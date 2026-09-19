/**
 * Recorded ambulance/patient trace contract supported by Control Center.
 * Keep it independent from the engine's new units/scenes/incidents format.
 * New-format records are rejected explicitly at the API boundary until ported.
 */
export type Action =
  | { type: "dispatch"; ambulanceId: string; patientId: string; hospitalId?: string }
  | { type: "transport"; ambulanceId: string; hospitalId: string }
  | { type: "reposition"; ambulanceId: string; node: number };

export type WorldEvent = { tick: number } & (
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
  | { type: "action_rejected"; action: Action; reason: string }
);

type Summary = {
  ticks: number;
  patients: number;
  saved: number;
  dead: number;
  waiting: number;
  inAmbulance: number;
  survivalRate: number;
  meanResponseTicks: number;
};

export interface RunMeta {
  id: string;
  map: string;
  seed: number;
  ticks: number;
  coordinator: string;
  model: string | null;
  config: {
    tickSeconds: number;
    ambulances: number;
    hospitals: number;
    hospitalCapacity: number;
    ambulanceSpeedFactor: number;
    pickupTicks: number;
    dropoffTicks: number;
    ttlDecayInAmbulance: number;
  };
  hospitals: { id: string; name: string; node: number; capacity: number }[];
  startedAt: string;
  status: "running" | "finished" | "failed";
  summary: Summary | null;
}

export interface AmbulanceFrame {
  id: string;
  pos: [number, number];
  mission: "idle" | "to_patient" | "to_hospital" | "reposition";
  patientId: string | null;
  targetPatientId: string | null;
  hospitalId: string | null;
  broken: boolean;
  stranded: boolean;
  route: [number, 0 | 1][];
  /** Missing telemetry must never imply availability. */
  busyUntil?: number;
  brokenUntil?: number | null;
  /** Travel only; loading, unloading and repair are separate. */
  etaTicks?: number | null;
}

export interface TickRecord {
  tick: number;
  frame: {
    ambulances: AmbulanceFrame[];
    patients: {
      id: string;
      node: number;
      status: "waiting" | "in_ambulance" | "delivered" | "dead";
      ttl: number;
      endTick: number | null;
      spawnTick?: number;
      pickupTick?: number | null;
    }[];
    hospitals: { id: string; occupied: number }[];
    closedEdges: number[];
    summary: Summary;
  };
  events: WorldEvent[];
  actions: Action[];
  decision?: {
    source: "llm" | "fallback" | "rules";
    situation?: string;
    reasons?: string[];
    ms?: number;
    costUsd?: number;
    error?: string;
  };
}
