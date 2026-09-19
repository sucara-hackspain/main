// Apunta los nodos POST de los workflows de voz a este backend: 112-inbound → PUBLIC_URL/phone (con el teléfono del que llama),
// 112-outbound → PUBLIC_URL/followup. Publica la versión (si la publicada está bloqueada, la bifurca). Repite al cambiar de túnel.
//   npm run webhooks
import { HAPPYROBOT_API_KEY, HAPPYROBOT_BASE_URL } from "./config.js";

const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "");
if (!PUBLIC_URL || !HAPPYROBOT_API_KEY) throw new Error("faltan PUBLIC_URL o HAPPYROBOT_API_KEY en backend/.env");

const INBOUND = process.env.HAPPYROBOT_INBOUND_WORKFLOW ?? "01a0b8a1-6cb5-7720-9c8d-13616cda6286"; // 112-inbound
const OUTBOUND = process.env.HAPPYROBOT_OUTBOUND_WORKFLOW ?? "01a0ba28-1760-7bcc-8ba5-f6a7385db05b"; // 112-outbound
const VOICE_NODE = "01a0b8a1-cb9c-7396-b23f-21c68391bc48"; // "Inbound Voice Agent": `.from` es el teléfono del que llama
const CALL_NODE = "01a0b986-7c90-710f-b995-dc955e6e161b"; // "Build Call Object": `.response` es el registro de la llamada

type Node = { id: string; name: string; event_id: string; configuration: { url?: unknown; body?: { raw: string } } & Record<string, unknown> };
type Version = { id: string; name: string; is_live: boolean };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(HAPPYROBOT_BASE_URL + path, {
    method,
    headers: { Authorization: `Bearer ${HAPPYROBOT_API_KEY}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const paragraph = (text: string) => [{ type: "paragraph", children: [{ text }] }];

async function repoint(workflowId: string, path: string, rawBody: string | null) {
  const wf = await api<{ name: string; latest_version: Version }>("GET", `/workflows/${workflowId}`);
  let versionId = wf.latest_version.id;
  const postNode = async () => {
    const { data } = await api<{ data: Node[] }>("GET", `/versions/${versionId}/nodes`);
    const node = data.find((n) => n.name === "POST");
    if (!node) throw new Error(`${wf.name}: no tiene un nodo llamado "POST"`);
    return node;
  };
  const push = async () => {
    const node = await postNode();
    // La API quiere la configuración entera: mandar solo la URL borraría el cuerpo.
    const configuration = { ...node.configuration, url: paragraph(PUBLIC_URL + path), body: { ...node.configuration.body, raw: rawBody ?? node.configuration.body?.raw } };
    await api("PUT", `/versions/${versionId}/nodes/${node.id}`, { type: "action", event_id: node.event_id, configuration });
  };
  try {
    await push();
  } catch (e) {
    if (!/locked/i.test((e as Error).message)) throw e;
    const fork = await api<{ id?: string; version?: { id: string }; data?: { id: string } }>("POST", `/versions/${versionId}/fork`, {});
    versionId = fork.id ?? fork.version?.id ?? fork.data?.id ?? (await api<{ latest_version: Version }>("GET", `/workflows/${workflowId}`)).latest_version.id;
    console.log(`${wf.name}: "${wf.latest_version.name}" está bloqueada → bifurcada`);
    await push();
  }
  await api("POST", `/versions/${versionId}/publish`, { force: true });
  const node = await postNode();
  const live = (await api<{ latest_version: Version }>("GET", `/workflows/${workflowId}`)).latest_version;
  console.log(`${wf.name} → ${live.name} (live=${live.is_live})\n  url:  ${PUBLIC_URL + path}\n  body: ${node.configuration.body?.raw}`);
}

await repoint(INBOUND, "/phone", `{"phone":"{{$var:${VOICE_NODE}.from}}","call":{{$var:${CALL_NODE}.response}}}`);
await repoint(OUTBOUND, "/followup", null);
