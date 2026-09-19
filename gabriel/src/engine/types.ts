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

// ---------- Ground truth: scenes and victims ----------
// The coordinator never sees any of this directly. It hears calls, and later what crews radio in.

export type InjuryKind = "cardiac_arrest" | "drowning" | "hemorrhage" | "respiratory" | "polytrauma" | "hypothermia" | "fracture" | "minor";
export type Breathing = "normal" | "difficult" | "none";
export type VictimStatus = "waiting" | "in_ambulance" | "delivered" | "treated" | "dead";
/** What a crew assigns on scene. black = dead. */
export type Triage = "red" | "yellow" | "green" | "black";

export interface VictimSpec {
  injury: InjuryKind;
  age: number;
  conscious: boolean;
  breathing: Breathing;
  bleeding: boolean;
  /** Stuck in a car or under rubble: nobody can carry them until firefighters free them. */
  trapped: boolean;
  /** Ticks of life left if untreated. null = not life-threatening. */
  ttl: number | null;
}

export interface Victim extends VictimSpec {
  id: string;
  sceneId: string;
  node: number;
  status: VictimStatus;
  spawnTick: number;
  /** Tick a crew first took charge (pickup or on-scene treatment). */
  attendedTick: number | null;
  endTick: number | null;
  /** The water reached them before any crew did: no ambulance can get there. */
  inWater: boolean;
}

export type SceneKind = "vehicle_trapped" | "flooded_home" | "swept_away" | "building_collapse" | "collapse" | "fall" | "traffic";

/** Something that happened at one place: one response, one or more victims. */
export interface Scene {
  id: string;
  kind: SceneKind;
  node: number;
  tick: number;
  victimIds: string[];
  /** A crew has been here and nobody is left waiting. */
  resolved: boolean;
  /**
   * Nobody calls 112 about this one: no witness, no coverage, no phone, nobody left conscious.
   * Dispatch only learns it exists if it sends someone to look.
   */
  silent: boolean;
}

/**
 * Water spreading from a point. Inside `radiusM` streets cannot be driven. Around it there is a
 * shallower fringe (FLOOD_FRINGE_M wide): cars stall and ground floors fill, but an ambulance gets through.
 */
export interface Flood {
  id: string;
  name: string;
  node: number;
  radiusM: number;
  /** Metres gained per tick until maxRadiusM. */
  growthM: number;
  maxRadiusM: number;
  startTick: number;
}

// ---------- Resources ----------

export type Mission = "idle" | "to_scene" | "to_hospital" | "reposition" | "to_observe";

/**
 * ambulance: carries one victim to hospital, by road.
 * fire: frees trapped victims so that someone else can carry them. Carries nobody.
 * rescue: high-clearance/amphibious crew. Slow, but drives through flooded streets: the only road unit that reaches people inside the water.
 * helicopter: flies straight, fast, ignores streets and water. One victim, and only to hospitals with a helipad.
 * drone: flies, carries nobody, rescues nobody. Its whole job is to go and look: it is the only way to
 *        learn about a place nobody has called about, and it never sees everything.
 */
export type UnitKind = "ambulance" | "fire" | "rescue" | "helicopter" | "drone";

export interface Unit {
  id: string;
  kind: UnitKind;
  /** Helicopters only: the leg being flown. */
  flight: { from: LonLat; toNode: number; distM: number; doneM: number } | null;
  /** Last node reached. While route[0] is in progress the ambulance is between `node` and that step's end. */
  node: number;
  mission: Mission;
  destNode: number | null;
  /** Remaining steps. route[0] is the edge being driven when progressS > 0. */
  route: Step[];
  /** Seconds already driven along route[0]. */
  progressS: number;
  /** Coordinator's incident this mission belongs to. Opaque to the engine: it is only echoed back in events. */
  incidentId: string | null;
  /** Real scene, once the crew has found it. */
  sceneId: string | null;
  /** Victim on board. mission "idle" + victimId set = waiting for a transport order. */
  victimId: string | null;
  hospitalId: string | null;
  /** Broken down until this tick. */
  brokenUntil: number | null;
  /** Busy loading/unloading/treating until this tick. */
  busyUntil: number;
  /** Has a destination but no open route to it. */
  stranded: boolean;
}

export interface Hospital {
  id: string;
  name: string;
  node: number;
  /** Helicopters can only deliver here if true. */
  helipad: boolean;
  capacity: number;
  occupied: number;
}

// ---------- World ----------

export interface SimConfig {
  tickSeconds: number;
  ambulances: number;
  fireUnits: number;
  rescueUnits: number;
  helicopters: number;
  drones: number;
  /** Max hospitals taken from the map (emergency ones first). */
  hospitals: number;
  hospitalCapacity: number;
  /** Multiplier over the street speed limit. */
  ambulanceSpeedFactor: number;
  pickupTicks: number;
  dropoffTicks: number;
  /** On-scene treatment of one minor victim. */
  treatTicks: number;
  /** Firefighters freeing one trapped victim. */
  extricateTicks: number;
  /** How far from the reported spot a crew will look for the scene. */
  searchRadiusM: number;
  /** How far around itself an aerial observer can make anything out. */
  scoutRadiusM: number;
  /** Ticks it spends over the area before the report goes out. */
  scoutTicks: number;
}

