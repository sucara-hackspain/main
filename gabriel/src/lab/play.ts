// One game: a scenario, a coordinator, and the count of who did not make it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ExplainedRules } from "../coordinators/explained";
import { HappyRobotCoordinator } from "../coordinators/happyrobot";
import { readEscalation } from "../escalationFile";
import { buildSignals, CachedReader, EscalationDesk, CallObserver, GreedyCoordinator, HumanReader, KeywordReader, makeTickRecord, Simulation, type Call, type NightSignals, type Reader, type Verdict, type Coordinator, type DecideInput, type Decision, type Graph, type RunMeta, type TickRecord } from "../engine";
import { evaluate, type Finding, type FindingKind } from "../memory/evaluate";
import { renderDoctrine, type Doctrine } from "./doctrine";
import { ScriptedMaster, type Scenario } from "./scenario";

export type Policy =
  | { kind: "greedy" }
  /** The dispatcher, also acting on the registry of sites and the gauges: what well-made rules can do with structured data. */
  | { kind: "registry" }
  /** Greedy told the truth about every emergency the moment it happens: what perfect information is worth. */
  | { kind: "informed" }
  /** `harness`: "basic" is the reactive dispatcher the agent used to be; the default lets it plan (stage, hold, notebook). */
  | { kind: "agent"; doctrine: Doctrine; harness?: "plan" | "basic" };

export interface Game {
  scenario: string;
  rep: number;
  victims: number;
  dead: number;
  saved: number;
  open: number;
  inWater: number;
  counts: Partial<Record<FindingKind, number>>;
  llm: { calls: number; fallbacks: number; meanMs: number | null };
  ruleUse: { ruleId: string; times: number }[];
  /** A game where the rule-based stand-in decided too often says nothing about the agent. */
  valid: boolean;
  seconds: number;
  findings: Finding[];
  /** What the agent ordered and why, decision by decision (kept for moments, where there are only a few). */
  decisions?: { tick: number; situation: string; plan?: string; orders: string[] }[];
  /** The citizen channel over the night: what came in, what was read, and how the leads turned out. */
  channel?: { reader: string; received: number; read: number; relevant: number; leads: number; realLeads: number; silentScenes: number; silentFound: number };
  /** 112 calls where the words carried more than the form, and how many of those somebody heard in full. */
  buriedCalls?: { total: number; recovered: number };
}

/** The dispatcher plays the night, except for a few decisions in the middle that are the agent's. */
class Handover implements Coordinator {
  readonly name: string;
  /** The dispatcher takes the night back, but what the agent is holding in reserve stays held until it expires. */
  private readonly rules: GreedyCoordinator;
  private left: number;
  private until: number;

  constructor(
    private readonly agent: HappyRobotCoordinator,
    private readonly fromTick: number,
    decisions: number,
  ) {
    this.name = agent.name;
    this.rules = new GreedyCoordinator(() => agent.standing);
    this.left = decisions;
    // If nothing needs deciding for a while, the agent does not keep the city waiting.
    this.until = fromTick + decisions * 3 + 6;
  }

  async decide(input: DecideInput): Promise<Decision> {
    if (input.tick < this.fromTick || input.tick >= this.until) return { actions: this.rules.decide(input), source: "rules" };
    const decided = await this.agent.decide(input);
    const decision: Decision = Array.isArray(decided) ? { actions: decided, source: "rules" } : decided;
    if (decision.source !== "rules" && --this.left === 0) this.until = input.tick + 1;
    return decision;
  }
}

const MAX_FALLBACK_SHARE = 0.2;

/** Who reads the citizen channel. "sala": a control room, a few messages a tick. "palabras": keyword rules. "agente": an LLM's reading, kept on disk. */
export type Attention = "sala" | "palabras" | "agente" | "perfecto";
export const READINGS_DIR = "lab/readings";
const SALA_PER_TICK = 6;

const nights = new Map<string, NightSignals>();
export function signalsOf(scenario: Scenario, graph: Graph): NightSignals {
  const id = scenario.handover?.night ?? scenario.id;
  if (!nights.has(id)) nights.set(id, buildSignals(scenario.script, graph, scenario.seed, scenario.ticks, scenario.volume ?? 1));
  return nights.get(id)!;
}

