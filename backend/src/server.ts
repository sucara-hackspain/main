// Webhooks de los workflows de voz: 112-inbound envía cada llamada a POST /phone al colgar; 112-outbound, el parte de seguimiento a POST /followup.
// Solo se apuntan en inbox.jsonl; el siguiente `npm run sim -- step` los mete en la partida (triaje, seguimiento, prioridad).
// Expón el puerto con ngrok y apunta los nodos POST de ambos workflows con `npm run webhooks`.
//   npm run phone
//   curl -X POST localhost:3000/phone -H 'content-type: application/json' -d @mock-call.json
import { createServer } from "node:http";
import { PHONE_PORT } from "./config.js";
import { enqueue, pendingInbox } from "./inbox.js";

const ROUTES = { "/phone": "call", "/followup": "followup" } as const;

createServer((req, res) => {
  const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const kind = req.method === "POST" ? ROUTES[req.url as keyof typeof ROUTES] : undefined;
  if (!kind) return reply(404, { error: `solo POST ${Object.keys(ROUTES).join(" | ")}` });
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      enqueue(kind, body);
      const summary = kind === "call" ? String(((body.call ?? body) as Record<string, unknown>).text ?? "").slice(0, 100) : `${body.callId}: ${String((body.followup as Record<string, unknown> | undefined)?.nextAction ?? "?")}`;
      console.log(`📥 ${kind} en la bandeja (${pendingInbox().length} pendientes): ${summary}`);
      reply(200, { ok: true, queued: kind, pending: pendingInbox().length, note: "entra en la partida en el próximo `npm run sim -- step`" });
    } catch (e) {
      reply(400, { ok: false, error: (e as Error).message });
    }
  });
}).listen(PHONE_PORT, () => console.log(`📞 POST /phone y /followup en :${PHONE_PORT}${process.env.PUBLIC_URL ? ` (${process.env.PUBLIC_URL})` : ""} → inbox.jsonl`));
