import { distM, type Graph, type SlowEdges } from "./graph";
import type { Rng } from "./rng";
import {
  CARRIERS,
  type Action,
  type EventInput,
  type Hospital,
  type Incident,
  type LonLat,
  type MasterAction,
  type Need,
  type Patient,
  type Severity,
  type SimConfig,
  type Unit,
  type UnitKind,
  type World,
} from "./types";

export const DEFAULT_CONFIG: SimConfig = {
  tickSeconds: 30,
  fleet: { svb: 4, sva: 2, heli: 1, fire: 2, police: 2 },
  hospitals: 7,
  speedFactor: 1.3,
  heliSpeedMs: 50,
  heliLandingTicks: 2,
  pickupTicks: 2,
  dropoffTicks: 1,
  extricateTicks: 4,
  floodSlowFactor: 6,
  discoveryPenaltyTicks: 2,
  backupDelayTicks: 50,
  maxBackups: 3,
};

/** Ticks of life a patient of each severity starts with: [min, max]. */
export const TTL_RANGE: Record<Severity, [number, number]> = { critico: [10, 25], grave: [30, 70], leve: [120, 240] };
/** What dispatch assumes before anyone has seen the patient. */
export const TTL_TYPICAL: Record<Severity, number> = { critico: 16, grave: 45, leve: 160 };
/** TTL lost per tick while in the care of each unit kind (1 = same as lying in the street). */
export const CARE_DECAY: Record<UnitKind, Record<Severity, number>> = {
  svb: { critico: 1, grave: 0.6, leve: 0.3 },
  sva: { critico: 0.35, grave: 0.3, leve: 0.2 },
  heli: { critico: 0.35, grave: 0.3, leve: 0.2 },
  fire: { critico: 1, grave: 0.8, leve: 0.5 },
  police: { critico: 1, grave: 1, leve: 1 },
};
export const SEVERITY_POINTS: Record<Severity, number> = { critico: 3, grave: 2, leve: 1 };
const SUBOPTIMAL_FACTOR = 0.6;
const ESCAPE_SLOW_FACTOR = 10;

const UNIT_PREFIX: Record<UnitKind, string> = { svb: "SVB", sva: "SVA", heli: "HELI", fire: "BOM", police: "POL" };
const BIG_HOSPITALS = [/la fe/i, /cl[ií]nic universitari/i, /general universitari/i, /peset/i, /arnau/i];

export function createWorld(graph: Graph, config: SimConfig): World {
  const rank = (name: string) => {
    const i = BIG_HOSPITALS.findIndex((re) => re.test(name));
    return i < 0 ? BIG_HOSPITALS.length : i;
  };
  const sites = [...graph.data.hospitals]
    .sort((a, b) => rank(a.name) - rank(b.name) || Number(b.emergency) - Number(a.emergency))
    .slice(0, config.hospitals);
  if (sites.length === 0) throw new Error("graph has no hospitals");

  // The biggest hospital has everything; the next ones are trauma centres; the rest are general.
  const hospitals: Hospital[] = sites.map((h, i) => ({
    id: `H${i + 1}`,
    name: h.name,
    node: h.node,
    capacity: i < 4 ? 12 : 6,
    occupied: 0,
    specialties: i === 0 ? ["general", "trauma", "quemados"] : i < 4 ? ["general", "trauma"] : ["general"],
    helipad: i < 2,
    offlineUntil: null,
  }));

  const world: World = {
    tick: 0,
    config,
    units: [],
    patients: [],
    hospitals,
    incidents: [],
    zones: [],
    closedEdges: [],
    floodEdges: [],
    knownClosed: [],
    pendingBackups: [],
    backupsRequested: 0,
    entryNode: graph.nearestNode(graph.data.bbox[1], graph.data.bbox[2]),
    log: [],
    nextId: 1,
  };

  const stations = graph.data.stations ?? [];
  const bases: Record<UnitKind, number[]> = {
    svb: hospitals.map((h) => h.node),
    sva: hospitals.map((h) => h.node),
    heli: [hospitals[0].node],
    fire: stations.filter((s) => s.kind === "fire").map((s) => s.node),
    police: stations.filter((s) => s.kind === "police").map((s) => s.node),
  };
  for (const kind of Object.keys(config.fleet) as UnitKind[]) {
    const nodes = bases[kind].length ? bases[kind] : bases.svb;
    for (let i = 0; i < config.fleet[kind]; i++) addUnit(world, graph, kind, nodes[i % nodes.length], false);
  }
  return world;
}

