import type { Action, WorldEvent } from "./types";

export function clock(tick: number, tickSeconds: number): string {
  const s = tick * tickSeconds;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case "dispatch":
      return `${a.ambulanceId} → recoger a ${a.patientId}${a.hospitalId ? ` y llevar a ${a.hospitalId}` : ""}`;
    case "transport":
      return `${a.ambulanceId} → llevar paciente a ${a.hospitalId}`;
    case "reposition":
      return `${a.ambulanceId} → reubicar en nodo ${a.node}`;
  }
}

/** One human-readable line per event. Shared by the CLI, the LLM briefing and the UI feed. */
export function describe(e: WorldEvent): string {
  switch (e.type) {
    case "patient_spawned":
      return `112: herido ${e.patientId} en nodo ${e.node}, le quedan ${e.ttl} ticks de vida`;
    case "patient_picked_up":
      return `${e.ambulanceId} ha recogido a ${e.patientId}`;
    case "patient_delivered":
      return `${e.ambulanceId} ha entregado a ${e.patientId} en ${e.hospitalId}`;
    case "patient_died":
      return `${e.patientId} ha muerto (${e.where === "street" ? "esperando en la calle" : "dentro de la ambulancia"})`;
    case "road_closed":
      return `Calle cortada: ${e.name ?? "sin nombre"} (tramo ${e.edge})`;
    case "road_opened":
      return `Calle reabierta: ${e.name ?? "sin nombre"} (tramo ${e.edge})`;
    case "ambulance_broken":
      return `${e.ambulanceId} averiada hasta el tick ${e.untilTick}`;
    case "ambulance_repaired":
      return `${e.ambulanceId} reparada`;
    case "ambulance_rerouted":
      return `${e.ambulanceId} recalcula ruta, nuevo ETA ${e.etaTicks} ticks`;
    case "ambulance_stranded":
      return `${e.ambulanceId} bloqueada: no hay ruta abierta a su destino`;
    case "ambulance_arrived":
      return `${e.ambulanceId} libre en nodo ${e.node}`;
    case "dispatch_void":
      return `${e.ambulanceId} llegó a ${e.patientId} para nada: ${e.reason}`;
    case "hospital_full":
      return `${e.hospitalId} lleno: rechaza a ${e.ambulanceId}`;
    case "action_applied":
      return `Orden: ${describeAction(e.action)} (ETA ${e.etaTicks} ticks)`;
    case "action_rejected":
      return `Orden rechazada: ${describeAction(e.action)} — ${e.reason}`;
  }
}
