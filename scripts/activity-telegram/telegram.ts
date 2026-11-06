// Activity Watch's own Telegram client. It reuses the existing bot and group credentials
// (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) but shares no code or state with the publication
// notifier in ../lightning-telegram-notifier/pending.ts, which stays untouched.
// Diagnostics never contain the token, request URL or Telegram response body.

/**
 * Telegram offers no application idempotency key, so every outcome is classified by what
 * is actually known about delivery:
 * - sent: Telegram confirmed the message.
 * - retry: confirmed non-delivery that may be repeated: a consistent Telegram 429, or a network
 *   failure before any connection existed.
 * - failed: confirmed, permanent rejection (Telegram 4xx other than 429).
 * - ambiguous: the request may have been accepted (any HTTP 5xx or Bot API error_code >= 500,
 *   timeout, dropped connection, unreadable success response). Never retried automatically.
 */
export type TelegramDelivery =
  | { status: "sent"; messageId: number | null }
  | { status: "retry"; detail: string; retryAfterSeconds?: number }
  | { status: "failed"; detail: string }
  | { status: "ambiguous"; detail: string };

export type ActivityTelegramClient = {
  sendMessage(text: string): Promise<TelegramDelivery>;
  sendDocument(caption: string, filename: string, json: string): Promise<TelegramDelivery>;
};

const MESSAGE_TIMEOUT_MS = 10_000;
const DOCUMENT_TIMEOUT_MS = 60_000;
// Failures that happen before a TCP connection exists cannot have delivered anything.
const PRE_CONNECT_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH",
  "ENETUNREACH"]);

export function telegramSettings(environment: Record<string, string | undefined>):
  { token: string; chatId: string; invalidSettings: string[] } {
  const token = environment.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const chatId = environment.TELEGRAM_CHAT_ID?.trim() ?? "";
  // Same validation as the existing publication notifier.
  const invalidSettings = [
    ...(/^\d+:[A-Za-z0-9_-]{20,}$/.test(token) ? [] : ["TELEGRAM_BOT_TOKEN"]),
    ...(/^-?\d+$/.test(chatId) ? [] : ["TELEGRAM_CHAT_ID"]),
  ];
  return { token, chatId, invalidSettings };
}

function errorCode(error: unknown): string | null {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export async function classifyTelegramResponse(response: Response): Promise<TelegramDelivery> {
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (body?.ok === true) {
    const result = body.result as { message_id?: unknown } | undefined;
    return { status: "sent", messageId: Number.isSafeInteger(result?.message_id) ? result!.message_id as number : null };
  }
  // Any server-side error (HTTP 5xx or a Bot API error_code >= 500) can follow a message that
  // was already accepted, so it is never proof of non-delivery and is never retried.
  const code = body?.ok === false && Number.isSafeInteger(body.error_code) ? body.error_code as number : null;
  if (response.status >= 500 || (code !== null && code >= 500)) {
    return { status: "ambiguous", detail: code !== null && code >= 500 ? `telegram_${code}` : `http_${response.status}` };
  }
  if (code !== null) {
    // A consistent 429 is Telegram refusing the request before processing it: safe to retry.
    if (code === 429 && response.status === 429) {
      const retryAfter = (body!.parameters as { retry_after?: unknown } | undefined)?.retry_after;
      return { status: "retry", detail: "telegram_429",
        ...(Number.isSafeInteger(retryAfter) && (retryAfter as number) >= 0
          ? { retryAfterSeconds: Math.min(86_400, retryAfter as number) } : {}) };
    }
    if (code === 429) return { status: "ambiguous", detail: `inconsistent_http_${response.status}` };
    return { status: "failed", detail: `telegram_${code}` };
  }
  // No readable Bot API answer. A success status may hide an accepted message; a non-JSON
  // client error was rejected before the Bot API processed it.
  if (response.ok) return { status: "ambiguous", detail: `unreadable_http_${response.status}` };
  return { status: "failed", detail: `http_${response.status}` };
}

export function createActivityTelegramClient(environment: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch): { client: ActivityTelegramClient | null; invalidSettings: string[] } {
  const { token, chatId, invalidSettings } = telegramSettings(environment);
  if (invalidSettings.length) return { client: null, invalidSettings };
  const call = async (method: "sendMessage" | "sendDocument", body: BodyInit, json: boolean,
    timeoutMs: number): Promise<TelegramDelivery> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: "POST",
        ...(json ? { headers: { "Content-Type": "application/json" } } : {}), body, signal: controller.signal });
      return await classifyTelegramResponse(response);
    } catch (error) {
      if (controller.signal.aborted) return { status: "ambiguous", detail: "timeout" };
      const code = errorCode(error);
      if (code && PRE_CONNECT_ERRORS.has(code)) return { status: "retry", detail: "connect_error" };
      return { status: "ambiguous", detail: "network_error" };
    } finally {
      clearTimeout(timer);
    }
  };
  return { invalidSettings: [], client: {
    sendMessage: text => call("sendMessage", JSON.stringify({ chat_id: chatId, text,
      link_preview_options: { is_disabled: true } }), true, MESSAGE_TIMEOUT_MS),
    sendDocument(caption, filename, json) {
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", caption);
      form.set("document", new Blob([json], { type: "application/json" }), filename);
      return call("sendDocument", form, false, DOCUMENT_TIMEOUT_MS);
    },
  } };
}