function addUnit(world: World, graph: Graph, kind: UnitKind, node: number, backup: boolean): Unit {
  const n = world.units.filter((u) => u.kind === kind).length + 1;
  const unit: Unit = {
    id: `${UNIT_PREFIX[kind]}${n}`,
    kind,
    node,
    pos: kind === "heli" ? graph.data.nodes[node] : null,
    mission: "idle",
    destNode: null,
    route: [],
    progressS: 0,
    patientId: null,
    targetPatientId: null,
    hospitalId: null,
    incidentId: null,
    brokenUntil: null,
    busyUntil: 0,
    stranded: false,
    backup,
    wading: false,
  };
  world.units.push(unit);
  return unit;
}

export function emit(world: World, event: EventInput): void {
  world.log.push({ ...event, tick: world.tick });
}

// ---------- Movement helpers ----------

const roadTicks = (config: SimConfig, seconds: number): number =>
  Math.ceil(seconds / config.speedFactor / config.tickSeconds);

/** Node the unit can next change direction at: it must finish the edge it is on. */
export function effectiveNode(unit: Unit, graph: Graph): number {
  return unit.progressS > 0 ? graph.stepEnd(unit.route[0]) : unit.node;
}

export function unitLonLat(unit: Unit, graph: Graph): LonLat {
  if (unit.pos) return unit.pos;
  if (unit.progressS > 0) return graph.pointAlong(unit.route[0], unit.progressS / graph.stepSeconds(unit.route[0]));
  return graph.data.nodes[unit.node];
}

/** How a unit kind sees the network: fire engines wade through flooded streets, slowly. */
export function travelRules(kind: UnitKind, knownClosed: readonly number[], floodEdges: readonly number[], config: SimConfig) {
  if (kind !== "fire") return { closed: new Set(knownClosed), slow: undefined as SlowEdges | undefined };
  const flood = new Set(floodEdges);
  return {
    closed: new Set(knownClosed.filter((e) => !flood.has(e))),
    slow: { edges: flood, factor: config.floodSlowFactor } as SlowEdges,
  };
}

/** ETA in ticks from a unit to any node, with what is known about the roads. Infinity = unreachable. */
export function etaFrom(
  unit: Unit,
  graph: Graph,
  config: SimConfig,
  knownClosed: readonly number[],
  floodEdges: readonly number[],
): (node: number) => number {
  if (unit.kind === "heli") {
    const from = unitLonLat(unit, graph);
    return (node) => Math.ceil(distM(from, graph.data.nodes[node]) / (config.heliSpeedMs * config.tickSeconds)) + config.heliLandingTicks;
  }
  const { closed, slow } = travelRules(unit.kind, knownClosed, floodEdges, config);
  const times = graph.timesFrom(effectiveNode(unit, graph), closed, slow);
  return (node) => (times[node] === Infinity ? Infinity : roadTicks(config, times[node]));
}

/** Ticks left on the unit's current trip. */
export function remainingTicks(unit: Unit, graph: Graph, config: SimConfig): number {
  if (unit.destNode === null) return 0;
  if (unit.kind === "heli") {
    return Math.ceil(distM(unitLonLat(unit, graph), graph.data.nodes[unit.destNode]) / (config.heliSpeedMs * config.tickSeconds));
  }
  let seconds = -unit.progressS;
  for (const step of unit.route) seconds += graph.stepSeconds(step);
  return roadTicks(config, seconds);
}

/** Plan a trip with what is known. Returns ETA in ticks, or null if there is no known open route. */
function setRoute(world: World, graph: Graph, unit: Unit, destNode: number): number | null {
  if (unit.kind === "heli") {
    unit.destNode = destNode;
    unit.stranded = false;
    return remainingTicks(unit, graph, world.config);
  }
  const inProgress = unit.progressS > 0 ? [unit.route[0]] : [];
  const from = effectiveNode(unit, graph);
  const { closed, slow } = travelRules(unit.kind, world.knownClosed, world.floodEdges, world.config);
  let found = graph.route(from, destNode, closed, slow);
  if (!found && unit.kind !== "fire" && graph.edgesAt(from).some((e) => world.floodEdges.includes(e))) {
    // The water has closed in around the unit: it may crawl through it to get out.
    const escape = travelRules("fire", world.knownClosed, world.floodEdges, { ...world.config, floodSlowFactor: ESCAPE_SLOW_FACTOR });
    found = graph.route(from, destNode, escape.closed, escape.slow);
  }
  if (!found) return null;
  unit.wading = unit.kind !== "fire" && found.steps.some((s) => world.floodEdges.includes(s.edge));
  unit.route = [...inProgress, ...found.steps];
  unit.destNode = destNode;
  unit.stranded = false;
  const remaining = inProgress.length ? graph.stepSeconds(inProgress[0]) - unit.progressS : 0;
  return roadTicks(world.config, found.seconds + remaining);
}

