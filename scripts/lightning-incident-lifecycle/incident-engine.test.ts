import test from "node:test";
import assert from "node:assert/strict";
import { IncidentLifecycleEngine } from "./incident-engine.ts";
import { compareIncidentProfiles, applyTransitions, runIncidentExperiment } from "./experiment.ts";
import { DryRunPublishPolicy } from "./publish-policy.ts";
import { SourceHealthTracker } from "./source-health.ts";
import { INCIDENT_POLICY_PROFILES, type ClusterObservation, type IncidentPolicyProfile, type IncidentReplaySignal } from "./types.ts";

const minute = 60_000;
const start = 1_000_000;
const profile = (overrides: Partial<IncidentPolicyProfile> = {}): IncidentPolicyProfile => ({
  ...INCIDENT_POLICY_PROFILES[1], ...overrides,
});
function observation(clusterId: string, eventMs: number, receivedMs = eventMs + 1_000, latitude = 40, longitude = 33): ClusterObservation {
  return { sourceClusterId: clusterId, eventTimeMs: eventMs, receivedAtMs: receivedMs, latitude, longitude };
}
function live(engine: IncidentLifecycleEngine, atMs = start) {
  engine.setSourceHealth({ state: "live", lastFrameAtMs: atMs }, atMs);
}
function promotion(engine: IncidentLifecycleEngine, id = "c-1", at = start, count = 3, lat = 40, lon = 33) {
  const out=[];
  for (let i=0;i<count;i++) out.push(...engine.observe(observation(id, at + i * minute, at + i * minute + 1000, lat, lon)));
  return out;
}

test("a singleton detection remains a candidate and cannot create a publish decision", () => {
  const engine = new IncidentLifecycleEngine(profile(), start); live(engine);
  const transitions=engine.observe(observation("c-1",start));
  const policy=new DryRunPublishPolicy(profile());
  assert.equal(transitions.some(item=>item.type==="promoted"),false);
  assert.equal(engine.snapshot().candidates,1);
  assert.equal(policy.metrics.publishCandidatesGenerated,0);
});

test("permissive profile promotes two events within five event-time minutes", () => {
  const p=profile({id:"A",promotionMinEvents:2,promotionWindowMinutes:5});
  const engine=new IncidentLifecycleEngine(p,start); live(engine);
  const transitions=[...engine.observe(observation("c-1",start)),...engine.observe(observation("c-1",start+4*minute,start+4*minute+1000))];
  assert.equal(transitions.filter(item=>item.type==="promoted").length,1);
  assert.equal(engine.snapshot().metrics.incidentsPromoted,1);
});

test("moderate profile waits for three events in its ten-minute event-time window", () => {
  const engine=new IncidentLifecycleEngine(profile(),start); live(engine);
  assert.equal(promotion(engine,"c-1",start,2).some(item=>item.type==="promoted"),false);
  assert.equal(engine.observe(observation("c-1",start+2*minute,start+2*minute+1000)).some(item=>item.type==="promoted"),true);
});

test("under-threshold candidate expires on its live-source processing-time window", () => {
  const engine=new IncidentLifecycleEngine(profile(),start); live(engine);
  engine.observe(observation("c-1",start));
  const transitions=engine.tick(start+10*minute+1_000);
  assert.equal(transitions[0].type,"candidate_expired");
  assert.equal(engine.snapshot().metrics.candidatesExpired,1);
  assert.equal(engine.snapshot().metrics.singletonClustersIgnored,1);
  assert.equal(engine.incidents[0].publishCount,0);
});

test("promoted incident stays active until its quiet-period deadline", () => {
  const engine=new IncidentLifecycleEngine(profile(),start); live(engine);
  const transitions=promotion(engine);
  assert.ok(transitions.some(item=>item.type==="promoted"));
  const last=engine.incidents[0].lastActivityReceivedAtMs;
  assert.deepEqual(engine.tick(last+20*minute-1),[]);
  assert.equal(engine.incidents[0].status,"active");
});

