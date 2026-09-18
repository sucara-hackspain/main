// Salida por consola del estado del mundo.
import { etaTurns } from "./coordinator.js";
import { statusOf } from "./entities/ambulance.js";
import type { RoadMap } from "./map/road-map.js";
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
    console.table(w.injured.map((h) => ({ id: h.id, en: map.streetOf(h.position), ttl: h.ttl, ambulancia: ambulanceAssignedTo(w, h.id)?.id ?? "-" })));
  if (cutStreets.length) console.log("🚧", cutStreets.join(" · "));
}

export const printEvents = (w: World, since: number) => w.log.slice(since - w.log.length || undefined).forEach((line) => console.log(line));
