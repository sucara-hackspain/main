// Traced run, viewable in the UI (pnpm ui) while it runs and afterwards.
//
//   pnpm run-sim                                   claude coordinator (haiku), seed 1, 120 ticks
//   pnpm run-sim --coordinator greedy --tick-ms 300
//   pnpm run-sim --coordinator happyrobot             thinks inside the HappyRobot workflow (needs .env)
//   pnpm run-sim --model sonnet --seed 7 --ticks 240
//
// Writes runs/<id>/: meta.json, ticks.jsonl (state + events per tick), llm.jsonl (full prompts), run.log
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ClaudeCliCoordinator } from "./coordinators/claude-cli";
import { HappyRobotCoordinator } from "./coordinators/happyrobot";
import {
  clock,
  describe,
  Graph,
  GreedyCoordinator,
  makeTickRecord,
  DanaMaster,
  RandomMaster,
  Simulation,
  type Coordinator,
  type GraphData,
  type RunMeta,
} from "./engine";

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "valencia" },
    scenario: { type: "string", default: "dana" },
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "120" },
    ambulances: { type: "string", default: "5" },
    coordinator: { type: "string", default: "claude" },
    model: { type: "string", default: "haiku" },
    "tick-ms": { type: "string", default: "0" },
  },
});

const seed = Number(values.seed);
const ticks = Number(values.ticks);
const tickMs = Number(values["tick-ms"]);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const id = `${stamp}-${values.scenario}-${values.coordinator}-s${seed}`;
const dir = `runs/${id}`;
mkdirSync(dir, { recursive: true });

const log = (line: string) => {
  console.log(line);
  appendFileSync(`${dir}/run.log`, line + "\n");
};

const onTrace = (trace: unknown) => appendFileSync(`${dir}/llm.jsonl`, JSON.stringify(trace) + "\n");
const coordinator: Coordinator =
  values.coordinator === "greedy"
    ? new GreedyCoordinator()
    : values.coordinator === "happyrobot"
      ? new HappyRobotCoordinator({ onTrace })
      : new ClaudeCliCoordinator({ model: values.model, onTrace });

const graph = new Graph(JSON.parse(readFileSync(`data/${values.map}.json`, "utf8")) as GraphData);
const sim = new Simulation({
  graph,
  seed,
  master: values.scenario === "random" ? new RandomMaster() : new DanaMaster(),
  coordinator,
  config: { ambulances: Number(values.ambulances) },
});

const meta: RunMeta = {
  id,
  map: values.map,
  seed,
  ticks,
  coordinator: coordinator.name,
  model: coordinator instanceof ClaudeCliCoordinator ? coordinator.model : null,
  config: sim.world.config,
  hospitals: sim.world.hospitals.map(({ id, name, node, capacity, helipad }) => ({ id, name, node, capacity, helipad })),
  startedAt: new Date().toISOString(),
  status: "running",
  summary: null,
};
const saveMeta = () => writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
saveMeta();
writeFileSync(`${dir}/ticks.jsonl`, "");
log(`run ${id}: ${meta.coordinator}${meta.model ? ` (${meta.model})` : ""}, seed ${seed}, ${ticks} ticks`);

let llmCalls = 0;
let llmCost = 0;
try {
  for (let i = 0; i < ticks; i++) {
    const result = await sim.step();
    const record = makeTickRecord(result, sim.world, sim.belief, graph);
    appendFileSync(`${dir}/ticks.jsonl`, JSON.stringify(record) + "\n");
    const at = `${clock(result.tick, sim.world.config.tickSeconds)} t${result.tick}`;
    const d = result.decision;
    if (d && d.source !== "rules") {
      llmCalls++;
      llmCost += d.costUsd ?? 0;
      log(`${at}  ${d.source === "llm" ? "LLM" : "FALLBACK"} (${((d.ms ?? 0) / 1000).toFixed(1)} s) ${d.situation ?? ""}${d.error ? ` [${d.error}]` : ""}`);
      d.reasons?.forEach((reason, i) => log(`${at}      ${JSON.stringify(d.actions[i])} <- ${reason}`));
    }
    for (const e of record.events) log(`${at}  ${describe(e)}`);
    if (tickMs > 0) await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  meta.status = "finished";
} catch (err) {
  meta.status = "failed";
  log(`FAILED: ${err instanceof Error ? err.stack : err}`);
}

meta.summary = sim.summary();
saveMeta();
const s = meta.summary;
log(
  `RESULT ${s.saved} saved, ${s.dead} dead, ${s.waiting + s.inAmbulance} open of ${s.victims}` +
    ` | survival ${(s.survivalRate * 100).toFixed(0)}% (${(s.reachableSurvivalRate * 100).toFixed(0)}% of reachable, ${s.inWater} lost to the water) | ${llmCalls} LLM calls, $${llmCost.toFixed(3)}`,
);
log(`trace: ${dir}`);
