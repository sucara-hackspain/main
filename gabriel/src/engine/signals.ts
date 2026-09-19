import type { Graph } from "./graph";
import { Rng } from "./rng";
import type { MasterAction, SceneKind } from "./types";

// The citizen channel: what people post and message while the night goes wrong. It is a lens on the same truth the 112
// calls come from, not more truth: every emergency leaves traces here, the silent ones above all (the neighbour, the
// niece, the photo from a balcony), buried in ten times as much noise. No control room can read it all. Nothing here
// depends on what the coordinator does, so a night always carries the same messages and a reading of it can be kept.

export type SignalChannel = "red" | "whatsapp" | "iot";
/** What a message really is. Never shown to a coordinator: readers have to work it out from the text. */
export type SignalKind = "plea" | "worry" | "sighting" | "lift" | "noise" | "joke" | "news" | "rumour";

export interface Signal {
  id: string;
  tick: number;
  channel: SignalChannel;
  /** Where the message points to, if it says. */
  node: number | null;
  street: string | null;
  text: string;
  kind: SignalKind;
  /** Node of the emergency it is really about (truth). null = about nothing. */
  about: number | null;
}

/** A person the home-care service knows lives alone: on its own it says nothing, next to a worried message it says a lot. */
export interface RegistryEntry {
  node: number;
  street: string | null;
  who: string;
}

const NAMES = ["Amparo", "Vicent", "Pepica", "Salvador", "Carmen", "Rafa", "Lola", "Batiste", "Empar", "Ximo", "Consuelo", "Toni"];
const KIN = ["mi madre", "mi abuelo", "mi tía", "mi padre", "mi abuela", "mi suegra", "mi hermano", "una vecina mayor"];
const FLOORS = ["el bajo", "la planta baja", "el entresuelo", "el bajo B", "el bajo izquierda"];

// {street} {num} {name} {kin} {floor} are filled in. The ones that matter most never say "socorro".
const TEMPLATES: Record<SignalKind, string[]> = {
  worry: [
    "Alguien sabe algo de {name}? Vive en {floor} de {street} {num} y no coge el teléfono desde hace una hora",
    "{kin} vive sin nadie más en {street} {num}, en {floor}. Llamo y no da señal. Si alguien está por allí que mire por favor",
    "No consigo hablar con {kin}. Está en {street} {num}, en {floor}, y no puede subir escaleras",
    "Vecinos de {street}: en el {num} hay un señor mayor en {floor} que no ha salido. Las persianas están bajadas y hay agua en el portal",
    "{name} no contesta. {street} {num}. Tiene 80 y pico años y va en silla. Alguien puede acercarse??",
    "Estoy fuera de Valencia y {kin} no responde. Vive en {street} {num}, en {floor}. Por favor que alguien avise",
    "Llevamos rato picando a la puerta en {floor} del {num} de {street} y nadie abre. Dentro se oye agua",
  ],
  plea: [
    "Estamos subidos al techo del coche en {street}, el agua sigue subiendo. Somos tres",
    "En {street} {num} hay gente atrapada en el garaje, no pueden abrir la puerta. El 112 no coge",
    "Necesitamos ayuda en {street}, mi marido se ha caído y no se puede mover, el agua nos llega a las rodillas",
    "Hay un hombre agarrado a una farola en {street}, la corriente es muy fuerte",
    "{street} {num}: una familia con dos críos en {floor}, el agua ya está dentro. No tienen cómo salir",
    "Por favor difundid: persona mayor atrapada en un coche en {street}, no responde",
  ],
  sighting: [
    "FOTO: coches amontonados en {street}, se ve a alguien dentro de uno",
    "Desde mi balcón en {street} veo agua entrando en los bajos del {num}. Hay luz encendida dentro",
    "Acaba de hundirse el muro del {num} de {street}, había gente en la acera",
    "VIDEO: {street} convertida en un río, una furgoneta arrastrada con el conductor dentro",
  ],
  lift: [
    "ALARMA ascensor · {street} {num} · cabina detenida entre plantas · pulsador activado",
    "ALARMA ascensor · {street} {num} · sin suministro · ocupante en cabina",
  ],
  noise: [
    "Menuda tromba está cayendo en {street}, no se ve nada",
    "En mi calle no hay luz desde hace un rato",
    "Alguien sabe si mañana hay clase?",
    "Se ha ido internet en todo el barrio",
    "Qué miedo los truenos, mi perro está debajo de la cama",
    "Está bajando mucha agua por {street} pero de momento se puede pasar",
    "El metro está parado, llevo 40 minutos en el andén",
    "Os leo desde Madrid, ánimo Valencia",
    "Han cortado {street}? Tengo que ir a trabajar a las 6",
    "Ha llegado la alerta al móvil a todo el mundo o solo a mí?",
    "Tengo el coche aparcado en {street}, alguien sabe cómo está aquello?",
    "Nosotros estamos bien, en un tercero. Sin luz pero bien",
    "La que está cayendo. Yo no recuerdo nada igual",
    "Se sabe algo de cuándo vuelve la luz?",
  ],
  joke: [
    "Socorro, atrapado en el sofá con una manta y sin ganas de salir",
    "Ayuda!! se me ha inundado la terraza y han muerto mis geranios",
    "Que alguien rescate a mi jefe, que quiere que vayamos mañana a la oficina",
    "Estoy atrapado en un grupo de WhatsApp de la comunidad, mandad ayuda",
    "Mi gato no responde, no respira... ah no, está durmiendo",
    "Necesito rescate urgente: se ha acabado el café y no puedo bajar al súper",
  ],
  news: [
    "ÚLTIMA HORA: bomberos rescatan a una familia atrapada en un garaje de Alzira (ayer)",
    "Recordad: en 2019 murieron seis personas atrapadas en sus coches en la Vega Baja",
    "Emergencias pide no usar el coche. Hay personas atrapadas en varias carreteras de la provincia",
    "HILO: qué hacer si el agua entra en tu casa y no puedes salir",
    "El 112 ha recibido miles de llamadas por personas atrapadas, según la Generalitat",
  ],
  rumour: [
    "Dicen que se ha roto la presa y viene una ola hacia {street}, salid todos!!",
    "Me han dicho que hay muertos en el parking de {street}, no sé si es verdad",
    "Por lo visto han evacuado todo {street}, alguien lo confirma?",
    "Un amigo policía dice que van a cortar el agua en toda la ciudad",
  ],
};