test("repeated activity yields suppressions, not additional publish candidates", () => {
  const p=profile(); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  const policy=new DryRunPublishPolicy(p);
  const initial=promotion(engine);
  const decisions=applyTransitions(initial,policy,engine);
  assert.equal(decisions.filter(item=>item.action==="WOULD_PUBLISH").length,1);
  for(let i=0;i<4;i++) applyTransitions(engine.observe(observation("c-1",start+4*minute+i*minute,start+4*minute+i*minute+1000)),policy,engine);
  assert.equal(policy.metrics.publishCandidatesGenerated,1);
  assert.equal(policy.metrics.suppressionsByReason.already_published_active_incident,4);
});

test("incident closes after the quiet interval while source health stays live", () => {
  const p=profile(); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  const transitions=promotion(engine); const policy=new DryRunPublishPolicy(p);
  applyTransitions(transitions,policy,engine);
  const last=engine.incidents[0].lastActivityReceivedAtMs;
  const closed=engine.tick(last+p.closeAfterMinutes*minute);
  assert.equal(closed[0].type,"closed");
  applyTransitions(closed,policy,engine);
  assert.equal(engine.snapshot().closedIncidents,1);
  assert.equal(policy.metrics.publishCandidatesGenerated,1);
});

test("disconnect freezes closure; reconnect starts a new known-coverage quiet interval", () => {
  const p=profile(); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  promotion(engine); const incident=engine.incidents[0];
  const interruptedAt=incident.lastActivityReceivedAtMs+5*minute;
  engine.setSourceHealth({state:"disconnected",sinceMs:interruptedAt},interruptedAt);
  assert.deepEqual(engine.tick(interruptedAt+60*minute),[]);
  assert.equal(incident.status,"active");
  const resumedAt=interruptedAt+60*minute;
  engine.setSourceHealth({state:"live",lastFrameAtMs:resumedAt},resumedAt);
  assert.deepEqual(engine.tick(resumedAt+p.closeAfterMinutes*minute-1),[]);
  assert.equal(engine.tick(resumedAt+p.closeAfterMinutes*minute)[0].type,"closed");
});

test("Profile B counts a nearby renewal within its 20-minute window", () => {
  const p=profile(); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  promotion(engine,"c-old",start,3);
  const first=engine.incidents[0]; engine.tick(first.lastActivityReceivedAtMs+p.closeAfterMinutes*minute);
  const transitions=engine.observe(observation("c-new",first.closedAtMs!+5*minute,first.closedAtMs!+5*minute+1000,40.01,33));
  assert.equal(transitions.some(item=>item.type==="candidate_created"),true);
  assert.notEqual(engine.incidents[1].id,first.id);
  assert.equal(engine.snapshot().metrics.reopenedOrRecreated,1);
});

test("Profile A does not count nearby renewal when its cooldown is zero", () => {
  const p=profile({id:"A",nearbyCooldownMinutes:0}); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  promotion(engine,"c-old",start,3);
  const first=engine.incidents[0]; engine.tick(first.lastActivityReceivedAtMs+p.closeAfterMinutes*minute);
  engine.observe(observation("c-new",first.closedAtMs!+5*minute,first.closedAtMs!+5*minute+1000,40.01,33));
  assert.equal(engine.snapshot().metrics.reopenedOrRecreated,0);
});

test("Profile B does not count nearby renewal after its 20-minute window", () => {
  const p=profile(); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  promotion(engine,"c-old",start,3);
  const first=engine.incidents[0]; engine.tick(first.lastActivityReceivedAtMs+p.closeAfterMinutes*minute);
  engine.observe(observation("c-new",first.closedAtMs!+20*minute+1,first.closedAtMs!+20*minute+1001,40.01,33));
  assert.equal(engine.snapshot().metrics.reopenedOrRecreated,0);
});

