import { ESCALATION_DEFAULTS, escalationKinds, type Policy } from "./escalationDefaults";
export type { Policy } from "./escalationDefaults";
// Keep the old editable coordination catalog intact, but never treat it as escalation rules.
export const POLICY_KEY = "crisis-escalation-policies-v1";
export function loadPolicies(): Policy[] {
  const raw = localStorage.getItem(POLICY_KEY);
  if (!raw) return structuredClone(ESCALATION_DEFAULTS);
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || !data.every(p => typeof p.id === "string" && typeof p.title === "string" && typeof p.body === "string" && Object.hasOwn(escalationKinds, p.kind) && ["critical", "warning"].includes(p.severity))) throw Error("No se pudo leer el catálogo local. Los datos guardados se han conservado.");
  return data;
}
export function savePolicy(policy: Policy, original?: Policy): Policy[] {
  const policies = loadPolicies();
  const existing = policies.find(p => p.id === policy.id);
  if (!original && existing) throw Error("Este identificador ya existe, incluso si la política está eliminada.");
  if (original && JSON.stringify(existing) !== JSON.stringify(original)) throw Error("Esta política cambió en otra pestaña. Cierra el editor y revisa la versión actual.");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(policy.id) || !policy.title.trim() || !policy.body.trim() || !Object.hasOwn(escalationKinds, policy.kind) || !["critical", "warning"].includes(policy.severity)) throw Error("Completa el identificador, el título, la condición y la prioridad.");
  const next = { ...policy, title: policy.title.trim(), body: policy.body.trim(), updatedAt: new Date().toISOString() };
  const result = existing ? policies.map(p => p.id === next.id ? next : p) : [...policies, next];
  localStorage.setItem(POLICY_KEY, JSON.stringify(result));
  window.dispatchEvent(new Event("policies-changed"));
  return result;
}
