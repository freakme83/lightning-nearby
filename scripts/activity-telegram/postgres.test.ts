import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ActivityWatch } from "../fly-ankara-worker/activity-watch.ts";
import { eligibleActivityEvent } from "../fly-ankara-worker/activity-watch.ts";
import { ActivityNotificationDispatcher } from "./dispatcher.ts";
import { archive, blitzEvent, createDatabase, iso, mockTelegram, notificationRows, sqlActivityStore,
  sqlExportStore, sqlNotificationStore } from "./test-support.ts";
import { createActivityTelegramClient, type TelegramDelivery } from "./telegram.ts";

// Same opt-in PGlite module as the Activity Watch and export SQL tests.
const modulePath = process.env.ACTIVITY_WATCH_POSTGRES_TEST_MODULE;
const skip = !modulePath;
const T0 = Date.parse("2026-11-06T11:32:00.000Z"); // 14.32 TSİ
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GOLBASI = [39.79, 32.81] as const, HAYMANA = [39.43, 32.5] as const;
const MIN = 60_000;

async function setup(responses: TelegramDelivery[] = []) {
  const db = await createDatabase(modulePath!);
  const clock = { now: T0 };
  const telegram = mockTelegram(responses);
  const failing = { store: false };
  const dispatcher = (workerId?: string) => new ActivityNotificationDispatcher({
    store: sqlNotificationStore(db, () => clock.now, { failing: () => failing.store }),
    exportStore: sqlExportStore(db), telegram, emit: () => {}, now: () => clock.now, ...(workerId ? { workerId } : {}) });
  const sync = async (events: ReturnType<typeof blitzEvent>[] = [], healthy = true,
    gap = { sequence: 0, maxMs: 0, unbounded: false }, run = RUN) =>
    sqlActivityStore(db, () => clock.now).sync(run, healthy, gap, events.map(e => eligibleActivityEvent(e)!), false,
      new AbortController().signal);
  // An eligible detection observed 1 s after it happened, archived by Continuous Capture.
  const detect = async (lat: number, lon: number, discriminator = 0, archived = true) => {
    const event = blitzEvent(clock.now - 1_000, clock.now, lat, lon, discriminator);
    if (archived) await archive(db, event);
    return event;
  };
  return { db, clock, telegram, failing, dispatcher, sync, detect };
}

