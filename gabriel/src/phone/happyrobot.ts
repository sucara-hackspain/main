import { HappyRobotClient } from "@happyrobot-ai/sdk";
import type { PhoneCall, SceneKind } from "../engine";
import { unwrap } from "../masters/protocol";

export interface PhoneLineOptions {
  apiKey?: string;
  /** The voice workflow that answers the 112 number. */
  workflowId?: string;
  /** `persistent_id` of the node that files the call record from the transcript. */
  nodeId?: string;
  cluster?: "us" | "eu";
  pollMs?: number;
  onCall: (call: PhoneCall, runId: string) => void;
  onError?: (error: string) => void;
}

const KINDS: SceneKind[] = ["vehicle_trapped", "flooded_home", "swept_away", "building_collapse", "collapse", "fall", "traffic"];
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);
const nothing = (value: unknown) => value === null || value === undefined || value === "" || value === "null";

/**
 * The record the operator agent filed, as the engine takes calls. Where the call happened is the street the
 * caller said: the agent cannot know the map, so whatever node it wrote down is ignored.
 */
export function toPhoneCall(record: Record<string, unknown>): PhoneCall {
  const victims = Number(record.victims);
  const error = Number(record.locationErrorM);
  return {
    caller: oneOf(record.caller, ["victim", "family", "bystander", "driver"] as const, "bystander"),
    mechanism: nothing(record.mechanism) ? null : oneOf(record.mechanism, KINDS, "collapse"),
    street: nothing(record.street) ? null : String(record.street),
    locationErrorM: Number.isFinite(error) && error > 0 ? error : 300,
    conscious: oneOf(record.conscious, ["yes", "no", "unknown"] as const, "unknown"),
    breathing: oneOf(record.breathing, ["normal", "difficult", "none", "unknown"] as const, "unknown"),
    bleeding: oneOf(record.bleeding, ["yes", "no", "unknown"] as const, "unknown"),
    trapped: oneOf(record.trapped, ["yes", "no", "unknown"] as const, "unknown"),
    ageGroup: oneOf(record.ageGroup, ["child", "adult", "elderly", "unknown"] as const, "unknown"),
    victims: Number.isFinite(victims) && victims >= 1 ? Math.round(victims) : null,
    text: `Llamada real al 112: «${String(record.text ?? "").trim() || "sin transcripción"}»`,
  };
}

/**
 * The real 112 line. People phone the HappyRobot number, its voice agent takes the call and files it; this
 * watches the workflow's runs and hands over every call that has finished since the session started.
 * Polling, not a webhook: the simulation runs on a laptop with no address the platform could post to.
 */
export class HappyRobotPhoneLine {
  private readonly client: HappyRobotClient;
  private readonly workflowId: string;
  private readonly nodeId: string;
  private readonly pollMs: number;
  private readonly seen = new Set<string>();
  private readonly since = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly options: PhoneLineOptions) {
    const apiKey = options.apiKey ?? process.env.HAPPYROBOT_API_KEY;
    const workflowId = options.workflowId ?? process.env.HAPPYROBOT_PHONE_WORKFLOW_ID;
    const nodeId = options.nodeId ?? process.env.HAPPYROBOT_PHONE_NODE_ID;
    if (!apiKey) throw new Error("HAPPYROBOT_API_KEY is not set (see .env.example)");
    if (!workflowId) throw new Error("HAPPYROBOT_PHONE_WORKFLOW_ID is not set (see .env.example)");
    if (!nodeId) throw new Error("HAPPYROBOT_PHONE_NODE_ID is not set (see .env.example)");
    this.client = new HappyRobotClient({ apiKey, cluster: options.cluster ?? (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
    this.workflowId = workflowId;
    this.nodeId = nodeId;
    this.pollMs = options.pollMs ?? 4000;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at the line. Public so a session can take a last look before it ends. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      type Run = { id: string; status: string; timestamp?: string };
      const { data: runs } = (await this.client.workflows.listRuns(this.workflowId, { limit: 10 } as never)) as unknown as { data: Run[] };
      for (const run of runs.reverse()) {
        if (this.seen.has(run.id) || new Date(run.timestamp ?? 0).getTime() < this.since) continue;
        // The record is filed after the caller hangs up: until then the run is simply not ready.
        const nodes = (await this.client.runs.listNodes(run.id, { node_persistent_id: this.nodeId, sort: "asc" } as never)) as unknown as { data: { node_persistent_id: string; output_id?: string; status?: string }[] };
        const filed = nodes.data.filter((n) => n.node_persistent_id === this.nodeId && n.output_id).at(-1);
        if (!filed) {
          if (["failed", "canceled", "skipped"].includes(run.status)) this.seen.add(run.id);
          continue;
        }
        this.seen.add(run.id);
        const output = await this.client.runs.getOutput(run.id, filed.output_id!);
        this.options.onCall(toPhoneCall(unwrap(output.data, "caller")), run.id);
      }
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }
}
