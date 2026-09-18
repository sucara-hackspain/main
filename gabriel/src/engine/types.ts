// All state here is plain JSON (no Map/Set/classes) so it can be snapshotted,
// replayed and sent to a UI as-is.

export type LonLat = [number, number];

// ---------- Map ----------

export interface EdgeData {
  a: number;
  b: number;
  /** metres */
  len: number;
  kph: number;
  /** if true, only a -> b is drivable */
  oneway: boolean;
  name?: string;
  /** polyline from a to b, endpoints included */
  geom: LonLat[];
}

export interface HospitalData {
  name: string;
  lon: number;
  lat: number;
  node: number;
  emergency: boolean;
}

export interface StationData {
  kind: "fire" | "police";
  name: string;
  lon: number;
  lat: number;
  node: number;
}

export interface GraphData {
  name: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
  /** index = node id */
  nodes: LonLat[];
  /** index = edge id. Closing a road = closing an edge id (both directions). */
  edges: EdgeData[];
  hospitals: HospitalData[];
  /** Fire and police stations: where those units start. Optional so hand-made graphs stay small. */
  stations?: StationData[];
}

/** One edge traversal. forward = a -> b. */
export interface Step {
  edge: number;
  forward: boolean;
}

// ---------- Entities ----------

/**
 * svb: basic ambulance. sva: advanced ambulance (doctor on board). heli: medical helicopter,
 * flies straight, only lands at helipad hospitals, can winch people out of the flood.
 * fire: puts fires out, frees trapped people, drives (slowly) through flooded streets.
 * police: clears blocked roads.
 */
export type UnitKind = "svb" | "sva" | "heli" | "fire" | "police";
export const CARRIERS: readonly UnitKind[] = ["svb", "sva", "heli", "fire"];

export type Mission = "idle" | "to_patient" | "on_scene" | "to_hospital" | "to_incident" | "working" | "reposition";

export interface Unit {
  id: string;
  kind: UnitKind;
  /** Last node reached. While route[0] is in progress the unit is between `node` and that step's end. */
  node: number;
  /** Helicopters only: free position in the air. */
  pos: LonLat | null;
  mission: Mission;
  destNode: number | null;
  /** Remaining steps. route[0] is the edge being driven when progressS > 0. Always empty for helicopters. */
  route: Step[];
  /** Seconds already driven along route[0]. */
  progressS: number;
  /** Patient on board. mission "idle" + patientId set = waiting for a transport order. */
  patientId: string | null;
  targetPatientId: string | null;
  hospitalId: string | null;
  incidentId: string | null;
  /** Out of service (breakdown, or helicopter grounded by wind) until this tick. */
  brokenUntil: number | null;
  /** Busy loading, unloading, freeing someone or turning around until this tick. */
  busyUntil: number;
  /** Has a destination but no known open route to it. */
  stranded: boolean;
  /** Sent from a neighbouring town on request. */
  backup: boolean;
  /** Crawling through flooded streets to get out of the water. */
  wading: boolean;
}

export type Severity = "leve" | "grave" | "critico";
export type Need = "general" | "trauma" | "quemados";
export type PatientStatus = "waiting" | "in_ambulance" | "delivered" | "dead" | "false_alarm";

export interface Patient {
  id: string;
  node: number;
  status: PatientStatus;
  severity: Severity;
  need: Need;
  /** Ticks of life left if untreated. */
  ttl: number;
  /** Cannot be loaded until a fire unit (or the helicopter, in a flood) frees them. */
  trapped: boolean;
  /** A call with nobody behind it. */
  phantom: boolean;
  incidentId: string | null;
  spawnTick: number;
  pickupTick: number | null;
  endTick: number | null;
  /** Delivered to a hospital without the speciality they needed. */
  suboptimal: boolean;
}

export interface Hospital {
  id: string;
  name: string;
  node: number;
  capacity: number;
  occupied: number;
  specialties: Need[];
  helipad: boolean;
  /** Out of service until this tick (flooded, no power). */
  offlineUntil: number | null;
}

