import assert from "node:assert/strict";
import test from "node:test";
import { buildOperations, inQueue, sectorIndex } from "../src/ui/operations/model";
import { createScaleRun } from "../src/ui/operations/demo";
import { buildSituation } from "../src/ui/situation/model";
import { buildTickets } from "../src/ui/tickets/model";
import { ticketGraph, ticketRun } from "./support/ticketRun";

test("sectors preserve individual tickets, archived closures and cases without a valid location", () => {
  const { meta, records } = ticketRun();
  const current = records[5];
  const tickets = buildTickets(records, 30);
  tickets[0] = { ...tickets[0], incident: { ...tickets[0].incident, node: 999999 } };
  const ops = buildOperations(tickets, current, records, ticketGraph, buildSituation(current, meta, records, ticketGraph));
  assert.equal(ops.sectors.flatMap((s) => s.tickets).length, tickets.length);
  assert.equal(new Set(ops.sectors.flatMap((s) => s.tickets.map((t) => t.id))).size, tickets.length);
  assert.equal(ops.open, current.frame.incidents.filter((i) => i.status === "open").length);
  assert.equal(ops.sectors.find((s) => s.name === "Sin ubicación")?.tickets.length, 1);
  assert.equal(ops.calls, 1, "calls present in both events and calls are counted once");
  assert.equal(sectorIndex([ticketGraph.bbox[3], ticketGraph.bbox[2]], ticketGraph), 2);
  assert.equal(sectorIndex(undefined, ticketGraph), 7);
  assert.equal(sectorIndex([0, 0], ticketGraph), 6);
});

test("urgent unconfirmed cases remain visible; reconnaissance and blocked crews do not count as effective attention", () => {
  const { records } = ticketRun();
  const t = buildTickets(records.slice(0, 2), 30).find((t) => t.id === "C1")!;
  t.incident = { ...t.incident, priority: 0, located: false };
  t.crews = [{ ...records[0].frame.units[0], kind: "drone", mission: "to_observe", incidentId: "C1" }];
  assert.equal(inQueue(t, "critical"), true);
  assert.equal(inQueue(t, "unconfirmed"), true);
  t.crews = [{ ...t.crews[0], kind: "ambulance", mission: "to_scene", stranded: true }];
  assert.equal(inQueue(t, "critical"), true);
  assert.equal(inQueue(t, "blocked"), true);
  t.crews[0].stranded = false;
  assert.equal(inQueue(t, "critical"), false);
  t.incident = { ...t.incident, status: "closed" };
  assert.equal(inQueue(t, "unconfirmed"), false);
});

test("the scale workload retains 2,400 cases and 12,000 calls; rewinding never exposes future activity", () => {
  const { meta, records } = createScaleRun(ticketGraph);
  const current = records.at(-1)!;
  const tickets = buildTickets(records, 30);
  const ops = buildOperations(tickets, current, records, ticketGraph, buildSituation(current, meta, records, ticketGraph));
  assert.equal(tickets.length, 2400);
  assert.equal(ops.calls, 12000);
  assert.equal(ops.open, 1866);
  assert.equal(ops.sectors.reduce((n, s) => n + s.available, 0), 24);
  assert.ok(ops.sectors.some((s) => s.stale > 0));
  const earlier = records[1], history = records.slice(0, 2);
  const past = buildOperations(buildTickets(history, 30), earlier, records, ticketGraph, buildSituation(earlier, meta, history, ticketGraph));
  assert.equal(past.open, 400);
  assert.equal(past.calls, 2000);
  assert.equal(past.sectors.reduce((n, s) => n + s.stale, 0), 0);
  assert.ok(past.trend.every((point) => point.tick <= earlier.tick));
});
