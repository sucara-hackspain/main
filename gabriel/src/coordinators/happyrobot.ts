import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { buildBriefing, GreedyCoordinator, holdOn, remainingTicks, whatWasSeen, type Coordinator, type DecideInput, type Decision, type Hold } from "../engine";
import { runAndReadNode } from "./hr-wait";
import { composePrompt, readOutput, toActions, toStanding, type LlmTrace } from "./protocol";

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
   * Ticks between decisions. A decision takes the platform some 20 s and is taken in the background: the night goes
   * on, and the orders land on the tick the run comes back. What is heard in between is kept and handed over with
   * the next decision; a new life-threatening incident brings that decision forward.
   */
  everyTicks?: number;
  /** Runs the workflow on a prompt and gives back the node output. Defaults to the platform; tests hand in their own. */
  run?: (prompt: string) => Promise<unknown>;
  /**
   * Decide in the background: the tick goes on and the orders land when the run comes back (a live, paced session).
   * Off, the tick waits for the decision: what the lab needs, where nights run unpaced and every order must be in the tick.
   */
  background?: boolean;
  /**
   * "plan" (default): the agent can stage units ahead of the water, hold some back, and keeps a notebook that is
   * handed back to it at the next decision. "basic": the reactive dispatcher it used to be, for comparison.
   */
  harness?: "plan" | "basic";
}

interface Notebook {
  tick: number;
  plan: string;
  watch: string;
  orders: { unitId: string; text: string }[];
}

