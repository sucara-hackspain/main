import {
  cutOffForecast,
  describe,
  INJURIES,
  makeVictim,
  SCENES,
  UNIT_KINDS,
  type Graph,
  type InjuryKind,
  type MasterAction,
  type Rng,
  type SceneKind,
  type World,
} from "../engine";

// What the agentic master is told each turn, what it may answer, and how that answer becomes things
// that happen to the world. Shared by whoever runs the agent (today a HappyRobot workflow).
//
// The master picks from what it is offered: places by index, streets by name, flood sources by index.
// It never names a node or an edge, so it cannot ask for something the map does not have.

export const MASTER_PROMPT = `Eres el MASTER de una simulación de emergencias: la noche de una DANA en València. Tú decides qué le pasa a la ciudad; enfrente hay un coordinador (otro agente) que manda ambulancias, bomberos, rescate acuático, un helicóptero y drones para salvar a quien tú pongas en peligro. No eres su enemigo ni su amigo: eres la tormenta. Tu trabajo es una noche creíble, tensa y que ponga a prueba sus decisiones, no una masacre imposible ni un paseo.

Juegas por TURNOS. Cada turno son unos minutos de la noche. Recibes el estado (turn, stats, log, places, injured, streets, ambulances) y decides qué ocurre hasta el turno siguiente.

QUÉ PUEDES HACER EN UN TURNO
- narration: UNA frase en español, en presente, como un parte de la noche: qué está pasando en la ciudad. Siempre obligatoria. No menciones índices ni ids.
- scenes: de 0 a 3 sucesos nuevos con heridos. Cada uno: place (un index de places[]), kind, victims (1 a 4), severity, trapped, silent.
  - kind: vehicle_trapped (coche atrapado por el agua), flooded_home (planta baja inundada), swept_away (persona arrastrada), building_collapse (derrumbe), collapse (persona desplomada), fall (caída), traffic (accidente de tráfico). Los cuatro primeros solo tienen sentido en places con zone "borde_del_agua" o "dentro_del_agua"; los tres últimos, en cualquier sitio.
  - severity: "critico" (minutos de vida: parada, ahogamiento, hemorragia), "grave" (aguanta más: politrauma, respiratorio, hipotermia) o "leve".
  - trapped: true si no pueden salir solos (hacen falta bomberos antes de poder cargarlos).
  - silent: true si de ese suceso NO va a llamar nadie al 112 (sin cobertura, sin batería, nadie consciente). Úsalo sobre todo dentro del agua. El coordinador solo los encontrará si va a mirar.
- flood: de 0 a 1 desbordamiento nuevo. source = un index de stats.flood_sources que aún esté libre; strength = "lenta", "media" o "rapida". El agua, una vez fuera, avanza sola cada turno y corta calles: no tienes que moverla tú.
- cut: de 0 a 1 calle cortada (un árbol, un socavón, un coche cruzado). El nombre debe coincidir EXACTAMENTE con un streets[].name. Las que tienen onRoute=true están en el camino de una unidad ahora mismo.
- puncture: de 0 a 1 unidad averiada; el id debe existir en ambulances[]. Raro: como mucho uno de cada seis turnos, y nunca dos turnos seguidos.

CÓMO LLEVAR LA NOCHE
- Es una DANA: el agua tiene que salir pronto. Si en el turno 2 todavía no hay ningún desbordamiento, abre uno. El agua ya crece sola: un segundo frente, no antes del turno 8; un tercero, no antes del turno 16, y solo si el coordinador aguanta bien. Tres como máximo en toda la noche.
- Ritmo: empieza con emergencias corrientes de ciudad, sube la presión cuando sale el agua y mantén la tensión. No hace falta que pase algo grave en cada turno: un turno de calma antes de un golpe fuerte también es narrativa. Mira stats: si hay muchos heridos esperando y pocas unidades libres, afloja (0 o 1 sucesos); si el coordinador va sobrado, aprieta.
- La mayoría de los sucesos del agua van en el "borde_del_agua": sitios a los que todavía se llega, pero que quedarán aislados (cutOffInTurns lo indica). Ahí es donde el coordinador tiene que decidir rápido. "dentro_del_agua" es para los que ya solo puede sacar el rescate acuático o el helicóptero: pocos, y a menudo silent.
- Pon a prueba decisiones distintas: dos sucesos casi a la vez en la misma esquina, un crítico lejos de todo (kmToNearestUnit alto), atrapados cuando los bomberos están ocupados, un barrio que deja de llamar.
- Lee el log: es lo que acaba de pasar, incluidas las órdenes del coordinador. Reacciona a ello como lo haría la noche, sin ensañarte con una unidad concreta.
- No repitas siempre el mismo tipo de suceso ni el mismo sitio.

Devuelve únicamente JSON válido conforme al esquema, sin texto adicional.`;

