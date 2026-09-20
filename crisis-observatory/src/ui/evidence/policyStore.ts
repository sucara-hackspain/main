import { DEFAULT_ESCALATION, isKind, type Policy } from "./escalationDefaults";
export type { Policy } from "./escalationDefaults";

// The catalogue the engine applies, read and written where the engine reads it. Editing a policy here
// changes what the next run escalates; nothing is kept in this browser.

const ENDPOINT = "/api/policies";

function check(policy: Policy) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(policy.id ?? "") || !policy.title?.trim() || !policy.body?.trim() || !isKind(policy.kind) || !["critical", "warning"].includes(policy.severity))
    throw Error("Completa el identificador, el título, la condición y la prioridad.");
  for (const key of ["afterTicks", "withinTicks", "minIncidents"] as const) {
    const value = policy[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw Error("Los umbrales deben ser números de cero en adelante.");
  }
}

async function call(method: "GET" | "PUT", body?: unknown): Promise<Policy[]> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw Error("No se pudo hablar con el motor. Comprueba que la sesión local está levantada.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error((data as { error?: string })?.error ?? "El motor rechazó el catálogo.");
  if (!Array.isArray(data)) throw Error("El motor devolvió un catálogo que no se puede leer.");
  return data as Policy[];
}

/** The catalogue in force. Falls back to the engine's own when the run API is not there (a built page). */
export async function loadPolicies(): Promise<Policy[]> {
  try {
    return await call("GET");
  } catch (err) {
    if (typeof window !== "undefined" && window.location.hostname === "localhost") throw err;
    return structuredClone(DEFAULT_ESCALATION);
  }
}

/**
 * Saves one policy into the catalogue and hands back the list as the engine now has it.
 * `original` is the version the editor opened: if the file moved on since, nothing is written.
 */
export async function savePolicy(policy: Policy, original?: Policy): Promise<Policy[]> {
  check(policy);
  const policies = await call("GET");
  const existing = policies.find((p) => p.id === policy.id);
  if (!original && existing) throw Error("Este identificador ya existe, incluso si la política está eliminada.");
  if (original && JSON.stringify(existing) !== JSON.stringify(original)) throw Error("Esta política cambió en otro sitio. Cierra el editor y revisa la versión actual.");
  const next = { ...policy, title: policy.title.trim(), body: policy.body.trim(), updatedAt: new Date().toISOString() };
  const saved = await call("PUT", existing ? policies.map((p) => (p.id === next.id ? next : p)) : [...policies, next]);
  window.dispatchEvent(new Event("policies-changed"));
  return saved;
}
