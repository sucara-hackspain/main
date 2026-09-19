import { test, expect, type Page } from "@playwright/test";
import type { TickRecord } from "../src/ui/engineTrace";
import { detectInterventions, interventionsAt } from "../src/ui/interventions/model";
import { serve, type Run } from "./support/engineRun";
import { interventionGraph, interventionRun } from "./support/interventionRun";

// A fixed recording keeps UI scenarios stable when the engine's strategy changes.
let run: Run, records: TickRecord[], opened: number, title: string;
let next: { index: number; title: string }, ending: string;
test.beforeAll(async () => {
  run = interventionRun();
  records = run.records;
  const all = detectInterventions(records);
  const [request, after] = all.filter((x) => x.severity === "critical");
  expect(request, "The run must include an urgent request").toBeDefined();
  expect(after, "The run must include a subsequent urgent request").toBeDefined();
  opened = records.findIndex((r) => r.tick === request.openedTick);
  title = request.title;
  next = { index: records.findIndex((r) => r.tick === after.openedTick), title: after.title };
  const open = all.filter((x) => x.closedTick === null);
  expect(open.map((x) => x.severity)).toEqual(["warning"]);
  ending = open[0].title;
  expect(opened).toBeGreaterThan(4);
  expect(next.index).toBeGreaterThan(opened);
});
test.beforeEach(async ({ page }) => {
  await serve(page, [run]);
  await page.route("**/api/graph/ticket-test", (route) => route.fulfill({ json: interventionGraph }));
});
const history = (page: Page) =>
  page.getByLabel("Navegar por el historial", { exact: true });
const receipt = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Decisión registrada" });
const room = (page: Page) => page.getByRole("alertdialog");
const inbox = (page: Page) =>
  page.getByRole("button", { name: /^Intervenciones/ });
async function decisions(page: Page) {
  await inbox(page).click();
  await page.getByText(/^Historial de decisiones/).click();
  return page.locator(".decision-history");
}
async function open(page: Page, index: number, path = "/?iteracion=2") {
  await page.goto(path);
  await expect(
    page.getByText(`${records.length} registros recibidos`, { exact: true }),
  ).toBeVisible();
  await history(page).fill(String(index));
}

test("an urgent request takes over the page until the operator approves the recommendation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page, opened - 1);
  await expect(room(page)).toHaveCount(0);

  await history(page).fill(String(opened));
  await expect(room(page).getByRole("heading")).toHaveText(title);
  await expect(room(page)).toContainText("RECOMENDACIÓN DEL SISTEMA");
  await expect(page).toHaveTitle(/^\(\d+\) Decisión pendiente/);
  // Nothing else can be used while the request waits.
  await expect(page.locator(".app-workspace")).toHaveAttribute("inert");
  await expect(page.locator(".app-sidebar-slot")).toHaveAttribute("inert");
  await page.keyboard.press("Escape");
  await expect(room(page)).toBeVisible();

  // Water and air units are occupied in this record, so the recommendation asks for outside help.
  const recommendation = "Pedir embarcaciones externas";
  const approve = room(page).getByRole("button", { name: `1 Aprobar: ${recommendation}`, exact: true });
  await expect(room(page)).toContainText("No hay ninguna unidad acuática ni el helicóptero libres");
  const before = Number((await page.title()).match(/^\((\d+)\)/)![1]);

  await approve.click();
  await expect(room(page)).toHaveCount(0);
  await expect(page.locator(".app-workspace")).not.toHaveAttribute("inert");
  await expect(receipt(page)).toContainText(`Decisión registrada · ${recommendation}`);
  await expect(receipt(page)).toContainText(
    "El motor todavía no recibe órdenes del operador",
  );
  await expect(page).toHaveTitle(
    before > 1 ? `(${before - 1}) Decisión pendiente · Alerta · Control Center` : "Alerta · Control Center",
  );

  // The decision stays while the timeline moves forward, and the history can undo it.
  await history(page).fill(String(next.index - 1));
  await expect(room(page)).toHaveCount(0);
  await expect((await decisions(page)).locator(".decided")).toContainText(
    `Aprobada · ${recommendation}`,
  );
  await page.getByRole("button", { name: `Deshacer decisión: ${title}` }).click();
  await expect(room(page).getByRole("heading")).toHaveText(title);
  expect(errors).toEqual([]);
});

