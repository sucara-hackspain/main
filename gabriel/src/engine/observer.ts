import type { Graph } from "./graph";
import type { Rng } from "./rng";
import type { AerialSighting, Answer, Breathing, Call, CallerKind, ObservedEvent, Report, ReportSource, SceneKind, Victim, World, WorldEvent } from "./types";
import { bySeverity } from "./victims";

/**
 * Turns ground truth into what the coordinator actually hears.
 * Nothing about a victim reaches the coordinator except through here: first as 112 calls
 * (what a scared person can tell an operator), later as what crews radio from the scene.
 */
export interface Observer {
  observe(events: WorldEvent[], world: Readonly<World>, graph: Graph, rng: Rng): Omit<Report, "id">[];
}

/** Who reports each kind of world event. null = nobody tells the coordinator. */
const SOURCE: Record<WorldEvent["type"], ReportSource | null> = {
  // Nobody announces a scene or a death in the street: calls do, or the crew that finds them.
  scene_created: null,
  master_narration: null,
  victim_died: null,
  scene_assessed: "ambulance",
  scene_not_found: "ambulance",
  victim_freed: "ambulance",
  victim_picked_up: "ambulance",
  victim_treated: "ambulance",
  victim_delivered: "hospital",
  // The water is never announced: it is inferred from calls and crews, and from official maps that arrive late.
  flood_started: null,
  flood_grew: null,
  // A closed street is found by a crew, or reported by traffic control some minutes later.
  road_closed: null,
  road_blocked_found: "ambulance",
  road_opened: "traffic",
  unit_broken: "ambulance",
  unit_repaired: "ambulance",
  unit_rerouted: "ambulance",
  unit_stranded: "ambulance",
  unit_arrived: "ambulance",
  // Raw truth of what was in sight. The observer degrades it into a drone_report; nobody hears this.
  area_surveyed: null,
  hospital_full: "hospital",
  // The coordinator already knows its own accepted orders.
  action_applied: null,
  action_rejected: "system",
};

interface CallerProfile {
  label: string;
  /** How far off their "where" can be. */
  errorM: number;
  /** Chance they can answer a protocol question at all. */
  knows: number;
  /** Chance an answer they give is wrong. */
  wrong: number;
}

export const CALLERS: Record<CallerKind, CallerProfile> = {
  victim: { label: "El propio herido", errorM: 40, knows: 0.9, wrong: 0.03 },
  family: { label: "Un familiar", errorM: 40, knows: 0.95, wrong: 0.05 },
  bystander: { label: "Un testigo a pie", errorM: 150, knows: 0.7, wrong: 0.1 },
  driver: { label: "Un conductor que pasaba", errorM: 400, knows: 0.25, wrong: 0.2 },
};

/**
 * How likely a scene is to be made out from the air at all, with a perfect look.
 * A car on a flooded street or a collapsed façade is unmistakable; what happens inside a ground
 * floor or on a staircase is not. This is why a drone never replaces a crew.
 */
const VISIBLE_FROM_AIR: Record<SceneKind, number> = {
  vehicle_trapped: 0.92,
  swept_away: 0.6,
  building_collapse: 0.95,
  traffic: 0.85,
  flooded_home: 0.35,
  collapse: 0.2,
  fall: 0.25,
};

const WHO_CALLS: Record<SceneKind, [CallerKind, number][]> = {
  vehicle_trapped: [["victim", 45], ["bystander", 35], ["driver", 20]],
  flooded_home: [["family", 50], ["victim", 30], ["bystander", 20]],
  swept_away: [["bystander", 60], ["driver", 30], ["family", 10]],
  building_collapse: [["bystander", 55], ["family", 25], ["victim", 20]],
  collapse: [["family", 50], ["bystander", 50]],
  fall: [["family", 50], ["victim", 30], ["bystander", 20]],
  traffic: [["bystander", 50], ["driver", 35], ["victim", 15]],
};

const RECALL_AFTER_TICKS = 16;
/** Official flood maps: how often they come out and how old the picture in them is. */
const BULLETIN_EVERY_TICKS = 24;
const BULLETIN_LAG_TICKS = 10;
const TRAFFIC_DELAY_TICKS: [number, number] = [8, 20];