/** Drop the current mission; a road unit still finishes the edge it is on. */
function halt(world: World, graph: Graph, unit: Unit, reason: string): void {
  unit.route = unit.progressS > 0 ? [unit.route[0]] : [];
  unit.destNode = unit.route.length ? graph.stepEnd(unit.route[0]) : null;
  unit.mission = unit.route.length ? "reposition" : "idle";
  unit.targetPatientId = null;
  unit.hospitalId = null;
  unit.incidentId = null;
  unit.stranded = false;
  if (unit.mission === "idle") emit(world, { type: "unit_free", unitId: unit.id, node: unit.node, reason });
}

/** No known way through: report it and hand the unit back to the coordinator (a loaded unit keeps its patient). */
function markStranded(world: World, graph: Graph, unit: Unit): void {
  emit(world, { type: "unit_stranded", unitId: unit.id });
  halt(world, graph, unit, "sin ruta conocida a su destino");
}

/** Called when dispatch learns about closures: units whose planned route crosses one re-plan. */
export function replanKnownClosures(world: World, graph: Graph): void {
  const known = new Set(world.knownClosed);
  const flood = new Set(world.floodEdges);
  for (const unit of world.units) {
    if (unit.destNode === null || unit.route.length === 0) continue;
    const first = unit.progressS > 0 ? 1 : 0;
    const blocked = unit.route.some((s, i) => i >= first && known.has(s.edge) && !(unit.kind === "fire" && flood.has(s.edge)));
    if (!blocked) continue;
    const eta = setRoute(world, graph, unit, unit.destNode);
    if (eta === null) markStranded(world, graph, unit);
    else emit(world, { type: "unit_rerouted", unitId: unit.id, etaTicks: eta });
  }
}

// ---------- Master ----------

function spawnPatient(
  world: World,
  p: { node: number; severity: Severity; need: Need; ttl: number; trapped: boolean; incidentId: string | null; phantom: boolean },
): Patient {
  const patient: Patient = {
    id: `P${world.patients.length + 1}`,
    node: p.node,
    status: "waiting",
    severity: p.severity,
    need: p.need,
    ttl: p.ttl,
    trapped: p.trapped,
    phantom: p.phantom,
    incidentId: p.incidentId,
    spawnTick: world.tick,
    pickupTick: null,
    endTick: null,
    suboptimal: false,
  };
  world.patients.push(patient);
  emit(world, {
    type: "patient_spawned",
    patientId: patient.id,
    node: p.node,
    severity: p.severity,
    need: p.need,
    ttl: p.ttl,
    trapped: p.trapped,
    incidentId: p.incidentId,
    phantom: p.phantom,
  });
  return patient;
}

function closeRoad(world: World, graph: Graph, edge: number, cause: string): void {
  if (world.closedEdges.includes(edge)) return;
  world.closedEdges.push(edge);
  emit(world, { type: "road_closed", edge, name: graph.edgeName(edge), cause });
}

function openRoad(world: World, graph: Graph, edge: number, by: "unit" | "self"): void {
  const i = world.closedEdges.indexOf(edge);
  if (i < 0) return;
  world.closedEdges.splice(i, 1);
  emit(world, { type: "road_opened", edge, name: graph.edgeName(edge), by });
}

