import { test, expect } from "@playwright/test";
import { serve } from "./support/engineRun";
import { ticketGraph, ticketRun } from "./support/ticketRun";
import { interventionGraph, interventionRun } from "./support/interventionRun";

test("operations scopes cases by sector and queue, opens evidence and preserves the way back", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await serve(page, [ticketRun()]);
  await page.route("**/api/graph/ticket-test", (route) => route.fulfill({ json: ticketGraph }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Operaciones", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Navegar por el historial", { exact: true })).toHaveValue("5");
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("3");
  await expect(page.getByTestId("ops-open")).toHaveText("5");
  await page.getByRole("button", { name: "Abrir sector Norte", exact: true }).click();
  await expect(page.locator(".ops-map-breadcrumb")).toContainText("Norte");
  await page.getByRole("button", { name: "Ver incidencias", exact: true }).click();
  await page.getByRole("button", { name: /^Abrir incidencia C1:/ }).click();
  const detail = page.getByRole("complementary", { name: "Detalle de incidencia" });
  await expect(detail).toContainText("A1 es la ambulancia disponible más cercana");
  await expect(page.locator(".ticket-scope")).toContainText("Norte");
  await page.getByRole("button", { name: "Operaciones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Abrir sector Norte", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Cerrar sector", exact: true }).click();
  await page.getByLabel("Navegar por el historial", { exact: true }).fill("0");
  await expect(page.getByTestId("ops-open")).toHaveText("0");
  await expect(page.getByTestId("ops-calls")).toHaveText("0");
  expect(errors).toEqual([]);
});

test("scale view keeps thousands of cases navigable with bounded rows, search, map and mobile layout", async ({ page }) => {
  const errors: string[] = [], requested: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requested.push(r.url()));
  await page.goto("/?escala=1");
  await expect(page.locator(".app-tabs button")).toHaveText(["Operaciones", "Incidencias"]);
  await expect(page.getByTestId("ops-calls")).toHaveText("12.000");
  await expect(page.getByTestId("ops-open")).toHaveText("1.866");
  await expect(page.locator(".ops-map-marker")).toHaveCount(6);
  await expect(page.locator(".ops-map-marker").first()).toBeInViewport();
  expect((await page.locator(".ops-map-canvas").boundingBox())?.height).toBeGreaterThan(200);
  await expect(page.locator(".ops-map-canvas")).toHaveAttribute("data-rendered", "true");
  await page.screenshot({ path: "test-results/operations-desktop.png", fullPage: true });
  await page.getByRole("button", { name: /Incidencias abiertas/ }).first().click();
  await expect(page.locator(".tickets-table tbody tr")).toHaveCount(50);
  const first = await page.locator(".tickets-table tbody tr").first().getAttribute("data-ticket");
  await page.getByLabel("Página siguiente de incidencias").click();
  await expect(page.locator(".tickets-table tbody tr").first()).not.toHaveAttribute("data-ticket", first!);
  await page.getByLabel("Buscar incidencias", { exact: true }).fill("DEMO-C2400");
  await expect(page.locator(".tickets-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: /^Abrir incidencia DEMO-C2400:/ }).click();
  await expect(page.getByRole("complementary", { name: "Detalle de incidencia" })).toContainText("DEMO-L11996");
  await page.getByRole("button", { name: "Ver sector en operaciones", exact: true }).click();
  await expect(page.getByRole("button", { name: "Operaciones", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ops-sector[aria-pressed=true]")).toHaveCount(1);
  await expect(page.locator(".operational-map")).toHaveCount(0);
  expect(requested.some((url) => url.includes("/map/RunMap") || url.includes("/situation/SituationSidebar"))).toBe(false);
  await page.getByRole("button", { name: "Cerrar sector", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".ops-map-marker")).toHaveCount(6);
  await expect(page.locator(".ops-map-canvas")).toHaveAttribute("data-rendered", "true");
  await expect(page.getByRole("heading", { name: /Panorama operativo/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/operations-mobile.png", fullPage: true });
  await page.getByLabel("Buscar sector").fill("suroeste");
  await expect(page.locator(".ops-sector")).toHaveCount(1);
  await page.getByRole("button", { name: "Abrir sector Suroeste", exact: true }).click();
  await expect(page.locator(".ops-map-breadcrumb")).toContainText("Suroeste");
  expect(errors).toEqual([]);
});

test("pending decisions never seize operations; the operator explicitly opens the decision room", async ({ page }) => {
  await serve(page, [interventionRun()]);
  await page.route("**/api/graph/ticket-test", (route) => route.fulfill({ json: interventionGraph }));
  await page.goto("/");
  const decisions = page.locator(".ops-decisions > button");
  await expect(decisions.first()).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator(".app-workspace")).not.toHaveAttribute("inert");
  await decisions.first().click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Salir a investigar", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Panorama operativo/ })).toBeVisible();
});

for (const mobile of [false, true]) test(`map incidents open in context and preserve the camera on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const run = ticketRun();
  // Two distinct cases in the middle of Norte, away from the other fixture cases.
  const graph = { ...ticketGraph, nodes: [[-0.375, 39.4775], ticketGraph.nodes[1], [-0.3735, 39.4775]] };
  for (const record of run.records) record.frame = { ...record.frame, incidents: record.frame.incidents.map((i) =>
    ({ ...i, node: i.id === "C1" ? 0 : i.id === "C2" ? 2 : 1 })) };
  await serve(page, [run]);
  await page.route("**/api/graph/ticket-test", (route) => route.fulfill({ json: graph }));
  await page.goto("/");
  const seek = page.getByLabel("Navegar por el historial", { exact: true });
  await expect(seek).toHaveValue("5");
  await seek.fill("3");
  await page.getByRole("button", { name: "Abrir sector Norte", exact: true }).click();
  const map = page.locator(".ops-map-canvas"), canvas = map.locator("canvas");
  await expect(map).toHaveAttribute("data-rendered", "true");
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Acercar mapa de operaciones" }).click();
    await expect(map).toHaveAttribute("data-rendered", "true");
  }
  if (mobile) await map.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 60));
  const box = (await map.boundingBox())!;
  // Pan as an operator would before inspecting a point.
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(map).toHaveAttribute("data-rendered", "true");
  const marker = page.locator(".ops-map-marker.selected");
  const beforeMarker = (await marker.boundingBox())!;
  const beforeCanvas = await canvas.elementHandle();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  // The first case is exactly at the sector marker's geographic anchor.
  const first = { x: beforeMarker.x + beforeMarker.width / 2, y: beforeMarker.y + beforeMarker.height + 24 };
  const mercator = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
  const scale = Math.min((box.width - 130) / ((0.05 / 3) / 360), (box.height - 130) / (mercator(39.465) - mercator(39.49))) * 8;
  const second = { x: first.x + 0.0015 / 360 * scale, y: first.y };
  const clip = { x: box.x + 60, y: box.y + 60, width: box.width - 120, height: box.height - 120 };
  const beforeImage = await page.screenshot({ clip });
  // The touch target extends beyond the visible five-pixel dot.
  await page.mouse.click(first.x + 8, first.y);
  const detail = page.getByRole("complementary", { name: "Detalle de incidencia en el mapa" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".ticket-summary-meta code")).toHaveText("C1");
  await expect(page.getByRole("button", { name: "Operaciones", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tickets-table")).toHaveCount(0);
  expect(await marker.boundingBox()).toEqual(beforeMarker);
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  expect(await beforeCanvas!.evaluate((element) => element.isConnected)).toBe(true);
  await page.screenshot({ path: `test-results/operations-incident-${mobile ? "mobile" : "desktop"}.png` });
  if (mobile) {
    const height = (await detail.boundingBox())!.height;
    expect(height).toBeLessThan(844 * 0.6);
    await detail.getByRole("button", { name: "Ampliar detalle" }).click();
    expect((await detail.boundingBox())!.height).toBeGreaterThan(height);
  }
  await detail.locator("summary").filter({ hasText: "Actividad y evidencias" }).click();
  await expect(detail.getByText(/A1 es la ambulancia disponible más cercana/)).toBeVisible();
  if (mobile) await detail.getByRole("button", { name: "Reducir detalle" }).click();
  await page.mouse.click(second.x, second.y);
  await expect(detail.locator(".ticket-summary-meta code")).toHaveText("C2");
  await expect(detail).toHaveCount(1);
  await expect(detail.locator(".ops-incident-evidence")).not.toHaveAttribute("open");
  expect(await marker.boundingBox()).toEqual(beforeMarker);
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(canvas).toBeFocused();
  expect(await marker.boundingBox()).toEqual(beforeMarker);
  await expect.poll(() => page.screenshot({ clip })).toEqual(beforeImage);
  await page.mouse.click(first.x, first.y);
  await expect(detail).toBeVisible();
  await seek.fill("0");
  await expect(detail).toHaveCount(0);
  await seek.fill("3");
  await expect(detail).toHaveCount(0);
  // Playback controls can scroll the page on mobile; return to the same map.
  if (mobile) await page.evaluate((y) => window.scrollTo(0, y), beforeScroll);
  await expect(map).toHaveAttribute("data-rendered", "true");
  await page.mouse.click(first.x, first.y);
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "Abrir en Incidencias", exact: true }).click();
  await expect(page.getByRole("button", { name: "Incidencias", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.tickets-table tr[data-ticket="C1"]')).toHaveClass("selected");
  await expect(page.locator(".ticket-scope")).toContainText("Norte");
  expect(errors).toEqual([]);
});