export interface CallObserverOptions {
  /** Force who calls (tests, scripted demos). */
  callers?: CallerKind[];
}

interface PendingCall {
  deliverTick: number;
  sceneId: string;
  caller: CallerKind;
}

export class CallObserver implements Observer {
  private pending: PendingCall[] = [];
  private pendingTraffic: { deliverTick: number; event: WorldEvent }[] = [];
  private lastCall = new Map<string, number>();
  private nextCallNum = 1;
  /** Which real scene each call was about. Never shown to the coordinator: only hindsight (evaluation) may read it. */
  readonly sceneOfCall = new Map<string, string>();

  constructor(private readonly options: CallObserverOptions = {}) {}

  observe(events: WorldEvent[], world: Readonly<World>, graph: Graph, rng: Rng): Omit<Report, "id">[] {
    const reports: Omit<Report, "id">[] = [];

    for (const event of events) {
      if (event.type === "scene_created") this.scheduleFirstCalls(event.sceneId, world, rng);
      if (event.type === "road_closed") this.pendingTraffic.push({ deliverTick: world.tick + rng.int(...TRAFFIC_DELAY_TICKS), event });
      if (event.type === "area_surveyed") {
        const report = this.readArea(event, world, graph, rng);
        reports.push({ tick: event.tick, source: "drone", confidence: report.quality, event: report });
      }
      const source = SOURCE[event.type];
      if (source) reports.push({ tick: event.tick, source, confidence: 1, event });
    }

    for (const t of this.pendingTraffic.filter((t) => t.deliverTick <= world.tick)) {
      reports.push({ tick: world.tick, source: "traffic", confidence: 1, event: t.event });
    }
    this.pendingTraffic = this.pendingTraffic.filter((t) => t.deliverTick > world.tick);

    if (world.tick > 0 && world.tick % BULLETIN_EVERY_TICKS === 0) {
      const asOfTick = world.tick - BULLETIN_LAG_TICKS;
      const floods = world.floods
        .filter((f) => f.startTick <= asOfTick)
        .map((f) => ({ id: f.id, name: f.name, node: f.node, radiusM: Math.round(Math.max(0, f.radiusM - f.growthM * BULLETIN_LAG_TICKS)) }));
      if (floods.length > 0) {
        reports.push({ tick: world.tick, source: "traffic", confidence: 1, event: { type: "flood_bulletin", tick: world.tick, asOfTick, floods } });
      }
    }

    // Nobody came: someone calls again.
    for (const scene of world.scenes) {
      if (scene.resolved || scene.silent || this.pending.some((p) => p.sceneId === scene.id)) continue;
      const stillWaiting = world.victims.some((v) => v.sceneId === scene.id && v.status === "waiting");
      const last = this.lastCall.get(scene.id);
      if (stillWaiting && last !== undefined && world.tick - last >= RECALL_AFTER_TICKS) {
        this.pending.push({ deliverTick: world.tick, sceneId: scene.id, caller: this.pickCaller(scene.kind, rng) });
      }
    }

    const due = this.pending.filter((p) => p.deliverTick <= world.tick);
    this.pending = this.pending.filter((p) => p.deliverTick > world.tick);
    for (const p of due) {
      const call = this.makeCall(p, world, graph, rng);
      if (!call) continue;
      this.lastCall.set(p.sceneId, world.tick);
      this.sceneOfCall.set(call.id, p.sceneId);
      const event: ObservedEvent = { type: "call_received", tick: world.tick, call };
      reports.push({ tick: world.tick, source: "call_112", confidence: 1 - CALLERS[p.caller].wrong, event });
    }
    return reports;
  }

