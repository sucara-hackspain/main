import { etaFrom } from "./engine";
import type { Graph } from "./graph";
import { estimatedTtl } from "./observer";
import type { Action, Belief, Hospital, IncidentView, PatientView, Report, SimConfig, Unit } from "./types";

export interface DecideInput {
  tick: number;
  /** New since the last decision. */
  reports: Report[];
  belief: Belief;
  graph: Graph;
  config: SimConfig;
}

/** Orders plus the why, so a human can audit the decision. */
export interface Decision {
  actions: Action[];
  source: "llm" | "fallback" | "rules";
  /** One-line read of the situation. */
  situation?: string;
  /** Why each action, same order as `actions`. */
  reasons?: string[];
  ms?: number;
  costUsd?: number;
  error?: string;
}

/** Only woken when there are new reports. Sees the belief, never the world. */
export interface Coordinator {
  readonly name: string;
  decide(input: DecideInput): Action[] | Decision | Promise<Action[] | Decision>;
}

const available = (u: Unit) => u.brokenUntil === null && !u.patientId;

/** What an incident still needs, as far as dispatch can tell. */
export function incidentNeeds(incident: IncidentView, belief: Belief) {
  const trapped = belief.patients.filter((p) => p.incidentId === incident.id && p.status === "waiting" && p.trapped).length;
  const crew = belief.units.filter((u) => u.incidentId === incident.id && u.brokenUntil === null);
  return {
    trapped,
    burning: incident.kind === "fire",
    roadBlocked: incident.edge !== null && belief.closedEdges.includes(incident.edge),
    fireCrews: crew.filter((u) => u.kind === "fire").length,
    policeCrews: crew.filter((u) => u.kind === "police").length,
  };
}

/** Beds free after counting the units already heading there. */
export function bedsFree(hospital: Hospital, belief: Belief): number {
  if (hospital.offlineUntil !== null) return 0;
  return hospital.capacity - hospital.occupied - belief.units.filter((u) => u.hospitalId === hospital.id).length;
}

/**
 * Baseline to beat. Most urgent patient first, nearest free carrier (advanced units kept for the
 * critical when it costs little), nearest suitable hospital, one fire crew per fire or entrapment,
 * police to blocked roads. Never reconsiders a unit that is already on its way and never asks for backup.
 */
export class GreedyCoordinator implements Coordinator {
  readonly name = "greedy";

  decide({ tick, belief, graph, config }: DecideInput): Action[] {
    const actions: Action[] = [];
    const eta = new Map<string, (node: number) => number>();
    const etaOf = (u: Unit) => {
      if (!eta.has(u.id)) eta.set(u.id, etaFrom(u, graph, config, belief.closedEdges, belief.floodEdges));
      return eta.get(u.id)!;
    };
    const taken = new Set<string>();
    const reserved = new Map<string, number>();

    const pickHospital = (unit: Unit, patient: PatientView | undefined, fromNode: number): string | null => {
      // A hospital counts from wherever the patient is, by road for everyone (close enough for the helicopter).
      const probe: Unit = { ...unit, node: fromNode, route: [], progressS: 0, pos: unit.pos ? graph.data.nodes[fromNode] : null };
      const to = etaFrom(probe, graph, config, belief.closedEdges, belief.floodEdges);
      let best: string | null = null;
      let bestCost = Infinity;
      for (const h of belief.hospitals) {
        if (bedsFree(h, belief) - (reserved.get(h.id) ?? 0) <= 0) continue;
        if (unit.kind === "heli" && !h.helipad) continue;
        // The wrong speciality costs points, so it is worth a detour of a few ticks.
        const cost = to(h.node) + (patient && !h.specialties.includes(patient.need) ? 6 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = h.id;
        }
      }
      if (best) reserved.set(best, (reserved.get(best) ?? 0) + 1);
      return best;
    };

    // Loaded units with nowhere to go (no hospital chosen, or the chosen one turned them away).
    for (const unit of belief.units) {
      if (!unit.patientId || unit.mission !== "idle" || unit.brokenUntil !== null) continue;
      const hospitalId = pickHospital(unit, belief.patients.find((p) => p.id === unit.patientId), unit.node);
      if (hospitalId) actions.push({ type: "transport", unitId: unit.id, hospitalId });
    }

    // Incidents: a fire crew where something burns or someone is trapped, police where a road is blocked.
    for (const incident of belief.incidents.filter((i) => i.active)) {
      const needs = incidentNeeds(incident, belief);
      const wanted: ("fire" | "police")[] = [];
      if ((needs.burning || needs.trapped > 0) && needs.fireCrews === 0) wanted.push("fire");
      else if (needs.roadBlocked && needs.fireCrews + needs.policeCrews === 0) wanted.push("police");
      for (const kind of wanted) {
        const free = belief.units.filter((u) => u.kind === kind && available(u) && u.mission === "idle" && !taken.has(u.id));
        const best = free.sort((a, b) => etaOf(a)(incident.node) - etaOf(b)(incident.node))[0];
        if (!best || etaOf(best)(incident.node) === Infinity) continue;
        taken.add(best.id);
        actions.push({ type: "assist", unitId: best.id, incidentId: incident.id });
      }
    }

    // Patients: most urgent first.
    const covered = new Set(belief.units.filter((u) => u.brokenUntil === null && u.targetPatientId).map((u) => u.targetPatientId));
    const pending = belief.patients
      .filter((p) => p.status === "waiting" && !covered.has(p.id))
      .sort((a, b) => estimatedTtl(a, tick) - estimatedTtl(b, tick));
    // Ambulances cannot enter the water: flood victims are for the helicopter and the fire crews.
    const carriers = (inWater: boolean) =>
      belief.units.filter(
        (u) => (inWater ? ["heli", "fire"] : ["svb", "sva", "heli"]).includes(u.kind) && available(u) && (u.mission === "idle" || u.mission === "reposition") && !taken.has(u.id),
      );

    for (const patient of pending) {
      const ttl = estimatedTtl(patient, tick);
      const inWater = belief.incidents.find((i) => i.id === patient.incidentId)?.kind === "flood_rescue";
      const options = carriers(inWater)
        .map((unit) => ({ unit, eta: etaOf(unit)(patient.node) }))
        .filter((o) => o.eta <= ttl)
        .sort((a, b) => a.eta - b.eta);
      if (options.length === 0) continue; // nobody can make it in time
      const nearest = options[0];
      const advanced = options.find((o) => o.unit.kind !== "svb");
      // Keep the doctors for the critical; do not burn them on the rest unless nothing else is near.
      const choice =
        patient.severity === "critico"
          ? advanced && advanced.eta <= nearest.eta + 4 ? advanced : nearest
          : (options.find((o) => o.unit.kind === "svb") ?? nearest);
      taken.add(choice.unit.id);
      const hospitalId = pickHospital(choice.unit, patient, patient.node) ?? undefined;
      actions.push({ type: "dispatch", unitId: choice.unit.id, patientId: patient.id, hospitalId });
    }

    return actions;
  }
}
