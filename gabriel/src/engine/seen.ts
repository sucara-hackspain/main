import type { DecideInput } from "./coordinator";
import { describe } from "./describe";
import { UNIT_KINDS } from "./engine";
import { unitsNeeded } from "./incidents";
import { sitesAtRisk } from "./sites";

/** Reports worth a line when explaining a decision, most telling first. Arrivals and the water creeping on are not. */
const TELLING = ["site_flooded", "gauge_reading", "call_received", "scene_assessed", "drone_report", "scene_not_found", "unit_stranded", "unit_broken", "hospital_full", "flood_bulletin", "action_rejected"];

/** The handful of facts a decision answers to: the state of play in one line, then what came in since the last one. */
export function whatWasSeen({ reports, belief, graph }: DecideInput, limit = 6): string[] {
  const open = belief.incidents.filter((i) => i.status === "open");
  const uncovered = open.filter((i) => { const need = unitsNeeded(i, belief.units); return need.carriers + need.fire > 0; });
  const free = belief.units.filter((u) => (UNIT_KINDS[u.kind].carries || UNIT_KINDS[u.kind].extricates) && u.mission === "idle" && !u.victimId && u.brokenUntil === null);
  const atRisk = sitesAtRisk(belief, graph);
  const lines = [
    `${open.length} incidentes abiertos, ${uncovered.length} esperando unidad (${uncovered.filter((i) => i.priority <= 1).length} graves) · ${free.length} unidades libres` +
      (atRisk.length ? ` · ${atRisk.filter((x) => x.site.warnedTick === null).length} sitios con gente dentro sin avisar, el agua llega al primero en ~${atRisk[0].arrival} ticks` : ""),
  ];
  const news = reports.filter((r) => TELLING.includes(r.event.type)).sort((a, b) => TELLING.indexOf(a.event.type) - TELLING.indexOf(b.event.type));
  // One gauge line per channel is enough: the latest.
  const seenGauge = new Set<string>();
  for (const r of news.reverse()) {
    if (r.event.type === "gauge_reading") {
      if (seenGauge.has(r.event.name)) continue;
      seenGauge.add(r.event.name);
    }
    lines.push(describe(r.event));
    if (lines.length > limit) break;
  }
  return lines;
}
