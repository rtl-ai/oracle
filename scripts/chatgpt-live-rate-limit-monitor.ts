#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import CDP from "chrome-remote-interface";

const execFileAsync = promisify(execFile);

interface Options {
  profileDir: string;
  outDir: string;
  durationMs: number;
  pollMs: number;
  modalPollMs: number;
}

interface EventRow {
  ts: string;
  relMs: number;
  event: string;
  targetId?: string;
  targetUrl?: string;
  requestId?: string;
  method?: string;
  url?: string;
  status?: number;
  retryAfter?: string | null;
  detail?: unknown;
}

interface AttachedTarget {
  id: string;
  url: string;
  client: Awaited<ReturnType<typeof CDP>>;
  requests: Map<string, { url: string; method: string }>;
  lastModalPollAt: number;
}

function parseArgs(argv: string[]): Options {
  const home = process.env.HOME ?? "/Users/pat";
  const opts: Options = {
    profileDir: path.join(home, ".oracle", "oracle-live-browser-profile"),
    outDir: path.join(home, "oracle", "artifacts", "chatgpt-history-limit"),
    durationMs: 10 * 60_000,
    pollMs: 1_000,
    modalPollMs: 5_000,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--profile-dir":
        opts.profileDir = next();
        break;
      case "--out-dir":
        opts.outDir = next();
        break;
      case "--duration-ms":
        opts.durationMs = Number.parseInt(next(), 10);
        break;
      case "--poll-ms":
        opts.pollMs = Number.parseInt(next(), 10);
        break;
      case "--modal-poll-ms":
        opts.modalPollMs = Number.parseInt(next(), 10);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.durationMs) || opts.durationMs <= 0) {
    throw new Error("--duration-ms must be positive");
  }
  if (!Number.isFinite(opts.pollMs) || opts.pollMs < 250) {
    throw new Error("--poll-ms must be >= 250");
  }
  if (!Number.isFinite(opts.modalPollMs) || opts.modalPollMs < 1_000) {
    throw new Error("--modal-poll-ms must be >= 1000");
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  ./node_modules/.bin/tsx scripts/chatgpt-live-rate-limit-monitor.ts --duration-ms 600000

Passive monitor. It waits for an Oracle/Chrome DevToolsActivePort in the manual
login profile, attaches to existing ChatGPT page targets, records relevant
backend-api response status codes and the conversation-history rate-limit modal,
and writes JSONL artifacts. It does not navigate or send ChatGPT prompts.`);
}

async function readActivePort(profileDir: string): Promise<number | null> {
  const candidatePorts: number[] = [];
  const candidateFiles = [
    path.join(profileDir, "DevToolsActivePort"),
    path.join(profileDir, "Default", "DevToolsActivePort"),
  ];
  for (const file of candidateFiles) {
    try {
      const raw = await readFile(file, "utf8");
      const first = raw.split(/\r?\n/)[0]?.trim();
      const port = Number.parseInt(first ?? "", 10);
      if (Number.isFinite(port) && port > 0) candidatePorts.push(port);
    } catch {
      // keep trying candidates
    }
  }
  candidatePorts.push(...(await readActivePortsFromProcessList(profileDir)));
  for (const port of [...new Set(candidatePorts)]) {
    if (await isDevtoolsPortReachable(port)) return port;
  }
  return null;
}

async function readActivePortsFromProcessList(profileDir: string): Promise<number[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ps", ["-axww", "-o", "command="], {
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch {
    return [];
  }
  const ports: number[] = [];
  const normalizedProfile = path.resolve(profileDir);
  for (const line of stdout.split("\n")) {
    if (!line.includes("Google Chrome") && !line.includes("Chromium")) continue;
    if (!line.includes("--remote-debugging-port")) continue;
    const userDataDir = extractFlagValue(line, "--user-data-dir");
    if (!userDataDir || path.resolve(userDataDir) !== normalizedProfile) continue;
    const rawPort = extractFlagValue(line, "--remote-debugging-port");
    const port = Number.parseInt(rawPort ?? "", 10);
    if (Number.isFinite(port) && port > 0) ports.push(port);
  }
  return [...new Set(ports)];
}

async function isDevtoolsPortReachable(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function extractFlagValue(command: string, flag: string): string | null {
  const equals = new RegExp(`${escapeRegExp(flag)}=([^\\s]+)`).exec(command);
  if (equals?.[1]) return equals[1];
  const spaced = new RegExp(`${escapeRegExp(flag)}\\s+([^\\s]+)`).exec(command);
  return spaced?.[1] ?? null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function isChatGptPageTarget(target: { type?: string; url?: string }) {
  const url = target.url ?? "";
  return target.type === "page" && /^https:\/\/chatgpt\.com\//.test(url);
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(opts.outDir, `${stamp}-live-monitor`);
  await mkdir(runDir, { recursive: true });
  const rows: EventRow[] = [];
  const attached = new Map<string, AttachedTarget>();
  let currentPort: number | null = null;

  const push = (row: Omit<EventRow, "ts" | "relMs">) => {
    rows.push({ ts: nowIso(), relMs: Date.now() - started, ...row });
  };

  const deadline = Date.now() + opts.durationMs;
  try {
    while (Date.now() < deadline) {
      const port = await readActivePort(opts.profileDir);
      if (port !== currentPort) {
        currentPort = port;
        push({ event: "port", detail: { port } });
        for (const target of attached.values()) {
          await target.client.close().catch(() => undefined);
        }
        attached.clear();
      }

      if (port) {
        const targets = await CDP.List({ port }).catch(() => []);
        const activeIds = new Set<string>();
        for (const target of targets) {
          if (!target.id || !isChatGptPageTarget(target)) continue;
          activeIds.add(target.id);
          if (!attached.has(target.id)) {
            const attachedTarget = await attachTarget(port, target.id, target.url ?? "", push);
            attached.set(target.id, attachedTarget);
            push({
              event: "targetAttached",
              targetId: target.id,
              targetUrl: target.url,
              detail: { title: target.title },
            });
          }
        }
        for (const [targetId, target] of attached.entries()) {
          if (!activeIds.has(targetId)) {
            await target.client.close().catch(() => undefined);
            attached.delete(targetId);
            push({ event: "targetDetached", targetId, targetUrl: target.url });
          }
        }
        for (const target of attached.values()) {
          if (Date.now() - target.lastModalPollAt >= opts.modalPollMs) {
            target.lastModalPollAt = Date.now();
            await pollModal(target, push).catch((error) => {
              push({
                event: "modalPollError",
                targetId: target.id,
                targetUrl: target.url,
                detail: String(error),
              });
            });
          }
        }
      }

      if (rows.some((row) => row.status === 429)) {
        await sleep(Math.min(opts.modalPollMs, 5_000));
      }
      await sleep(opts.pollMs);
    }
  } finally {
    for (const target of attached.values()) {
      await target.client.close().catch(() => undefined);
    }
  }

  await writeFile(
    path.join(runDir, "events.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const summary = summarize(rows, opts, runDir);
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

async function attachTarget(
  port: number,
  targetId: string,
  targetUrl: string,
  push: (row: Omit<EventRow, "ts" | "relMs">) => void,
): Promise<AttachedTarget> {
  const client = await CDP({ port, target: targetId });
  const { Network, Runtime } = client;
  const record: AttachedTarget = {
    id: targetId,
    url: targetUrl,
    client,
    requests: new Map(),
    lastModalPollAt: 0,
  };
  await Promise.all([Network.enable(), Runtime.enable()]);
  Network.requestWillBeSent((event) => {
    record.requests.set(event.requestId, {
      url: event.request.url,
      method: event.request.method,
    });
    if (!isRelevantUrl(event.request.url)) return;
    push({
      event: "request",
      targetId,
      targetUrl,
      requestId: event.requestId,
      method: event.request.method,
      url: event.request.url,
    });
  });
  Network.responseReceived((event) => {
    const remembered = record.requests.get(event.requestId);
    const url = event.response.url || remembered?.url;
    if (!url || !isRelevantUrl(url)) return;
    push({
      event: "response",
      targetId,
      targetUrl,
      requestId: event.requestId,
      method: remembered?.method,
      url,
      status: event.response.status,
      retryAfter: headerValue(event.response.headers, "retry-after"),
    });
  });
  Network.loadingFailed((event) => {
    const remembered = record.requests.get(event.requestId);
    if (!remembered?.url || !isRelevantUrl(remembered.url)) return;
    push({
      event: "loadingFailed",
      targetId,
      targetUrl,
      requestId: event.requestId,
      method: remembered.method,
      url: remembered.url,
      detail: {
        errorText: event.errorText,
        blockedReason: event.blockedReason,
        canceled: event.canceled,
      },
    });
  });
  return record;
}

async function pollModal(
  target: AttachedTarget,
  push: (row: Omit<EventRow, "ts" | "relMs">) => void,
) {
  const result = await target.client.Runtime.evaluate({
    returnByValue: true,
    expression: `(() => {
      const modal = document.querySelector('[data-testid="modal-conversation-history-rate-limit"]');
      return {
        href: location.href,
        modalFound: Boolean(modal),
        modalText: modal?.textContent ?? null
      };
    })()`,
  });
  const value = result.result.value as
    | { href?: string; modalFound?: boolean; modalText?: string | null }
    | undefined;
  if (value?.modalFound) {
    push({
      event: "modalFound",
      targetId: target.id,
      targetUrl: target.url,
      detail: value,
    });
  }
}

function headerValue(headers: Record<string, unknown>, wanted: string): string | null {
  const lowered = wanted.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return String(value);
  }
  return null;
}

function summarize(rows: EventRow[], opts: Options, runDir: string) {
  const responses = rows.filter((row) => row.event === "response");
  const statusCounts = new Map<string, number>();
  const endpointCounts = new Map<string, number>();
  for (const row of responses) {
    const statusKey = String(row.status ?? "unknown");
    statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);
    if (row.url) {
      const endpointKey = endpointBucket(row.url);
      endpointCounts.set(endpointKey, (endpointCounts.get(endpointKey) ?? 0) + 1);
    }
  }
  return {
    runDir,
    profileDir: opts.profileDir,
    durationMs: opts.durationMs,
    totalEvents: rows.length,
    attachedTargets: new Set(rows.filter((row) => row.targetId).map((row) => row.targetId)).size,
    relevantRequests: rows.filter((row) => row.event === "request").length,
    relevantResponses: responses.length,
    statusCounts: Object.fromEntries(statusCounts),
    endpointCounts: Object.fromEntries([...endpointCounts.entries()].sort()),
    first429: rows.find((row) => row.status === 429) ?? null,
    modalEvents: rows.filter((row) => row.event === "modalFound"),
  };
}

function endpointBucket(rawUrl: string) {
  const url = new URL(rawUrl);
  const pathname = url.pathname.replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/{id}");
  if (pathname.includes("/gizmos/") && pathname.endsWith("/conversations")) {
    return "/backend-api/gizmos/{gizmo_id}/conversations";
  }
  return pathname;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
