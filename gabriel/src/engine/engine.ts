import { WADING_FACTOR, type Graph } from "./graph";
import type {
  Action,
  Unit,
  AssessedVictim,
  EventInput,
  Hospital,
  LonLat,
  MasterAction,
  Scene,
  SimConfig,
  UnitKind,
  Victim,
  World,
} from "./types";
import { bySeverity, INJURIES, triage } from "./victims";

export const DEFAULT_CONFIG: SimConfig = {
  tickSeconds: 30,
  ambulances: 5,
  fireUnits: 3,
  rescueUnits: 2,
  helicopters: 1,
  drones: 2,
  hospitals: 6,
  hospitalCapacity: 14,
  ambulanceSpeedFactor: 1.3,
  pickupTicks: 2,
  dropoffTicks: 1,
  treatTicks: 2,
  extricateTicks: 3,
  searchRadiusM: 600,
  scoutRadiusM: 500,
  scoutTicks: 2,
};

/** Hospitals a helicopter can land at. */
const HELIPADS = ["La Fe", "General Universitari"];
/** Fire stations (approximate): Centro, Norte, Oeste. */
const STATIONS: [number, number][] = [
  [-0.366, 39.4577],
  [-0.3644, 39.4905],
  [-0.401, 39.4795],
];
/** Metres per second in a straight line, for the units that fly. */
const FLIGHT_MPS: Partial<Record<UnitKind, number>> = { helicopter: 50, drone: 22 };
export const flightMps = (kind: UnitKind): number => FLIGHT_MPS[kind] ?? 50;

/** What each kind of unit can do. `observes` = it can be sent to look at a place and report back. */
export const UNIT_KINDS: Record<UnitKind, { label: string; carries: boolean; extricates: boolean; wades: boolean; flies: boolean; observes: boolean }> = {
  ambulance: { label: "ambulancia", carries: true, extricates: false, wades: false, flies: false, observes: false },
  fire: { label: "bomberos", carries: false, extricates: true, wades: false, flies: false, observes: false },
  rescue: { label: "rescate acuático", carries: true, extricates: true, wades: true, flies: false, observes: false },
  helicopter: { label: "helicóptero", carries: true, extricates: false, wades: false, flies: true, observes: true },
  drone: { label: "dron", carries: false, extricates: false, wades: false, flies: true, observes: true },
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
    helipad: HELIPADS.some((name) => h.name.includes(name)),
    capacity: config.hospitalCapacity,
    occupied: 0,
  }));

  const units: Unit[] = [];
  const park = (kind: UnitKind, prefix: string, count: number, nodeFor: (i: number) => number) => {
    for (let i = 0; i < count; i++) {
      units.push({
        id: `${prefix}${i + 1}`,
        kind,
        flight: null,
        node: nodeFor(i),
        mission: "idle",
        destNode: null,
        route: [],
        progressS: 0,
        incidentId: null,
        sceneId: null,
        victimId: null,
        hospitalId: null,
        brokenUntil: null,
        busyUntil: 0,
        stranded: false,
      });
    }
  };
  const station = (i: number) => graph.nearestNode(...STATIONS[i % STATIONS.length]);
  // Ambulances wait at hospitals, firefighters and rescue crews at fire stations, the helicopter at a helipad.
  park("ambulance", "A", config.ambulances, (i) => hospitals[i % hospitals.length].node);
  park("fire", "B", config.fireUnits, station);
  park("rescue", "R", config.rescueUnits, (i) => station(i + 1));
  park("helicopter", "HEL", config.helicopters, () => (hospitals.find((h) => h.helipad) ?? hospitals[0]).node);
  // Drones live at the stations they launch from.
  park("drone", "D", config.drones, station);

  return {
    tick: 0,
    config,
    units,
    scenes: [],
    victims: [],
    hospitals,
    floods: [],
    closedEdges: [],
    floodedEdges: [],
    knownClosedEdges: [],
    log: [],
    nextSceneNum: 1,
    nextVictimNum: 1,
  };
}

export function emit(world: World, event: EventInput): void {
  world.log.push({ ...event, tick: world.tick });
}

const secondsToTicks = (world: World, seconds: number): number =>
  Math.ceil(seconds / world.config.ambulanceSpeedFactor / world.config.tickSeconds);

/** Node the ambulance can next change direction at: it must finish the edge it is on. */
export function effectiveNode(amb: Unit, graph: Graph): number {
  return amb.progressS > 0 ? graph.stepEnd(amb.route[0]) : amb.node;
}

