import { createServer, type Server } from "node:http";
import type { PhoneCall } from "../engine";
import { unwrap } from "../masters/protocol";
import { toPhoneCall } from "./happyrobot";

/**
 * Where the 112 voice workflow posts the call record the moment the caller hangs up (its `POST` node).
 * The session listens on a local port; a tunnel (ngrok, cloudflared) gives the platform an address for it.
 */
export function startPhoneWebhook(options: { port: number; onCall: (call: PhoneCall) => void; onError?: (error: string) => void }): Server {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET") return reply(200, { ok: true, listening: "POST /phone" });
    if (req.method !== "POST") return reply(405, { ok: false });
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const call = toPhoneCall(unwrap(raw, "caller"));
        options.onCall(call);
        reply(200, { ok: true, street: call.street });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        options.onError?.(`${error} · cuerpo: ${raw.slice(0, 200)}`);
        reply(400, { ok: false, error });
      }
    });
  });
  server.listen(options.port);
  return server;
}
