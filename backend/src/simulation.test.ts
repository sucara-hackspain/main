import assert from "node:assert/strict";
import { test } from "node:test";
import { cutStreet, punctureAmbulance, spawnInjured } from "./actions.js";
import { PUNCTURE_REPAIR_TURNS } from "./config.js";
import type { Graph } from "./map/graph.js";
import { RoadMap } from "./map/road-map.js";
import { step } from "./simulation.js";
import type { World } from "./world.js";

// A -500- B -500- C -500- D   (calle "mid" = B-C)
// A ------800------ E ------800------ D
const graph: Graph = {
  nodes: { 1: [0, 0], 2: [0, 0.005], 3: [0, 0.01], 4: [0, 0.015], 5: [0.005, 0.0075] },
  edges: [[1, 2, 500, "west"], [2, 3, 500, "mid"], [3, 4, 500, "east"], [1, 5, 800, "north"], [5, 4, 800, "north"]],
};

test("rescate, desvío por corte, pinchazo y muerte", async () => {
  const map = new RoadMap(graph);
  const w: World = {
    turn: 0,
    base: { position: 1 },
    ambulances: [{ id: "A1", position: 1, target: null, repairTurns: 0 }],
    injured: [],
    cuts: [],
    stats: { rescued: 0, dead: 0 },
    log: [],
    nextInjuredId: 1,
  };
  const A1 = w.ambulances[0];

  spawnInjured(w, map, 4, 10); // H1 en D
  await step(w, map);
  assert.equal(A1.position, 2, "600m de presupuesto: llega a B, no a C");
  await step(w, map);
  await step(w, map);
  assert.deepEqual([A1.position, w.stats.rescued, A1.target], [4, 1, null]);

  cutStreet(w, map, "mid");
  spawnInjured(w, map, 1, 10); // H2 en A: la ruta corta está cortada → por E
  await step(w, map);
  assert.equal(A1.position, 5, "desvía por E al estar B-C cortada");
  await step(w, map);
  assert.equal(w.stats.rescued, 2);

  spawnInjured(w, map, 4, 20); // H3 en D
  punctureAmbulance(w, "A1");
  for (let i = 0; i < PUNCTURE_REPAIR_TURNS; i++) await step(w, map);
  assert.equal(A1.position, 1, "pinchada: no se mueve");
  await step(w, map);
  assert.equal(A1.position, 5, "reparada: vuelve a moverse");

  spawnInjured(w, map, 1, 1); // H4 muere este turno (A1 está lejos); A1 llega a D y rescata a H3
  await step(w, map);
  assert.deepEqual([w.stats.dead, w.stats.rescued, w.injured], [1, 3, []]);
});
