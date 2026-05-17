import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  endpointBucket,
  sanitizeChatGptRateLimitUrl,
  saveChatGptRateLimitLogArtifact,
  startChatGptRateLimitLogger,
  summarizeChatGptRateLimitEvents,
  type ChatGptRateLimitLogEvent,
} from "../../src/browser/rateLimitLogger.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("ChatGPT rate-limit logger", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
    vi.restoreAllMocks();
  });

  test("redacts path ids while preserving conversation-history query shape", () => {
    expect(
      sanitizeChatGptRateLimitUrl(
        "https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false",
      ),
    ).toBe(
      "https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false",
    );
    expect(
      sanitizeChatGptRateLimitUrl(
        "https://chatgpt.com/backend-api/conversation/123e4567-e89b-12d3-a456-426614174000?token=secret",
      ),
    ).toBe("https://chatgpt.com/backend-api/conversation/{id}?token=%5Bredacted%5D");
    expect(endpointBucket("https://chatgpt.com/backend-api/gizmos/g-abc/conversations")).toBe(
      "/backend-api/gizmos/{id}/conversations",
    );
  });

  test("summarizes response status and modal events", () => {
    const events: ChatGptRateLimitLogEvent[] = [
      {
        ts: "2026-05-17T00:00:00.000Z",
        relMs: 10,
        event: "request",
        endpoint: "/backend-api/conversations",
      },
      {
        ts: "2026-05-17T00:00:00.100Z",
        relMs: 100,
        event: "response",
        endpoint: "/backend-api/conversations",
        status: 429,
      },
      {
        ts: "2026-05-17T00:00:00.200Z",
        relMs: 200,
        event: "modalFound",
      },
    ];

    expect(
      summarizeChatGptRateLimitEvents(events, {
        startedAt: "2026-05-17T00:00:00.000Z",
        startedAtMs: Date.now(),
      }),
    ).toMatchObject({
      totalEvents: 3,
      relevantRequests: 1,
      relevantResponses: 1,
      statusCounts: { "429": 1 },
      endpointCounts: { "/backend-api/conversations": 1 },
      first429: { status: 429 },
      modalEvents: [{ event: "modalFound" }],
    });
  });

  test("records relevant CDP events and writes a session artifact", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-rate-limit-"));
    setOracleHomeDirOverrideForTest(tmpHome);

    const requestHandlers: Array<(event: Record<string, unknown>) => void> = [];
    const responseHandlers: Array<(event: Record<string, unknown>) => void> = [];
    const loadingFailedHandlers: Array<(event: Record<string, unknown>) => void> = [];
    const client = {
      Network: {
        requestWillBeSent: vi.fn((handler) => requestHandlers.push(handler)),
        responseReceived: vi.fn((handler) => responseHandlers.push(handler)),
        loadingFailed: vi.fn((handler) => loadingFailedHandlers.push(handler)),
      },
      Runtime: {
        evaluate: vi.fn(async () => ({
          result: {
            value: {
              href: "https://chatgpt.com/",
              modalFound: true,
              modalText: "Too many requests",
            },
          },
        })),
      },
    } as unknown as ChromeClient;

    const logger = startChatGptRateLimitLogger(client, {
      sessionId: "rate-limit-session",
      targetId: "target-1",
      pollModal: false,
    });
    requestHandlers[0]?.({
      requestId: "req-1",
      request: {
        method: "GET",
        url: "https://chatgpt.com/backend-api/conversations?offset=0&limit=28",
      },
    });
    responseHandlers[0]?.({
      requestId: "req-1",
      response: {
        status: 429,
        url: "https://chatgpt.com/backend-api/conversations?offset=0&limit=28",
        headers: { "retry-after": "120" },
      },
    });

    const artifact = await logger.stopAndSave();
    expect(artifact).toMatchObject({
      kind: "chatgpt-rate-limit-log",
      label: "ChatGPT rate-limit log",
      mimeType: "application/json",
    });
    const saved = JSON.parse(await fs.readFile(artifact!.path, "utf8")) as {
      summary: Record<string, unknown>;
      events: ChatGptRateLimitLogEvent[];
    };
    expect(saved.summary).toMatchObject({
      relevantRequests: 1,
      relevantResponses: 1,
      statusCounts: { "429": 1 },
    });
    expect(saved.events.some((event) => event.event === "modalFound")).toBe(true);
    expect(saved.events.find((event) => event.status === 429)).toMatchObject({
      endpoint: "/backend-api/conversations",
      retryAfter: "120",
    });
  });

  test("writes an empty logger artifact so absence of signals is explicit", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-rate-limit-empty-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const summary = summarizeChatGptRateLimitEvents([]);

    const artifact = await saveChatGptRateLimitLogArtifact({
      sessionId: "empty-rate-limit-session",
      events: [],
      summary,
    });

    expect(artifact?.path).toBe(
      path.join(
        tmpHome,
        "sessions",
        "empty-rate-limit-session",
        "artifacts",
        "chatgpt-rate-limit-log.json",
      ),
    );
  });
});
