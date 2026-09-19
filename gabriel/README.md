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

## Truth vs. what the coordinator knows

The world holds **scenes** (a crash, a collapse, a fire) with **victims** that have a real injury, real signs and a real time to live (`victims.ts`). The coordinator never sees any of that. It gets:

1. **112 calls** (`observer.ts`): answers to the operator's protocol questions - where (roughly), what happened, conscious?, breathing?, bleeding?, how many. Quality depends on who calls: a relative is precise, a driver passing by barely knows anything and can be wrong. No diagnosis, no time to live.
2. **Incidents** (`incidents.ts`): calls about the same place/time/kind are attached to one incident. Priority P0-P3 is *deduced* from the signs by protocol. Every field remembers which call or radio message it came from.
3. **Crew radio**: the ambulance drives to the reported spot, looks for the real scene nearby, triages everyone (red/yellow/green/black) and reports. That overrides the calls. It loads the worst victim; minor ones are treated on the spot.

Orders go to an incident, not to a victim. If nobody comes, someone calls again.

### The DANA and what is known about the water

`DanaMaster` plays a flood night: ordinary emergencies first, then water comes out at two points and spreads. Each flood has an impassable core (streets closed, never reopened) and a shallow fringe where cars stall and ground floors fill but ambulances still get through. Scenes happen in the fringe, in the rest of the city, and inside the core - those call 112 like everyone else, but no ambulance can reach them (`unreachable` incidents: they need a boat).

Nobody tells the coordinator where the water is (`water.ts`):

- **Sightings**: flood calls ("wet") and crews that run into a flooded street, radio it in and turn back ("blocked"). Routes only avoid closures that are *known*; the rest are found on the ground.
- **Official maps** every 24 ticks, showing the water as it was 10 ticks earlier. The coordinator extrapolates the front from the difference between maps.
- **Cut-off forecast**: a neighbourhood is lost when its last bridge goes under, however far the water is, so the forecast projects the believed water forward and checks road connectivity to a dry hospital.

### Units

| Kind | Does | Limits |
| --- | --- | --- |
| Ambulance (A) | Carries one victim to hospital by road | Stops at the water |
| Firefighters (B) | Free trapped victims, treat minor ones | Carry nobody; stop at the water |
| Water rescue (R) | Drives through flooded streets (4x slower), frees and carries | Few and slow |
| Helicopter (HEL) | Flies straight at 180 km/h, ignores streets and water | One; one victim; only hospitals with a helipad |

A trapped victim (car, rubble) cannot be loaded by anyone until firefighters or a rescue crew free them: callers are asked "can they get out?", so the coordinator may know before anyone arrives.

Emergency vehicles may drive against one-way streets (3x slower): otherwise a flooded exit traps them on a one-way carriageway for good.

## Memory: doctrine, hindsight and the dream

The agent (HappyRobot or Claude; never the greedy baseline) decides with a long-term memory that sessions reshape.

1. **Doctrine in, citations out.** `memory/memory.db` (SQLite, built into Node) holds the memory as a graph. Its live rules - principles (D), heuristics (H), mistakes to avoid (A) - are rendered into ~30 lines and placed before every briefing. Each order comes back with `applies: ["H5","D2"]`: the ids the agent says it followed. Made-up ids are dropped.
2. **Hindsight** (`src/memory/evaluate.ts`, rules only). When the session ends the evaluator reads the ground truth the coordinator never had and gives every death and wasted trip a cause: never dispatched, arrived late, trapped with nobody to free them, left waiting for a second unit, died in transport, inside the water, nobody there, turned back by the water, hospital full. Critical saves count as evidence too. Written to `runs/<id>/evaluation.json`.
3. **Dream** (`src/memory/dream-protocol.ts`). A HappyRobot workflow (Claude/sonnet if `HAPPYROBOT_DREAM_*` is not set) reads the evaluation, how often each rule was cited and the current memory, and returns operations: `reinforce`, `weaken`, `rewrite`, `add`, `merge`, `retire`, each citing the evidence behind it, plus a few sentences of lessons.
4. **Consolidation** (`src/memory/consolidate.ts`). New rules start *on trial* and become doctrine only when a later session backs them; rules nobody can defend sink below 0.25 and are retired. Nothing is deleted: episodes, evidence, retired rules and every change stay in the graph. `memory/MEMORY.md` is a generated snapshot of what the agent reads.

