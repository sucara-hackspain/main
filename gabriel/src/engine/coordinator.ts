import { closuresFor, effectiveNode, flightMps, UNIT_KINDS } from "./engine";
import type { Graph } from "./graph";
import { resolve, unitsNeeded } from "./incidents";
import { infoGaps } from "./recon";
import { CREW_RATE, SITES, sitesAtRisk } from "./sites";
import { holdAllows, holdOn, type Hold } from "./staging";
import { believedWater, cutOffForecast } from "./water";
import type { Action, Belief, Incident, Report, SimConfig, Unit, UnitKind } from "./types";

export interface DecideInput {
  tick: number;
  /** New since the last decision. */
  reports: Report[];
  belief: Belief;
  graph: Graph;
  config: SimConfig;
}

/** Orders plus the why, so a human can audit the decision. */
export interface Decision {
  actions: Action[];
  source: "llm" | "fallback" | "rules";
  /** One-line read of the situation. */
  situation?: string;
  /** What the coordinator is trying to do over the next few minutes, in its own words (its notebook). */
  plan?: string;
  /** Why each action, same order as `actions`. */
  reasons?: string[];
  /** Doctrine ids (from the agent's memory) cited for each action, same order as `actions`. */
  applies?: string[][];
  ms?: number;
  costUsd?: number;
  error?: string;
}

/** Only woken when there are new reports. Sees the belief, never the world. */
export interface Coordinator {
  readonly name: string;
  decide(input: DecideInput): Action[] | Decision | Promise<Action[] | Decision>;
}

/**
 * Baseline to beat: highest-priority incident first, nearest free unit of the right kind, nearest hospital with a bed.
 *  - firefighters go where someone is trapped;
 *  - ambulances go where a road gets them; rescue crews where only water does; the helicopter to the worst far-away case;
 *  - idle drones go and look at whatever the coordinator is most blind about, silence included.
 * Never reconsiders a unit that is already on its way to an open incident.
 */
export class GreedyCoordinator implements Coordinator {
  readonly name = "greedy";

  /** Standing holds somebody above the dispatcher has placed: a held unit is only spent on what it is held for. */
  constructor(
    private readonly holds: () => Hold[] = () => [],
    /**
     * Also act on the registry of sites and the gauges: warn whoever the water will reach, soonest first, and post a
     * crew where a warning alone will not get everyone out. Off by default: today's control rooms do not cross these.
     */
    private readonly usesRegistry = false,
  ) {}