  /**
   * What the observer thinks it saw. One roll decides how good the look was (rain, altitude, night,
   * how much smoke and water there is below) and everything else degrades from there: whole scenes
   * are missed, counts are off by one, and "cannot tell" is a perfectly normal answer.
   * The one thing it is good at is water: from above, a flooded street is unmistakable.
   */
  private readArea(
    event: Extract<WorldEvent, { type: "area_surveyed" }>,
    world: Readonly<World>,
    graph: Graph,
    rng: Rng,
  ): Extract<ObservedEvent, { type: "drone_report" }> {
    const quality = rng.range(0.5, 1);
    const sightings: AerialSighting[] = [];

    for (const sceneId of event.sceneIds) {
      const scene = world.scenes.find((s) => s.id === sceneId)!;
      const victims = world.victims.filter((v) => v.sceneId === sceneId && v.status !== "delivered" && v.status !== "treated");
      if (victims.length === 0) continue;
      // Further out from the observer, and in worse conditions, whole scenes go unnoticed.
      const far = graph.distanceM(event.node, scene.node) / Math.max(1, event.radiusM);
      if (!rng.chance(VISIBLE_FROM_AIR[scene.kind] * quality * (1 - 0.35 * far))) continue;

      const errorM = Math.round(20 + (1 - quality) * 120);
      const alive = victims.filter((v) => v.status !== "dead");
      const still = victims.filter((v) => v.status === "dead" || !v.conscious).length;
      const knows = (p: number): boolean => rng.chance(quality * p);
      const guess = (truth: boolean, p: number): Answer => (knows(p) ? (rng.chance(1 - quality) ? !truth : truth) ? "yes" : "no" : "unknown");

      let people: number | null = victims.length;
      if (!knows(0.9)) people = null;
      else if (rng.chance(1 - quality)) people = Math.max(1, people + rng.pick([-1, 1]));

      sightings.push({
        node: rng.pick(graph.nodesWithin(scene.node, errorM)),
        locationErrorM: errorM,
        kind: knows(0.85) ? scene.kind : null,
        people,
        // Telling "hurt" from "not moving" is the hardest call from the air, and the one that matters most.
        still: knows(0.6) ? Math.max(0, Math.min(people ?? still, still + (rng.chance(1 - quality) ? rng.pick([-1, 1]) : 0))) : null,
        trapped: guess(victims.some((v) => v.trapped), 0.45),
        inWater: guess(victims.some((v) => v.inWater) || alive.length === 0, 0.8),
      });
    }

    // Water reads well from above; a barrier or a landslide on a narrow street does not.
    const seen = (edges: number[], p: number) => edges.filter(() => rng.chance(p * (0.6 + 0.4 * quality)));
    const floodedEdges = seen(event.floodedEdges, 0.97);
    return {
      type: "drone_report",
      tick: world.tick,
      unitId: event.unitId,
      node: event.node,
      radiusM: event.radiusM,
      quality: Number(quality.toFixed(2)),
      sightings,
      closedEdges: seen(event.closedEdges, 0.8),
      floodedEdges,
      water: floodedEdges.length > 0 || world.floods.some((f) => graph.distanceM(f.node, event.node) <= f.radiusM + 150),
    };
  }

  private pickCaller(kind: SceneKind, rng: Rng): CallerKind {
    if (this.options.callers) return rng.pick(this.options.callers);
    const options = WHO_CALLS[kind];
    let roll = rng.next() * options.reduce((sum, [, w]) => sum + w, 0);
    for (const [caller, weight] of options) if ((roll -= weight) <= 0) return caller;
    return options[0][0];
  }

  /** Busy street scenes get several witnesses; what happens indoors gets one call. */
  private scheduleFirstCalls(sceneId: string, world: Readonly<World>, rng: Rng): void {
    const scene = world.scenes.find((s) => s.id === sceneId)!;
    // Nobody is going to call about this one. The only way it ever gets known is someone going to look.
    if (scene.silent) return;
    const outdoors = scene.kind !== "flooded_home" && scene.kind !== "collapse" && scene.kind !== "fall";
    let calls = outdoors ? 1 + rng.int(0, 2) : rng.chance(0.2) ? 2 : 1;
    if (scene.victimIds.length >= 3) calls++;
    let deliverTick = world.tick + rng.int(0, 2);
    for (let i = 0; i < calls; i++) {
      this.pending.push({ deliverTick, sceneId, caller: this.pickCaller(scene.kind, rng) });
      deliverTick += rng.int(1, 5);
    }
  }

