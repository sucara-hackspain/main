// Escribe la partida en el formato del Control Center (crisis-observatory): runs/<id>/meta.json + ticks.jsonl, un registro por turno.
// La UI sirve backend/runs y backend/data/valencia-ui.json y sigue la partida en vivo.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isPunctured } from "./entities/ambulance.js";
import type { Injured, InjuredId } from "./entities/injured.js";
import { blockedEdges } from "./entities/street-cut.js";
import { edgeKey, type NodeId } from "./map/graph.js";
import type { RoadMap } from "./map/road-map.js";
import { HOSPITAL_ID, UI_MAP_NAME, uiGraph } from "./map/ui-graph.js";
import type { Call, Incident, Priority } from "./triage.js";
import { findInjured, type SimEvent, type World } from "./world.js";

const RECENT_TICKS = 20; // los incidentes cerrados siguen en el registro este tiempo, como hace la UI
const PRIORITY: Record<Priority, 0 | 1 | 2 | 3> = { critical: 0, high: 1, medium: 2, low: 3 };
const SCENE_KINDS = ["vehicle_trapped", "flooded_home", "swept_away", "building_collapse", "collapse", "fall", "traffic"];
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** Entrada del expediente de un incidente (CaseEntry de la UI). */
export type CaseEntry = { tick: number; kind: "call" | "update" | "radio" | "order"; text: string; from: string; flag?: "alert"; callId?: string; unitId?: string; action?: object; accepted?: boolean; etaTicks?: number; decidedBy?: "rules" };
/** Incidente tal como lo pinta la UI. Solo los campos que el registro necesita; el resto es JSON opaco. */
export type UiIncident = { id: string; status: "open" | "closed"; callIds: InjuredId[]; updatedTick: number; timeline: CaseEntry[] } & Record<string, unknown>;
/** Lo que el grabador recuerda entre turnos (vive en state.json). */
export type RecorderState = { prevIncidents: UiIncident[]; closed: UiIncident[]; timeline: Record<string, CaseEntry[]> };
export const emptyRecorderState = (): RecorderState => ({ prevIncidents: [], closed: [], timeline: {} });

let root = "."; // carpeta con runs/ y data/; los tests la cambian
export const setRecorderRoot = (dir: string) => void (root = dir);
const runDir = (w: World) => `${root}/runs/${w.runId}`;

/** Al crear la partida: exporta el mapa en el formato de la UI y abre runs/<id>/. */
export function startRun(w: World, map: RoadMap) {
  const startedAt = new Date().toISOString();
  w.startedAt = startedAt;
  w.runId = `${startedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "")}-dana-112`;
  w.ui = emptyRecorderState();
  mkdirSync(`${root}/data`, { recursive: true });
  writeFileSync(`${root}/data/${UI_MAP_NAME}.json`, JSON.stringify(uiGraph(map, w.base.position).data));
  mkdirSync(runDir(w), { recursive: true });
  writeFileSync(`${runDir(w)}/ticks.jsonl`, "");
  writeMeta(w, map);
}

function writeMeta(w: World, map: RoadMap) {
  const { nodeIndex } = uiGraph(map, w.base.position);
  const meta = {
    id: w.runId, map: UI_MAP_NAME, seed: 0, ticks: w.turn + 1, coordinator: "greedy + agentes 112", model: null,
    config: { tickSeconds: 60, ambulances: w.ambulances.length, fireUnits: 0, rescueUnits: 0, helicopters: 0, drones: 0, hospitals: 1, hospitalCapacity: 9999, ambulanceSpeedFactor: 1, pickupTicks: 0, dropoffTicks: 0, treatTicks: 0, extricateTicks: 0, searchRadiusM: 0, scoutRadiusM: 0, scoutTicks: 0 },
    hospitals: [{ id: HOSPITAL_ID, name: "Hospital La Fe", node: nodeIndex.get(w.base.position), capacity: 9999, helipad: false }],
    startedAt: w.startedAt, status: "running", summary: summary(w),
  };
  writeFileSync(`${runDir(w)}/meta.json`, JSON.stringify(meta, null, 2));
}

function summary(w: World) {
  const { rescued: saved, dead } = w.stats;
  const rate = saved + dead ? saved / (saved + dead) : 1;
  return { ticks: w.turn, victims: saved + dead + w.injured.length, saved, dead, waiting: w.injured.length, inAmbulance: 0, survivalRate: rate, inWater: 0, reachableSurvivalRate: rate, meanResponseTicks: 0 };
}

