import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPolicies, savePolicy, type Policy } from "../src/ui/evidence/policyStore";
import { DEFAULT_ESCALATION } from "../src/ui/engineTrace";

/** The run API, as the engine serves it: one catalogue, validated on write. */
function server(initial: Policy[] = structuredClone(DEFAULT_ESCALATION)) {
  let stored = initial;
  const calls: string[] = [];
  const reply = (body: unknown, ok = true, status = ok ? 200 : 400) =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), { location: { hostname: "localhost" } }) });
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    if (!init?.method || init.method === "GET") return reply(stored);
    const sent = JSON.parse(String(init.body)) as Policy[];
    if (sent.some((p) => !p.title?.trim())) return reply({ error: "El catálogo tiene políticas no válidas: sin título" }, false);
    stored = sent;
    return reply(stored);
  }) as typeof fetch;
  return { calls, current: () => stored };
}

test("policies are read from and written to the engine's catalogue, with stale writers and reused ids refused", async () => {
  const api = server();
  const policies = await loadPolicies();
  assert.deepEqual(policies.map((p) => p.id), DEFAULT_ESCALATION.map((p) => p.id));

  const policy: Policy = { id: "ESC-QA", title: "Confirmación humana", body: "Escalar al operador.", kind: "rejected", severity: "warning" };
  await savePolicy(policy);
  assert.equal(api.current().at(-1)?.id, "ESC-QA");
  await assert.rejects(() => savePolicy(policy), /ya existe/);

  const saved = (await loadPolicies()).find((p) => p.id === "ESC-QA")!;
  await savePolicy({ ...saved, title: "Confirmación actualizada" }, saved);
  assert.equal((await loadPolicies()).find((p) => p.id === "ESC-QA")?.title, "Confirmación actualizada");
  // The version the editor opened is no longer the one in the catalogue: nothing is written.
  await assert.rejects(() => savePolicy({ ...saved, body: "Otra cosa" }, saved), /cambió en otro sitio/);

  // Thresholds and the switch travel with the policy; bad ones never reach the engine.
  const current = (await loadPolicies()).find((p) => p.id === "ESC-02")!;
  await savePolicy({ ...current, afterTicks: 6, enabled: false }, current);
  assert.deepEqual(
    api.current().find((p) => p.id === "ESC-02"),
    { ...current, afterTicks: 6, enabled: false, updatedAt: api.current().find((p) => p.id === "ESC-02")!.updatedAt },
  );
  await assert.rejects(() => savePolicy({ ...current, afterTicks: -2 }, current), /números de cero en adelante/);
  await assert.rejects(() => savePolicy({ ...current, id: "espacio y símbolos" }), /Completa el identificador/);

  // A deleted policy keeps its id reserved, so old alerts still point somewhere.
  const target = (await loadPolicies()).find((p) => p.id === "ESC-QA")!;
  await savePolicy({ ...target, deleted: true }, target);
  assert.equal((await loadPolicies()).find((p) => p.id === "ESC-QA")?.deleted, true);
  await assert.rejects(() => savePolicy(policy), /ya existe/);
});

test("a catalogue the engine refuses is reported, and an unreachable engine is not mistaken for an empty one", async () => {
  server();
  const policies = await loadPolicies();
  const first = policies[0];
  await assert.rejects(() => savePolicy({ ...first, title: " " }, first), /Completa el identificador/);
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
  await assert.rejects(() => loadPolicies(), /No se pudo hablar con el motor/);
});
