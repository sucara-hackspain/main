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
    case "scout":
      return `${a.unitId} → reconocer nodo ${a.node}${a.incidentId ? ` (${a.incidentId})` : ""}`;
    case "warn":
      return `112 → llamar a ${a.siteId} para que se pongan a salvo`;
    case "call_zone":
      return `112 → ronda de llamadas a las casas de ${a.zone}`;
  }
}

/** One human-readable line per event. Shared by the CLI, the LLM briefing and the UI feed. */
export function describe(e: ObservedEvent): string {
  switch (e.type) {
    case "call_received":
      return `112 ${e.call.id} — ${e.call.text}`;
    case "master_narration":
      return `[MASTER] ${e.text}`;
    case "site_placed":
      return `[REAL] ${e.siteId}: ${e.people} personas dentro en nodo ${e.node}`;
    case "site_warned":
      return `112 → ${e.siteId}: avisados, empiezan a ponerse a salvo`;
    case "site_flooded":
      return `${e.siteId}: el agua ha entrado. ${e.safe} a salvo${e.caught ? `, ${e.caught} ATRAPADOS DENTRO` : ", nadie dentro"}`;
    case "blackout_started":
      return `Apagón ${e.outageId}: ${e.radiusM} m sin luz hasta el tick ${e.untilTick}. Quien esté dentro apenas podrá llamar`;
    case "outbound_placed":
      return `112 → ronda de llamadas a las casas de ${e.zone}`;
    case "outbound_answered":
      return `Ronda de llamadas a ${e.zone} (~${e.homes} casas): ${e.sceneIds.length ? `${e.sceneIds.length} vecino(s) saben de alguien que necesita ayuda` : "nadie sabe de nadie en apuros"}`;
    case "gauge_reading":
      return `Aforo ${e.name}: ${Math.round(e.level * 100)} % del cauce${e.level >= 1 ? ", DESBORDADO" : `, desborda hacia el tick ${e.overflowTick}`}`;
    case "scene_created":
      return `[REAL] ${e.sceneId}: ${SCENES[e.kind].label} en nodo ${e.node}, ${e.victims} víctima(s)`;
    case "scene_assessed":
      return (
        `${e.unitId} en el lugar (${e.incidentId ?? "sin incidente"}), ${SCENES[e.kind].label.toLowerCase()}: ` +
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
    case "area_surveyed":
      return `[REAL] ${e.unitId} tiene a la vista ${e.sceneIds.length} escena(s) y ${e.closedEdges.length + e.floodedEdges.length} tramo(s) cortado(s)`;
    case "drone_report": {
      const how = e.quality >= 0.85 ? "se ve bien" : e.quality >= 0.65 ? "se ve regular" : "se ve mal";
      if (e.sightings.length === 0) {
        return `${e.unitId} sobrevuela el nodo ${e.node} (${how}): no ve a nadie${e.water ? ", hay agua debajo" : ""}. No prueba que no haya nadie.`;
      }
      const what = e.sightings
        .map((v) => {
          const kind = v.kind ? SCENES[v.kind].label : "no distingue qué ha pasado";
          const people = v.people === null ? "no puede contarlos" : `${v.people} persona(s)`;
          const still = v.still === null ? "" : `, ${v.still} sin moverse`;
          const trapped = v.trapped === "yes" ? ", parecen atrapados" : "";
          const water = v.inWater === "yes" ? ", rodeados de agua" : "";
          return `nodo ${v.node} ±${v.locationErrorM} m: ${kind}, ${people}${still}${trapped}${water}`;
        })
        .join("; ");
      return `${e.unitId} sobrevuela el nodo ${e.node} (${how}): ${what}`;
    }
    case "hospital_full":
      return `${e.hospitalId} lleno: rechaza a ${e.unitId}`;
    case "action_applied":
      return `Orden: ${describeAction(e.action)} (ETA ${e.etaTicks} ticks)`;
    case "action_rejected":
      return `Orden rechazada: ${describeAction(e.action)} — ${e.reason}`;
  }
}
