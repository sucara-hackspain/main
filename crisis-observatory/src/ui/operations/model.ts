import { attention, type GraphData, type LonLat, type TickRecord } from "../engineTrace";
import type { Situation } from "../situation/model";
import type { Ticket } from "../tickets/model";

export type Queue = "all" | "critical" | "waiting" | "blocked" | "unconfirmed";
export const queueLabels: Record<Queue, string> = {
  all: "Todas las incidencias", critical: "Urgentes sin atención", waiting: "Sin atención efectiva",
  blocked: "Acceso comprometido", unconfirmed: "Pendientes de confirmar",
};
export type Sector = {
  id: string; name: string; bounds: [LonLat, LonLat] | null; center: LonLat | null;
  tickets: Ticket[]; open: number; critical: number; waiting: number; blocked: number;
  unconfirmed: number; calls: number; available: number; units: number;
  delta: number | null; gaps: number; stale: number;
};

/** Stable geographic bins are navigation scopes, never inferred incident merges. */
export function sectorDefinitions(graph: GraphData): Sector[] {
  const [s, w, n, e] = graph.bbox;
  return ["Noroeste", "Norte", "Noreste", "Suroeste", "Sur", "Sureste", "Fuera del ámbito", "Sin ubicación"].map((name, i) => {
    const x = i % 3, y = i < 3 ? 1 : 0;
    const bounds: [LonLat, LonLat] | null = i >= 6 ? null : [
      [w + (e - w) * x / 3, s + (n - s) * y / 2],
      [w + (e - w) * (x + 1) / 3, s + (n - s) * (y + 1) / 2],
    ];
    return { id: `sector-${i + 1}`, name, bounds,
      center: bounds ? [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2] : null,
      tickets: [], open: 0, critical: 0, waiting: 0, blocked: 0, unconfirmed: 0,
      calls: 0, available: 0, units: 0, delta: null, gaps: 0, stale: 0 };
  });
}
export function sectorIndex(pos: LonLat | undefined, graph: GraphData): number {
  const [s, w, n, e] = graph.bbox;
  if (!pos || !pos.every(Number.isFinite)) return 7;
  if (pos[0] < w || pos[0] > e || pos[1] < s || pos[1] > n) return 6;
  const x = Math.min(2, Math.floor((pos[0] - w) / Math.max(e - w, 1e-9) * 3));
  return (pos[1] >= (s + n) / 2 ? 0 : 3) + x;
}
export function inQueue(ticket: Ticket, queue: Queue) {
  const i = ticket.incident;
  if (queue === "all") return true;
  if (i.status !== "open") return false;
  const waiting = attention(i, ticket.crews.filter((u) => !u.broken && !u.stranded)) === "waiting";
  if (queue === "critical") return i.priority <= 1 && waiting;
  if (queue === "waiting") return waiting;
  if (queue === "blocked") return i.unreachable || i.cutOffIn === 0 || ticket.crews.some((u) => u.stranded || u.broken);
  return !i.located;
}

export function buildOperations(tickets: Ticket[], record: TickRecord, history: TickRecord[], graph: GraphData, situation: Situation) {
  const sectors = sectorDefinitions(graph);
  const currentTick = record.tick;
  const windowTicks = Math.max(1, Math.ceil(15 * 60 / situation.seconds));
  const past = history.filter((r) => r.tick <= currentTick);
  const baseline = [...past].reverse().find((r) => r.tick <= currentTick - windowTicks) ?? past[0];
  const prior = sectors.map(() => 0);
  if (baseline && baseline.tick < currentTick) {
    for (const i of baseline.frame.incidents) if (i.status === "open") prior[sectorIndex(graph.nodes[i.node], graph)]++;
  }
  for (const t of tickets) {
    const sector = sectors[sectorIndex(graph.nodes[t.incident.node], graph)];
    sector.tickets.push(t);
    if (t.incident.status !== "open") continue;
    sector.open++;
    sector.calls += t.incident.callIds.length;
    if (inQueue(t, "critical")) sector.critical++;
    if (inQueue(t, "waiting")) sector.waiting++;
    if (inQueue(t, "blocked")) sector.blocked++;
    if (inQueue(t, "unconfirmed")) sector.unconfirmed++;
  }
  for (const u of situation.units) {
    const sector = sectors[sectorIndex(u.pos, graph)];
    sector.units++;
    if (u.available) sector.available++;
  }
  for (const gap of record.frame.recon?.gaps ?? []) sectors[sectorIndex(graph.nodes[gap.node], graph)].gaps++;
  for (const zone of record.frame.knownWater.zones) {
    if (zone.ageTicks * situation.seconds >= 600) sectors[sectorIndex(graph.nodes[zone.node], graph)].stale++;
  }
  sectors.forEach((sector, i) => { sector.delta = baseline && baseline.tick < currentTick ? sector.open - prior[i] : null; });
  const calls = new Set<string>();
  let radio = 0, lastCall: number | null = null, lastRadio: number | null = null;
  const radioTypes = new Set(["scene_assessed", "scene_not_found", "road_blocked_found", "unit_stranded", "hospital_full", "drone_report"]);
  for (const r of past) {
    for (const c of r.calls) if (c.tick <= currentTick) { calls.add(c.id); lastCall = Math.max(lastCall ?? 0, c.tick); }
    for (const e of r.events) {
      if (e.tick > currentTick) continue;
      if (e.type === "call_received") { calls.add(e.call.id); lastCall = Math.max(lastCall ?? 0, e.tick); }
      if (radioTypes.has(e.type)) { radio++; lastRadio = Math.max(lastRadio ?? 0, e.tick); }
    }
  }
  const trend = past.slice(-24).map((r) => ({ tick: r.tick, open: r.frame.incidents.filter((i) => i.status === "open").length }));
  return {
    sectors: sectors.filter((s, i) => i < 6 || s.tickets.length || s.units || s.gaps || s.stale),
    calls: calls.size, radio, lastCall, lastRadio, trend,
    windowMinutes: baseline ? Math.round((currentTick - baseline.tick) * situation.seconds / 60) : 0,
    open: sectors.reduce((n, s) => n + s.open, 0), critical: sectors.reduce((n, s) => n + s.critical, 0),
    waiting: sectors.reduce((n, s) => n + s.waiting, 0), blocked: sectors.reduce((n, s) => n + s.blocked, 0),
    unconfirmed: sectors.reduce((n, s) => n + s.unconfirmed, 0),
  };
}
export type Operations = ReturnType<typeof buildOperations>;
export const number = (n: number) => new Intl.NumberFormat("es-ES", { useGrouping: true }).format(n);
