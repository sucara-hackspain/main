import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { RunMeta, TickRecord } from "../../src/ui/engineTrace";

export type Run = { meta: RunMeta; records: TickRecord[] };

/** The latest game recorded by ../backend (npm run sim -- init && step), cut to `ticks` records. */
export async function simulate(_seed: number, ticks: number): Promise<Run> {
  const root = resolve("../backend/runs");
  const ids = existsSync(root) ? readdirSync(root).filter((id) => existsSync(resolve(root, id, "meta.json"))).sort() : [];
  const id = ids.at(-1);
  if (!id) throw new Error("no hay partidas en backend/runs: crea una con `npm run sim -- init -n 4 && npm run sim -- step 20` en backend/");
  const meta = JSON.parse(readFileSync(resolve(root, id, "meta.json"), "utf8")) as RunMeta;
  const records = readFileSync(resolve(root, id, "ticks.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TickRecord).slice(0, ticks);
  return { meta, records };
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