```
pnpm run-sim --coordinator happyrobot   # session -> evaluation -> dream -> memory, all in one
pnpm run-sim --no-memory                # same agent without the doctrine: what is the memory worth?
pnpm dream [runId] [--dry-run]          # dream again over a finished session
pnpm hr:sync --dream                    # push the dream's prompt + schema to its HappyRobot workflow
```

The starting doctrine is `src/memory/seed.ts`; delete `memory/memory.db` to go back to it. The viewer's **Memoria** tab draws the graph: rules hang from the concepts they are about, sessions and their evidence from the rules they backed or undermined. Click anything to see what it says, where it came from and how it changed.

## One tick (30 simulated seconds)

1. **Master** acts: spawn scene, close/open road, puncture ambulance (`MasterAction`).
2. **World advances**: ambulances drive, victims deteriorate (each injury at its own pace), crews assess, load, treat, deliver.
3. **Observer** turns what happened into `Report`s (calls, radio, hospital, traffic) and they are folded into the coordinator's `Belief`.
4. **Coordinator** is woken only if there are new reports, and answers with `Action`s: `dispatch` (to an incident), `transport`, `reposition`.

## Where things are

| File | What |
| --- | --- |
| `src/engine/types.ts` | Entities, actions, events. All plain JSON. |
| `src/engine/graph.ts` | Street graph + Dijkstra. Closing a road = closing an edge id. |
| `src/engine/engine.ts` | Rules: apply actions, move ambulances, score. |
| `src/engine/master.ts` | `Master` interface + seeded `RandomMaster`. |
| `src/engine/victims.ts` | Clinical model: injuries, how fast each kills, triage, victim generation. |
| `src/engine/observer.ts` | Who calls 112, what they know and how wrong they are; which world events get reported at all. |
| `src/engine/water.ts` | The coordinator's picture of the flood: sightings, stale official maps, extrapolation, cut-off forecast. |
| `src/engine/incidents.ts` | Coordinator side: attach calls to incidents, deduce priority, merge, close. Reads reports only. |
| `src/engine/coordinator.ts` | `Coordinator` interface + `GreedyCoordinator` baseline. |
| `src/engine/sim.ts` | The loop. `inject()` / `order()` let a human play master or override the coordinator. |
| `src/engine/briefing.ts` | Situation report for an LLM, with every ETA precomputed. Skips the call when nothing is decidable. |
| `src/engine/trace.ts` | On-disk run format: `meta.json`, `ticks.jsonl`, `llm.jsonl` (full prompts), `run.log`. |
| `src/coordinators/claude-cli.ts` | LLM coordinator on headless Claude Code. Falls back to greedy on timeout/error. |
| `src/memory/` | The agent's long-term memory: graph store, seed doctrine, hindsight evaluator, dream protocol and back ends, consolidation. |
| `src/run.ts` | Traced runner: session, then evaluation, then dream. |
| `ui/` | React + MapLibre viewer: map (truth vs. belief), incident board, knowledge graph. Reads `runs/` through a Vite middleware. |
| `scripts/fetch-graph.ts` | OpenStreetMap (Overpass) -> `data/<name>.json`. |

To plug another brain in, implement `Coordinator.decide()` (it can be async). Same for `Master.act()`.

maplibre-gl is pinned to v5: v6 ships its worker as a separate ESM file that Vite's dep optimizer breaks (map stays black).
