// Seguimiento de los heridos atendidos, unos turnos después del rescate:
// - con teléfono (llamada real): el agente de voz de 112-outbound le llama; tarda minutos, así que solo se lanza y el parte vuelve por POST /followup.
// - sin teléfono (coordinador 112, Master): sim-112-outbound inventa el parte en el acto.
// El parte cambia la prioridad del caso (mejor → low, peor → high) y, si hay que escalar, el caso vuelve a entrar como llamada nueva.
import { z } from "zod";
import { FOLLOWUP_AFTER_TURNS, FOLLOWUP_PRIORITIES, FOLLOWUP_SIMULATED, OUTBOUND_WORKFLOW, SIM_OUTBOUND_NODE, SIM_OUTBOUND_WORKFLOW } from "./config.js";
import type { Injured, InjuredId } from "./entities/injured.js";
import { callFromInjured } from "./actions.js";
import { runWorkflow, triggerRun } from "./happyrobot.js";
import type { RoadMap } from "./map/road-map.js";
import { reprioritize } from "./recorder.js";
import { admitCall, priorityOf, triagePending, type Call, type Priority } from "./triage.js";
import { logEvent, type World } from "./world.js";

const MAX_TRIES = 2; // ponytail: si no contesta, un reintento y se cierra

/** Parte que rellena el agente tras la llamada. Tolerante: lo escribe una IA a partir de la transcripción. */
export const FollowupReportSchema = z.object({
  reached: z.string().catch("unknown"), // patient | family | other | voicemail | no_answer
  evolution: z.string().catch("unknown"), // better | same | worse | unknown
  painNow: z.coerce.number().nullable().catch(null),
  painTrend: z.string().catch("unknown"),
  mobility: z.string().catch("unknown"),
  fever: z.string().catch("unknown"),
  bleeding: z.string().catch("unknown"),
  woundWorse: z.string().catch("unknown"),
  redFlags: z.string().catch("unknown"),
  soughtCare: z.string().catch("unknown"),
  alone: z.string().catch("unknown"),
  street: z.string().nullable().catch(null),
  locationErrorM: z.coerce.number().catch(300),
  escalate: z.string().catch("unknown"), // yes | no | unknown
  escalationReason: z.string().nullable().catch(null),
  nextAction: z.string().catch("monitor"), // monitor | followup_again | escalate_operator | dispatch_resource | close | retry_call
  text: z.string().catch(""),
});
export type FollowupReport = z.infer<typeof FollowupReportSchema>;

/** Lo que el nodo POST de 112-outbound envía a /followup al colgar. */
export const FollowupPostSchema = z.object({ callId: z.string(), phone: z.string().catch(""), callStatus: z.string().catch("unknown"), followup: FollowupReportSchema });

export type Followup = {
  id: InjuredId; // = callId que ve el workflow
  call: Call; // la llamada original, con teléfono
  priority: Priority;
  incidentId?: string; // incidente del tablón al que pertenecía, para que la UI siga mostrando el caso cerrado con su seguimiento
  status: "pending" | "calling" | "done";
  dueTurn: number; // no se llama antes de este turno
  tries: number;
  runId?: string;
  report?: FollowupReport;
};

export function queueFollowup(w: World, map: RoadMap, h: Injured, afterTurns = FOLLOWUP_AFTER_TURNS) {
  const dueTurn = w.turn + afterTurns;
  const incidentId = w.incidents.find((i) => i.callIds.includes(h.id))?.id;
  w.followups.push({ id: h.id, call: h.call ?? callFromInjured(w, map, h), priority: priorityOf(w, h.id), incidentId, status: "pending", dueTurn, tries: 0 });
  logEvent(w, `📋 ${h.id}: seguimiento en t${dueTurn}`);
}

/** Al rescatar: prioridad en FOLLOWUP_PRIORITIES y, o teléfono (llamada real), o seguimiento simulado activado. */
export function scheduleFollowup(w: World, map: RoadMap, h: Injured) {
  if ((h.call?.phone || FOLLOWUP_SIMULATED) && FOLLOWUP_PRIORITIES.includes(priorityOf(w, h.id))) queueFollowup(w, map, h);
}

