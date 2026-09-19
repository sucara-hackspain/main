import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DanaMaster, Graph, GreedyCoordinator, makeTickRecord, Simulation, type GraphData, type RunMeta } from "../../gabriel/src/engine";

// A reproducible UI recording using the real engine, without external agents or long-term memory.
const engineRoot = fileURLToPath(new URL("../../gabriel/", import.meta.url));
const seed = 2, ticks = 120, startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
const id = `${stamp}-dana-greedy-s${seed}`;
const graph = new Graph(JSON.parse(readFileSync(resolve(engineRoot, "data/valencia.json"), "utf8")) as GraphData);
const sim = new Simulation({ graph, seed, master: new DanaMaster(), coordinator: new GreedyCoordinator() });
const dir = resolve(engineRoot, "runs", id);
mkdirSync(dir, { recursive: true });
const meta: RunMeta = {
  id, map: "valencia", seed, ticks, coordinator: "greedy", model: null, startedAt,
  config: sim.world.config,
  hospitals: sim.world.hospitals.map(({ id, name, node, capacity, helipad }) => ({ id, name, node, capacity, helipad })),
  status: "running", summary: null,
};
const saveMeta = () => writeFileSync(resolve(dir, "meta.json"), JSON.stringify(meta, null, 2));
writeFileSync(resolve(dir, "ticks.jsonl"), "");
saveMeta();
try {
  for (let i = 0; i < ticks; i++) {
    const result = await sim.step();
    appendFileSync(resolve(dir, "ticks.jsonl"), JSON.stringify(makeTickRecord(result, sim.world, sim.belief, graph)) + "\n");
  }
  meta.status = "finished";
} catch (error) {
  meta.status = "failed";
  throw error;
} finally {
  meta.summary = sim.summary();
  saveMeta();
}
console.log(`Generada ${id}: ${ticks} registros · ${meta.summary!.saved} personas salvadas.`);
console.log("Selecciona esta ejecución en Control Center y pulsa «Ir al final» para explorar las incidencias.");
