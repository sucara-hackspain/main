import type { Rng } from "./rng";
import type { Belief, Report, ReportSource, World, WorldEvent } from "./types";

/**
 * Turns ground-truth events into what the coordinator actually hears.
 * This is the seam for uncertainty: delays, wrong locations, false calls, missed events.
 */
export interface Observer {
  observe(events: WorldEvent[], world: Readonly<World>, rng: Rng): Omit<Report, "id">[];
}

const SOURCE: Record<WorldEvent["type"], ReportSource | null> = {
  patient_spawned: "call_112",
  patient_picked_up: "ambulance",
  patient_delivered: "hospital",
  patient_died: "ambulance",
  road_closed: "traffic",
  road_opened: "traffic",
  ambulance_broken: "ambulance",
  ambulance_repaired: "ambulance",
  ambulance_rerouted: "ambulance",
  ambulance_stranded: "ambulance",
  ambulance_arrived: "ambulance",
  dispatch_void: "ambulance",
  hospital_full: "hospital",
  // The coordinator already knows its own accepted orders.
  action_applied: null,
  action_rejected: "system",
};

/** v0: everything is reported instantly and correctly. */
export const truthfulObserver: Observer = {
  observe(events) {
    const reports: Omit<Report, "id">[] = [];
    for (const event of events) {
      const source = SOURCE[event.type];
      if (source) reports.push({ tick: event.tick, source, confidence: 1, event });
    }
    return reports;
  },
};

export function createBelief(world: Readonly<World>): Belief {
  return {
    tick: world.tick,
    ambulances: structuredClone(world.ambulances),
    hospitals: structuredClone(world.hospitals),
    patients: [],
    closedEdges: [],
  };
}

/** Folds new reports into the coordinator's picture of the world. */
export function updateBelief(belief: Belief, reports: Report[], world: Readonly<World>): void {
  belief.tick = world.tick;
  // Fleet GPS/status and hospital bed counts come from our own systems, not from reports.
  belief.ambulances = structuredClone(world.ambulances);
  belief.hospitals = structuredClone(world.hospitals);

  for (const { event, tick } of reports) {
    switch (event.type) {
      case "patient_spawned":
        belief.patients.push({
          id: event.patientId,
          node: event.node,
          status: "waiting",
          ttlReported: event.ttl,
          reportedTick: tick,
        });
        break;
      case "patient_picked_up":
        setStatus(belief, event.patientId, "in_ambulance");
        break;
      case "patient_delivered":
        setStatus(belief, event.patientId, "delivered");
        break;
      case "patient_died":
        setStatus(belief, event.patientId, "dead");
        break;
      case "road_closed":
        if (!belief.closedEdges.includes(event.edge)) belief.closedEdges.push(event.edge);
        break;
      case "road_opened":
        belief.closedEdges = belief.closedEdges.filter((e) => e !== event.edge);
        break;
    }
  }
}

function setStatus(belief: Belief, patientId: string, status: Belief["patients"][number]["status"]): void {
  const patient = belief.patients.find((p) => p.id === patientId);
  if (patient) patient.status = status;
}

/** Best guess of a waiting patient's remaining ticks. */
export function estimatedTtl(patient: Belief["patients"][number], tick: number): number {
  return patient.ttlReported - (tick - patient.reportedTick);
}
