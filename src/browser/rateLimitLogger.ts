import type Protocol from "devtools-protocol";
import type { SessionArtifact } from "../sessionStore.js";
import { writeTextBrowserArtifact } from "./artifacts.js";
import type { BrowserLogger, ChromeClient } from "./types.js";

const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MODAL_POLL_MS = 5_000;
const RATE_LIMIT_MODAL_SELECTOR = "modal-conversation-history-rate-limit";
const SENSITIVE_QUERY_KEYS = new Set(["access_token", "auth", "code", "key", "signature", "token"]);

export type ChatGptRateLimitEventName =
  | "request"
  | "response"
  | "loadingFailed"
  | "modalFound"
  | "modalPollError";

export interface ChatGptRateLimitLogEvent {
  ts: string;
  relMs: number;
  event: ChatGptRateLimitEventName;
  targetId?: string;
  targetUrl?: string;
  requestId?: string;
  method?: string;
  url?: string;
  endpoint?: string;
  status?: number;
  retryAfter?: string | null;
  detail?: unknown;
}

export interface ChatGptRateLimitLogSummary {
  generatedAt: string;
  startedAt: string;
  durationMs: number;
  totalEvents: number;
  droppedEvents: number;
  relevantRequests: number;
  relevantResponses: number;
  statusCounts: Record<string, number>;
  endpointCounts: Record<string, number>;
  first429: ChatGptRateLimitLogEvent | null;
  modalEvents: ChatGptRateLimitLogEvent[];
}

export interface ChatGptRateLimitLogger {
  stop(): Promise<void>;
  stopAndSave(): Promise<SessionArtifact | null>;
  snapshot(): {
    events: ChatGptRateLimitLogEvent[];
    summary: ChatGptRateLimitLogSummary;
  };
}

interface RequestRecord {
  url: string;
  method: string;
  endpoint: string;
}

interface StartRateLimitLoggerOptions {
  sessionId?: string;
  logger?: BrowserLogger;
  targetId?: string;
  getTargetUrl?: () => string | undefined;
  maxEvents?: number;
  modalPollMs?: number;
  pollModal?: boolean;
}

interface SaveRateLimitLogArtifactOptions {
  sessionId?: string;
  events: ChatGptRateLimitLogEvent[];
  summary: ChatGptRateLimitLogSummary;
  logger?: BrowserLogger;
}

