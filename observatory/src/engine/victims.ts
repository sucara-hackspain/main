import type { Rng } from "./rng";
import type { InjuryKind, SceneKind, Triage, Victim, VictimSpec, Call } from "./types";

interface InjuryProfile {
  label: string;
  /** Ticks to live when untreated, or null if nobody dies of this. */
  ttl: [number, number] | null;
  /** TTL lost per tick once a crew has the victim on board (1 = no better than the street). */
  ambulanceDecay: number;
  /** false = a crew fixes it on the spot, no hospital needed. */
  transport: boolean;
}

/** How each injury behaves. Same "time left" is not the same urgency: a bleed is slowed by a crew far more than burns are. */
export const INJURIES: Record<InjuryKind, InjuryProfile> = {
  cardiac_arrest: { label: "parada cardiaca", ttl: [10, 22], ambulanceDecay: 0.5, transport: true },
  drowning: { label: "ahogamiento", ttl: [8, 20], ambulanceDecay: 0.4, transport: true },
  hemorrhage: { label: "hemorragia grave", ttl: [18, 40], ambulanceDecay: 0.3, transport: true },
  respiratory: { label: "insuficiencia respiratoria", ttl: [25, 60], ambulanceDecay: 0.4, transport: true },
  polytrauma: { label: "politraumatismo", ttl: [30, 80], ambulanceDecay: 0.6, transport: true },
  hypothermia: { label: "hipotermia", ttl: [60, 140], ambulanceDecay: 0.2, transport: true },
  fracture: { label: "fractura", ttl: null, ambulanceDecay: 0, transport: true },
  minor: { label: "herida leve", ttl: null, ambulanceDecay: 0, transport: false },
};

/** What a crew sees when it gets there. */
export function triage(victim: Pick<Victim, "status" | "injury" | "ttl">): Triage {
  if (victim.status === "dead") return "black";
  if (victim.injury === "minor") return "green";
  if (victim.ttl === null) return "yellow";
  if (victim.injury === "cardiac_arrest" || victim.injury === "drowning" || victim.injury === "hemorrhage" || victim.ttl <= 30) return "red";
  return "yellow";
}

const TRIAGE_ORDER: Record<Triage, number> = { red: 0, yellow: 1, green: 2, black: 3 };

/** Most urgent first; among equals, the one with less time. */
export function bySeverity(a: Victim, b: Victim): number {
  return TRIAGE_ORDER[triage(a)] - TRIAGE_ORDER[triage(b)] || (a.ttl ?? Infinity) - (b.ttl ?? Infinity);
}

type Weighted<T> = [T, number][];

function pickWeighted<T>(options: Weighted<T>, rng: Rng): T {
  let roll = rng.next() * options.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, weight] of options) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return options[options.length - 1][0];
}

interface SceneProfile {
  label: string;
  /** Caused by the water (happens at its edge) or ordinary city emergency (anywhere). */
  where: "flood" | "city";
  weight: number;
  victims: [number, number];
  injuries: Weighted<InjuryKind>;
  elderly: number;
  /** Chance each victim is stuck (in the car, under rubble) and needs firefighters first. */
  trapped: number;
}

/** What a DANA does to people: cars caught by the water, ground floors filling up, people swept away, buildings giving in. */
export const SCENES: Record<SceneKind, SceneProfile> = {
  vehicle_trapped: { label: "vehículo atrapado por el agua", where: "flood", weight: 35, victims: [1, 3], injuries: [["hypothermia", 35], ["drowning", 20], ["polytrauma", 10], ["minor", 35]], elderly: 0.15, trapped: 0.55 },
  flooded_home: { label: "planta baja inundada", where: "flood", weight: 30, victims: [1, 3], injuries: [["hypothermia", 35], ["drowning", 25], ["respiratory", 10], ["minor", 30]], elderly: 0.6, trapped: 0.15 },
  swept_away: { label: "persona arrastrada por el agua", where: "flood", weight: 20, victims: [1, 2], injuries: [["drowning", 40], ["polytrauma", 30], ["hemorrhage", 15], ["hypothermia", 15]], elderly: 0.2, trapped: 0 },
  building_collapse: { label: "derrumbe", where: "flood", weight: 15, victims: [1, 4], injuries: [["polytrauma", 40], ["hemorrhage", 20], ["fracture", 25], ["minor", 15]], elderly: 0.3, trapped: 0.6 },
  collapse: { label: "persona desplomada", where: "city", weight: 40, victims: [1, 1], injuries: [["cardiac_arrest", 45], ["respiratory", 35], ["minor", 20]], elderly: 0.6, trapped: 0 },
  fall: { label: "caída", where: "city", weight: 30, victims: [1, 1], injuries: [["fracture", 50], ["polytrauma", 20], ["minor", 30]], elderly: 0.5, trapped: 0 },
  traffic: { label: "accidente de tráfico", where: "city", weight: 30, victims: [1, 4], injuries: [["polytrauma", 30], ["hemorrhage", 15], ["fracture", 25], ["minor", 30]], elderly: 0.15, trapped: 0.3 },
};