  private makeCall(p: PendingCall, world: Readonly<World>, graph: Graph, rng: Rng): Call | null {
    const scene = world.scenes.find((s) => s.id === p.sceneId)!;
    if (scene.resolved) return null;
    const victims = world.victims.filter((v) => v.sceneId === scene.id && v.status !== "delivered" && v.status !== "treated");
    if (victims.length === 0) return null;

    // A victim can only call about themselves, and only if they can talk.
    let caller = p.caller;
    let subject: Victim;
    const canTalk = victims.filter((v) => v.conscious && v.status === "waiting");
    if (caller === "victim" && canTalk.length > 0) {
      subject = rng.pick(canTalk);
    } else {
      if (caller === "victim") caller = "bystander";
      // People mostly describe whoever looks worst.
      subject = rng.chance(0.7) ? [...victims].sort(bySeverity)[0] : rng.pick(victims);
    }
    const profile = CALLERS[caller];

    const answer = (truth: boolean): Answer => {
      if (!rng.chance(profile.knows)) return "unknown";
      return (rng.chance(profile.wrong) ? !truth : truth) ? "yes" : "no";
    };
    const dead = subject.status === "dead";
    const conscious = answer(subject.conscious && !dead);
    let breathing: Breathing | "unknown" = "unknown";
    if (rng.chance(profile.knows)) breathing = dead ? "none" : subject.breathing;
    const bleeding = answer(subject.bleeding);
    const trapped = answer(subject.trapped);

    let ageGroup: Call["ageGroup"] = "unknown";
    if (rng.chance(profile.knows)) ageGroup = subject.age < 16 ? "child" : subject.age > 65 ? "elderly" : "adult";

    let count: number | null = victims.length;
    if (caller === "bystander" && !rng.chance(0.6)) count = Math.max(1, count + rng.pick([-1, 1]));
    if (caller === "driver") count = rng.chance(0.6) ? null : Math.max(1, count + rng.pick([-1, 0, 1]));

    const mechanism = caller === "driver" && !rng.chance(0.6) ? null : scene.kind;
    const node = rng.pick(graph.nodesWithin(scene.node, profile.errorM));
    const street = graph.streetAt(node);

    const call: Call = {
      id: `L${this.nextCallNum++}`,
      tick: world.tick,
      caller,
      mechanism,
      node,
      locationErrorM: profile.errorM,
      street,
      conscious,
      breathing,
      bleeding,
      trapped,
      ageGroup,
      victims: count,
      text: "",
    };
    call.text = callText(call);
    return call;
  }
}

const WHAT: Record<SceneKind, string> = {
  vehicle_trapped: "El agua ha atrapado un coche con gente dentro",
  flooded_home: "Se está inundando una planta baja con gente dentro",
  swept_away: "El agua ha arrastrado a una persona",
  building_collapse: "Se ha derrumbado parte de un edificio",
  collapse: "Se ha desplomado una persona",
  fall: "Se ha caído una persona",
  traffic: "Ha habido un accidente de tráfico",
};

/** The call the way the operator would note it down. */
export function callText(call: Call): string {
  const where =
    (call.street ? `en ${call.street}` : "en una calle que no sabe nombrar") +
    (call.locationErrorM > 200 ? ", no sabe a qué altura" : call.locationErrorM > 100 ? ", más o menos" : "");
  const who = { child: "Es un niño. ", adult: "", elderly: "Es una persona mayor. ", unknown: "" }[call.ageGroup];
  const conscious = { yes: "Está consciente", no: "No responde", unknown: "No sabe si está consciente" }[call.conscious];
  const breathing = {
    normal: "respira bien",
    difficult: "respira con dificultad",
    none: "no respira",
    unknown: "no sabe si respira",
  }[call.breathing];
  const bleeding = { yes: " Sangra mucho.", no: "", unknown: "" }[call.bleeding] + { yes: " Está atrapado, no puede salir.", no: "", unknown: "" }[call.trapped];
  const count =
    call.victims === null ? " No sabe cuántos heridos hay." : call.victims > 1 ? ` Dice que hay ${call.victims} heridos.` : "";
  const what = call.mechanism ? WHAT[call.mechanism] : "Hay alguien tirado en el suelo";
  return `${CALLERS[call.caller].label}: «${what} ${where}. ${who}${conscious}, ${breathing}.${bleeding}${count}»`;
}