export function startChatGptRateLimitLogger(
  client: ChromeClient,
  options: StartRateLimitLoggerOptions = {},
): ChatGptRateLimitLogger {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS);
  const requests = new Map<string, RequestRecord>();
  const events: ChatGptRateLimitLogEvent[] = [];
  let stopped = false;
  let droppedEvents = 0;
  let firstSignalLogged = false;
  let modalPollInFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const push = (row: Omit<ChatGptRateLimitLogEvent, "ts" | "relMs">): void => {
    if (stopped) {
      return;
    }
    const event: ChatGptRateLimitLogEvent = {
      ts: new Date().toISOString(),
      relMs: Date.now() - startedAtMs,
      ...row,
    };
    if (events.length >= maxEvents) {
      events.shift();
      droppedEvents += 1;
    }
    events.push(event);
    if (!firstSignalLogged && (event.status === 429 || event.event === "modalFound")) {
      firstSignalLogged = true;
      const endpoint = event.endpoint ? ` ${event.endpoint}` : "";
      options.logger?.(`[browser] ChatGPT rate-limit signal captured:${endpoint}`);
    }
  };

  client.Network.requestWillBeSent((event: Protocol.Network.RequestWillBeSentEvent) => {
    const url = event.request.url;
    if (!isRelevantChatGptRateLimitUrl(url)) {
      return;
    }
    const sanitizedUrl = sanitizeChatGptRateLimitUrl(url);
    const endpoint = endpointBucket(url);
    requests.set(event.requestId, {
      url: sanitizedUrl,
      method: event.request.method,
      endpoint,
    });
    push({
      event: "request",
      targetId: options.targetId,
      targetUrl: options.getTargetUrl?.(),
      requestId: event.requestId,
      method: event.request.method,
      url: sanitizedUrl,
      endpoint,
    });
  });

  client.Network.responseReceived((event: Protocol.Network.ResponseReceivedEvent) => {
    const remembered = requests.get(event.requestId);
    const rawUrl = event.response.url || remembered?.url;
    if (!rawUrl || !isRelevantChatGptRateLimitUrl(rawUrl)) {
      return;
    }
    const endpoint = remembered?.endpoint ?? endpointBucket(rawUrl);
    push({
      event: "response",
      targetId: options.targetId,
      targetUrl: options.getTargetUrl?.(),
      requestId: event.requestId,
      method: remembered?.method,
      url: remembered?.url ?? sanitizeChatGptRateLimitUrl(rawUrl),
      endpoint,
      status: event.response.status,
      retryAfter: headerValue(event.response.headers, "retry-after"),
    });
  });

  client.Network.loadingFailed((event: Protocol.Network.LoadingFailedEvent) => {
    const remembered = requests.get(event.requestId);
    if (!remembered) {
      return;
    }
    push({
      event: "loadingFailed",
      targetId: options.targetId,
      targetUrl: options.getTargetUrl?.(),
      requestId: event.requestId,
      method: remembered.method,
      url: remembered.url,
      endpoint: remembered.endpoint,
      detail: {
        errorText: event.errorText,
        blockedReason: event.blockedReason,
        canceled: event.canceled,
      },
    });
  });

  const pollModal = async (): Promise<void> => {
    if (stopped || modalPollInFlight) {
      return;
    }
    modalPollInFlight = true;
    try {
      const modal = await readConversationHistoryRateLimitModal(client.Runtime);
      if (modal?.modalFound) {
        push({
          event: "modalFound",
          targetId: options.targetId,
          targetUrl: modal.href ?? options.getTargetUrl?.(),
          detail: modal,
        });
      }
    } catch (error) {
      push({
        event: "modalPollError",
        targetId: options.targetId,
        targetUrl: options.getTargetUrl?.(),
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      modalPollInFlight = false;
    }
  };

  const pollModalEnabled = options.pollModal ?? true;
  const modalPollMs = Math.max(1_000, options.modalPollMs ?? DEFAULT_MODAL_POLL_MS);
  if (pollModalEnabled) {
    void pollModal();
    timer = setInterval(() => void pollModal(), modalPollMs);
    timer.unref?.();
  }

  const buildSnapshot = () => {
    const summary = summarizeChatGptRateLimitEvents(events, {
      droppedEvents,
      startedAt,
      startedAtMs,
    });
    return {
      events: [...events],
      summary,
    };
  };

  const stop = async (): Promise<void> => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await pollModal().catch(() => undefined);
    stopped = true;
  };

  return {
    stop,
    async stopAndSave() {
      await stop();
      const snapshot = buildSnapshot();
      return saveChatGptRateLimitLogArtifact({
        sessionId: options.sessionId,
        events: snapshot.events,
        summary: snapshot.summary,
        logger: options.logger,
      });
    },
    snapshot: buildSnapshot,
  };
}

export async function saveChatGptRateLimitLogArtifact(
  options: SaveRateLimitLogArtifactOptions,
): Promise<SessionArtifact | null> {
  const payload = {
    schemaVersion: 1,
    source: "oracle-chatgpt-browser-rate-limit-logger",
    summary: options.summary,
    events: options.events,
  };
  return writeTextBrowserArtifact({
    sessionId: options.sessionId,
    kind: "chatgpt-rate-limit-log",
    filename: "chatgpt-rate-limit-log.json",
    contents: JSON.stringify(payload, null, 2),
    label: "ChatGPT rate-limit log",
    mimeType: "application/json",
    logger: options.logger,
  });
}