export function applyMasterAction(world: World, graph: Graph, action: MasterAction, rng: Rng): void {
  switch (action.type) {
    case "spawn_patient":
      spawnPatient(world, {
        node: action.node,
        severity: action.severity,
        need: action.need ?? "general",
        ttl: action.ttl ?? rng.int(...TTL_RANGE[action.severity]),
        trapped: false,
        incidentId: null,
        phantom: false,
      });
      return;
    case "false_alarm":
      spawnPatient(world, { node: action.node, severity: "grave", need: "general", ttl: 9999, trapped: false, incidentId: null, phantom: true });
      return;
    case "start_incident": {
      const incident: Incident = {
        id: `I${world.incidents.length + 1}`,
        kind: action.kind,
        label: action.label,
        node: action.node,
        edge: action.edge ?? null,
        active: true,
        startTick: world.tick,
        endTick: null,
        fireWork: action.fireWork ?? 0,
        roadWork: action.edge === undefined ? 0 : (action.roadWork ?? 6),
        extricateProgress: 0,
        nextVictimTick: action.extraVictims ? world.tick + 6 : null,
        victimsLeft: action.extraVictims ?? 0,
        autoClearTick: action.kind === "obstacle" ? world.tick + rng.int(60, 120) : null,
      };
      world.incidents.push(incident);
      emit(world, {
        type: "incident_started",
        incidentId: incident.id,
        kind: incident.kind,
        label: incident.label,
        node: incident.node,
        edge: incident.edge,
        victims: action.victims.length,
      });
      if (incident.edge !== null) closeRoad(world, graph, incident.edge, incident.label);
      for (const v of action.victims) {
        const ttl = Math.round(rng.int(...TTL_RANGE[v.severity]) * (action.ttlFactor ?? 1));
        spawnPatient(world, { node: action.node, ...v, ttl, incidentId: incident.id, phantom: false });
      }
      return;
    }
    case "close_road": {
      const e = graph.data.edges[action.edge];
      applyMasterAction(
        world,
        graph,
        { type: "start_incident", kind: "obstacle", label: action.label ?? "Vía bloqueada", node: e.a, edge: action.edge, victims: [], roadWork: 5 },
        rng,
      );
      return;
    }
    case "start_zone": {
      const zone = {
        id: `Z${world.zones.length + 1}`,
        kind: action.kind,
        label: action.label,
        center: action.center,
        radiusM: action.radiusM,
        growthM: action.growthM ?? 0,
        maxRadiusM: action.maxRadiusM ?? action.radiusM,
        active: true,
        startTick: world.tick,
        endTick: action.durationTicks ? world.tick + action.durationTicks : null,
      };
      world.zones.push(zone);
      emit(world, { type: "zone_started", zoneId: zone.id, kind: zone.kind, label: zone.label, center: zone.center, radiusM: zone.radiusM });
      if (zone.kind === "flood") floodStreets(world, graph, zone.center, zone.radiusM);
      return;
    }
    case "breakdown": {
      const unit = world.units.find((u) => u.id === action.unitId);
      if (!unit || unit.brokenUntil !== null) return;
      unit.brokenUntil = world.tick + action.ticks;
      emit(world, { type: "unit_broken", unitId: unit.id, untilTick: unit.brokenUntil });
      return;
    }
    case "hospital_down": {
      const hospital = world.hospitals.find((h) => h.id === action.hospitalId);
      if (!hospital || hospital.offlineUntil !== null) return;
      hospital.offlineUntil = world.tick + action.ticks;
      emit(world, { type: "hospital_down", hospitalId: hospital.id, untilTick: hospital.offlineUntil });
      return;
    }
  }
}

/** Water does not send a notice per street: dispatch only learns the zone radius, late. */
function floodStreets(world: World, graph: Graph, center: LonLat, radiusM: number): void {
  const flooded = new Set(world.floodEdges);
  const closed = new Set(world.closedEdges);
  for (const edge of graph.edgesWithin(center, radiusM)) {
    if (flooded.has(edge)) continue;
    world.floodEdges.push(edge);
    if (!closed.has(edge)) world.closedEdges.push(edge);
  }
}

// ---------- Coordinator ----------

