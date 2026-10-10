// Outbound-only Telegram notification for a newly persisted pending publication.
// Never expose the bot token, Telegram response body, or request URL in diagnostics.
export type PendingPublicationNotification = {
  publicationId: string;
  hashtag: "#YILDIRIM" | "#ŞİMŞEK";
  messageText: string;
  locationLabel: string;
  enrichmentStatus: "cg_verified" | "ic_only" | "no_match";
  autoPublish?: boolean;
};

export type AutoPublishFailureNotification = { publicationId: string; httpStatus?: number };
export type AutoPublishFailureNotifier = (failure: AutoPublishFailureNotification) => Promise<TelegramSendResult>;

export type TelegramSendResult =
  | { ok: true }
  | { ok: false; reason: "timeout" | "network_error" | "http_error" | "invalid_response"; httpStatus?: number };

export type PendingPublicationNotifier = (candidate: PendingPublicationNotification) => Promise<TelegramSendResult>;

export const MANUAL_APPROVAL_WORKFLOW_URL =
  "https://github.com/freakme83/lightning-nearby/actions/workflows/research-lightning-manual-approval.yml";
const REQUEST_TIMEOUT_MS = 5_000;

export function pendingPublicationText(candidate: PendingPublicationNotification): string {
  const status = candidate.autoPublish
    ? "Otomatik yayın süreci başlatılıyor."
    : `Onay gerekli; henüz yayımlanmadı.\n\nHerkese açık mesaj:\n${candidate.messageText}\n\n` +
      `Manuel onay: ${MANUAL_APPROVAL_WORKFLOW_URL}`;
  const publicMessage = candidate.autoPublish ? `\n\nHerkese açık mesaj:\n${candidate.messageText}` : "";
  return `⚡ Yeni yayın adayı\n\nTür: ${candidate.hashtag}\nKonum: ${candidate.locationLabel}\n` +
    `Zenginleştirme: ${candidate.enrichmentStatus}\nYayın ID: ${candidate.publicationId}\n` +
    `${status}${publicMessage}`;
}

export function autoPublishFailureText(failure: AutoPublishFailureNotification): string {
  return `❌ Otomatik yayın başlatılamadı\n\nYayın ID: ${failure.publicationId}\n` +
    `Durum: GitHub publisher workflow başlatılamadı.\n` +
    `${failure.httpStatus === undefined ? "" : `HTTP: ${failure.httpStatus}\n`}` +
    "Manuel kontrol gerekebilir.";
}

export function createPendingPublicationNotifier(
  environment: Record<string, string | undefined>, fetcher: typeof fetch = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): { notify: PendingPublicationNotifier | null; notifyAutoPublishFailure: AutoPublishFailureNotifier | null;
  invalidSettings: string[] } {
  const token = environment.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = environment.TELEGRAM_CHAT_ID?.trim() ?? "";
  const invalidSettings = [
    ...(/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) ? [] : ["TELEGRAM_BOT_TOKEN"]),
    ...(/^-?\d+$/.test(chatId) ? [] : ["TELEGRAM_CHAT_ID"]),
  ];
  if (invalidSettings.length) return { notify: null, notifyAutoPublishFailure: null, invalidSettings };

  const sendText = async (text: string): Promise<TelegramSendResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: "http_error", httpStatus: response.status };
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) {
        return { ok: false, reason: "invalid_response" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  };
  const notify: PendingPublicationNotifier = candidate => sendText(pendingPublicationText(candidate));
  const notifyAutoPublishFailure: AutoPublishFailureNotifier = failure => sendText(autoPublishFailureText(failure));
  return { notify, notifyAutoPublishFailure, invalidSettings: [] };
}
