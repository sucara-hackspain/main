import type { Action, GraphData, LonLat, RunMeta, TickRecord } from "../engineTrace";

// One decision, read in full: what was on the table, what the coordinator made of it, what it ordered and why,
// where it parted from the rule-based dispatcher, and what came of each order afterwards.

export type Tone = "good" | "bad" | "neutral";

export interface OrderLine {
  key: string;
  action: Action;
  kind: Action["type"];
  text: string;
  reason: string;
  applies: string[];
  etaTicks: number | null;
  from: LonLat | null;
  to: LonLat | null;
  /** The dispatcher would have given this very order too. */
  shared: boolean;
  after: { tone: Tone; text: string } | null;
}

export interface DecisionCard {
  index: number;
  tick: number;
  source: "llm" | "fallback" | "rules";
  ms: number | null;
  situation: string;
  plan: string;
  watch: string;
  saw: string[];
  orders: OrderLine[];
  holds: { unitId: string; onlyFor: string; untilTick: number; reason: string }[];
  /** What the dispatcher would have ordered and the coordinator did not. */
  rulesOnly: OrderLine[];
  /** True when there is a baseline to compare with. */
  compared: boolean;
  /** Where the water is expected ten ticks on, as dispatch reckons it: what most of these decisions are about. */
  waterAhead: { at: LonLat; radiusM: number }[];
}

const AHEAD_TICKS = 10;
const SEARCH_TICKS = 70;

const target = (a: Action) => (a.type === "dispatch" ? a.incidentId : a.type === "transport" ? a.hospitalId : a.type === "warn" ? a.siteId : String(a.node));
const keyOf = (a: Action) => `${a.type}:${a.unitId}:${target(a)}`;

export function decisionCards(records: TickRecord[], graph: GraphData, meta: RunMeta): DecisionCard[] {
  const explained = records.some((r) => r.decision?.reasons?.length);
  const cards: DecisionCard[] = [];
  records.forEach((record, at) => {
    const d = record.decision;
    if (!d || record.actions.length === 0) return;
    // A night with reasons shows only the decisions that carry them; one without (plain rules) shows them all.
    if (explained && !d.reasons?.length) return;

    const siteAt = (node: number) => (record.frame.sites ?? []).find((s) => s.node === node);
    const place = (a: Action): LonLat | null => {
      if (a.type === "transport") return graph.nodes[meta.hospitals.find((h) => h.id === a.hospitalId)?.node ?? -1] ?? null;
      if (a.type === "warn") return graph.nodes[(record.frame.sites ?? []).find((s) => s.id === a.siteId)?.node ?? -1] ?? null;
      return graph.nodes[a.node] ?? null;
    };
    const describe = (a: Action): string => {
      if (a.type === "dispatch") return `${a.unitId} → ${a.incidentId}${a.hospitalId ? ` → ${a.hospitalId}` : ""}`;
      if (a.type === "transport") return `${a.unitId} → trasladar a ${a.hospitalId}`;
      if (a.type === "scout") return `${a.unitId} → mirar ${a.incidentId ?? "zona sin datos"}`;
      if (a.type === "warn") return `112 llama a ${a.siteId}${name(a.siteId)}`;
      const site = siteAt(a.node);
      const hospital = meta.hospitals.find((h) => h.node === a.node);
      return `${a.unitId} → esperar en ${site ? `${site.id}${name(site.id)}` : hospital ? hospital.id : "punto adelantado"}`;
    };
    const name = (siteId: string) => {
      const site = (record.frame.sites ?? []).find((s) => s.id === siteId);
      return site ? ` · ${site.name}` : "";
    };

    const baseline = d.baseline ?? [];
    const baselineKeys = new Set(baseline.map(keyOf));
    const ownKeys = new Set(record.actions.map(keyOf));
    const later = records.slice(at + 1, at + 1 + SEARCH_TICKS);
    const applied = record.events.flatMap((e) => (e.type === "action_applied" ? [e] : []));
    const rejected = record.events.flatMap((e) => (e.type === "action_rejected" ? [e] : []));

    const line = (a: Action, n: number, own: boolean): OrderLine => ({
      key: `${record.tick}:${own ? "o" : "r"}:${n}`,
      action: a,
      kind: a.type,
      text: describe(a),
      reason: own ? (d.reasons?.[n] ?? "") : "",
      applies: own ? (d.applies?.[n] ?? []) : [],
      etaTicks: applied.find((e) => keyOf(e.action) === keyOf(a))?.etaTicks ?? null,
      from: a.type === "warn" ? null : (record.frame.units.find((u) => u.id === a.unitId)?.pos ?? null),
      to: place(a),
      shared: own ? baselineKeys.has(keyOf(a)) : false,
      after: own ? aftermath(a, record, later, rejected.find((e) => keyOf(e.action) === keyOf(a))?.reason ?? null) : null,
    });

    cards.push({
      index: cards.length,
      tick: record.tick,
      source: d.source,
      ms: d.ms ?? null,
      situation: d.situation ?? "",
      plan: d.plan ?? "",
      watch: d.watch ?? "",
      saw: d.saw ?? [],
      orders: record.actions.map((a, n) => line(a, n, true)),
      holds: (d.holds ?? []).filter((h) => h.untilTick > record.tick),
      rulesOnly: baseline.filter((a) => !ownKeys.has(keyOf(a))).map((a, n) => line(a, n, false)),
      compared: d.baseline !== undefined,
      waterAhead: record.frame.knownWater.zones.map((z) => ({ at: graph.nodes[z.node], radiusM: z.radiusM + growth(records, at, z.id) * AHEAD_TICKS })),
    });
  });
  return cards;
}

