import { expect, test } from "@playwright/test";
import { DRAFT_STORAGE_KEY } from "../src/ui/calls/demoCall";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/runs", (route) => route.fulfill({ json: [] }));
  await page.clock.install();
});

test("the simulated call progresses, extracts information and keeps running while minimized", async ({ page }) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.method() !== "GET") writes.push(request.url()); });
  await page.goto("/");
  const launcher = page.getByRole("button", { name: "Ver llamada de ejemplo" });
  await launcher.click();
  await expect(page.getByRole("dialog", { name: "Atención de llamada" })).toBeVisible();
  await expect(page.getByLabel("Ubicación", { exact: true })).toHaveValue(/San Vicente/);
  await expect(page.getByLabel("Situación reportada", { exact: true })).toHaveValue("");
  await page.clock.runFor(9000);
  await expect(page.getByLabel("Situación reportada", { exact: true })).toHaveValue(/Puerta del portal bloqueada/);
  await page.getByRole("button", { name: "Pausar demo", exact: true }).click();
  const timestamp = await page.locator(".call-duration").textContent();
  await page.clock.runFor(4000);
  await expect(page.locator(".call-duration")).toHaveText(timestamp!);
  await page.getByRole("button", { name: "Reanudar demo", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(launcher).toBeFocused();
  await page.clock.runFor(3000);
  await page.getByRole("button", { name: "Abrir transcripción de la llamada de ejemplo" }).click();
  await expect(page.locator(".call-duration")).not.toHaveText(timestamp!);
  await page.clock.runFor(40000);
  await expect(page.getByText("Demo finalizada", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Repetir demo" })).toBeEnabled();
  await page.getByRole("button", { name: "Repetir demo" }).click();
  await expect(page.locator(".call-duration")).toHaveText("00:49");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("operators can review sources, edit the draft and restore their locally saved changes", async ({ page }) => {
  await page.goto("/?call=demo");
  await page.getByRole("button", { name: "Pausar demo", exact: true }).click();
  await page.getByRole("button", { name: "Ver origen de la ubicación, segundo 6" }).click();
  await expect(page.locator('[data-turn="location"]')).toHaveClass(/is-highlighted/);
  await expect(page.locator('[data-turn="location"]')).toBeInViewport();
  await expect(page.getByRole("button", { name: "Ir a lo más reciente" })).toBeVisible();
  await page.getByLabel("Ubicación", { exact: true }).fill("C/ San Vicente Mártir, 173 · València");
  await page.getByLabel("Notas del operador").fill("Comprobar el número del portal.");
  await page.getByLabel("Prioridad del aviso").selectOption("Alta");
  await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Guardado en este navegador");
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), DRAFT_STORAGE_KEY);
  expect(saved.simulated).toBe(true);
  expect(saved.draft.location).toContain("173");
  expect(saved.transcript.length).toBeGreaterThan(3);
  await page.reload();
  await expect(page.getByLabel("Ubicación", { exact: true })).toHaveValue(/173/);
  await expect(page.getByLabel("Prioridad del aviso")).toHaveValue("Alta");
  await expect(page.getByLabel("Notas del operador")).toHaveValue("Comprobar el número del portal.");
  await page.getByLabel("Notas del operador").fill("Nueva observación.");
  await expect(page.getByRole("status")).toHaveText("Hay cambios sin guardar");
  await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toBeEnabled();
});

test("mobile dialog switches panels, validates hidden fields and preserves a draft across minimizing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?call=demo");
  await page.getByRole("button", { name: "Pausar demo", exact: true }).click();
  await expect(page.getByRole("region", { name: "Conversación transcrita" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Borrador del aviso" })).not.toBeVisible();
  await page.screenshot({ path: "test-results/call-mobile-transcript.png" });
  await page.getByRole("tab", { name: /Borrador/ }).click();
  await page.getByLabel("Ubicación", { exact: true }).fill("");
  await page.getByRole("tab", { name: "Conversación" }).click();
  await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Añade una ubicación");
  await expect(page.getByLabel("Ubicación", { exact: true })).toBeFocused();
  await page.getByLabel("Ubicación", { exact: true }).fill("Ubicación revisada");
  await page.getByLabel("Notas del operador").fill("Borrador sin guardar");
  await page.getByRole("button", { name: "Minimizar llamada" }).click();
  await page.getByRole("button", { name: "Abrir transcripción de la llamada de ejemplo" }).click();
  await expect(page.getByLabel("Notas del operador")).toHaveValue("Borrador sin guardar");
  await page.getByRole("button", { name: "Ver origen de las personas afectadas, segundo 24" }).click();
  await expect(page.getByRole("tab", { name: "Conversación" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-turn="people"]')).toBeInViewport();
  await page.getByRole("tab", { name: /Borrador/ }).click();
  await page.screenshot({ path: "test-results/call-mobile-draft.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await page.locator(".call-dialog").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toBeInViewport();
});

test("storage failures stay recoverable and the visible transcript can be downloaded", async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); }; });
  await page.goto("/?call=demo");
  await page.getByRole("button", { name: "Pausar demo", exact: true }).click();
  await page.getByRole("button", { name: "Guardar borrador", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No se ha podido guardar");
  await expect(page.getByLabel("Ubicación", { exact: true })).toHaveValue(/San Vicente/);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Descargar transcripción" }).click();
  expect((await downloaded).suggestedFilename()).toBe("llamada-demo-0142.txt");
});

test("desktop preview has no overflow and keeps keyboard focus inside the modal", async ({ page }) => {
  await page.goto("/?call=demo");
  await page.getByRole("button", { name: "Pausar demo", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "test-results/call-desktop.png" });
  await page.getByRole("button", { name: "Minimizar llamada" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Guardar borrador", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Minimizar llamada" })).toBeFocused();
  expect(await page.locator(".call-dialog").evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
});
