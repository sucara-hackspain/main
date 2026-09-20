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
4. **Aerial reports** (`scout`): what a drone or the helicopter thinks it saw over a place. See below.

Orders go to an incident, not to a victim. If nobody comes, someone calls again.

### Going to look for what nobody told you

Not every scene calls. Some are **silent**: nobody saw it, the line is down, the phone is gone, nobody is left conscious. Inside the water most of them are (`pSilentInWater`). Dispatch never hears about them at all, so the only way they are ever known is an order to go and look.

`scout {unitId, node}` sends an observer (drone, or the helicopter when it is not needed to carry anyone) over a place. The engine records the truth in sight (`area_surveyed`); the observer degrades it into what gets radioed back (`drone_report`), and only that reaches the belief:

- one roll per flight sets how good the look was, and everything else degrades from there;
- whole scenes are missed - what happens on a flooded street is obvious from above, what happens inside a ground floor is not (`VISIBLE_FROM_AIR`);
- counts come back off by one, or as "cannot count"; "not moving" is the hardest call and the one that matters most;
- water and closed streets, on the other hand, read very well from the air.

A sighting with no matching incident **opens one**, without ever confirming it: a scouted incident is never `located`, keeps a location error and holds no triage. Only a crew on the ground confirms.

**Silence as information** (`recon.ts`). The city is cut into ~700 m zones. A zone that was calling and went quiet, or that never called while its neighbours did, or that the water is reaching without a word from it, is ranked as a hole in the picture: either there is nobody there, or there is nobody left who can call. `infoGaps()` ranks those holes together with the incidents being decided blind (±400 m, number of victims unknown, no road access), the briefing prints them under **LO QUE NO SABES** with an ETA per observer, and the greedy baseline sends idle drones to the top one.

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
| Helicopter (HEL) | Flies straight at 180 km/h, ignores streets and water; can also scout | One; one victim; only hospitals with a helipad |
| Drone (D) | Flies at 80 km/h and looks: the only way to learn about a place nobody has called from | Rescues nobody; never confirms anything |

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

## An agent on the other side too: the master

`--master happyrobot` hands the night to an agent in a HappyRobot workflow (`src/masters/`). Every 10 ticks it is shown the night so far - stats, what just happened (the coordinator's orders included), a dozen places it may use (dry, at the water's edge, inside the water; how far the nearest free unit is; how many turns until the water cuts them off), streets it may cut, the fleet - and answers with one sentence of narration plus what happens next: up to three scenes (place, kind, how many hurt, how bad, trapped, silent), one new flood from a list of sources, one street cut, one breakdown. It picks by index and by name, never a node or an edge, and whatever the map does not have is dropped and logged. What it decides is spread over the ticks of the turn; the water, once out, advances on its own. Turns are traced to `runs/<id>/master.jsonl`, and the narration reaches the viewers as a `master_narration` event the coordinator never hears.

```
pnpm run-sim --coordinator happyrobot --master happyrobot   # agent against agent
pnpm hr:sync --master                                       # push the master's prompt + schema (forks the locked version)
```

`--calls happyrobot` has the `sim-112` workflow word each 112 call. The facts stay the engine's (who calls, what they could tell, how sure of the place): the agent only gets the call as the operator filed it, and if its answer is not about that call the engine's wording is kept. It needs `sim-112` behind a webhook trigger; as a workflow-called trigger it never receives the payload.

## The 112 desk: an agent that triages, an agent that calls

`--desk happyrobot` puts two HappyRobot agents on the 112 desk, started inside the tick after the master has acted and before the coordinator decides. Neither holds the tick: the runs go on in the background and what comes back lands on the following ticks, so it is meant for a real-time pace (`--tick-ms`). Triage runs for every call the tick it comes in (`--triage-every` 1, a few seconds per verdict); the generator runs every `--desk-every` ticks (9).

1. **`112-coordinator`** (a call generator, whatever its name) invents a batch of callers for the scenario, some of them a deliberate second report of an earlier emergency. Each call enters exactly as a real one does (`Simulation.phone`): what it describes becomes true where it says, and the call reaches the board marked `source: "agent"`.
2. **`112-triage`** reads every new call, one run per call, against the board as the rules built it at that moment: whether it belongs to an open incident or is something new, and what priority (`critical > high > medium > low`, a child or an elderly person one level up, never down). The engine keeps its own grouping (one place, one response) and takes the agent's priority as a floor on the incident holding the call (`Incident.triaged`), until a crew is on the spot: what a crew radios beats every call. Where the agent would have filed the call somewhere else, the case file says so.

Both are traced to `runs/<id>/desk.jsonl`. The ids of the two workflows default to the hackathon's (`.env.example`). The generator is handed a dozen real streets from the map each turn, so its calls land where they say; `pnpm hr:generator` republishes the workflow repair that makes it read them (its trigger keeps the payload under `data`).

```
pnpm run-sim --coordinator happyrobot --master happyrobot --desk happyrobot --tick-ms 1000
```

## The real 112 line

`--phone` opens the session to the outside: whoever phones the HappyRobot 112 number talks to its voice agent, which files the call as the engine's own `Call` record once they hang up (`Build Call Object` in the `112` workflow). The session polls that workflow's runs every few seconds (`src/phone/happyrobot.ts`; polling because a laptop has no address to post to) and every call finished since it started goes in through `Simulation.phone()`: the street the caller said is looked up on the map (`Graph.findStreet`, forgiving about accents, "calle/carrer" and Spanish or Valencian spellings), what they described becomes a real emergency there - the worst victim as bad as their answers to the protocol - and their call reaches the coordinator on the next tick like any other, numbered with the rest and marked `source: "phone"`. Nobody else calls about it, but if nobody comes they are rung back like everyone else. Use a real-time pace, e.g. `pnpm run-sim --coordinator happyrobot --phone --tick-ms 1000`; calls taken are kept in `runs/<id>/phone.jsonl`.

**Ringing them back.** A real call carries the caller's number (the workflow's POST node sends it alongside the record). `--followup-after` ticks later (10), if the case is still low or medium priority, the `112-outbound` voice agent ("Seguimiento 112") rings the number, asks how it is going and files a report (`src/phone/followup.ts`, traced to `runs/<id>/followups.jsonl`). No answer: one more try. Worse, red flags, or asked for help: the open case's priority floor goes to P1, and a case already closed comes back in as a new call marked `source: "outbound"`, at the street the person says they are now. Critical and high cases are never rung: a crew is on its way. The dialler sleeps outside business hours, so out of hours the report arrives when it wakes.

## One tick (30 simulated seconds)

1. **Master** acts: spawn scene, close/open road, puncture ambulance (`MasterAction`).
2. **World advances**: ambulances drive, victims deteriorate (each injury at its own pace), crews assess, load, treat, deliver.
3. **Observer** turns what happened into `Report`s (calls, radio, hospital, traffic) and they are folded into the coordinator's `Belief`.
4. **Coordinator** is woken only if there are new reports, and answers with `Action`s: `dispatch` (to an incident), `transport`, `reposition`, `scout` (go and look). The HappyRobot coordinator decides every `--decide-every` ticks (6) in the background: the tick never waits for the platform, and the orders land on the tick the run comes back, checked against the board as it is by then.

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
| `src/engine/incidents.ts` | Coordinator side: attach calls and aerial sightings to incidents, deduce priority, merge, close. Reads reports only. |
| `src/engine/recon.ts` | What the coordinator does not know: zones, the silence heuristic, and the ranked list of places worth looking at. |
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