export const MASTER_SCHEMA = {
  type: "object",
  properties: {
    narration: { type: "string", description: "Exactamente una frase en español, en presente, contando qué pasa en la ciudad este turno. Siempre obligatoria." },
    scenes: {
      type: "array",
      description: "Sucesos nuevos con heridos. MÁXIMO 3. Devuelve [] si este turno no hay ninguno.",
      items: {
        type: "object",
        properties: {
          place: { type: "integer", description: "Un index que exista en places[] del input." },
          kind: { type: "string", enum: ["vehicle_trapped", "flooded_home", "swept_away", "building_collapse", "collapse", "fall", "traffic"] },
          victims: { type: "integer", description: "Personas heridas, de 1 a 4." },
          severity: { type: "string", enum: ["critico", "grave", "leve"], description: "Gravedad del peor herido." },
          trapped: { type: "boolean", description: "true si no pueden salir solos y hacen falta bomberos." },
          silent: { type: "boolean", description: "true si nadie va a llamar al 112 por este suceso." },
        },
        required: ["place", "kind", "victims", "severity", "trapped", "silent"],
        additionalProperties: false,
      },
    },
    flood: {
      type: "array",
      description: "Desbordamiento nuevo. MÁXIMO 1. Devuelve [] si no abres ninguno.",
      items: {
        type: "object",
        properties: {
          source: { type: "integer", description: "Un index libre de stats.flood_sources." },
          strength: { type: "string", enum: ["lenta", "media", "rapida"] },
        },
        required: ["source", "strength"],
        additionalProperties: false,
      },
    },
    cut: { type: "array", description: "Calles cortadas. MÁXIMO 1. Cada nombre debe coincidir exactamente con un streets[].name. Devuelve [] si no cortas ninguna.", items: { type: "string" } },
    puncture: { type: "array", description: "Ids de unidades que se averían. MÁXIMO 1, debe existir en ambulances[].id. Normalmente [].", items: { type: "string" } },
  },
  required: ["narration", "scenes", "flood", "cut", "puncture"],
  additionalProperties: false,
} as const;

export interface MasterOutput {
  narration: string;
  scenes: { place: number; kind: SceneKind; victims: number; severity: "critico" | "grave" | "leve"; trapped: boolean; silent: boolean }[];
  flood: { source: number; strength: "lenta" | "media" | "rapida" }[];
  cut: string[];
  puncture: string[];
}

/** Where the water can come out: rough stand-ins for the ravines and channels south of València. */
export const FLOOD_SOURCES = [
  { name: "Barranco sur · La Torre", lon: -0.398, lat: 39.438 },
  { name: "Nuevo cauce · La Punta", lon: -0.345, lat: 39.441 },
  { name: "Acequia de Favara · Malilla", lon: -0.372, lat: 39.446 },
  { name: "Nuevo cauce · Sant Isidre", lon: -0.413, lat: 39.452 },
  { name: "Marjal · Natzaret", lon: -0.333, lat: 39.452 },
] as const;

const STRENGTH = {
  lenta: { radiusM: 200, growthM: 4, maxRadiusM: 900 },
  media: { radiusM: 250, growthM: 6, maxRadiusM: 1200 },
  rapida: { radiusM: 300, growthM: 9, maxRadiusM: 1500 },
} as const;
const MAX_FLOODS = 3;

/** How far from the impassable core the water's edge still counts as "its edge". */
const EDGE_M: [number, number] = [150, 700];

export interface MasterTurn {
  /** The payload, field by field as the workflow's trigger expects them (each one a string). */
  payload: Record<string, string>;
  places: { index: number; node: number }[];
  streets: Map<string, number>;
}

