import type { DecideInput } from "./coordinator";
import { clock, describe } from "./describe";
import { effectiveNode, remainingTicks } from "./engine";
import { estimatedTtl } from "./observer";

export interface Briefing {
  /** Situation report for an LLM coordinator. It cannot run Dijkstra, so every ETA it may need is precomputed here. */
  text: string;
  /** False when there is no decision to take, so the LLM call can be skipped. */
  actionable: boolean;
}

const WAKE_ALWAYS = new Set(["ambulance_broken", "ambulance_stranded", "action_rejected", "hospital_full"]);

export function buildBriefing({ tick, reports, belief, graph, config }: DecideInput): Briefing {
  const closed = new Set(belief.closedEdges);
  const toTicks = (seconds: number) => Math.ceil(seconds / config.ambulanceSpeedFactor / config.tickSeconds);
  const lines: string[] = [];

  lines.push(`HORA ${clock(tick, config.tickSeconds)} (tick ${tick}). 1 tick = ${config.tickSeconds} s.`, "");
  lines.push("NOVEDADES:");
  for (const r of reports) lines.push(`- [${r.source}] ${describe(r.event)}`);

  const inbound = new Map<string, number>();
  for (const a of belief.ambulances) if (a.hospitalId) inbound.set(a.hospitalId, (inbound.get(a.hospitalId) ?? 0) + 1);
  const bedsFree = (id: string) => {
    const h = belief.hospitals.find((x) => x.id === id)!;
    return h.capacity - h.occupied - (inbound.get(id) ?? 0);
  };
  const ttlOf = (patientId: string | null) => {
    const p = belief.patients.find((x) => x.id === patientId);
    return p ? Math.floor(estimatedTtl(p, tick)) : 0;
  };

  lines.push("", "AMBULANCIAS:");
  for (const a of belief.ambulances) {
    const eta = remainingTicks(a, graph, config);
    let state: string;
    if (a.mission === "to_patient") {
      state = `yendo a por ${a.targetPatientId}, llega en ${eta} ticks${a.hospitalId ? ` (luego ${a.hospitalId})` : ""}`;
    } else if (a.mission === "to_hospital") {
      state = `llevando a ${a.patientId} a ${a.hospitalId}, llega en ${eta} ticks`;
    } else if (a.patientId) {
      state = `PARADA con ${a.patientId} a bordo, SIN HOSPITAL ASIGNADO`;
    } else {
      state = "libre";
    }
    if (a.brokenUntil !== null) state = `AVERIADA hasta el tick ${a.brokenUntil} (${state})`;
    if (a.stranded) state += " — BLOQUEADA, sin ruta abierta";
    lines.push(`- ${a.id}: ${state}`);
  }

  lines.push("", "HOSPITALES (camas libres, ya descontadas las ambulancias en camino):");
  for (const h of belief.hospitals) lines.push(`- ${h.id} ${h.name}: ${bedsFree(h.id)}`);

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
  const available = belief.ambulances
    .filter((a) => !a.patientId && a.brokenUntil === null)
    .map((amb) => ({ amb, times: graph.timesFrom(effectiveNode(amb, graph), closed) }));
  const soon = belief.ambulances
    .filter((a) => a.mission === "to_hospital" && a.brokenUntil === null)
    .map((amb) => ({
      amb,
      freeIn: remainingTicks(amb, graph, config) + config.dropoffTicks,
      times: graph.timesFrom(amb.destNode!, closed),
    }));

  let actionable = false;
  const waiting = belief.patients
    .filter((p) => p.status === "waiting")
    .sort((a, b) => estimatedTtl(a, tick) - estimatedTtl(b, tick));

  lines.push("", "HERIDOS ESPERANDO (más urgente primero):");
  if (waiting.length === 0) lines.push("- ninguno");
  for (const p of waiting) {
    const ttl = Math.floor(estimatedTtl(p, tick));
    const assigned = belief.ambulances.find((a) => a.targetPatientId === p.id && a.brokenUntil === null);
    lines.push(
      `- ${p.id}: le quedan ~${ttl} ticks. ` +
        (assigned ? `Asignada ${assigned.id}, llega en ${remainingTicks(assigned, graph, config)} ticks.` : "SIN AMBULANCIA."),
    );
    const options = [
      ...available
        .filter(({ amb }) => amb !== assigned && times(p.node, amb.id) < Infinity)
        .map(({ amb }) => ({
          eta: toTicks(times(p.node, amb.id)),
          label: amb.id + (amb.mission === "to_patient" ? ` (desviándola de ${amb.targetPatientId})` : ""),
          now: true,
        })),
      ...soon
        .filter((s) => s.times[p.node] < Infinity)
        .map((s) => ({
          eta: s.freeIn + toTicks(s.times[p.node]),
          label: `${s.amb.id} (AÚN NO disponible: primero entrega en ${s.amb.hospitalId})`,
          now: false,
        })),
    ]
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 5);
    lines.push(`    ETA hasta el herido: ${options.map((o) => `${o.label} ${o.eta}`).join(" | ") || "nadie puede llegar"}`);
    lines.push(`    Hospitales desde el herido: ${hospitalOptions(p.node)}`);
    if (!assigned && options.some((o) => o.now && o.eta <= ttl)) actionable = true;
  }

  function times(node: number, ambulanceId: string): number {
    return available.find((x) => x.amb.id === ambulanceId)!.times[node];
  }

  const loaded = belief.ambulances.filter((a) => a.patientId && a.mission === "idle" && a.brokenUntil === null);
  if (loaded.length) {
    lines.push("", "AMBULANCIAS CARGADAS SIN DESTINO:");
    for (const a of loaded) {
      lines.push(`- ${a.id} (${a.patientId}, ~${ttlOf(a.patientId)} ticks de vida): ${hospitalOptions(effectiveNode(a, graph))}`);
    }
    actionable = true;
  }

  lines.push("", `CALLES CORTADAS: ${closed.size} (los ETA ya las esquivan).`);

  if (reports.some((r) => WAKE_ALWAYS.has(r.event.type)) && (waiting.length > 0 || loaded.length > 0)) {
    actionable = true;
  }
  return { text: lines.join("\n"), actionable };
}
