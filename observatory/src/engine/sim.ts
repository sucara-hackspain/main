import type { Coordinator, Decision } from "./coordinator";
import { advance, applyAction, applyMasterAction, createWorld, DEFAULT_CONFIG, summarize } from "./engine";
import type { Graph } from "./graph";
import type { Master } from "./master";
import { applyTriage, createBelief, recordOrders, updateBelief, type TriageVerdict } from "./incidents";
import { CallObserver, type Observer } from "./observer";
import { leadAsCall, LeadDesk, type Reader } from "./reading";
import type { NightSignals } from "./signals";
import { Rng } from "./rng";
import type { Action, Belief, Call, MasterAction, PhoneCall, Report, SimConfig, World, WorldEvent } from "./types";
import { sceneFromCall } from "./victims";

export interface SimulationOptions {
  graph: Graph;
  master: Master;
  coordinator: Coordinator;
  seed?: number;
  config?: Partial<SimConfig>;
  observer?: Observer;
  /** Puts a 112 call into words. It gets the call as the operator filed it, nothing more; null keeps the engine's wording. */
  callWriter?: (call: Call) => Promise<string | null>;
  /** The night's citizen channel and whoever reads it. What the reader makes out reaches dispatch as one more call. */
  signals?: { night: NightSignals; reader: Reader };
  /** Somebody who listens to the whole call, not just the form: gives back the fields the words carry. */
  callReader?: (call: Call) => Call["buried"] | null;
  /**
   * The 112 desk, after the master and before the coordinator. Neither agent holds the tick: every `everyTicks` ticks
   * `generate` is set going and its calls are phoned in when they arrive; every `triageEvery` ticks (1: as calls come in)
   * `triage` gets every call heard since last time, with the board as it stands, and the verdicts it comes back with are
   * folded in at the next tick.
   */
  desk?: { everyTicks: number; generate?: (tick: number) => Promise<PhoneCall[]>; triage?: (input: TriageInput) => Promise<TriageVerdict[]>; triageEvery?: number };
  /** Rung every tick once the board is up to date: whoever rings callers back files what they said, or phones a case in again. */
  followup?: (input: { tick: number; belief: Belief; graph: Graph; phone: (call: PhoneCall, source: Call["source"]) => void }) => void;
}

export interface TriageInput {
  tick: number;
  /** Heard since the last triage, in order. */
  calls: Call[];
  belief: Belief;
  graph: Graph;
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
  readonly observer: Observer;
  private readonly masterRng: Rng;
  private readonly observerRng: Rng;
  private observedUpTo = 0;
  private nextReportId = 1;
  private readonly callWriter?: (call: Call) => Promise<string | null>;
  private injected: MasterAction[] = [];
  private orders: Action[] = [];
  private phoned: (PhoneCall & { source: Call["source"] })[] = [];
  private readonly phoneRng: Rng;
  readonly desk: LeadDesk | null;
  private readonly callReader?: (call: Call) => Call["buried"] | null;
  private readonly desk112?: SimulationOptions["desk"];
  private readonly followup?: SimulationOptions["followup"];
  private untriaged: Call[] = [];
  private verdicts: TriageVerdict[] = [];
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Calls where the words carried more than the form, and whether anybody picked it up. */
  readonly buriedCalls = { total: 0, recovered: 0 };

  constructor(options: SimulationOptions) {
    const root = new Rng(options.seed ?? 1);
    this.masterRng = root.fork();
    this.observerRng = root.fork();
    // Forked last, and only drawn from when someone phones: a run nobody phones into is the same run as before.
    this.phoneRng = root.fork();
    this.graph = options.graph;
    this.master = options.master;
    this.coordinator = options.coordinator;
    this.observer = options.observer ?? new CallObserver();
    this.callWriter = options.callWriter;
    this.world = createWorld(options.graph, { ...DEFAULT_CONFIG, ...options.config });
    this.belief = createBelief(this.world);
    this.callReader = options.callReader;
    this.desk112 = options.desk;
    this.followup = options.followup;
    this.desk = options.signals ? new LeadDesk(options.graph, options.signals.night.signals, options.signals.night.registry, options.signals.reader) : null;
  }

  /** Human playing master: applied at the start of the next tick. */
  inject(action: MasterAction): void {
    this.injected.push(action);
  }

  /** Human overriding the coordinator: applied after its own orders on the next tick, so it wins. */
  order(action: Action): void {
    this.orders.push(action);
  }

  /**
   * Somebody really phoned 112. What they described becomes true: an emergency appears where they said, nobody else
   * calls about it, and their call reaches the coordinator on the next tick like any other.
   */
  phone(call: PhoneCall, source: Call["source"] = "phone"): void {
    this.phoned.push({ ...call, source });
  }

  /** Work the desk is doing in the background; failures are the hooks' to report. */
  private spawn(job: Promise<unknown>): void {
    this.inFlight.add(job);
    void job.catch(() => undefined).finally(() => this.inFlight.delete(job));
  }