export function unitLonLat(amb: Unit, graph: Graph): LonLat {
  if (amb.flight) {
    const to = graph.data.nodes[amb.flight.toNode];
    const t = amb.flight.distM > 0 ? amb.flight.doneM / amb.flight.distM : 1;
    return [amb.flight.from[0] + (to[0] - amb.flight.from[0]) * t, amb.flight.from[1] + (to[1] - amb.flight.from[1]) * t];
  }
  if (amb.progressS > 0) return graph.pointAlong(amb.route[0], Math.min(1, amb.progressS / graph.stepSeconds(amb.route[0])));
  return graph.data.nodes[amb.node];
}

function metresBetween(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  return Math.hypot((b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad), (b[1] - a[1]) * rad) * 6371000;
}

/** Streets this kind of unit treats as closed / as slow, given a set of closures and which of them are water. */
export function closuresFor(kind: UnitKind, closed: number[], flooded: number[]): { closed: Set<number>; slow: Set<number> } {
  if (!UNIT_KINDS[kind].wades) return { closed: new Set(closed), slow: new Set() };
  const water = new Set(flooded);
  return { closed: new Set(closed.filter((e) => !water.has(e))), slow: water };
}

/**
 * Sets course for destNode. Road units route around the closures we KNOW of (rescue crews wade through
 * the flooded ones), keeping the edge already in progress; helicopters fly straight.
 * Returns ETA in ticks, or null if unreachable.
 */
function setRoute(world: World, graph: Graph, amb: Unit, destNode: number): number | null {
  amb.stranded = false;
  if (UNIT_KINDS[amb.kind].flies) {
    const from = unitLonLat(amb, graph);
    const distM = metresBetween(from, graph.data.nodes[destNode]);
    amb.flight = { from, toNode: destNode, distM, doneM: 0 };
    amb.route = [];
    amb.destNode = destNode;
    return Math.ceil(distM / flightMps(amb.kind) / world.config.tickSeconds);
  }
  const inProgress = amb.progressS > 0 ? [amb.route[0]] : [];
  const { closed, slow } = closuresFor(amb.kind, world.knownClosedEdges, world.floodedEdges);
  const found = graph.route(effectiveNode(amb, graph), destNode, closed, slow);
  if (!found) return null;
  amb.route = [...inProgress, ...found.steps];
  amb.destNode = destNode;
  const remaining = inProgress.length ? graph.stepSeconds(inProgress[0]) - amb.progressS : 0;
  return secondsToTicks(world, found.seconds + remaining);
}

/** Drop the current mission; the ambulance still finishes the edge it is on. */
function halt(amb: Unit, graph: Graph): void {
  if (amb.flight) {
    // A helicopter just hovers where it is: snap it to the nearest street node.
    const [lon, lat] = unitLonLat(amb, graph);
    amb.node = graph.nearestNode(lon, lat);
    amb.flight = null;
  }
  amb.route = amb.progressS > 0 ? [amb.route[0]] : [];
  amb.destNode = amb.route.length ? graph.stepEnd(amb.route[0]) : null;
  amb.mission = amb.route.length ? "reposition" : "idle";
  amb.incidentId = null;
  amb.sceneId = null;
  amb.hospitalId = null;
  amb.stranded = false;
}

/** No known way to get there: the crew says so and stops. What to do next is the coordinator's call. */
function markStranded(world: World, graph: Graph, amb: Unit): void {
  emit(world, { type: "unit_stranded", unitId: amb.id, incidentId: amb.incidentId });
  const victimId = amb.victimId;
  halt(amb, graph);
  amb.victimId = victimId;
}

// ---------- Master ----------

