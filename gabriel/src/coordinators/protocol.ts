// The coordinator's contract with any LLM: the standing orders, the shape of the reply, and the
// validation that turns a reply into engine actions.
//
// Kept here (not inside a provider) so both back ends share one prompt, and so the prompt stays in
// git even when it also lives in a HappyRobot workflow: `pnpm hr:sync` pushes this file up there.
import { resolve, type Action, type DecideInput } from "../engine";

export const SYSTEM_PROMPT = `Eres el coordinador de emergencias de una ciudad en plena crisis: mandas ambulancias, bomberos, rescate acuático y un helicóptero. Cada vez que algo cambia recibes un parte de situación y decides qué órdenes dar. Objetivo único: salvar el máximo de vidas.

QUÉ SABES Y QUÉ NO
- Trabajas con INCIDENTES: un lugar, una respuesta, una o varias víctimas. Se abren a partir de llamadas al 112 y varias llamadas pueden ser el mismo incidente.
- De una llamada solo sabes lo que un ciudadano asustado puede contar: dónde más o menos, qué ha pasado, si responde, si respira, si sangra, cuántos ve. Puede no saberlo o equivocarse. Nadie te dice el diagnóstico ni cuánto tiempo le queda a nadie.
- La verdad llega cuando una dotación está en el lugar: confirma ubicación, cuántas víctimas hay, qué tienen y su triaje (red/yellow/green/black). Eso manda sobre cualquier llamada.
- La prioridad P0-P3 del parte se deduce por protocolo de las señales conocidas. Un "no respira" no confirmado sigue siendo P0: mejor sobretriaje que perder una parada.

REGLAS DEL MUNDO
- Cuatro tipos de unidad. Ambulancia: lleva un herido por carretera. Bomberos: liberan a los atrapados y atienden leves; NO trasladan. Rescate acuático: lento, pero cruza las calles inundadas; libera y traslada: es lo único por tierra que llega a un incidente SIN RUTA POR CARRETERA. Helicóptero: solo hay uno, rapidísimo, ignora calles y agua, lleva un herido y solo puede entregarlo en un hospital con HELIPUERTO.
- Un herido ATRAPADO no puede ser cargado por nadie hasta que bomberos o rescate lo liberen: mandar solo una ambulancia es perder el viaje.
- Una ambulancia lleva un solo herido. Al llegar, la dotación carga al más grave; los leves los atiende allí mismo una sola dotación y no van a hospital.
- Es una DANA: el agua avanza desde el sur y corta calles. Un incidente marcado "EL AGUA LO AÍSLA EN MENOS DE n ticks" deja de ser alcanzable pasado ese tiempo: o llegas y sales antes, o pierdes también la ambulancia. No dejes ambulancias paradas en zonas a punto de quedar aisladas: usa reposition.
- Una parada cardiaca o un ahogamiento mueren en pocos minutos; una hemorragia grave algo después; un politrauma aguanta más; la hipotermia mata despacio; una fractura no mata.
- Un herido se salva al entregarlo en un hospital con cama libre. Un hospital lleno rechaza la ambulancia.
- Una ambulancia averiada no acepta órdenes. Calles cortadas, averías e incidentes nuevos aparecen sin avisar.

ÓRDENES
- dispatch {unitId, incidentId, hospitalId}: unidad SIN herido a bordo va al incidente y, si traslada, sigue sola al hospital indicado (para bomberos no pongas hospitalId). Puedes desviar una que iba a otro incidente; ese otro se queda sin ella.
- transport {unitId, hospitalId}: ambulancia CON herido a bordo va a ese hospital.
- reposition {unitId, hospitalId}: ambulancia vacía va a esperar junto a ese hospital (también sirve para anular una salida).

CÓMO DECIDIR
- Usa solo los ETA del parte; ya esquivan las calles cortadas.
- "FALTAN n" indica cuántas unidades más necesita un incidente. Con pocos datos (una llamada vaga) puede bastar una unidad que confirme antes de mandar más.
- Cuando todo no cabe, P0 y P1 van antes aunque lleven menos tiempo abiertos. No dejes un P3 esperando para siempre.
- No reasignes por reasignar: desvía una ambulancia solo si con ello se salva alguien más.
- Si la ambulancia que antes llegaría está a punto de quedar libre, puede compensar esperarla. No puedes darle órdenes hasta que esté libre.
- Reparte entre hospitales: no satures uno si otro está casi igual de cerca.
- Si no hay nada que mejorar, devuelve actions vacío.

DOCTRINA
- Cada parte empieza con tu DOCTRINA Y MEMORIA: principios, heurísticas y errores aprendidos en sesiones anteriores, cada uno con un id. Tenla en cuenta al decidir; si en este caso concreto no aplica o ves algo mejor, decide tú.
- En cada orden, pon en "applies" los ids que has seguido (por ejemplo ["H5","D2"]). Si no has seguido ninguno, déjalo vacío. No inventes ids.

Responde solo con la salida estructurada, en español. "situation": una frase con lo que más importa ahora. Cada acción lleva "reason" de 15 palabras como mucho.`;

