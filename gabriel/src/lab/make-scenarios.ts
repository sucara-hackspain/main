// pnpm lab:scenarios — writes the frozen nights to lab/scenarios and shows how hard each one is for the rule-based dispatcher.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Graph, type GraphData } from "../engine";
import { play } from "./play";
import { COLLECTION, generateScenario, SCENARIO_DIR } from "./scenario";

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
mkdirSync(SCENARIO_DIR, { recursive: true });

for (const spec of COLLECTION) {
  const scenario = generateScenario(spec, graph);
  writeFileSync(`${SCENARIO_DIR}/${scenario.id}.json`, JSON.stringify(scenario));
  const greedy = await play(scenario, { kind: "greedy" }, graph);
  const informed = await play(scenario, { kind: "informed" }, graph);
  console.log(
    `${scenario.id} ${scenario.split.padEnd(10)} ${scenario.title.padEnd(34)} ${String(scenario.stats.scenes).padStart(3)} escenas (${scenario.stats.silent} mudas) ${String(scenario.stats.victims).padStart(3)} víctimas` +
      ` | greedy ${greedy.dead} muertos, ${greedy.open} abiertos (${greedy.inWater} en el agua) | info perfecta ${informed.dead} muertos`,
  );
}