export function applyMasterAction(world: World, graph: Graph, action: MasterAction): void {
  switch (action.type) {
    case "spawn_scene": {
      const scene: Scene = {
        id: `S${world.nextSceneNum++}`,
        kind: action.kind,
        node: action.node,
        tick: world.tick,
        victimIds: [],
        resolved: false,
        silent: action.silent ?? false,
      };
      for (const spec of action.victims) {
        const victim: Victim = {
          ...spec,
          id: `V${world.nextVictimNum++}`,
          sceneId: scene.id,
          node: action.node,
          status: "waiting",
          spawnTick: world.tick,
          attendedTick: null,
          endTick: null,
          inWater: world.floods.some((f) => graph.distanceM(f.node, action.node) <= f.radiusM),
        };
        world.victims.push(victim);
        scene.victimIds.push(victim.id);
      }
      world.scenes.push(scene);
      emit(world, { type: "scene_created", sceneId: scene.id, kind: scene.kind, node: scene.node, victims: scene.victimIds.length });
      return;
    }
    case "start_flood": {
      const flood = {
        id: `F${world.floods.length + 1}`,
        name: action.name,
        node: action.node,
        radiusM: action.radiusM,
        growthM: action.growthM,
        maxRadiusM: action.maxRadiusM,
        startTick: world.tick,
      };
      world.floods.push(flood);
      emit(world, { type: "flood_started", floodId: flood.id, name: flood.name, node: flood.node, radiusM: flood.radiusM, growthM: flood.growthM });
      return;
    }
    case "close_road": {
      if (world.closedEdges.includes(action.edge)) return;
      emit(world, { type: "road_closed", edge: action.edge, name: graph.edgeName(action.edge) });
      closeEdges(world, [action.edge]);
      return;
    }
    case "open_road": {
      const i = world.closedEdges.indexOf(action.edge);
      if (i < 0 || underWater(world, graph, action.edge)) return;
      world.closedEdges.splice(i, 1);
      emit(world, { type: "road_opened", edge: action.edge, name: graph.edgeName(action.edge) });
      return;
    }
    case "puncture": {
      const amb = world.units.find((a) => a.id === action.unitId);
      if (!amb || amb.brokenUntil !== null) return;
      amb.brokenUntil = world.tick + action.ticks;
      emit(world, { type: "unit_broken", unitId: amb.id, untilTick: amb.brokenUntil });
      return;
    }
  }
}

/** Closes streets. Nobody is told: crews find out when they get there, dispatch when someone reports it. */
function closeEdges(world: World, edges: number[]): void {
  world.closedEdges.push(...edges.filter((e) => !world.closedEdges.includes(e)));
}

function underWater(world: World, graph: Graph, edge: number): boolean {
  const { a, b } = graph.data.edges[edge];
  return world.floods.some((f) => graph.distanceM(f.node, a) <= f.radiusM && graph.distanceM(f.node, b) <= f.radiusM);
}

/** Width of the shallow water around the impassable core. */
export const FLOOD_FRINGE_M = 700;
const FLOOD_STEP_TICKS = 4;
/** How far a crew can see that streets are closed from where it stands. */
const SIGHT_M = 180;

