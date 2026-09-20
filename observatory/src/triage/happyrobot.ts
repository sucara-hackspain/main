import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { runAndReadAll, runAndReadNode } from "../coordinators/hr-wait";
import { incidentLine, TRIAGE_LEVELS, type Belief, type Call, type Graph, type PhoneCall, type TriageInput, type TriageVerdict } from "../engine";
import { WHO } from "../masters/happyrobot";
import { unwrap } from "../masters/protocol";
import { toPhoneCall } from "../phone/happyrobot";

// The 112 desk on HappyRobot: `112-triage` prioritises one call against the board, `112-coordinator` (a call generator,
// whatever its name) invents a batch of calls. Ids default to the hackathon's workflows; the env overrides them.

const TRIAGE_WORKFLOW = "01a0ba99-6f31-7fc8-a336-20eea7a1f42d"; // 112-triage
const TRIAGE_NODE = "01a0baa6-1ebc-7bc8-98cf-ac659a384ce3"; // "Triage Decision": the verdict itself; "Incidents Response" after it only copies it and costs another model call
const GENERATOR_WORKFLOW = "01a0bac2-283b-7174-8857-5ea031bf4cf5"; // 112-coordinator
const GENERATOR_NODE = "01a0bac6-6b48-77ed-ad34-0a72b8065592"; // "Call sim-112-inbound": one call per iteration of its loop
const SCENARIO = "DANA: lluvia torrencial e inundaciones sobre València y l'Horta Sud. Las llamadas son de València: nombra calles reales de València capital o de l'Horta Sud (Paiporta, Catarroja, Torrent, Alfafar), nunca de otra ciudad";

interface ClientOptions {
  apiKey?: string;
  cluster?: "us" | "eu";
}

