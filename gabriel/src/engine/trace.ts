import type { Decision } from "./coordinator";
import { summarize, unitLonLat, type Summary } from "./engine";
import type { Graph } from "./graph";
import type { TickResult } from "./sim";
import type {
  Action,
  Belief,
  IncidentKind,
  LonLat,
  Mission,
  Need,
  PatientStatus,
  Severity,
  SimConfig,
  UnitKind,
  World,
  WorldEvent,
  ZoneKind,
} from "./types";

// On-disk format of a run (runs/<id>/): meta.json + ticks.jsonl (one TickRecord per line) + llm.jsonl.

export interface RunMeta {
  id: string;
  map: string;
  seed: number;
  ticks: number;
  scenario: string;
  coordinator: string;
  model: string | null;
  config: SimConfig;
  hospitals: { id: string; name: string; node: number; capacity: number; specialties: Need[]; helipad: boolean }[];
  startedAt: string;
  status: "running" | "finished" | "failed";
  summary: Summary | null;
}

export interface UnitFrame {
  id: string;
  kind: UnitKind;
  pos: LonLat;
  mission: Mission;
  patientId: string | null;
  targetPatientId: string | null;
  hospitalId: string | null;
  incidentId: string | null;
  broken: boolean;
  stranded: boolean;
  destNode: number | null;
  /** Remaining route as [edge, forward] pairs. */
  route: [number, 0 | 1][];
}

/** Everything the UI needs to draw one tick: the truth, plus what the coordinator knows of it. */
export interface Frame {
  units: UnitFrame[];
  patients: {
    id: string;
    node: number;
    status: PatientStatus;
    severity: Severity;
    need: Need;
    trapped: boolean;
    phantom: boolean;
    ttl: number;
    endTick: number | null;
    /** Dispatch has heard of this patient. */
    known: boolean;
  }[];
  hospitals: { id: string; occupied: number; offline: boolean }[];
  incidents: { id: string; kind: IncidentKind; label: string; node: number; known: boolean; fireWork: number }[];
  zones: { id: string; kind: ZoneKind; label: string; center: LonLat; radiusM: number; knownRadiusM: number | null }[];
  /** Closed by something other than water (water is drawn as the zone). */
  closedEdges: number[];
  /** Subset of closedEdges dispatch knows about. */
  knownClosedEdges: number[];
  summary: Summary;
}

export interface TickRecord {
  tick: number;
  frame: Frame;
  events: WorldEvent[];
  /** Event indexes (into `events`) that are not known to the coordinator yet are not tracked; reports carry what it heard. */
  heard: WorldEvent[];
  actions: Action[];
  decision?: Omit<Decision, "actions">;
}

export function makeFrame(world: World, belief: Belief, graph: Graph): Frame {
  const flood = new Set(world.floodEdges);
  const known = new Set(belief.closedEdges);
  const dry = world.closedEdges.filter((e) => !flood.has(e));
  return {
    units: world.units.map((u) => ({
      id: u.id,
      kind: u.kind,
      pos: unitLonLat(u, graph),
      mission: u.mission,
      patientId: u.patientId,
      targetPatientId: u.targetPatientId,
      hospitalId: u.hospitalId,
      incidentId: u.incidentId,
      broken: u.brokenUntil !== null,
      stranded: u.stranded,
      destNode: u.destNode,
      route: u.route.map((s) => [s.edge, s.forward ? 1 : 0]),
    })),
    patients: world.patients.map((p) => ({
      id: p.id,
      node: p.node,
      status: p.status,
      severity: p.severity,
      need: p.need,
      trapped: p.trapped,
      phantom: p.phantom,
      ttl: Math.ceil(p.ttl),
      endTick: p.endTick,
      known: belief.patients.some((b) => b.id === p.id),
    })),
    hospitals: world.hospitals.map((h) => ({ id: h.id, occupied: h.occupied, offline: h.offlineUntil !== null })),
    incidents: world.incidents
      .filter((i) => i.active)
      .map((i) => ({ id: i.id, kind: i.kind, label: i.label, node: i.node, known: belief.incidents.some((b) => b.id === i.id), fireWork: i.fireWork })),
    zones: world.zones
      .filter((z) => z.active)
      .map((z) => ({
        id: z.id,
        kind: z.kind,
        label: z.label,
        center: z.center,
        radiusM: Math.round(z.radiusM),
        knownRadiusM: belief.zones.find((b) => b.id === z.id)?.radiusM ?? null,
      })),
    closedEdges: dry,
    knownClosedEdges: dry.filter((e) => known.has(e)),
    summary: summarize(world),
  };
}

export function makeTickRecord(result: TickResult, world: World, belief: Belief, graph: Graph): TickRecord {
  const record: TickRecord = {
    tick: result.tick,
    frame: makeFrame(world, belief, graph),
    events: result.events,
    heard: result.reports.map((r) => r.event),
    actions: result.actions,
  };
  if (result.decision) {
    const { actions: _actions, ...why } = result.decision;
    record.decision = why;
  }
  return record;
}