/** Validates and applies an order. Rejections are logged so the coordinator hears about them. */
export function applyAction(world: World, graph: Graph, action: Action): boolean {
  const reject = (reason: string): boolean => {
    emit(world, { type: "action_rejected", action, reason });
    return false;
  };

  if (action.type === "request_backup") {
    if (world.backupsRequested >= world.config.maxBackups) return reject("no more backup available");
    world.backupsRequested++;
    world.pendingBackups.push({ kind: action.kind, arriveTick: world.tick + world.config.backupDelayTicks });
    emit(world, { type: "action_applied", action, etaTicks: world.config.backupDelayTicks });
    return true;
  }

  const unit = world.units.find((u) => u.id === action.unitId);
  if (!unit) return reject("unknown unit");
  if (unit.brokenUntil !== null) return reject("unit is out of service");

  let eta: number | null;
  switch (action.type) {
    case "dispatch": {
      if (!CARRIERS.includes(unit.kind)) return reject(`${unit.kind} units cannot carry patients`);
      if (unit.patientId) return reject("unit already carries a patient");
      const patient = world.patients.find((p) => p.id === action.patientId);
      if (!patient) return reject("unknown patient");
      // A patient who died in the street is only discovered by the crew that gets there.
      if (patient.status !== "waiting" && patient.status !== "dead") return reject(`patient is ${patient.status}`);
      const hospital = action.hospitalId ? world.hospitals.find((h) => h.id === action.hospitalId) : undefined;
      if (action.hospitalId && !hospital) return reject("unknown hospital");
      if (hospital && unit.kind === "heli" && !hospital.helipad) return reject("that hospital has no helipad");
      eta = setRoute(world, graph, unit, patient.node);
      if (eta === null) return reject("no known open route to patient");
      // One carrier per patient: whoever was heading there is released.
      for (const other of world.units) {
        if (other !== unit && other.targetPatientId === patient.id) halt(world, graph, other, "reasignada");
      }
      unit.mission = "to_patient";
      unit.targetPatientId = patient.id;
      unit.hospitalId = hospital?.id ?? null;
      unit.incidentId = null;
      break;
    }
    case "transport": {
      if (!unit.patientId) return reject("unit carries no patient");
      const hospital = world.hospitals.find((h) => h.id === action.hospitalId);
      if (!hospital) return reject("unknown hospital");
      if (unit.kind === "heli" && !hospital.helipad) return reject("that hospital has no helipad");
      eta = setRoute(world, graph, unit, hospital.node);
      if (eta === null) return reject("no known open route to hospital");
      unit.mission = "to_hospital";
      unit.hospitalId = hospital.id;
      break;
    }
    case "assist": {
      if (unit.patientId) return reject("unit carries a patient");
      const incident = world.incidents.find((i) => i.id === action.incidentId);
      if (!incident) return reject("unknown incident");
      if (!incident.active) return reject("incident already resolved");
      eta = setRoute(world, graph, unit, incident.node);
      if (eta === null) return reject("no known open route to incident");
      // Fire and police work on the incident. An ambulance sent there just stages at the scene:
      // its crew sees (and reports) every victim nobody has phoned in yet.
      const works = unit.kind === "fire" || unit.kind === "police";
      unit.mission = works ? "to_incident" : "reposition";
      unit.incidentId = works ? incident.id : null;
      unit.targetPatientId = null;
      unit.hospitalId = null;
      break;
    }
    case "reposition": {
      if (unit.patientId) return reject("unit carries a patient");
      if (!(action.node >= 0 && action.node < graph.nodeCount)) return reject("unknown node");
      eta = setRoute(world, graph, unit, action.node);
      if (eta === null) return reject("no known open route to node");
      unit.mission = "reposition";
      unit.targetPatientId = null;
      unit.hospitalId = null;
      unit.incidentId = null;
      break;
    }
  }
  emit(world, { type: "action_applied", action, etaTicks: eta });
  return true;
}

// ---------- Physics: one tick ----------

export function advance(world: World, graph: Graph, rng: Rng): void {
  growZones(world, graph);
  for (const h of world.hospitals) {
    if (h.offlineUntil !== null && world.tick >= h.offlineUntil) {
      h.offlineUntil = null;
      emit(world, { type: "hospital_up", hospitalId: h.id });
    }
  }
  for (let i = world.pendingBackups.length - 1; i >= 0; i--) {
    if (world.tick < world.pendingBackups[i].arriveTick) continue;
    const [{ kind }] = world.pendingBackups.splice(i, 1);
    const unit = addUnit(world, graph, kind, world.entryNode, true);
    emit(world, { type: "backup_arrived", unitId: unit.id, kind });
  }
  for (const unit of world.units) moveUnit(world, graph, unit);
  workIncidents(world, graph, rng);
  for (const unit of world.units) if (unit.mission === "on_scene") waitOnScene(world, graph, unit);
  for (const patient of world.patients) agePatient(world, graph, patient);
}

function growZones(world: World, graph: Graph): void {
  for (const zone of world.zones) {
    if (!zone.active) continue;
    if (zone.endTick !== null && world.tick >= zone.endTick) {
      zone.active = false;
      emit(world, { type: "zone_ended", zoneId: zone.id });
      continue;
    }
    if (zone.kind !== "flood" || zone.radiusM >= zone.maxRadiusM) continue;
    zone.radiusM = Math.min(zone.maxRadiusM, zone.radiusM + zone.growthM);
    floodStreets(world, graph, zone.center, zone.radiusM);
    if ((world.tick - zone.startTick) % 10 === 0) emit(world, { type: "zone_grew", zoneId: zone.id, radiusM: Math.round(zone.radiusM) });
  }
}

