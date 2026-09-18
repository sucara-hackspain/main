# crisis-sim

Turn-based emergency simulator on a real street map (Valencia by default). A **master** tells a flash-flood story and breaks things, a **coordinator** (rules or Claude) moves the emergency services with late and imperfect information, and the score is lives saved.

```
pnpm run-sim                      # DANA story, Claude coordinator (claude -p, haiku), traced -> runs/<id>/
pnpm run-sim --model sonnet --seed 2 --ticks 200
pnpm run-sim --coordinator greedy # rule-based baseline on the same story
pnpm ui                           # http://localhost:5173: follow a run live or replay it
pnpm sim --runs 20 --quiet        # greedy benchmark over 20 seeds, no traces
pnpm sim --scenario random        # no story, just dice
pnpm test
pnpm fetch-graph madrid 40.38,-3.75,40.48,-3.63   # another city: south,west,north,east
```

## The world

| Thing | What it does |
| --- | --- |
| **Units** | `svb` basic ambulance, `sva` advanced ambulance (a critical patient only holds on with a doctor on board), `heli` (flies straight, lands only at helipad hospitals, winches people out of the flood), `fire` (puts fires out, frees trapped people, wades slowly through flooded streets), `police` (clears blocked roads). Start at real hospitals, fire stations and police stations from OpenStreetMap. Up to 3 backup units can be requested from neighbouring towns (50 ticks away). |
| **Patients** | Severity `leve / grave / critico` sets how long they last; `need` (trauma, quemados) sets which hospital is right; `trapped` means nobody can load them until a fire crew frees them (an ambulance waiting beside them keeps them alive). |
| **Hospitals** | Beds, specialities, helipad, and they can go out of service (the water reaches one). Wrong speciality = 60 % of the points. |
| **Incidents** | `accident`, `fire` (keeps producing burn victims until it is out), `collapse`, `flood_rescue`, `obstacle` (fallen tree...). They block roads, trap people and need crews working on them. |
| **Zones** | `flood`: grows every tick and swallows streets. `no_coverage`: calls from inside do not get out until it ends or a unit drives within 400 m. |
| **Score** | Critical 3, serious 2, minor 1. |

## Information is late, partial and sometimes wrong

The coordinator never reads the world, only `Report`s that the `FieldObserver` lets through:

- 112 calls arrive 1-9 ticks late and the severity is a bystander's guess; it becomes exact when a unit examines the patient. Some calls are false alarms.
- Victims of an incident trickle in call by call, or all at once when the first unit reaches the scene.
- Nobody announces a closed road. Dispatch learns it from the incident report, from the flood bulletin (every 10 ticks, already outdated) or because a unit **drives into it**, loses 2 ticks turning around and radios it in. Routes and ETAs only avoid what is known.
- A crew that hits water beyond the last bulletin's radius makes dispatch infer the flood has grown that far.
- Our own radios, GPS and hospital systems are instant and exact.

The UI has a switch between **reality** and **what the coordinator knows**: faint dots are victims nobody has phoned in yet, dashed dark red lines are closures nobody knows about.

## One tick (30 simulated seconds)

1. **Master** acts (`DanaMaster`: flood at t10, pile-up at t28, mobile network down at t45, building fire at t65, helicopter grounded at t100, building collapse at t125, second flood at t155; plus everyday noise).
2. **World advances**: units drive/fly/work, fires spread victims, water rises, patients lose time to live.
3. **Observer** decides which reports reach dispatch this tick; they are folded into the `Belief`.
4. **Coordinator** is woken only if something decision-relevant changed, and answers with `Action`s: `dispatch`, `transport`, `assist`, `reposition`, `request_backup`.

## Where things are

| File | What |
| --- | --- |
| `src/engine/types.ts` | Entities, actions, events. All plain JSON. |
| `src/engine/graph.ts` | Street graph + Dijkstra. Closing a road = closing an edge id. |
| `src/engine/engine.ts` | Rules of the world: orders, movement, incidents, flood, score. |
| `src/engine/master.ts` | `Master` interface, `DanaMaster` (the story) and `RandomMaster` (dice). All seeded. |
| `src/engine/observer.ts` | `FieldObserver`: delays, guesses, dead zones. Reports -> belief. |
| `src/engine/coordinator.ts` | `Coordinator` interface + `GreedyCoordinator` baseline. |
| `src/engine/sim.ts` | The loop. `inject()` / `order()` let a human play master or override the coordinator. |
| `src/engine/briefing.ts` | Situation report for an LLM, with every ETA precomputed. Skips the call when nothing is decidable. |
| `src/engine/trace.ts` | On-disk run format: `meta.json`, `ticks.jsonl`, `llm.jsonl` (full prompts), `run.log`. |
| `src/coordinators/claude-cli.ts` | LLM coordinator on headless Claude Code, extended thinking off (5-10 s per decision instead of 60+). Falls back to greedy on timeout/error. |
| `src/run.ts` | Traced runner. |
| `ui/` | React + MapLibre viewer. Reads `runs/` through a Vite middleware. |
| `scripts/fetch-graph.ts` | OpenStreetMap (Overpass) -> `data/<name>.json`. |

To plug another brain in, implement `Coordinator.decide()` (it can be async). Same for `Master.act()`.

maplibre-gl is pinned to v5: v6 ships its worker as a separate ESM file that Vite's dep optimizer breaks (map stays black).