test("the room carries the context to decide: incident map, facts with their sources, reality and the thread", async ({
  page,
}) => {
  await open(page, opened + 2);
  const incidentId = title.match(/C\d+/)![0];
  await expect(room(page).locator(".incident-map")).toBeVisible();
  const facts = room(page).locator(".decision-facts");
  await expect(facts).toContainText(`LO QUE SABE EL COORDINADOR · ${incidentId}`);
  await expect(facts.locator("code").first()).toHaveText(/^L\d+/);
  await expect(facts).toContainText("REALIDAD DE LA SIMULACIÓN");
  // The thread starts at the calls about it and ends now.
  const thread = room(page).locator(".decision-thread");
  await expect(thread.locator("li.call").first()).toContainText("Llamada");
  await expect(thread.locator("li.now")).toContainText("Ahora · se requiere tu decisión");
  await thread.locator("li.call button").first().click();
  await expect(thread.locator(".run-call")).toBeVisible();
  await expect(thread.getByRole("button", { name: "Abrir en Actividad de los agentes" })).toHaveCount(0);
  await thread.locator("li.coordinator > button").first().click();
  await expect(thread.locator(".app-event-detail")).toContainText("ÓRDENES Y RESULTADOS");

  // Leaving to investigate keeps the request in a bar and frees the page.
  await room(page).getByRole("button", { name: "Salir a investigar" }).click();
  await expect(room(page)).toHaveCount(0);
  const bar = page.locator(".decision-pending-bar");
  await expect(bar).toContainText(/decisi(?:ón|ones) pendiente/i);
  await expect(page.locator(".app-workspace")).not.toHaveAttribute("inert");
  await bar.getByRole("button", { name: "Volver a la decisión" }).click();
  await expect(room(page)).toBeVisible();

  // The sound can be silenced from the room, and the choice sticks.
  await room(page).getByRole("button", { name: "Silenciar los avisos" }).click();
  await open(page, opened + 2);
  await room(page).getByRole("button", { name: "Activar el sonido de los avisos" }).click();
});

test("replay stops when an urgent request opens, takes a keyboard answer, carries on to the next one and asks again after rewinding", async ({
  page,
}) => {
  await open(page, opened - 4);
  await page.getByLabel("Reproducir historial", { exact: true }).click();
  await expect(room(page)).toContainText("Historial en pausa");
  await expect(history(page)).toHaveValue(String(opened));
  await page.waitForTimeout(1200);
  await expect(history(page)).toHaveValue(String(opened));

  await page.keyboard.press("2");
  await expect(receipt(page)).toContainText("Decisión registrada ·");
  // The replay carries on by itself, and the next urgent request stops it again.
  await expect(room(page).getByRole("heading")).toHaveText(next.title);
  await expect(room(page)).toContainText("Historial en pausa");
  await expect(history(page)).toHaveValue(String(next.index));
  await room(page).getByRole("button", { name: "Salir a investigar" }).click();
  // The receipt leaves the playback controls free.
  const play = page.getByLabel("Reproducir historial", { exact: true });
  const [a, b] = [await receipt(page).boundingBox(), await play.boundingBox()];
  expect(a && b && (a.x > b.x + b.width || a.y > b.y + b.height || b.y > a.y + a.height)).toBe(true);

  // Going back before the decision undoes it: the replay stops at the same request again.
  await history(page).fill(String(opened - 4));
  await expect(page.locator(".decision-pending-bar")).toHaveCount(0);
  await play.click();
  await expect(room(page)).toContainText("Historial en pausa");
  await expect(room(page).getByRole("heading")).toHaveText(title);
  await expect(history(page)).toHaveValue(String(opened));

  // Without a decision the record shows how the system resolved it on its own.
  await room(page).getByRole("button", { name: "Salir a investigar" }).click();
  await page.getByRole("button", { name: "Ir al final", exact: true }).click();
  // The supervision request still open at the end takes over the page as well.
  await expect(room(page).getByRole("heading")).toHaveText(ending);
  await room(page).getByRole("button", { name: "Salir a investigar" }).click();
  await expect(page.locator(".decision-pending-bar")).toHaveClass(/warning/);
  const log = await decisions(page);
  await expect(log.locator(".expired").first()).toContainText("Sin decisión del operador");
  await expect(log).toContainText("Desenlace en los registros:");
});

