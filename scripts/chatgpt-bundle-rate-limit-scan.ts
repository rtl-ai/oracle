#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface Options {
  outDir: string;
  assetUrl?: string;
  maxAssets: number;
}

interface MatchRow {
  assetUrl: string;
  pattern: string;
  count: number;
  snippets: string[];
}

const DEFAULT_PATTERNS = [
  "conversationHistoryRateLimitModal",
  "modal-conversation-history-rate-limit",
  "You're making requests too quickly",
  "temporarily limited access to your conversations",
  "/conversations",
  "limit:28",
  "nHt=429",
  "status!==nHt",
  "RequestError",
];

function parseArgs(argv: string[]): Options {
  const home = process.env.HOME ?? "/Users/pat";
  const opts: Options = {
    outDir: path.join(home, "oracle", "artifacts", "chatgpt-history-limit"),
    maxAssets: 80,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--asset-url":
        opts.assetUrl = next();
        break;
      case "--out-dir":
        opts.outDir = next();
        break;
      case "--max-assets":
        opts.maxAssets = Number.parseInt(next(), 10);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.maxAssets) || opts.maxAssets < 1) {
    throw new Error("--max-assets must be a positive integer");
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  ./node_modules/.bin/tsx scripts/chatgpt-bundle-rate-limit-scan.ts
  ./node_modules/.bin/tsx scripts/chatgpt-bundle-rate-limit-scan.ts --asset-url https://chatgpt.com/cdn/assets/<asset>.js

Fetches public chatgpt.com JavaScript assets and scans for the stable strings
that identify the conversation-history rate-limit modal and its 429 handler.
It does not use cookies, navigate a logged-in browser, or send prompts.`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/javascript,*/*",
      "accept-encoding": "gzip, deflate, br",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return await response.text();
}

function extractAssetUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/g)) {
    const rawUrl = match[1];
    if (!rawUrl) continue;
    const resolved = new URL(rawUrl, "https://chatgpt.com/").toString();
    if (resolved.startsWith("https://chatgpt.com/")) urls.add(resolved);
  }
  return [...urls];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) return count;
    count++;
    offset = found + needle.length;
  }
}

function snippetsFor(haystack: string, needle: string): string[] {
  const snippets: string[] = [];
  let offset = 0;
  while (snippets.length < 3) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) break;
    const start = Math.max(0, found - 220);
    const end = Math.min(haystack.length, found + needle.length + 220);
    snippets.push(haystack.slice(start, end).replace(/\s+/g, " "));
    offset = found + needle.length;
  }
  return snippets;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const runDir = path.join(opts.outDir, `${stamp}-bundle-scan`);
  await mkdir(runDir, { recursive: true });

  const assetUrls = opts.assetUrl
    ? [opts.assetUrl]
    : extractAssetUrls(await fetchText("https://chatgpt.com/")).slice(0, opts.maxAssets);
  const matches: MatchRow[] = [];
  const failures: Array<{ assetUrl: string; error: string }> = [];

  for (const assetUrl of assetUrls) {
    let source = "";
    try {
      source = await fetchText(assetUrl);
    } catch (error) {
      failures.push({ assetUrl, error: String(error instanceof Error ? error.message : error) });
      continue;
    }
    for (const pattern of DEFAULT_PATTERNS) {
      const count = countOccurrences(source, pattern);
      if (count > 0) {
        matches.push({ assetUrl, pattern, count, snippets: snippetsFor(source, pattern) });
      }
    }
  }

  const summary = {
    runDir,
    startedAt,
    scannedAssetCount: assetUrls.length,
    matchedAssetCount: new Set(matches.map((row) => row.assetUrl)).size,
    modalAssets: [
      ...new Set(
        matches
          .filter((row) =>
            [
              "conversationHistoryRateLimitModal",
              "modal-conversation-history-rate-limit",
              "temporarily limited access to your conversations",
            ].includes(row.pattern),
          )
          .map((row) => row.assetUrl),
      ),
    ],
    handlerHints: matches.filter((row) =>
      ["/conversations", "limit:28", "nHt=429", "status!==nHt"].includes(row.pattern),
    ),
    matches,
    failures,
  };

  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