test("Profile C counts nearby renewal within its 30-minute window", () => {
  const p=profile({id:"C",closeAfterMinutes:30,nearbyCooldownMinutes:30}); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  promotion(engine,"c-old",start,3);
  const first=engine.incidents[0]; engine.tick(first.lastActivityReceivedAtMs+p.closeAfterMinutes*minute);
  engine.observe(observation("c-new",first.closedAtMs!+25*minute,first.closedAtMs!+25*minute+1000,40.01,33));
  assert.equal(engine.snapshot().metrics.reopenedOrRecreated,1);
});

test("a geographically distant renewal does not increment reopenedOrRecreated", () => {
  const p=profile(); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  promotion(engine,"c-old",start,3);
  const first=engine.incidents[0]; engine.tick(first.lastActivityReceivedAtMs+p.closeAfterMinutes*minute);
  engine.observe(observation("c-far",first.closedAtMs!+5*minute,first.closedAtMs!+5*minute+1000,42,33));
  engine.observe(observation("c-far-later",first.closedAtMs!+25*minute,first.closedAtMs!+25*minute+1000,42,33));
  assert.equal(engine.snapshot().metrics.reopenedOrRecreated,0);
});

test("nearby cooldown suppresses a new promoted incident and records its related incident", () => {
  const p=profile({nearbyCooldownMinutes:20}); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  const policy=new DryRunPublishPolicy(p);
  applyTransitions(promotion(engine,"c-old",start),policy,engine);
  const old=engine.incidents[0];
  const close=engine.tick(old.lastActivityReceivedAtMs+p.closeAfterMinutes*minute);
  applyTransitions(close,policy,engine);
  const at=old.closedAtMs!+5*minute;
  const transitions=promotion(engine,"c-new",at,3,40.01,33);
  const decisions=applyTransitions(transitions,policy,engine);
  assert.equal(decisions[0].reason,"nearby_cooldown");
  assert.equal(decisions[0].relatedIncidentId,old.id);
  assert.equal(policy.metrics.nearbyRepeatSuppressions,1);
});

test("nearby activity after the cooldown can become a new publish candidate", () => {
  const p=profile({nearbyCooldownMinutes:20}); const engine=new IncidentLifecycleEngine(p,start); live(engine);
  const policy=new DryRunPublishPolicy(p);
  applyTransitions(promotion(engine,"c-old",start),policy,engine);
  const old=engine.incidents[0]; applyTransitions(engine.tick(old.lastActivityReceivedAtMs+p.closeAfterMinutes*minute),policy,engine);
  const at=old.closedAtMs!+21*minute;
  const decisions=applyTransitions(promotion(engine,"c-later",at,3,40.01,33),policy,engine);
  assert.equal(decisions.some(item=>item.action==="WOULD_PUBLISH"),true);
  assert.equal(policy.metrics.nearbyRepeatSuppressions,0);
});

test("geographically separate activity starts an independent candidate", () => {
  const engine=new IncidentLifecycleEngine(profile(),start); live(engine);
  promotion(engine,"c-near",start);
  const transitions=engine.observe(observation("c-far",start+4*minute,start+4*minute+1000,41,35));
  assert.equal(transitions.some(item=>item.type==="candidate_created"),true);
  assert.equal(engine.incidents.length,2);
  assert.equal(engine.incidents[1].sourceClusterIds[0],"c-far");
});

test("out-of-order activity preserves event-time extrema and processing-time promotion", () => {
  const engine=new IncidentLifecycleEngine(profile(),start); live(engine);
  engine.observe(observation("c-1",start+3*minute,start+1000));
  engine.observe(observation("c-1",start+minute,start+2000));
  const transitions=engine.observe(observation("c-1",start+2*minute,start+3000));
  const incident=engine.incidents[0];
  assert.equal(transitions.some(item=>item.type==="promoted"),true);
  assert.equal(incident.firstEventTimeMs,start+minute);
  assert.equal(incident.lastActivityTimeMs,start+3*minute);
  assert.equal(incident.promotedAtMs,start+3000);
});

