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

export interface GraphData {
  name: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
  /** index = node id */
  nodes: LonLat[];
  /** index = edge id. Closing a road = closing an edge id (both directions). */
  edges: EdgeData[];
  hospitals: HospitalData[];
}

/** One edge traversal. forward = a -> b. */
export interface Step {
  edge: number;
  forward: boolean;
}

// ---------- Entities ----------

export type Mission = "idle" | "to_patient" | "to_hospital" | "reposition";

export interface Ambulance {
  id: string;
  /** Last node reached. While route[0] is in progress the ambulance is between `node` and that step's end. */
  node: number;
  mission: Mission;
  destNode: number | null;
  /** Remaining steps. route[0] is the edge being driven when progressS > 0. */
  route: Step[];
  /** Seconds already driven along route[0]. */
  progressS: number;
  /** Patient on board ("llena"). mission "idle" + patientId set = waiting for a transport order. */
  patientId: string | null;
  targetPatientId: string | null;
  hospitalId: string | null;
  /** Broken down ("pinchada") until this tick. */
  brokenUntil: number | null;
  /** Busy loading/unloading until this tick. */
  busyUntil: number;
  /** Has a destination but no open route to it. */
  stranded: boolean;
}

export type PatientStatus = "waiting" | "in_ambulance" | "delivered" | "dead";

export interface Patient {
  id: string;
  node: number;
  status: PatientStatus;
  /** Ticks of life left if untreated. */
  ttl: number;
  spawnTick: number;
  pickupTick: number | null;
  endTick: number | null;
}

export interface Hospital {
  id: string;
  name: string;
  node: number;
  capacity: number;
  occupied: number;
}

// ---------- World ----------

export interface SimConfig {
  tickSeconds: number;
  ambulances: number;
  /** Max hospitals taken from the map (emergency ones first). */
  hospitals: number;
  hospitalCapacity: number;
  /** Multiplier over the street speed limit. */
  ambulanceSpeedFactor: number;
  pickupTicks: number;
  dropoffTicks: number;
  /** TTL lost per tick while on board (1 = same as on the street). */
  ttlDecayInAmbulance: number;
}

export interface World {
  tick: number;
  config: SimConfig;
  ambulances: Ambulance[];
  patients: Patient[];
  hospitals: Hospital[];
  closedEdges: number[];
  log: WorldEvent[];
  nextPatientNum: number;
}

// ---------- What the master can do to the world ----------

export type MasterAction =
  | { type: "spawn_patient"; node: number; ttl: number }
  | { type: "close_road"; edge: number }
  | { type: "open_road"; edge: number }
  | { type: "puncture"; ambulanceId: string; ticks: number };

// ---------- What the coordinator can order ----------

export type Action =
  /** Send an empty ambulance to a patient. With hospitalId it continues there after pickup. */
  | { type: "dispatch"; ambulanceId: string; patientId: string; hospitalId?: string }
  /** Send a loaded ambulance to a hospital. */
  | { type: "transport"; ambulanceId: string; hospitalId: string }
  /** Move an empty ambulance to a node (staging). */
  | { type: "reposition"; ambulanceId: string; node: number };

// ---------- Event log (ground truth) ----------

type EventBody =
  | { type: "patient_spawned"; patientId: string; node: number; ttl: number }
  | { type: "patient_picked_up"; patientId: string; ambulanceId: string }
  | { type: "patient_delivered"; patientId: string; ambulanceId: string; hospitalId: string }
  | { type: "patient_died"; patientId: string; where: "street" | "ambulance" }
  | { type: "road_closed"; edge: number; name: string | null }
  | { type: "road_opened"; edge: number; name: string | null }
  | { type: "ambulance_broken"; ambulanceId: string; untilTick: number }
  | { type: "ambulance_repaired"; ambulanceId: string }
  | { type: "ambulance_rerouted"; ambulanceId: string; etaTicks: number }
  | { type: "ambulance_stranded"; ambulanceId: string }
  | { type: "ambulance_arrived"; ambulanceId: string; node: number }
  | { type: "dispatch_void"; ambulanceId: string; patientId: string; reason: string }
  | { type: "hospital_full"; hospitalId: string; ambulanceId: string }
  | { type: "action_applied"; action: Action; etaTicks: number }
  | { type: "action_rejected"; action: Action; reason: string };

export type WorldEvent = EventBody & { tick: number };
export type EventInput = EventBody;

// ---------- What the coordinator sees ----------

export type ReportSource = "call_112" | "ambulance" | "hospital" | "traffic" | "system";

/** The coordinator never reads the world, only reports. v0: report = truth, confidence 1. */
export interface Report {
  id: number;
  tick: number;
  source: ReportSource;
  confidence: number;
  event: WorldEvent;
}

export interface PatientView {
  id: string;
  node: number;
  status: PatientStatus;
  ttlReported: number;
  reportedTick: number;
}

export interface Belief {
  tick: number;
  /** Fleet telemetry: assumed reliable. */
  ambulances: Ambulance[];
  hospitals: Hospital[];
  patients: PatientView[];
  closedEdges: number[];
}
