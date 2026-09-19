import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { buildBriefing, GreedyCoordinator, type Coordinator, type DecideInput, type Decision } from "../engine";
import { runAndReadNode } from "./hr-wait";
import { composePrompt, readOutput, toActions, type LlmTrace } from "./protocol";

export interface HappyRobotOptions {
  apiKey?: string;
  /** Workflow id or slug. */
  workflowId?: string;
  /** `persistent_id` of the node that emits the decision — not the node id, which changes per version. */
  nodeId?: string;
  cluster?: "us" | "eu";
  timeoutMs?: number;
  /** How often to ask whether the decision is ready, after the first few seconds in which it never is. */
  pollIntervalMs?: number;
  onTrace?: (trace: LlmTrace) => void;
  /** The agent's doctrine, rendered fresh for each decision and placed before the briefing. */
  memory?: () => string;
  /**
   * Ticks between decisions. A decision takes the platform some 10 s, so deciding on every tick makes a night last
   * three times longer for orders that mostly repeat. What is heard in between is kept and handed over together;
   * a new life-threatening incident does not wait.
   */
  everyTicks?: number;
}

/**
 * Coordinator that thinks inside a HappyRobot workflow.
 *
 * Every decision is one workflow run: the briefing goes up as the trigger payload, and the run is
 * polled until the decision node has emitted its structured output. Each run starts cold, so the
 * briefing has to carry everything — there is no conversation to remember the last tick.
 */
export class HappyRobotCoordinator implements Coordinator {
  readonly name = "happyrobot";
  readonly model: string;
  private readonly client: HappyRobotClient;
  private readonly workflowId: string;
  private readonly nodeId: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly onTrace?: (trace: LlmTrace) => void;
  private readonly memory?: () => string;
  private readonly fallback = new GreedyCoordinator();
  private readonly everyTicks: number;
  private unheard: DecideInput["reports"] = [];
  private decidedAt = -Infinity;

  constructor(options: HappyRobotOptions = {}) {
    const apiKey = options.apiKey ?? process.env.HAPPYROBOT_API_KEY;
    const workflowId = options.workflowId ?? process.env.HAPPYROBOT_WORKFLOW_ID;
    const nodeId = options.nodeId ?? process.env.HAPPYROBOT_NODE_ID;
    if (!apiKey) throw new Error("HAPPYROBOT_API_KEY is not set (see .env.example)");
    if (!workflowId) throw new Error("HAPPYROBOT_WORKFLOW_ID is not set (see .env.example)");
    if (!nodeId) throw new Error("HAPPYROBOT_NODE_ID is not set (see .env.example)");

    this.client = new HappyRobotClient({ apiKey, cluster: options.cluster ?? (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
    this.workflowId = workflowId;
    this.nodeId = nodeId;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 4000;
    this.onTrace = options.onTrace;
    this.memory = options.memory;
    this.everyTicks = options.everyTicks ?? 3;
    this.model = `happyrobot:${workflowId}`;
  }

  async decide(heard: DecideInput): Promise<Decision> {
    this.unheard.push(...heard.reports);
    const urgent = heard.belief.incidents.some((i) => i.status === "open" && i.priority === 0 && i.openedTick === heard.tick);
    if (!urgent && heard.tick - this.decidedAt < this.everyTicks) return { actions: [], source: "rules", situation: "Entre decisiones: se acumulan las novedades." };
    const input = { ...heard, reports: this.unheard };
    this.unheard = [];
    this.decidedAt = heard.tick;

    const briefing = buildBriefing(input);
    if (!briefing.actionable) return { actions: [], source: "rules", situation: "Sin decisiones pendientes." };

    const prompt = composePrompt(briefing.text, this.memory);
    const started = Date.now();
    try {
      const result = await runAndReadNode(this.client, {
        workflowId: this.workflowId,
        nodePersistentId: this.nodeId,
        payload: { data: prompt },
        timeoutMs: this.timeoutMs,
        pollIntervalMs: this.pollIntervalMs,
      });
      const ms = Date.now() - started;

      const output = readOutput(result.nodeOutput);
      this.onTrace?.({ tick: input.tick, model: this.model, prompt, response: result.nodeOutput, ms, costUsd: 0 });

      const { actions, reasons, applies } = toActions(output, input);
      return { actions, reasons, applies, source: "llm", situation: output.situation, ms };
    } catch (err) {
      // The platform is down or the workflow is misconfigured: keep the city covered with the rule-based dispatcher.
      const error = err instanceof Error ? err.message : String(err);
      const ms = Date.now() - started;
      this.onTrace?.({ tick: input.tick, model: this.model, prompt, response: null, ms, costUsd: 0, error });
      return {
        actions: this.fallback.decide(input),
        source: "fallback",
        situation: "HappyRobot no disponible: decide el despachador por reglas.",
        ms,
        error,
      };
    }
  }
}
