import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, RunMeta, TickRecord } from "../engineTrace";
import {
  byUrgency,
  detectInterventions,
  interventionsAt,
  prescribe,
  type InterventionView,
  type OperatorDecision,
  type Option,
  type Pending,
} from "./model";
import { createRouter, knownFlooded } from "./routing";

/**
 * Operator decisions for the current pass over the timeline, in memory: the engine does not take
 * operator orders yet. Going back before a decision undoes it, so replaying asks again.
 */
function useDecisions(tick: number | undefined) {
  const [decisions, setDecisions] = useState<Record<string, OperatorDecision>>(
    {},
  );
  const last = useRef(tick);
  useEffect(() => {
    const previous = last.current;
    last.current = tick;
    if (tick === undefined || previous === undefined || tick >= previous)
      return;
    setDecisions((all) => {
      const kept = Object.entries(all).filter(([, d]) => d.tick <= tick);
      return kept.length === Object.keys(all).length
        ? all
        : Object.fromEntries(kept);
    });
  }, [tick]);
  const record = useCallback(
    (decision: OperatorDecision) =>
      // decision.action is the order Simulation.order() takes: send it from here once the run API accepts it.
      setDecisions((all) => ({ ...all, [decision.interventionId]: decision })),
    [],
  );
  const undo = useCallback(
    (interventionId: string) =>
      setDecisions(({ [interventionId]: _removed, ...rest }) => rest),
    [],
  );
  return { decisions, record, undo };
}

export function useInterventions({
  ticks,
  current,
  graph,
  meta,
}: {
  ticks: TickRecord[];
  current: TickRecord | undefined;
  graph: GraphData | null;
  meta: RunMeta | null;
}) {
  const { decisions, record, undo } = useDecisions(current?.tick);
  // Stand-in for decision requests from the backend: derived from the records until the run API sends them.
  const all = useMemo(() => detectInterventions(ticks), [ticks]);
  const config = meta?.config;
  const routes = useMemo(
    () => (graph && config ? createRouter(graph, config) : null),
    [graph, config],
  );
  // Travel as the coordinator could plan it at the selected instant: its known closures and water.
  const router = useMemo(
    () =>
      routes && current && graph
        ? routes(current.frame.knownClosedEdges, knownFlooded(ticks, current, graph))
        : null,
    [routes, current, ticks, graph],
  );
  const views = useMemo(
    () => (current ? interventionsAt(all, current.tick, decisions) : []),
    [all, current, decisions],
  );
  const pending = useMemo(() => {
    if (!current || !meta || !router) return [];
    return views
      .filter((item) => item.status === "pending")
      .flatMap((item): Pending[] => {
        const prescription = prescribe(item, current, meta, router);
        return prescription ? [{ item, prescription }] : [];
      })
      .sort(byUrgency);
  }, [views, current, meta, router]);
  const history = useMemo(
    () =>
      views
        .filter((item) => item.status !== "pending")
        .sort((a, b) => b.openedTick - a.openedTick),
    [views],
  );
  const decide = useCallback(
    (item: InterventionView, option: Option, prescribed: Option) => {
      if (!current) return;
      record({
        interventionId: item.id,
        optionId: option.id,
        label: option.label,
        approved: option.id === prescribed.id,
        action: option.action,
        tick: current.tick,
        at: new Date().toISOString(),
      });
    },
    [current, record],
  );
  /** Next tick after the selected one where an exception opens, for jumping through a finished run. */
  const nextTick = all.find(
    (item) => item.openedTick > (current?.tick ?? 0),
  )?.openedTick;
  return { pending, history, decide, undo, nextTick, router };
}
