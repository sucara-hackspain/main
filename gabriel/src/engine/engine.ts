import type { Graph } from "./graph";
import type {
  Action,
  Ambulance,
  EventInput,
  Hospital,
  LonLat,
  MasterAction,
  Patient,
  SimConfig,
  World,
} from "./types";

export const DEFAULT_CONFIG: SimConfig = {
  tickSeconds: 30,
  ambulances: 5,
  hospitals: 6,
  hospitalCapacity: 8,
  ambulanceSpeedFactor: 1.3,
  pickupTicks: 2,
  dropoffTicks: 1,
  ttlDecayInAmbulance: 0.5,
};

export function createWorld(graph: Graph, config: SimConfig): World {
  const sites = [...graph.data.hospitals]
    .sort((a, b) => Number(b.emergency) - Number(a.emergency))
    .slice(0, config.hospitals);
  if (sites.length === 0) throw new Error("graph has no hospitals");

  const hospitals: Hospital[] = sites.map((h, i) => ({
    id: `H${i + 1}`,
    name: h.name,
    node: h.node,
    capacity: config.hospitalCapacity,
    occupied: 0,
  }));

  // Ambulances start parked at hospitals, round robin.
  const ambulances: Ambulance[] = [];
  for (let i = 0; i < config.ambulances; i++) {
    ambulances.push({
      id: `A${i + 1}`,
      node: hospitals[i % hospitals.length].node,
      mission: "idle",
      destNode: null,
      route: [],
      progressS: 0,
      patientId: null,
      targetPatientId: null,
      hospitalId: null,
      brokenUntil: null,
      busyUntil: 0,
      stranded: false,
    });
  }

  return { tick: 0, config, ambulances, patients: [], hospitals, closedEdges: [], log: [], nextPatientNum: 1 };
}

export function emit(world: World, event: EventInput): void {
  world.log.push({ ...event, tick: world.tick });
}

const secondsToTicks = (world: World, seconds: number): number =>
  Math.ceil(seconds / world.config.ambulanceSpeedFactor / world.config.tickSeconds);

/** Node the ambulance can next change direction at: it must finish the edge it is on. */
export function effectiveNode(amb: Ambulance, graph: Graph): number {
  return amb.progressS > 0 ? graph.stepEnd(amb.route[0]) : amb.node;
}

export function ambulanceLonLat(amb: Ambulance, graph: Graph): LonLat {
  if (amb.progressS > 0) return graph.pointAlong(amb.route[0], amb.progressS / graph.stepSeconds(amb.route[0]));
  return graph.data.nodes[amb.node];
}

/** Route to destNode keeping the edge already in progress. Returns ETA in ticks, or null if unreachable. */
function setRoute(world: World, graph: Graph, amb: Ambulance, destNode: number): number | null {
  const inProgress = amb.progressS > 0 ? [amb.route[0]] : [];
  const found = graph.route(effectiveNode(amb, graph), destNode, new Set(world.closedEdges));
  if (!found) return null;
  amb.route = [...inProgress, ...found.steps];
  amb.destNode = destNode;
  amb.stranded = false;
  const remaining = inProgress.length ? graph.stepSeconds(inProgress[0]) - amb.progressS : 0;
  return secondsToTicks(world, found.seconds + remaining);
}

/** Drop the current mission; the ambulance still finishes the edge it is on. */
function halt(amb: Ambulance, graph: Graph): void {
  amb.route = amb.progressS > 0 ? [amb.route[0]] : [];
  amb.destNode = amb.route.length ? graph.stepEnd(amb.route[0]) : null;
  amb.mission = amb.route.length ? "reposition" : "idle";
  amb.targetPatientId = null;
  amb.hospitalId = null;
  amb.stranded = false;
}

function markStranded(world: World, graph: Graph, amb: Ambulance): void {
  amb.route = amb.progressS > 0 ? [amb.route[0]] : [];
  if (!amb.stranded) {
    amb.stranded = true;
    emit(world, { type: "ambulance_stranded", ambulanceId: amb.id });
  }
}

// ---------- Master ----------