  decide({ belief, graph, config }: DecideInput): Action[] {
    const actions: Action[] = [];
    const toTicks = (seconds: number) => seconds / config.ambulanceSpeedFactor / config.tickSeconds;

    // ETA in ticks from a unit to any node, the way that kind of unit travels.
    const etaCache = new Map<string, (node: number) => number>();
    const etaOf = (unit: Unit): ((node: number) => number) => {
      let eta = etaCache.get(unit.id);
      if (!eta) {
        if (UNIT_KINDS[unit.kind].flies) {
          const from = effectiveNode(unit, graph);
          eta = (node) => graph.distanceM(from, node) / flightMps(unit.kind) / config.tickSeconds;
        } else {
          const { closed, slow } = closuresFor(unit.kind, belief.closedEdges, belief.floodedEdges);
          const times = graph.timesFrom(effectiveNode(unit, graph), closed, slow);
          eta = (node) => toTicks(times[node]);
        }
        etaCache.set(unit.id, eta);
      }
      return eta;
    };

    // Beds already spoken for by units heading to each hospital.
    const inbound = new Map<string, number>();
    for (const u of belief.units) if (u.hospitalId) inbound.set(u.hospitalId, (inbound.get(u.hospitalId) ?? 0) + 1);
    const nearestHospital = (unit: Unit, fromNode: number): string | null => {
      const flies = UNIT_KINDS[unit.kind].flies;
      const { closed, slow } = closuresFor(unit.kind, belief.closedEdges, belief.floodedEdges);
      const times = flies ? null : graph.timesFrom(fromNode, closed, slow);
      let best: string | null = null;
      let bestTime = Infinity;
      for (const h of belief.hospitals) {
        if (h.occupied + (inbound.get(h.id) ?? 0) >= h.capacity || (flies && !h.helipad)) continue;
        const time = times ? times[h.node] : graph.distanceM(fromNode, h.node);
        if (time < bestTime) {
          bestTime = time;
          best = h.id;
        }
      }
      if (best) inbound.set(best, (inbound.get(best) ?? 0) + 1);
      return best;
    };

    // Loaded units with nowhere to go: no hospital chosen, the chosen one was full, or the water cut the way.
    for (const u of belief.units) {
      if (u.victimId && u.mission === "idle" && u.brokenUntil === null) {
        const hospitalId = nearestHospital(u, effectiveNode(u, graph));
        if (hospitalId) actions.push({ type: "transport", unitId: u.id, hospitalId });
      }
    }

    // Free = empty and idle, or heading somewhere pointless (an incident already closed).
    const isOpen = (incidentId: string | null) => resolve(belief, incidentId)?.status === "open";
    // A drone can do nothing else, so it never competes for rescue work; and a unit already looking
    // at something is left alone until its report comes in.
    const canRescue = (u: Unit) => UNIT_KINDS[u.kind].carries || UNIT_KINDS[u.kind].extricates;
    // A crew getting people out of a site ahead of the water, or on its way to do it, is at work, not free.
    const evacuating = new Set(belief.sites.filter((site) => site.floodedTick === null && site.safe < site.people).map((site) => site.node));
    const atSite = (u: Unit) => evacuating.has(u.destNode ?? (u.mission === "idle" ? u.node : -1));
    const free = belief.units.filter(
      (u) => !atSite(u) && canRescue(u) && !u.victimId && u.brokenUntil === null && u.mission !== "to_observe" && (u.mission !== "to_scene" || !isOpen(u.incidentId)),
    );
    const take = (unit: Unit) => free.splice(free.indexOf(unit), 1);
    const holds = this.holds();
    const nearest = (kinds: UnitKind[], node: number, incident: Incident): Unit | null => {
      let best: Unit | null = null;
      for (const u of free) {
        if (!kinds.includes(u.kind) || etaOf(u)(node) === Infinity) continue;
        const hold = holdOn(holds, u, belief.tick);
        if (hold && !holdAllows(hold, incident)) continue;
        if (!best || etaOf(u)(node) < etaOf(best)(node)) best = u;
      }
      return best;
    };

    const cutOffIn = cutOffForecast(believedWater(belief), belief.hospitals, graph);

    // Nobody waits parked where the water is about to close the way out (rescue crews and helicopters do not care).
    for (const u of [...free]) {
      if (UNIT_KINDS[u.kind].wades || UNIT_KINDS[u.kind].flies || u.mission === "reposition") continue;
      const danger = cutOffIn(effectiveNode(u, graph));
      if (danger === null || danger > 20) continue;
      const refuge = belief.hospitals
        .filter((h) => cutOffIn(h.node) === null && etaOf(u)(h.node) < Infinity)
        .sort((a, b) => etaOf(u)(a.node) - etaOf(u)(b.node))[0];
      if (!refuge) continue;
      actions.push({ type: "reposition", unitId: u.id, node: refuge.node });
      take(u);
    }

    if (this.usesRegistry) {
      let lines = config.outboundLines;
      for (const { site, arrival } of sitesAtRisk(belief, graph)) {
        if (site.warnedTick === null && lines-- > 0) actions.push({ type: "warn", unitId: "112", siteId: site.id });
        const alone = SITES[site.kind].selfRate * arrival;
        const posted = belief.units.filter((u) => u.destNode === site.node || (u.node === site.node && u.mission === "idle")).length;
        if (site.people - site.safe <= alone + posted * CREW_RATE * arrival) continue;
        const crew = free.filter((u) => u.kind === "fire" || u.kind === "ambulance").filter((u) => etaOf(u)(site.node) < arrival).sort((a, b) => etaOf(a)(site.node) - etaOf(b)(site.node))[0];
        if (!crew) continue;
        actions.push({ type: "reposition", unitId: crew.id, node: site.node });
        take(crew);
      }
    }

    const open = belief.incidents
      .filter((i) => i.status === "open")
      .sort((a, b) => a.priority - b.priority || a.openedTick - b.openedTick);

    for (const incident of open) {
      const need = unitsNeeded(incident, belief.units);
      const cutOff = cutOffIn(incident.node);
      // Road crews do not drive into a place the water will close behind them.
      const safeByRoad = (u: Unit) => cutOff === null || cutOff >= etaOf(u)(incident.node) + 8;

      if (need.fire > 0) {
        const crew = incident.unreachable ? nearest(["rescue"], incident.node, incident) : nearest(["fire"], incident.node, incident) ?? nearest(["rescue"], incident.node, incident);
        if (crew && (UNIT_KINDS[crew.kind].wades || safeByRoad(crew))) {
          actions.push({ type: "dispatch", unitId: crew.id, incidentId: incident.id, node: incident.node, hospitalId: UNIT_KINDS[crew.kind].carries ? (nearestHospital(crew, incident.node) ?? undefined) : undefined });
          take(crew);
          if (UNIT_KINDS[crew.kind].carries) need.carriers--;
        }
      }

      for (let n = need.carriers; n > 0; n--) {
        // By road if a road gets there; otherwise only water or air does. The helicopter is kept for the worst cases.
        const ambulance = incident.unreachable ? null : nearest(["ambulance"], incident.node, incident);
        const byRoad = ambulance && safeByRoad(ambulance) ? ambulance : null;
        const urgentAndFar = incident.priority <= 1 && (!byRoad || etaOf(byRoad)(incident.node) > 12);
        const unit = (urgentAndFar ? nearest(["helicopter"], incident.node, incident) : null) ?? byRoad ?? nearest(["rescue"], incident.node, incident);
        if (!unit) break;
        actions.push({ type: "dispatch", unitId: unit.id, incidentId: incident.id, node: incident.node, hospitalId: nearestHospital(unit, incident.node) ?? undefined });
        take(unit);
      }
    }

    // What we do not know. Only units with nothing better to do go looking: a drone always, the
    // helicopter only while no incident is waiting for a crew that can actually carry someone.
    const carrierWanted = open.some((i) => unitsNeeded(i, belief.units).carriers > 0);
    const observers = belief.units.filter(
      (u) => UNIT_KINDS[u.kind].observes && u.brokenUntil === null && !u.victimId && u.mission === "idle" && (!carrierWanted || !UNIT_KINDS[u.kind].carries),
    );
    if (observers.length > 0) {
      const gaps = infoGaps(belief, graph, belief.tick, observers.length * 2);
      const taken = new Set<number>();
      for (const gap of gaps) {
        if (taken.has(gap.node)) continue;
        const unit = observers
          .filter((u) => !actions.some((a) => a.unitId === u.id))
          .sort((a, b) => etaOf(a)(gap.node) - etaOf(b)(gap.node))[0];
        if (!unit || etaOf(unit)(gap.node) === Infinity) break;
        actions.push({ type: "scout", unitId: unit.id, node: gap.node, incidentId: gap.kind === "incident" ? gap.id : undefined });
        taken.add(gap.node);
      }
    }

    return actions;
  }
}
