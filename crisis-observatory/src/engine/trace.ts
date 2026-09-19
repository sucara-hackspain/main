// On-disk format of a run (runs/<id>/): meta.json + ticks.jsonl (one TickRecord per line). Written by ../../backend/src/recorder.ts.
import type { Action, Call, Incident, InjuryKind, LonLat, Mission, ObservedEvent, SceneKind, SimConfig, Triage, UnitKind, VictimStatus } from "./types";

export interface Summary {
  ticks: number;
  victims: number;
  saved: number;
  dead: number;
  waiting: number;
  inAmbulance: number;
  survivalRate: number;
  inWater: number;
  reachableSurvivalRate: number;
  meanResponseTicks: number;
}

export interface Decision {
  actions: Action[];
  source: "llm" | "fallback" | "rules";
  situation?: string;
  reasons?: string[];
  applies?: string[][];
  ms?: number;
  costUsd?: number;
  error?: string;
}

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
  cutOffIn: number | null;
}

export interface Frame {
  units: UnitFrame[];
  scenes: SceneFrame[];
  incidents: IncidentFrame[];
  floods: { id: string; name: string; node: number; radiusM: number; fringeM: number }[];
  knownWater: {
    zones: { id: string; name: string; node: number; radiusM: number; ageTicks: number }[];
    sightings: { node: number; kind: "wet" | "blocked"; ageTicks: number }[];
  };
  knownClosedEdges: number[];
  recon: {
    scouts: { node: number; radiusM: number; ageTicks: number; quality: number; found: number }[];
    gaps: { id: string; node: number; kind: "incident" | "silence"; why: string }[];
  };
  hospitals: { id: string; occupied: number }[];
  closedEdges: number[];
  summary: Summary;
}

export interface TickRecord {
  tick: number;
  frame: Frame;
  events: ObservedEvent[];
  calls: Call[];
  actions: Action[];
  decision?: Omit<Decision, "actions">;
}
