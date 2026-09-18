import type { Coordinator, Decision } from "./coordinator";
import { advance, applyAction, applyMasterAction, createWorld, DEFAULT_CONFIG, summarize } from "./engine";
import type { Graph } from "./graph";
import type { Master } from "./master";
import { createBelief, truthfulObserver, updateBelief, type Observer } from "./observer";
import { Rng } from "./rng";
import type { Action, Belief, MasterAction, Report, SimConfig, World, WorldEvent } from "./types";

export interface SimulationOptions {
  graph: Graph;
  master: Master;
  coordinator: Coordinator;
  seed?: number;
  config?: Partial<SimConfig>;
  observer?: Observer;
}

export interface TickResult {
  tick: number;
  events: WorldEvent[];
  reports: Report[];
  actions: Action[];
  /** Present on ticks where the coordinator was woken. */
  decision?: Decision;
}

/**
 * One tick = master changes the world -> world advances 30 s -> coordinator hears
 * the reports and gives orders (only if there is anything new to hear).
 */
export class Simulation {
  readonly graph: Graph;
  readonly world: World;
  readonly belief: Belief;
  private readonly master: Master;
  private readonly coordinator: Coordinator;
  private readonly observer: Observer;
  private readonly masterRng: Rng;
  private readonly observerRng: Rng;
  private observedUpTo = 0;
  private nextReportId = 1;
  private injected: MasterAction[] = [];
  private orders: Action[] = [];

  constructor(options: SimulationOptions) {
    const root = new Rng(options.seed ?? 1);
    this.masterRng = root.fork();
    this.observerRng = root.fork();
    this.graph = options.graph;
    this.master = options.master;
    this.coordinator = options.coordinator;
    this.observer = options.observer ?? truthfulObserver;
    this.world = createWorld(options.graph, { ...DEFAULT_CONFIG, ...options.config });
    this.belief = createBelief(this.world);
  }

  /** Human playing master: applied at the start of the next tick. */
  inject(action: MasterAction): void {
    this.injected.push(action);
  }

  /** Human overriding the coordinator: applied after its own orders on the next tick, so it wins. */
  order(action: Action): void {
    this.orders.push(action);
  }

  async step(): Promise<TickResult> {
    const { world, graph } = this;
    const logStart = world.log.length;

    const masterActions = [...this.injected, ...(await this.master.act(world, graph, this.masterRng))];
    this.injected = [];
    for (const action of masterActions) applyMasterAction(world, graph, action);

    advance(world, graph);

    const fresh = world.log.slice(this.observedUpTo);
    this.observedUpTo = world.log.length;
    const reports = this.observer
      .observe(fresh, world, this.observerRng)
      .map((report) => ({ ...report, id: this.nextReportId++ }));
    updateBelief(this.belief, reports, world);

    let decision: Decision | undefined;
    if (reports.length > 0) {
      const decided = await this.coordinator.decide({
        tick: world.tick,
        reports,
        belief: this.belief,
        graph,
        config: world.config,
      });
      decision = Array.isArray(decided) ? { actions: decided, source: "rules" } : decided;
    }
    const actions = [...(decision?.actions ?? []), ...this.orders];
    this.orders = [];
    for (const action of actions) applyAction(world, graph, action);

    const result: TickResult = { tick: world.tick, events: world.log.slice(logStart), reports, actions, decision };
    world.tick++;
    return result;
  }

  async run(ticks: number, onTick?: (result: TickResult) => void): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      const result = await this.step();
      onTick?.(result);
    }
  }

  summary() {
    return summarize(this.world);
  }
}
