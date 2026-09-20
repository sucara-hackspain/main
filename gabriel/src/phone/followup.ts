import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { runAndReadNode } from "../coordinators/hr-wait";
import { annotate, TRIAGE_LEVELS, type Belief, type Call, type Graph, type PhoneCall } from "../engine";
import { unwrap } from "../masters/protocol";

// Ringing callers back: the `112-outbound` voice agent phones whoever called on the real line about a case the desk
// rated low or medium, some ticks after their call, asks how it is going and files a report. A report that says worse
// raises the case; a closed case that got worse comes back in as a new call.

const OUTBOUND_WORKFLOW = "01a0ba28-1760-7bcc-8ba5-f6a7385db05b"; // 112-outbound
const OUTBOUND_NODE = "01a0ba28-f446-7d99-8f5c-7cb44b092b96"; // "Build Followup Object"
const MAX_TRIES = 2; // ponytail: no answer once, one more try, then let it go

export interface FollowupReport {
  reached: string; // patient | family | other | voicemail | no_answer
  evolution: string; // better | same | worse | unknown
  painNow: number | null;
  painTrend: string;
  mobility: string;
  fever: string;
  bleeding: string;
  woundWorse: string;
  redFlags: string;
  soughtCare: string;
  alone: string;
  street: string | null;
  locationErrorM: number;
  escalate: string; // yes | no | unknown
  escalationReason: string | null;
  nextAction: string; // monitor | followup_again | escalate_operator | dispatch_resource | close | retry_call
  text: string;
}

/** The report as the operator agent filed it from the transcript. Tolerant: an AI wrote it. */
export function readFollowup(raw: unknown): FollowupReport {
  const r = unwrap(raw, "reached");
  const word = (v: unknown, fallback = "unknown") => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const pain = Number(r.painNow);
  const error = Number(r.locationErrorM);
  return {
    reached: word(r.reached), evolution: word(r.evolution), painNow: Number.isFinite(pain) && pain >= 0 && pain <= 10 ? pain : null, painTrend: word(r.painTrend), mobility: word(r.mobility), fever: word(r.fever),
    bleeding: word(r.bleeding), woundWorse: word(r.woundWorse), redFlags: word(r.redFlags), soughtCare: word(r.soughtCare), alone: word(r.alone),
    street: r.street === null || r.street === undefined || r.street === "" || r.street === "null" ? null : String(r.street), locationErrorM: Number.isFinite(error) && error > 0 ? error : 300,
    escalate: word(r.escalate), escalationReason: r.escalationReason ? String(r.escalationReason) : null, nextAction: word(r.nextAction, "monitor"), text: word(r.text, ""),
  };
}

export type FollowupPayload = { callId: string; phone: string; priority: string; mechanism: string | null; street: string | null; ageGroup: string; conscious: string; breathing: string; bleeding: string; trapped: string };

export interface FollowupTrace {
  tick: number;
  callId: string;
  phone: string;
  outcome: "placed" | "skipped" | "filed" | "retry" | "escalated" | "failed";
  why?: string;
  payload?: FollowupPayload;
  report?: FollowupReport | null;
  ms?: number;
  error?: string;
}

export interface FollowupOptions {
  apiKey?: string;
  cluster?: "us" | "eu";
  workflowId?: string;
  nodeId?: string;
  /** Ticks between the call and ringing back (and between tries). */
  afterTicks?: number;
  /** How long a call may take before it is given up on: a voicemail and a chat are minutes, out of hours it sleeps. */
  timeoutMs?: number;
  /** Rings and files the report. Defaults to the HappyRobot workflow; tests hand in their own. */
  place?: (payload: FollowupPayload) => Promise<FollowupReport>;
  onTrace?: (trace: FollowupTrace) => void;
}

interface Pending {
  call: Call;
  dueTick: number;
  tries: number;
}

