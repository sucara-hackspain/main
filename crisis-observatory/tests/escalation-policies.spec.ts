import { test, expect } from "@playwright/test";

test("escalation CRUD writes the catalogue the engine applies, apart from the read-only coordination policies", async ({ page }) => {
  // The engine's catalogue, served and saved through the run API; the file itself is never touched here.
  let catalogue = [
    { id: "ESC-02", kind: "unassigned", severity: "critical", afterTicks: 3, title: "Incidencia urgente sin unidad asignada", body: "Escalar si una incidencia P0 o P1 sigue sin dotación." },
    { id: "ESC-06", kind: "rejected", severity: "warning", title: "Una orden no puede ejecutarse", body: "Solicitar revisión humana cuando el motor rechace una orden." },
  ];
  await page.route("**/api/policies", async (route) => {
    if (route.request().method() === "PUT") catalogue = JSON.parse(route.request().postData() ?? "[]");
    await route.fulfill({ json: catalogue });
  });
  await page.addInitScript(() => localStorage.setItem("crisis-policies-v1", JSON.stringify([{id:"D1",title:"Old editable doctrine"}])));
  await page.goto("/policies");
  await expect(page).toHaveURL(/\/escalation-policies$/);
  await expect(page.getByRole("heading", {name:"Políticas de escalado",exact:true})).toBeVisible();
  await expect(page.getByText("Old editable doctrine")).toHaveCount(0);
  await page.getByRole("button", {name:"Nueva política",exact:true}).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("Identificador", {exact:true}).fill("ESC-QA");
  await editor.getByLabel("Título", {exact:true}).fill("Confirmación humana");
  await editor.getByLabel("Situación que requiere escalado").selectOption("rejected");
  await editor.getByLabel("Prioridad de la alerta").selectOption("critical");
  await editor.getByLabel("Cuándo debe escalar la IA").fill("Pedir al operador que revise las órdenes rechazadas.");
  await editor.getByRole("button", {name:"Guardar política"}).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#ESC-QA")).toContainText("Confirmación humana");
  await expect(page.locator("#ESC-QA")).toContainText("Crítica");
  await expect(page.locator("#ESC-QA")).toContainText("En vigor");
  // What the engine reads is what the editor wrote.
  expect(await page.evaluate(() => fetch("/api/policies").then(r => r.json()))).toContainEqual(expect.objectContaining({ id: "ESC-QA", kind: "rejected", severity: "critical" }));
  // A threshold and the switch are part of the policy: editing them changes what the engine escalates.
  await page.getByRole("button", {name:"Editar política ESC-02",exact:true}).click();
  await editor.getByLabel("Registros que debe durar antes de escalar").fill("6");
  await editor.getByLabel("En vigor: el motor escala esta situación").uncheck();
  await editor.getByRole("button", {name:"Guardar política"}).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("#ESC-02")).toContainText("Desactivada");
  await expect(page.locator("#ESC-02")).toContainText("Registros que debe durar antes de escalar: 6");
  await page.getByRole("button", {name:"Editar política ESC-QA",exact:true}).click();
  await editor.getByLabel("Título", {exact:true}).fill("Confirmación actualizada");
  await editor.getByRole("button", {name:"Guardar política"}).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("#ESC-QA")).toContainText("Confirmación actualizada");
  await page.getByLabel("Modo de búsqueda").selectOption("text");
  await page.getByLabel("Buscar políticas", {exact:true}).fill("ESC-QA");
  await page.getByRole("button", {name:"Buscar",exact:true}).click();
  await expect(page.locator(".policies-layout article section")).toHaveCount(1);
  await page.getByRole("button", {name:"Editar política ESC-QA",exact:true}).click();
  await editor.getByRole("button", {name:"Eliminar política",exact:true}).click();
  await editor.getByRole("button", {name:"Confirmar eliminación"}).click();
  await expect(editor).toHaveCount(0);
  await page.goto("/escalation-policies#ESC-QA");
  await expect(page.locator("#ESC-QA")).toContainText("fue eliminada");
  await page.goto("/policies#D1");
  await expect(page).toHaveURL(/\/coordination-policies#D1$/);
  await expect(page.getByRole("heading", {name:"Políticas de coordinación",exact:true})).toBeVisible();
  await expect(page.getByText("Referencia D1", {exact:true})).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Old editable doctrine")).toHaveCount(0);
});