/** One turn as the master sees it. The master may look at the truth: it IS the truth. */
export function buildMasterTurn(world: Readonly<World>, graph: Graph, rng: Rng, turn: number, everyTicks: number, gameId: string): MasterTurn {
  const cutOffIn = cutOffForecast({ zones: world.floods, closedEdges: world.closedEdges }, world.hospitals, graph);
  const free = world.units.filter((u) => u.mission === "idle" && u.brokenUntil === null && u.kind !== "drone");
  const kmToUnit = (node: number) => {
    const d = Math.min(...(free.length > 0 ? free : world.units).map((u) => graph.distanceM(u.node, node)));
    return Math.round(d / 100) / 10;
  };

  type Zone = "seco" | "borde_del_agua" | "dentro_del_agua";
  const picked: { node: number; zone: Zone }[] = [];
  const take = (nodes: number[], zone: Zone, n: number) => {
    const fresh = nodes.filter((node) => !picked.some((p) => p.node === node));
    // A place the master can picture has a street name; on a map without names, anywhere will do.
    const named = fresh.filter((node) => graph.streetAt(node));
    const pool = named.length > 0 ? named : fresh;
    for (let i = 0; i < n && pool.length > 0; i++) picked.push({ node: pool.splice(rng.int(0, pool.length - 1), 1)[0], zone });
  };
  for (const flood of world.floods) {
    const around = graph.nodesWithin(flood.node, flood.radiusM + EDGE_M[1]);
    const d = (n: number) => graph.distanceM(flood.node, n);
    take(around.filter((n) => d(n) > flood.radiusM + EDGE_M[0] && cutOffIn(n) === null), "borde_del_agua", 4);
    take(around.filter((n) => d(n) <= flood.radiusM && d(n) > flood.radiusM * 0.3), "dentro_del_agua", 2);
  }
  const underWater = (n: number) => world.floods.some((f) => graph.distanceM(f.node, n) <= f.radiusM + EDGE_M[1]);
  take(Array.from({ length: 60 }, () => rng.int(0, graph.nodeCount - 1)).filter((n) => !underWater(n)), "seco", Math.max(5, 14 - picked.length));
  // One pair on the same corner, so that "two things in one place" can happen.
  const anchor = picked.find((p) => p.zone !== "dentro_del_agua");
  if (anchor) take(graph.nodesWithin(anchor.node, 120).filter((n) => n !== anchor.node), anchor.zone, 1);

  const places = picked.map((p, index) => {
    const cut = cutOffIn(p.node);
    return { index, street: graph.streetAt(p.node), zone: p.zone, kmToNearestUnit: kmToUnit(p.node), cutOffInTurns: cut === null ? null : Math.ceil(cut / everyTicks), nextTo: null as number | null, node: p.node };
  });
  for (const a of places) {
    const near = places.find((b) => b !== a && graph.distanceM(a.node, b.node) <= 150);
    if (near) a.nextTo = near.index;
  }

  const streets = new Map<string, number>();
  const onRoute = new Set<string>();
  for (const unit of world.units) {
    for (const step of unit.route.slice(2, 14)) {
      const name = graph.edgeName(step.edge);
      if (!name || world.closedEdges.includes(step.edge) || streets.has(name)) continue;
      streets.set(name, step.edge);
      onRoute.add(name);
      if (streets.size >= 6) break;
    }
  }
  for (let tries = 0; streets.size < 10 && tries < 80; tries++) {
    const edge = rng.int(0, graph.edgeCount - 1);
    const name = graph.edgeName(edge);
    if (name && !streets.has(name) && !world.closedEdges.includes(edge)) streets.set(name, edge);
  }

  const waiting = world.victims.filter((v) => v.status === "waiting");
  const stats = {
    clock: `${Math.floor((world.tick * world.config.tickSeconds) / 60)} min de noche`,
    minutesPerTurn: Math.round((everyTicks * world.config.tickSeconds) / 60),
    victims: world.victims.length,
    saved: world.victims.filter((v) => v.status === "delivered" || v.status === "treated").length,
    dead: world.victims.filter((v) => v.status === "dead").length,
    waiting: waiting.length,
    waitingInsideWater: waiting.filter((v) => v.inWater).length,
    freeUnits: free.length,
    closedStreets: world.closedEdges.length,
    floods: world.floods.map((f) => ({ name: f.name, radiusM: Math.round(f.radiusM), stillGrowing: f.radiusM < f.maxRadiusM })),
    flood_sources: FLOOD_SOURCES.map((s, index) => ({ index, name: s.name, free: world.floods.length < MAX_FLOODS && !world.floods.some((f) => f.name === s.name) })),
  };
  const injured = world.scenes
    .filter((s) => !s.resolved)
    .map((s) => ({ what: SCENES[s.kind].label, street: graph.streetAt(s.node), waiting: world.victims.filter((v) => v.sceneId === s.id && v.status === "waiting").length, sinceTurns: Math.floor((world.tick - s.tick) / everyTicks) }))
    .filter((s) => s.waiting > 0)
    .slice(-12);
  const log = world.log.filter((e) => e.tick >= world.tick - everyTicks && e.type !== "flood_grew" && e.type !== "unit_arrived").slice(-25).map(describe);
  const ambulances = world.units.map((u) => ({ id: u.id, kind: UNIT_KINDS[u.kind].label, status: u.brokenUntil !== null ? "averiada" : u.mission === "idle" ? "libre" : u.mission }));

  return {
    payload: {
      game_id: gameId,
      role: "master",
      turn: String(turn),
      stats: JSON.stringify(stats),
      log: JSON.stringify(log),
      places: JSON.stringify(places.map(({ node: _node, ...place }) => place)),
      injured: JSON.stringify(injured),
      streets: JSON.stringify([...streets.keys()].map((name) => ({ name, onRoute: onRoute.has(name) }))),
      ambulances: JSON.stringify(ambulances),
    },
    places: places.map((p) => ({ index: p.index, node: p.node })),
    streets,
  };
}

