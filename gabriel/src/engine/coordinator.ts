import { effectiveNode } from "./engine";
import type { Graph } from "./graph";
import { estimatedTtl } from "./observer";
import type { Action, Belief, Report, SimConfig } from "./types";

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

/**
 * Baseline to beat: most urgent patient first, nearest free ambulance, nearest hospital with a bed.
 * Never reconsiders an ambulance that is already on its way.
 */
export class GreedyCoordinator implements Coordinator {
  readonly name = "greedy";

  decide({ tick, belief, graph, config }: DecideInput): Action[] {
    const actions: Action[] = [];
    const closed = new Set(belief.closedEdges);
    const ticksFor = (seconds: number) => seconds / config.ambulanceSpeedFactor / config.tickSeconds;

    // Beds already spoken for by ambulances heading to each hospital.
    const inbound = new Map<string, number>();
    for (const amb of belief.ambulances) {
      if (amb.hospitalId) inbound.set(amb.hospitalId, (inbound.get(amb.hospitalId) ?? 0) + 1);
    }
    const nearestHospital = (fromNode: number): string | null => {
      const times = graph.timesFrom(fromNode, closed);
      let best: string | null = null;
      let bestTime = Infinity;
      for (const h of belief.hospitals) {
        if (h.occupied + (inbound.get(h.id) ?? 0) >= h.capacity) continue;
        if (times[h.node] < bestTime) {
          bestTime = times[h.node];
          best = h.id;
        }
      }
      if (best) inbound.set(best, (inbound.get(best) ?? 0) + 1);
      return best;
    };

    // Loaded ambulances with nowhere to go (no hospital chosen, or the chosen one was full).
    for (const amb of belief.ambulances) {
      if (amb.patientId && amb.mission === "idle" && amb.brokenUntil === null) {
        const hospitalId = nearestHospital(effectiveNode(amb, graph));
        if (hospitalId) actions.push({ type: "transport", ambulanceId: amb.id, hospitalId });
      }
    }

    const free = belief.ambulances
      .filter((a) => !a.patientId && a.brokenUntil === null && a.mission !== "to_patient")
      .map((amb) => ({ amb, times: graph.timesFrom(effectiveNode(amb, graph), closed) }));

    const covered = new Set(
      belief.ambulances.filter((a) => a.brokenUntil === null && a.targetPatientId).map((a) => a.targetPatientId),
    );
    const pending = belief.patients
      .filter((p) => p.status === "waiting" && !covered.has(p.id))
      .sort((a, b) => estimatedTtl(a, tick) - estimatedTtl(b, tick));

    for (const patient of pending) {
      let best = -1;
      for (let i = 0; i < free.length; i++) {
        if (best < 0 || free[i].times[patient.node] < free[best].times[patient.node]) best = i;
      }
      if (best < 0) break;
      const eta = ticksFor(free[best].times[patient.node]);
      // Triage: do not burn an ambulance on someone it cannot reach in time.
      if (eta > estimatedTtl(patient, tick)) continue;
      const [{ amb }] = free.splice(best, 1);
      const hospitalId = nearestHospital(patient.node) ?? undefined;
      actions.push({ type: "dispatch", ambulanceId: amb.id, patientId: patient.id, hospitalId });
    }

    return actions;
  }
}
