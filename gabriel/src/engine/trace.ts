import type { Decision } from "./coordinator";
import { ambulanceLonLat, summarize, type Summary } from "./engine";
import type { Graph } from "./graph";
import type { TickResult } from "./sim";
import type { Action, LonLat, Mission, PatientStatus, SimConfig, World, WorldEvent } from "./types";

// On-disk format of a run (runs/<id>/): meta.json + ticks.jsonl (one TickRecord per line) + llm.jsonl.

export interface RunMeta {
  id: string;
  map: string;
  seed: number;
  ticks: number;
  coordinator: string;
  model: string | null;
  config: SimConfig;
  hospitals: { id: string; name: string; node: number; capacity: number }[];
  startedAt: string;
  status: "running" | "finished" | "failed";
  summary: Summary | null;
}

export interface AmbulanceFrame {
  id: string;
  pos: LonLat;
  mission: Mission;
  patientId: string | null;
  targetPatientId: string | null;
  hospitalId: string | null;
  broken: boolean;
  stranded: boolean;
  /** Remaining route as [edge, forward] pairs. */
  route: [number, 0 | 1][];
}

/** Everything the UI needs to draw one tick. */
export interface Frame {
  ambulances: AmbulanceFrame[];
  patients: { id: string; node: number; status: PatientStatus; ttl: number; endTick: number | null }[];
  hospitals: { id: string; occupied: number }[];
  closedEdges: number[];
  summary: Summary;
}

export interface TickRecord {
  tick: number;
  frame: Frame;
  events: WorldEvent[];
  actions: Action[];
  decision?: Omit<Decision, "actions">;
}

export function makeFrame(world: World, graph: Graph): Frame {
  return {
    ambulances: world.ambulances.map((a) => ({
      id: a.id,
      pos: ambulanceLonLat(a, graph),
      mission: a.mission,
      patientId: a.patientId,
      targetPatientId: a.targetPatientId,
      hospitalId: a.hospitalId,
      broken: a.brokenUntil !== null,
      stranded: a.stranded,
      route: a.route.map((s) => [s.edge, s.forward ? 1 : 0]),
    })),
    patients: world.patients.map((p) => ({
      id: p.id,
      node: p.node,
      status: p.status,
      ttl: Math.ceil(p.ttl),
      endTick: p.endTick,
    })),
    hospitals: world.hospitals.map((h) => ({ id: h.id, occupied: h.occupied })),
    closedEdges: [...world.closedEdges],
    summary: summarize(world),
  };
}

export function makeTickRecord(result: TickResult, world: World, graph: Graph): TickRecord {
  const record: TickRecord = {
    tick: result.tick,
    frame: makeFrame(world, graph),
    events: result.events,
    actions: result.actions,
  };
  if (result.decision) {
    const { actions: _actions, ...why } = result.decision;
    record.decision = why;
  }
  return record;
}