export function readerFor(attention: Attention, scenario: Scenario): Reader {
  if (attention === "sala") return new HumanReader(SALA_PER_TICK);
  if (attention === "perfecto") return new HumanReader(Infinity);
  if (attention === "palabras") return new KeywordReader();
  const file = `${READINGS_DIR}/${scenario.handover?.night ?? scenario.id}.json`;
  if (!existsSync(file)) throw new Error(`${file} does not exist: read the night first (pnpm lab:read ${scenario.id})`);
  return new CachedReader(JSON.parse(readFileSync(file, "utf8")) as Record<string, Verdict>);
}

/** The agent's hearing of a night's 112 calls, by the words of each call: the fields the words carried. */
function callReaderFor(attention: Attention, scenario: Scenario): ((call: Call) => Call["buried"] | null) | undefined {
  if (attention === "perfecto") return (call) => call.buried ?? null;
  if (attention !== "agente") return undefined;
  const file = `${READINGS_DIR}/${scenario.handover?.night ?? scenario.id}.calls.json`;
  if (!existsSync(file)) return undefined;
  const heard = JSON.parse(readFileSync(file, "utf8")) as Record<string, Call["buried"]>;
  return (call) => heard[call.text] ?? null;
}

export interface PlayOptions {
  /** The citizen channel is on, read by this; `outbound` also lets the dispatcher phone round silent zones. */
  channel?: { attention: Attention; outbound?: boolean };
  rep?: number;
  /** Also leave the game where the viewers can open it (runs/<id>). */
  traceId?: string;
  onTick?: (tick: number, dead: number) => void;
}

