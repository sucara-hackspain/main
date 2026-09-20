// Re-runs the dream for a finished session (useful once the HappyRobot dream workflow exists,
// or to try another model on the same night):
//
//   pnpm dream                 latest run
//   pnpm dream <runId>
//   pnpm dream --dry-run       only print what the dream would read
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { consolidate, exportMemory, recordEpisode } from "./memory/consolidate";
import { buildDreamInput } from "./memory/dream-protocol";
import { pickDreamers } from "./memory/dreamers";
import type { Evaluation } from "./memory/evaluate";
import { MemoryStore } from "./memory/store";

const { values, positionals } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } }, allowPositionals: true });
const runId = positionals[0] ?? readdirSync("runs").filter((r) => existsSync(`runs/${r}/evaluation.json`)).sort().at(-1);
if (!runId || !existsSync(`runs/${runId}/evaluation.json`)) {
  console.error("No evaluated run found. Finish a session with `pnpm run-sim` first.");
  process.exit(1);
}

const evaluation = JSON.parse(readFileSync(`runs/${runId}/evaluation.json`, "utf8")) as Evaluation;
const store = new MemoryStore();
recordEpisode(store, evaluation);
const input = buildDreamInput(evaluation, store);
if (values["dry-run"]) {
  console.log(input);
  process.exit(0);
}

for (const dreamer of pickDreamers()) {
  try {
    console.log(`dreaming about ${runId} with ${dreamer.name}...`);
    const started = Date.now();
    const output = await dreamer.dream(input);
    const changes = consolidate(store, evaluation, output, dreamer.name);
    writeFileSync(`runs/${runId}/dream.json`, JSON.stringify({ dreamer: dreamer.name, ms: Date.now() - started, input, output, changes }, null, 2));
    console.log(`\n${output.lessons}\n`);
    for (const c of changes.applied) console.log(`  ${c.op.padEnd(9)} ${c.summary}`);
    for (const k of changes.skipped) console.log(`  skipped   ${k.op.op} ${k.op.id ?? k.op.title ?? ""}: ${k.why}`);
    break;
  } catch (err) {
    console.error(`dream with ${dreamer.name} failed: ${err instanceof Error ? err.message : err}`);
  }
}
exportMemory(store);
store.close();
