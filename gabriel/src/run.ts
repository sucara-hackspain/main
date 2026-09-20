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
import { consolidate, exportMemory, recordEpisode } from "./memory/consolidate";
import { buildDreamInput } from "./memory/dream-protocol";
import { pickDreamers } from "./memory/dreamers";
import { evaluate } from "./memory/evaluate";
import { MemoryStore } from "./memory/store";
import { HappyRobotCoordinator } from "./coordinators/happyrobot";
import { happyRobotCallWriter, HappyRobotMaster } from "./masters/happyrobot";
import { HappyRobotPhoneLine } from "./phone/happyrobot";
import { startPhoneWebhook } from "./phone/webhook";
import { FollowupLine } from "./phone/followup";
import { happyRobotCallGenerator, HappyRobotTriage } from "./triage/happyrobot";
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
  type PhoneCall,
  type RunMeta,
  type TickRecord,
} from "./engine";

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "valencia" },
    scenario: { type: "string", default: "dana" },
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "120" },
    ambulances: { type: "string", default: "5" },
    coordinator: { type: "string", default: "claude" },
    /** Ticks between the HappyRobot coordinator's decisions (each is taken in the background, ~20 s). */
    "decide-every": { type: "string", default: "6" },
    /** Who decides what happens to the city: the scripted night of the scenario, or the agent in the HappyRobot `master` workflow. */
    master: { type: "string", default: "scripted" },
    /** Who words the 112 calls: the engine's templates, or the HappyRobot `sim-112` workflow (facts stay the engine's). */
    calls: { type: "string", default: "engine" },
    /** Listen to the real 112 line (the HappyRobot voice workflow): whoever phones it puts a call into this session. */
    phone: { type: "boolean", default: false },
    /** The 112 desk on HappyRobot: `112-coordinator` phones in a batch of invented calls and `112-triage` prioritises every call heard, every `--desk-every` ticks. */
    desk: { type: "string", default: "none" },
    "desk-every": { type: "string", default: "9" },
    /** Ticks between triage runs: 1 = every call is triaged the tick it comes in (its verdict lands a few seconds later). */
    "triage-every": { type: "string", default: "1" },
    /** Port for the 112 workflow's POST node to reach (through a tunnel). 0 = only poll the platform. */
    "phone-port": { type: "string", default: "8112" },
    /** Also take calls that ended up to this many minutes before the session started. */
    "phone-since": { type: "string", default: "0" },
    /** Ticks after a real call before the `112-outbound` agent rings the caller back, if the case is low or medium priority. */
    "followup-after": { type: "string", default: "10" },
    /** Decide without the doctrine (to measure what the memory is worth). */
    "no-memory": { type: "boolean", default: false },
    /** Skip the end-of-session dream; `--dream` forces it for a greedy run. */
    "no-dream": { type: "boolean", default: false },
    dream: { type: "boolean", default: false },
    model: { type: "string", default: "haiku" },
    "tick-ms": { type: "string", default: "0" },
  },
});

const seed = Number(values.seed);
const ticks = Number(values.ticks);
const tickMs = Number(values["tick-ms"]);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const id = `${stamp}-${values.scenario}-${values.coordinator}${values.master === "happyrobot" ? "-hrmaster" : ""}${values.desk === "happyrobot" ? "-desk" : ""}-s${seed}`;
const dir = `runs/${id}`;
mkdirSync(dir, { recursive: true });

const log = (line: string) => {
  console.log(line);
  appendFileSync(`${dir}/run.log`, line + "\n");
};

// The agent's long-term memory: read before every decision, rewritten by the dream after the session.
const usesAgent = values.coordinator !== "greedy";
const store = new MemoryStore();
const memory = usesAgent && !values["no-memory"] ? () => store.renderView() : undefined;

const onTrace = (trace: unknown) => appendFileSync(`${dir}/llm.jsonl`, JSON.stringify(trace) + "\n");
const coordinator: Coordinator =
  values.coordinator === "greedy"
    ? new GreedyCoordinator()
    : values.coordinator === "happyrobot"
      ? new HappyRobotCoordinator({ onTrace, memory, everyTicks: Number(values["decide-every"]), background: true })
      : new ClaudeCliCoordinator({ model: values.model, onTrace, memory });

