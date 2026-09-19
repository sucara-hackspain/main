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
    { cwd: resolve("gabriel"), encoding: "utf8" },
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
// Cartography is external; keep state, markers and interactions deterministic offline.
test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/styles/positron", (route) => route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#f4f5f6" } }] } }));
});
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
    await expect(page.locator('.situation-row[data-entity^="patient:"]')).toHaveCount(active.length);
    await expect(page.getByTestId("saved-count")).toHaveText(
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
  await expect(page.locator(".app-sidebar .app-agent-cards, .app-sidebar .app-log")).toHaveCount(0);
  await page.getByRole("button", { name: "Actividad de los agentes", exact: true }).click();
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
  await expect(page.locator('.situation-row[data-entity^="patient:"]')).toHaveCount(0);
  await page.unroute("**/api/runs");
  await page.route("**/api/runs", (r) => r.fulfill({ json: [meta] }));
  await page.route(`**/api/runs/${meta.id}?*`, (r) =>
    r.fulfill({
      json: { meta, ticks: [{ ...records[0], frame: { units: [] } }] },
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Formato de registros de actividad no válido");
  await expect(page.locator('.situation-row[data-entity^="patient:"]')).toHaveCount(0);
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

test("operational sidebar explores the map, keeps global context and respects the selected instant", async ({ page }) => {
  const idle = { ...records[0].frame.ambulances[0], mission: "idle" as const, patientId: null, targetPatientId: null, hospitalId: null, broken: false, stranded: false, busyUntil: 0, brokenUntil: null, route: [] as [number, 0 | 1][] };
  const hospitals = meta.hospitals.slice(0, 2);
  const operationalMeta = { ...meta, id: "operational-sidebar", hospitals, status: "finished" as const };
  const initial: TickRecord = { ...records[0], tick: 0, events: [], actions: [], frame: {
    ...records[0].frame, patients: [], closedEdges: [],
    ambulances: ["A1", "A2", "A3"].map((id) => ({ ...idle, id })),
    hospitals: hospitals.map((h) => ({ id: h.id, occupied: 0 })),
  } };
  const busy: TickRecord = { ...initial, tick: 5, frame: { ...initial.frame,
    ambulances: [
      { ...idle, id: "A1", mission: "to_patient", targetPatientId: "P7", hospitalId: hospitals[0].id, etaTicks: 6 },
      { ...idle, id: "A2", mission: "to_hospital", patientId: "P9", hospitalId: hospitals[0].id, etaTicks: 3, pos: records[30].frame.ambulances[0].pos },
      { ...idle, id: "A3", broken: true, brokenUntil: 9 },
    ],
    patients: [
      { id: "P7", node: hospitals[0].node, status: "waiting", ttl: 20, spawnTick: 1, endTick: null },
      { id: "P8", node: hospitals[1].node, status: "waiting", ttl: 20, spawnTick: 2, endTick: null },
      { id: "P9", node: hospitals[0].node, status: "in_ambulance", ttl: 20, spawnTick: 0, pickupTick: 3, endTick: null },
    ],
    hospitals: hospitals.map((h, i) => ({ id: h.id, occupied: h.capacity - (i === 0 ? 1 : 0) })),
    summary: { ...initial.frame.summary, saved: 0, dead: 0 },
  } };
  const unloading: TickRecord = { ...busy, tick: 6,
    events: [{ type: "patient_delivered", tick: 6, patientId: "P9", ambulanceId: "A2", hospitalId: hospitals[0].id }],
    frame: { ...busy.frame,
      ambulances: busy.frame.ambulances.map((a) => a.id === "A2" ? { ...idle, id: "A2", busyUntil: 8 } : a),
      patients: busy.frame.patients.map((p) => p.id === "P9" ? { ...p, status: "delivered", endTick: 6 } : p),
      hospitals: hospitals.map((h) => ({ id: h.id, occupied: h.capacity })),
      summary: { ...busy.frame.summary, saved: 1 },
    },
  };
  const available = { ...unloading, tick: 8, events: [] };
  const snapshots = [initial, busy, unloading, available];
  await page.route("**/api/runs", (r) => r.fulfill({ json: [operationalMeta] }));
  await page.route("**/api/runs/operational-sidebar?*", (r) => r.fulfill({ json: { meta: operationalMeta, ticks: snapshots.slice(Number(new URL(r.request().url()).searchParams.get("from"))) } }));
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Estado de la situación" });
  const row = (ref: string) => sidebar.locator(`.situation-row[data-entity="${ref}"]`);
  const pin = (ref: string) => page.locator(`.operational-map [data-entity="${ref}"]`);
  await expect(sidebar.getByTestId("available-units")).toHaveText("3/3");
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("1");
  await expect(sidebar).toContainText("3 casos activos");
  await expect(sidebar.getByTestId("available-units")).toHaveText("0/3");
  await expect(sidebar).toContainText("Revisando el pasado");
  await expect(sidebar).not.toContainText("Master");
  await expect(sidebar).not.toContainText("Coordinador");
  await expect(row(`hospital:${hospitals[0].id}`)).toContainText("Margen previsto: 0");
  await expect(row("ambulance:A3")).toContainText("Reparación prevista en 2 min");
  await expect(pin("patient:P8")).toBeAttached();
  await sidebar.getByRole("button", { name: "Sin asignar 1", exact: true }).click();
  await expect(sidebar.locator(".situation-row")).toHaveCount(1);
  await expect(pin("patient:P8")).not.toHaveClass(/is-muted/);
  await expect(pin("ambulance:A1")).toHaveClass(/is-muted/);
  await row("patient:P8").click();
  await expect(sidebar.getByRole("region", { name: "Detalle de la selección" })).toContainText("1 min 30 s");
  await expect(sidebar).toContainText("3 casos activos");
  await expect(sidebar.getByTestId("available-units")).toHaveText("0/3");
  await sidebar.getByRole("button", { name: "Todos", exact: true }).click();
  await row("ambulance:A1").click();
  await expect(pin("ambulance:A1")).toHaveAttribute("aria-pressed", "true");
  await expect(row("patient:P7")).toHaveClass(/related/);
  await expect(pin(`hospital:${hospitals[0].id}`)).toHaveClass(/related/);
  await pin("patient:P7").focus();
  await page.keyboard.press("Enter");
  await expect(pin("patient:P7")).toBeFocused();
  await expect(row("patient:P7")).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar.getByRole("region", { name: "Detalle de la selección" })).toContainText("P7");
  await page.getByRole("button", { name: "Actividad de los agentes", exact: true }).click();
  await sidebar.getByRole("button", { name: "Ver en el mapa" }).click();
  await expect(page.getByRole("button", { name: "Territorio", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sidebar.getByRole("button", { name: "Cerrar detalle" }).click();
  await sidebar.getByLabel("Buscar entidades").fill("p8");
  await expect(sidebar.locator(".situation-row")).toHaveCount(1);
  await sidebar.getByLabel("Buscar entidades").fill("sin-coincidencias");
  await expect(sidebar.getByText("No hay coincidencias", { exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Borrar búsqueda" }).click();
  await sidebar.getByRole("button", { name: "Sin camas 1", exact: true }).click();
  await expect(row(`hospital:${hospitals[1].id}`)).toBeVisible();
  await expect(sidebar.locator(".situation-row")).toHaveCount(1);
  await sidebar.getByRole("button", { name: "Todos", exact: true }).click();
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("2");
  await expect(row("ambulance:A2")).toContainText("Descargando");
  await expect(sidebar.getByTestId("available-units")).toHaveText("0/3");
  await expect(sidebar.getByTestId("saved-count")).toHaveText("1");
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("3");
  await expect(sidebar.getByTestId("available-units")).toHaveText("1/3");
  await expect(sidebar).toContainText("Estado final de la ejecución");
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("1");
  await row("patient:P8").click();
  await page.screenshot({ path: "test-results/operational-sidebar-desktop.png", fullPage: true });
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("0");
  await expect(sidebar.getByRole("region", { name: "Detalle de la selección" })).toHaveCount(0);
  await expect(sidebar.getByTestId("saved-count")).toHaveText("0");
  await expect(sidebar.locator('.situation-row[data-entity^="patient:"]')).toHaveCount(0);
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("1");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row("patient:P8")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/operational-sidebar-mobile.png", fullPage: true });
  await row("patient:P8").click();
  await expect(sidebar.getByRole("region", { name: "Detalle de la selección" })).toBeInViewport();
  await sidebar.getByRole("button", { name: "Ver en el mapa" }).click();
  await expect(page.locator(".operational-map")).toBeInViewport();
});
