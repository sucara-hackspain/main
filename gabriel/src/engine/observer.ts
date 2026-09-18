import { TTL_TYPICAL, unitLonLat } from "./engine";
import { distM, type Graph } from "./graph";
import type { Rng } from "./rng";
import type { Belief, LonLat, PatientStatus, Report, ReportSource, Severity, World, WorldEvent } from "./types";

type Draft = Omit<Report, "id" | "tick">;

/**
 * Turns ground-truth events into what the coordinator actually hears.
 * This is where uncertainty lives: delays, wrong details, missed events, dead zones.
 */
export interface Observer {
  /** Returns the reports that reach the coordinator this tick. */
  observe(events: WorldEvent[], world: Readonly<World>, graph: Graph, rng: Rng): Draft[];
}

/** Who tells dispatch about each kind of event. null = nobody does. */
const SOURCE: Record<WorldEvent["type"], ReportSource | null> = {
  patient_spawned: "call_112",
  patient_assessed: "radio",
  patient_extricated: "radio",
  patient_picked_up: "radio",
  patient_delivered: "hospital",
  patient_died: "call_112",
  false_alarm: "radio",
  incident_started: "call_112",
  incident_resolved: "radio",
  zone_started: "aemet",
  zone_grew: "aemet",
  zone_ended: "system",
  // A closed street is learnt from its incident, from the flood bulletin, or by running into it.
  road_closed: null,
  road_opened: "traffic",
  road_discovered: "radio",
  unit_broken: "radio",
  unit_repaired: "radio",
  unit_rerouted: "radio",
  unit_stranded: "radio",
  unit_free: "radio",
  dispatch_void: "radio",
  hospital_rejected: "hospital",
  hospital_down: "hospital",
  hospital_up: "hospital",
  backup_arrived: "radio",
  // The coordinator already knows its own accepted orders.
  action_applied: null,
  action_rejected: "system",
};

/** Test/benchmark observer: everything is reported instantly and correctly. */
export const truthfulObserver: Observer = {
  observe(events) {
    return events.flatMap((event) => {
      const source = event.type === "road_closed" ? "traffic" : SOURCE[event.type];
      return source ? [{ source, confidence: 1, event }] : [];
    });
  },
};

interface Pending {
  deliverAt: number;
  draft: Draft;
  /** Where it happened: calls from inside a dead zone do not get out. */
  at: LonLat | null;
  /** Patients of an incident are all reported the moment a unit reaches the scene. */
  sceneNode: number | null;
}

const RELAY_RADIUS_M = 400;

/**
 * Reports take time and come from people. Citizens' calls are late and guess the severity;
 * our own radios and hospitals are instant and exact; nothing gets out of a zone without coverage
 * until it comes back or one of our units drives close enough to relay it.
 */
export class FieldObserver implements Observer {
  private queue: Pending[] = [];

  observe(events: WorldEvent[], world: Readonly<World>, graph: Graph, rng: Rng): Draft[] {
    for (const event of events) {
      const pending = this.schedule(event, world, graph, rng);
      if (pending) this.queue.push(pending);
    }

    const deadZones = world.zones.filter((z) => z.kind === "no_coverage" && z.active);
    const unitPositions = world.units.map((u) => unitLonLat(u, graph));
    const onScene = new Set(world.units.filter((u) => u.progressS === 0 && u.destNode === null).map((u) => u.node));

    const out: Draft[] = [];
    const waiting: Pending[] = [];
    for (const p of this.queue) {
      const silenced =
        p.at !== null &&
        p.draft.source === "call_112" &&
        deadZones.some((z) => distM(z.center, p.at!) <= z.radiusM) &&
        !unitPositions.some((pos) => distM(pos, p.at!) <= RELAY_RADIUS_M);
      const seenByCrew = p.sceneNode !== null && onScene.has(p.sceneNode);
      if (!silenced && (seenByCrew || world.tick >= p.deliverAt)) out.push(seenByCrew ? { ...p.draft, source: "radio" } : p.draft);
      else waiting.push(p);
    }
    this.queue = waiting;
    return out;
  }

  private schedule(event: WorldEvent, world: Readonly<World>, graph: Graph, rng: Rng): Pending | null {
    const source = SOURCE[event.type];
    if (!source) return null;
    const now = world.tick;
    const nodeAt = (node: number): LonLat => graph.data.nodes[node];
    const instant = (): Pending => ({ deliverAt: now, draft: { source, confidence: 1, event }, at: null, sceneNode: null });

    switch (event.type) {
      case "patient_spawned": {
        // The caller is not a doctor: severity is a guess until a unit examines the patient.
        const guess = event.phantom || rng.chance(0.7) ? event.severity : misjudge(event.severity, rng);
        const told: WorldEvent = { ...event, severity: guess, ttl: TTL_TYPICAL[guess] };
        return {
          deliverAt: now + (event.incidentId ? rng.int(2, 9) : rng.int(1, 5)),
          draft: { source, confidence: 0.6, event: told },
          at: nodeAt(event.node),
          sceneNode: event.incidentId ? event.node : null,
        };
      }
      case "incident_started":
        return { deliverAt: now + rng.int(1, 3), draft: { source, confidence: 0.8, event }, at: nodeAt(event.node), sceneNode: null };
      case "patient_died": {
        if (event.where === "unit") return instant();
        const patient = world.patients.find((p) => p.id === event.patientId)!;
        return { deliverAt: now + rng.int(3, 8), draft: { source, confidence: 0.8, event }, at: nodeAt(patient.node), sceneNode: patient.node };
      }
      case "zone_started":
      case "zone_grew":
        return { deliverAt: now + rng.int(2, 4), draft: { source, confidence: 0.9, event }, at: null, sceneNode: null };
      case "road_opened":
        return event.by === "unit" ? instant() : { deliverAt: now + rng.int(2, 6), draft: { source, confidence: 0.9, event }, at: null, sceneNode: null };
      default:
        return instant();
    }
  }
}