export interface World {
  tick: number;
  config: SimConfig;
  units: Unit[];
  scenes: Scene[];
  victims: Victim[];
  hospitals: Hospital[];
  floods: Flood[];
  /** Streets that really cannot be driven. */
  closedEdges: number[];
  /** The subset of closedEdges that is under water: rescue units still get through these. */
  floodedEdges: number[];
  /**
   * Streets dispatch and crews KNOW are closed: the only ones routes avoid. A mirror of the
   * coordinator's belief, refreshed every tick; crews add to it when they run into a closure.
   */
  knownClosedEdges: number[];
  log: WorldEvent[];
  nextSceneNum: number;
  nextVictimNum: number;
}

// ---------- What the master can do to the world ----------

export type MasterAction =
  | { type: "spawn_scene"; kind: SceneKind; node: number; victims: VictimSpec[]; silent?: boolean }
  | { type: "start_flood"; name: string; node: number; radiusM: number; growthM: number; maxRadiusM: number }
  | { type: "close_road"; edge: number }
  | { type: "open_road"; edge: number }
  | { type: "puncture"; unitId: string; ticks: number };

// ---------- What the coordinator can order ----------

export type Action =
  /**
   * Send an empty ambulance to an incident. `node` is where the coordinator believes it is;
   * the crew looks around there. With hospitalId it continues there once it has loaded someone.
   */
  | { type: "dispatch"; unitId: string; incidentId: string; node: number; hospitalId?: string }
  /** Send a loaded ambulance to a hospital. */
  | { type: "transport"; unitId: string; hospitalId: string }
  /** Move an empty ambulance to a node (staging). Also the way to call one off. */
  | { type: "reposition"; unitId: string; node: number }
  /**
   * Send an observer (drone, helicopter) to look at a place. It rescues nobody: it comes back with a
   * report of what it thinks is there. The answer to "I am deciding blind here".
   */
  | { type: "scout"; unitId: string; node: number; incidentId?: string };

// ---------- Event log (ground truth) ----------

export interface AssessedVictim {
  id: string;
  injury: InjuryKind;
  triage: Triage;
  status: VictimStatus;
  trapped: boolean;
}

type EventBody =
  | { type: "scene_created"; sceneId: string; kind: SceneKind; node: number; victims: number }
  | { type: "scene_assessed"; unitId: string; incidentId: string | null; sceneId: string; node: number; victims: AssessedVictim[] }
  | { type: "scene_not_found"; unitId: string; incidentId: string | null; node: number }
  | { type: "victim_picked_up"; victimId: string; unitId: string; incidentId: string | null }
  | { type: "victim_freed"; victimId: string; unitId: string; incidentId: string | null }
  | { type: "victim_treated"; victimId: string; unitId: string; incidentId: string | null }
  | { type: "victim_delivered"; victimId: string; unitId: string; hospitalId: string }
  | { type: "victim_died"; victimId: string; where: "street" | "ambulance" }
  | { type: "flood_started"; floodId: string; name: string; node: number; radiusM: number; growthM: number }
  | { type: "flood_grew"; floodId: string; radiusM: number; closed: number[] }
  | { type: "road_closed"; edge: number; name: string | null }
  | { type: "road_opened"; edge: number; name: string | null }
  | { type: "unit_broken"; unitId: string; untilTick: number }
  | { type: "unit_repaired"; unitId: string }
  | { type: "unit_rerouted"; unitId: string; etaTicks: number }
  | { type: "unit_stranded"; unitId: string; incidentId: string | null }
  /** A crew runs into streets it thought were open. `edges` = what it can see closed from there. */
  | { type: "road_blocked_found"; unitId: string; node: number; edges: number[]; flooded: boolean }
  | { type: "unit_arrived"; unitId: string; node: number }
  /**
   * Ground truth of what was actually within sight of an observer. Nobody hears this: the observer
   * turns it into a report, and a report is always worse than the truth.
   */
  | { type: "area_surveyed"; unitId: string; node: number; radiusM: number; sceneIds: string[]; closedEdges: number[]; floodedEdges: number[] }
  | { type: "hospital_full"; hospitalId: string; unitId: string }
  | { type: "action_applied"; action: Action; etaTicks: number }
  | { type: "action_rejected"; action: Action; reason: string };

export type WorldEvent = EventBody & { tick: number };
export type EventInput = EventBody;

// ---------- What reaches the coordinator ----------

export type CallerKind = "victim" | "family" | "bystander" | "driver";
export type Answer = "yes" | "no" | "unknown";

/** A 112 call as the operator files it: answers to the protocol questions. No diagnosis, no time to live. */
export interface Call {
  id: string;
  tick: number;
  caller: CallerKind;
  /** What happened, if the caller could tell. */
  mechanism: SceneKind | null;
  /** Best node for "where are you?", and how loose that answer was. */
  node: number;
  locationErrorM: number;
  street: string | null;
  conscious: Answer;
  breathing: Breathing | "unknown";
  bleeding: Answer;
  /** "Can they get out on their own?" */
  trapped: Answer;
  ageGroup: "child" | "adult" | "elderly" | "unknown";
  /** How many hurt, as far as the caller could see. */
  victims: number | null;
  /** The call in words, for humans and LLMs. */
  text: string;
}

