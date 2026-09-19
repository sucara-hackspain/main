import {
  attention, elapsed, isFree, priority, sceneLabel, unitKind, UNIT_KINDS,
  type GraphData, type IncidentFrame, type RunMeta, type Selection, type TickRecord, type UnitFrame,
} from "../engineTrace";

export type SituationFilter = "all" | "unattended" | "isolated" | "broken" | "full";
export type Tone = "neutral" | "info" | "warning" | "danger" | "success";
export const entityKey = (ref: Selection) => `${ref.kind}:${ref.id}`;
export const sameEntity = (a: Selection | null, b: Selection) => !!a && entityKey(a) === entityKey(b);
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, "es", { numeric: true });
const kinds = Object.keys(unitKind);
export const duration = (ticks: number, seconds: number) => {
  const total = Math.max(0, Math.ceil(ticks * seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60), rest = total % 60;
  return `${minutes} min${rest ? ` ${rest} s` : ""}`;
};

/** Work that keeps a crew on the spot. The frame carries no deadline: it follows from what the crew did. */
export type Busy = { until: number; task: "pickup" | "treat" | "dropoff" };

/** Deadlines known at `tick`, rebuilt from the engine's rules: freeing someone, picking up or treating on scene, unloading at hospital, repairs. */
export function unitDeadlines(history: TickRecord[], tick: number, config: RunMeta["config"]) {
  const busy = new Map<string, Busy>(), repairs = new Map<string, number>();
  for (const record of history) {
    if (record.tick > tick) continue;
    const onScene = new Map<string, { freed: number; picked: boolean; treated: number }>();
    for (const e of record.events) {
      if (e.tick > tick) continue;
      if (e.type === "unit_broken") repairs.set(e.unitId, e.untilTick);
      if (e.type === "unit_repaired") repairs.delete(e.unitId);
      if (e.type === "victim_delivered") busy.set(e.unitId, { until: e.tick + config.dropoffTicks, task: "dropoff" });
      if (e.type === "victim_freed" || e.type === "victim_picked_up" || e.type === "victim_treated") {
        const work = onScene.get(e.unitId) ?? { freed: 0, picked: false, treated: 0 };
        if (e.type === "victim_freed") work.freed++;
        else if (e.type === "victim_picked_up") work.picked = true;
        else work.treated++;
        onScene.set(e.unitId, work);
      }
    }
    for (const [unitId, w] of onScene) busy.set(unitId, {
      until: record.tick + w.freed * config.extricateTicks + (w.picked ? config.pickupTicks : w.treated * config.treatTicks),
      task: w.picked ? "pickup" : "treat",
    });
  }
  return { busy, repairs };
}

export function unitActivity(u: UnitFrame, tick: number, seconds: number, busy?: Busy, repairAt?: number) {
  const left = busy && busy.until > tick ? busy.until - tick : 0;
  if (u.broken) return {
    label: "Averiada", tone: "danger" as Tone,
    detail: repairAt !== undefined ? `Reparación prevista en ${duration(repairAt - tick, seconds)}` : "Sin plazo de reparación registrado",
  };
  if (u.stranded) return {
    label: "Sin ruta conocida", tone: "danger" as Tone,
    detail: u.victimId ? `Detenida con ${u.victimId} a bordo` : u.incidentId ? `Ningún camino conocido llega a ${u.incidentId}` : "Destino inaccesible",
  };
  if (left && busy?.task === "dropoff") return { label: "Descargando", tone: "info" as Tone, detail: `La descarga termina en ${duration(left, seconds)}` };
  if (left && busy?.task === "pickup") return {
    label: "Recogiendo", tone: "info" as Tone,
    detail: `${u.victimId ?? "La víctima"} a bordo en ${duration(left, seconds)}${u.hospitalId ? ` · después, traslado a ${u.hospitalId}` : " · sin hospital asignado"}`,
  };
  if (left) return { label: "Atendiendo en el lugar", tone: "info" as Tone, detail: `Termina en ${duration(left, seconds)}` };
  if (u.mission === "to_scene") return {
    label: `Hacia ${u.incidentId ?? "su destino"}`, tone: "info" as Tone,
    detail: u.hospitalId ? `Después: traslado a ${u.hospitalId}` : "Después: valoración en el lugar",
  };
  if (u.mission === "to_hospital") return { label: `Traslado a ${u.hospitalId}`, tone: "info" as Tone, detail: `${u.victimId} a bordo` };
  if (u.victimId) return { label: "Víctima a bordo", tone: "warning" as Tone, detail: `${u.victimId} pendiente de hospital` };
  if (u.mission === "reposition") return { label: "Reubicándose", tone: "info" as Tone, detail: "En camino a una nueva posición" };
  if (u.mission === "to_observe") return {
    label: "Reconociendo", tone: "info" as Tone,
    detail: `Va a mirar ${u.incidentId ?? "una zona de la que no sabes nada"}: volverá con un informe, no con una confirmación`,
  };
  return { label: "Disponible", tone: "success" as Tone, detail: "Lista para una nueva misión" };
}

/** No known road gets there, or the water forecast already cuts it off: only boats and the helicopter reach it. */
export const isolated = (i: IncidentFrame) => i.unreachable || i.cutOffIn === 0;
const reachesWater = (u: UnitFrame) => UNIT_KINDS[u.kind].wades || UNIT_KINDS[u.kind].flies;

function incidentState(i: IncidentFrame, crews: UnitFrame[], seconds: number): { label: string; tone: Tone } {
  if (i.status === "closed") return i.closedReason === "not_found" ? { label: "Nadie en el lugar", tone: "neutral" }
    : i.closedReason === "merged" ? { label: `Unido a ${i.mergedInto}`, tone: "neutral" } : { label: "Resuelto", tone: "success" };
  const urgent: Tone = i.priority === 0 ? "danger" : "warning";
  if (isolated(i) && !crews.some(reachesWater)) return { label: i.unreachable ? "Sin acceso por carretera" : "Aislado por el agua", tone: "danger" };
  if (crews.length) return crews.some((u) => u.mission === "to_scene") ? { label: "Unidad en camino", tone: "info" } : { label: "En atención", tone: "info" };
  if (i.cutOffIn !== null) return { label: `El agua lo aísla en ${duration(i.cutOffIn, seconds)}`, tone: i.priority <= 1 ? "danger" : "warning" };
  return { label: "Sin unidad", tone: urgent };
}

export function buildSituation(record: TickRecord, meta: RunMeta, history: TickRecord[], graph: GraphData | null) {
  const { frame, tick } = record, seconds = meta.config.tickSeconds;
  // Only what is known at the selected instant: later events never leak into the past.
  const { busy, repairs } = unitDeadlines(history, tick, meta.config);
  const units = [...frame.units].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || byId(a, b)).map((u) => ({
    ...u, ref: { kind: "unit", id: u.id } as Selection, kindLabel: unitKind[u.kind].label,
    available: isFree(u) && !((busy.get(u.id)?.until ?? 0) > tick),
    ...unitActivity(u, tick, seconds, busy.get(u.id), u.broken ? repairs.get(u.id) : undefined),
  }));
  const incidents = [...frame.incidents].sort((a, b) =>
    Number(b.status === "open") - Number(a.status === "open") || a.priority - b.priority || byId(a, b)).map((i) => {
    const open = i.status === "open";
    const crews = open ? units.filter((u) => u.incidentId === i.id) : [];
    const state = incidentState(i, crews, seconds);
    return {
      ...i, ref: { kind: "incident", id: i.id } as Selection, open, crews, ...state, attention: attention(i, crews),
      unattended: open && crews.length === 0, isolated: open && isolated(i),
      wait: open ? tick - i.openedTick : null,
      detail: [
        i.mechanism ? sceneLabel(i.mechanism.value) : "Qué ha pasado: sin confirmar",
        crews.length ? crews.map((u) => u.id).join(", ") : null,
        i.located ? "ubicación confirmada" : `±${i.locationErrorM} m`,
        `${i.callIds.length} ${i.callIds.length === 1 ? "llamada" : "llamadas"}`,
      ].filter(Boolean).join(" · "),
    };
  });
  const hospitals = [...meta.hospitals].sort(byId).map((h) => {
    const occupied = frame.hospitals.find((x) => x.id === h.id)?.occupied ?? 0;
    // Victims already on board with this destination, stopped transfers included; never a hospital picked before the pickup.
    const incoming = units.filter((u) => u.victimId && u.hospitalId === h.id);
    return { ...h, ref: { kind: "hospital", id: h.id } as Selection, occupied, free: Math.max(0, h.capacity - occupied), incoming, margin: h.capacity - occupied - incoming.length };
  });
  const known = new Set(frame.knownClosedEdges);
  const water = {
    zones: [...frame.knownWater.zones].sort(byId),
    sightings: frame.knownWater.sightings.length,
    blocked: frame.knownWater.sightings.filter((w) => w.kind === "blocked").length,
    closed: frame.knownClosedEdges.length,
    streets: new Set(frame.knownClosedEdges.map((e) => graph?.edges[e]?.name).filter(Boolean)).size,
    // Truth, for the supervisor: what is really closed and nobody has reported.
    real: frame.closedEdges.length,
    unreported: frame.closedEdges.filter((e) => !known.has(e)).length,
  };
  const open = incidents.filter((i) => i.open);
  return { tick, seconds, units, incidents, hospitals, water, sites: frame.sites ?? [], gauges: frame.gauges ?? [], scenes: frame.scenes, open,
    unattended: open.filter((i) => i.unattended).length,
    isolated: open.filter((i) => i.isolated).length,
    available: units.filter((u) => u.available).length,
    broken: units.filter((u) => u.broken).length,
    saved: frame.summary.saved, dead: frame.summary.dead, inWater: frame.summary.inWater,
  };
}
export type Situation = ReturnType<typeof buildSituation>;
export type SituationIncident = Situation["incidents"][number];