const agenticMaster = values.master === "happyrobot"
  ? new HappyRobotMaster({
      gameId: id,
      onTrace: (trace) => {
        appendFileSync(`${dir}/master.jsonl`, JSON.stringify(trace) + "\n");
        log(`MASTER turno ${trace.turn} (${(trace.ms / 1000).toFixed(1)} s) ${trace.error ? `SIN RESPUESTA [${trace.error}]` : `${trace.actions.length} acciones`}${trace.dropped.length ? ` · descartado: ${trace.dropped.join(", ")}` : ""}`);
      },
    })
  : null;
const callWriter = values.calls === "happyrobot"
  ? happyRobotCallWriter({
      context: () => agenticMaster?.narration ?? "",
      onTrace: (trace) => appendFileSync(`${dir}/calls.jsonl`, JSON.stringify(trace) + "\n"),
    })
  : undefined;

const graph = new Graph(JSON.parse(readFileSync(`data/${values.map}.json`, "utf8")) as GraphData);
const desk = values.desk === "happyrobot"
  ? {
      everyTicks: Number(values["desk-every"]),
      triageEvery: Number(values["triage-every"]),
      generate: happyRobotCallGenerator({
        context: () => agenticMaster?.narration ?? "",
        streets: () => [...new Set(Array.from({ length: 40 }, () => graph.streetAt(Math.floor(Math.random() * graph.nodeCount))).filter((s): s is string => !!s))].slice(0, 12),
        onTrace: (trace) => {
          appendFileSync(`${dir}/desk.jsonl`, JSON.stringify({ agent: "112-coordinator", ...trace }) + "\n");
          log(`MESA 112 t${trace.tick}: ${trace.error ? `sin llamadas [${trace.error}]` : `${trace.calls.length} llamadas inventadas`} (${(trace.ms / 1000).toFixed(1)} s)`);
        },
      }),
      triage: (input: Parameters<HappyRobotTriage["triage"]>[0]) => triageAgent.triage(input),
    }
  : undefined;
const triageAgent = new HappyRobotTriage({
  onTrace: (trace) => {
    appendFileSync(`${dir}/desk.jsonl`, JSON.stringify({ agent: "112-triage", ...trace }) + "\n");
    const v = trace.verdict;
    log(`TRIAJE 112 t${trace.tick} ${trace.callId} (${(trace.ms / 1000).toFixed(1)} s): ${trace.error ? `SIN RESPUESTA [${trace.error}]` : `${v!.matchedNewIncident ? "incidente nuevo" : `→ ${v!.matchedIncidentId}`} · ${v!.incidents.find((i) => i.callIds.includes(trace.callId) || i.id === v!.matchedIncidentId)?.priority ?? "?"} · ${v!.reasoning}`}`);
  },
});

const followupLine = values.phone
  ? new FollowupLine({
      afterTicks: Number(values["followup-after"]),
      onTrace: (trace) => {
        appendFileSync(`${dir}/followups.jsonl`, JSON.stringify(trace) + "\n");
        const r = trace.report;
        log(`SEGUIMIENTO 112 t${trace.tick} ${trace.callId} (${trace.phone}): ${trace.outcome}${trace.why ? ` · ${trace.why}` : ""}${r ? ` · contesta ${r.reached}, ${r.evolution}, siguiente ${r.nextAction}` : ""}${trace.ms ? ` (${(trace.ms / 1000).toFixed(0)} s)` : ""}${trace.error ? ` [${trace.error}]` : ""}`);
      },
    })
  : null;
