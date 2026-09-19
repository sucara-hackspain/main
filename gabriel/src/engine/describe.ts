import type { Action, ObservedEvent } from "./types";
import { INJURIES, SCENES } from "./victims";

export function clock(tick: number, tickSeconds: number): string {
  const s = tick * tickSeconds;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case "dispatch":
      return `${a.unitId} → incidente ${a.incidentId}${a.hospitalId ? ` y después a ${a.hospitalId}` : ""}`;
    case "transport":
      return `${a.unitId} → llevar paciente a ${a.hospitalId}`;
    case "reposition":
      return `${a.unitId} → reubicar en nodo ${a.node}`;
  }
}

/** One human-readable line per event. Shared by the CLI, the LLM briefing and the UI feed. */
export function describe(e: ObservedEvent): string {
  switch (e.type) {
    case "call_received":
      return `112 ${e.call.id} — ${e.call.text}`;
    case "scene_created":
      return `[REAL] ${e.sceneId}: ${SCENES[e.kind].label} en nodo ${e.node}, ${e.victims} víctima(s)`;
    case "scene_assessed":
      return (
        `${e.unitId} en el lugar (${e.incidentId ?? "sin incidente"}): ` +
        e.victims.map((v) => `${v.id} ${INJURIES[v.injury].label} [${v.triage}${v.trapped ? ", ATRAPADO" : ""}${v.status === "waiting" ? "" : `, ${v.status}`}]`).join("; ")
      );
    case "scene_not_found":
      return `${e.unitId} llega a ${e.incidentId ?? "su destino"} y no encuentra a nadie`;
    case "victim_freed":
      return `${e.unitId} libera a ${e.victimId}, que estaba atrapado`;
    case "victim_picked_up":
      return `${e.unitId} carga a ${e.victimId}`;
    case "victim_treated":
      return `${e.unitId} atiende en el lugar a ${e.victimId} (alta in situ)`;
    case "victim_delivered":
      return `${e.unitId} ha entregado a ${e.victimId} en ${e.hospitalId}`;
    case "victim_died":
      return `[REAL] ${e.victimId} ha muerto (${e.where === "street" ? "esperando en la calle" : "dentro de la ambulancia"})`;
    case "flood_bulletin":
      return `Parte oficial (situación de hace ${e.tick - e.asOfTick} ticks): ${e.floods.map((f) => `${f.name}, radio ${f.radiusM} m`).join("; ")}`;
    case "road_blocked_found":
      return `${e.unitId} se encuentra ${e.flooded ? "la calle inundada" : "la calle cortada"} y da la vuelta (${e.edges.length} tramos vistos)`;
    case "flood_started":
      return `[REAL] AGUA: se desborda ${e.name} (radio ${e.radiusM} m, avanza ${e.growthM} m por tick)`;
    case "flood_grew":
      return `[REAL] AGUA: ${e.floodId} alcanza ${e.radiusM} m de radio, ${e.closed.length} tramos más intransitables`;
    case "road_closed":
      return `Tráfico: calle cortada ${e.name ?? "sin nombre"} (tramo ${e.edge})`;
    case "road_opened":
      return `Calle reabierta: ${e.name ?? "sin nombre"} (tramo ${e.edge})`;
    case "unit_broken":
      return `${e.unitId} averiada hasta el tick ${e.untilTick}`;
    case "unit_repaired":
      return `${e.unitId} reparada`;
    case "unit_rerouted":
      return `${e.unitId} recalcula ruta, nuevo ETA ${e.etaTicks} ticks`;
    case "unit_stranded":
      return `${e.unitId} no tiene ruta conocida${e.incidentId ? ` hasta ${e.incidentId}` : " a su destino"} y se detiene`;
    case "unit_arrived":
      return `${e.unitId} libre en nodo ${e.node}`;
    case "hospital_full":
      return `${e.hospitalId} lleno: rechaza a ${e.unitId}`;
    case "action_applied":
      return `Orden: ${describeAction(e.action)} (ETA ${e.etaTicks} ticks)`;
    case "action_rejected":
      return `Orden rechazada: ${describeAction(e.action)} — ${e.reason}`;
  }
}