/** Un turno → un registro. Vacía `w.events` siempre; escribe solo si la partida se creó con `init` (tiene runId). */
export function record(w: World, map: RoadMap) {
  const events = w.events.splice(0);
  if (!w.runId) return;
  w.ui ??= emptyRecorderState();
  const tick = w.turn;
  const { data, nodeIndex, edgeIndex } = uiGraph(map, w.base.position);
  const idx = (n: NodeId) => nodeIndex.get(n) ?? 0;
  const edge = (u: NodeId, v: NodeId) => edgeIndex.get(edgeKey(u, v)) ?? 0;
  const live = (i: Incident) => i.callIds.map((id) => findInjured(w, id)).filter((h): h is Injured => !!h);
  const incidentOf = (id: InjuredId) => w.incidents.find((i) => i.callIds.includes(id))?.id ?? w.ui.closed.find((i) => i.callIds.includes(id))?.id ?? `P-${id}`;
  /** El incidente cerrado de un seguimiento: si la UI ya lo olvidó, vuelve con su id de entonces para mostrar el resultado. */
  const revive = (injuredId: InjuredId) => {
    const f = w.followups.find((x) => x.id === injuredId);
    const id = incidentOf(injuredId);
    if (!id.startsWith("P-") || !f) return id;
    const back: UiIncident = { ...incidentFrame(w, map, idx, tick, null, [], f.incidentId ?? id, f.call), status: "closed", closedReason: "resolved", priority: PRIORITY[f.priority], updatedTick: tick };
    back.line = String(back.line).replace(/· P\d/, `· P${back.priority}`);
    w.ui.closed.push(back);
    return back.id;
  };
  const uiCall = (c: Call) => ({
    id: c.id, tick: c.tick, caller: oneOf(c.caller, ["victim", "family", "bystander", "driver"], "bystander"), mechanism: oneOf(c.mechanism, SCENE_KINDS, "") || null,
    node: idx(c.node), locationErrorM: c.locationErrorM, street: c.street, conscious: oneOf(c.conscious, ["yes", "no", "unknown"], "unknown"),
    breathing: oneOf(c.breathing, ["normal", "difficult", "none", "unknown"], "unknown"), bleeding: oneOf(c.bleeding, ["yes", "no", "unknown"], "unknown"),
    trapped: oneOf(c.trapped, ["yes", "no", "unknown"], "unknown"), ageGroup: oneOf(c.ageGroup, ["child", "adult", "elderly", "unknown"], "unknown"), victims: c.victims, text: c.text,
  });

  // Eventos del turno → eventos de la UI, llamadas, órdenes y expediente de cada incidente.
  const uiEvents: object[] = [], calls: object[] = [], actions: object[] = [];
  const note = (incidentId: string, entry: Omit<CaseEntry, "tick">, t: number) => (w.ui.timeline[incidentId] ??= []).push({ tick: t, ...entry });
  for (const e of events) {
    const t = e.tick;
    if (e.type === "call") {
      const call = uiCall(e.call);
      calls.push(call);
      uiEvents.push({ type: "call_received", tick: t, call }, { type: "scene_created", tick: t, sceneId: `S-${e.injuredId}`, kind: call.mechanism ?? "collapse", node: call.node, victims: 1 });
      note(incidentOf(e.injuredId), { kind: "call", text: e.call.text, from: e.call.id, callId: e.call.id }, t);
    } else if (e.type === "triaged") {
      note(e.incidentId, { kind: "update", text: `${e.isNew ? "Incidente nuevo" : "Se une al incidente"} [${e.priority}]: ${e.reasoning}`, from: "112-triage" }, t);
    } else if (e.type === "dispatch") {
      const incidentId = incidentOf(e.injuredId);
      const action = { type: "dispatch", unitId: e.unitId, incidentId, node: idx(findInjured(w, e.injuredId)?.position ?? w.base.position) };
      actions.push(action);
      uiEvents.push({ type: "action_applied", tick: t, action, etaTicks: e.eta });
      note(incidentId, { kind: "order", text: `${e.unitId} → ${e.injuredId} (eta ${e.eta} turnos)`, from: "reglas", unitId: e.unitId, action, accepted: true, etaTicks: e.eta, decidedBy: "rules" }, t);
    } else if (e.type === "rescued") {
      const incidentId = incidentOf(e.injuredId);
      uiEvents.push({ type: "victim_picked_up", tick: t, victimId: e.injuredId, unitId: e.unitId, incidentId }, { type: "victim_delivered", tick: t, victimId: e.injuredId, unitId: e.unitId, hospitalId: HOSPITAL_ID });
      note(incidentId, { kind: "radio", text: `${e.unitId} rescata a ${e.injuredId}`, from: `radio ${e.unitId}`, unitId: e.unitId }, t);
    } else if (e.type === "died") {
      uiEvents.push({ type: "victim_died", tick: t, victimId: e.injuredId, where: "street" });
      note(incidentOf(e.injuredId), { kind: "update", flag: "alert", text: `${e.injuredId} ha muerto antes de que llegara nadie`, from: "sistema" }, t);
    } else if (e.type === "cut") {
      for (const [u, v] of e.edges) uiEvents.push({ type: "road_closed", tick: t, edge: edge(u, v), name: e.street });
    } else if (e.type === "punctured") {
      uiEvents.push({ type: "unit_broken", tick: t, unitId: e.unitId, untilTick: t + e.turns });
    } else if (e.type === "repaired") {
      uiEvents.push({ type: "unit_repaired", tick: t, unitId: e.unitId });
    } else if (e.type === "followup") {
      const id = revive(e.injuredId);
      note(id, { kind: "radio", text: e.text, from: "seguimiento 112" }, t);
      for (const c of w.ui.closed) if (c.id === id) (c.updatedTick = tick), (c.timeline = w.ui.timeline[id] ?? []); // sigue visible otros RECENT_TICKS
    }
  }

  // Incidentes abiertos: el tablón del triaje (con heridos vivos) más uno provisional por herido aún sin triar.
  const open: UiIncident[] = [
    ...w.incidents.filter((i) => live(i).length).map((i) => incidentFrame(w, map, idx, tick, i, live(i), i.id)),
    ...w.injured.filter((h) => !w.incidents.some((i) => i.callIds.includes(h.id))).map((h) => incidentFrame(w, map, idx, tick, null, [h], `P-${h.id}`)),
  ];
  // Los que estaban y ya no: resueltos, o fundidos en otro (el expediente pasa con ellos). Se conservan RECENT_TICKS turnos.
  const openIds = new Set(open.map((i) => i.id));
  const closedNow = w.ui.prevIncidents.filter((p) => !openIds.has(p.id)).map((p) => {
    const into = open.find((o) => p.callIds.some((c) => o.callIds.includes(c)));
    if (into) {
      w.ui.timeline[into.id] = [...(w.ui.timeline[p.id] ?? []), ...(w.ui.timeline[into.id] ?? [])].sort((a, b) => a.tick - b.tick);
      into.timeline = w.ui.timeline[into.id];
      delete w.ui.timeline[p.id];
    }
    return { ...p, status: "closed" as const, closedReason: into ? "merged" : "resolved", mergedInto: into?.id ?? null, updatedTick: tick, timeline: into ? [] : w.ui.timeline[p.id] ?? [] };
  });
  // Un caso cerrado sigue en el registro mientras tenga un seguimiento por hacer, y RECENT_TICKS turnos tras su último cambio.
  const awaitingFollowup = (c: UiIncident) => w.followups.some((f) => f.status !== "done" && c.callIds.includes(f.id));
  w.ui.closed = [...w.ui.closed, ...closedNow].filter((c) => awaitingFollowup(c) || tick - c.updatedTick <= RECENT_TICKS);
  w.ui.prevIncidents = open;

  const blocked = blockedEdges(w.cuts);
  const closedEdges = w.cuts.map((c) => edge(c.u, c.v));
  const frame = {
    units: w.ambulances.map((a) => {
      const target = a.target ? findInjured(w, a.target) : undefined;
      const path = target ? map.shortestPath(a.position, target.position, blocked) : null;
      const [lat, lon] = map.coords(a.position);
      const route: [number, 0 | 1][] = [];
      for (let i = 1; path && i < path.length; i++) route.push([edge(path[i - 1], path[i]), data.edges[edge(path[i - 1], path[i])].a === idx(path[i - 1]) ? 1 : 0]);
      return { id: a.id, kind: "ambulance", pos: [lon, lat], mission: target ? "to_scene" : "idle", incidentId: target ? incidentOf(target.id) : null, victimId: null, hospitalId: null, broken: isPunctured(a), stranded: !!target && !path, route };
    }),
    scenes: w.injured.map((h) => ({
      id: `S-${h.id}`, kind: oneOf(h.call?.mechanism, SCENE_KINDS, "collapse"), node: idx(h.position), resolved: false,
      victims: [{ id: h.id, injury: h.ttl <= 5 ? "cardiac_arrest" : h.ttl <= 8 ? "hemorrhage" : h.ttl <= 14 ? "polytrauma" : "fracture", age: h.call?.ageGroup === "child" ? 8 : h.call?.ageGroup === "elderly" ? 78 : 40, trapped: h.call?.trapped === "yes", inWater: false, status: "waiting", ttl: h.ttl, triage: h.ttl <= 5 ? "red" : h.ttl <= 10 ? "yellow" : "green", endTick: null }],
    })),
    incidents: [...open, ...w.ui.closed],
    floods: [], knownWater: { zones: [], sightings: [] }, knownClosedEdges: closedEdges, recon: { scouts: [], gaps: [] },
    hospitals: [{ id: HOSPITAL_ID, occupied: w.stats.rescued }], closedEdges, summary: summary(w),
  };
  appendFileSync(`${runDir(w)}/ticks.jsonl`, JSON.stringify({ tick, frame, events: uiEvents, calls, actions }) + "\n");
  writeMeta(w, map);
}

