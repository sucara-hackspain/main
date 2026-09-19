// Salida por consola del estado del mundo.
import { etaTurns } from "./coordinator.js";
import { statusOf } from "./entities/ambulance.js";
import type { RoadMap } from "./map/road-map.js";
import { pendingInbox } from "./inbox.js";
import { priorityOf } from "./triage.js";
import { ambulanceAssignedTo, type World } from "./world.js";

export function printStatus(w: World, map: RoadMap) {
  const cutStreets = [...new Set(w.cuts.map((c) => c.street))];
  console.log(`\n⏱ t=${w.turn}  rescatados=${w.stats.rescued}  muertos=${w.stats.dead}  calles cortadas=${cutStreets.length}`);
  console.table(
    w.ambulances.map((a) => ({
      id: a.id,
      estado: statusOf(a),
      en: map.streetOf(a.position),
      objetivo: a.target ?? "-",
      eta: a.target ? (etaTurns(w, map, a) ?? "sin ruta") : "-",
    })),
  );
  if (w.injured.length)
    console.table(w.injured.map((h) => ({ id: h.id, en: map.streetOf(h.position), ttl: h.ttl, prioridad: priorityOf(w, h.id), ambulancia: ambulanceAssignedTo(w, h.id)?.id ?? "-" })));
  if (w.incidents.length)
    console.table(w.incidents.map((i) => ({ id: i.id, prioridad: i.priority, heridos: i.callIds.join(","), calle: i.street ?? "-", resumen: String(i.text ?? "").slice(0, 70) })));
  if (w.followups.length)
    console.table(w.followups.map((f) => ({ herido: f.id, estado: f.status, prioridad: f.priority, llama_en: f.status === "pending" ? `t${f.dueTurn}` : "-", intentos: f.tries, siguiente: f.report?.nextAction ?? "-", parte: String(f.report?.text ?? "").slice(0, 70) })));
  if (cutStreets.length) console.log("🚧", cutStreets.join(" · "));
  const inbox = pendingInbox();
  if (inbox.length) console.log(`📥 ${inbox.length} en la bandeja de webhooks (entran con el próximo step): ${inbox.map((e) => e.kind).join(", ")}`);
}

export const printEvents = (w: World, since: number) => w.log.slice(since - w.log.length || undefined).forEach((line) => console.log(line));
