import type {
  Action,
  GraphData,
  WorldEvent,
} from "../../gabriel/src/engine/types";
import type {
  AmbulanceFrame,
  RunMeta,
  TickRecord,
} from "../../gabriel/src/engine/trace";
export type { GraphData, RunMeta, TickRecord, AmbulanceFrame };
export const elapsed = (tick: number, seconds: number) => {
  const n = Math.floor(tick * seconds);
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};
export const patientStatus = {
  waiting: "Esperando atención",
  in_ambulance: "En traslado",
  delivered: "En hospital",
  dead: "Fallecido",
};
export function unitStatus(a: AmbulanceFrame) {
  if (a.broken) return "Averiada";
  if (a.stranded) return "Sin ruta abierta";
  if (a.mission === "to_patient") return "Hacia paciente";
  if (a.mission === "to_hospital") return "Hacia hospital";
  if (a.patientId) return "Paciente a bordo";
  if (a.mission === "reposition") return "Reubicándose";
  return "Sin misión"; // Frame does not include busyUntil: idle is not proof of availability.
}
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
export function assertMainContract(records: TickRecord[]) {
  for (const r of records) {
    if (
      !Number.isInteger(r.tick) ||
      !r.frame ||
      !Array.isArray(r.frame.ambulances) ||
      !Array.isArray(r.frame.patients) ||
      !Array.isArray(r.events) ||
      !Array.isArray(r.actions)
    )
      throw new Error(
        "Formato de ejecución no compatible con Gabriel main. La PR rich-world cambia el contrato y requiere migración.",
      );
  }
}
// Trim the first edge at the reported GPS position. No chord cutting across a street bend.
export function remainingRoute(
  a: AmbulanceFrame,
  graph: GraphData,
): [number, number][] {
  const coords: [number, number][] = [a.pos];
  a.route.forEach(([edge, forward], i) => {
    const source = graph.edges[edge]?.geom;
    if (!source) return;
    const points = forward ? source : [...source].reverse();
    if (i !== 0) {
      coords.push(...points);
      return;
    }
    let best = Infinity,
      segment = 0;
    for (let j = 0; j < points.length - 1; j++) {
      const [x, y] = points[j],
        [xx, yy] = points[j + 1];
      const dx = xx - x,
        dy = yy - y,
        k = Math.max(
          0,
          Math.min(
            1,
            ((a.pos[0] - x) * dx + (a.pos[1] - y) * dy) /
              (dx * dx + dy * dy || 1),
          ),
        );
      const d = (a.pos[0] - x - k * dx) ** 2 + (a.pos[1] - y - k * dy) ** 2;
      if (d < best) {
        best = d;
        segment = j;
      }
    }
    coords.push(...points.slice(segment + 1));
  });
  return coords;
}
