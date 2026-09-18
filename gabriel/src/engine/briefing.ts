import { bedsFree, incidentNeeds, type DecideInput } from "./coordinator";
import { clock, describe, UNIT_KIND_LABEL } from "./describe";
import { etaFrom, remainingTicks } from "./engine";
import { estimatedTtl } from "./observer";
import { CARRIERS, type Unit } from "./types";

export interface Briefing {
  /** Situation report for an LLM coordinator. It cannot run Dijkstra, so every ETA it may need is precomputed here. */
  text: string;
  /** False when there is no decision to take, so the LLM call can be skipped. */
  actionable: boolean;
  /** Fingerprint of everything a decision depends on. Same fingerprint as last time = same answer: skip the call. */
  signature: string;
  /** Something happened that deserves a fresh look even if the fingerprint did not change. */
  urgent: boolean;
}

const WAKE_ALWAYS = new Set([
  "unit_broken",
  "unit_stranded",
  "action_rejected",
  "hospital_rejected",
  "hospital_down",
  "zone_started",
  "incident_started",
  "backup_arrived",
]);

export function buildBriefing({ tick, reports, belief, graph, config }: DecideInput): Briefing {
  const lines: string[] = [];
  const etas = new Map<string, (node: number) => number>();
  const etaOf = (u: Unit) => {
    if (!etas.has(u.id)) etas.set(u.id, etaFrom(u, graph, config, belief.closedEdges, belief.floodEdges));
    return etas.get(u.id)!;
  };
  const fmt = (n: number) => (n === Infinity ? "sin ruta" : String(n));

  lines.push(`HORA ${clock(tick, config.tickSeconds)} (tick ${tick}). 1 tick = ${config.tickSeconds} s.`, "");
  lines.push("NOVEDADES (lo que acaba de llegar; los avisos del 112 llegan con retraso y la gravedad es una estimación):");
  for (const r of reports) lines.push(`- [${r.source}${r.confidence < 1 ? `, fiabilidad ${r.confidence}` : ""}] ${describe(r.event)}`);

  const zones = belief.zones.filter((z) => z.active);
  if (zones.length) {
    lines.push("", "ZONAS:");
    for (const z of zones) {
      const age = tick - z.updatedTick;
      lines.push(
        z.kind === "flood"
          ? `- ${z.id} INUNDACIÓN "${z.label}": radio ${Math.round(z.radiusM)} m según el último parte (hace ${age} ticks; puede haber crecido). Solo bomberos (despacio) y helicóptero entran.`
          : `- ${z.id} SIN COBERTURA MÓVIL "${z.label}": radio ${Math.round(z.radiusM)} m. De ahí dentro no llegan llamadas; puede haber heridos que no conoces. Una unidad que pase cerca los detecta.`,
      );
    }
  }

  lines.push("", "UNIDADES:");
  for (const u of belief.units) {
    const eta = remainingTicks(u, graph, config);
    let state: string;
    if (u.mission === "to_patient") state = `yendo a por ${u.targetPatientId}, llega en ${eta}${u.hospitalId ? ` (luego ${u.hospitalId})` : ""}`;
    else if (u.mission === "on_scene") state = `junto a ${u.targetPatientId}, que sigue ATRAPADO: lo mantiene con vida pero no puede cargarlo`;
    else if (u.mission === "to_hospital") state = `llevando a ${u.patientId} a ${u.hospitalId}, llega en ${eta}`;
    else if (u.mission === "to_incident") state = `yendo al incidente ${u.incidentId}, llega en ${eta}`;
    else if (u.mission === "working") state = `trabajando en ${u.incidentId}`;
    else if (u.patientId) state = `PARADA con ${u.patientId} a bordo, SIN HOSPITAL ASIGNADO`;
    else state = u.mission === "reposition" ? `reubicándose, llega en ${eta}` : "libre";
    if (u.brokenUntil !== null) state = `FUERA DE SERVICIO hasta el tick ${u.brokenUntil} (${state})`;
    if (u.stranded) state += " — BLOQUEADA, sin ruta conocida";
    lines.push(`- ${u.id} [${UNIT_KIND_LABEL[u.kind]}${u.backup ? ", refuerzo" : ""}]: ${state}`);
  }
  lines.push(`Refuerzos externos que aún puedes pedir: ${belief.backupsLeft} (tardan ${config.backupDelayTicks} ticks en llegar).`);

  lines.push("", "HOSPITALES (camas libres ya descontando unidades en camino):");
  for (const h of belief.hospitals) {
    const extras = [h.specialties.filter((s) => s !== "general").join("+"), h.helipad ? "helipuerto" : ""].filter(Boolean).join(", ");
    lines.push(`- ${h.id} ${h.name}${extras ? ` [${extras}]` : ""}: ${h.offlineUntil !== null ? "FUERA DE SERVICIO" : bedsFree(h, belief)}`);
  }

  const hospitalOptions = (unit: Unit, fromNode: number, need: string): string => {
    const probe: Unit = { ...unit, node: fromNode, route: [], progressS: 0, pos: unit.pos ? graph.data.nodes[fromNode] : null };
    const to = etaFrom(probe, graph, config, belief.closedEdges, belief.floodEdges);
    const options = belief.hospitals
      .filter((h) => bedsFree(h, belief) > 0 && (unit.kind !== "heli" || h.helipad) && to(h.node) < Infinity)
      .map((h) => ({ h, eta: to(h.node) }))
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 4);
    if (options.length === 0) return "NINGUNO accesible con cama";
    return options.map((o) => `${o.h.id} ${o.eta}${o.h.specialties.includes(need as never) ? "" : " (sin la especialidad)"}`).join(" | ");
  };

  let actionable = false;
  const free = (u: Unit) => u.brokenUntil === null && !u.patientId;

  const incidents = belief.incidents.filter((i) => i.active);
  if (incidents.length) {
    lines.push("", "INCIDENTES ABIERTOS:");
    for (const inc of incidents) {
      const needs = incidentNeeds(inc, belief);
      const asks = [
        needs.burning ? "FUEGO activo (sigue generando quemados hasta que se apague)" : "",
        needs.trapped ? `${needs.trapped} atrapados conocidos (solo bomberos los liberan)` : "",
        needs.roadBlocked ? "bloquea una calle (policía o bomberos la despejan)" : "",
      ].filter(Boolean);
      lines.push(`- ${inc.id} ${inc.label}. ${asks.join("; ") || "sin necesidades conocidas"}. Trabajando allí: ${needs.fireCrews} bomberos, ${needs.policeCrews} policía.`);
      const helpers = belief.units
        .filter((u) => (u.kind === "fire" || u.kind === "police") && free(u) && u.incidentId !== inc.id)
        .map((u) => ({ u, eta: etaOf(u)(inc.node) }))
        .sort((a, b) => a.eta - b.eta);
      lines.push(`    ETA: ${helpers.map((o) => `${o.u.id}${o.u.mission === "idle" ? "" : " (ocupada)"} ${fmt(o.eta)}`).join(" | ") || "nadie disponible"}`);
      const lacksFire = (needs.burning || needs.trapped > 0) && needs.fireCrews === 0;
      const lacksRoad = needs.roadBlocked && needs.fireCrews + needs.policeCrews === 0;
      if ((lacksFire || lacksRoad) && helpers.some((o) => o.u.mission === "idle" && o.eta < Infinity)) actionable = true;
    }
  }

  const waiting = belief.patients.filter((p) => p.status === "waiting").sort((a, b) => estimatedTtl(a, tick) - estimatedTtl(b, tick));
  const carriers = belief.units.filter((u) => CARRIERS.includes(u.kind) && free(u));
  const soon = belief.units.filter((u) => u.mission === "to_hospital" && u.brokenUntil === null);

  lines.push("", "HERIDOS ESPERANDO (más urgente primero). ETA en ticks hasta el herido:");
  if (waiting.length === 0) lines.push("- ninguno");
  for (const p of waiting.slice(0, 14)) {
    const ttl = Math.floor(estimatedTtl(p, tick));
    const assigned = belief.units.find((u) => u.targetPatientId === p.id && u.brokenUntil === null);
    const tags = [p.severity.toUpperCase(), p.need !== "general" ? p.need : "", p.trapped ? "ATRAPADO" : "", p.incidentId ?? "", p.assessed ? "valorado in situ" : "sin confirmar"].filter(Boolean);
    lines.push(
      `- ${p.id} [${tags.join(", ")}]: ~${ttl} ticks de vida${p.assessed ? "" : " (estimado)"}. ` +
        (assigned ? `Asignada ${assigned.id}${assigned.mission === "on_scene" ? " (ya con él)" : `, llega en ${remainingTicks(assigned, graph, config)}`}.` : "SIN UNIDAD."),
    );
    const options = [
      ...carriers
        .filter((u) => u !== assigned && !(u.kind === "fire" && u.mission === "working"))
        .map((u) => ({
          eta: etaOf(u)(p.node),
          label: u.id + (u.mission === "to_patient" ? ` (desviándola de ${u.targetPatientId})` : u.mission === "to_incident" ? ` (iba a ${u.incidentId})` : ""),
          now: true,
        })),
      ...soon.map((u) => {
        const after: Unit = { ...u, node: u.destNode!, route: [], progressS: 0, pos: u.pos ? graph.data.nodes[u.destNode!] : null };
        return {
          eta: remainingTicks(u, graph, config) + config.dropoffTicks + etaFrom(after, graph, config, belief.closedEdges, belief.floodEdges)(p.node),
          label: `${u.id} (AÚN NO: primero entrega en ${u.hospitalId})`,
          now: false,
        };
      }),
    ]
      .filter((o) => o.eta < Infinity)
      .sort((a, b) => a.eta - b.eta)
      .slice(0, 6);
    lines.push(`    Quién llega: ${options.map((o) => `${o.label} ${o.eta}`).join(" | ") || "NADIE tiene ruta"}`);
    const sample = carriers.find((u) => u.kind === "svb" || u.kind === "sva") ?? carriers[0];
    if (sample) lines.push(`    Hospitales desde el herido (por carretera): ${hospitalOptions({ ...sample, kind: "svb", pos: null }, p.node, p.need)}`);
    if (!assigned && options.some((o) => o.now && o.eta <= ttl)) actionable = true;
  }
  if (waiting.length > 14) lines.push(`- … y ${waiting.length - 14} más, menos urgentes.`);

  const loaded = belief.units.filter((u) => u.patientId && u.mission === "idle" && u.brokenUntil === null);
  if (loaded.length) {
    lines.push("", "UNIDADES CARGADAS SIN DESTINO:");
    for (const u of loaded) {
      const p = belief.patients.find((x) => x.id === u.patientId);
      lines.push(`- ${u.id} (${u.patientId}, ${p?.severity ?? "?"}${p && p.need !== "general" ? `, ${p.need}` : ""}, ~${p ? Math.floor(estimatedTtl(p, tick)) : "?"} ticks): ${hospitalOptions(u, u.node, p?.need ?? "general")}`);
    }
    actionable = true;
  }

  lines.push("", `CALLES CORTADAS CONOCIDAS: ${belief.closedEdges.length} (${belief.floodEdges.length} por agua). Los ETA solo esquivan las conocidas: puede haber más.`);

  const urgent = reports.some((r) => WAKE_ALWAYS.has(r.event.type));
  if (urgent && (waiting.length > 0 || loaded.length > 0 || incidents.length > 0)) actionable = true;

  const assignedIds = new Set(belief.units.filter((u) => u.brokenUntil === null).map((u) => u.targetPatientId));
  const signature = JSON.stringify([
    waiting.filter((p) => !assignedIds.has(p.id)).map((p) => `${p.id}${p.severity[0]}${p.trapped ? "t" : ""}`),
    belief.units.filter((u) => free(u) && u.mission === "idle").map((u) => u.id),
    loaded.map((u) => u.id),
    incidents.map((i) => { const n = incidentNeeds(i, belief); return `${i.id}:${n.fireCrews}:${n.policeCrews}:${n.trapped}`; }),
    belief.hospitals.filter((h) => bedsFree(h, belief) <= 0).map((h) => h.id),
  ]);
  return { text: lines.join("\n"), actionable, signature, urgent };
}
