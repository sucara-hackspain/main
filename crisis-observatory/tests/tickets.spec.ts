import { test, expect, type Page } from "@playwright/test";
import { serve } from "./support/engineRun";
import { ticketGraph, ticketRun } from "./support/ticketRun";

test.beforeEach(async ({ page }) => {
  await serve(page, [ticketRun()]);
  await page.route("**/api/graph/ticket-test", (route) => route.fulfill({ json: ticketGraph }));
  await page.goto("/?inicio=1");
  await expect(page.getByText("6 registros recibidos", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Incidencias", exact: true }).click();
});

async function expectIncidentFocus(page: Page, id: string) {
  const point = page.getByRole("button", { name: `Incidencia seleccionada ${id}:`, exact: false });
  const detail = page.getByRole("complementary", { name: "Detalle de incidencia en el mapa", exact: true });
  await expect(detail.locator(".ticket-summary-meta code")).toHaveText(id);
  await expect(page.locator(".ops-map-canvas")).toHaveAttribute("data-rendered", "true");
  await expect(point).toBeInViewport();
  const map = (await page.locator(".ops-map-canvas").boundingBox())!, panel = (await detail.boundingBox())!;
  const bounds = (await point.boundingBox())!;
  const mobile = page.viewportSize()!.width <= 1000;
  const right = mobile ? map.x + map.width : panel.x;
  const bottom = mobile ? Math.min(map.y + map.height, panel.y) : map.y + map.height;
  expect(Math.abs(bounds.x + bounds.width / 2 - (map.x + right) / 2)).toBeLessThan(2);
  expect(Math.abs(bounds.y + bounds.height / 2 - (map.y + bottom) / 2)).toBeLessThan(2);
  // C1 is hundreds of metres from the sector center: at street zoom its sector card is offscreen.
  await expect(page.locator(".ops-map-marker.selected")).not.toBeInViewport();
}

test("ticket list, filters, reasons, historical details and exact map navigation work together", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const seek = page.getByLabel("Navegar por el historial", { exact: true });
  const detail = page.getByRole("complementary", { name: "Detalle de incidencia" });
  await expect(page.getByText("Todavía no hay incidencias", { exact: true })).toBeVisible();
  await seek.fill("2");
  await page.getByRole("button", { name: "Abrir incidencia C1:", exact: false }).click();
  await expect(detail).toContainText("Esperando valoración en la zona");
  await expect(detail).toContainText("A1 es la ambulancia disponible más cercana");
  await expect(detail).not.toContainText("A2 cubre el aviso");
  await detail.getByRole("button", { name: "Ver en el mapa" }).click();
  await expect(page.getByRole("button", { name: "Operaciones", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Abrir sector Norte", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".operational-map")).toHaveCount(0);
  await expectIncidentFocus(page, "C1");
  const map = page.locator(".ops-map-canvas"), before = (await map.boundingBox())!;
  await page.mouse.move(before.x + 60, before.y + 120);
  await page.mouse.down();
  await page.mouse.move(before.x + 120, before.y + 150, { steps: 5 });
  await page.mouse.up();
  await expect(map).toHaveAttribute("data-rendered", "true");
  const point = page.locator(".ops-map-incident-marker");
  const panned = await point.boundingBox();
  await seek.fill("3");
  await expect.poll(() => point.boundingBox()).toEqual(panned);
  await page.screenshot({ path: "test-results/tickets-map-focus-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Incidencias", exact: true }).click();
  await seek.fill("3");
  await expect(detail).toContainText("La incidencia es más grave de lo previsto");
  await expect(detail).toContainText("parada cardiaca");
  await page.screenshot({ path: "test-results/tickets-desktop.png", fullPage: true });
  const filters = page.getByLabel("Filtrar tickets por estado");
  await filters.getByRole("button", { name: /^Triage/ }).click();
  await expect(page.locator('.tickets-table tr[data-ticket="C1"]')).toHaveCount(0);
  await filters.getByRole("button", { name: /^Todos/ }).click();
  await page.getByLabel("Buscar incidencias").fill("avinguda");
  await expect(page.locator(".tickets-table tbody tr")).toHaveCount(1);
  await page.getByLabel("Buscar incidencias").fill("no-existe");
  await expect(page.getByText("No hay coincidencias", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Limpiar filtros", exact: true }).click();
  await seek.fill("5");
  await filters.getByRole("button", { name: /^Resuelto/ }).click();
  await expect(page.locator('.tickets-table tr[data-ticket="C1"]')).toBeVisible();
  await expect(detail).toContainText("Se muestra la última ubicación registrada");
  await detail.getByRole("button", { name: "Ver en el mapa" }).click();
  await expect(seek).toHaveValue("5");
  await expect(page.getByRole("button", { name: "Abrir sector Norte", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".operational-map")).toHaveCount(0);
  await expectIncidentFocus(page, "C1");
  await expect(page.locator(".ops-incident-panel .ticket-status")).toHaveText("Resuelto");
  await page.locator(".ops-map-incident-marker").click();
  await expect(page.locator(".ops-incident-panel .ticket-summary-meta code")).toHaveText("C1");
  await page.getByRole("button", { name: "Incidencias", exact: true }).click();
  await seek.fill("0");
  await expect(detail).toContainText("Selecciona un ticket");
  await expect(detail).not.toContainText("parada cardiaca");
  expect(errors).toEqual([]);
});

test("tickets support keyboard selection and mobile navigation without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("2");
  const open = page.getByRole("button", { name: "Abrir incidencia C1:", exact: false });
  await open.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("complementary", { name: "Detalle de incidencia" });
  await expect(detail.getByRole("heading", { name: "accidente de tráfico", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/tickets-mobile.png", fullPage: true });
  await detail.getByRole("button", { name: "Ver en el mapa" }).click();
  await expectIncidentFocus(page, "C1");
  await expect(page.getByRole("button", { name: "Abrir sector Norte", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".operational-map")).toHaveCount(0);
  await page.screenshot({ path: "test-results/tickets-map-focus-mobile.png" });
});

test("a ticket without coordinates does not navigate to an unrelated map location", async ({ page }) => {
  const run = ticketRun();
  for (const record of run.records) record.frame = { ...record.frame,
    incidents: record.frame.incidents.map((incident) => incident.id === "C1" ? { ...incident, node: 999999 } : incident) };
  await serve(page, [run]);
  await page.reload();
  await expect(page.getByText("6 registros recibidos", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Incidencias", exact: true }).click();
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Abrir incidencia C1:", exact: false }).click();
  await expect(page.getByRole("button", { name: "Ver en el mapa", exact: true })).toBeDisabled();
  await expect(page.getByText("No hay coordenadas disponibles para esta incidencia.", { exact: true })).toBeVisible();
});
