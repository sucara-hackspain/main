import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { RunMeta, TickRecord } from "../src/ui/runModel";
let id: string, meta: RunMeta, records: TickRecord[];
test.beforeAll(async ({ request }) => {
  const output = execFileSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      "src/run.ts",
      "--coordinator",
      "greedy",
      "--seed",
      "2",
      "--ticks",
      "120",
    ],
    { cwd: resolve("../gabriel"), encoding: "utf8" },
  );
  id = output.match(/trace: runs\/(.+)/)![1].trim();
  const data = await (await request.get(`/api/runs/${id}`)).json();
  meta = data.meta;
  records = data.ticks;
});
async function open(page: any) {
  await page.goto("/");
  await page.getByLabel("Seleccionar ejecución").selectOption(id);
  await expect(
    page.getByText("120 registros recibidos", { exact: true }),
  ).toBeVisible();
}
test("real Gabriel run drives patients, hospital capacity, GPS, playback and historical state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await expect(page.locator(".run-hospital")).toHaveCount(
    meta.hospitals.length,
    { timeout: 30000 },
  );
  for (const i of [25, 80, 119, 0]) {
    await page
      .getByLabel("Navegar por el historial", { exact: true })
      .fill(String(i));
    for (const a of records[i].frame.ambulances)
      await expect(page.locator(`[data-unit="${a.id}"]`)).toHaveAttribute(
        "data-position",
        a.pos.join(","),
      );
    const active = records[i].frame.patients.filter(
      (p) => p.status === "waiting" || p.status === "in_ambulance",
    );
    await expect(page.locator(".run-case")).toHaveCount(active.length);
    await expect(page.locator(".run-kpis strong").first()).toHaveText(
      String(records[i].frame.summary.saved),
    );
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
test("coordinator detail expands only centrally and records actual accepted actions", async ({
  page,
}) => {
  await open(page);
  const i = records.findIndex((r) => r.actions.length > 0);
  await page
    .getByLabel("Navegar por el historial", { exact: true })
    .fill(String(i));
  await page
    .getByRole("button", { name: "Actividad de los agentes", exact: true })
    .click();
  await page
    .locator(".app-event-row.coordinator .app-event-button")
    .last()
    .click();
  await expect(page.locator(".app-event-detail")).toContainText("Aceptada");
  await expect(page.locator(".app-event-detail")).toContainText(
    "Sin justificación registrada",
  );
  await expect(page.locator(".app-sidebar .app-event-detail")).toHaveCount(0);
  await expect(page.locator(".app-event-detail")).not.toContainText("IA");
  await page.getByRole("button", { name: "Territorio", exact: true }).click();
  await expect(page.locator(".app-event-detail")).toHaveCount(0);
  await page.locator(".app-log.selected").click();
  await expect(
    page.getByRole("button", { name: "Actividad de los agentes", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".app-event-detail")).toContainText("Aceptada");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
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
  await page.goto("/");
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
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "No hay ejecuciones todavía" }),
  ).toBeVisible();
  await expect(page.locator(".run-case")).toHaveCount(0);
  await page.unroute("**/api/runs");
  await page.route("**/api/runs", (r) => r.fulfill({ json: [meta] }));
  await page.route(`**/api/runs/${meta.id}?*`, (r) =>
    r.fulfill({
      json: { meta, ticks: [{ ...records[0], frame: { units: [] } }] },
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Formato de registros de actividad no válido");
  await expect(page.locator(".run-case")).toHaveCount(0);
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
  await page.goto("/");
  await expect(
    page.getByText("120 registros recibidos", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ir al final", exact: true }).click();
  await expect(
    page.getByLabel("Navegar por el historial", { exact: true }),
  ).toHaveValue("119");
});
