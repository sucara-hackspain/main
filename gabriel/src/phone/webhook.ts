import { createServer, type Server } from "node:http";
import type { PhoneCall } from "../engine";
import { unwrap } from "../masters/protocol";
import { toPhoneCall } from "./happyrobot";

/**
 * Where the 112 voice workflow posts the call record the moment the caller hangs up (its `POST` node).
 * The session listens on a local port; a tunnel (ngrok, cloudflared) gives the platform an address for it.
 */
export function startPhoneWebhook(options: { port: number; onCall: (call: PhoneCall) => void; onPing?: () => void; onError?: (error: string) => void }): Server {
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
      } catch {
        // The post came without the record in it: still, a call has just ended. Go and read it from the platform now.
        options.onPing?.();
        reply(202, { ok: true, note: "no call record in the body: reading it from the workflow's run instead" });
      }
    });
  });
  server.listen(options.port);
  return server;
}