export function applyMasterAction(world: World, graph: Graph, action: MasterAction): void {
  switch (action.type) {
    case "spawn_patient": {
      const patient: Patient = {
        id: `P${world.nextPatientNum++}`,
        node: action.node,
        status: "waiting",
        ttl: action.ttl,
        spawnTick: world.tick,
        pickupTick: null,
        endTick: null,
      };
      world.patients.push(patient);
      emit(world, { type: "patient_spawned", patientId: patient.id, node: patient.node, ttl: patient.ttl });
      return;
    }
    case "close_road": {
      if (world.closedEdges.includes(action.edge)) return;
      world.closedEdges.push(action.edge);
      emit(world, { type: "road_closed", edge: action.edge, name: graph.edgeName(action.edge) });
      for (const amb of world.ambulances) {
        const firstFree = amb.progressS > 0 ? 1 : 0;
        const hit = amb.route.some((s, i) => i >= firstFree && s.edge === action.edge);
        if (!hit || amb.destNode === null) continue;
        const eta = setRoute(world, graph, amb, amb.destNode);
        if (eta === null) markStranded(world, graph, amb);
        else emit(world, { type: "ambulance_rerouted", ambulanceId: amb.id, etaTicks: eta });
      }
      return;
    }
    case "open_road": {
      const i = world.closedEdges.indexOf(action.edge);
      if (i < 0) return;
      world.closedEdges.splice(i, 1);
      emit(world, { type: "road_opened", edge: action.edge, name: graph.edgeName(action.edge) });
      return;
    }
    case "puncture": {
      const amb = world.ambulances.find((a) => a.id === action.ambulanceId);
      if (!amb || amb.brokenUntil !== null) return;
      amb.brokenUntil = world.tick + action.ticks;
      emit(world, { type: "ambulance_broken", ambulanceId: amb.id, untilTick: amb.brokenUntil });
      return;
    }
  }
}

// ---------- Coordinator ----------

/** Validates and applies an order. Rejections are logged so the coordinator hears about them. */
export function applyAction(world: World, graph: Graph, action: Action): boolean {
  const reject = (reason: string): boolean => {
    emit(world, { type: "action_rejected", action, reason });
    return false;
  };
  const amb = world.ambulances.find((a) => a.id === action.ambulanceId);
  if (!amb) return reject("unknown ambulance");
  if (amb.brokenUntil !== null) return reject("ambulance is broken down");

  let eta: number | null;
  switch (action.type) {
    case "dispatch": {
      if (amb.patientId) return reject("ambulance already carries a patient");
      const patient = world.patients.find((p) => p.id === action.patientId);
      if (!patient) return reject("unknown patient");
      if (patient.status !== "waiting") return reject(`patient is ${patient.status}`);
      if (action.hospitalId && !world.hospitals.some((h) => h.id === action.hospitalId)) {
        return reject("unknown hospital");
      }
      eta = setRoute(world, graph, amb, patient.node);
      if (eta === null) return reject("no open route to patient");
      // One ambulance per patient: whoever was heading there is released.
      for (const other of world.ambulances) {
        if (other !== amb && other.targetPatientId === patient.id) halt(other, graph);
      }
      amb.mission = "to_patient";
      amb.targetPatientId = patient.id;
      amb.hospitalId = action.hospitalId ?? null;
      break;
    }
    case "transport": {
      if (!amb.patientId) return reject("ambulance carries no patient");
      const hospital = world.hospitals.find((h) => h.id === action.hospitalId);
      if (!hospital) return reject("unknown hospital");
      eta = setRoute(world, graph, amb, hospital.node);
      if (eta === null) return reject("no open route to hospital");
      amb.mission = "to_hospital";
      amb.hospitalId = hospital.id;
      break;
    }
    case "reposition": {
      if (amb.patientId) return reject("ambulance carries a patient");
      if (!(action.node >= 0 && action.node < graph.nodeCount)) return reject("unknown node");
      eta = setRoute(world, graph, amb, action.node);
      if (eta === null) return reject("no open route to node");
      amb.mission = "reposition";
      amb.targetPatientId = null;
      amb.hospitalId = null;
      break;
    }
  }
  emit(world, { type: "action_applied", action, etaTicks: eta });
  return true;
}

// ---------- Physics: one tick ----------

export function advance(world: World, graph: Graph): void {
  const closed = new Set(world.closedEdges);
  for (const amb of world.ambulances) moveAmbulance(world, graph, amb, closed);
  for (const patient of world.patients) agePatient(world, graph, patient);
}

function moveAmbulance(world: World, graph: Graph, amb: Ambulance, closed: ReadonlySet<number>): void {
  if (amb.brokenUntil !== null) {
    if (world.tick < amb.brokenUntil) return;
    amb.brokenUntil = null;
    emit(world, { type: "ambulance_repaired", ambulanceId: amb.id });
  }
  if (world.tick < amb.busyUntil) return;

  let budget = world.config.tickSeconds * world.config.ambulanceSpeedFactor;
  while (amb.mission !== "idle" && amb.destNode !== null) {
    if (amb.route.length === 0) {
      if (amb.node === amb.destNode) {
        arrive(world, graph, amb);
        if (world.tick < amb.busyUntil) return;
        continue;
      }
      // Stranded earlier: keep trying, a road may have reopened.
      if (setRoute(world, graph, amb, amb.destNode) === null) return markStranded(world, graph, amb);
      emit(world, { type: "ambulance_rerouted", ambulanceId: amb.id, etaTicks: remainingTicks(amb, graph, world.config) });
    }
    if (budget <= 0) return;

    const step = amb.route[0];
    if (amb.progressS === 0 && closed.has(step.edge)) {
      if (setRoute(world, graph, amb, amb.destNode) === null) return markStranded(world, graph, amb);
      emit(world, { type: "ambulance_rerouted", ambulanceId: amb.id, etaTicks: remainingTicks(amb, graph, world.config) });
      continue;
    }
    const left = graph.stepSeconds(step) - amb.progressS;
    if (budget >= left) {
      budget -= left;
      amb.node = graph.stepEnd(step);
      amb.route.shift();
      amb.progressS = 0;
    } else {
      amb.progressS += budget;
      budget = 0;
    }
  }
}

