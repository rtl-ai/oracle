#!/usr/bin/env tsx
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, type LaunchedChrome } from "chrome-launcher";
import puppeteer, { type Page } from "puppeteer-core";

interface Options {
  profileDir: string;
  outDir: string;
  tabs: number;
  staggerMs: number;
  holdMs: number;
}

interface EventRow {
  ts: string;
  relMs: number;
  event: string;
  tab?: number;
  url?: string;
  method?: string;
  status?: number;
  retryAfter?: string | null;
  detail?: unknown;
}

function parseArgs(argv: string[]): Options {
  const home = process.env.HOME ?? "/Users/pat";
  const opts: Options = {
    profileDir: path.join(home, ".oracle", "oracle-live-browser-profile"),
    outDir: path.join(home, "oracle", "artifacts", "chatgpt-history-limit"),
    tabs: 3,
    staggerMs: 0,
    holdMs: 25_000,
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
      case "--tabs":
        opts.tabs = Number.parseInt(next(), 10);
        break;
      case "--stagger-ms":
        opts.staggerMs = Number.parseInt(next(), 10);
        break;
      case "--hold-ms":
        opts.holdMs = Number.parseInt(next(), 10);
        break;
      case "--help":
      case "-h":
        console.log(`Usage:
  ./node_modules/.bin/tsx scripts/chatgpt-tab-burst-probe.ts --tabs 5 --stagger-ms 500 --hold-ms 25000

Launches Chrome with the Oracle ChatGPT profile, opens N chatgpt.com tabs,
records relevant backend responses, checks for the conversation-history
rate-limit modal, and writes JSONL artifacts.`);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.tabs) || opts.tabs < 1 || opts.tabs > 50) {
    throw new Error("--tabs must be between 1 and 50");
  }
  if (!Number.isFinite(opts.staggerMs) || opts.staggerMs < 0) {
    throw new Error("--stagger-ms must be >= 0");
  }
  if (!Number.isFinite(opts.holdMs) || opts.holdMs < 0) {
    throw new Error("--hold-ms must be >= 0");
  }
  return opts;
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

function isRelevantUrl(url: string) {
  return (
    url.includes("/backend-api/conversations") ||
    url.includes("/backend-api/conversation") ||
    url.includes("/backend-api/projects") ||
    url.includes("/backend-api/gizmos") ||
    url.includes("/backend-api/accounts")
  );
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(opts.outDir, `${stamp}-tab-burst-${opts.tabs}`);
  await mkdir(runDir, { recursive: true });
  const rows: EventRow[] = [];
  const push = (row: Omit<EventRow, "ts" | "relMs">) => {
    rows.push({ ts: nowIso(), relMs: Date.now() - started, ...row });
  };

  await safeRemoveStaleChromeState(opts.profileDir);
  const chrome = await launchChrome(opts);
  let browser: Awaited<ReturnType<typeof puppeteer.connect>> | undefined;
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${chrome.port}`,
      defaultViewport: null,
    });

    const pages: Page[] = [];
    for (let index = 0; index < opts.tabs; index++) {
      const page = await browser.newPage();
      attachPageLogging(page, index, push);
      pages.push(page);
    }

    await Promise.all(
      pages.map(async (page, index) => {
        if (opts.staggerMs > 0) await sleep(index * opts.staggerMs);
        push({ event: "navigate", tab: index, url: "https://chatgpt.com/" });
        await page
          .goto("https://chatgpt.com/", {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          })
          .catch((error) => {
            push({ event: "navigateError", tab: index, detail: String(error) });
          });
      }),
    );

    await sleep(opts.holdMs);

    for (const [index, page] of pages.entries()) {
      const state = await page
        .evaluate(() => {
          const modal = document.querySelector(
            '[data-testid="modal-conversation-history-rate-limit"]',
          );
          const composer = document.querySelector(
            'textarea, [contenteditable="true"], [data-testid="composer"]',
          );
          return {
            href: location.href,
            title: document.title,
            modalFound: Boolean(modal),
            modalText: modal?.textContent ?? null,
            hasComposerLikeElement: Boolean(composer),
          };
        })
        .catch((error) => ({ error: String(error) }));
      push({ event: "pageState", tab: index, detail: state });
    }
  } finally {
    if (browser) await browser.disconnect();
    try {
      await chrome.kill();
    } catch {
      // ignore cleanup errors
    }
    await rm(path.join(opts.profileDir, "DevToolsActivePort"), { force: true }).catch(
      () => undefined,
    );
  }

  await writeFile(
    path.join(runDir, "events.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const summary = summarize(rows, opts, runDir);
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

function attachPageLogging(
  page: Page,
  tab: number,
  push: (row: Omit<EventRow, "ts" | "relMs">) => void,
) {
  page.on("request", (request) => {
    const url = request.url();
    if (!isRelevantUrl(url)) return;
    push({ event: "request", tab, method: request.method(), url });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!isRelevantUrl(url)) return;
    push({
      event: "response",
      tab,
      status: response.status(),
      url,
      retryAfter: response.headers()["retry-after"] ?? null,
    });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!isRelevantUrl(url)) return;
    push({
      event: "requestFailed",
      tab,
      method: request.method(),
      url,
      detail: request.failure(),
    });
  });
}

async function launchChrome(opts: Options): Promise<LaunchedChrome> {
  return await launch({
    userDataDir: opts.profileDir,
    handleSIGINT: false,
    chromeFlags: [
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--disable-popup-blocking",
    ],
  });
}

function summarize(rows: EventRow[], opts: Options, runDir: string) {
  const responses = rows.filter((row) => row.event === "response");
  const statusCounts = new Map<string, number>();
  for (const row of responses) {
    const key = String(row.status ?? "unknown");
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }
  return {
    runDir,
    profileDir: opts.profileDir,
    tabs: opts.tabs,
    staggerMs: opts.staggerMs,
    holdMs: opts.holdMs,
    totalEvents: rows.length,
    relevantRequests: rows.filter((row) => row.event === "request").length,
    relevantResponses: responses.length,
    conversationResponses: responses.filter((row) => row.url?.includes("/conversations")).length,
    statusCounts: Object.fromEntries(statusCounts),
    first429: rows.find((row) => row.status === 429) ?? null,
    modalStates: rows.filter((row) => row.event === "pageState"),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
