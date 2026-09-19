import type { DecideInput } from "./coordinator";
import { clock, describe } from "./describe";
import { closuresFor, effectiveNode, remainingTicks, UNIT_KINDS } from "./engine";
import { incidentLine, resolve, unitsNeeded } from "./incidents";
import { believedWater, cutOffForecast, projectedRadius } from "./water";

export interface Briefing {
  /** Situation report for an LLM coordinator. It cannot run Dijkstra, so every ETA it may need is precomputed here. */
  text: string;
  /** False when there is no decision to take, so the LLM call can be skipped. */
  actionable: boolean;
}

const WAKE_ALWAYS = new Set(["unit_broken", "unit_stranded", "action_rejected", "hospital_full"]);
/** Incidents shown in full; the rest are only counted. */
const TOP_INCIDENTS = 12;

export function buildBriefing({ tick, reports, belief, graph, config }: DecideInput): Briefing {
  const closed = new Set(belief.closedEdges);
  const toTicks = (seconds: number) => Math.ceil(seconds / config.ambulanceSpeedFactor / config.tickSeconds);
  const lines: string[] = [];

  lines.push(`HORA ${clock(tick, config.tickSeconds)} (tick ${tick}). 1 tick = ${config.tickSeconds} s.`, "");
  lines.push("NOVEDADES:");
  for (const r of reports) lines.push(`- [${r.source}] ${describe(r.event)}`);

  const inbound = new Map<string, number>();
  for (const a of belief.units) if (a.hospitalId) inbound.set(a.hospitalId, (inbound.get(a.hospitalId) ?? 0) + 1);
  const bedsFree = (id: string) => {
    const h = belief.hospitals.find((x) => x.id === id)!;
    return h.capacity - h.occupied - (inbound.get(id) ?? 0);
  };

  lines.push("", "UNIDADES (ambulancia: lleva 1 herido por carretera · bomberos: liberan atrapados, no trasladan · rescate acuático: lento, cruza calles inundadas, libera y traslada · helicóptero: rápido, ignora calles y agua, solo entrega en hospital con helipuerto):");
  for (const a of belief.units) {
    const eta = remainingTicks(a, graph, config);
    let state: string;
    if (a.mission === "to_scene") {
      const incident = resolve(belief, a.incidentId);
      state = `yendo a ${a.incidentId}${incident?.status === "closed" ? " (YA CERRADO: reasígnala)" : ""}, llega en ${eta} ticks${a.hospitalId ? ` (luego ${a.hospitalId})` : ""}`;
    } else if (a.mission === "to_hospital") {
      state = `llevando a ${a.victimId} a ${a.hospitalId}, llega en ${eta} ticks`;
    } else if (a.victimId) {
      state = `PARADA con ${a.victimId} a bordo, SIN HOSPITAL ASIGNADO`;
    } else {
      state = "libre";
    }
    if (a.brokenUntil !== null) state = `AVERIADA hasta el tick ${a.brokenUntil} (${state})`;
    if (a.stranded) state += " — BLOQUEADA, sin ruta abierta";
    lines.push(`- ${a.id} [${UNIT_KINDS[a.kind].label}]: ${state}`);
  }

  lines.push("", "HOSPITALES (camas libres, ya descontadas las ambulancias en camino):");
  for (const h of belief.hospitals) lines.push(`- ${h.id} ${h.name}: ${bedsFree(h.id)}${h.helipad ? " · HELIPUERTO" : ""}`);

  const hospitalOptions = (fromNode: number): string => {
    const times = graph.timesFrom(fromNode, closed);
    const options = belief.hospitals
      .filter((h) => bedsFree(h.id) > 0 && times[h.node] < Infinity)
      .map((h) => ({ id: h.id, eta: toTicks(times[h.node]) }))
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 3);
    return options.length ? options.map((o) => `${o.id} a ${o.eta} ticks`).join(" | ") : "NINGUNO con cama";
  };

  // Ambulances that can take a dispatch now, and loaded ones that will be free soon.
  const timesFor = (amb: (typeof belief.units)[number], fromNode: number): Float64Array | number[] => {
    if (UNIT_KINDS[amb.kind].flies) return graph.data.nodes.map((_, n) => (graph.distanceM(fromNode, n) / 50) * config.ambulanceSpeedFactor);
    const c = closuresFor(amb.kind, belief.closedEdges, belief.floodedEdges);
    return graph.timesFrom(fromNode, c.closed, c.slow);
  };
  const available = belief.units
    .filter((a) => !a.victimId && a.brokenUntil === null)
    .map((amb) => ({ amb, times: timesFor(amb, effectiveNode(amb, graph)) }));
  const soon = belief.units
    .filter((a) => a.mission === "to_hospital" && a.brokenUntil === null)
    .map((amb) => ({
      amb,
      freeIn: remainingTicks(amb, graph, config) + config.dropoffTicks,
      times: timesFor(amb, amb.destNode!),
    }));

  const cutOffIn = cutOffForecast(believedWater(belief), belief.hospitals, graph);
  let actionable = false;
  const open = belief.incidents
    .filter((i) => i.status === "open")
    .sort((a, b) => a.priority - b.priority || a.openedTick - b.openedTick);

  lines.push("", "INCIDENTES ABIERTOS (P0 = vida en riesgo ya ... P3 = puede esperar; la prioridad se deduce de las señales, nadie sabe cuánto le queda a nadie):");
  if (open.length === 0) lines.push("- ninguno");
  for (const incident of open.slice(0, TOP_INCIDENTS)) {
    const heading = belief.units.filter((a) => a.incidentId === incident.id && a.mission === "to_scene" && a.brokenUntil === null);
    const needs = unitsNeeded(incident, belief.units);
    const need = needs.carriers + needs.fire;
    const cutOff = cutOffIn(incident.node);
    lines.push(
      `- ${incidentLine(incident)}${incident.unreachable ? " · SIN RUTA POR CARRETERA" : ""} · abierto hace ${tick - incident.openedTick} ticks` +
        (cutOff === null ? "" : cutOff === 0 ? " · ⚠ YA AISLADO POR EL AGUA (inalcanzable en ambulancia)" : ` · ⚠ EL AGUA LO AÍSLA EN MENOS DE ${cutOff} ticks`),
    );
    lines.push(
      `    Unidades: ${heading.map((a) => `${a.id} llega en ${remainingTicks(a, graph, config)}`).join(", ") || "NINGUNA"}` +
        (needs.carriers > 0 ? ` · FALTAN ${needs.carriers} para trasladar` : "") +
        (needs.fire > 0 ? " · FALTAN BOMBEROS o rescate (hay atrapados: nadie puede cargarlos hasta liberarlos)" : ""),
    );
    if (need === 0) continue;
    const options = [
      ...available
        .filter(({ amb, times }) => amb.incidentId !== incident.id && times[incident.node] < Infinity)
        .map(({ amb, times }) => ({
          eta: toTicks(times[incident.node]),
          label: `${amb.id}/${UNIT_KINDS[amb.kind].label}` + (amb.mission === "to_scene" ? ` (desviándola de ${amb.incidentId})` : ""),
          now: true,
        })),
      ...soon
        .filter((s) => s.times[incident.node] < Infinity)
        .map((s) => ({
          eta: s.freeIn + toTicks(s.times[incident.node]),
          label: `${s.amb.id} (AÚN NO disponible: primero entrega en ${s.amb.hospitalId})`,
          now: false,
        })),
    ]
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 7);
    lines.push(`    ETA hasta el lugar: ${options.map((o) => `${o.label} ${o.eta}`).join(" | ") || "nadie puede llegar"}`);
    lines.push(`    Hospitales desde el lugar: ${hospitalOptions(incident.node)}`);
    if (options.some((o) => o.now)) actionable = true;
  }
  if (open.length > TOP_INCIDENTS) {
    const rest = open.slice(TOP_INCIDENTS);
    const oldest = Math.max(...rest.map((i) => tick - i.openedTick));
    lines.push(`- (+${rest.length} incidentes de menor prioridad en espera; el más antiguo lleva ${oldest} ticks)`);
  }

  const lost = belief.incidents.filter((i) => i.status === "open" && i.unreachable);
  if (lost.length) lines.push("", `INALCANZABLES POR CARRETERA (${lost.length}): ${lost.map((i) => i.id).join(", ")}. No mandes ambulancias ni bomberos: solo llegan rescate acuático o helicóptero.`);

  const loaded = belief.units.filter((a) => a.victimId && a.mission === "idle" && a.brokenUntil === null);
  if (loaded.length) {
    lines.push("", "AMBULANCIAS CARGADAS SIN DESTINO:");
    for (const a of loaded) lines.push(`- ${a.id} (${a.victimId}): ${hospitalOptions(effectiveNode(a, graph))}`);
    actionable = true;
  }

  if (belief.floods.length || belief.waterSightings.length) {
    lines.push("", "AGUA (lo que SABES, no lo que hay: el agua real va por delante de todo esto):");
    for (const f of belief.floods) {
      lines.push(
        `- ${f.id} ${f.name}: el último parte oficial la daba intransitable hasta ${f.radiusM} m del centro hace ${tick - f.asOfTick} ticks; ` +
          `a ${f.growthM.toFixed(1)} m/tick${f.bulletins < 2 ? " (supuesto, solo hay un parte)" : ""} ahora andará por ${projectedRadius(f, tick)} m`,
      );
    }
    const recent = belief.waterSightings.filter((w) => tick - w.tick <= 30);
    lines.push(`- Avistamientos en los últimos 30 ticks: ${recent.filter((w) => w.kind === "blocked").length} dotaciones se han dado la vuelta por agua, ${recent.filter((w) => w.kind === "wet").length} llamadas hablan de agua.`);
    if (belief.floods.length === 0) lines.push("- Todavía no hay ningún parte oficial: no sabes dónde está el centro ni cuánto ocupa.");
  }
  lines.push("", `TRAMOS CORTADOS CONOCIDOS: ${closed.size}. Los ETA esquivan solo estos; puede haber más que nadie ha visto aún.`);

  if (reports.some((r) => WAKE_ALWAYS.has(r.event.type)) && (open.length > 0 || loaded.length > 0)) actionable = true;
  return { text: lines.join("\n"), actionable };
}