const sim = new Simulation({
  graph,
  seed,
  master: agenticMaster ?? (values.scenario === "random" ? new RandomMaster() : new DanaMaster()),
  callWriter,
  coordinator,
  desk,
  followup: followupLine ? (input) => followupLine.tick(input) : undefined,
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

// A real call can arrive twice: posted by the workflow the moment it ends, and seen again when polling its runs.
const heard = new Set<string>();
const takeCall = (call: PhoneCall, via: string) => {
  const key = `${call.street}|${call.text}`;
  if (heard.has(key)) return;
  heard.add(key);
  log(`TELÉFONO 112: entra una llamada real (${via}) · ${call.street ?? "sin calle"} · ${call.text}`);
  appendFileSync(`${dir}/phone.jsonl`, JSON.stringify({ at: new Date().toISOString(), via, call }) + "\n");
  sim.phone(call);
};
const phoneError = (error: string) => log(`TELÉFONO 112: ${error}`);
const phoneLine = values.phone ? new HappyRobotPhoneLine({ sinceMinutes: Number(values["phone-since"]), onCall: (call, runId) => takeCall(call, `sondeo ${runId}`), onError: phoneError }) : null;
const phonePort = Number(values["phone-port"]);
const phoneHook = values.phone && phonePort > 0 ? startPhoneWebhook({ port: phonePort, onCall: (call) => takeCall(call, "webhook"), onPing: () => [0, 2000, 5000].forEach((ms) => setTimeout(() => void phoneLine?.poll(), ms)), onError: phoneError }) : null;
phoneLine?.start();
if (phoneLine) log(`TELÉFONO 112: línea abierta${phoneHook ? `, webhook en http://localhost:${phonePort}/phone` : ""}`);

let llmCalls = 0;
let llmCost = 0;
const records: TickRecord[] = [];
try {
  for (let i = 0; i < ticks; i++) {
    const result = await sim.step();
    const record = makeTickRecord(result, sim.world, sim.belief, graph, sim.desk);
    appendFileSync(`${dir}/ticks.jsonl`, JSON.stringify(record) + "\n");
    records.push(record);
    result.decision?.applies?.forEach((ids, i) => {
      const action = result.decision!.actions[i];
      store.recordApplied(id, result.tick, ids, action.type === "dispatch" ? action.incidentId : null, action.unitId);
    });
    const at = `${clock(result.tick, sim.world.config.tickSeconds)} t${result.tick}`;
    const d = result.decision;
    if (d && d.source !== "rules") {
      llmCalls++;
      llmCost += d.costUsd ?? 0;
      log(`${at}  ${d.source === "llm" ? "LLM" : "FALLBACK"} (${((d.ms ?? 0) / 1000).toFixed(1)} s) ${d.situation ?? ""}${d.error ? ` [${d.error}]` : ""}`);
      d.reasons?.forEach((reason, i) => log(`${at}      ${JSON.stringify(d.actions[i])} <- ${reason}${d.applies?.[i]?.length ? ` [${d.applies[i].join(", ")}]` : ""}`));
    }
    for (const e of record.events) log(`${at}  ${describe(e)}`);
    if (tickMs > 0) await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  meta.status = "finished";
} catch (err) {
  meta.status = "failed";
  log(`FAILED: ${err instanceof Error ? err.stack : err}`);
}

followupLine?.stop();
await sim.settle();
phoneLine?.stop();
phoneHook?.close();
meta.summary = sim.summary();
saveMeta();
const s = meta.summary;
log(
  `RESULT ${s.saved} saved, ${s.dead} dead, ${s.waiting + s.inAmbulance} open of ${s.victims}` +
    ` | survival ${(s.survivalRate * 100).toFixed(0)}% (${(s.reachableSurvivalRate * 100).toFixed(0)}% of reachable, ${s.inWater} lost to the water) | ${llmCalls} LLM calls, $${llmCost.toFixed(3)}`,
);
log(`trace: ${dir}`);

// ---------- after the session: judge it with hindsight, then dream ----------

const evaluation = evaluate({ session: id, coordinator: meta.coordinator, seed, sim, records, applications: store.applications(id) });
writeFileSync(`${dir}/evaluation.json`, JSON.stringify(evaluation, null, 2));
recordEpisode(store, evaluation);
log(`evaluation: ${Object.entries(evaluation.counts).map(([k, n]) => `${k} x${n}`).join(", ") || "nothing to report"}`);

if ((usesAgent && !values["no-dream"] && !values["no-memory"]) || values.dream) {
  const input = buildDreamInput(evaluation, store);
  for (const dreamer of pickDreamers()) {
    try {
      log(`dreaming with ${dreamer.name}...`);
      const started = Date.now();
      const output = await dreamer.dream(input);
      const changes = consolidate(store, evaluation, output, dreamer.name);
      writeFileSync(`${dir}/dream.json`, JSON.stringify({ dreamer: dreamer.name, ms: Date.now() - started, input, output, changes }, null, 2));
      log(`dream (${((Date.now() - started) / 1000).toFixed(0)} s): ${output.lessons}`);
      for (const c of changes.applied) log(`  memory ${c.op}: ${c.summary}`);
      for (const k of changes.skipped) log(`  memory skipped ${k.op.op} ${k.op.id ?? k.op.title ?? ""}: ${k.why}`);
      break;
    } catch (err) {
      log(`dream with ${dreamer.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
exportMemory(store);
store.close();