export async function play(scenario: Scenario, policy: Policy, graph: Graph, options: PlayOptions = {}): Promise<Game> {
  const started = Date.now();
  const dir = options.traceId ? `runs/${options.traceId}` : null;
  if (dir) mkdirSync(dir, { recursive: true });

  let coordinator: Coordinator;
  if (policy.kind === "agent") {
    const doctrine = renderDoctrine(policy.doctrine);
    const agent = new HappyRobotCoordinator({
      harness: policy.harness,
      memory: doctrine ? () => doctrine : undefined,
      onTrace: dir ? (trace) => appendFileSync(`${dir}/llm.jsonl`, JSON.stringify(trace) + "\n") : undefined,
    });
    coordinator = scenario.handover ? new Handover(agent, scenario.handover.tick, scenario.handover.decisions) : agent;
  } else {
    coordinator = policy.kind === "registry" ? new ExplainedRules(options.channel?.outbound) : new GreedyCoordinator(undefined, false, options.channel?.outbound);
  }

  const sim = new Simulation({
    graph,
    seed: scenario.seed,
    master: new ScriptedMaster(scenario),
    coordinator,
    config: scenario.config,
    observer: policy.kind === "informed" ? new CallObserver({ perfect: true }) : scenario.buried ? new CallObserver({ buried: scenario.buried }) : undefined,
    callReader: options.channel ? callReaderFor(options.channel.attention, scenario) : undefined,
    signals: options.channel ? { night: signalsOf(scenario, graph), reader: readerFor(options.channel.attention, scenario) } : undefined,
  });

  // A recorded night carries what would have been escalated, under the catalogue in force.
  const escalation = readEscalation();
  const escalations = dir ? new EscalationDesk(escalation) : null;

  const meta: RunMeta | null = dir
    ? {
        id: options.traceId!,
        map: "valencia",
        seed: scenario.seed,
        ticks: scenario.ticks,
        coordinator: coordinator.name,
        model: null,
        config: sim.world.config,
        hospitals: sim.world.hospitals.map(({ id, name, node, capacity, helipad }) => ({ id, name, node, capacity, helipad })),
        startedAt: new Date().toISOString(),
        status: "running",
        summary: null,
        escalation,
      }
    : null;
  if (dir) {
    writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
    writeFileSync(`${dir}/ticks.jsonl`, "");
  }

  const records: TickRecord[] = [];
  const applications: { ruleId: string; incidentId: string | null }[] = [];
  const known = new Set(policy.kind === "agent" ? policy.doctrine.rules.map((r) => r.id) : []);
  const decisions: NonNullable<Game["decisions"]> = [];
  let calls = 0;
  let fallbacks = 0;
  let thinkingMs = 0;
  for (let i = 0; i < scenario.ticks; i++) {
    const result = await sim.step();
    const d = result.decision;
    if (d && d.source !== "rules") {
      calls++;
      if (d.source === "fallback") fallbacks++;
      else thinkingMs += d.ms ?? 0;
      if (scenario.handover) decisions.push({ tick: result.tick, situation: d.situation ?? "", plan: d.plan, orders: d.actions.map((a, n) => `${a.type} ${a.unitId}${"incidentId" in a && a.incidentId ? ` → ${a.incidentId}` : ""}${"hospitalId" in a && a.hospitalId ? ` (${a.hospitalId})` : ""}: ${d.reasons?.[n] ?? ""}`) });
    }
    // A moment is mostly the dispatcher replaying the night: the per-tick record is only worth its cost for a whole game.
    if (scenario.handover && !dir) {
      options.onTick?.(result.tick, sim.world.victims.filter((v) => v.status === "dead").length);
      result.decision?.applies?.forEach((ids, n) => {
        const action = result.decision!.actions[n];
        for (const ruleId of new Set(ids)) if (known.has(ruleId)) applications.push({ ruleId, incidentId: action.type === "dispatch" ? action.incidentId : null });
      });
      continue;
    }
    const record = makeTickRecord(result, sim.world, sim.belief, graph, sim.desk, escalations);
    records.push(record);
    options.onTick?.(result.tick, sim.world.victims.filter((v) => v.status === "dead").length);
    if (dir) appendFileSync(`${dir}/ticks.jsonl`, JSON.stringify(record) + "\n");
    result.decision?.applies?.forEach((ids, n) => {
      const action = result.decision!.actions[n];
      for (const ruleId of new Set(ids)) if (known.has(ruleId)) applications.push({ ruleId, incidentId: action.type === "dispatch" ? action.incidentId : null });
    });
  }

  const evaluation = evaluate({ session: options.traceId ?? `${scenario.id}-r${options.rep ?? 0}`, coordinator: coordinator.name, seed: scenario.seed, sim, records, applications });
  const s = evaluation.summary;
  if (dir && meta) {
    writeFileSync(`${dir}/meta.json`, JSON.stringify({ ...meta, status: "finished", summary: s }, null, 2));
    writeFileSync(`${dir}/evaluation.json`, JSON.stringify(evaluation, null, 2));
  }
  const from = scenario.handover?.tick ?? 0;
  return {
    scenario: scenario.id,
    rep: options.rep ?? 0,
    victims: s.victims,
    dead: s.dead,
    saved: s.saved,
    open: s.waiting + s.inAmbulance,
    inWater: s.inWater,
    counts: evaluation.counts,
    llm: { calls, fallbacks, meanMs: calls > fallbacks ? thinkingMs / (calls - fallbacks) : null },
    ruleUse: evaluation.ruleUse,
    valid: policy.kind !== "agent" || calls === 0 || fallbacks / calls <= MAX_FALLBACK_SHARE,
    seconds: (Date.now() - started) / 1000,
    // In a moment, what happened before the agent took over says nothing about it.
    findings: evaluation.findings.filter((f) => f.tick >= from),
    decisions: scenario.handover ? decisions : undefined,
    channel: sim.desk ? channelSummary(sim, scenario) : undefined,
    buriedCalls: scenario.buried ? sim.buriedCalls : undefined,
  };
}

/** How much of what nobody phoned about got found anyway: a crew reached it, whatever led it there. */
function channelSummary(sim: Simulation, scenario: Scenario): NonNullable<Game["channel"]> {
  const silent = scenario.script.flatMap((x) => (x.action.type === "spawn_scene" && x.action.silent ? [x.action.node] : []));
  const reached = new Set(sim.world.log.flatMap((e) => (e.type === "scene_assessed" ? [e.node] : [])));
  const desk = sim.desk!;
  return { reader: desk.reader.name, ...desk.stats, leads: desk.leads.length, realLeads: desk.leads.filter((l) => l.about !== null).length, silentScenes: silent.length, silentFound: silent.filter((node) => reached.has(node)).length };
}

/** Runs jobs a few at a time: the engine costs milliseconds, the wait is all on the platform. */
export async function pool<T, R>(items: T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}