test("another action is recorded in the operator's words and the room fits a phone", async ({
  page,
}) => {
  await open(page, opened + 1);
  await room(page).getByRole("button", { name: "Otra acción…" }).click();
  // Digits typed into the note are text, not answers.
  await page
    .getByLabel("Decisión del operador")
    .pressSequentially("Enviar 2 lanchas de bomberos");
  await expect(room(page)).toBeVisible();
  await page.getByRole("button", { name: "Registrar decisión" }).click();
  await expect((await decisions(page)).locator(".decided")).toContainText(
    "Operador · Enviar 2 lanchas de bomberos",
  );
  await page.getByRole("button", { name: /^Deshacer$/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(room(page)).toBeVisible();
  await expect(room(page).getByRole("button", { name: /^1 Aprobar/ })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  ).toBe(false);
});

test("a supervision request takes over the page the same way, in amber", async ({
  page,
}) => {
  // The rule fallback only happens with the AI coordinator: mark one decision so, at a quiet moment.
  const all = detectInterventions(records);
  const quiet = records.findIndex(
    (r, i) =>
      i > 2 &&
      i < opened - 5 &&
      r.decision &&
      interventionsAt(all, records[i + 1].tick, {}).every((x) => x.status !== "pending"),
  );
  expect(quiet).toBeGreaterThan(2);
  const ticks = records.map((r, i) =>
    i === quiet ? { ...r, decision: { source: "fallback" as const, error: "claude timed out" } } : r,
  );
  await serve(page, [{ meta: { ...run.meta, id: "fallback-run" }, records: ticks }]);
  await page.goto("/?iteracion=2");
  await expect(history(page)).toHaveAttribute("max", String(ticks.length - 1));
  await history(page).fill(String(quiet + 1));
  await expect(room(page)).toContainText("Supervisión requerida");
  await expect(room(page)).toHaveClass(/warning/);
  await expect(room(page).getByRole("heading")).toHaveText("IA no disponible: deciden las reglas");
  await expect(room(page)).toContainText("claude timed out");
  await expect(page.locator(".app-workspace")).toHaveAttribute("inert");
  await page.keyboard.press("Escape");
  await expect(room(page)).toBeVisible();
  await room(page).getByRole("button", { name: "1 Aprobar: Continuar con reglas" }).click();
  await expect(room(page)).toHaveCount(0);
  await expect(receipt(page)).toContainText("Decisión registrada · Continuar con reglas");

  // The legacy banner also keeps the recommendation, without linking to the removed page.
  await page.goto("/?iteracion=1");
  await expect(history(page)).toHaveAttribute("max", String(ticks.length - 1));
  await history(page).fill(String(quiet + 1));
  const banner = page.getByRole("region", { name: "Decisión requerida" });
  await expect(banner).toContainText("IA no disponible: deciden las reglas");
  await expect(banner.getByRole("button", { name: "Ver en actividad" })).toHaveCount(0);
});

test("?iteracion=1 keeps the first iteration, a banner above the map", async ({ page }) => {
  await open(page, opened + 2, "/?iteracion=1");
  const banner = page.getByRole("region", { name: "Decisión requerida" }).first();
  await expect(banner.getByRole("heading")).toHaveText(title);
  await expect(banner.getByRole("button", { name: /^Ver C\d+ en operaciones$/ })).toBeVisible();
  await expect(banner).not.toHaveClass(/floating/);
  await expect(room(page)).toHaveCount(0);
  await expect(page.locator(".app-workspace")).not.toHaveAttribute("inert");
});

test("switching runs with a request pending keeps a single count in the tab title", async ({
  page,
}) => {
  await serve(page, [
    { meta: { ...run.meta, id: "copy-a" }, records },
    { meta: { ...run.meta, id: "copy-b" }, records },
  ]);
  await page.goto("/?iteracion=2");
  await expect(history(page)).toHaveAttribute("max", String(records.length - 1));
  await history(page).fill(String(opened + 2));
  const title = await page.title();
  expect(title).toMatch(/^\(\d+\) Decisión pendiente · Alerta · Control Center$/);
  // The other run mounts while this one still shows its count.
  await room(page).getByRole("button", { name: "Salir a investigar" }).click();
  await page.getByLabel("Seleccionar ejecución").selectOption("copy-b");
  await expect(history(page)).toHaveAttribute("max", String(records.length - 1));
  await history(page).fill(String(opened + 2));
  await expect(page).toHaveTitle(title);
});