function clientFrom(options: ClientOptions): HappyRobotClient {
  const apiKey = options.apiKey ?? process.env.HAPPYROBOT_API_KEY;
  if (!apiKey) throw new Error("HAPPYROBOT_API_KEY is not set (see .env.example)");
  return new HappyRobotClient({ apiKey, cluster: options.cluster ?? (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
}

export interface TriageTrace {
  tick: number;
  callId: string;
  payload: unknown;
  response: unknown;
  verdict: TriageVerdict | null;
  ms: number;
  error?: string;
}

export interface TriageOptions extends ClientOptions {
  workflowId?: string;
  nodeId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onTrace?: (trace: TriageTrace) => void;
}

/** The call as the operator filed it and nothing more: `buried` is hindsight truth and never leaves the engine. */
const filed = ({ id, tick, caller, mechanism, node, locationErrorM, street, conscious, breathing, bleeding, trapped, ageGroup, victims, text }: Call) =>
  ({ id, tick, caller, mechanism, node, locationErrorM, street, conscious, breathing, bleeding, trapped, ageGroup, victims, text });

/** The whole open board in the agent's terms, without the call being triaged: it has to decide where that one belongs. */
function board(belief: Belief, graph: Graph, call: Call) {
  return belief.incidents
    .filter((i) => i.status === "open" && !i.mergedInto)
    .map((i) => ({ i, callIds: i.callIds.filter((id) => id !== call.id) }))
    .filter(({ i, callIds }) => callIds.length > 0 || i.callIds.length === 0)
    .map(({ i, callIds }) => ({
      id: i.id,
      callIds,
      priority: TRIAGE_LEVELS[i.priority],
      mechanism: i.mechanism?.value ?? null,
      node: i.node,
      locationErrorM: i.locationErrorM,
      street: graph.streetAt(i.node),
      conscious: i.conscious?.value ?? "unknown",
      breathing: i.breathing?.value ?? "unknown",
      bleeding: i.bleeding?.value ?? "unknown",
      trapped: i.trapped?.value ?? "unknown",
      ageGroup: i.ageGroup?.value ?? "unknown",
      victims: i.victimsReported?.value ?? null,
      firstTick: i.openedTick,
      lastTick: i.updatedTick,
      text: incidentLine(i),
      changed: false,
    }));
}

export function readTriage(raw: unknown, callId: string): TriageVerdict {
  const out = unwrap(raw, "incidents");
  const list = typeof out.incidents === "string" ? (JSON.parse(out.incidents) as unknown[]) : Array.isArray(out.incidents) ? out.incidents : [];
  return {
    callId,
    matchedIncidentId: String(out.matchedIncidentId ?? ""),
    matchedNewIncident: out.matchedNewIncident === true || out.matchedNewIncident === "true",
    reasoning: String(out.reasoning ?? "").trim(),
    incidents: list.map((x) => {
      const r = x as Record<string, unknown>;
      return { id: String(r.id ?? ""), callIds: Array.isArray(r.callIds) ? r.callIds.map(String) : [], priority: r.priority as TriageVerdict["incidents"][number]["priority"] };
    }),
  };
}

/**
 * The 112 triage agent. One run per call, all at once, each against the board as it stood when the desk turn
 * started (a call sees the others of its batch as the rules filed them, not as the agent will). The verdicts go
 * back to the simulation, which folds them in (`applyTriage`) at its next tick. A run that fails leaves the
 * rules' priority in place: the board is never without one.
 */
export class HappyRobotTriage {
  private readonly client: HappyRobotClient;
  private readonly workflowId: string;
  private readonly nodeId: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onTrace?: (trace: TriageTrace) => void;

  constructor(options: TriageOptions = {}) {
    this.client = clientFrom(options);
    this.workflowId = options.workflowId ?? process.env.HAPPYROBOT_TRIAGE_WORKFLOW_ID ?? TRIAGE_WORKFLOW;
    this.nodeId = options.nodeId ?? process.env.HAPPYROBOT_TRIAGE_NODE_ID ?? TRIAGE_NODE;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.onTrace = options.onTrace;
  }

  // ponytail: one run per call, ~10 s each but concurrent; batch the turn's calls into one run if the workflow ever takes a list
  async triage({ tick, calls, belief, graph }: TriageInput): Promise<TriageVerdict[]> {
    // Boards are taken now, before anything is awaited: the belief keeps changing under us once the tick moves on.
    const jobs = calls
      .filter((call) => belief.incidents.find((i) => !i.mergedInto && i.callIds.includes(call.id))?.status === "open")
      .map((call) => ({ call, payload: { call: filed(call), incidents: board(belief, graph, call) } }));
    const started = Date.now();
    const verdicts = await Promise.all(
      jobs.map(async ({ call, payload }) => {
        try {
          const result = await runAndReadNode(this.client, { workflowId: this.workflowId, nodePersistentId: this.nodeId, payload, timeoutMs: this.timeoutMs, firstPollMs: 800, pollIntervalMs: this.pollIntervalMs });
          const verdict = readTriage(result.nodeOutput, call.id);
          this.onTrace?.({ tick, callId: call.id, payload, response: result.nodeOutput, verdict, ms: Date.now() - started });
          return verdict;
        } catch (err) {
          this.onTrace?.({ tick, callId: call.id, payload, response: null, verdict: null, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      }),
    );
    return verdicts.filter((v): v is TriageVerdict => v !== null);
  }
}

export interface GeneratorOptions extends ClientOptions {
  workflowId?: string;
  nodeId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** What is going on in the city, for the calls to be about it. */
  context?: () => string;
  /** Streets the map knows, a fresh handful per turn: named in the scenario so the invented calls land where they say. */
  streets?: () => string[];
  onTrace?: (trace: { tick: number; runId: string | null; calls: PhoneCall[]; ms: number; error?: string }) => void;
}

/**
 * Callers invented by the `112-coordinator` workflow: each run loops (five times, whatever `ticks` says) and
 * `sim-112-inbound` files one call per iteration, sometimes a deliberate second report of an earlier one.
 * The calls enter the session as if phoned in: what they describe becomes true where they say it is.
 */
export function happyRobotCallGenerator(options: GeneratorOptions = {}): (tick: number) => Promise<PhoneCall[]> {
  const client = clientFrom(options);
  const workflowId = options.workflowId ?? process.env.HAPPYROBOT_GENERATOR_WORKFLOW_ID ?? GENERATOR_WORKFLOW;
  const nodeId = options.nodeId ?? process.env.HAPPYROBOT_GENERATOR_NODE_ID ?? GENERATOR_NODE;
  return async (tick) => {
    const started = Date.now();
    const streets = options.streets?.() ?? [];
    const scenario = [SCENARIO, streets.length ? `Calles que existen, usa estas y solo estas: ${streets.join("; ")}` : "", options.context?.()].filter(Boolean).join(". ");
    try {
      const { runId, outputs } = await runAndReadAll(client, { workflowId, nodePersistentId: nodeId, payload: { ticks: 5, scenario }, timeoutMs: options.timeoutMs ?? 180_000, pollIntervalMs: options.pollIntervalMs ?? 5000 });
      const calls = outputs.flatMap((raw) => {
        try {
          const record = unwrap(raw, "caller");
          const call = toPhoneCall(record);
          const who = WHO[call.caller];
          call.text = `${who[0].toUpperCase()}${who.slice(1)}: «${String(record.text ?? "").trim().replace(/^[«"]|[»"]$/g, "") || "sin transcripción"}»`;
          return [call];
        } catch {
          return [];
        }
      });
      options.onTrace?.({ tick, runId, calls, ms: Date.now() - started });
      return calls;
    } catch (err) {
      options.onTrace?.({ tick, runId: null, calls: [], ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  };
}
