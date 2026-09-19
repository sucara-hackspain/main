import {
  elapsed,
  sceneLabel,
  type Action,
  type ObservedEvent,
  type TickRecord,
} from "../engineTrace";

export const laneName = {
  master: "Master · entorno",
  call: "112 · llamada",
  world: "Dotaciones · motor",
  coordinator: "Coordinador",
};
export type Lane = keyof typeof laneName;
export const auditTitle = (item: AuditItem, seconds: number) =>
  item.event ? eventText(item.event, seconds) : item.title;

export function actionText(a: Action) {
  if (a.type === "dispatch")
    return `${a.unitId} → ${a.incidentId}${a.hospitalId ? ` → ${a.hospitalId}` : ""}`;
  if (a.type === "transport") return `${a.unitId} → trasladar a ${a.hospitalId}`;
  return `${a.unitId} → reubicar`;
}
const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export function eventText(e: ObservedEvent, seconds: number): string {
  switch (e.type) {
    case "call_received":
      return `Llamada ${e.call.id} · ${e.call.street ?? "ubicación aproximada"}`;
    case "flood_bulletin":
      return `Parte oficial del agua · muestra la situación de hace ${elapsed(e.tick - e.asOfTick, seconds)}`;
    case "scene_created":
      return `Ocurre · ${sceneLabel(e.kind)} · ${count(e.victims, "víctima", "víctimas")}`;
    case "scene_assessed":
      return `${e.unitId} valora ${e.incidentId ?? e.sceneId} · ${count(e.victims.length, "víctima", "víctimas")}`;
    case "scene_not_found":
      return `${e.unitId} no encuentra a nadie en ${e.incidentId ?? "el lugar indicado"}`;
    case "victim_picked_up":
      return `${e.unitId} carga a ${e.victimId}`;
    case "victim_freed":
      return `${e.unitId} libera a ${e.victimId}`;
    case "victim_treated":
      return `${e.unitId} atiende en el lugar a ${e.victimId}`;
    case "victim_delivered":
      return `${e.victimId} ingresa en ${e.hospitalId}`;
    case "victim_died":
      return `${e.victimId} fallece ${e.where === "street" ? "esperando ayuda" : "durante el traslado"}`;
    case "flood_started":
      return `Se desborda ${e.name}`;
    case "flood_grew":
      return `El agua avanza · ${e.floodId} a ${e.radiusM} m · ${count(e.closed.length, "tramo más", "tramos más")} bajo el agua`;
    case "road_closed":
      return `Corte · ${e.name || `Tramo ${e.edge}`}`;
    case "road_opened":
      return `Reapertura · ${e.name || `Tramo ${e.edge}`}`;
    case "road_blocked_found":
      return `${e.unitId} encuentra ${e.flooded ? "la calle inundada" : "la calle cortada"} y da la vuelta`;
    case "unit_broken":
      return `${e.unitId} averiada hasta +${elapsed(e.untilTick, seconds)}`;
    case "unit_repaired":
      return `${e.unitId} reparada`;
    case "unit_rerouted":
      return `${e.unitId} cambia de ruta · ETA ${elapsed(e.etaTicks, seconds)}`;
    case "unit_stranded":
      return `${e.unitId} sin ruta conocida${e.incidentId ? ` hacia ${e.incidentId}` : ""}`;
    case "unit_arrived":
      return `${e.unitId} llega a destino`;
    case "hospital_full":
      return `${e.hospitalId} lleno · rechaza a ${e.unitId}`;
    case "action_applied":
      return `Aceptada · ${actionText(e.action)}`;
    case "action_rejected":
      return `Rechazada · ${actionText(e.action)} · ${e.reason}`;
  }
}

export type AuditItem = {
  id: string;
  tick: number;
  lane: Lane;
  title: string;
  /** What it concerns: incidents, units, victims, scenes, calls, hospitals. Filters and tags read it. */
  refs: string[];
  record: TickRecord;
  event?: ObservedEvent;
};

const MASTER = new Set([
  "scene_created",
  "flood_started",
  "flood_grew",
  "flood_bulletin",
  "road_closed",
  "road_opened",
  "unit_broken",
]);

function refsOf(e: ObservedEvent, record: TickRecord): string[] {
  const refs: (string | null | undefined)[] = [];
  if (e.type === "call_received")
    refs.push(
      e.call.id,
      record.frame.incidents.find((i) => i.callIds.includes(e.call.id))?.id,
    );
  if ("unitId" in e) refs.push(e.unitId);
  if ("incidentId" in e) refs.push(e.incidentId);
  if ("sceneId" in e) refs.push(e.sceneId);
  if ("victimId" in e) refs.push(e.victimId);
  if ("hospitalId" in e) refs.push(e.hospitalId);
  if ("floodId" in e) refs.push(e.floodId);
  if (e.type === "scene_assessed") refs.push(...e.victims.map((v) => v.id));
  if ("action" in e)
    refs.push(e.action.unitId, "incidentId" in e.action ? e.action.incidentId : null);
  return [...new Set(refs.filter((x): x is string => Boolean(x)))];
}

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
      items.push({
        id: `${record.tick}:e:${i}`,
        tick: record.tick,
        lane:
          event.type === "call_received"
            ? "call"
            : MASTER.has(event.type)
              ? "master"
              : "world",
        title: event.type,
        refs: refsOf(event, record),
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
        refs: [
          ...new Set(
            record.actions.flatMap((a) => {
              const unit = record.frame.units.find((u) => u.id === a.unitId);
              return [
                a.unitId,
                a.type === "dispatch" ? a.incidentId : unit?.incidentId,
                a.type === "transport" ? unit?.victimId : null,
              ].filter((x): x is string => Boolean(x));
            }),
          ),
        ],
        record,
      });
  }
  return items;
}
