import { test, expect } from "@playwright/test";
import { serve } from "./support/engineRun";
import { ticketGraph, ticketRun } from "./support/ticketRun";

for (const mobile of [false, true]) test(`main's recorded decisions, plan, press and signals remain usable on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const run = ticketRun();
  run.records[2].decision = { ...run.records[2].decision!, plan: "Cubrir los dos avisos y reservar capacidad.", watch: "La evolución del agua.", saw: ["112 L1: accidente en Avinguda del Cid."] };
  run.records[3].press = { tick: 4, number: 1, headline: "Una dotación atiende el accidente", lead: "Información confirmada sobre el terreno.", figures: [{ label: "Dotaciones", value: "2" }], paragraphs: ["Se mantiene la atención a los avisos."], advice: ["Evitar desplazamientos innecesarios."] };
  for (const record of run.records.slice(2)) record.frame = { ...record.frame, channel: {
    reader: "lector de prueba", received: 20, read: 20, relevant: 1,
    fresh: record.tick === 2 ? [{ id: "M1", channel: "red", node: 0, street: "Avinguda del Cid", text: "Hay una persona atrapada en el coche.", read: true, relevant: true, leadId: "P1" }] : [],
    leads: [{ id: "P1", tick: 2, node: 0, street: "Avinguda del Cid", summary: "Persona atrapada en un coche", credibility: 0.8, urgency: "high", messages: ["M1"], registry: null, real: true }],
  } };
  await serve(page, [run]);
  await page.route("**/api/graph/ticket-test", (route) => route.fulfill({ json: ticketGraph }));
  await page.goto("/");
  const seek = page.getByLabel("Navegar por el historial", { exact: true });
  await expect(seek).toHaveValue("5");
  await expect(page.getByRole("button", { name: "Territorio", exact: true })).toHaveCount(0);
  await expect(page.locator(".ops-sources")).toContainText("20 mensajes");
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.locator(".plan-text")).toHaveText("Cubrir los dos avisos y reservar capacidad.");
  await page.getByRole("button", { name: "t2", exact: true }).click();
  await expect(page.getByRole("button", { name: "Decisiones", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(seek).toHaveValue("2");
  await expect(page.getByRole("complementary", { name: "Ficha de decisión" })).toContainText("A1 es la ambulancia disponible más cercana");
  await expect(page.locator(".operational-map canvas")).toBeVisible();
  await page.getByRole("button", { name: /^Prensa/ }).click();
  await expect(page.getByText("Todavía no hay ningún comunicado", { exact: true })).toBeVisible();
  await seek.fill("3");
  await expect(page.getByRole("heading", { name: "Una dotación atiende el accidente", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Señales/ }).click();
  await expect(page.locator(".lead-card")).toContainText("Hay una persona atrapada en el coche.");
  await seek.fill("0");
  await expect(page.getByText("Esta ejecución no tiene canal ciudadano", { exact: true })).toBeVisible();
  await seek.fill("3");
  await expect(page.locator(".lead-card")).toBeVisible();
  await page.getByRole("button", { name: "Operaciones", exact: true }).click();
  await expect(page.locator(".ops-map-canvas")).toBeVisible();
  await expect(page.locator(".operational-map")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});
