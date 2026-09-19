import type { Action, WorldEvent } from "../../../../gabriel/src/engine/types";
import { elapsed, type TickRecord } from "../runModel";

export const laneName = {
  master: "Master · entorno",
  coordinator: "Coordinador",
  world: "Motor · evolución",
};
export const auditTitle = (item: AuditItem, seconds: number) =>
  item.event ? eventText(item.event, seconds) : item.title;

export function actionText(a: Action) {
  if (a.type === "dispatch")
    return `${a.ambulanceId} → recoger a ${a.patientId}${a.hospitalId ? ` → ${a.hospitalId}` : ""}`;
  if (a.type === "transport")
    return `${a.ambulanceId} → trasladar a ${a.hospitalId}`;
  return `${a.ambulanceId} → reubicar en nodo ${a.node}`;
}
export function eventText(e: WorldEvent, seconds: number): string {
  switch (e.type) {
    case "patient_spawned":
      return `Nuevo aviso · ${e.patientId}`;
    case "patient_picked_up":
      return `${e.ambulanceId} recoge a ${e.patientId}`;
    case "patient_delivered":
      return `${e.patientId} ingresa en ${e.hospitalId}`;
    case "patient_died":
      return `${e.patientId} fallece ${e.where === "street" ? "antes de la recogida" : "durante el traslado"}`;
    case "road_closed":
      return `Corte · ${e.name || `Tramo ${e.edge}`}`;
    case "road_opened":
      return `Reapertura · ${e.name || `Tramo ${e.edge}`}`;
    case "ambulance_broken":
      return `${e.ambulanceId} averiada hasta +${elapsed(e.untilTick, seconds)}`;
    case "ambulance_repaired":
      return `${e.ambulanceId} reparada`;
    case "ambulance_rerouted":
      return `${e.ambulanceId} cambia de ruta · ETA ${elapsed(e.etaTicks, seconds)}`;
    case "ambulance_stranded":
      return `${e.ambulanceId} sin ruta abierta`;
    case "ambulance_arrived":
      return `${e.ambulanceId} llega a destino`;
    case "dispatch_void":
      return `${e.ambulanceId}: recogida cancelada · ${e.reason}`;
    case "hospital_full":
      return `${e.hospitalId} lleno · rechaza a ${e.ambulanceId}`;
    case "action_applied":
      return `Aceptada · ${actionText(e.action)}`;
    case "action_rejected":
      return `Rechazada · ${actionText(e.action)} · ${e.reason}`;
  }
}
export type AuditItem = {
  id: string;
  tick: number;
  lane: "master" | "coordinator" | "world";
  title: string;
  patients: string[];
  units: string[];
  record: TickRecord;
  event?: WorldEvent;
};
export function auditItems(records: TickRecord[]): AuditItem[] {
  const items: AuditItem[] = [];
  for (const record of records) {
    for (const [i, event] of record.events.entries()) {
      // Orders have their own decision card, including the engine's acceptance/rejection.
      if (
        record.decision &&
        (event.type === "action_applied" || event.type === "action_rejected")
      )
        continue;
      const action = "action" in event ? event.action : null;
      const patients =
        "patientId" in event
          ? [event.patientId]
          : action && "patientId" in action
            ? [action.patientId]
            : [];
      const units =
        "ambulanceId" in event
          ? [event.ambulanceId]
          : action
            ? [action.ambulanceId]
            : [];
      items.push({
        id: `${record.tick}:e:${i}`,
        tick: record.tick,
        lane: [
          "patient_spawned",
          "road_closed",
          "road_opened",
          "ambulance_broken",
        ].includes(event.type)
          ? "master"
          : "world",
        title: event.type,
        patients,
        units,
        record,
        event,
      });
    }
    if (record.decision)
      items.push({
        id: `${record.tick}:d`,
        tick: record.tick,
        lane: "coordinator",
        title:
          record.decision.situation ||
          (record.actions.length
            ? `${record.actions.length} órdenes de coordinación`
            : "Sin nuevas órdenes"),
        patients: [
          ...new Set(
            record.actions.flatMap((a) =>
              "patientId" in a
                ? [a.patientId]
                : record.frame.ambulances.find((u) => u.id === a.ambulanceId)
                      ?.patientId
                  ? [
                      record.frame.ambulances.find(
                        (u) => u.id === a.ambulanceId,
                      )!.patientId!,
                    ]
                  : [],
            ),
          ),
        ],
        units: [...new Set(record.actions.map((a) => a.ambulanceId))],
        record,
      });
  }
  return items;
}