export function summarizeChatGptRateLimitEvents(
  events: ChatGptRateLimitLogEvent[],
  options: { droppedEvents?: number; startedAt?: string; startedAtMs?: number } = {},
): ChatGptRateLimitLogSummary {
  const statusCounts = new Map<string, number>();
  const endpointCounts = new Map<string, number>();
  for (const event of events) {
    if (event.event !== "response") {
      continue;
    }
    const statusKey = String(event.status ?? "unknown");
    statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);
    const endpoint = event.endpoint ?? (event.url ? endpointBucket(event.url) : undefined);
    if (endpoint) {
      endpointCounts.set(endpoint, (endpointCounts.get(endpoint) ?? 0) + 1);
    }
  }
  const now = Date.now();
  const startedAtMs = options.startedAtMs ?? now;
  return {
    generatedAt: new Date(now).toISOString(),
    startedAt: options.startedAt ?? new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, now - startedAtMs),
    totalEvents: events.length,
    droppedEvents: options.droppedEvents ?? 0,
    relevantRequests: events.filter((event) => event.event === "request").length,
    relevantResponses: events.filter((event) => event.event === "response").length,
    statusCounts: Object.fromEntries(statusCounts),
    endpointCounts: Object.fromEntries([...endpointCounts.entries()].sort()),
    first429: events.find((event) => event.status === 429) ?? null,
    modalEvents: events.filter((event) => event.event === "modalFound"),
  };
}

export async function readConversationHistoryRateLimitModal(
  Runtime: ChromeClient["Runtime"],
): Promise<{ href?: string; modalFound: boolean; modalText: string | null } | null> {
  const result = await Runtime.evaluate({
    returnByValue: true,
    expression: `(() => {
      const modal = document.querySelector('[data-testid="${RATE_LIMIT_MODAL_SELECTOR}"]');
      return {
        href: location.href,
        modalFound: Boolean(modal),
        modalText: modal?.textContent ?? null
      };
    })()`,
  });
  const value = result.result.value;
  if (!value || typeof value !== "object") {
    return null;
  }
  const modal = value as { href?: unknown; modalFound?: unknown; modalText?: unknown };
  return {
    href: typeof modal.href === "string" ? modal.href : undefined,
    modalFound: Boolean(modal.modalFound),
    modalText: typeof modal.modalText === "string" ? modal.modalText : null,
  };
}

export function isRelevantChatGptRateLimitUrl(url: string): boolean {
  return (
    url.includes("/backend-api/conversations") ||
    url.includes("/backend-api/conversation") ||
    url.includes("/backend-api/projects") ||
    url.includes("/backend-api/gizmos") ||
    url.includes("/backend-api/accounts")
  );
}

export function sanitizeChatGptRateLimitUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const redactedPath = redactPathIds(url.pathname);
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        params.set(key, "[redacted]");
      } else if (value.length > 120) {
        params.set(key, `${value.slice(0, 120)}...`);
      } else {
        params.set(key, value);
      }
    }
    const query = params.toString();
    return `${url.origin}${redactedPath}${query ? `?${query}` : ""}`;
  } catch {
    return rawUrl;
  }
}

export function endpointBucket(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = redactPathIds(url.pathname);
    if (pathname.includes("/gizmos/") && pathname.endsWith("/conversations")) {
      return "/backend-api/gizmos/{id}/conversations";
    }
    return pathname;
  } catch {
    return rawUrl;
  }
}

function redactPathIds(pathname: string): string {
  return pathname
    .replace(/(\/backend-api\/gizmos\/)[^/]+(?=\/|$)/g, "$1{id}")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/{id}")
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, "/{id}")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/{id}");
}

function headerValue(headers: Record<string, unknown>, wanted: string): string | null {
  const lowered = wanted.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      return String(value);
    }
  }
  return null;
}