export type IncidentKind = "accident" | "fire" | "collapse" | "flood_rescue" | "obstacle";

export interface Incident {
  id: string;
  kind: IncidentKind;
  label: string;
  node: number;
  /** Road it blocks while roadWork > 0. */
  edge: number | null;
  active: boolean;
  startTick: number;
  endTick: number | null;
  /** Fire-unit ticks left to put the fire out. While > 0 it keeps producing burn victims. */
  fireWork: number;
  /** Unit ticks left to clear the road (police or fire). */
  roadWork: number;
  /** Progress towards freeing the next trapped patient. */
  extricateProgress: number;
  nextVictimTick: number | null;
  victimsLeft: number;
  /** Blocked roads eventually get cleared by a tow truck even if nobody is sent. */
  autoClearTick: number | null;
}

export type ZoneKind = "flood" | "no_coverage";

export interface Zone {
  id: string;
  kind: ZoneKind;
  label: string;
  center: LonLat;
  radiusM: number;
  growthM: number;
  maxRadiusM: number;
  active: boolean;
  startTick: number;
  endTick: number | null;
}

// ---------- World ----------

export interface SimConfig {
  tickSeconds: number;
  fleet: Record<UnitKind, number>;
  /** Max hospitals taken from the map (big public ones first). */
  hospitals: number;
  /** Multiplier over the street speed limit for emergency vehicles. */
  speedFactor: number;
  heliSpeedMs: number;
  heliLandingTicks: number;
  pickupTicks: number;
  dropoffTicks: number;
  extricateTicks: number;
  /** Fire units drive through flooded streets this many times slower. */
  floodSlowFactor: number;
  /** Ticks lost when a unit runs into a closure nobody knew about. */
  discoveryPenaltyTicks: number;
  backupDelayTicks: number;
  maxBackups: number;
}

export interface World {
  tick: number;
  config: SimConfig;
  units: Unit[];
  patients: Patient[];
  hospitals: Hospital[];
  incidents: Incident[];
  zones: Zone[];
  /** Ground truth. */
  closedEdges: number[];
  /** Subset of closedEdges that is under water. */
  floodEdges: number[];
  /** What dispatch and the drivers know: routes are planned with this, not with the truth. */
  knownClosed: number[];
  pendingBackups: { kind: UnitKind; arriveTick: number }[];
  backupsRequested: number;
  entryNode: number;
  log: WorldEvent[];
  nextId: number;
}

// ---------- What the master can do to the world ----------

export type MasterAction =
  | { type: "spawn_patient"; node: number; severity: Severity; need?: Need; ttl?: number }
  | { type: "false_alarm"; node: number }
  | {
      type: "start_incident";
      kind: IncidentKind;
      label: string;
      node: number;
      /** Road blocked by it. */
      edge?: number;
      victims: { severity: Severity; need: Need; trapped: boolean }[];
      fireWork?: number;
      roadWork?: number;
      /** Fire only: more burn victims appear while it burns. */
      extraVictims?: number;
      /** Victims of slow emergencies (people on a roof) last longer than the severity suggests. */
      ttlFactor?: number;
    }
  | { type: "start_zone"; kind: ZoneKind; label: string; center: LonLat; radiusM: number; growthM?: number; maxRadiusM?: number; durationTicks?: number }
  | { type: "close_road"; edge: number; label?: string }
  | { type: "breakdown"; unitId: string; ticks: number }
  | { type: "hospital_down"; hospitalId: string; ticks: number };

// ---------- What the coordinator can order ----------

export type Action =
  /** Send an empty carrier (svb, sva, heli, fire) to a patient. With hospitalId it continues there after pickup. */
  | { type: "dispatch"; unitId: string; patientId: string; hospitalId?: string }
  /** Send a loaded unit to a hospital. */
  | { type: "transport"; unitId: string; hospitalId: string }
  /** Send a fire or police unit to work on an incident. */
  | { type: "assist"; unitId: string; incidentId: string }
  /** Move an empty unit to a node (staging, or getting out of the water's way). */
  | { type: "reposition"; unitId: string; node: number }
  /** Ask a neighbouring town for one more unit. Slow and limited. */
  | { type: "request_backup"; kind: UnitKind };

