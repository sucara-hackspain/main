import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTickets, ticketNextStep } from "../src/ui/tickets/model";
import { ticketRun } from "./support/ticketRun";

test("tickets evolve through triage, dispatch, assessment and resolution without leaking future information", () => {
  const { records, meta } = ticketRun();
  const at = (end: number) => buildTickets(records.slice(0, end), meta.config.tickSeconds).find((t) => t.id === "C1")!;
  assert.equal(buildTickets(records.slice(0, 1), 30).length, 0);
  assert.equal(at(2).state, "triage");
  assert.equal(at(2).steps.some((s) => s.kind === "action"), false);
  assert.equal(at(3).state, "progress");
  assert.match(ticketNextStep(at(3)).title, /Esperando valoración/);
  assert.match(at(3).steps.find((s) => s.kind === "action")!.reason!, /más cercana/);
  assert.equal(at(3).steps.some((s) => s.reason?.includes("vivienda")), false);
  assert.equal(at(3).steps.some((s) => s.kind === "assessment"), false);
  assert.match(at(4).steps.find((s) => s.kind === "alert")!.title, /más grave/);
  assert.equal(at(5).state, "resolved");
  assert.equal(at(6).state, "resolved");
  assert.equal(at(6).lastSeenTick, 6);
  assert.equal(at(6).steps.filter((s) => s.kind === "resolved").length, 1);
});

test("hospital arrivals stay with the original victim's ticket when the unit has a new assignment", () => {
  const { records } = ticketRun();
  const tickets = buildTickets(records, 30);
  assert.ok(tickets.find((t) => t.id === "C1")!.steps.some((s) => s.title === "V1 ingresa en H1"));
  assert.equal(tickets.find((t) => t.id === "C2")!.steps.some((s) => s.title.includes("V1")), false);
});

test("rejected and unconfirmed orders never mark a triage ticket as dispatched", () => {
  const { records } = ticketRun();
  const action = records[2].actions[0];
  const proposed = { ...records[1], tick: 2, calls: [], events: [], actions: [action] };
  const pending = buildTickets([records[1], proposed], 30).find((t) => t.id === "C1")!;
  assert.equal(pending.state, "triage");
  assert.match(pending.steps.at(-1)!.detail!, /Pendiente de confirmación/);
  const rejected = { ...proposed, events: [{ type: "action_rejected" as const, tick: 2, action, reason: "No hay ruta" }] };
  const ticket = buildTickets([records[1], rejected], 30).find((t) => t.id === "C1")!;
  assert.equal(ticket.state, "triage");
  assert.match(ticket.steps.at(-1)!.title, /rechazada/);
  assert.match(ticket.steps.at(-1)!.reason!, /Sin justificación registrada/);
});

test("waiting summaries attach only to incidents explicitly named by the coordinator", () => {
  const { records } = ticketRun();
  const wait = { ...records[1], tick: 2, calls: [], events: [], decision: { source: "llm" as const, situation: "C1 espera información de la dotación; C10 requiere otra unidad." } };
  const tickets = buildTickets([records[1], wait], 30);
  assert.ok(tickets.find((t) => t.id === "C1")!.steps.some((s) => s.detail?.includes("espera información")));
  assert.equal(tickets.find((t) => t.id === "C2")!.steps.some((s) => s.detail?.includes("espera información")), false);
  wait.decision.situation = "C10 espera información";
  assert.equal(buildTickets([records[1], wait], 30).find((t) => t.id === "C1")!.steps.some((s) => s.detail?.includes("C10")), false);
});

test("the 112 desk reads in the case file: the triage agent and the ring-back are named", () => {
  const { records } = ticketRun();
  const file = [
    { tick: 1, kind: "call" as const, from: "L1", callId: "L1", text: "Un coche ha chocado." },
    { tick: 1, kind: "update" as const, from: "triaje 112", callId: "L1", flag: "alert" as const, text: "Triaje 112 de L1: critical — no responde y el agua sube" },
    { tick: 2, kind: "update" as const, from: "seguimiento 112", callId: "L1", text: "Seguimiento de L1: ha empeorado, no responde" },
    { tick: 2, kind: "update" as const, from: "reglas", text: "prioridad: P2 → P0" },
  ];
  const triaged = { priority: 0 as const, reasoning: "no responde y el agua sube", tick: 1, from: "triaje 112" };
  const withDesk = records.map((r) => ({ ...r, frame: { ...r.frame,
    incidents: r.frame.incidents.map((i) => i.id === "C1" ? { ...i, timeline: r.tick >= 2 ? file : [], triaged } : i) } }));
  const ticket = buildTickets(withDesk.slice(0, 3), 30).find((t) => t.id === "C1")!;
  assert.deepEqual(ticket.steps.map((s) => s.source), ["112 · llamada", "Triaje 112 · agente", "Seguimiento 112 · llamada de vuelta", "Protocolo de triaje"]);
  assert.deepEqual(ticket.incident.triaged, triaged);
  // Runs recorded before the desk existed carry no reading at all.
  assert.equal(records[2].frame.incidents[0].triaged ?? null, null);
});
