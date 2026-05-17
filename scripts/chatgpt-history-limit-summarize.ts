#!/usr/bin/env tsx
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

interface Options {
  artifactDir: string;
}

interface SummaryFile {
  runDir?: string;
  statusCounts?: Record<string, number>;
  totalEvents?: number;
  relevantResponses?: number;
  conversationResponses?: number;
  first429?: unknown;
  modalEvents?: unknown[];
  modalStates?: Array<{ detail?: { modalFound?: boolean } }>;
}

function parseArgs(argv: string[]): Options {
  const home = process.env.HOME ?? "/Users/pat";
  const opts: Options = {
    artifactDir: path.join(home, "oracle", "artifacts", "chatgpt-history-limit"),
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--artifact-dir":
        opts.artifactDir = next();
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  ./node_modules/.bin/tsx scripts/chatgpt-history-limit-summarize.ts

Aggregates summary.json files from chatgpt-history-limit probes using structured
fields, so modalFound:false plus another true field cannot become a false
positive.`);
}

async function findSummaryFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "summary.json"))
    .sort();
}

function addCounts(target: Record<string, number>, source?: Record<string, number>) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function isProbeSummary(data: SummaryFile) {
  return (
    data.statusCounts !== undefined ||
    data.relevantResponses !== undefined ||
    data.modalEvents !== undefined ||
    data.modalStates !== undefined
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = await findSummaryFiles(opts.artifactDir);
  const summaries: Array<{ file: string; data: SummaryFile }> = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(file, "utf8")) as SummaryFile;
      if (!isProbeSummary(data)) continue;
      summaries.push({ file, data });
    } catch {
      // Ignore incomplete monitor runs that have not written a summary yet.
    }
  }

  const statusCounts: Record<string, number> = {};
  let totalEvents = 0;
  let totalRelevantResponses = 0;
  let totalConversationResponses = 0;
  let modalDetections = 0;
  const runsWith429: string[] = [];
  const runsWithModal: string[] = [];

  for (const { file, data } of summaries) {
    totalEvents += data.totalEvents ?? 0;
    totalRelevantResponses += data.relevantResponses ?? 0;
    totalConversationResponses += data.conversationResponses ?? 0;
    addCounts(statusCounts, data.statusCounts);
    if (data.first429) runsWith429.push(file);
    const modalCount =
      (data.modalEvents ?? []).length +
      (data.modalStates ?? []).filter((state) => state.detail?.modalFound === true).length;
    modalDetections += modalCount;
    if (modalCount > 0) runsWithModal.push(file);
  }

  console.log(
    JSON.stringify(
      {
        artifactDir: opts.artifactDir,
        runs: summaries.length,
        totalEvents,
        totalRelevantResponses,
        totalConversationResponses,
        statusCounts,
        runsWith429,
        modalDetections,
        runsWithModal,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
