import { DEFAULT_CONFIG } from "../../../gabriel/src/engine/engine";
import type { Action, Call, GraphData, IncidentFrame, RunMeta, TickRecord, UnitFrame } from "../../src/ui/engineTrace";

export const ticketGraph: GraphData = {
  name: "ticket-test", bbox: [39.44, -0.4, 39.49, -0.35], nodes: [[-0.38, 39.47], [-0.37, 39.46]],
  edges: [{ a: 0, b: 1, len: 500, kph: 40, oneway: false, geom: [[-0.38, 39.47], [-0.37, 39.46]] }], hospitals: [],
};
export function ticketRun() {
  const meta: RunMeta = {
    id: "ticket-test", map: "ticket-test", seed: 1, ticks: 31, coordinator: "test", model: null,
    config: DEFAULT_CONFIG, startedAt: "2026-09-19T08:00:00Z", status: "finished", summary: null,
    hospitals: [{ id: "H1", name: "Hospital General", node: 1, capacity: 20, helipad: true }],
  };
  const incident = (id: string, extra: Partial<IncidentFrame> = {}): IncidentFrame => ({
    id, status: "open", closedReason: null, mergedInto: null, emergencyId: null, openedTick: 1, updatedTick: 1,
    node: 0, locationErrorM: 120, located: false, sceneId: null, callIds: [`L${id.slice(1)}`],
    mechanism: { value: "traffic", from: "112", tick: 1 }, conscious: null, breathing: null, bleeding: null,
    trapped: null, ageGroup: null, victimsReported: { value: 1, from: "112", tick: 1 }, victims: [],
    priority: 2, unreachable: false, history: [], line: `${id} · accidente de tráfico`, cutOffIn: null, ...extra,
  });
  const unit = (id: string, extra: Partial<UnitFrame> = {}): UnitFrame => ({
    id, kind: "ambulance", pos: ticketGraph.nodes[1], mission: "idle", incidentId: null,
    victimId: null, hospitalId: null, broken: false, stranded: false, route: [], ...extra,
  });
  const call: Call = {
    id: "L1", tick: 1, caller: "bystander", mechanism: "traffic", node: 0, locationErrorM: 120,
    street: "Avinguda del Cid", conscious: "yes", breathing: "normal", bleeding: "unknown", trapped: "unknown",
    ageGroup: "adult", victims: 1, text: "Un coche ha chocado. Hay una persona herida, parece consciente.",
  };
  const empty: TickRecord = { tick: 0, events: [], calls: [], actions: [], frame: {
    units: [unit("A1"), unit("A2")], incidents: [], scenes: [], floods: [], knownWater: { zones: [], sightings: [] },
    knownClosedEdges: [], closedEdges: [], hospitals: [{ id: "H1", occupied: 0 }],
    summary: { ticks: 0, victims: 0, saved: 0, dead: 0, waiting: 0, inAmbulance: 0, survivalRate: 1, inWater: 0, reachableSurvivalRate: 1, meanResponseTicks: null },
  } };
  const c1 = incident("C1");
  const others = [
    incident("C2", { mechanism: { value: "flooded_home", from: "112", tick: 1 } }),
    incident("C3", { mechanism: { value: "fall", from: "112", tick: 1 }, priority: 3 }),
    incident("C4", { mechanism: { value: "vehicle_trapped", from: "112", tick: 1 } }),
    incident("C5", { status: "closed", closedReason: "resolved", mechanism: { value: "collapse", from: "112", tick: 1 } }),
    incident("C6", { mechanism: { value: "building_collapse", from: "112", tick: 1 } }),
  ];
  const received: TickRecord = { ...empty, tick: 1, calls: [call], events: [{ type: "call_received", tick: 1, call }], frame: { ...empty.frame, incidents: [c1, ...others] } };
  const action: Action = { type: "dispatch", unitId: "A1", incidentId: "C1", node: 0, hospitalId: "H1" };
  const otherAction: Action = { type: "dispatch", unitId: "A2", incidentId: "C2", node: 0 };
  const dispatched: TickRecord = { ...received, tick: 2, calls: [], actions: [action, otherAction],
    decision: { source: "llm", situation: "Dos avisos requieren una primera valoración.", reasons: ["A1 es la ambulancia disponible más cercana; enviarla permite confirmar la gravedad.", "A2 cubre el aviso de la vivienda."] },
    events: [{ type: "action_applied", tick: 2, action, etaTicks: 2 }, { type: "action_applied", tick: 2, action: otherAction, etaTicks: 3 }],
    frame: { ...received.frame, units: [unit("A1", { incidentId: "C1", mission: "to_scene", hospitalId: "H1" }), unit("A2", { incidentId: "C2", mission: "to_scene" })] },
  };
  const victims: IncidentFrame["victims"] = [{ id: "V1", injury: "cardiac_arrest", triage: "red", status: "waiting", trapped: false }];
  const assessed: TickRecord = { ...dispatched, tick: 4, actions: [], decision: undefined,
    events: [{ type: "scene_assessed", tick: 4, unitId: "A1", incidentId: "C1", sceneId: "S1", node: 0, victims }],
    frame: { ...dispatched.frame, incidents: [{ ...c1, priority: 0, updatedTick: 4, located: true, sceneId: "S1", locationErrorM: 0, victims }, ...others] },
  };
  const resolved: TickRecord = { ...assessed, tick: 6,
    events: [{ type: "victim_delivered", tick: 6, victimId: "V1", unitId: "A1", hospitalId: "H1" }],
    frame: { ...assessed.frame, units: [unit("A1", { incidentId: "C2", mission: "to_scene" }), dispatched.frame.units[1]],
      incidents: [{ ...assessed.frame.incidents[0], status: "closed", closedReason: "resolved", updatedTick: 6, victims: [{ ...victims[0], status: "delivered" }] }, ...others] },
  };
  const archived: TickRecord = { ...resolved, tick: 30, events: [], frame: { ...resolved.frame, incidents: others.filter((i) => i.status === "open") } };
  return { meta, records: [empty, received, dispatched, assessed, resolved, archived] };
}
