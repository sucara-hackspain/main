import type { Action, UnitKind, WorldEvent } from "./types";

export const UNIT_KIND_LABEL: Record<UnitKind, string> = {
  svb: "ambulancia básica",
  sva: "ambulancia medicalizada",
  heli: "helicóptero medicalizado",
  fire: "bomberos",
  police: "policía",
};

export function clock(tick: number, tickSeconds: number): string {
  const s = tick * tickSeconds;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case "dispatch":
      return `${a.unitId} → recoger a ${a.patientId}${a.hospitalId ? ` y llevar a ${a.hospitalId}` : ""}`;
    case "transport":
      return `${a.unitId} → llevar paciente a ${a.hospitalId}`;
    case "assist":
      return `${a.unitId} → trabajar en el incidente ${a.incidentId}`;
    case "reposition":
      return `${a.unitId} → reubicar en nodo ${a.node}`;
    case "request_backup":
      return `Pedir refuerzo externo: ${UNIT_KIND_LABEL[a.kind]}`;
  }
}

/** One human-readable line per event. Shared by the CLI, the LLM briefing and the UI feed. */
export function describe(e: WorldEvent): string {
  switch (e.type) {
    case "patient_spawned": {
      const tags = [e.severity, e.need !== "general" ? e.need : "", e.trapped ? "atrapado" : "", e.incidentId ?? ""].filter(Boolean).join(", ");
      return `Herido ${e.patientId} en nodo ${e.node} (${tags})`;
    }
    case "patient_assessed":
      return `${e.unitId} valora a ${e.patientId}: ${e.severity}, ~${e.ttl} ticks de vida${e.trapped ? ", ATRAPADO" : ""}`;
    case "patient_extricated":
      return `${e.by} ha liberado a ${e.patientId}`;
    case "patient_picked_up":
      return `${e.unitId} ha recogido a ${e.patientId}`;
    case "patient_delivered":
      return `${e.unitId} ha entregado a ${e.patientId} en ${e.hospitalId}${e.suboptimal ? " (sin la especialidad que necesitaba)" : ""}`;
    case "patient_died":
      return `${e.patientId} ha muerto (${e.where === "street" ? "esperando" : "durante el traslado"})`;
    case "false_alarm":
      return `${e.unitId} llega a ${e.patientId}: falsa alarma, no hay nadie`;
    case "incident_started":
      return `INCIDENTE ${e.incidentId}: ${e.label}${e.victims ? `, ${e.victims} heridos iniciales` : ""}`;
    case "incident_resolved":
      return `Incidente ${e.incidentId} resuelto`;
    case "zone_started":
      return e.kind === "flood" ? `INUNDACIÓN ${e.zoneId}: ${e.label}, radio ${e.radiusM} m y creciendo` : `SIN COBERTURA ${e.zoneId}: ${e.label}, radio ${e.radiusM} m`;
    case "zone_grew":
      return `La inundación ${e.zoneId} alcanza ${e.radiusM} m de radio`;
    case "zone_ended":
      return `Zona ${e.zoneId} vuelve a la normalidad`;
    case "road_closed":
      return `Calle cortada: ${e.name ?? "sin nombre"} (${e.cause})`;
    case "road_opened":
      return `Calle reabierta: ${e.name ?? "sin nombre"}`;
    case "road_discovered":
      return `${e.unitId} se encuentra cortada ${e.name ?? "una calle"}: da la vuelta y avisa`;
    case "unit_broken":
      return `${e.unitId} fuera de servicio hasta el tick ${e.untilTick}`;
    case "unit_repaired":
      return `${e.unitId} vuelve a estar operativa`;
    case "unit_rerouted":
      return `${e.unitId} recalcula ruta, nuevo ETA ${e.etaTicks} ticks`;
    case "unit_stranded":
      return `${e.unitId} bloqueada: no conoce ruta abierta a su destino`;
    case "unit_free":
      return `${e.unitId} libre (${e.reason})`;
    case "dispatch_void":
      return `${e.unitId} llegó a ${e.patientId} para nada: ${e.reason}`;
    case "hospital_rejected":
      return `${e.hospitalId} rechaza a ${e.unitId}: ${e.reason === "full" ? "sin camas" : "fuera de servicio"}`;
    case "hospital_down":
      return `${e.hospitalId} FUERA DE SERVICIO: deja de admitir pacientes`;
    case "hospital_up":
      return `${e.hospitalId} vuelve a admitir pacientes`;
    case "backup_arrived":
      return `Llega el refuerzo ${e.unitId} (${UNIT_KIND_LABEL[e.kind]})`;
    case "action_applied":
      return `Orden: ${describeAction(e.action)} (ETA ${e.etaTicks} ticks)`;
    case "action_rejected":
      return `Orden rechazada: ${describeAction(e.action)} — ${e.reason}`;
  }
}