test("one start for the first persisted detection, none for later ones, one completion with Replay JSON; " +
  "restarts repeat neither", { skip }, async () => {
  const { db, clock, telegram, dispatcher, sync, detect } = await setup();
  try {
    let worker = dispatcher();
    assert.equal(await worker.tick(), "idle"); // records the enablement baseline
    clock.now += 5_000;
    const first = await detect(...GOLBASI);
    await sync([first]);
    // The start waits briefly for the asynchronous archive row.
    assert.equal(await worker.tick(), "idle");
    clock.now += 11_000;
    assert.equal(await worker.tick(), "processed");
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].method, "sendMessage");
    assert.equal(telegram.sent[0].text, "⚡ Ankara'da yıldırım hareketliliği tespit edildi.\nİlk tespit: 14.32 TSİ\n" +
      "Konum: Gölbaşı\nHarita: https://www.openstreetmap.org/?mlat=39.7900&mlon=32.8100#map=11/39.7900/32.8100\n" +
      "Yeni tespitler izleniyor.\nKaynak: Blitzortung tespit kayıtları (bağımsız olarak doğrulanmış yıldırım değildir).");

    // More detections, two of them in one millisecond; no further start message.
    clock.now += 4 * MIN;
    const sameA = await detect(...HAYMANA, 1), sameB = await detect(...HAYMANA, 2);
    await sync([sameA, sameB]);
    clock.now += 2 * MIN;
    const last = await detect(...GOLBASI);
    await sync([last]);
    for (let i = 0; i < 3; i++) { clock.now += 20_000; assert.equal(await worker.tick(), "idle"); }
    // Restart while active: the delivered start is not repeated.
    worker = dispatcher();
    assert.equal(await worker.tick(), "idle");
    assert.equal(telegram.sent.length, 1);

    // Close after 30 minutes of healthy silence; the completion carries the Replay JSON.
    clock.now = last.eventTimeMs + 30 * MIN + 5_000;
    assert.equal((await sync()).state, "idle");
    assert.equal(await worker.tick(), "processed");
    assert.equal(telegram.sent.length, 2);
    const end = telegram.sent[1];
    assert.equal(end.method, "sendDocument");
    const [period] = (await db.query("select period_id from public.ankara_activity_periods")).rows;
    assert.equal(end.filename, `ankara-activity-20261106-1432-tsi-${period.period_id}.json`);
    const replay = JSON.parse(end.json!);
    assert.equal(replay.events.length, 4);
    assert.equal(replay.events[1].timestamp, replay.events[2].timestamp); // same millisecond, two records
    assert.notEqual(replay.events[1].id, replay.events[2].id);
    assert.equal(replay.meta.windowStart, iso(first.eventTimeMs));
    assert.equal(replay.meta.windowEnd, iso(last.eventTimeMs + 10_000)); // no 30-minute silence
    assert.match(end.text, /^⚡ Ankara yıldırım hareketliliği sona erdi\.\nTarih: 06\.11\.2026\nİlk tespit: 14\.32 TSİ\n/);
    assert.match(end.text, /Son tespit: 14\.38 TSİ/);
    assert.match(end.text, /Kapanış: 15\.08 TSİ \(30 dk sessizlik sonrası; oynatmaya dahil değil\)/);
    assert.match(end.text, /Toplam: 4 Blitzortung tespit kaydı\nYoğunlaşan ilçeler: Gölbaşı \(2\), Haymana \(2\)/);
    assert.match(end.text, /📎 Replay kaydı ektedir/);
    assert.doesNotMatch(end.text, /eksik|belirsiz/);

    // Restart after delivery: nothing is repeated.
    for (const restarted of [dispatcher(), dispatcher()]) {
      clock.now += MIN;
      assert.equal(await restarted.tick(), "idle");
    }
    assert.equal(telegram.sent.length, 2);
    assert.deepEqual((await notificationRows(db)).map(row => [row.kind, row.state, row.attempts, row.attachment]),
      [["start", "sent", 1, null], ["end", "sent", 1, "attached"]]);
  } finally { await db.close(); }
});

test("no history flood: periods before enablement are never announced; a period missed while down " +
  "gets a single completion", { skip }, async () => {
  const { db, clock, telegram, dispatcher, sync, detect } = await setup();
  try {
    // A period that started before the feature was first enabled.
    await sync([await detect(...GOLBASI)]);
    clock.now += MIN;
    const worker = dispatcher();
    assert.equal(await worker.tick(), "idle");
    clock.now += 31 * MIN;
    await sync();
    assert.equal(await worker.tick(), "idle");
    assert.equal(telegram.sent.length, 0);

    // A new period opens and closes while no dispatcher runs.
    clock.now += MIN;
    const event = await detect(...HAYMANA);
    await sync([event]);
    clock.now = event.eventTimeMs + 31 * MIN;
    await sync();
    assert.equal(await dispatcher().tick(), "processed");
    assert.deepEqual(telegram.sent.map(item => item.method), ["sendDocument"]);
    assert.match(telegram.sent[0].text, /Haymana \(1\)/);

    // A start that was planned but never sent before closure is superseded, not sent late.
    clock.now += MIN;
    const third = await detect(...GOLBASI);
    await sync([third]);
    assert.equal(await worker.tick(), "idle"); // planned, due after the archive delay
    clock.now = third.eventTimeMs + 31 * MIN;
    await sync();
    clock.now += 4_000;
    assert.equal(await worker.tick(), "processed");
    assert.deepEqual(telegram.sent.map(item => item.method), ["sendDocument", "sendDocument"]);
    const rows = await notificationRows(db);
    assert.deepEqual(rows.map(row => [row.kind, row.state]), [["end", "sent"], ["start", "superseded"], ["end", "sent"]]);
  } finally { await db.close(); }
});

