// pnpm sim                         one run, full event log
// pnpm sim --seed 7 --ticks 480    8 simulated hours
// pnpm sim --runs 20 --quiet       average score over seeds 1..20
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { clock, describe, Graph, GreedyCoordinator, DanaMaster, RandomMaster, Simulation, type GraphData } from "./engine";

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "valencia" },
    scenario: { type: "string", default: "dana" },
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "240" },
    ambulances: { type: "string", default: "5" },
    runs: { type: "string", default: "1" },
    quiet: { type: "boolean", default: false },
  },
});

const graph = new Graph(JSON.parse(readFileSync(`data/${values.map}.json`, "utf8")) as GraphData);
const ticks = Number(values.ticks);
const runs = Number(values.runs);

let saved = 0;
let dead = 0;
for (let run = 0; run < runs; run++) {
  const seed = Number(values.seed) + run;
  const sim = new Simulation({
    graph,
    seed,
    master: values.scenario === "random" ? new RandomMaster() : new DanaMaster(),
    coordinator: new GreedyCoordinator(),
    config: { ambulances: Number(values.ambulances) },
  });
  await sim.run(ticks, ({ events, reports }) => {
    if (values.quiet) return;
    const calls = reports.flatMap((r) => (r.event.type === "call_received" ? [r.event] : []));
    for (const e of [...calls, ...events]) console.log(`${clock(e.tick, sim.world.config.tickSeconds)} t${e.tick}  ${describe(e)}`);
  });
  const s = sim.summary();
  saved += s.saved;
  dead += s.dead;
  console.log(
    `seed ${seed}: ${s.saved} saved, ${s.dead} dead, ${s.waiting + s.inAmbulance} open of ${s.victims}` +
      ` | survival ${(s.survivalRate * 100).toFixed(0)}% (${(s.reachableSurvivalRate * 100).toFixed(0)}% of reachable, ${s.inWater} lost to the water) | mean response ${s.meanResponseTicks.toFixed(1)} ticks`,
  );
}
if (runs > 1) console.log(`TOTAL ${runs} runs: ${saved} saved, ${dead} dead, survival ${((saved / (saved + dead)) * 100).toFixed(1)}%`);