function moveUnit(world: World, graph: Graph, unit: Unit): void {
  if (unit.brokenUntil !== null) {
    if (world.tick < unit.brokenUntil) return;
    unit.brokenUntil = null;
    emit(world, { type: "unit_repaired", unitId: unit.id });
  }
  if (world.tick < unit.busyUntil) return;
  if (unit.kind === "heli") return flyUnit(world, graph, unit);

  const closed = new Set(world.closedEdges);
  const flood = new Set(world.floodEdges);
  let budget = world.config.tickSeconds * world.config.speedFactor;
  while (unit.destNode !== null && !["idle", "working", "on_scene"].includes(unit.mission)) {
    if (unit.route.length === 0) {
      if (unit.node === unit.destNode) {
        arrive(world, graph, unit);
        if (world.tick < unit.busyUntil) return;
        continue;
      }
      // Stranded earlier: keep trying, we may have learnt of a reopened road.
      if (setRoute(world, graph, unit, unit.destNode) === null) return markStranded(world, graph, unit);
      emit(world, { type: "unit_rerouted", unitId: unit.id, etaTicks: remainingTicks(unit, graph, world.config) });
    }
    if (budget <= 0) return;

    const step = unit.route[0];
    // Fire engines wade by design; anyone else only when the plan says so (escaping rising water).
    const wades = flood.has(step.edge) && (unit.kind === "fire" || unit.wading);
    if (unit.progressS === 0 && closed.has(step.edge) && !wades) {
      // The plan said this road was open. It is not: lose time turning around and tell everyone.
      if (!world.knownClosed.includes(step.edge)) {
        world.knownClosed.push(step.edge);
        emit(world, { type: "road_discovered", unitId: unit.id, edge: step.edge, name: graph.edgeName(step.edge) });
        unit.busyUntil = world.tick + world.config.discoveryPenaltyTicks;
      }
      if (setRoute(world, graph, unit, unit.destNode) === null) return markStranded(world, graph, unit);
      emit(world, { type: "unit_rerouted", unitId: unit.id, etaTicks: remainingTicks(unit, graph, world.config) });
      if (world.tick < unit.busyUntil) return;
      continue;
    }
    // Wading is slow: the same edge costs floodSlowFactor times its seconds.
    const factor = !wades ? 1 : unit.kind === "fire" ? world.config.floodSlowFactor : ESCAPE_SLOW_FACTOR;
    const cost = graph.stepSeconds(step) * factor;
    const done = unit.progressS * factor;
    if (budget >= cost - done) {
      budget -= cost - done;
      unit.node = graph.stepEnd(step);
      unit.route.shift();
      unit.progressS = 0;
    } else {
      unit.progressS += budget / factor;
      budget = 0;
    }
  }
}

function flyUnit(world: World, graph: Graph, unit: Unit): void {
  if (unit.destNode === null || ["idle", "working", "on_scene"].includes(unit.mission)) return;
  const target = graph.data.nodes[unit.destNode];
  const from = unit.pos!;
  const reach = world.config.heliSpeedMs * world.config.tickSeconds;
  const left = distM(from, target);
  if (left <= reach) {
    unit.pos = target;
    unit.node = unit.destNode;
    arrive(world, graph, unit);
    return;
  }
  const t = reach / left;
  unit.pos = [from[0] + (target[0] - from[0]) * t, from[1] + (target[1] - from[1]) * t];
}

function hospitalOk(hospital: Hospital | undefined, unit: Unit): hospital is Hospital {
  return !!hospital && hospital.offlineUntil === null && (unit.kind !== "heli" || hospital.helipad);
}