test("concurrent dispatchers cannot claim the same notification", { skip }, async () => {
  const { db, clock, telegram, dispatcher, sync, detect } = await setup();
  try {
    await dispatcher().tick();
    clock.now += 1_000;
    await sync([await detect(...GOLBASI)]);
    clock.now += 11_000;
    const results = await Promise.all([dispatcher().tick(), dispatcher().tick(), dispatcher().tick()]);
    assert.equal(results.filter(result => result === "processed").length, 1);
    assert.equal(telegram.sent.length, 1);
    // A direct second claim of the same leased row is impossible.
    const store = sqlNotificationStore(db, () => clock.now);
    const signal = new AbortController().signal;
    assert.equal((await store.claim("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", signal)).outcome, "wait");
    clock.now += 5_000;
    assert.equal((await store.claim("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", signal)).outcome, "idle");
  } finally { await db.close(); }
});

test("an ambiguous Telegram outcome or a crash after reserving the send is never retried; " +
  "a crash before reserving is", { skip }, async () => {
  const { db, clock, telegram, dispatcher, sync, detect } = await setup([{ status: "ambiguous", detail: "timeout" }]);
  const signal = new AbortController().signal;
  try {
    await dispatcher().tick();
    clock.now += 1_000;
    const event = await detect(...GOLBASI);
    await sync([event]);
    clock.now += 11_000;
    assert.equal(await dispatcher().tick(), "processed");
    for (let i = 0; i < 5; i++) { clock.now += 5 * MIN; assert.equal(await dispatcher().tick(), "idle"); }
    assert.equal(telegram.sent.length, 1);
    assert.deepEqual((await notificationRows(db)).map(row => [row.state, row.last_outcome]), [["ambiguous", "timeout"]]);

    // Close the period; a worker crashes after begin_send (a request may have left).
    clock.now = event.eventTimeMs + 31 * MIN;
    await sync();
    const store = sqlNotificationStore(db, () => clock.now);
    const crashed = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const claim = await store.claim(crashed, signal);
    assert.equal(claim.outcome, "claimed");
    const periodId = claim.outcome === "claimed" ? claim.notification.periodId : "";
    assert.equal(await store.beginSend(crashed, periodId, "end", signal), "proceed");
    assert.equal(await store.beginSend(crashed, periodId, "end", signal), "proceed"); // idempotent for the owner
    clock.now += 4 * MIN;
    assert.equal(await dispatcher().tick(), "idle");
    let rows = await notificationRows(db);
    assert.deepEqual([rows[1].kind, rows[1].state, rows[1].last_outcome], ["end", "ambiguous", "lease_expired_while_sending"]);
    // A late confirmation from the same owner still resolves it; anyone else cannot.
    assert.equal(await store.complete("dddddddd-dddd-4ddd-8ddd-dddddddddddd", periodId, "end",
      { outcome: "sent", messageId: 9, attachment: "attached" }, signal), "not_owner");
    assert.equal(await store.complete(crashed, periodId, "end", { outcome: "sent", messageId: 9, attachment: "attached" },
      signal), "recorded");
    rows = await notificationRows(db);
    assert.equal(rows[1].state, "sent");
    assert.equal(telegram.sent.length, 1);

    // A crash after claiming but before begin_send: nothing left, so it is retried once.
    clock.now += MIN;
    const second = await detect(...HAYMANA);
    await sync([second]);
    clock.now += 11_000;
    assert.equal((await store.claim(crashed, signal)).outcome, "claimed");
    clock.now += 6 * MIN;
    assert.equal(await dispatcher().tick(), "processed");
    assert.equal(telegram.sent.length, 2);
    assert.equal((await notificationRows(db)).at(-1)!.state, "sent");
  } finally { await db.close(); }
});