/** Ticks left on the ambulance's current route. */
export function remainingTicks(amb: Ambulance, graph: Graph, config: SimConfig): number {
  let seconds = -amb.progressS;
  for (const step of amb.route) seconds += graph.stepSeconds(step);
  return Math.ceil(seconds / config.ambulanceSpeedFactor / config.tickSeconds);
}

function arrive(world: World, graph: Graph, amb: Ambulance): void {
  const mission = amb.mission;
  amb.destNode = null;
  amb.mission = "idle";

  if (mission === "reposition") {
    emit(world, { type: "ambulance_arrived", ambulanceId: amb.id, node: amb.node });
    return;
  }

  if (mission === "to_patient") {
    const patient = world.patients.find((p) => p.id === amb.targetPatientId)!;
    amb.targetPatientId = null;
    if (patient.status !== "waiting") {
      amb.hospitalId = null;
      emit(world, {
        type: "dispatch_void",
        ambulanceId: amb.id,
        patientId: patient.id,
        reason: `patient is ${patient.status}`,
      });
      return;
    }
    patient.status = "in_ambulance";
    patient.pickupTick = world.tick;
    amb.patientId = patient.id;
    amb.busyUntil = world.tick + world.config.pickupTicks;
    emit(world, { type: "patient_picked_up", patientId: patient.id, ambulanceId: amb.id });
    // Pre-assigned hospital: continue on our own. Otherwise wait for a transport order.
    const hospital = world.hospitals.find((h) => h.id === amb.hospitalId);
    if (hospital && setRoute(world, graph, amb, hospital.node) !== null) amb.mission = "to_hospital";
    else amb.hospitalId = null;
    return;
  }

  if (mission === "to_hospital") {
    const hospital = world.hospitals.find((h) => h.id === amb.hospitalId)!;
    amb.hospitalId = null;
    if (hospital.occupied >= hospital.capacity) {
      emit(world, { type: "hospital_full", hospitalId: hospital.id, ambulanceId: amb.id });
      return;
    }
    const patient = world.patients.find((p) => p.id === amb.patientId)!;
    patient.status = "delivered";
    patient.endTick = world.tick;
    hospital.occupied++;
    amb.patientId = null;
    amb.busyUntil = world.tick + world.config.dropoffTicks;
    emit(world, {
      type: "patient_delivered",
      patientId: patient.id,
      ambulanceId: amb.id,
      hospitalId: hospital.id,
    });
  }
}

function agePatient(world: World, graph: Graph, patient: Patient): void {
  if (patient.status !== "waiting" && patient.status !== "in_ambulance") return;
  patient.ttl -= patient.status === "waiting" ? 1 : world.config.ttlDecayInAmbulance;
  if (patient.ttl > 0) return;

  const where = patient.status === "waiting" ? "street" : "ambulance";
  patient.status = "dead";
  patient.ttl = 0;
  patient.endTick = world.tick;
  emit(world, { type: "patient_died", patientId: patient.id, where });
  const carrier = world.ambulances.find((a) => a.patientId === patient.id);
  if (carrier) {
    carrier.patientId = null;
    halt(carrier, graph);
  }
}

// ---------- Score ----------

export interface Summary {
  ticks: number;
  patients: number;
  saved: number;
  dead: number;
  waiting: number;
  inAmbulance: number;
  /** saved / (saved + dead) */
  survivalRate: number;
  /** Mean ticks from report to pickup. */
  meanResponseTicks: number;
}

export function summarize(world: World): Summary {
  const count = (status: Patient["status"]) => world.patients.filter((p) => p.status === status).length;
  const saved = count("delivered");
  const dead = count("dead");
  const picked = world.patients.filter((p) => p.pickupTick !== null);
  const responseSum = picked.reduce((sum, p) => sum + (p.pickupTick! - p.spawnTick), 0);
  return {
    ticks: world.tick,
    patients: world.patients.length,
    saved,
    dead,
    waiting: count("waiting"),
    inAmbulance: count("in_ambulance"),
    survivalRate: saved + dead ? saved / (saved + dead) : 1,
    meanResponseTicks: picked.length ? responseSum / picked.length : 0,
  };
}
