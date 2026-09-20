import type { Call, IncidentFrame, TickRecord } from "../../src/ui/engineTrace";
import type { Run } from "./engineRun";
import { ticketGraph, ticketRun } from "./ticketRun";

export { ticketGraph as interventionGraph };

/** Fixed API snapshots: two urgent incidents become isolated, then resolve; a lesser one stays open.
 * Browser tests exercise operator decisions independently of changes to the simulator's strategy. */
export function interventionRun(): Run {
  const base = ticketRun();
  const empty = base.records[0];
  const template = base.records[1].frame.incidents[0];
  const firstCall = base.records[1].calls[0];
  const cases = [
    { id: "C1", opened: 12, closed: 22, priority: 1 as const },
    { id: "C2", opened: 16, closed: 26, priority: 1 as const },
    { id: "C3", opened: 24, closed: null, priority: 2 as const },
  ];
  const calls: Call[] = cases.map((c, index) => ({
    ...firstCall, id: `L${index + 1}`, tick: c.opened,
    text: `Hay una persona herida y el agua ha cortado el acceso a ${c.id}.`,
  }));
  const records: TickRecord[] = Array.from({ length: 33 }, (_, tick) => {
    const received = calls.filter((call) => call.tick === tick);
    const incidents: IncidentFrame[] = cases.flatMap((c, index) => {
      if (tick < c.opened) return [];
      const closed = c.closed !== null && tick >= c.closed;
      return [{
        ...template, id: c.id, priority: c.priority,
        openedTick: c.opened, updatedTick: closed ? c.closed! : c.opened,
        status: closed ? "closed" : "open", closedReason: closed ? "resolved" : null,
        callIds: [calls[index].id], cutOffIn: 0,
        mechanism: { value: "traffic", from: calls[index].id, tick: c.opened },
        victimsReported: { value: 1, from: calls[index].id, tick: c.opened },
        line: `${c.id} · P${c.priority} · acceso aislado por el agua`,
      }];
    });
    return {
      ...empty, tick, calls: received,
      events: received.map((call) => ({ type: "call_received", tick, call })),
      decision: tick % 2 === 0 ? {
        source: "llm", situation: "Se mantienen las prioridades; no hay medios acuáticos disponibles.",
      } : undefined,
      frame: {
        ...empty.frame, incidents, knownClosedEdges: [0], closedEdges: [0],
        summary: { ...empty.frame.summary, ticks: tick },
      },
    };
  });
  return {
    meta: { ...base.meta, id: "intervention-test", map: ticketGraph.name, ticks: records.length },
    records,
  };
}