test("confirmed non-delivery follows bounded backoff and respects Telegram retry_after", { skip }, async () => {
  // Only confirmed refusals are retryable: a consistent 429, or a failure before connecting.
  const responses: TelegramDelivery[] = [{ status: "retry", detail: "telegram_429", retryAfterSeconds: 120 },
    ...Array.from({ length: 4 }, () => ({ status: "retry" as const, detail: "connect_error" }))];
  const { db, clock, telegram, dispatcher, sync, detect } = await setup(responses);
  try {
    const worker = dispatcher();
    await worker.tick();
    clock.now += 1_000;
    await sync([await detect(...GOLBASI)]);
    clock.now += 11_000;
    assert.equal(await worker.tick(), "processed");
    clock.now += 60_000;
    assert.equal(await worker.tick(), "wait"); // Telegram's retry_after pauses every notification
    const sentAt: number[] = [clock.now];
    for (let minute = 0; minute < 60; minute++) {
      clock.now += 20_000;
      if (await worker.tick() === "processed") sentAt.push(clock.now);
    }
    assert.equal(telegram.sent.length, 5); // max attempts, then failed: no flood
    const [row] = await notificationRows(db);
    assert.deepEqual([row.state, row.attempts, row.last_outcome], ["failed", 5, "connect_error"]);
  } finally { await db.close(); }
});