/** A clinically plausible victim for an injury: the signs a bystander could see follow from what is wrong. */
export function makeVictim(injury: InjuryKind, rng: Rng, elderlyShare = 0.2): VictimSpec {
  const profile = INJURIES[injury];
  const age = rng.chance(elderlyShare) ? rng.int(66, 92) : rng.chance(0.12) ? rng.int(3, 15) : rng.int(16, 65);
  const spec: VictimSpec = {
    injury,
    age,
    conscious: true,
    breathing: "normal",
    bleeding: false,
    trapped: false,
    ttl: profile.ttl ? rng.int(...profile.ttl) : null,
  };
  switch (injury) {
    case "cardiac_arrest":
      spec.conscious = false;
      spec.breathing = "none";
      break;
    case "hemorrhage":
      spec.conscious = rng.chance(0.6);
      spec.bleeding = true;
      break;
    case "polytrauma":
      spec.conscious = rng.chance(0.5);
      spec.bleeding = rng.chance(0.4);
      if (rng.chance(0.3)) spec.breathing = "difficult";
      break;
    case "respiratory":
      spec.conscious = rng.chance(0.8);
      spec.breathing = "difficult";
      break;
    case "drowning":
      spec.conscious = rng.chance(0.2);
      spec.breathing = rng.chance(0.5) ? "none" : "difficult";
      break;
    case "hypothermia":
      spec.conscious = rng.chance(0.75);
      break;
  }
  return spec;
}

export function makeSceneVictims(kind: SceneKind, rng: Rng): VictimSpec[] {
  const scene = SCENES[kind];
  const count = rng.int(...scene.victims);
  return Array.from({ length: count }, () => ({
    ...makeVictim(pickWeighted(scene.injuries, rng), rng, scene.elderly),
    trapped: rng.chance(scene.trapped),
  }));
}

const WATER_KINDS: SceneKind[] = ["vehicle_trapped", "flooded_home", "swept_away"];

/**
 * The emergency behind a call somebody really phoned in: what the caller described becomes what is true there.
 * The worst victim is as bad as the answers to the protocol say; the rest are whatever that kind of thing does to people.
 */
export function sceneFromCall(call: Pick<Call, "mechanism" | "conscious" | "breathing" | "bleeding" | "trapped" | "ageGroup" | "victims">, rng: Rng): { kind: SceneKind; victims: VictimSpec[] } {
  const kind = call.mechanism ?? "collapse";
  const water = WATER_KINDS.includes(kind);
  const worst: InjuryKind =
    call.breathing === "none" ? (water ? "drowning" : "cardiac_arrest")
    : call.bleeding === "yes" ? "hemorrhage"
    : call.breathing === "difficult" ? "respiratory"
    : call.conscious === "no" ? "polytrauma"
    : water ? "hypothermia"
    : kind === "fall" || kind === "traffic" || kind === "building_collapse" ? "fracture"
    : "minor";
  const count = Math.max(1, Math.min(4, Math.round(call.victims ?? 1)));
  const victims = Array.from({ length: count }, (_, n) => {
    const spec = makeVictim(n === 0 ? worst : pickWeighted(SCENES[kind].injuries, rng), rng, SCENES[kind].elderly);
    if (n === 0 && call.ageGroup === "child") spec.age = rng.int(3, 15);
    if (n === 0 && call.ageGroup === "elderly") spec.age = rng.int(66, 92);
    if (n === 0 && call.ageGroup === "adult") spec.age = rng.int(16, 65);
    return { ...spec, trapped: n === 0 ? call.trapped === "yes" : call.trapped === "yes" && rng.chance(0.4) };
  });
  return { kind, victims };
}

export function pickSceneKind(rng: Rng, where: "flood" | "city"): SceneKind {
  const kinds = (Object.keys(SCENES) as SceneKind[]).filter((k) => SCENES[k].where === where);
  return pickWeighted(kinds.map((k) => [k, SCENES[k].weight] as [SceneKind, number]), rng);
}