export class FollowupLine {
  private readonly afterTicks: number;
  private readonly place: (payload: FollowupPayload) => Promise<FollowupReport>;
  private readonly onTrace?: (trace: FollowupTrace) => void;
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private arrived: (Pending & { report: FollowupReport | null; error?: string; ms: number })[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly stopping = new AbortController();

  constructor(options: FollowupOptions = {}) {
    this.afterTicks = options.afterTicks ?? 10;
    this.onTrace = options.onTrace;
    if (options.place) this.place = options.place;
    else {
      const apiKey = options.apiKey ?? process.env.HAPPYROBOT_API_KEY;
      if (!apiKey) throw new Error("HAPPYROBOT_API_KEY is not set (see .env.example)");
      const client = new HappyRobotClient({ apiKey, cluster: options.cluster ?? (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
      const workflowId = options.workflowId ?? process.env.HAPPYROBOT_OUTBOUND_WORKFLOW_ID ?? OUTBOUND_WORKFLOW;
      const nodePersistentId = options.nodeId ?? process.env.HAPPYROBOT_OUTBOUND_NODE_ID ?? OUTBOUND_NODE;
      const timeoutMs = options.timeoutMs ?? 20 * 60_000;
      this.place = async (payload) => readFollowup((await runAndReadNode(client, { workflowId, nodePersistentId, payload, timeoutMs, firstPollMs: 20_000, pollIntervalMs: 10_000, signal: this.stopping.signal })).nodeOutput);
    }
  }

  /** Once a tick, with the board up to date: note new callers, file what came back, ring whoever is due. */
  tick({ tick, belief, phone }: { tick: number; belief: Belief; graph: Graph; phone: (call: PhoneCall, source: Call["source"]) => void }): void {
    for (const call of belief.calls) {
      if (!call.phone || this.seen.has(call.id)) continue;
      this.seen.add(call.id);
      this.pending.set(call.id, { call, dueTick: tick + this.afterTicks, tries: 0 });
    }
    for (const done of this.arrived.splice(0)) this.file(done, tick, belief, phone);
    for (const [id, p] of this.pending) {
      if (p.dueTick > tick) continue;
      this.pending.delete(id);
      this.ring(p, tick, belief);
    }
  }

  private ring(p: Pending, tick: number, belief: Belief): void {
    const { call } = p;
    const incident = belief.incidents.find((i) => !i.mergedInto && i.callIds.includes(call.id));
    // ponytail: low and medium only, fixed. A P0/P1 has a crew on the way; nobody rings them to ask how it is going.
    if (!incident || incident.priority < 2) {
      this.onTrace?.({ tick, callId: call.id, phone: call.phone!, outcome: "skipped", why: incident ? `P${incident.priority}: una dotación va de camino` : "sin incidente" });
      return;
    }
    const payload: FollowupPayload = { callId: call.id, phone: call.phone!, priority: TRIAGE_LEVELS[incident.priority], mechanism: call.mechanism, street: call.street, ageGroup: call.ageGroup, conscious: call.conscious, breathing: call.breathing, bleeding: call.bleeding, trapped: call.trapped };
    p.tries++;
    this.onTrace?.({ tick, callId: call.id, phone: call.phone!, outcome: "placed", payload, why: `intento ${p.tries}` });
    const started = Date.now();
    const job = this.place(payload).then(
      (report) => this.arrived.push({ ...p, report, ms: Date.now() - started }),
      (err: unknown) => this.arrived.push({ ...p, report: null, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started }),
    );
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

  private file(done: Pending & { report: FollowupReport | null; error?: string; ms: number }, tick: number, belief: Belief, phone: (call: PhoneCall, source: Call["source"]) => void): void {
    const { call, tries, report } = done;
    const from = "seguimiento 112";
    if (!report) {
      annotate(belief, call.id, tick, from, `Seguimiento de ${call.id}: la llamada no se pudo hacer (${done.error})`);
      this.onTrace?.({ tick, callId: call.id, phone: call.phone!, outcome: "failed", error: done.error, ms: done.ms });
      return;
    }
    const unanswered = ["voicemail", "no_answer"].includes(report.reached) || ["retry_call", "followup_again"].includes(report.nextAction);
    if (unanswered && tries < MAX_TRIES) {
      const dueTick = tick + this.afterTicks;
      this.pending.set(call.id, { call, dueTick, tries });
      annotate(belief, call.id, tick, from, `Seguimiento de ${call.id}: sin respuesta (${report.reached}); se vuelve a llamar en t${dueTick}`);
      this.onTrace?.({ tick, callId: call.id, phone: call.phone!, outcome: "retry", report, ms: done.ms });
      return;
    }
    const flags = !["", "none", "unknown", "null"].includes(report.redFlags.toLowerCase());
    const worse = report.escalate === "yes" || report.evolution === "worse" || flags || ["dispatch_resource", "escalate_operator"].includes(report.nextAction);
    const text = `Seguimiento de ${call.id} (contesta ${report.reached}): ${report.evolution}, siguiente ${report.nextAction}${report.escalationReason ? ` — ${report.escalationReason}` : ""}. ${report.text}`.trim();
    const incident = annotate(belief, call.id, tick, from, text, worse ? 1 : undefined);
    if (worse && incident?.status !== "open") {
      // Attended and sent home, and now worse: it is a case again, where the person says they are now.
      const { id: _id, tick: _tick, node: _node, source: _source, ...rest } = call;
      phone({ ...rest, street: report.street ?? call.street, locationErrorM: report.street ? report.locationErrorM : call.locationErrorM, bleeding: report.bleeding === "yes" ? "yes" : call.bleeding, text: `Seguimiento de ${call.id}: ${report.text || report.escalationReason || "ha empeorado"}` }, "outbound");
    }
    this.onTrace?.({ tick, callId: call.id, phone: call.phone!, outcome: worse ? "escalated" : "filed", report, ms: done.ms });
  }

  /** Calls off the waits on calls still in progress: the session is over. */
  stop(): void {
    this.stopping.abort();
  }
}