/**
 * Coordinator that thinks inside a HappyRobot workflow.
 *
 * Every decision is one workflow run: the briefing goes up as the trigger payload, and the run is
 * polled until the decision node has emitted its structured output. Each run starts cold, so the
 * briefing has to carry everything — there is no conversation to remember the last tick. With
 * `background`, the run is not waited for: the night goes on, and its orders are applied on the
 * tick it comes back.
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
  private readonly harness: "plan" | "basic";
  private holds: Hold[] = [];
  private notebook: Notebook | null = null;
  private readonly run: (prompt: string) => Promise<unknown>;
  private readonly background: boolean;
  private inFlight: Promise<void> | null = null;
  private firedAt = 0;
  private landed: Decision | null = null;
  private urgentPending = false;

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
    this.everyTicks = options.everyTicks ?? 6;
    this.background = options.background ?? false;
    this.harness = options.harness ?? "plan";
    this.model = `happyrobot:${workflowId}`;
    this.run = options.run ?? (async (prompt) => (await runAndReadNode(this.client, { workflowId: this.workflowId, nodePersistentId: this.nodeId, payload: { data: prompt }, timeoutMs: this.timeoutMs, pollIntervalMs: this.pollIntervalMs })).nodeOutput);
  }

  pending(): boolean {
    return this.landed !== null;
  }

  async settle(): Promise<void> {
    await this.inFlight;
  }

  /** Units this coordinator is holding back right now: whoever dispatches under it has to respect them. */
  get standing(): Hold[] {
    return this.holds;
  }

  /** What the agent wrote last time, and what has become of it: the only memory a cold run has. */
  private notebookText({ tick, belief, graph, config }: DecideInput): string {
    const book = this.notebook;
    if (!book) return "TU CUADERNO: vacío, es tu primera decisión de la sesión. Deja escrito tu plan.";
    const lines = [`TU CUADERNO (lo escribiste hace ${tick - book.tick} ticks, en el tick ${book.tick}):`, `- Plan: ${book.plan || "(no escribiste ninguno)"}`, `- Vigilas: ${book.watch || "(nada)"}`];
    if (book.orders.length) {
      lines.push("- Lo que ordenaste entonces y cómo está ahora:");
      for (const order of book.orders.slice(0, 12)) {
        const unit = belief.units.find((u) => u.id === order.unitId);
        const hold = unit ? holdOn(this.holds, unit, tick) : undefined;
        const now = !unit ? "" : unit.brokenUntil !== null ? "AVERIADA" : unit.mission === "idle" ? (unit.victimId ? "parada con herido a bordo" : hold ? `libre y reservada hasta el tick ${hold.untilTick}` : "libre") : `${unit.mission}, llega en ${remainingTicks(unit, graph, config)} ticks`;
        lines.push(`    · ${order.text} → ahora: ${now}`);
      }
    }
    return lines.join("\n");
  }

  async decide(heard: DecideInput): Promise<Decision> {
    this.unheard.push(...heard.reports);
    if (heard.belief.incidents.some((i) => i.status === "open" && i.priority === 0 && i.openedTick === heard.tick)) this.urgentPending = true;
    // A decision that came back since last tick is given now, whatever else is going on.
    if (this.landed) {
      const decision = this.landed;
      this.landed = null;
      return decision;
    }
    if (this.inFlight) return { actions: [], source: "rules", situation: `El agente sigue decidiendo (desde el tick ${this.firedAt}): se acumulan las novedades.` };
    if (!this.urgentPending && heard.tick - this.decidedAt < this.everyTicks) return { actions: [], source: "rules", situation: "Entre decisiones: se acumulan las novedades." };
    const input = { ...heard, reports: this.unheard };
    this.unheard = [];
    this.decidedAt = heard.tick;
    this.urgentPending = false;

    this.holds = this.holds.filter((h) => h.untilTick > input.tick);
    const planning = this.harness === "plan";
    const briefing = buildBriefing(input, planning ? { plan: { holds: this.holds } } : {});
    if (!briefing.actionable) return { actions: [], source: "rules", situation: "Sin decisiones pendientes." };

    // Briefing and prompt are taken now; the run goes on in the background and its orders land when it comes back,
    // checked against the board as it is by then (a unit that has moved on, an incident that closed, are refused).
    const prompt = composePrompt(`${planning ? this.notebookText(input) : "EN ESTA SESIÓN NO HAY CUADERNO, RESERVAS NI PUNTOS DE ESPERA."}\n\n${briefing.text}`, this.memory);
    this.firedAt = input.tick;
    if (!this.background) return this.think(input, prompt);
    this.inFlight = this.think(input, prompt).then((decision) => {
      this.landed = decision;
      this.inFlight = null;
    });
    return { actions: [], source: "rules", situation: "Decisión en curso: el agente está pensando." };
  }

  private async think(input: DecideInput, prompt: string): Promise<Decision> {
    const started = Date.now();
    try {
      const nodeOutput = await this.run(prompt);
      const ms = Date.now() - started;
      const output = readOutput(nodeOutput);
      this.onTrace?.({ tick: input.tick, model: this.model, prompt, response: nodeOutput, ms, costUsd: 0 });

      const { actions, reasons, applies } = toActions(output, input);
      const planning = this.harness === "plan";
      if (planning) {
        const standing = toStanding(output, input);
        const replaced = new Set([...standing.releases, ...standing.holds.map((h) => h.unitId)]);
        this.holds = [...this.holds.filter((h) => !replaced.has(h.unitId)), ...standing.holds];
        this.notebook = {
          tick: input.tick,
          plan: output.plan,
          watch: output.watch,
          orders: [...actions.map((a, n) => ({ unitId: a.unitId, text: `${a.type} ${a.unitId}${"incidentId" in a && a.incidentId ? ` → ${a.incidentId}` : ""}: ${reasons[n]}` })), ...standing.notes.map((text) => ({ unitId: text.split(" ")[1], text }))],
        };
      }
      const late = input.belief.tick - input.tick;
      return { actions, reasons, applies, source: "llm", situation: `${late > 0 ? `[decidido en t${input.tick}, ${late} ticks antes] ` : ""}${output.situation}`, plan: output.plan || undefined, watch: output.watch || undefined, saw: whatWasSeen(input), holds: planning ? [...this.holds] : undefined, baseline: this.fallback.decide(input), ms };
    } catch (err) {
      // The platform is down or the workflow is misconfigured: keep the city covered with the rule-based dispatcher.
      const error = err instanceof Error ? err.message : String(err);
      const ms = Date.now() - started;
      this.onTrace?.({ tick: input.tick, model: this.model, prompt, response: null, ms, costUsd: 0, error });
      return { actions: this.fallback.decide(input), source: "fallback", situation: "HappyRobot no disponible: decide el despachador por reglas.", ms, error };
    }
  }
}
