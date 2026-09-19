// Cliente mínimo de HappyRobot: lanza un workflow, espera a que termine y lee la salida de un nodo.
import { HAPPYROBOT_API_KEY, HAPPYROBOT_BASE_URL, HAPPYROBOT_TIMEOUT_MS } from "./config.js";

const TERMINAL = new Set(["completed", "succeeded", "failed", "canceled", "skipped"]);
type RunNode = { node_persistent_id: string; status: string; output_id?: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000; // ponytail: más rápido dispara el límite de peticiones de la organización

async function api<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  if (!HAPPYROBOT_API_KEY) throw new Error("falta HAPPYROBOT_API_KEY (ponla en backend/.env)");
  const res = await fetch(HAPPYROBOT_BASE_URL + path, {
    method,
    headers: { Authorization: `Bearer ${HAPPYROBOT_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 3) {
    await sleep(15_000 * (attempt + 1)); // límite de la API pública de la organización: esperar y reintentar
    return api(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`HappyRobot ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

/** Lanza `workflow` con `payload` y devuelve el run_id sin esperar (el resultado llega por webhook). */
export async function triggerRun(workflow: string, payload: object): Promise<string> {
  const { run_id } = await api<{ run_id: string }>("POST", `/workflows/${workflow}/runs`, { payload, environment: "production" });
  return run_id;
}

/** Lanza `workflow` con `payload`, espera al final y devuelve la `response` de cada ejecución del nodo `nodeId` (persistent_id), en orden. */
export async function runWorkflow<T>(workflow: string, payload: object, nodeId: string): Promise<T[]> {
  const run_id = await triggerRun(workflow, payload);
  const deadline = Date.now() + HAPPYROBOT_TIMEOUT_MS;
  for (let status = ""; !TERMINAL.has(status); ) {
    if (Date.now() > deadline) throw new Error(`run ${run_id} no termina en ${HAPPYROBOT_TIMEOUT_MS} ms`);
    await sleep(POLL_MS);
    ({ status } = await api<{ status: string }>("GET", `/runs/${run_id}`));
  }
  const { data: nodes } = await api<{ data: RunNode[] }>("GET", `/runs/${run_id}/nodes?sort=asc`);
  const outputs: T[] = [];
  for (const n of nodes.filter((n) => n.node_persistent_id === nodeId && n.output_id && n.status === "succeeded")) {
    const { data } = await api<{ data: { data?: { response?: T } } }>("GET", `/runs/${run_id}/outputs/${n.output_id}`);
    if (data.data?.response !== undefined) outputs.push(data.data.response);
  }
  return outputs;
}