  /** Waits for whatever the desk still has in hand, so a session's trace ends with its last verdict. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight, this.coordinator.settle?.()]);
  }

  async step(): Promise<TickResult> {
    const { world, graph } = this;
    const logStart = world.log.length;

    const masterActions = [...this.injected, ...(await this.master.act(world, graph, this.masterRng))];
    this.injected = [];
    for (const action of masterActions) applyMasterAction(world, graph, action);

    const deskTurn = this.desk112 !== undefined && world.tick % this.desk112.everyTicks === 0;
    if (deskTurn && this.desk112!.generate) this.spawn(this.desk112!.generate(world.tick).then((calls) => calls.forEach((call) => this.phone(call, "agent"))));

    const phoned: Omit<Report, "id">[] = [];
    for (const heard of this.phoned.splice(0)) {
      if (!(this.observer instanceof CallObserver)) break;
      const placed = heard.node ?? (heard.street ? graph.findStreet(heard.street) : null);
      // No street the map knows: somewhere in the city, and the operator's "where" is worth very little.
      const node = placed ?? this.phoneRng.int(0, graph.nodeCount - 1);
      const { kind, victims } = sceneFromCall(heard, this.phoneRng);
      applyMasterAction(world, graph, { type: "spawn_scene", kind, node, victims, silent: true });
      const call = this.observer.adopt(
        { ...heard, node, street: heard.street ?? graph.streetAt(node), locationErrorM: placed === null ? Math.max(heard.locationErrorM, 1000) : heard.locationErrorM },
        world.scenes.at(-1)!.id,
        world.tick,
      );
      phoned.push({ tick: world.tick, source: "call_112", confidence: 1, event: { type: "call_received", tick: world.tick, call } });
    }

    if (this.desk && this.observer instanceof CallObserver) {
      for (const lead of this.desk.take(world.tick)) {
        // Hindsight only: which real emergency, if any, the lead was about.
        const scene = lead.about === null ? null : world.scenes.find((x) => !x.resolved && x.node === lead.about);
        const call = this.observer.adopt(leadAsCall(lead), scene?.id ?? null, world.tick);
        phoned.push({ tick: world.tick, source: "call_112", confidence: lead.credibility, event: { type: "call_received", tick: world.tick, call } });
      }
    }

    advance(world, graph);

    const fresh = world.log.slice(this.observedUpTo);
    this.observedUpTo = world.log.length;
    const reports = [...this.observer.observe(fresh, world, graph, this.observerRng), ...phoned].map((report) => ({ ...report, id: this.nextReportId++ }));
    if (this.callWriter) {
      // A call somebody really made already is in their own words.
      const calls = reports.flatMap((r) => (r.event.type === "call_received" && !r.event.call.source ? [r.event.call] : []));
      const texts = await Promise.all(calls.map((call) => this.callWriter!(call).catch(() => null)));
      calls.forEach((call, n) => (call.text = texts[n] ?? call.text));
    }
    for (const r of reports) {
      if (r.event.type !== "call_received" || !r.event.call.buried) continue;
      this.buriedCalls.total++;
      const heard = this.callReader?.(r.event.call);
      if (!heard) continue;
      Object.assign(r.event.call, heard);
      if (Object.keys(heard).length >= Object.keys(r.event.call.buried).length) this.buriedCalls.recovered++;
    }
    // What a crew is working on may turn out to belong to another incident: dispatch relabels it.
    for (const { unitId, incidentId } of updateBelief(this.belief, reports, world, graph)) {
      for (const fleet of [world.units, this.belief.units]) fleet.find((u) => u.id === unitId)!.incidentId = incidentId;
    }
    // Crews drive with what dispatch knows, nothing more.
    world.knownClosedEdges = [...this.belief.closedEdges];

    // What the triage agent answered since last tick goes into the board the rules just built; then the coordinator decides on it.
    for (const verdict of this.verdicts.splice(0)) applyTriage(this.belief, verdict, world.tick);
    this.followup?.({ tick: world.tick, belief: this.belief, graph, phone: (call, source) => this.phone(call, source) });
    this.untriaged.push(...reports.flatMap((r) => (r.event.type === "call_received" ? [r.event.call] : [])));
    if (this.desk112?.triage && world.tick % (this.desk112.triageEvery ?? 1) === 0 && this.untriaged.length > 0) {
      this.spawn(this.desk112!.triage({ tick: world.tick, calls: this.untriaged.splice(0), belief: this.belief, graph }).then((verdicts) => this.verdicts.push(...verdicts)));
    }

    let decision: Decision | undefined;
    if (reports.length > 0 || this.coordinator.pending?.()) {
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
    const ordersFrom = world.log.length;
    for (const action of actions) applyAction(world, graph, action);
    recordOrders(this.belief, world.tick, decision, actions, world.log.slice(ordersFrom));

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
