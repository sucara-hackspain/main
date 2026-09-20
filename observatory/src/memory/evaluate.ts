import { CallObserver, INJURIES, SCENES, UNIT_KINDS, type Simulation, type Summary, type TickRecord, type Victim, type WorldEvent } from "../engine";

// The session judged with hindsight. Unlike the coordinator, the evaluator sees everything: what was
// really wrong with each victim, when they died, which call was about which scene. Every death and
// every wasted trip gets a cause, so the dream has facts to learn from rather than a score.

export type FindingKind =
  | "death_never_dispatched"
  | "death_late"
  | "death_trapped_waiting"
  | "death_left_waiting"
  | "death_in_transport"
  | "death_in_water"
  | "wasted_nobody_there"
  | "wasted_trapped_no_fire"
  | "wasted_turned_back"
  | "hospital_rejected"
  | "saved_critical";

export interface Finding {
  id: string;
  kind: FindingKind;
  good: boolean;
  tick: number;
  incidentIds: string[];
  sceneId: string | null;
  victimId: string | null;
  title: string;
  /** The story, with the numbers: what was known, what was decided, what happened. */
  detail: string;
  /** Doctrine ids the agent cited on this incident. */
  ruleIds: string[];
}

export interface Evaluation {
  session: string;
  coordinator: string;
  seed: number;
  ticks: number;
  summary: Summary;
  counts: Partial<Record<FindingKind, number>>;
  /** Mean ticks from the scene happening to a crew taking charge, for victims whose life was at risk. */
  criticalResponseTicks: number | null;
  hospitalLoad: { id: string; name: string; delivered: number; capacity: number }[];
  decisions: { llm: number; fallback: number; meanMs: number | null };
  ruleUse: { ruleId: string; times: number }[];
  findings: Finding[];
}

const TITLES: Record<FindingKind, string> = {
  death_never_dispatched: "Murió sin que se mandara a nadie",
  death_late: "Murió antes de que llegara la unidad",
  death_trapped_waiting: "Murió atrapado esperando a que lo liberaran",
  death_left_waiting: "Murió en el lugar esperando una segunda unidad",
  death_in_transport: "Murió durante el traslado",
  death_in_water: "Murió dentro del agua, fuera del alcance de las ambulancias",
  wasted_nobody_there: "Viaje perdido: no había nadie",
  wasted_trapped_no_fire: "Viaje perdido: la víctima estaba atrapada y no había quien la liberase",
  wasted_turned_back: "Viaje perdido: el agua cortó el paso y la unidad se quedó sin ruta",
  hospital_rejected: "Hospital lleno: rechazó la unidad con el herido a bordo",
  saved_critical: "Caso crítico salvado",
};

export interface EvaluateInput {
  session: string;
  coordinator: string;
  seed: number;
  sim: Simulation;
  records: TickRecord[];
  applications: { ruleId: string; incidentId: string | null }[];
}

