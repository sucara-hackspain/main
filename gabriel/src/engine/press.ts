import { clock } from "./describe";
import type { Graph } from "./graph";
import { sitesAtRisk } from "./sites";
import { projectedRadius } from "./water";
import type { Belief, SimConfig } from "./types";

// The public statement the control room puts out every few minutes. It is written from what dispatch knows and has
// confirmed, never from the truth: a press note that says more than the room knows would be a lie, and one that
// repeats an unconfirmed rumour would be worse. No names, no addresses of victims; places only where people must act.

export interface PressNote {
  tick: number;
  number: number;
  headline: string;
  lead: string;
  figures: { label: string; value: string }[];
  paragraphs: string[];
  advice: string[];
}

export const PRESS_EVERY_TICKS = 10;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function pressNote(belief: Belief, graph: Graph, config: SimConfig, channel?: { received: number; leads: number } | null): PressNote {
  const tick = belief.tick;
  const open = belief.incidents.filter((i) => i.status === "open" && !i.mergedInto);
  const seen = belief.incidents.filter((i) => !i.mergedInto).flatMap((i) => i.victims);
  const safe = seen.filter((v) => v.status === "delivered" || v.status === "treated").length;
  const dead = seen.filter((v) => v.status === "dead" || v.triage === "black").length;
  const onTheirWay = belief.units.filter((u) => u.mission === "to_scene" || u.mission === "to_hospital").length;
  const cutOff = open.filter((i) => i.unreachable).length;
  const beds = belief.hospitals.reduce((sum, h) => sum + Math.max(0, h.capacity - h.occupied), 0);
  const full = belief.hospitals.filter((h) => h.occupied >= h.capacity);
  const gaugesRising = belief.gauges.filter((g) => g.overflowTick > tick);
  const risk = sitesAtRisk(belief, graph, 60);
  const moved = belief.sites.reduce((sum, s) => sum + s.safe, 0);
  const caught = belief.sites.filter((s) => s.floodedTick !== null && s.safe < s.people).length;
  const dark = belief.outages.filter((o) => tick < o.untilTick);
  const streets = (node: number, radiusM: number) => [...new Set(graph.nodesWithin(node, radiusM).map((n) => graph.streetAt(n)).filter((name): name is string => Boolean(name)))].slice(0, 3);

  const headline = belief.floods.length
    ? `El agua afecta ya a ${belief.floods.map((f) => f.name.split(" · ").at(-1)).join(" y ")}: ${plural(open.length, "emergencia abierta", "emergencias abiertas")} y ${plural(onTheirWay, "unidad en servicio", "unidades en servicio")}`
    : gaugesRising.length
      ? `Aviso: el cauce de ${gaugesRising[0].name.split(" · ")[0]} puede desbordar en unos ${Math.max(1, Math.round(((gaugesRising[0].overflowTick - tick) * config.tickSeconds) / 60))} minutos`
      : `Emergencias atiende ${plural(open.length, "incidente", "incidentes")} por el temporal`;

  const paragraphs: string[] = [];
  for (const f of belief.floods) {
    const around = streets(f.node, projectedRadius(f, tick) + 250);
    paragraphs.push(`Zona inundada de ${f.name}: unos ${projectedRadius(f, tick)} metros alrededor del punto de desborde y avanzando${around.length ? `. Calles afectadas o próximas: ${around.join(", ")}` : ""}.`);
  }
  for (const g of gaugesRising) paragraphs.push(`El aforo de ${g.name} está al ${Math.round(g.level * 100)} % y subiendo. Se pide a quienes vivan en plantas bajas cerca del cauce que suban ya a un piso alto, sin esperar a ver el agua.`);
  if (moved > 0 || risk.length > 0) paragraphs.push(`Evacuación preventiva: ${plural(moved, "persona puesta", "personas puestas")} a salvo en residencias, colegios y garajes antes de que llegara el agua${risk.length ? `; se está actuando en ${plural(risk.length, "centro más", "centros más")} en el camino del agua` : ""}.${caught ? ` En ${plural(caught, "centro", "centros")} el agua llegó con gente dentro: hay equipos de rescate trabajando allí.` : ""}`);
  if (cutOff > 0) paragraphs.push(`${plural(cutOff, "emergencia no tiene", "emergencias no tienen")} acceso por carretera: solo se llega con rescate acuático o helicóptero. No intente acercarse por su cuenta.`);
  if (dark.length) paragraphs.push(`Hay ${plural(dark.length, "zona", "zonas")} sin suministro eléctrico. Desde allí casi no entran llamadas: si no consigue hablar con un familiar que vive en esa zona, comuníquelo con su dirección exacta.`);
  if (channel && channel.received > 0) paragraphs.push(`La sala está leyendo también los mensajes ciudadanos (${channel.received.toLocaleString("es-ES")} hasta ahora) y ha abierto ${plural(channel.leads, "aviso", "avisos")} a partir de ellos. Un mensaje útil dice quién, dónde (calle y número) y qué pasa.`);
  if (full.length) paragraphs.push(`${full.map((h) => h.name).join(" y ")} no ${full.length === 1 ? "admite" : "admiten"} más ingresos por ahora; los traslados se derivan al resto de la red, con ${beds} camas disponibles.`);

  const advice = [
    "Llame al 112 solo si hay una vida en peligro. Para todo lo demás, use los canales municipales.",
    belief.floods.length || gaugesRising.length ? "Si vive en planta baja, sótano o garaje cerca del agua, suba a un piso alto ahora. No baje a por el coche." : "Evite los desplazamientos que no sean imprescindibles.",
    "Si sabe de una persona mayor o que vive sola en la zona afectada y no responde, avise indicando calle y número.",
    "No difunda rumores: compruebe la fuente antes de reenviar.",
  ];

  return {
    tick,
    number: Math.floor(tick / PRESS_EVERY_TICKS),
    headline,
    lead: `Comunicado nº ${Math.floor(tick / PRESS_EVERY_TICKS)} · ${clock(tick, config.tickSeconds)}. Datos confirmados por las dotaciones sobre el terreno; pueden cambiar en el siguiente comunicado.`,
    figures: [
      { label: "emergencias abiertas", value: String(open.length) },
      { label: "personas atendidas o trasladadas", value: String(safe) },
      { label: "fallecidos confirmados", value: String(dead) },
      { label: "unidades en servicio", value: `${onTheirWay} de ${belief.units.length}` },
      { label: "camas libres en la red", value: String(beds) },
    ],
    paragraphs,
    advice,
  };
}
