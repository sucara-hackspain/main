import type { Decision } from "./coordinator";
import { unitLonLat, summarize, type Summary } from "./engine";
import type { Graph } from "./graph";
import { FLOOD_FRINGE_M } from "./engine";
import { incidentLine } from "./incidents";
import { believedWater, cutOffForecast, projectedRadius } from "./water";
import type { TickResult } from "./sim";
import type { Action, Belief, Call, Incident, InjuryKind, LonLat, Mission, ObservedEvent, SceneKind, SimConfig, Triage, UnitKind, VictimStatus, World } from "./types";
import { triage } from "./victims";

// On-disk format of a run (runs/<id>/): meta.json + ticks.jsonl (one TickRecord per line) + llm.jsonl.

export interface RunMeta {
  id: string;
  map: string;
  seed: number;
  ticks: number;
  coordinator: string;
  model: string | null;
  config: SimConfig;
  hospitals: { id: string; name: string; node: number; capacity: number; helipad: boolean }[];
  startedAt: string;
  status: "running" | "finished" | "failed";
  summary: Summary | null;
}

export interface UnitFrame {
  id: string;
  kind: UnitKind;
  pos: LonLat;
  mission: Mission;
  incidentId: string | null;
  victimId: string | null;
  hospitalId: string | null;
  broken: boolean;
  stranded: boolean;
  /** Remaining route as [edge, forward] pairs. */
  route: [number, 0 | 1][];
}

/** Ground truth, for the human supervisor only. */
export interface SceneFrame {
  id: string;
  kind: SceneKind;
  node: number;
  resolved: boolean;
  victims: { id: string; injury: InjuryKind; age: number; trapped: boolean; inWater: boolean; status: VictimStatus; ttl: number | null; triage: Triage; endTick: number | null }[];
}

export interface IncidentFrame extends Incident {
  line: string;
  /** Ticks until the water cuts this place off, if it is in its way. */
  cutOffIn: number | null;
}

/** Everything the UI needs to draw one tick: what is true, and what the coordinator believes. */
export interface Frame {
  units: UnitFrame[];
  scenes: SceneFrame[];
  incidents: IncidentFrame[];
  /** Truth: where the water really is. */
  floods: { id: string; name: string; node: number; radiusM: number; fringeM: number }[];
  /** Belief: what the coordinator has pieced together about it. */
  knownWater: {
    zones: { id: string; name: string; node: number; radiusM: number; ageTicks: number }[];
    sightings: { node: number; kind: "wet" | "blocked"; ageTicks: number }[];
  };
  knownClosedEdges: number[];
  hospitals: { id: string; occupied: number }[];
  closedEdges: number[];
  summary: Summary;
}

export interface TickRecord {
  tick: number;
  frame: Frame;
  /** Truth log plus the calls that came in this tick. */
  events: ObservedEvent[];
  calls: Call[];
  actions: Action[];
  decision?: Omit<Decision, "actions">;
}

const RECENT_TICKS = 20;

export function makeFrame(world: World, belief: Belief, graph: Graph): Frame {
  const cutOffIn = cutOffForecast(believedWater(belief), belief.hospitals, graph);
  const recent = (tick: number | null) => tick !== null && world.tick - tick <= RECENT_TICKS;
  return {
    units: world.units.map((a) => ({
      id: a.id,
      kind: a.kind,
      pos: unitLonLat(a, graph),
      mission: a.mission,
      incidentId: a.incidentId,
      victimId: a.victimId,
      hospitalId: a.hospitalId,
      broken: a.brokenUntil !== null,
      stranded: a.stranded,
      route: a.route.map((s) => [s.edge, s.forward ? 1 : 0]),
    })),
    scenes: world.scenes
      .map((scene) => ({ scene, victims: world.victims.filter((v) => v.sceneId === scene.id) }))
      .filter(({ victims }) => victims.some((v) => v.status === "waiting" || v.status === "in_ambulance" || recent(v.endTick)))
      .map(({ scene, victims }) => ({
        id: scene.id,
        kind: scene.kind,
        node: scene.node,
        resolved: scene.resolved,
        victims: victims.map((v) => ({
          id: v.id,
          injury: v.injury,
          age: v.age,
          trapped: v.trapped,
          inWater: v.inWater,
          status: v.status,
          ttl: v.ttl === null ? null : Math.ceil(v.ttl),
          triage: triage(v),
          endTick: v.endTick,
        })),
      })),
    incidents: belief.incidents
      .filter((i) => i.status === "open" || recent(i.updatedTick))
      .map((i) => ({ ...structuredClone(i), line: incidentLine(i), cutOffIn: i.status === "open" ? cutOffIn(i.node) : null })),
    floods: world.floods.map((f) => ({ id: f.id, name: f.name, node: f.node, radiusM: Math.round(f.radiusM), fringeM: Math.round(f.radiusM + FLOOD_FRINGE_M) })),
    knownWater: {
      zones: belief.floods.map((z) => ({ id: z.id, name: z.name, node: z.node, radiusM: projectedRadius(z, world.tick), ageTicks: world.tick - z.asOfTick })),
      sightings: belief.waterSightings.map((w) => ({ node: w.node, kind: w.kind, ageTicks: world.tick - w.tick })),
    },
    knownClosedEdges: [...belief.closedEdges],
    hospitals: world.hospitals.map((h) => ({ id: h.id, occupied: h.occupied })),
    closedEdges: [...world.closedEdges],
    summary: summarize(world),
  };
}

export function makeTickRecord(result: TickResult, world: World, belief: Belief, graph: Graph): TickRecord {
  const calls = result.reports.flatMap((r) => (r.event.type === "call_received" ? [r.event.call] : []));
  const record: TickRecord = {
    tick: result.tick,
    frame: makeFrame(world, belief, graph),
    events: [...calls.map((call) => ({ type: "call_received" as const, tick: result.tick, call })), ...result.events],
    calls,
    actions: result.actions,
  };
  if (result.decision) {
    const { actions: _actions, ...why } = result.decision;
    record.decision = why;
  }
  return record;
}