/** Metres per tick a known flood has been growing, from the last two pictures dispatch had of it. */
function growth(records: TickRecord[], at: number, zoneId: string): number {
  const now = records[at].frame.knownWater.zones.find((z) => z.id === zoneId);
  const before = records[Math.max(0, at - 10)].frame.knownWater.zones.find((z) => z.id === zoneId);
  if (!now || !before || at < 10) return 8;
  return Math.max(0, (now.radiusM - before.radiusM) / 10);
}

/** What became of an order, read off the ticks that followed. */
function aftermath(a: Action, record: TickRecord, later: TickRecord[], rejection: string | null): OrderLine["after"] {
  if (rejection) return { tone: "bad", text: `rechazada: ${rejection}` };
  const events = later.flatMap((r) => r.events);
  if (a.type === "warn" || (a.type === "reposition" && (record.frame.sites ?? []).some((s) => s.node === a.node))) {
    const siteId = a.type === "warn" ? a.siteId : (record.frame.sites ?? []).find((s) => s.node === a.node)!.id;
    const flooded = events.find((e) => e.type === "site_flooded" && e.siteId === siteId);
    if (flooded?.type !== "site_flooded") return { tone: "neutral", text: "el agua aún no ha llegado al sitio" };
    return flooded.caught === 0
      ? { tone: "good", text: `al llegar el agua (tick ${flooded.tick}) estaban todos a salvo: ${flooded.safe}` }
      : { tone: "bad", text: `al llegar el agua (tick ${flooded.tick}) quedaban ${flooded.caught} dentro; ${flooded.safe} a salvo` };
  }
  // Whatever the unit was told next ends this order's story.
  const next = later.find((r) => r.actions.some((x) => x.unitId === a.unitId));
  const until = next?.tick ?? Infinity;
  const mine = events.filter((e) => e.tick <= until && "unitId" in e && e.unitId === a.unitId);
  if (a.type === "dispatch") {
    const notFound = mine.find((e) => e.type === "scene_not_found");
    if (notFound) return { tone: "bad", text: `llegó en el tick ${notFound.tick} y no había nadie: viaje perdido` };
    const stranded = mine.find((e) => e.type === "unit_stranded");
    if (stranded) return { tone: "bad", text: `el agua le cortó el paso en el tick ${stranded.tick}` };
    const arrived = mine.find((e) => e.type === "scene_assessed" && !e.inSight);
    if (!arrived) return next ? { tone: "neutral", text: `reasignada en el tick ${next.tick} antes de llegar` } : { tone: "neutral", text: "aún de camino" };
    const delivered = mine.filter((e) => e.type === "victim_delivered").length;
    const helped = mine.filter((e) => e.type === "victim_freed" || e.type === "victim_treated").length;
    const waited = arrived.tick - record.tick;
    return { tone: "good", text: `llegó en ${waited} ticks${delivered ? ` · ${delivered} entregado(s) en hospital` : ""}${helped ? ` · ${helped} liberado(s) o atendido(s)` : ""}` };
  }
  if (a.type === "transport") {
    const delivered = mine.find((e) => e.type === "victim_delivered");
    if (delivered) return { tone: "good", text: `entregado en el tick ${delivered.tick}` };
    return mine.some((e) => e.type === "hospital_full") ? { tone: "bad", text: "el hospital estaba lleno" } : { tone: "neutral", text: "traslado en curso" };
  }
  if (a.type === "scout") {
    // The report itself only reaches the coordinator; what the run keeps is the pass, and what was really under it.
    const pass = mine.find((e) => e.type === "area_surveyed");
    if (pass?.type !== "area_surveyed") return { tone: "neutral", text: "aún no ha llegado a la zona" };
    return pass.sceneIds.length
      ? { tone: "good", text: `sobrevoló la zona en el tick ${pass.tick}: había ${pass.sceneIds.length} emergencia(s) debajo` }
      : { tone: "neutral", text: `sobrevoló la zona en el tick ${pass.tick}: no había nada debajo` };
  }
  const there = mine.find((e) => e.type === "unit_arrived");
  return there ? { tone: "neutral", text: `en posición desde el tick ${there.tick}` } : { tone: "neutral", text: "de camino a su posición" };
}

/** How often, over the night, the coordinator did something the dispatcher would not have. */
export function divergence(cards: DecisionCard[]): { compared: number; differed: number } {
  const compared = cards.filter((c) => c.compared);
  return { compared: compared.length, differed: compared.filter((c) => c.rulesOnly.length > 0 || c.orders.some((o) => !o.shared)).length };
}