function arrive(world: World, graph: Graph, unit: Unit): void {
  const mission = unit.mission;
  unit.destNode = null;
  unit.mission = "idle";

  if (mission === "reposition") {
    emit(world, { type: "unit_free", unitId: unit.id, node: unit.node, reason: "en posición" });
    return;
  }

  if (mission === "to_incident") {
    const incident = world.incidents.find((i) => i.id === unit.incidentId);
    if (!incident?.active) {
      unit.incidentId = null;
      emit(world, { type: "unit_free", unitId: unit.id, node: unit.node, reason: "incidente ya resuelto" });
      return;
    }
    unit.mission = "working";
    return;
  }

  if (mission === "to_patient") {
    const patient = world.patients.find((p) => p.id === unit.targetPatientId)!;
    if (patient.phantom && patient.status === "waiting") {
      patient.status = "false_alarm";
      patient.endTick = world.tick;
      unit.targetPatientId = null;
      unit.hospitalId = null;
      emit(world, { type: "false_alarm", patientId: patient.id, unitId: unit.id });
      return;
    }
    if (patient.status !== "waiting") {
      unit.targetPatientId = null;
      unit.hospitalId = null;
      emit(world, { type: "dispatch_void", unitId: unit.id, patientId: patient.id, reason: `patient is ${patient.status}` });
      return;
    }
    emit(world, { type: "patient_assessed", patientId: patient.id, unitId: unit.id, severity: patient.severity, ttl: Math.ceil(patient.ttl), trapped: patient.trapped });
    if (patient.trapped) {
      const incident = world.incidents.find((i) => i.id === patient.incidentId);
      const canFree = unit.kind === "fire" || (unit.kind === "heli" && incident?.kind === "flood_rescue");
      if (!canFree) {
        // Stay with them and keep them alive until someone gets them out.
        unit.mission = "on_scene";
        return;
      }
      patient.trapped = false;
      unit.busyUntil = world.tick + world.config.extricateTicks;
      emit(world, { type: "patient_extricated", patientId: patient.id, by: unit.id });
    }
    load(world, graph, unit, patient);
    return;
  }

  if (mission === "to_hospital") {
    const hospital = world.hospitals.find((h) => h.id === unit.hospitalId)!;
    unit.hospitalId = null;
    if (hospital.offlineUntil !== null || hospital.occupied >= hospital.capacity) {
      emit(world, {
        type: "hospital_rejected",
        hospitalId: hospital.id,
        unitId: unit.id,
        reason: hospital.offlineUntil !== null ? "offline" : "full",
      });
      return;
    }
    const patient = world.patients.find((p) => p.id === unit.patientId)!;
    patient.status = "delivered";
    patient.endTick = world.tick;
    patient.suboptimal = !hospital.specialties.includes(patient.need);
    hospital.occupied++;
    unit.patientId = null;
    unit.busyUntil = world.tick + world.config.dropoffTicks;
    emit(world, { type: "patient_delivered", patientId: patient.id, unitId: unit.id, hospitalId: hospital.id, suboptimal: patient.suboptimal });
  }
}

function load(world: World, graph: Graph, unit: Unit, patient: Patient): void {
  patient.status = "in_ambulance";
  patient.pickupTick = world.tick;
  unit.patientId = patient.id;
  unit.targetPatientId = null;
  unit.mission = "idle";
  unit.busyUntil = Math.max(unit.busyUntil, world.tick) + world.config.pickupTicks + (unit.kind === "heli" ? world.config.heliLandingTicks : 0);
  emit(world, { type: "patient_picked_up", patientId: patient.id, unitId: unit.id });
  // Pre-assigned hospital: continue on our own. Otherwise wait for a transport order.
  const hospital = world.hospitals.find((h) => h.id === unit.hospitalId);
  if (hospitalOk(hospital, unit) && setRoute(world, graph, unit, hospital.node) !== null) unit.mission = "to_hospital";
  else unit.hospitalId = null;
}

function waitOnScene(world: World, graph: Graph, unit: Unit): void {
  const patient = world.patients.find((p) => p.id === unit.targetPatientId);
  if (!patient || patient.status !== "waiting") {
    unit.mission = "idle";
    unit.targetPatientId = null;
    unit.hospitalId = null;
    emit(world, { type: "unit_free", unitId: unit.id, node: unit.node, reason: "el herido ya no está" });
    return;
  }
  if (!patient.trapped && world.tick >= unit.busyUntil) load(world, graph, unit, patient);
}