test("Telegram 500/502/504 through the real client are terminal ambiguous outcomes, never reclaimed after restarts",
  { skip }, async () => {
    const { db, clock, sync, detect } = await setup();
    const token = "123456:THIS_IS_A_FIXTURE_TOKEN_NOT_A_SECRET";
    const answers = [
      () => Response.json({ ok: false, error_code: 500, description: "Internal Server Error" }, { status: 500 }),
      () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      () => Response.json({ ok: false, error_code: 504, description: "Gateway Timeout" }, { status: 504 }),
    ];
    const requests: string[] = [];
    const { client } = createActivityTelegramClient({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-100123" },
      async input => {
        requests.push(String(input).replace(token, "<token>"));
        const answer = answers.shift();
        return answer ? answer() : Response.json({ ok: true, result: { message_id: 1 } });
      });
    const dispatcher = () => new ActivityNotificationDispatcher({ store: sqlNotificationStore(db, () => clock.now),
      exportStore: sqlExportStore(db), telegram: client!, emit: () => {}, now: () => clock.now });
    try {
      await dispatcher().tick();
      clock.now += 1_000;
      const first = await detect(...GOLBASI);
      await sync([first]);
      clock.now += 11_000;
      assert.equal(await dispatcher().tick(), "processed"); // start -> 500
      clock.now = first.eventTimeMs + 31 * MIN;
      await sync();
      assert.equal(await dispatcher().tick(), "processed"); // completion -> 502
      clock.now += MIN;
      const second = await detect(...HAYMANA);
      await sync([second]);
      clock.now += 11_000;
      assert.equal(await dispatcher().tick(), "processed"); // start -> 504
      // Many restarts over hours, past every lease: nothing is reclaimed or resent.
      for (let restart = 0; restart < 12; restart++) {
        clock.now += 10 * MIN;
        assert.equal(await dispatcher().tick(), "idle");
      }
      assert.deepEqual(requests, ["https://api.telegram.org/bot<token>/sendMessage",
        "https://api.telegram.org/bot<token>/sendDocument", "https://api.telegram.org/bot<token>/sendMessage"]);
      const rows = await notificationRows(db);
      assert.deepEqual(rows.map(row => [row.kind, row.state, row.attempts, row.last_outcome]), [
        ["start", "ambiguous", 1, "telegram_500"], ["end", "ambiguous", 1, "http_502"],
        ["start", "ambiguous", 1, "telegram_504"]]);
      // The second period's normal completion is unaffected by the earlier ambiguity.
      clock.now = second.eventTimeMs + 31 * MIN;
      await sync();
      assert.equal(await dispatcher().tick(), "processed");
      assert.equal(requests.length, 4);
      assert.deepEqual((await notificationRows(db)).at(-1)!.state, "sent");
    } finally { await db.close(); }
  });

test("a permanent rejection is not retried", { skip }, async () => {
  const { db, clock, telegram, dispatcher, sync, detect } = await setup([{ status: "failed", detail: "telegram_400" }]);
  try {
    const worker = dispatcher();
    await worker.tick();
    clock.now += 1_000;
    await sync([await detect(...GOLBASI)]);
    clock.now += 11_000;
    await worker.tick();
    for (let i = 0; i < 10; i++) { clock.now += MIN; await worker.tick(); }
    assert.equal(telegram.sent.length, 1);
    assert.deepEqual((await notificationRows(db)).map(row => row.state), ["failed"]);
  } finally { await db.close(); }
});

test("missing archive rows are disclosed; a period without archive rows gets a text-only completion", { skip },
  async () => {
    const { db, clock, telegram, dispatcher, sync, detect } = await setup();
    try {
      const worker = dispatcher();
      await worker.tick();
      clock.now += 1_000;
      const archived = await detect(...GOLBASI);
      clock.now += 1_000;
      const lost = await detect(...HAYMANA, 0, false);
      await sync([archived, lost]);
      clock.now = lost.eventTimeMs + 31 * MIN;
      await sync();
      assert.equal(await worker.tick(), "processed");
      const end = telegram.sent[0];
      assert.equal(end.method, "sendDocument");
      assert.match(end.text, /Toplam: 2 Blitzortung tespit kaydı/);
      assert.match(end.text, /⚠️ Arşivde eksik kayıt: 1 \(Replay'de yer almıyor\)/);
      const replay = JSON.parse(end.json!);
      assert.equal(replay.meta.archive.complete, false);
      assert.equal(replay.events.length, 1);

      clock.now += MIN;
      const none = await detect(...GOLBASI, 0, false);
      await sync([none]);
      clock.now += 61_000;
      await worker.tick(); // start without location once the archive wait has passed
      assert.doesNotMatch(telegram.sent[1].text, /Harita/);
      assert.match(telegram.sent[1].text, /Konum: Ankara izleme alanı/);
      clock.now = none.eventTimeMs + 31 * MIN;
      await sync();
      clock.now += 5_000;
      assert.equal(await worker.tick(), "processed");
      const text = telegram.sent[2];
      assert.equal(text.method, "sendMessage");
      assert.match(text.text, /⚠️ Replay kaydı oluşturulamadı: bu döneme ait arşiv kaydı bulunamadı\./);
      assert.equal((await notificationRows(db)).at(-1)!.attachment, "unavailable:no_archived_events");
    } finally { await db.close(); }
  });

test("a notification database outage blocks neither Activity Watch nor anything else, and recovers", { skip },
  async () => {
    const { db, clock, telegram, failing, dispatcher, sync, detect } = await setup();
    try {
      const worker = dispatcher();
      await worker.tick();
      failing.store = true;
      clock.now += 1_000;
      assert.equal((await sync([await detect(...GOLBASI)])).state, "active"); // Activity Watch keeps working
      clock.now += 11_000;
      assert.equal(await worker.tick(), "backoff");
      assert.equal(await worker.tick(), "backoff"); // bounded local backoff, no busy loop
      failing.store = false;
      clock.now += 10 * MIN;
      assert.equal(await worker.tick(), "processed");
      assert.equal(telegram.sent.length, 1);
    } finally { await db.close(); }
  });

test("six hours of intermittent activity with routine reconnects and a worker restart: one start, " +
  "no premature completion, one complete Replay", { skip }, async () => {
  const { db, clock, telegram, dispatcher } = await setup();
  try {
    let sourceHealthy = true;
    const makeWatch = () => new ActivityWatch(sqlActivityStore(db, () => clock.now), () => sourceHealthy, () => {},
      () => clock.now);
    let watch = makeWatch();
    let worker = dispatcher();
    const flush = async () => { for (let i = 0; i < 5; i++) await watch.tick(); };
    await worker.tick();
    const detections: number[] = [];
    let lastReconnect = clock.now, discriminator = 0;
    const end = T0 + 6 * 60 * MIN;
    for (let step = 0; clock.now < end; step++) {
      clock.now += 3 * MIN + (step % 7) * 7_000;
      // A quiet spell shorter than 30 minutes keeps the same period.
      if (step === 40) clock.now += 22 * MIN;
      if (clock.now - lastReconnect >= 361_000) {
        // Routine socket rotation with a 1–4 s gap.
        sourceHealthy = false; watch.sourceState(false); await flush();
        clock.now += 1_000 + (step % 4) * 1_000;
        lastReconnect = clock.now;
        sourceHealthy = true;
      }
      const burst = step % 9 === 0 ? 2 : 1; // occasional same-millisecond pair
      for (let i = 0; i < burst; i++) {
        const event = blitzEvent(clock.now - 1_000, clock.now, step % 2 ? GOLBASI[0] : HAYMANA[0],
          step % 2 ? GOLBASI[1] : HAYMANA[1], ++discriminator);
        await archive(db, event);
        watch.observe(event);
        detections.push(event.eventTimeMs);
      }
      watch.sourceState(true);
      await flush();
      if (step === 60) { // worker restart mid-activity
        watch.stop(); watch = makeWatch(); worker = dispatcher();
        await flush();
      }
      assert.ok(["idle", "processed", "wait"].includes(await worker.tick()));
    }
    const lastDetection = detections.at(-1)!;
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].method, "sendMessage");
    // Quiet tail with continued reconnects: nothing until the period really closes.
    while (clock.now + 2 * MIN + 2_000 <= lastDetection + 29 * MIN) {
      clock.now += 2 * MIN;
      sourceHealthy = false; watch.sourceState(false); await flush();
      clock.now += 2_000; sourceHealthy = true; watch.sourceState(true); await flush();
      await worker.tick();
    }
    assert.equal(telegram.sent.length, 1);
    assert.equal((await db.query("select state from public.ankara_activity_periods")).rows[0].state, "active");
    clock.now = lastDetection + 31 * MIN;
    await flush();
    assert.equal((await db.query("select state from public.ankara_activity_periods")).rows[0].state, "closed");
    for (let i = 0; i < 3; i++) { clock.now += 20_000; await worker.tick(); }
    assert.equal(telegram.sent.length, 2);
    const completion = telegram.sent[1];
    assert.equal(completion.method, "sendDocument");
    const replay = JSON.parse(completion.json!);
    assert.equal(replay.events.length, detections.length);
    assert.equal(replay.meta.archive.complete, true);
    assert.equal(replay.meta.windowStart, iso(detections[0]));
    assert.equal(replay.meta.windowEnd, iso(lastDetection + 10_000));
    assert.ok(lastDetection - detections[0] > 6 * 60 * MIN - 5 * MIN);
    assert.equal(replay.meta.activityPeriod.coverageUncertain, true);
    assert.match(completion.text, /⚠️ Kapsama belirsiz \(kaynak kesintisi: \d+\)/);
    assert.match(completion.text, new RegExp(`Toplam: ${detections.length} Blitzortung`));
    const sameMs = replay.events.filter((e: { timestamp: string }, i: number, all: { timestamp: string }[]) =>
      i > 0 && all[i - 1].timestamp === e.timestamp).length;
    assert.ok(sameMs >= 5);
    watch.stop();
  } finally { await db.close(); }
});

test("migration is additive, isolated from Activity Watch, and service-role only", { skip }, async () => {
  const sql = await readFile(new URL("./migrations/20261106120000_ankara_activity_notifications_v1.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /create\s+trigger|alter\s+table\s+public\.(ankara_activity_period|continuous_capture|publication)/i);
  assert.doesNotMatch(sql, /references\s+public\.ankara_activity_periods/i);
  const db = await createDatabase(modulePath!);
  try {
    await db.exec("reset role; set role anon");
    await assert.rejects(db.query("select public.claim_ankara_activity_notification($1)",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]), /permission denied/);
    await assert.rejects(db.query("select * from public.ankara_activity_notifications"), /permission denied/);
    await db.exec("reset role; set role authenticated");
    await assert.rejects(db.query("select * from public.ankara_activity_notification_settings"), /permission denied/);
    await db.exec("reset role; set role service_role");
    // Production path: the worker omits p_now (database clock).
    const result = (await db.query("select public.claim_ankara_activity_notification($1) as r",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])).rows[0].r as { outcome: string };
    assert.equal(result.outcome, "idle");
    await assert.rejects(db.query("select public.complete_ankara_activity_notification($1,$2,'start','sent',$3)",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Bot TOKEN!"]), /Invalid/);
  } finally { await db.close(); }
});
