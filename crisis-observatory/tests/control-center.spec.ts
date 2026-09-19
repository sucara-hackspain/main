import { test, expect } from "@playwright/test";
import type { RunMeta, TickRecord } from "../src/ui/engineTrace";
import { serve, simulate } from "./support/engineRun";
let id: string, meta: RunMeta, records: TickRecord[];
// A DANA night with the rule coordinator, simulated in memory from a fixed seed.
test.beforeAll(async () => {
  ({ meta, records } = await simulate(2, 120));
  id = meta.id;
});
async function open(page: any) {
  await page.goto("/?inicio=1");
  await page.getByLabel("Seleccionar ejecución").selectOption(id);
  await expect(
    page.getByText(`${records.length} registros recibidos`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Incidencias", exact: true }).click();
}
// Cartography is external; keep state, markers and interactions deterministic offline.
test.beforeEach(async ({ page }) => {
  await serve(page, [{ meta, records }]);
});
test("engine run drives operational totals, playback and historical state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await page.getByRole("button", { name: "Operaciones", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("12px 'Geist Variable'"))).toBe(true);
  for (const i of [25, records.length - 2, records.length - 1, 0]) {
    await page
      .getByLabel("Navegar por el historial", { exact: true })
      .fill(String(i));
    const open = records[i].frame.incidents.filter((x) => x.status === "open");
    await expect(page.getByTestId("ops-open")).toHaveText(String(open.length));
    await expect(page.locator(".operational-map")).toHaveCount(0);
  }
  await page.getByLabel("Reproducir historial", { exact: true }).click();
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).not.toHaveValue("0");
  await page.getByLabel("Pausar historial", { exact: true }).click();
  const paused = await page.getByLabel("Tiempo transcurrido").textContent();
  await page.waitForTimeout(700);
  await expect(page.getByLabel("Tiempo transcurrido")).toHaveText(paused!);
  expect(errors).toEqual([]);
});
test("navigation contains only operations and incidents on desktop and mobile", async ({
  page,
}) => {
  await open(page);
  // The legacy case workspace remains reachable beside the operations overview.
  await expect(page.getByRole("button", { name: "Incidencias", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator(".app-tabs button")).toHaveText(["Operaciones", "Incidencias"]);
    await page.getByRole("button", { name: "Operaciones", exact: true }).click();
    await expect(page.getByRole("button", { name: "Operaciones", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Panorama operativo", exact: true })).toBeVisible();
    await expect(page.locator(".ops-map")).toBeVisible();
    await expect(page.locator(".operational-map")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.getByRole("button", { name: "Incidencias", exact: true }).click();
    await expect(page.getByRole("button", { name: "Incidencias", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("complementary", { name: "Detalle de incidencia" })).toBeVisible();
  }
});
test("new records follow on demand, paused history stays fixed and connection errors recover", async ({
  page,
}) => {
  let length = 8,
    fail = false;
  await page.route("**/api/runs", (r) =>
    r.fulfill({ json: [{ ...meta, id: "live-test", status: "running" }] }),
  );
  await page.route("**/api/runs/live-test?*", (r) => {
    if (fail) return r.fulfill({ status: 503, json: { error: "offline" } });
    const from = Number(new URL(r.request().url()).searchParams.get("from"));
    return r.fulfill({
      json: {
        meta: { ...meta, id: "live-test", status: "running" },
        ticks: records.slice(from, length),
      },
    });
  });
  await page.goto("/?inicio=1");
  await expect(
    page.getByText("8 registros recibidos", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Seguir ejecución", exact: true })
    .click();
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).toHaveValue("7");
  length = 12;
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).toHaveValue("11");
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("3");
  length = 16;
  await expect(
    page.getByText("16 registros recibidos", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).toHaveValue("3");
  fail = true;
  await expect(page.getByRole("alert")).toContainText("503");
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).toHaveValue("3");
  fail = false;
  await expect(page.getByRole("alert")).toHaveCount(0);
});
test("empty and incompatible executions are explicit, with no mock fallback", async ({
  page,
}) => {
  await page.route("**/api/runs", (r) => r.fulfill({ json: [] }));
  await page.goto("/?inicio=1");
  await expect(
    page.getByRole("heading", { name: "No hay ejecuciones todavía" }),
  ).toBeVisible();
  await expect(page.locator(".run-incident")).toHaveCount(0);
  await page.unroute("**/api/runs");
  await page.route("**/api/runs", (r) => r.fulfill({ json: [meta] }));
  await page.route(`**/api/runs/${meta.id}?*`, (r) =>
    r.fulfill({
      json: { meta, ticks: [{ ...records[0], frame: { units: [] } }] },
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Formato de registros de actividad no válido");
  await expect(page.locator(".run-incident")).toHaveCount(0);
});

test("recordings in the previous format show an explicit error while the run picker remains usable", async ({ page }) => {
  await page.route(`**/api/runs/${meta.id}?*`, (route) => route.fulfill({
    json: { meta, ticks: [{ tick: 0, frame: { ambulances: [], patients: [], hospitals: [], closedEdges: [] }, events: [], actions: [] }] },
  }));
  await page.goto("/?inicio=1");
  await expect(page.getByRole("alert")).toContainText("formato anterior de ambulancias y pacientes");
  await expect(page.getByLabel("Seleccionar ejecución")).toBeEnabled();
  await expect(page.locator(".run-incident")).toHaveCount(0);
});

test("completion drains trailing records even if finished metadata races the file read", async ({
  page,
}) => {
  await page.route("**/api/runs", (r) =>
    r.fulfill({ json: [{ ...meta, id: "final-drain" }] }),
  );
  await page.route("**/api/runs/final-drain?*", (r) => {
    const from = Number(new URL(r.request().url()).searchParams.get("from"));
    return r.fulfill({
      json: {
        meta: { ...meta, id: "final-drain", status: "finished" },
        ticks: records.slice(from, from === 0 ? 10 : records.length),
      },
    });
  });
  await page.goto("/?inicio=1");
  await expect(
    page.getByText(`${records.length} registros recibidos`, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ir al final", exact: true }).click();
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).toHaveValue(String(records.length - 1));
});
