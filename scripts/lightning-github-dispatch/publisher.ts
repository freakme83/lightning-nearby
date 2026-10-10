// Dispatch only the existing publisher; no social API or signing belongs here.
export const PUBLISHER_DISPATCH_URL =
  "https://api.github.com/repos/freakme83/lightning-nearby/actions/workflows/research-lightning-x-publisher.yml/dispatches";
const REQUEST_TIMEOUT_MS = 5_000;

export type PublisherDispatchResult =
  | { ok: true; httpStatus: 204 }
  | { ok: false; reason: "invalid_publication_id" | "timeout" | "network_error" | "http_error"; httpStatus?: number };
export type PublisherDispatcher = (publicationId: string) => Promise<PublisherDispatchResult>;

export function createPublisherDispatcher(environment: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch, timeoutMs = REQUEST_TIMEOUT_MS,
): { dispatch: PublisherDispatcher | null; invalidSettings: string[] } {
  const token = environment.GITHUB_ACTIONS_DISPATCH_TOKEN ?? "";
  // Accept a syntactically valid fine-grained PAT only. Permissions/expiry must be
  // checked operationally; startup performs no live API probe.
  if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) {
    return { dispatch: null, invalidSettings: ["GITHUB_ACTIONS_DISPATCH_TOKEN"] };
  }
  const dispatch: PublisherDispatcher = async publicationId => {
    if (!/^pub_[0-9a-f]{32}$/.test(publicationId)) return { ok: false, reason: "invalid_publication_id" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(PUBLISHER_DISPATCH_URL, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ ref: "main", inputs: { publicationId } }),
        signal: controller.signal,
        redirect: "error",
      });
      // The pinned API version returns 204. Never inspect or log response bodies,
      // request headers, or transport exception text. No retries, even on timeout.
      if (response.status === 204) return { ok: true, httpStatus: 204 };
      return { ok: false, reason: "http_error", httpStatus: response.status };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  };
  return { dispatch, invalidSettings: [] };
}