test("identical sequence and source-health transitions produce deterministic results", () => {
  const signals: IncidentReplaySignal[]=[
    {kind:"source_health",atMs:start,health:{state:"live",lastFrameAtMs:start}},
    ...[0,minute,2*minute].map((dt,i)=>({kind:"activity" as const,atMs:start+dt+1000,
      observation:observation("c-1",start+dt,start+dt+1000)})),
    {kind:"source_health",atMs:start+3*minute,health:{state:"disconnected",sinceMs:start+3*minute}},
  ];
  const first=runIncidentExperiment(signals,profile(),start+60*minute).result;
  const second=runIncidentExperiment(signals,profile(),start+60*minute).result;
  assert.deepEqual(first,second);
  assert.equal(first.sourceHealthInterruptions,1);
  assert.equal(first.closedIncidents,0);
});

test("profile comparison reuses one signal sequence and changes promotion and closure outputs directionally", () => {
  const base=start;
  const signals: IncidentReplaySignal[]=[
    {kind:"source_health",atMs:base,health:{state:"live",lastFrameAtMs:base}},
    {kind:"activity",atMs:base+1000,observation:observation("c-noise",base,base+1000)},
    {kind:"cluster_closed",atMs:base+6*minute,sourceClusterId:"c-noise"},
    ...[0,2,4].map((dt,i)=>({kind:"activity" as const,atMs:base+(10+dt)*minute,
      observation:observation("c-active",base+(10+dt)*minute,base+(10+dt)*minute+1000,40.1,33)})),
    {kind:"cluster_closed",atMs:base+25*minute,sourceClusterId:"c-active"},
    {kind:"source_health",atMs:base+70*minute,health:{state:"disconnected",sinceMs:base+70*minute}},
  ];
  const rows=compareIncidentProfiles(signals,INCIDENT_POLICY_PROFILES,base+70*minute);
  const a=rows.find(row=>row.profile.id==="A")!;
  const b=rows.find(row=>row.profile.id==="B")!;
  const c=rows.find(row=>row.profile.id==="C")!;
  assert.ok(a.incidentsPromoted>=b.incidentsPromoted);
  assert.ok(b.incidentsClosed>=c.incidentsClosed);
  assert.equal(a.clustersObserved,b.clustersObserved);
  assert.equal(b.clustersObserved,c.clustersObserved);
});

test("same-sequence comparison uses the conventional midpoint for even promotion samples", () => {
  const p=profile({id:"A",promotionMinEvents:2,promotionWindowMinutes:5,nearbyCooldownMinutes:0});
  const signals: IncidentReplaySignal[]=[
    {kind:"source_health",atMs:start,health:{state:"live",lastFrameAtMs:start}},
    {kind:"activity",atMs:start+1_000,observation:observation("c-one",start,start+1_000,40,33)},
    {kind:"activity",atMs:start+minute+1_000,observation:observation("c-one",start+minute,start+minute+1_000,40,33)},
    {kind:"activity",atMs:start+2*minute+1_000,observation:observation("c-two",start+2*minute,start+2*minute+1_000,42,33)},
    {kind:"activity",atMs:start+6*minute+1_000,observation:observation("c-two",start+6*minute,start+6*minute+1_000,42,33)},
  ];
  const result=runIncidentExperiment(signals,p,start+7*minute).result;
  assert.equal(result.incidentsPromoted,2);
  assert.equal(result.medianTimeToPromotionMinutes,2.5);
});

test("source health marks stale and does not double-count a single stale-to-disconnected outage", () => {
  const health=new SourceHealthTracker(start,90_000);
  health.connecting(start);
  health.frame(start+1);
  assert.equal(health.poll(start+90_002)?.to,"stale");
  health.disconnected(start+95_000);
  assert.equal(health.interruptions,1);
  health.connecting(start+100_000); health.frame(start+101_000);
  health.poll(start+191_001);
  assert.equal(health.interruptions,2);
});