export function evaluate({ session, coordinator, seed, sim, records, applications }: EvaluateInput): Evaluation {
  const { world, belief } = sim;
  const log = world.log;
  const sceneOfCall = sim.observer instanceof CallObserver ? sim.observer.sceneOfCall : new Map<string, string>();

  // Which of the coordinator's incidents were really about each scene.
  const incidentsOf = (sceneId: string): string[] =>
    belief.incidents.filter((i) => i.foci.some((f) => f.sceneId === sceneId) || i.sceneId === sceneId || i.callIds.some((c) => sceneOfCall.get(c) === sceneId)).map((i) => i.id);
  const firstCallTick = (sceneId: string): number | null => {
    const ticks = belief.calls.filter((c) => sceneOfCall.get(c.id) === sceneId).map((c) => c.tick);
    return ticks.length ? Math.min(...ticks) : null;
  };
  const kindOf = (unitId: string) => world.units.find((u) => u.id === unitId)!.kind;
  const rulesFor = (incidentIds: string[]) => [...new Set(applications.filter((a) => a.incidentId && incidentIds.includes(a.incidentId)).map((a) => a.ruleId))];
  const freeCarriersAt = (tick: number): number => {
    const frame = records.find((r) => r.tick === tick)?.frame;
    return frame ? frame.units.filter((u) => UNIT_KINDS[u.kind].carries && u.mission === "idle" && !u.victimId && !u.broken).length : 0;
  };
  type Of<T extends WorldEvent["type"]> = Extract<WorldEvent, { type: T }>;
  const events = <T extends WorldEvent["type"]>(type: T) => log.filter((e): e is Of<T> => e.type === type);

  const findings: Finding[] = [];
  const add = (kind: FindingKind, tick: number, f: Pick<Finding, "incidentIds" | "sceneId" | "victimId" | "detail">) =>
    findings.push({ id: `${session}:E${findings.length + 1}`, kind, good: kind === "saved_critical", tick, title: TITLES[kind], ruleIds: rulesFor(f.incidentIds), ...f });

  const describeVictim = (v: Victim) => `${v.id} (${INJURIES[v.injury].label}, ${v.age} años${v.trapped ? ", atrapado" : ""})`;

  for (const victim of world.victims) {
    const scene = world.scenes.find((s) => s.id === victim.sceneId)!;
    const incidentIds = incidentsOf(scene.id);
    const called = firstCallTick(scene.id);
    const dispatches = events("action_applied").filter((e) => e.action.type === "dispatch" && incidentIds.includes(e.action.incidentId));
    const arrivals = events("scene_assessed").filter((e) => e.sceneId === scene.id);
    const where = `${SCENES[scene.kind].label} (${scene.id}, tick ${scene.tick}${incidentIds.length ? `, incidente ${incidentIds.join("/")}` : ", nunca llegó a ser incidente"})`;
    const base = { incidentIds, sceneId: scene.id, victimId: victim.id };

    if (victim.status === "dead") {
      const died = victim.endTick!;
      const death = events("victim_died").find((e) => e.victimId === victim.id);
      const who = describeVictim(victim);
      if (victim.inWater) {
        const reachers = dispatches.filter((d) => UNIT_KINDS[kindOf(d.action.unitId)].wades || UNIT_KINDS[kindOf(d.action.unitId)].flies);
        add("death_in_water", died, { ...base, detail: `${who} en ${where}. Quedó dentro del agua. ${reachers.length ? `Se mandó ${reachers.map((d) => d.action.unitId).join(", ")} en el tick ${reachers[0].tick}, no llegó a tiempo.` : "No se mandó ni rescate acuático ni helicóptero."} Murió en el tick ${died}.` });
      } else if (death?.where === "ambulance") {
        add("death_in_transport", died, { ...base, detail: `${who} en ${where}. Recogido en el tick ${victim.attendedTick}, murió a bordo en el tick ${died}, ${died - victim.attendedTick!} ticks después: traslado demasiado largo o recogida demasiado tarde.` });
      } else if (dispatches.length === 0) {
        add("death_never_dispatched", died, { ...base, detail: `${who} en ${where}. ${called === null ? "Nadie llamó a tiempo." : `Primera llamada en el tick ${called}; había ${freeCarriersAt(called)} unidades de traslado libres en ese momento.`} Nunca se mandó a nadie. Murió en el tick ${died}, tras ${died - scene.tick} ticks.` });
      } else if (!arrivals.some((a) => a.tick <= died)) {
        const first = dispatches[0];
        add("death_late", died, { ...base, detail: `${who} en ${where}. Llamada en el tick ${called ?? "?"}, primera unidad (${first.action.unitId}) mandada en el tick ${first.tick} (${called === null ? "?" : first.tick - called} ticks después, con ${called === null ? "?" : freeCarriersAt(called)} unidades de traslado libres al entrar la llamada) con ETA ${first.etaTicks}. Murió en el tick ${died}, antes de que llegara nadie.` });
      } else {
        const wasTrapped = victim.trapped || events("victim_freed").some((e) => e.victimId === victim.id);
        const crews = arrivals.filter((a) => a.tick <= died).map((a) => `${a.unitId} (tick ${a.tick})`).join(", ");
        add(wasTrapped ? "death_trapped_waiting" : "death_left_waiting", died, { ...base, detail: `${who} en ${where}. Llegaron ${crews}, pero ${wasTrapped ? "estaba atrapado y nadie lo liberó a tiempo" : "se llevaron a otra víctima y no volvió nadie a tiempo"}. Murió en el tick ${died}.` });
      }
    } else if (victim.status === "delivered" && victim.ttl !== null && ["cardiac_arrest", "drowning", "hemorrhage"].includes(victim.injury)) {
      const response = victim.attendedTick! - scene.tick;
      add("saved_critical", victim.endTick!, { ...base, detail: `${describeVictim(victim)} en ${where}. Atendido a los ${response} ticks y entregado en el tick ${victim.endTick}, con ${Math.ceil(victim.ttl)} ticks de margen.` });
    }
  }

  for (const e of events("scene_not_found")) {
    add("wasted_nobody_there", e.tick, { incidentIds: e.incidentId ? [e.incidentId] : [], sceneId: null, victimId: null, detail: `${e.unitId} llegó a ${e.incidentId ?? "su destino"} en el tick ${e.tick} y no había nadie: otra unidad ya lo había resuelto, o el incidente era un duplicado.` });
  }
  for (const e of events("scene_assessed")) {
    const waiting = e.victims.filter((v) => v.status === "waiting");
    if (UNIT_KINDS[kindOf(e.unitId)].extricates || waiting.length === 0 || !waiting.every((v) => v.trapped)) continue;
    add("wasted_trapped_no_fire", e.tick, { incidentIds: e.incidentId ? [e.incidentId] : incidentsOf(e.sceneId), sceneId: e.sceneId, victimId: null, detail: `${e.unitId} (${UNIT_KINDS[kindOf(e.unitId)].label}) llegó a ${e.incidentId} en el tick ${e.tick}: ${waiting.length} víctima(s), todas atrapadas. No pudo cargar a nadie.` });
  }
  for (const e of events("unit_stranded")) {
    if (!e.incidentId) continue;
    add("wasted_turned_back", e.tick, { incidentIds: [e.incidentId], sceneId: null, victimId: null, detail: `${e.unitId} iba a ${e.incidentId} y en el tick ${e.tick} se quedó sin ruta conocida por el agua. El viaje se perdió y el incidente pasó a inalcanzable por carretera.` });
  }
  for (const e of events("hospital_full")) {
    add("hospital_rejected", e.tick, { incidentIds: [], sceneId: null, victimId: null, detail: `${e.hospitalId} rechazó a ${e.unitId} en el tick ${e.tick} por estar lleno: se le envió un herido sin cama.` });
  }

  const counts: Evaluation["counts"] = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  const critical = world.victims.filter((v) => v.attendedTick !== null && INJURIES[v.injury].ttl !== null);
  const decisions = records.flatMap((r) => (r.decision && r.decision.source !== "rules" ? [r.decision] : []));
  const answered = decisions.filter((d) => d.source === "llm");
  const use = new Map<string, number>();
  for (const a of applications) use.set(a.ruleId, (use.get(a.ruleId) ?? 0) + 1);

  return {
    session,
    coordinator,
    seed,
    ticks: world.tick,
    summary: sim.summary(),
    counts,
    criticalResponseTicks: critical.length ? critical.reduce((sum, v) => sum + (v.attendedTick! - v.spawnTick), 0) / critical.length : null,
    hospitalLoad: world.hospitals.map((h) => ({ id: h.id, name: h.name, delivered: h.occupied, capacity: h.capacity })),
    decisions: { llm: answered.length, fallback: decisions.length - answered.length, meanMs: answered.length ? answered.reduce((sum, d) => sum + (d.ms ?? 0), 0) / answered.length : null },
    ruleUse: [...use].map(([ruleId, times]) => ({ ruleId, times })).sort((a, b) => b.times - a.times),
    findings,
  };
}