function workIncidents(world: World, graph: Graph, rng: Rng): void {
  for (const incident of world.incidents) {
    if (!incident.active) continue;
    const crew = world.units.filter((u) => u.mission === "working" && u.incidentId === incident.id && u.brokenUntil === null);
    let fire = crew.filter((u) => u.kind === "fire").length;
    const police = crew.filter((u) => u.kind === "police").length;
    const trapped = () => world.patients.filter((p) => p.incidentId === incident.id && p.status === "waiting" && p.trapped);

    // A burning building keeps hurting people until it is out.
    if (incident.fireWork > 0 && incident.victimsLeft > 0 && incident.nextVictimTick !== null && world.tick >= incident.nextVictimTick) {
      const severity: Severity = rng.pick(["leve", "grave", "grave", "critico"]);
      spawnPatient(world, { node: incident.node, severity, need: "quemados", ttl: rng.int(...TTL_RANGE[severity]), trapped: rng.chance(0.4), incidentId: incident.id, phantom: false });
      incident.victimsLeft--;
      incident.nextVictimTick = world.tick + rng.int(5, 9);
    }

    // Fire crews: flames first, then people, then the road.
    if (incident.fireWork > 0) {
      incident.fireWork = Math.max(0, incident.fireWork - fire);
      fire = 0;
    }
    if (fire > 0 && trapped().length > 0) {
      incident.extricateProgress += fire;
      while (incident.extricateProgress >= world.config.extricateTicks && trapped().length > 0) {
        const next = trapped().sort((a, b) => a.ttl - b.ttl)[0];
        next.trapped = false;
        incident.extricateProgress -= world.config.extricateTicks;
        emit(world, { type: "patient_extricated", patientId: next.id, by: crew.find((u) => u.kind === "fire")!.id });
      }
      fire = 0;
    }
    if (incident.roadWork > 0) {
      incident.roadWork = Math.max(0, incident.roadWork - fire - police);
      if (incident.autoClearTick !== null && world.tick >= incident.autoClearTick) incident.roadWork = 0;
      if (incident.roadWork === 0 && incident.edge !== null) openRoad(world, graph, incident.edge, crew.length ? "unit" : "self");
    }

    const done = incident.fireWork === 0 && incident.roadWork === 0 && trapped().length === 0;
    if (done) {
      incident.active = false;
      incident.endTick = world.tick;
      emit(world, { type: "incident_resolved", incidentId: incident.id });
    }
    for (const unit of crew) {
      const useful = unit.kind === "fire" ? !done : incident.roadWork > 0;
      if (useful) continue;
      unit.mission = "idle";
      unit.incidentId = null;
      emit(world, { type: "unit_free", unitId: unit.id, node: unit.node, reason: "trabajo terminado" });
    }
  }
}

function agePatient(world: World, graph: Graph, patient: Patient): void {
  if (patient.phantom || (patient.status !== "waiting" && patient.status !== "in_ambulance")) return;
  const carer =
    patient.status === "in_ambulance"
      ? world.units.find((u) => u.patientId === patient.id)
      : world.units.find((u) => u.mission === "on_scene" && u.targetPatientId === patient.id);
  patient.ttl -= carer ? CARE_DECAY[carer.kind][patient.severity] : 1;
  if (patient.ttl > 0) return;

  const where = patient.status === "waiting" ? "street" : "unit";
  patient.status = "dead";
  patient.ttl = 0;
  patient.endTick = world.tick;
  emit(world, { type: "patient_died", patientId: patient.id, where });
  if (carer) {
    carer.patientId = null;
    halt(world, graph, carer, "el herido ha muerto");
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
  falseAlarms: number;
  /** saved / (saved + dead) */
  survivalRate: number;
  /** Critical 3, serious 2, minor 1; x0.6 if delivered to a hospital without the right speciality. */
  points: number;
  /** Points if everyone already saved or dead had been saved at the right hospital. */
  maxPoints: number;
  /** Mean ticks from the incident to pickup. */
  meanResponseTicks: number;
}

export function summarize(world: World): Summary {
  const real = world.patients.filter((p) => !p.phantom);
  const count = (status: Patient["status"]) => real.filter((p) => p.status === status).length;
  const saved = count("delivered");
  const dead = count("dead");
  const picked = real.filter((p) => p.pickupTick !== null);
  let points = 0;
  let maxPoints = 0;
  for (const p of real) {
    if (p.status !== "delivered" && p.status !== "dead") continue;
    maxPoints += SEVERITY_POINTS[p.severity];
    if (p.status === "delivered") points += SEVERITY_POINTS[p.severity] * (p.suboptimal ? SUBOPTIMAL_FACTOR : 1);
  }
  return {
    ticks: world.tick,
    patients: real.length,
    saved,
    dead,
    waiting: count("waiting"),
    inAmbulance: count("in_ambulance"),
    falseAlarms: world.patients.filter((p) => p.status === "false_alarm").length,
    survivalRate: saved + dead ? saved / (saved + dead) : 1,
    points: Math.round(points * 10) / 10,
    maxPoints,
    meanResponseTicks: picked.length ? picked.reduce((sum, p) => sum + (p.pickupTick! - p.spawnTick), 0) / picked.length : 0,
  };
}