/** The water advances; every few ticks the streets it has covered become impassable. */
function growFloods(world: World, graph: Graph): void {
  for (const flood of world.floods) {
    flood.radiusM = Math.min(flood.maxRadiusM, flood.radiusM + flood.growthM);
    if ((world.tick - flood.startTick) % FLOOD_STEP_TICKS !== 0) continue;
    const closed = new Set(world.closedEdges);
    const covered: number[] = [];
    graph.data.edges.forEach((e, edge) => {
      if (closed.has(edge)) return;
      if (graph.distanceM(flood.node, e.a) <= flood.radiusM && graph.distanceM(flood.node, e.b) <= flood.radiusM) covered.push(edge);
    });
    if (covered.length === 0) continue;
    emit(world, { type: "flood_grew", floodId: flood.id, radiusM: Math.round(flood.radiusM), closed: covered });
    closeEdges(world, covered);
    world.floodedEdges.push(...covered);
    for (const victim of world.victims) {
      if (victim.status === "waiting" && graph.distanceM(flood.node, victim.node) <= flood.radiusM) victim.inWater = true;
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
  const amb = world.units.find((a) => a.id === action.unitId);
  if (!amb) return reject("unknown ambulance");
  if (amb.brokenUntil !== null) return reject("ambulance is broken down");

  let eta: number | null;
  switch (action.type) {
    case "dispatch": {
      if (amb.victimId) return reject("unit already carries a victim");
      if (!(action.node >= 0 && action.node < graph.nodeCount)) return reject("unknown node");
      if (action.hospitalId) {
        const hospital = world.hospitals.find((h) => h.id === action.hospitalId);
        if (!hospital) return reject("unknown hospital");
        if (!UNIT_KINDS[amb.kind].carries) return reject(`${UNIT_KINDS[amb.kind].label} do not carry victims`);
        if (UNIT_KINDS[amb.kind].flies && !hospital.helipad) return reject("hospital has no helipad");
      }
      eta = setRoute(world, graph, amb, action.node);
      if (eta === null) return reject("no open route to incident");
      amb.mission = "to_scene";
      amb.incidentId = action.incidentId;
      amb.sceneId = null;
      amb.hospitalId = action.hospitalId ?? null;
      break;
    }
    case "transport": {
      if (!amb.victimId) return reject("ambulance carries no victim");
      const hospital = world.hospitals.find((h) => h.id === action.hospitalId);
      if (!hospital) return reject("unknown hospital");
      if (UNIT_KINDS[amb.kind].flies && !hospital.helipad) return reject("hospital has no helipad");
      eta = setRoute(world, graph, amb, hospital.node);
      if (eta === null) return reject("no open route to hospital");
      amb.mission = "to_hospital";
      amb.hospitalId = hospital.id;
      break;
    }
    case "reposition": {
      if (amb.victimId) return reject("ambulance carries a victim");
      if (!(action.node >= 0 && action.node < graph.nodeCount)) return reject("unknown node");
      eta = setRoute(world, graph, amb, action.node);
      if (eta === null) return reject("no open route to node");
      amb.mission = "reposition";
      amb.incidentId = null;
      amb.sceneId = null;
      amb.hospitalId = null;
      break;
    }
    case "scout": {
      if (!UNIT_KINDS[amb.kind].observes) return reject(`${UNIT_KINDS[amb.kind].label} cannot scout`);
      if (amb.victimId) return reject("unit already carries a victim");
      if (!(action.node >= 0 && action.node < graph.nodeCount)) return reject("unknown node");
      eta = setRoute(world, graph, amb, action.node);
      if (eta === null) return reject("no open route to node");
      amb.mission = "to_observe";
      amb.incidentId = action.incidentId ?? null;
      amb.sceneId = null;
      amb.hospitalId = null;
      break;
    }
  }
  emit(world, { type: "action_applied", action, etaTicks: eta });
  return true;
}

// ---------- Physics: one tick ----------

export function advance(world: World, graph: Graph): void {
  growFloods(world, graph);
  const closed = new Set(world.closedEdges);
  for (const amb of world.units) moveUnit(world, graph, amb, closed);
  for (const victim of world.victims) ageVictim(world, graph, victim);
}

function moveUnit(world: World, graph: Graph, amb: Unit, closed: ReadonlySet<number>): void {
  if (amb.brokenUntil !== null) {
    if (world.tick < amb.brokenUntil) return;
    amb.brokenUntil = null;
    emit(world, { type: "unit_repaired", unitId: amb.id });
  }
  if (world.tick < amb.busyUntil) return;

  if (amb.flight) {
    amb.flight.doneM += flightMps(amb.kind) * world.config.tickSeconds;
    if (amb.flight.doneM < amb.flight.distM) return;
    amb.node = amb.flight.toNode;
    amb.flight = null;
  }

  const wades = UNIT_KINDS[amb.kind].wades;
  const flooded = wades ? new Set(world.floodedEdges) : null;
  let budget = world.config.tickSeconds * world.config.ambulanceSpeedFactor;
  while (amb.mission !== "idle" && amb.destNode !== null) {
    if (amb.flight) return; // took off again on arrival
    if (amb.route.length === 0) {
      if (amb.node === amb.destNode) {
        arrive(world, graph, amb);
        if (world.tick < amb.busyUntil) return;
        continue;
      }
      return markStranded(world, graph, amb);
    }
    if (budget <= 0) return;

    const step = amb.route[0];
    const wading = flooded?.has(step.edge) ?? false;
    if (amb.progressS === 0 && closed.has(step.edge) && !wading) {
      // The street is closed and nobody had told us. Look around, radio it in, turn back.
      const seen = [step.edge];
      graph.data.edges.forEach((e, edge) => {
        if (edge !== step.edge && closed.has(edge) && graph.distanceM(amb.node, e.a) <= SIGHT_M && graph.distanceM(amb.node, e.b) <= SIGHT_M) seen.push(edge);
      });
      const fresh = seen.filter((e) => !world.knownClosedEdges.includes(e));
      world.knownClosedEdges.push(...fresh);
      const flooded = underWater(world, graph, step.edge);
      if (fresh.length > 0) emit(world, { type: "road_blocked_found", unitId: amb.id, node: amb.node, edges: fresh, flooded });
      amb.busyUntil = world.tick + 1;
      if (setRoute(world, graph, amb, amb.destNode) === null) return markStranded(world, graph, amb);
      emit(world, { type: "unit_rerouted", unitId: amb.id, etaTicks: remainingTicks(amb, graph, world.config) });
      return;
    }
    const left = graph.stepSeconds(step) * (wading ? WADING_FACTOR : 1) - amb.progressS;
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
export function remainingTicks(amb: Unit, graph: Graph, config: SimConfig): number {
  if (amb.flight) return Math.ceil((amb.flight.distM - amb.flight.doneM) / flightMps(amb.kind) / config.tickSeconds);
  let seconds = -amb.progressS;
  for (const step of amb.route) seconds += graph.stepSeconds(step);
  return Math.ceil(seconds / config.ambulanceSpeedFactor / config.tickSeconds);
}

function arrive(world: World, graph: Graph, amb: Unit): void {
  const mission = amb.mission;
  amb.destNode = null;
  amb.mission = "idle";

  if (mission === "reposition") {
    emit(world, { type: "unit_arrived", unitId: amb.id, node: amb.node });
    return;
  }
  if (mission === "to_observe") return survey(world, graph, amb);
  if (mission === "to_scene") return arriveAtScene(world, graph, amb);

  if (mission === "to_hospital") {
    const hospital = world.hospitals.find((h) => h.id === amb.hospitalId)!;
    amb.hospitalId = null;
    if (hospital.occupied >= hospital.capacity) {
      emit(world, { type: "hospital_full", hospitalId: hospital.id, unitId: amb.id });
      return;
    }
    const victim = world.victims.find((v) => v.id === amb.victimId)!;
    victim.status = "delivered";
    victim.endTick = world.tick;
    hospital.occupied++;
    amb.victimId = null;
    amb.incidentId = null;
    amb.sceneId = null;
    amb.busyUntil = world.tick + world.config.dropoffTicks;
    emit(world, { type: "victim_delivered", victimId: victim.id, unitId: amb.id, hospitalId: hospital.id });
  }
}

/**
 * An observer is over the area: this is everything that is really within sight of it. What the
 * coordinator gets to hear is the observer's read of it, which is built (and degraded) in the observer.
 */
function survey(world: World, graph: Graph, unit: Unit): void {
  const radiusM = world.config.scoutRadiusM;
  const sceneIds = world.scenes
    .filter((s) => graph.distanceM(unit.node, s.node) <= radiusM)
    .filter((s) => world.victims.some((v) => v.sceneId === s.id && (v.status === "waiting" || v.status === "in_ambulance")))
    .map((s) => s.id);
  const water = new Set(world.floodedEdges);
  const closedEdges: number[] = [];
  const floodedEdges: number[] = [];
  for (const edge of world.closedEdges) {
    const e = graph.data.edges[edge];
    if (graph.distanceM(unit.node, e.a) > radiusM && graph.distanceM(unit.node, e.b) > radiusM) continue;
    (water.has(edge) ? floodedEdges : closedEdges).push(edge);
  }
  unit.busyUntil = world.tick + world.config.scoutTicks;
  unit.incidentId = null;
  emit(world, { type: "area_surveyed", unitId: unit.id, node: unit.node, radiusM, sceneIds, closedEdges, floodedEdges });
}

/** The crew reaches the reported spot, looks for the real scene, triages whoever is there and takes the worst one. */
function arriveAtScene(world: World, graph: Graph, amb: Unit): void {
  if (!amb.sceneId) {
    // The caller's "where" is approximate: look around for whatever is actually going on.
    let found: Scene | null = null;
    let foundM = world.config.searchRadiusM;
    for (const scene of world.scenes) {
      const d = graph.distanceM(amb.node, scene.node);
      if (!scene.resolved && d <= foundM) {
        found = scene;
        foundM = d;
      }
    }
    if (!found) {
      emit(world, { type: "scene_not_found", unitId: amb.id, incidentId: amb.incidentId, node: amb.node });
      amb.incidentId = null;
      amb.hospitalId = null;
      return;
    }
    amb.sceneId = found.id;
    if (found.node !== amb.node && setRoute(world, graph, amb, found.node) !== null) {
      amb.mission = "to_scene";
      return;
    }
  }

  const scene = world.scenes.find((s) => s.id === amb.sceneId)!;
  const victims = world.victims.filter((v) => v.sceneId === scene.id);
  const assessed: AssessedVictim[] = victims.map((v) => ({ id: v.id, injury: v.injury, triage: triage(v), status: v.status, trapped: v.trapped }));
  emit(world, {
    type: "scene_assessed",
    unitId: amb.id,
    incidentId: amb.incidentId,
    sceneId: scene.id,
    node: scene.node,
    victims: assessed,
  });

  const can = UNIT_KINDS[amb.kind];
  const waiting = victims.filter((v) => v.status === "waiting").sort(bySeverity);
  let busy = 0;

  // Firefighters (and rescue crews) free whoever is stuck; until then nobody can carry them.
  if (can.extricates) {
    for (const victim of waiting.filter((v) => v.trapped && (!can.carries || v === waiting[0]))) {
      victim.trapped = false;
      busy += world.config.extricateTicks;
      emit(world, { type: "victim_freed", victimId: victim.id, unitId: amb.id, incidentId: amb.incidentId });
    }
  }

  const toCarry = can.carries ? waiting.find((v) => INJURIES[v.injury].transport && !v.trapped) : undefined;
  if (toCarry) {
    toCarry.status = "in_ambulance";
    toCarry.attendedTick = world.tick;
    amb.victimId = toCarry.id;
    amb.busyUntil = world.tick + busy + world.config.pickupTicks;
    emit(world, { type: "victim_picked_up", victimId: toCarry.id, unitId: amb.id, incidentId: amb.incidentId });
    // Pre-assigned hospital: continue on our own. Otherwise wait for a transport order.
    const hospital = world.hospitals.find((h) => h.id === amb.hospitalId);
    if (hospital && setRoute(world, graph, amb, hospital.node) !== null) amb.mission = "to_hospital";
    else amb.hospitalId = null;
  } else {
    // Nobody this crew can take: patch up the minor ones here and become free again.
    for (const victim of waiting.filter((v) => !INJURIES[v.injury].transport && !v.trapped)) {
      victim.status = "treated";
      victim.attendedTick = world.tick;
      victim.endTick = world.tick;
      busy += world.config.treatTicks;
      emit(world, { type: "victim_treated", victimId: victim.id, unitId: amb.id, incidentId: amb.incidentId });
    }
    amb.busyUntil = world.tick + busy;
    amb.incidentId = null;
    amb.sceneId = null;
    amb.hospitalId = null;
  }
  scene.resolved = !victims.some((v) => v.status === "waiting");
}

function ageVictim(world: World, graph: Graph, victim: Victim): void {
  if (victim.ttl === null) return;
  if (victim.status !== "waiting" && victim.status !== "in_ambulance") return;
  victim.ttl -= victim.status === "waiting" ? 1 : INJURIES[victim.injury].ambulanceDecay;
  if (victim.ttl > 0) return;

  const where = victim.status === "waiting" ? "street" : "ambulance";
  victim.status = "dead";
  victim.ttl = 0;
  victim.endTick = world.tick;
  emit(world, { type: "victim_died", victimId: victim.id, where });
  const carrier = world.units.find((a) => a.victimId === victim.id);
  if (carrier) {
    carrier.victimId = null;
    halt(carrier, graph);
  }
}

// ---------- Score ----------

export interface Summary {
  ticks: number;
  victims: number;
  /** Delivered to hospital or treated on scene. */
  saved: number;
  dead: number;
  waiting: number;
  inAmbulance: number;
  /** saved / (saved + dead) */
  survivalRate: number;
  /** Victims the water reached before any crew: out of an ambulance's reach (dead or still waiting). */
  inWater: number;
  /** Survival among those an ambulance could get to. */
  reachableSurvivalRate: number;
  /** Mean ticks from the incident happening to a crew taking charge. */
  meanResponseTicks: number;
}

export function summarize(world: World): Summary {
  const count = (status: Victim["status"]) => world.victims.filter((v) => v.status === status).length;
  const saved = count("delivered") + count("treated");
  const dead = count("dead");
  const attended = world.victims.filter((v) => v.attendedTick !== null);
  const responseSum = attended.reduce((sum, v) => sum + (v.attendedTick! - v.spawnTick), 0);
  return {
    ticks: world.tick,
    victims: world.victims.length,
    saved,
    dead,
    waiting: count("waiting"),
    inAmbulance: count("in_ambulance"),
    survivalRate: saved + dead ? saved / (saved + dead) : 1,
    inWater: world.victims.filter((v) => v.inWater && (v.status === "waiting" || v.status === "dead")).length,
    reachableSurvivalRate: (() => {
      const deadReachable = world.victims.filter((v) => v.status === "dead" && !v.inWater).length;
      return saved + deadReachable ? saved / (saved + deadReachable) : 1;
    })(),
    meanResponseTicks: attended.length ? responseSum / attended.length : 0,
  };
}