/** Cada seguimiento pendiente que ya toca: con teléfono se lanza la llamada real (el parte llega a POST /followup); sin él, se simula y se aplica en el acto. */
export async function placeFollowupCalls(w: World, map: RoadMap) {
  for (const f of w.followups.filter((f) => f.status === "pending" && f.dueTurn <= w.turn)) {
    const { mechanism, street, ageGroup, conscious, breathing, bleeding, trapped, phone } = f.call;
    f.tries++;
    try {
      if (phone) {
        f.runId = await triggerRun(OUTBOUND_WORKFLOW, { callId: f.id, phone, priority: f.priority, mechanism, street, ageGroup, conscious, breathing, bleeding, trapped });
        f.status = "calling";
        logEvent(w, `📞 ${f.id}: llamando para seguimiento (run ${f.runId})`, { type: "followup", injuredId: f.id, text: `Llamada de seguimiento a ${phone}` });
      } else {
        const payload = { narrative_seed: "", tick: w.turn, followup_id: `F${f.tries}`, call_id: f.id, name: "", mechanism, street, ageGroup, conscious, breathing, bleeding, trapped, incident_text: f.call.text };
        const [report] = await runWorkflow<unknown>(SIM_OUTBOUND_WORKFLOW, payload, SIM_OUTBOUND_NODE);
        if (!report) throw new Error("el simulador no devolvió parte");
        await applyFollowup(w, map, f, FollowupReportSchema.parse(report), "simulated");
      }
    } catch (e) {
      logEvent(w, `⚠️ seguimiento de ${f.id} falló: ${(e as Error).message}`);
    }
  }
}

/** Parte de la llamada real, por webhook. */
export async function receiveFollowup(w: World, map: RoadMap, post: z.infer<typeof FollowupPostSchema>, triage = triagePending) {
  const f = w.followups.find((x) => x.id === post.callId);
  if (!f) throw new Error(`seguimiento desconocido: ${post.callId}`);
  await applyFollowup(w, map, f, post.followup, post.callStatus, triage);
}

/** Prioridad que deja el parte: peor o con banderas rojas → high; mejor o cerrado → low; si no, la que había. */
export function priorityAfter(r: FollowupReport, before: Priority): Priority {
  const redFlags = !["", "none", "unknown", "null"].includes(r.redFlags.trim().toLowerCase());
  if (r.escalate === "yes" || r.evolution === "worse" || redFlags || ["dispatch_resource", "escalate_operator"].includes(r.nextAction)) return "high";
  if (r.evolution === "better" || r.nextAction === "close") return "low";
  return before;
}

/** Aplica un parte (real o simulado): guarda, reprioriza, reintenta si no contestan, y escala reabriendo el caso como llamada nueva. */
export async function applyFollowup(w: World, map: RoadMap, f: Followup, r: FollowupReport, callStatus: string, triage = triagePending) {
  f.report = r;
  f.status = "done";
  if (["retry_call", "followup_again"].includes(r.nextAction) && f.tries < MAX_TRIES) {
    f.status = "pending";
    f.dueTurn = w.turn + FOLLOWUP_AFTER_TURNS;
    logEvent(w, `📋 ${f.id} seguimiento (${callStatus}): ${r.reached}, se reintenta en t${f.dueTurn}`, { type: "followup", injuredId: f.id, text: `Seguimiento sin resultado (${r.reached}); se reintenta en t${f.dueTurn}` });
    return;
  }
  const before = f.priority;
  f.priority = priorityAfter(r, before);
  reprioritize(w, f.id, f.priority);
  const change = f.priority === before ? `prioridad ${before}` : `prioridad ${before} → ${f.priority}`;
  logEvent(w, `📋 ${f.id} seguimiento (${callStatus}, contesta ${r.reached}): ${r.evolution}, siguiente ${r.nextAction}, ${change}${r.escalationReason ? ` — ${r.escalationReason}` : ""}`, {
    type: "followup", injuredId: f.id, text: `Seguimiento (${callStatus}, contesta ${r.reached}): ${r.evolution}; siguiente ${r.nextAction}; ${change}. ${r.text}`,
  });
  if (r.escalate === "yes" || ["dispatch_resource", "escalate_operator"].includes(r.nextAction)) {
    const h = admitCall(w, map, { ...f.call, tick: w.turn, street: r.street ?? f.call.street, locationErrorM: r.locationErrorM, bleeding: r.bleeding, text: `Seguimiento de ${f.id}: ${r.text}` });
    await triage(w, map);
    logEvent(w, `🔁 ${f.id} escalado: vuelve al tablón como ${h.id} [${priorityOf(w, h.id)}]`);
  }
}