export function relatedEntities(s: Situation, selection: Selection | null): Set<string> {
  const keys = new Set<string>();
  if (!selection) return keys;
  keys.add(entityKey(selection));
  const incidents = s.incidents.filter((i) =>
    selection.kind === "incident" ? i.id === selection.id :
    selection.kind === "unit" ? i.crews.some((u) => u.id === selection.id) :
    selection.kind === "scene" ? i.sceneId === selection.id :
    i.crews.some((u) => u.victimId && u.hospitalId === selection.id));
  const units = s.units.filter((u) =>
    (selection.kind === "unit" && u.id === selection.id) ||
    (selection.kind === "hospital" && u.victimId && u.hospitalId === selection.id) ||
    incidents.some((i) => i.crews.some((crew) => crew.id === u.id)));
  for (const u of units) {
    keys.add(entityKey(u.ref));
    if (u.incidentId) keys.add(`incident:${u.incidentId}`);
    if (u.hospitalId) keys.add(`hospital:${u.hospitalId}`);
  }
  for (const i of incidents) {
    keys.add(entityKey(i.ref));
    if (i.sceneId) keys.add(`scene:${i.sceneId}`);
  }
  return keys;
}

export function matchingEntities(s: Situation, filter: SituationFilter, query: string, showClosed: boolean): Set<string> {
  const text = query.trim().toLocaleLowerCase("es");
  const keys = new Set<string>();
  function add(ref: Selection, label: string, matches: boolean) {
    if (matches && `${ref.id} ${label}`.toLocaleLowerCase("es").includes(text)) keys.add(entityKey(ref));
  }
  for (const i of s.incidents) add(i.ref, `P${i.priority} ${priority[i.priority].label} ${i.label} ${i.detail}`,
    (i.open || showClosed) && (filter === "all" || filter === "unattended" && i.unattended || filter === "isolated" && i.isolated));
  for (const u of s.units) add(u.ref, `${u.kindLabel} ${u.label} ${u.detail}`, filter === "all" || filter === "broken" && u.broken);
  for (const h of s.hospitals) add(h.ref, h.name, filter === "all" || filter === "full" && h.free === 0);
  return keys;
}

export const snapshotTime = (s: Situation) => `+${elapsed(s.tick, s.seconds)}`;