/** Un seguimiento cambia la prioridad del caso: en el tablón si sigue abierto, y en el incidente ya cerrado que la UI aún muestra. */
export function reprioritize(w: World, injuredId: InjuredId, priority: Priority) {
  for (const i of w.incidents) if (i.callIds.includes(injuredId)) i.priority = priority;
  for (const i of [...w.ui.closed, ...w.ui.prevIncidents]) if (i.callIds.includes(injuredId)) (i.priority = PRIORITY[priority]), (i.line = String(i.line).replace(/· P\d/, `· P${PRIORITY[priority]}`));
}

function incidentFrame(w: World, map: RoadMap, idx: (n: NodeId) => number, tick: number, i: Incident | null, heridos: Injured[], id: string, known?: Call): UiIncident {
  const first = heridos[0];
  const call = first?.call ?? known;
  const from = i?.callIds.at(-1) ?? first?.id ?? id;
  const src = <T>(v: unknown, ok: (x: unknown) => boolean) => (ok(v) ? { value: v as T, from, tick: Number(i?.lastTick ?? tick) } : null);
  const yesNo = (v: unknown) => v === "yes" || v === "no";
  const signs = {
    mechanism: src(i?.mechanism ?? call?.mechanism, (v) => SCENE_KINDS.includes(v as string)),
    conscious: src(i?.conscious ?? call?.conscious, yesNo),
    breathing: src(i?.breathing ?? call?.breathing, (v) => ["normal", "difficult", "none"].includes(v as string)),
    bleeding: src(i?.bleeding ?? call?.bleeding, yesNo),
    trapped: src(i?.trapped ?? call?.trapped, yesNo),
    ageGroup: src(i?.ageGroup ?? call?.ageGroup, (v) => ["child", "adult", "elderly"].includes(v as string)),
    victimsReported: src(i?.victims ?? call?.victims, (v) => typeof v === "number"),
  };
  const priority = PRIORITY[i?.priority ?? "medium"];
  const node = first ? idx(first.position) : idx(Number(i?.node ?? call?.node));
  const locationErrorM = Number(i?.locationErrorM ?? call?.locationErrorM ?? 100);
  const street = (i?.street as string | null) ?? call?.street ?? (first ? map.streetOf(first.position) : null);
  const text = (i?.text as string) ?? call?.text ?? "";
  const callIds = i?.callIds ?? (heridos.length ? heridos.map((h) => h.id) : call ? [call.id] : []);
  const openedTick = Number(i?.firstTick ?? call?.tick ?? tick);
  const focus = { id: `${id}.1`, status: "reported", openedTick, node, locationErrorM, sceneId: null, callIds, victims: [], lastReport: null, seenTick: null, seenBy: null, peopleSeen: null, ...signs };
  return {
    id, status: "open", closedReason: null, mergedInto: null, splitFrom: null, emergencyId: null, openedTick, updatedTick: Number(i?.lastTick ?? tick),
    node, locationErrorM, located: false, seenTick: null, seenBy: null, sceneId: null, callIds, foci: [focus], victims: [], priority, unreachable: false, history: [],
    timeline: w.ui.timeline[id] ?? [], ...signs, line: `${id} · P${priority} · ${street ?? "sin calle"} · ${text}`.slice(0, 160), cutOffIn: null,
  };
}
