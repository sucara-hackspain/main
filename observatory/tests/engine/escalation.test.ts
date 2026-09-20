import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESCALATION,
  EscalationDesk,
  parseEscalationPolicies,
  type EscalationPolicy,
  type Frame,
  type IncidentFrame,
  type UnitFrame,
} from "../../src/engine";

// The catalogue is what decides when a person is asked. These tests are about that: the same picture
// escalates or not depending on what the catalogue says, and a situation the coordinator fixes closes
// itself without anybody being asked.

const unit = (id: string, extra: Partial<UnitFrame> = {}): UnitFrame => ({
  id, kind: "ambulance", pos: [0, 0], mission: "idle", incidentId: null, victimId: null, hospitalId: null,
  broken: false, stranded: false, route: [], ...extra,
});
const incident = (id: string, extra: Partial<IncidentFrame> = {}): IncidentFrame => ({
  id, status: "open", closedReason: null, mergedInto: null, splitFrom: null, emergencyId: null,
  openedTick: 0, updatedTick: 0, node: 0, locationErrorM: 100, located: false, seenTick: null, seenBy: null,
  sceneId: null, callIds: ["L1"], foci: [], victims: [], priority: 0, unreachable: false, history: [], timeline: [],
  mechanism: null, conscious: null, breathing: null, bleeding: null, trapped: null, ageGroup: null, victimsReported: null,
  triaged: null, line: `${id} · P0`, cutOffIn: null, ...extra,
});
const frame = (units: UnitFrame[], incidents: IncidentFrame[]): Frame => ({
  units, incidents, scenes: [], sites: [], gauges: [], outages: [], outbound: [], floods: [],
  knownWater: { zones: [], sightings: [] }, knownClosedEdges: [], recon: { scouts: [], gaps: [] },
  hospitals: [], closedEdges: [],
  summary: { ticks: 0, victims: 0, saved: 0, dead: 0, waiting: 0, inAmbulance: 0, survivalRate: 1, inWater: 0, reachableSurvivalRate: 1, meanResponseTicks: 0 },
});
/** An urgent incident nobody is working on, with an ambulance free to take it. */
const waiting = frame([unit("A1")], [incident("C1")]);
const review = (desk: EscalationDesk, ticks: number, at: (tick: number) => Frame) =>
  Array.from({ length: ticks }, (_, tick) => desk.review({ tick, frame: at(tick), events: [] })).flat();

describe("escalation desk", () => {
  it("waits as long as the policy says before asking a person", () => {
    const desk = new EscalationDesk();
    const raised = review(desk, 3, () => waiting);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ policyId: "ESC-02", kind: "unassigned", severity: "critical", openedTick: 2, incidentId: "C1", closedTick: null });
    // The same situation is one request, not one per tick.
    expect(review(desk, 3, () => waiting)).toHaveLength(0);
  });

  it("applies the threshold written in the catalogue", () => {
    const slower: EscalationPolicy[] = DEFAULT_ESCALATION.map((p) => (p.id === "ESC-02" ? { ...p, afterTicks: 6 } : p));
    expect(review(new EscalationDesk(slower), 5, () => waiting)).toHaveLength(0);
    expect(review(new EscalationDesk(slower), 6, () => waiting)).toHaveLength(1);
  });

  it("never asks about a policy that is switched off or deleted", () => {
    const off = DEFAULT_ESCALATION.map((p) => (p.id === "ESC-02" ? { ...p, enabled: false } : p));
    expect(review(new EscalationDesk(off), 10, () => waiting)).toHaveLength(0);
    const gone = DEFAULT_ESCALATION.map((p) => (p.id === "ESC-02" ? { ...p, deleted: true } : p));
    expect(review(new EscalationDesk(gone), 10, () => waiting)).toHaveLength(0);
    // Everything else in the catalogue still works.
    const desk = new EscalationDesk(off);
    const raised = desk.review({ tick: 0, frame: frame([unit("A1", { stranded: true, victimId: "V1" })], []), events: [] });
    expect(raised[0]).toMatchObject({ policyId: "ESC-01", kind: "stranded" });
  });

  it("closes a request the coordinator sorted out, saying what happened", () => {
    const desk = new EscalationDesk();
    review(desk, 3, () => waiting);
    const sent = frame([unit("A1", { incidentId: "C1", mission: "to_scene" })], [incident("C1")]);
    const [closed] = desk.review({ tick: 3, frame: sent, events: [] });
    expect(closed).toMatchObject({ kind: "unassigned", closedTick: 3, outcome: "El coordinador envió A1" });
    // Once closed it is not asked again while the crew is on it.
    expect(desk.review({ tick: 4, frame: sent, events: [] })).toHaveLength(0);
  });

  it("reads a hand-written catalogue and says what it had to drop", () => {
    const { policies, skipped } = parseEscalationPolicies([
      { id: "ESC-02", kind: "unassigned", severity: "critical", title: "Sin unidad", body: "Escalar.", afterTicks: 4 },
      { id: "ESC-02", kind: "surge", severity: "warning", title: "Repetida", body: "Escalar." },
      { id: "ESC-99", kind: "inventada", severity: "critical", title: "No existe", body: "Escalar." },
      { id: "ESC-98", kind: "surge", severity: "critical", title: "Sin números", body: "Escalar.", minIncidents: -1 },
      { kind: "surge", severity: "critical", title: "Sin id", body: "Escalar." },
    ]);
    expect(policies.map((p) => p.id)).toEqual(["ESC-02"]);
    expect(skipped).toEqual([
      "ESC-02: identificador repetido",
      "ESC-99: situación desconocida (inventada)",
      "ESC-98: umbrales no numéricos",
      "(sin id): sin identificador",
    ]);
    expect(parseEscalationPolicies({ nope: true }).policies).toEqual([]);
  });
});