const SILENT_WORRIES: [number, number] = [2, 4];
const HEARD_TRACES: [number, number] = [0, 2];
const INDOORS: SceneKind[] = ["flooded_home", "collapse", "fall"];

function hashSeed(seed: number, salt: string): number {
  let hash = seed >>> 0;
  for (const char of salt) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

const fill = (template: string, rng: Rng, street: string | null) =>
  template
    .replace("{street}", street ?? "mi calle")
    .replace("{num}", String(rng.int(1, 60)))
    .replace("{name}", rng.pick(NAMES))
    .replace("{kin}", rng.pick(KIN))
    .replace("{floor}", rng.pick(FLOORS));

export interface NightSignals {
  signals: Signal[];
  registry: RegistryEntry[];
}

/**
 * Everything the citizen channel carries over a night, written from the night's script alone.
 * `volume` scales the noise: 1 is a bad night, 6 is a city where everyone is posting at once.
 */
export function buildSignals(script: { tick: number; action: MasterAction }[], graph: Graph, seed: number, ticks: number, volume = 1): NightSignals {
  const signals: Signal[] = [];
  const registry: RegistryEntry[] = [];
  const floods = script.flatMap((s) => (s.action.type === "start_flood" ? [{ tick: s.tick, node: s.action.node }] : []));
  const outages = script.flatMap((s) => (s.action.type === "blackout" ? [{ ...s.action, fromTick: s.tick }] : []));
  const push = (tick: number, kind: SignalKind, node: number | null, about: number | null, rng: Rng, channel?: SignalChannel) => {
    if (tick >= ticks) return;
    const street = node === null ? null : graph.streetAt(node);
    signals.push({ id: "", tick, channel: channel ?? (kind === "lift" ? "iot" : rng.chance(0.35) ? "whatsapp" : "red"), node, street, text: fill(rng.pick(TEMPLATES[kind]), rng, street), kind, about });
  };

  script.forEach(({ tick, action }, n) => {
    if (action.type !== "spawn_scene") return;
    const rng = new Rng(hashSeed(seed, `scene${n}`));
    const near = () => rng.pick(graph.nodesWithin(action.node, 70));
    const indoors = INDOORS.includes(action.kind);
    // Nobody phones about a silent scene, but somebody always misses whoever is in it.
    const count = rng.int(...(action.silent ? SILENT_WORRIES : HEARD_TRACES));
    let at = tick + rng.int(2, 6);
    for (let i = 0; i < count; i++) {
      push(at, action.silent || indoors ? "worry" : rng.chance(0.5) ? "plea" : "sighting", near(), action.node, rng);
      at += rng.int(2, 7);
    }
    const old = action.victims.find((v) => v.age > 65);
    if (old && indoors && rng.chance(0.75)) registry.push({ node: action.node, street: graph.streetAt(action.node), who: `${old.age} años, vive ${rng.chance(0.7) ? "sola" : "solo"}, ${rng.pick(["planta baja", "movilidad reducida", "planta baja, usa andador"])}` });
    // No power: whoever was in a lift stays in it, and the lift says so.
    if (outages.some((o) => tick >= o.fromTick && graph.distanceM(o.node, action.node) <= o.radiusM) && rng.chance(0.25)) push(tick + rng.int(0, 3), "lift", near(), null, rng);
  });

  const noise = new Rng(hashSeed(seed, "noise"));
  const hot = floods.length ? floods.map((f) => f.node) : [0];
  for (let tick = 0; tick < ticks; tick++) {
    const wet = floods.filter((f) => f.tick <= tick).length;
    const many = Math.round(volume * (5 + wet * 9 + noise.int(0, 6)));
    for (let i = 0; i < many; i++) {
      const kind = noise.pick<SignalKind>(["noise", "noise", "noise", "noise", "noise", "joke", "news", "rumour"]);
      const node = noise.chance(0.7) ? (noise.chance(0.6) ? noise.pick(graph.nodesWithin(noise.pick(hot), 1600)) : noise.int(0, graph.nodeCount - 1)) : null;
      push(tick, kind, kind === "news" ? null : node, null, noise);
    }
  }
  for (let i = 0; i < 70; i++) {
    const node = noise.int(0, graph.nodeCount - 1);
    registry.push({ node, street: graph.streetAt(node), who: `${noise.int(70, 96)} años, vive ${noise.chance(0.6) ? "sola" : "solo"}` });
  }

  // Arrival order within a tick is what a reader with limited attention gets through first: keep it arbitrary.
  const order = new Rng(hashSeed(seed, "order"));
  const shuffled = signals.map((s) => ({ s, key: s.tick + order.next() })).sort((a, b) => a.key - b.key).map(({ s }, n) => ({ ...s, id: `M${n + 1}` }));
  return { signals: shuffled, registry };
}
