// Bandeja de entrada de los webhooks: el servidor solo apunta lo que llega (llamadas y partes de seguimiento) y cada `step` lo
// procesa antes de nada. Así la CLI, que tiene la partida en memoria durante todo el `step`, nunca pisa lo que entró mientras tanto.
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { FollowupPostSchema, receiveFollowup } from "./followup.js";
import type { RoadMap } from "./map/road-map.js";
import { admitCall, CallSchema } from "./triage.js";
import { logEvent, type World } from "./world.js";

let INBOX_FILE = "inbox.jsonl";
export const setInboxFile = (path: string) => void (INBOX_FILE = path); // los tests usan uno temporal: el real puede tener llamadas de verdad
export type InboxEntry = { kind: "call" | "followup"; body: Record<string, unknown>; at: string };

export const enqueue = (kind: InboxEntry["kind"], body: Record<string, unknown>) => appendFileSync(INBOX_FILE, JSON.stringify({ kind, body, at: new Date().toISOString() } satisfies InboxEntry) + "\n");

export const pendingInbox = (): InboxEntry[] => (existsSync(INBOX_FILE) ? readFileSync(INBOX_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as InboxEntry) : []);

/** Mete en el mundo lo que llegó por los webhooks desde el último turno y vacía la bandeja. */
export async function drainInbox(w: World, map: RoadMap) {
  if (!w.runId) return; // solo partidas reales (creadas con `init`): un mundo de prueba no debe consumir llamadas de verdad
  const entries = pendingInbox();
  if (!entries.length) return;
  unlinkSync(INBOX_FILE);
  for (const { kind, body } of entries) {
    try {
      if (kind === "call") {
        // El nodo POST de 112-inbound manda {phone, call}; una llamada suelta también vale
        const record = (body.call ?? body) as Record<string, unknown>;
        admitCall(w, map, CallSchema.parse({ ...record, phone: body.phone ?? record.phone }));
      } else {
        await receiveFollowup(w, map, FollowupPostSchema.parse(body));
      }
    } catch (e) {
      logEvent(w, `⚠️ entrada de la bandeja (${kind}) descartada: ${(e as Error).message}`);
    }
  }
}
