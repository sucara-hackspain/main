import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import {
  DanaMaster,
  Graph,
  GreedyCoordinator,
  makeTickRecord,
  Simulation,
  type GraphData,
} from "../../src/engine";
import type { RunMeta, TickRecord } from "../../src/ui/engineTrace";

export type Run = { meta: RunMeta; records: TickRecord[] };

/** A DANA night with the rule coordinator, simulated in memory: nothing is written to runs/. */
export async function simulate(seed: number, ticks: number): Promise<Run> {
  const data = JSON.parse(
    readFileSync(resolve("data/valencia.json"), "utf8"),
  ) as GraphData;
  const graph = new Graph(data);
  const sim = new Simulation({
    graph,
    seed,
    master: new DanaMaster(),
    coordinator: new GreedyCoordinator(),
  });
  const records: TickRecord[] = [];
  for (let i = 0; i < ticks; i++)
    records.push(makeTickRecord(await sim.step(), sim.world, sim.belief, graph));
  return {
    meta: {
      id: `e2e-dana-s${seed}`,
      map: "valencia",
      seed,
      ticks,
      coordinator: "greedy",
      model: null,
      config: sim.world.config,
      hospitals: sim.world.hospitals.map(({ id, name, node, capacity, helipad }) => ({
        id,
        name,
        node,
        capacity,
        helipad,
      })),
      startedAt: "2026-09-19T00:00:00.000Z",
      status: "finished",
      summary: sim.summary(),
    },
    records,
  };
}

/** Serve runs through the same incremental API the app polls. External tiles become a plain background. */
export async function serve(page: Page, runs: Run[]) {
  await page.route("**/api/runs", (r) => r.fulfill({ json: runs.map((x) => x.meta) }));
  for (const { meta, records } of runs)
    await page.route(`**/api/runs/${meta.id}?*`, (r) => {
      const from = Number(new URL(r.request().url()).searchParams.get("from"));
      return r.fulfill({ json: { meta, ticks: records.slice(from) } });
    });
  await page.route("https://tiles.openfreemap.org/styles/positron", (r) =>
    r.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#f4f5f6" } },
        ],
      },
    }),
  );
}