/** Structured reply we ask for. Claude enforces it natively; HappyRobot carries it as the node's json_schema. */
export const SCHEMA = {
  type: "object",
  properties: {
    situation: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["dispatch", "transport", "reposition"] },
          unitId: { type: "string" },
          incidentId: { type: "string" },
          hospitalId: { type: "string" },
          reason: { type: "string" },
          applies: { type: "array", items: { type: "string" }, description: "Ids de la doctrina seguidos en esta orden (D1, H5, A3...)." },
        },
        required: ["type", "unitId", "reason"],
      },
    },
  },
  required: ["situation", "actions"],
};

export interface LlmAction {
  type: "dispatch" | "transport" | "reposition";
  unitId: string;
  incidentId?: string;
  hospitalId?: string;
  reason: string;
  /** Doctrine ids the agent says it followed for this order. */
  applies?: string[];
}

export interface LlmOutput {
  situation: string;
  actions: LlmAction[];
}

/** What the agent reads each time: the doctrine from memory, then the situation. */
export function composePrompt(briefing: string, memory?: () => string): string {
  const doctrine = memory?.();
  return doctrine ? `${doctrine}\n\n────────────────────────\n\n${briefing}` : briefing;
}

/** One call to an LLM coordinator, logged verbatim so a run can be audited or replayed. */
export interface LlmTrace {
  tick: number;
  model: string;
  prompt: string;
  response: unknown;
  ms: number;
  costUsd: number;
  error?: string;
}

export function toAction(raw: LlmAction, { belief }: DecideInput): Action | null {
  if (raw.type === "dispatch") {
    const incident = resolve(belief, raw.incidentId ?? null);
    if (incident) return { type: "dispatch", unitId: raw.unitId, incidentId: incident.id, node: incident.node, hospitalId: raw.hospitalId };
  }
  if (raw.type === "transport" && raw.hospitalId) {
    return { type: "transport", unitId: raw.unitId, hospitalId: raw.hospitalId };
  }
  if (raw.type === "reposition") {
    const hospital = belief.hospitals.find((h) => h.id === raw.hospitalId);
    if (hospital) return { type: "reposition", unitId: raw.unitId, node: hospital.node };
  }
  return null;
}

/**
 * Orders the engine can carry out, plus the reason for each. Anything naming a unit, incident or
 * hospital that does not exist is dropped: a hallucinated id must never reach the world.
 */
export function toActions(output: LlmOutput, input: DecideInput): { actions: Action[]; reasons: string[]; applies: string[][] } {
  const actions: Action[] = [];
  const reasons: string[] = [];
  const applies: string[][] = [];
  for (const raw of output.actions ?? []) {
    const action = toAction(raw, input);
    if (!action) continue;
    actions.push(action);
    reasons.push(raw.reason);
    applies.push(Array.isArray(raw.applies) ? raw.applies.filter((id) => typeof id === "string") : []);
  }
  return { actions, reasons, applies };
}

/**
 * The same contract as SCHEMA, for a HappyRobot node. `actions` travels as a JSON string because
 * the platform's structured output is happiest with flat fields — the coordinator parses it back.
 */
export const HR_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "decidir_ordenes",
  description: "Órdenes de coordinación para este parte de situación.",
  type: "object",
  properties: {
    situation: { type: "string", description: "Una frase con lo que más importa ahora." },
    actions: {
      type: "string",
      description:
        'Array JSON de órdenes, como cadena. Cada orden: {"type":"dispatch"|"transport"|"reposition","unitId":"...","incidentId":"...","hospitalId":"...","reason":"...","applies":["H5","D2"]}. `applies` = ids de la doctrina seguidos en esa orden. Sin órdenes: "[]".',
    },
  },
  required: ["situation", "actions"],
} as const;

/** Pull `{situation, actions}` out of whatever the platform wrapped the node output in. */
export function readOutput(raw: unknown): LlmOutput {
  const WRAPPERS = ["data", "response", "output", "result"];
  let body = raw;
  // The platform nests the model's reply under a couple of envelopes, and which ones depends on the
  // node type. Descend until the object in hand is the reply itself.
  for (let depth = 0; depth < 6; depth++) {
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || typeof body !== "object") break;
    const record = body as Record<string, unknown>;
    if ("situation" in record || "actions" in record) break;
    const wrapper = WRAPPERS.find((key) => key in record);
    if (!wrapper) break;
    body = record[wrapper];
  }
  if (typeof body === "string") body = JSON.parse(body);
  if (!body || typeof body !== "object") throw new Error(`unreadable node output: ${JSON.stringify(raw).slice(0, 200)}`);

  const { situation, actions } = body as { situation?: unknown; actions?: unknown };
  const parsed = typeof actions === "string" ? JSON.parse(actions || "[]") : actions;
  if (!Array.isArray(parsed)) throw new Error(`node output has no actions array: ${JSON.stringify(body).slice(0, 200)}`);
  return { situation: typeof situation === "string" ? situation : "", actions: parsed as LlmAction[] };
}