/**
 * One thing an aerial observer believes it has seen. Every field can be wrong or missing: it is a
 * camera at 100 m through rain, not a crew on the ground.
 */
export interface AerialSighting {
  /** Where the observer places it. */
  node: number;
  locationErrorM: number;
  /** What it looks like from above. null = cannot tell what happened. */
  kind: SceneKind | null;
  /** People made out. null = "there is somebody, cannot count". */
  people: number | null;
  /** Of those, how many are not moving. null = cannot tell. */
  still: number | null;
  trapped: Answer;
  inWater: Answer;
}

export type ObservedEvent =
  | WorldEvent
  | { type: "call_received"; tick: number; call: Call }
  /**
   * What an observer radioes back after looking at a place. `quality` (0-1) is how good the look was:
   * with a bad one it misses whole scenes, and an empty `sightings` never proves there is nobody there.
   */
  | {
      type: "drone_report";
      tick: number;
      unitId: string;
      node: number;
      radiusM: number;
      quality: number;
      sightings: AerialSighting[];
      closedEdges: number[];
      floodedEdges: number[];
      /** It can see water below it. */
      water: boolean;
    }
  /** Official flood map. Reliable, but it shows the water as it was `asOfTick`, not now. */
  | { type: "flood_bulletin"; tick: number; asOfTick: number; floods: { id: string; name: string; node: number; radiusM: number }[] };
export type ReportSource = "call_112" | "ambulance" | "hospital" | "traffic" | "system" | "drone";

/** The coordinator never reads the world, only reports. */
export interface Report {
  id: number;
  tick: number;
  source: ReportSource;
  confidence: number;
  event: ObservedEvent;
}

// ---------- The coordinator's picture: incidents ----------

/** A belief plus where it came from (call id, or the ambulance that radioed it). */
export interface Sourced<T> {
  value: T;
  from: string;
  tick: number;
}

export type Priority = 0 | 1 | 2 | 3;

/** One place, one response. Calls get attached to it; crews confirm what is really there. */
export interface Incident {
  id: string;
  status: "open" | "closed";
  closedReason: "resolved" | "not_found" | "merged" | null;
  mergedInto: string | null;
  /** Reserved: parent emergency (flood, blackout...) once those exist. */
  emergencyId: string | null;
  openedTick: number;
  updatedTick: number;
  node: number;
  locationErrorM: number;
  /** A crew has confirmed the exact spot. */
  located: boolean;
  /** Last tick an observer looked at it from the air, and who. Worse than a crew, far better than a call. */
  seenTick: number | null;
  seenBy: string | null;
  /** People an observer counted from the air, when it could count them. */
  peopleSeen: Sourced<number> | null;
  sceneId: string | null;
  callIds: string[];
  mechanism: Sourced<SceneKind> | null;
  conscious: Sourced<"yes" | "no"> | null;
  breathing: Sourced<Breathing> | null;
  bleeding: Sourced<"yes" | "no"> | null;
  trapped: Sourced<"yes" | "no"> | null;
  ageGroup: Sourced<"child" | "adult" | "elderly"> | null;
  victimsReported: Sourced<number> | null;
  /** Confirmed on scene by a crew. */
  victims: AssessedVictim[];
  /** 0 = life at risk right now ... 3 = can wait. Deduced from the signs, never told. */
  priority: Priority;
  /** No road gets there (as far as we know): it needs a boat or a helicopter, not an ambulance. */
  unreachable: boolean;
  history: { tick: number; field: string; value: string; from: string }[];
}

/** Somebody saw water. wet = a caller or crew reports water there. blocked = a crew could not drive any further. */
export interface WaterSighting {
  tick: number;
  node: number;
  from: string;
  kind: "wet" | "blocked";
}

/** A flood as the last official map showed it. The coordinator extrapolates from there; the real one is ahead. */
export interface WaterZone {
  id: string;
  name: string;
  node: number;
  /** Impassable radius published in the last map, which showed the water as of `asOfTick`. */
  radiusM: number;
  asOfTick: number;
  /** Speed of the front, from the difference between maps (a guess until there are two). */
  growthM: number;
  bulletins: number;
}

export interface Belief {
  tick: number;
  /** Fleet telemetry: assumed reliable. */
  units: Unit[];
  hospitals: Hospital[];
  incidents: Incident[];
  calls: Call[];
  /** Places where someone has seen water: flood calls, crews turning back, crews on scene. */
  waterSightings: WaterSighting[];
  /** Floods known from official maps: always some minutes old. */
  floods: WaterZone[];
  closedEdges: number[];
  /** Known closures that are water: rescue units are routed through them. */
  floodedEdges: number[];
  /** Places already looked at from the air, and how good that look was. Ageing information, not proof. */
  scouts: { tick: number; node: number; radiusM: number; quality: number; from: string; found: number }[];
  nextIncidentNum: number;
}