/**
 * The platform nests a node's reply under a couple of envelopes, and which ones depends on the node type.
 * Descends until the object in hand has the field we are after.
 */
export function unwrap(raw: unknown, field: string): Record<string, unknown> {
  let body = raw;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || typeof body !== "object") break;
    const record = body as Record<string, unknown>;
    if (field in record) return record;
    const wrapper = ["data", "response", "output", "result"].find((key) => key in record);
    if (!wrapper) break;
    body = record[wrapper];
  }
  throw new Error(`node output has no "${field}": ${JSON.stringify(raw).slice(0, 200)}`);
}

export function readMasterOutput(raw: unknown): MasterOutput {
  const out = unwrap(raw, "narration");
  const list = <T>(v: unknown): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : Array.isArray(v) ? (v as T[]) : []);
  return { narration: String(out.narration ?? ""), scenes: list(out.scenes), flood: list(out.flood), cut: list(out.cut), puncture: list(out.puncture) };
}

const BY_SEVERITY: Record<MasterOutput["scenes"][number]["severity"], InjuryKind[]> = {
  critico: ["cardiac_arrest", "drowning", "hemorrhage"],
  grave: ["polytrauma", "respiratory", "hypothermia"],
  leve: ["fracture", "minor"],
};

function pick<T>(options: [T, number][], rng: Rng): T {
  let roll = rng.next() * options.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, weight] of options) if ((roll -= weight) <= 0) return value;
  return options[0][0];
}

/**
 * The master's wishes, as things the engine can do. Whatever it asks for that the map does not have
 * (a place it was not offered, a street that is not there) is dropped, and said so in `dropped`.
 */
export function toMasterActions(output: MasterOutput, turn: MasterTurn, world: Readonly<World>, graph: Graph, rng: Rng): { actions: MasterAction[]; dropped: string[] } {
  const actions: MasterAction[] = [];
  const dropped: string[] = [];
  if (output.narration.trim()) actions.push({ type: "narrate", text: output.narration.trim() });

  for (const wish of output.flood.slice(0, 1)) {
    const source = FLOOD_SOURCES[wish.source];
    const strength = STRENGTH[wish.strength] ?? STRENGTH.media;
    if (!source || world.floods.length >= MAX_FLOODS || world.floods.some((f) => f.name === source.name)) dropped.push(`flood source ${wish.source}`);
    else actions.push({ type: "start_flood", name: source.name, node: graph.nearestNode(source.lon, source.lat), ...strength });
  }

  for (const wish of output.scenes.slice(0, 3)) {
    const place = turn.places.find((p) => p.index === wish.place);
    if (!place || !(wish.kind in SCENES)) {
      dropped.push(`scene at place ${wish.place} (${wish.kind})`);
      continue;
    }
    const profile = SCENES[wish.kind];
    const count = Math.max(1, Math.min(4, Math.round(wish.victims) || 1));
    // The worst victim is as bad as the master said; the rest are whatever that kind of thing usually does to people.
    const wanted = BY_SEVERITY[wish.severity] ?? BY_SEVERITY.grave;
    const worst = profile.injuries.filter(([injury]) => wanted.includes(injury));
    const victims = Array.from({ length: count }, (_, n) => {
      const injury = n === 0 ? (worst.length > 0 ? pick(worst, rng) : rng.pick(wanted)) : pick(profile.injuries, rng);
      return { ...makeVictim(injury, rng, profile.elderly), trapped: n === 0 ? Boolean(wish.trapped) : wish.trapped && rng.chance(0.5) };
    });
    actions.push({ type: "spawn_scene", kind: wish.kind, node: place.node, victims, silent: Boolean(wish.silent) });
  }

  for (const name of output.cut.slice(0, 1)) {
    const edge = turn.streets.get(name);
    if (edge === undefined) dropped.push(`street "${name}"`);
    else actions.push({ type: "close_road", edge });
  }

  for (const unitId of output.puncture.slice(0, 1)) {
    const unit = world.units.find((u) => u.id === unitId);
    if (!unit || unit.brokenUntil !== null) dropped.push(`unit ${unitId}`);
    else actions.push({ type: "puncture", unitId, ticks: rng.int(10, 30) });
  }
  return { actions, dropped };
}

/** INJURIES is re-exported so the prompt's severities and the engine's injuries can be checked against each other in tests. */
export const SEVERITY_INJURIES = BY_SEVERITY;
export const KNOWN_INJURIES = Object.keys(INJURIES) as InjuryKind[];
