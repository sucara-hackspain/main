import { elapsed, type AmbulanceFrame, type GraphData, type RunMeta, type TickRecord } from "../runModel";

export type EntityKind = "patient" | "ambulance" | "hospital" | "road";
export type EntityRef = { kind: EntityKind; id: string };
export type SituationFilter = "all" | "unassigned" | "broken" | "full";
export type Tone = "neutral" | "info" | "warning" | "danger" | "success";
export const entityKey = (ref: EntityRef) => `${ref.kind}:${ref.id}`;
export const sameEntity = (a: EntityRef | null, b: EntityRef) => !!a && entityKey(a) === entityKey(b);
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, "es", { numeric: true });
export const duration = (ticks: number, seconds: number) => {
  const total = Math.max(0, Math.ceil(ticks * seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60), rest = total % 60;
  return `${minutes} min${rest ? ` ${rest} s` : ""}`;
};

export function ambulanceAvailability(a: AmbulanceFrame, tick: number): boolean | null {
  if (a.broken || a.stranded || a.mission !== "idle" || a.patientId || a.targetPatientId || a.route.length) return false;
  return a.busyUntil === undefined ? null : a.busyUntil <= tick;
}

export function ambulanceActivity(a: AmbulanceFrame, tick: number, seconds: number) {
  const busy = Math.max(0, (a.busyUntil ?? tick) - tick);
  const patient = a.patientId || a.targetPatientId;
  if (a.broken) return {
    label: "Averiada", tone: "danger" as Tone,
    detail: a.brokenUntil != null ? `Reparación prevista en ${duration(a.brokenUntil - tick, seconds)}` : "Sin plazo de reparación registrado",
  };
  if (a.stranded) return { label: "Sin ruta abierta", tone: "danger" as Tone, detail: patient ? `Misión detenida · ${patient}` : "Destino inaccesible" };
  if (busy > 0) return {
    label: a.patientId ? "Recogiendo" : "Descargando", tone: "info" as Tone,
    detail: `${a.patientId ? "Recogida" : "Descarga"} termina en ${duration(busy, seconds)}${!a.patientId && a.targetPatientId ? ` · después ${a.targetPatientId}` : ""}`,
  };
  if (a.mission === "to_patient") return {
    label: "En recogida", tone: "info" as Tone,
    detail: a.etaTicks != null ? `Llegada estimada en ${duration(a.etaTicks, seconds)}` : "Después: recogida y traslado",
  };
  if (a.mission === "to_hospital") return {
    label: "En traslado", tone: "info" as Tone,
    detail: a.etaTicks != null ? `Llegada estimada en ${duration(a.etaTicks, seconds)} · después descarga` : "Después: llegada y descarga",
  };
  if (a.patientId) return { label: "Paciente a bordo", tone: "warning" as Tone, detail: "Pendiente de destino hospitalario" };
  if (a.mission === "reposition") return { label: "Reubicándose", tone: "info" as Tone, detail: "En camino a una nueva posición" };
  if (ambulanceAvailability(a, tick) === true) return { label: "Disponible", tone: "success" as Tone, detail: "Lista para una nueva misión" };
  return { label: "Sin misión", tone: "neutral" as Tone, detail: "Disponibilidad sin confirmar" };
}

export function buildSituation(record: TickRecord, meta: RunMeta, history: TickRecord[], graph: GraphData | null) {
  const { frame, tick } = record, seconds = meta.config.tickSeconds;
  // Only events known at the selected instant can enrich legacy snapshots.
  const events = history.filter((r) => r.tick <= tick).flatMap((r) => r.events).filter((e) => e.tick <= tick);
  const births = new Map<string, number>();
  const pickups = new Map<string, number>();
  const deliveries = new Map<string, string>();
  const repairs = new Map<string, number>();
  for (const event of events) {
    if (event.type === "patient_spawned") births.set(event.patientId, event.tick);
    if (event.type === "patient_picked_up") pickups.set(event.patientId, event.tick);
    if (event.type === "patient_delivered") deliveries.set(event.patientId, event.hospitalId);
    if (event.type === "ambulance_broken") repairs.set(event.ambulanceId, event.untilTick);
    if (event.type === "ambulance_repaired") repairs.delete(event.ambulanceId);
  }
  const units = [...frame.ambulances].sort(byId).map((frame) => {
    const a = { ...frame, brokenUntil: frame.brokenUntil ?? (frame.broken ? repairs.get(frame.id) : null) };
    return {
      ...a, ref: { kind: "ambulance", id: a.id } as EntityRef,
      available: ambulanceAvailability(a, tick), ...ambulanceActivity(a, tick, seconds),
    };
  });
  const cases = [...frame.patients].sort(byId).map((p) => {
    const active = p.status === "waiting" || p.status === "in_ambulance";
    const unit = active ? units.find((a) => a.patientId === p.id || a.targetPatientId === p.id) : undefined;
    const spawnTick = p.spawnTick ?? births.get(p.id);
    const pickupTick = p.pickupTick ?? pickups.get(p.id);
    const wait = spawnTick === undefined ? null : Math.max(0, (pickupTick ?? p.endTick ?? tick) - spawnTick);
    let label: string, tone: Tone;
    if (p.status === "delivered") { label = "Ingresado"; tone = "success"; }
    else if (p.status === "dead") { label = "Fallecido"; tone = "neutral"; }
    else if (unit?.broken || unit?.stranded) { label = "Bloqueado"; tone = "danger"; }
    else if (p.status === "waiting") { label = unit ? "En recogida" : "Sin asignar"; tone = unit ? "info" : "warning"; }
    else if (unit && (unit.busyUntil ?? tick) > tick) { label = "En recogida"; tone = "info"; }
    else if (unit?.mission === "to_hospital") { label = "En traslado"; tone = "info"; }
    else { label = "Pendiente de destino"; tone = "warning"; }
    return {
      ...p, ref: { kind: "patient", id: p.id } as EntityRef, active, unit, label, tone, wait, pickedUp: pickupTick != null,
      unassigned: p.status === "waiting" && !unit,
      hospitalId: unit?.hospitalId ?? deliveries.get(p.id) ?? null,
      detail: unit ? `${unit.id}${unit.hospitalId ? ` → ${unit.hospitalId}` : ""}${unit.broken ? " · averiada" : unit.stranded ? " · sin ruta" : ""}`
        : p.status === "waiting" ? "Todavía no tiene una unidad" : p.status === "delivered" ? "Atención completada" : p.status === "dead" ? "Caso cerrado" : "Sin destino registrado",
    };
  });
  const hospitals = [...meta.hospitals].sort(byId).map((h) => {
    const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
    // Count patients already on board with this destination, never a preassigned pickup.
    const incoming = units.filter((a) => a.mission === "to_hospital" && a.hospitalId === h.id && cases.some((p) => p.id === a.patientId && p.status === "in_ambulance"));
    return { ...h, ref: { kind: "hospital", id: h.id } as EntityRef, occupied, free: Math.max(0, h.capacity - occupied), incoming, margin: h.capacity - occupied - incoming.length };
  });
  const roads = [...frame.closedEdges].sort((a, b) => a - b).map((edge) => ({
    id: String(edge), edge, ref: { kind: "road", id: String(edge) } as EntityRef,
    name: graph?.edges[edge]?.name || `Tramo ${edge}`,
    units: units.filter((a) => a.route.some(([e]) => e === edge)),
  }));
  return { tick, seconds, units, cases, hospitals, roads,
    active: cases.filter((p) => p.active),
    unassigned: cases.filter((p) => p.unassigned).length,
    available: units.filter((a) => a.available === true).length,
    unknownAvailability: units.filter((a) => a.available === null).length,
    broken: units.filter((a) => a.broken).length,
    saved: frame.summary.saved, dead: frame.summary.dead,
  };
}
export type Situation = ReturnType<typeof buildSituation>;

export function relatedEntities(s: Situation, selection: EntityRef | null): Set<string> {
  const keys = new Set<string>();
  if (!selection) return keys;
  keys.add(entityKey(selection));
  const patients = s.cases.filter((p) =>
    selection.kind === "patient" ? p.id === selection.id :
    selection.kind === "ambulance" ? p.unit?.id === selection.id :
    selection.kind === "hospital" ? p.active && p.hospitalId === selection.id : false);
  const units = s.units.filter((a) =>
    (selection.kind === "ambulance" && a.id === selection.id) ||
    (selection.kind === "hospital" && a.hospitalId === selection.id) ||
    (selection.kind === "road" && a.route.some(([edge]) => String(edge) === selection.id)) ||
    patients.some((p) => p.unit?.id === a.id));
  for (const a of units) {
    keys.add(entityKey(a.ref));
    if (a.patientId || a.targetPatientId) keys.add(`patient:${a.patientId || a.targetPatientId}`);
    if (a.hospitalId) keys.add(`hospital:${a.hospitalId}`);
    for (const r of s.roads) if (r.units.some((unit) => unit.id === a.id)) keys.add(entityKey(r.ref));
  }
  for (const p of patients) {
    keys.add(entityKey(p.ref));
    if (p.hospitalId) keys.add(`hospital:${p.hospitalId}`);
  }
  return keys;
}

export function matchingEntities(s: Situation, filter: SituationFilter, query: string, showClosed: boolean): Set<string> {
  const text = query.trim().toLocaleLowerCase("es");
  const keys = new Set<string>();
  function add(ref: EntityRef, label: string, matches: boolean) {
    if (matches && `${ref.id} ${label}`.toLocaleLowerCase("es").includes(text)) keys.add(entityKey(ref));
  }
  for (const p of s.cases) add(p.ref, `${p.label} ${p.detail}`, (p.active || showClosed) && (filter === "all" || filter === "unassigned" && p.unassigned));
  for (const a of s.units) add(a.ref, `${a.label} ${a.patientId || a.targetPatientId || ""}`, filter === "all" || filter === "broken" && a.broken);
  for (const h of s.hospitals) add(h.ref, h.name, filter === "all" || filter === "full" && h.free === 0);
  for (const r of s.roads) add(r.ref, `${r.name} corte`, filter === "all");
  return keys;
}

export function entityExists(record: TickRecord | undefined, meta: RunMeta | null, ref: EntityRef) {
  if (!record) return false;
  if (ref.kind === "patient") return record.frame.patients.some((p) => p.id === ref.id);
  if (ref.kind === "ambulance") return record.frame.ambulances.some((a) => a.id === ref.id);
  if (ref.kind === "hospital") return !!meta?.hospitals.some((h) => h.id === ref.id);
  return record.frame.closedEdges.some((edge) => String(edge) === ref.id);
}

export function selectionPosition(s: Situation, graph: GraphData, ref: EntityRef): [number, number] | undefined {
  if (ref.kind === "ambulance") return s.units.find((a) => a.id === ref.id)?.pos;
  if (ref.kind === "patient") {
    const p = s.cases.find((p) => p.id === ref.id);
    if (!p) return undefined;
    if (p.status === "in_ambulance") return p.unit?.pos ?? graph.nodes[p.node];
    const h = p.status === "delivered" && s.hospitals.find((h) => h.id === p.hospitalId);
    return graph.nodes[h ? h.node : p.node];
  }
  if (ref.kind === "hospital") {
    const h = s.hospitals.find((h) => h.id === ref.id);
    return h && graph.nodes[h.node];
  }
  const geom = graph.edges[Number(ref.id)]?.geom;
  return geom?.[Math.floor(geom.length / 2)];
}

export const snapshotTime = (s: Situation) => `+${elapsed(s.tick, s.seconds)}`;
