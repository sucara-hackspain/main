# crisis-sim

Turn-based emergency simulator on a real street map (Valencia by default). A **master** breaks things, a **coordinator** moves ambulances, and the score is lives saved.

```
pnpm sim                          # one run, full event log
pnpm sim --seed 7 --ticks 480     # same seed = same scenario
pnpm sim --runs 20 --quiet        # average score over 20 seeds
pnpm run-sim                      # traced run with the Claude coordinator (claude -p, haiku) -> runs/<id>/
pnpm run-sim --coordinator greedy --seed 1 --ticks 120
pnpm ui                           # http://localhost:5173: follow a run live or replay it
pnpm test
pnpm fetch-graph madrid 40.38,-3.75,40.48,-3.63   # another city: south,west,north,east
```

## One tick (30 simulated seconds)

1. **Master** acts: spawn patient, close/open road, puncture ambulance (`MasterAction`).
2. **World advances**: ambulances drive, patients lose time to live, pickups/deliveries/deaths happen.
3. **Observer** turns the new events into `Report`s and folds them into the coordinator's `Belief`.
4. **Coordinator** is woken only if there are new reports, and answers with `Action`s: `dispatch`, `transport`, `reposition`.

The coordinator never reads `World`, only `Belief`. Today reports are truthful; noise, delays and false calls go in `Observer`.

## Where things are

| File | What |
| --- | --- |
| `src/engine/types.ts` | Entities, actions, events. All plain JSON. |
| `src/engine/graph.ts` | Street graph + Dijkstra. Closing a road = closing an edge id. |
| `src/engine/engine.ts` | Rules: apply actions, move ambulances, score. |
| `src/engine/master.ts` | `Master` interface + seeded `RandomMaster`. |
| `src/engine/observer.ts` | World events -> reports -> belief. |
| `src/engine/coordinator.ts` | `Coordinator` interface + `GreedyCoordinator` baseline. |
| `src/engine/sim.ts` | The loop. `inject()` / `order()` let a human play master or override the coordinator. |
| `src/engine/briefing.ts` | Situation report for an LLM, with every ETA precomputed. Skips the call when nothing is decidable. |
| `src/engine/trace.ts` | On-disk run format: `meta.json`, `ticks.jsonl`, `llm.jsonl` (full prompts), `run.log`. |
| `src/coordinators/claude-cli.ts` | LLM coordinator on headless Claude Code. Falls back to greedy on timeout/error. |
| `src/run.ts` | Traced runner. |
| `ui/` | React + MapLibre viewer. Reads `runs/` through a Vite middleware. |
| `scripts/fetch-graph.ts` | OpenStreetMap (Overpass) -> `data/<name>.json`. |

To plug another brain in, implement `Coordinator.decide()` (it can be async). Same for `Master.act()`.

maplibre-gl is pinned to v5: v6 ships its worker as a separate ESM file that Vite's dep optimizer breaks (map stays black).
