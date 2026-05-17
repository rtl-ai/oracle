#!/usr/bin/env tsx
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import CDP from "chrome-remote-interface";
import { launch, type LaunchedChrome } from "chrome-launcher";

type Mode = "observe" | "probe";

interface Options {
  mode: Mode;
  profileDir: string;
  outDir: string;
  port?: number;
  observeMs: number;
  probeCount: number;
  probeIntervalMs: number;
  burstSize: number;
  offsetMode: "same" | "sequential";
  targetSet: "main" | "observed-conversations" | "observed-relevant";
  closeChrome: boolean;
}

interface EventRow {
  ts: string;
  relMs: number;
  event: string;
  url?: string;
  method?: string;
  status?: number;
  requestId?: string;
  type?: string;
  fromProbe?: boolean;
  retryAfter?: string | null;
  detail?: unknown;
}

const CONVERSATIONS_URL =
  "https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false";

function parseArgs(argv: string[]): Options {
  const home = process.env.HOME ?? "/Users/pat";
  const opts: Options = {
    mode: "observe",
    profileDir: path.join(home, ".oracle", "oracle-live-browser-profile"),
    outDir: path.join(home, "oracle", "artifacts", "chatgpt-history-limit"),
    observeMs: 20_000,
    probeCount: 0,
    probeIntervalMs: 5_000,
    burstSize: 1,
    offsetMode: "same",
    targetSet: "main",
    closeChrome: true,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--mode":
        opts.mode = next() as Mode;
        break;
      case "--profile-dir":
        opts.profileDir = next();
        break;
      case "--out-dir":
        opts.outDir = next();
        break;
      case "--port":
        opts.port = Number.parseInt(next(), 10);
        break;
      case "--observe-ms":
        opts.observeMs = Number.parseInt(next(), 10);
        break;
      case "--probe-count":
        opts.probeCount = Number.parseInt(next(), 10);
        break;
      case "--probe-interval-ms":
        opts.probeIntervalMs = Number.parseInt(next(), 10);
        break;
      case "--burst-size":
        opts.burstSize = Number.parseInt(next(), 10);
        break;
      case "--offset-mode":
        opts.offsetMode = next() as Options["offsetMode"];
        break;
      case "--target-set":
        opts.targetSet = next() as Options["targetSet"];
        break;
      case "--keep-chrome":
        opts.closeChrome = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.mode !== "observe" && opts.mode !== "probe") {
    throw new Error(`Unsupported --mode: ${opts.mode}`);
  }
  if (opts.offsetMode !== "same" && opts.offsetMode !== "sequential") {
    throw new Error(`Unsupported --offset-mode: ${opts.offsetMode}`);
  }
  if (
    opts.targetSet !== "main" &&
    opts.targetSet !== "observed-conversations" &&
    opts.targetSet !== "observed-relevant"
  ) {
    throw new Error(`Unsupported --target-set: ${opts.targetSet}`);
  }
  for (const [name, value] of [
    ["observe-ms", opts.observeMs],
    ["probe-count", opts.probeCount],
    ["probe-interval-ms", opts.probeIntervalMs],
    ["burst-size", opts.burstSize],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${name}: ${value}`);
  }
  if (opts.burstSize < 1) throw new Error("--burst-size must be at least 1");
  if (opts.port !== undefined && (!Number.isFinite(opts.port) || opts.port <= 0)) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  pnpm tsx scripts/chatgpt-history-limit-probe.ts --mode observe
  pnpm tsx scripts/chatgpt-history-limit-probe.ts --mode probe --probe-count 8 --probe-interval-ms 5000

This launches Chrome with the Oracle manual-login profile, opens chatgpt.com,
records backend-api/conversations requests, and optionally performs a bounded
same-origin fetch probe. It stops probe requests immediately on the first 429.`);
}

async function safeRemoveStaleChromeState(profileDir: string) {
  const lockPath = path.join(profileDir, "SingletonLock");
  let lockText = "";
  try {
    lockText = await readFile(lockPath, "utf8");
  } catch {
    return;
  }
  const match = lockText.match(/-(\d+)$/);
  if (!match) return;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
    throw new Error(
      `Chrome profile appears active via ${lockPath} (pid ${pid}). Refusing to reuse it.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await Promise.all([
    rm(path.join(profileDir, "SingletonLock"), { force: true }),
    rm(path.join(profileDir, "SingletonSocket"), { force: true }),
    rm(path.join(profileDir, "SingletonCookie"), { force: true }),
    rm(path.join(profileDir, "DevToolsActivePort"), { force: true }),
  ]);
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(opts.outDir, `${stamp}-${opts.mode}`);
  await mkdir(runDir, { recursive: true });
  const jsonlPath = path.join(runDir, "events.jsonl");
  const summaryPath = path.join(runDir, "summary.json");
  const rows: EventRow[] = [];
  const requestUrls = new Map<string, string>();

  const push = (row: Omit<EventRow, "ts" | "relMs">) => {
    rows.push({ ts: nowIso(), relMs: Date.now() - started, ...row });
  };

  await safeRemoveStaleChromeState(opts.profileDir);
  const chrome = await launchChrome(opts);
  let client: Awaited<ReturnType<typeof CDP>> | undefined;

  try {
    const target = await CDP.New({ port: chrome.port, url: "about:blank" });
    client = await CDP({ port: chrome.port, target });
    const { Network, Page, Runtime } = client;
    await Promise.all([Network.enable(), Page.enable(), Runtime.enable()]);

    Network.requestWillBeSent((event) => {
      const url = event.request.url;
      requestUrls.set(event.requestId, url);
      if (isRelevantUrl(url)) {
        push({
          event: "request",
          requestId: event.requestId,
          method: event.request.method,
          url,
          type: event.type,
        });
      }
    });
    Network.responseReceived((event) => {
      const url = event.response.url || requestUrls.get(event.requestId);
      if (url && isRelevantUrl(url)) {
        push({
          event: "response",
          requestId: event.requestId,
          status: event.response.status,
          url,
          type: event.type,
          retryAfter: headerValue(event.response.headers, "retry-after"),
        });
      }
    });
    Network.loadingFailed((event) => {
      const url = requestUrls.get(event.requestId);
      if (url && isRelevantUrl(url)) {
        push({
          event: "loadingFailed",
          requestId: event.requestId,
          url,
          type: event.type,
          detail: {
            errorText: event.errorText,
            canceled: event.canceled,
            blockedReason: event.blockedReason,
          },
        });
      }
    });

    push({ event: "navigate", url: "https://chatgpt.com/" });
    await Page.navigate({ url: "https://chatgpt.com/" });
    await sleep(opts.observeMs);

    const pageState = await Runtime.evaluate({
      returnByValue: true,
      expression: `(() => {
        const modal = document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');
        const composer = document.querySelector('textarea, [contenteditable="true"], [data-testid="composer"]');
        const login = document.querySelector('a[href*="login"], button[data-testid*="login"]');
        return {
          href: location.href,
          title: document.title,
          modalFound: Boolean(modal),
          modalText: modal?.textContent ?? null,
          hasComposerLikeElement: Boolean(composer),
          hasLoginLikeElement: Boolean(login),
        };
      })()`,
    });
    push({ event: "pageState", detail: pageState.result.value });

    if (opts.mode === "probe" && opts.probeCount > 0) {
      const observedProbeUrls = resolveProbeUrls(rows, opts);
      push({ event: "probeTargetSet", detail: observedProbeUrls });
      let globalIndex = 0;
      for (let index = 0; index < opts.probeCount; index++) {
        const probes = Array.from({ length: opts.burstSize }, (_, burstIndex) => {
          const probeIndex = globalIndex++;
          const probeUrl = probeUrlForIndex(observedProbeUrls, probeIndex, opts);
          return { probeIndex, burstIndex, probeUrl };
        });
        const result = await Runtime.evaluate({
          awaitPromise: true,
          returnByValue: true,
          expression: `Promise.all(${JSON.stringify(probes)}.map(({ probeIndex, burstIndex, probeUrl }) =>
            fetch(probeUrl, {
                credentials: "include",
                cache: "no-store",
                headers: { "accept": "application/json" }
              }).then((res) => ({
                loopIndex: ${index},
                probeIndex,
                burstIndex,
                url: probeUrl,
                status: res.status,
                ok: res.ok,
                retryAfter: res.headers.get("retry-after"),
                date: res.headers.get("date"),
                contentType: res.headers.get("content-type")
              })).catch((error) => ({
                loopIndex: ${index},
                probeIndex,
                burstIndex,
                url: probeUrl,
                error: String(error?.message ?? error)
              }))
          ))`,
        });
        const values = result.result.value as Array<{
          url?: string;
          status?: number;
          retryAfter?: string | null;
        }>;
        for (const value of values) {
          push({
            event: "probeFetch",
            url: value.url,
            fromProbe: true,
            status: value?.status,
            retryAfter: value?.retryAfter ?? null,
            detail: value,
          });
        }
        if (values.some((value) => value?.status === 429)) break;
        if (index < opts.probeCount - 1 && opts.probeIntervalMs > 0) {
          await sleep(opts.probeIntervalMs);
        }
      }
    }

    await sleep(2_000);
    const finalState = await Runtime.evaluate({
      returnByValue: true,
      expression: `(() => {
        const modal = document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');
        return { href: location.href, modalFound: Boolean(modal), modalText: modal?.textContent ?? null };
      })()`,
    });
    push({ event: "finalPageState", detail: finalState.result.value });
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (opts.closeChrome) {
      try {
        await chrome.kill();
      } catch {
        // ignore Chrome cleanup failures; the collected network rows are the important artifact
      }
      await rm(path.join(opts.profileDir, "DevToolsActivePort"), { force: true }).catch(
        () => undefined,
      );
    }
  }

  await writeFile(jsonlPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const summary = summarize(rows, opts, runDir);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

async function launchChrome(opts: Options): Promise<LaunchedChrome> {
  return await launch({
    port: opts.port,
    userDataDir: opts.profileDir,
    handleSIGINT: false,
    chromeFlags: [
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--disable-popup-blocking",
    ],
  });
}

function isRelevantUrl(url: string) {
  return (
    url.includes("/backend-api/conversations") ||
    url.includes("/backend-api/conversation") ||
    url.includes("/backend-api/projects") ||
    url.includes("/backend-api/gizmos") ||
    url.includes("/backend-api/accounts")
  );
}

function headerValue(headers: Record<string, unknown>, wanted: string): string | null {
  const lowered = wanted.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return String(value);
  }
  return null;
}

function summarize(rows: EventRow[], opts: Options, runDir: string) {
  const responses = rows.filter((row) => row.event === "response" || row.event === "probeFetch");
  const byStatus = new Map<string, number>();
  for (const row of responses) {
    const key = String(row.status ?? "unknown");
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  const conversationResponses = responses.filter((row) =>
    row.url?.includes("/backend-api/conversations"),
  );
  const first429 = responses.find((row) => row.status === 429);
  return {
    mode: opts.mode,
    runDir,
    profileDir: opts.profileDir,
    observeMs: opts.observeMs,
    probeCount: opts.probeCount,
    probeIntervalMs: opts.probeIntervalMs,
    burstSize: opts.burstSize,
    offsetMode: opts.offsetMode,
    targetSet: opts.targetSet,
    totalEvents: rows.length,
    relevantRequests: rows.filter((row) => row.event === "request").length,
    relevantResponses: responses.length,
    conversationResponses: conversationResponses.length,
    statusCounts: Object.fromEntries(byStatus),
    first429: first429 ?? null,
    modalStates: rows.filter((row) => row.event === "pageState" || row.event === "finalPageState"),
  };
}

function resolveProbeUrls(rows: EventRow[], opts: Options): string[] {
  if (opts.targetSet === "main") return [CONVERSATIONS_URL];
  const urls = new Set<string>();
  for (const row of rows) {
    if (row.event !== "request" || row.method !== "GET" || !row.url) continue;
    if (opts.targetSet === "observed-conversations") {
      if (row.url.includes("/conversations")) urls.add(row.url);
    } else if (opts.targetSet === "observed-relevant") {
      if (isRelevantUrl(row.url)) urls.add(row.url);
    }
  }
  return urls.size > 0 ? [...urls] : [CONVERSATIONS_URL];
}

function probeUrlForIndex(urls: string[], index: number, opts: Options): string {
  const baseUrl = urls[index % urls.length] ?? CONVERSATIONS_URL;
  if (opts.offsetMode !== "sequential") return baseUrl;
  if (!baseUrl.includes("/backend-api/conversations?")) return baseUrl;
  const url = new URL(baseUrl);
  url.searchParams.set("offset", String(Math.floor(index / urls.length) * 28));
  return url.toString();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