// ---------- Event log (ground truth) ----------

type EventBody =
  | { type: "patient_spawned"; patientId: string; node: number; severity: Severity; need: Need; ttl: number; trapped: boolean; incidentId: string | null; phantom: boolean }
  | { type: "patient_assessed"; patientId: string; unitId: string; severity: Severity; ttl: number; trapped: boolean }
  | { type: "patient_extricated"; patientId: string; by: string }
  | { type: "patient_picked_up"; patientId: string; unitId: string }
  | { type: "patient_delivered"; patientId: string; unitId: string; hospitalId: string; suboptimal: boolean }
  | { type: "patient_died"; patientId: string; where: "street" | "unit" }
  | { type: "false_alarm"; patientId: string; unitId: string }
  | { type: "incident_started"; incidentId: string; kind: IncidentKind; label: string; node: number; edge: number | null; victims: number }
  | { type: "incident_resolved"; incidentId: string }
  | { type: "zone_started"; zoneId: string; kind: ZoneKind; label: string; center: LonLat; radiusM: number }
  | { type: "zone_grew"; zoneId: string; radiusM: number }
  | { type: "zone_ended"; zoneId: string }
  | { type: "road_closed"; edge: number; name: string | null; cause: string }
  | { type: "road_opened"; edge: number; name: string | null; by: "unit" | "self" }
  | { type: "road_discovered"; unitId: string; edge: number; name: string | null }
  | { type: "unit_broken"; unitId: string; untilTick: number }
  | { type: "unit_repaired"; unitId: string }
  | { type: "unit_rerouted"; unitId: string; etaTicks: number }
  | { type: "unit_stranded"; unitId: string }
  | { type: "unit_free"; unitId: string; node: number; reason: string }
  | { type: "dispatch_void"; unitId: string; patientId: string; reason: string }
  | { type: "hospital_rejected"; hospitalId: string; unitId: string; reason: "full" | "offline" }
  | { type: "hospital_down"; hospitalId: string; untilTick: number }
  | { type: "hospital_up"; hospitalId: string }
  | { type: "backup_arrived"; unitId: string; kind: UnitKind }
  | { type: "action_applied"; action: Action; etaTicks: number }
  | { type: "action_rejected"; action: Action; reason: string };

export type WorldEvent = EventBody & { tick: number };
export type EventInput = EventBody;

// ---------- What the coordinator sees ----------

export type ReportSource = "call_112" | "radio" | "hospital" | "traffic" | "aemet" | "system";

/** The coordinator never reads the world, only reports: late, sometimes wrong, sometimes missing. */
export interface Report {
  id: number;
  /** Tick it reached the coordinator (the event inside keeps the tick it really happened). */
  tick: number;
  source: ReportSource;
  confidence: number;
  event: WorldEvent;
}

export interface PatientView {
  id: string;
  node: number;
  status: PatientStatus;
  /** As told by the caller until a unit sees the patient. */
  severity: Severity;
  need: Need;
  trapped: boolean;
  incidentId: string | null;
  /** True once a unit has examined them: severity and ttl are then exact. */
  assessed: boolean;
  ttlReported: number;
  reportedTick: number;
}

export interface IncidentView {
  id: string;
  kind: IncidentKind;
  label: string;
  node: number;
  edge: number | null;
  active: boolean;
  reportedTick: number;
}

export interface ZoneView {
  id: string;
  kind: ZoneKind;
  label: string;
  center: LonLat;
  /** Last reported radius: the water may be further by now. */
  radiusM: number;
  active: boolean;
  updatedTick: number;
}

export interface Belief {
  tick: number;
  /** Fleet telemetry and hospital bed counts come from our own systems: assumed reliable. */
  units: Unit[];
  hospitals: Hospital[];
  patients: PatientView[];
  incidents: IncidentView[];
  zones: ZoneView[];
  closedEdges: number[];
  floodEdges: number[];
  backupsLeft: number;
}
