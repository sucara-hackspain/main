import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPolicies, savePolicy, POLICY_KEY, type Policy } from "../src/ui/evidence/policyStore";

test("policy edits persist, stale writers and reused IDs fail, and deletions keep references", () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  values.set("crisis-policies-v1", JSON.stringify([{ id: "D1", title: "Old edited coordination rule" }]));
  assert.ok(loadPolicies().every(p => p.id.startsWith("ESC-")));
  assert.ok(!loadPolicies().some(p => p.id === "D1"));
  const policy: Policy = { id: "TEST", title: "Test", body: "Escalate to an operator", kind: "custom", severity: "warning" };
  savePolicy(policy);
  assert.throws(() => savePolicy(policy), /ya existe/);
  const original = loadPolicies().find(p => p.id === policy.id)!;
  savePolicy({ ...original, title: "Updated" }, original);
  assert.throws(() => savePolicy({ ...original, body: "Stale" }, original), /otra pestaña/);
  const updated = loadPolicies().find(p => p.id === policy.id)!;
  savePolicy({ ...updated, deleted: true }, updated);
  assert.equal(loadPolicies().find(p => p.id === policy.id)?.deleted, true);
  assert.throws(() => savePolicy(policy), /ya existe/);
  values.set(POLICY_KEY, "corrupt");
  assert.throws(() => loadPolicies());
  assert.throws(() => savePolicy(policy));
  assert.equal(values.get(POLICY_KEY), "corrupt");
});