function misjudge(severity: Severity, rng: Rng): Severity {
  if (severity === "grave") return rng.chance(0.5) ? "critico" : "leve";
  return "grave";
}

// ---------- Belief ----------

export function createBelief(world: Readonly<World>): Belief {
  return {
    tick: world.tick,
    units: structuredClone(world.units),
    hospitals: structuredClone(world.hospitals),
    patients: [],
    incidents: [],
    zones: [],
    closedEdges: [],
    floodEdges: [],
    backupsLeft: world.config.maxBackups,
  };
}

/** Folds new reports into the coordinator's picture of the world. */
export function updateBelief(belief: Belief, reports: Report[], world: Readonly<World>, graph: Graph): void {
  belief.tick = world.tick;
  // Fleet GPS/status and hospital systems are ours: always current.
  belief.units = structuredClone(world.units);
  belief.hospitals = structuredClone(world.hospitals);
  belief.backupsLeft = world.config.maxBackups - world.backupsRequested;

  const close = (edge: number) => {
    if (!belief.closedEdges.includes(edge)) belief.closedEdges.push(edge);
  };
  const flood = (center: LonLat, radiusM: number) => {
    for (const edge of graph.edgesWithin(center, radiusM)) {
      close(edge);
      if (!belief.floodEdges.includes(edge)) belief.floodEdges.push(edge);
    }
  };

  for (const { event, tick } of reports) {
    switch (event.type) {
      case "patient_spawned":
        if (belief.patients.some((p) => p.id === event.patientId)) break;
        belief.patients.push({
          id: event.patientId,
          node: event.node,
          status: "waiting",
          severity: event.severity,
          need: event.need,
          trapped: event.trapped,
          incidentId: event.incidentId,
          assessed: false,
          ttlReported: event.ttl,
          reportedTick: tick,
        });
        break;
      case "patient_assessed": {
        const p = belief.patients.find((x) => x.id === event.patientId);
        if (p) Object.assign(p, { severity: event.severity, trapped: event.trapped, assessed: true, ttlReported: event.ttl, reportedTick: tick });
        break;
      }
      case "patient_extricated": {
        const p = belief.patients.find((x) => x.id === event.patientId);
        if (p) p.trapped = false;
        break;
      }
      case "patient_picked_up":
        setStatus(belief, event.patientId, "in_ambulance");
        break;
      case "patient_delivered":
        setStatus(belief, event.patientId, "delivered");
        break;
      case "patient_died":
        setStatus(belief, event.patientId, "dead");
        break;
      case "false_alarm":
        setStatus(belief, event.patientId, "false_alarm");
        break;
      case "dispatch_void":
        // The crew found nobody to pick up: whatever we believed, that case is closed.
        if (belief.patients.find((p) => p.id === event.patientId)?.status === "waiting") setStatus(belief, event.patientId, "dead");
        break;
      case "incident_started":
        belief.incidents.push({ id: event.incidentId, kind: event.kind, label: event.label, node: event.node, edge: event.edge, active: true, reportedTick: tick });
        if (event.edge !== null) close(event.edge);
        break;
      case "incident_resolved": {
        const incident = belief.incidents.find((i) => i.id === event.incidentId);
        if (incident) incident.active = false;
        break;
      }
      case "zone_started":
        belief.zones.push({ id: event.zoneId, kind: event.kind, label: event.label, center: event.center, radiusM: event.radiusM, active: true, updatedTick: tick });
        if (event.kind === "flood") flood(event.center, event.radiusM);
        break;
      case "zone_grew": {
        const zone = belief.zones.find((z) => z.id === event.zoneId);
        if (!zone) break;
        zone.radiusM = event.radiusM;
        zone.updatedTick = tick;
        flood(zone.center, zone.radiusM);
        break;
      }
      case "zone_ended": {
        const zone = belief.zones.find((z) => z.id === event.zoneId);
        if (zone) zone.active = false;
        break;
      }
      case "road_closed":
        close(event.edge);
        break;
      case "road_discovered": {
        close(event.edge);
        // A crew hit water beyond the last bulletin's radius: the flood has got at least that far.
        const where = graph.edgeMidpoint(event.edge);
        for (const zone of belief.zones) {
          if (zone.kind !== "flood" || !zone.active) continue;
          const d = distM(zone.center, where);
          if (d > zone.radiusM && d < zone.radiusM + 800) {
            zone.radiusM = Math.round(d + 50);
            zone.updatedTick = tick;
            flood(zone.center, zone.radiusM);
          }
        }
        break;
      }
      case "road_opened":
        belief.closedEdges = belief.closedEdges.filter((e) => e !== event.edge);
        break;
    }
  }
}

function setStatus(belief: Belief, patientId: string, status: PatientStatus): void {
  const patient = belief.patients.find((p) => p.id === patientId);
  if (patient) patient.status = status;
}

/** Best guess of a waiting patient's remaining ticks. */
export function estimatedTtl(patient: Belief["patients"][number], tick: number): number {
  return patient.ttlReported - (tick - patient.reportedTick);
}
