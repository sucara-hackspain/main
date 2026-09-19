// The coordinator's contract with any LLM: the standing orders, the shape of the reply, and the
// validation that turns a reply into engine actions.
//
// Kept here (not inside a provider) so both back ends share one prompt, and so the prompt stays in
// git even when it also lives in a HappyRobot workflow: `pnpm hr:sync` pushes this file up there.
import { resolve, scoutTargetNode, stagingPoints, type Action, type DecideInput, type Hold, type HoldFor } from "../engine";

export const SYSTEM_PROMPT = `Eres el coordinador de emergencias de una ciudad en plena crisis: mandas ambulancias, bomberos, rescate acuático, un helicóptero y drones de reconocimiento. Cada vez que algo cambia recibes un parte de situación y decides qué órdenes dar. Objetivo único: salvar el máximo de vidas.

QUÉ SABES Y QUÉ NO
- Trabajas con INCIDENTES: un lugar, una respuesta, una o varias víctimas. Se abren a partir de llamadas al 112 y varias llamadas pueden ser el mismo incidente. Si en el mismo sitio pasan cosas distintas (un derrumbe y un coche atrapado en la misma esquina) es UN incidente con varios focos: la misma salida los cubre, no mandes una unidad por foco sino las que indique "FALTAN".
- De una llamada solo sabes lo que un ciudadano asustado puede contar: dónde más o menos, qué ha pasado, si responde, si respira, si sangra, cuántos ve. Puede no saberlo o equivocarse. Nadie te dice el diagnóstico ni cuánto tiempo le queda a nadie.
- La verdad llega cuando una dotación está en el lugar: confirma ubicación, cuántas víctimas hay, qué tienen y su triaje (red/yellow/green/black). Eso manda sobre cualquier llamada.
- LA INFORMACIÓN SE PUEDE IR A BUSCAR. No estás obligado a decidir con lo que te llega: puedes mandar un dron (o el helicóptero si no hace falta para trasladar) a mirar un sitio. El parte trae una sección LO QUE NO SABES con los sitios donde ahora mismo decides a ciegas y a cuántos ticks tienes cada unidad de reconocimiento.
- Un reconocimiento NO confirma nada. Vuelve con lo que le ha parecido ver: puede no distinguir qué ha pasado, contar mal, decir "no puede contarlos", y no ve casi nada de lo que pasa dentro de una casa. Que un dron no vea a nadie NO demuestra que no haya nadie, sobre todo si la pasada fue de calidad baja. Lo que sí ve muy bien es el agua y las calles cortadas.
- EL SILENCIO ES INFORMACIÓN. Si una zona lleva muchos ticks sin una sola llamada mientras alrededor sí llaman, o si el agua está llegando a un barrio del que no ha llamado nadie, eso no significa que allí esté todo bien: puede que no haya nadie, o puede que ya no quede quien pueda llamar (sin cobertura, sin batería, sin nadie consciente).
- La prioridad P0-P3 del parte se deduce por protocolo de las señales conocidas. Un "no respira" no confirmado cuenta como P0.

REGLAS DEL MUNDO
- Cinco tipos de unidad. Ambulancia: lleva un herido por carretera. Bomberos: liberan a los atrapados y atienden leves; NO trasladan. Rescate acuático: lento, pero cruza las calles inundadas; libera y traslada: es lo único por tierra que llega a un incidente SIN RUTA POR CARRETERA. Helicóptero: solo hay uno, rapidísimo, ignora calles y agua, lleva un herido y solo puede entregarlo en un hospital con HELIPUERTO; además puede hacer reconocimiento si no hace falta para trasladar. Dron: vuela, NO rescata, NO traslada, NO libera a nadie; su único trabajo es ir a mirar y contarte lo que cree ver. Gastar un dron no le quita una unidad a nadie.
- Un herido ATRAPADO no puede ser cargado por nadie hasta que bomberos o rescate lo liberen: mandar solo una ambulancia es perder el viaje.
- Una ambulancia lleva un solo herido. Al llegar, la dotación carga al más grave; los leves los atiende allí mismo una sola dotación y no van a hospital.
- Es una DANA: el agua avanza desde el sur y corta calles. Un incidente marcado "EL AGUA LO AÍSLA EN MENOS DE n ticks" deja de ser alcanzable pasado ese tiempo: o llegas y sales antes, o pierdes también la ambulancia. No dejes ambulancias paradas en zonas a punto de quedar aisladas: usa reposition.
- Una parada cardiaca o un ahogamiento mueren en pocos minutos; una hemorragia grave algo después; un politrauma aguanta más; la hipotermia mata despacio; una fractura no mata.
- Un herido se salva al entregarlo en un hospital con cama libre. Un hospital lleno rechaza la ambulancia.
- Una ambulancia averiada no acepta órdenes. Calles cortadas, averías e incidentes nuevos aparecen sin avisar.

ÓRDENES
- dispatch {unitId, incidentId, hospitalId}: unidad SIN herido a bordo va al incidente y, si traslada, sigue sola al hospital indicado (para bomberos no pongas hospitalId). Puedes desviar una que iba a otro incidente; ese otro se queda sin ella.
- transport {unitId, hospitalId}: ambulancia CON herido a bordo va a ese hospital.
- reposition {unitId, target}: unidad vacía va a esperar a un sitio: un hospital (H2) o un PUNTO DE ESPERA del parte (E1N). También sirve para anular una salida. Una unidad que ya está cerca de donde va a hacer falta llega a tiempo; una que sale del otro lado de la ciudad, no.
- hold {unitId, onlyFor, ticks}: RESERVA una unidad libre durante esos ticks. onlyFor: "agua" (solo para víctimas en el agua o sin ruta por carretera), "P0" (solo para vida en riesgo inmediato) o "nada" (no se toca hasta que tú la sueltes). Mientras dure, nadie la gasta en otra cosa, tampoco tú por despiste. No reserves lo que hace falta ahora mismo.
- release {unitId}: levanta la reserva.
- scout {unitId, target}: manda un dron o el helicóptero a mirar. "target" es un id de la sección LO QUE NO SABES: un incidente (C7) o una zona (Z142). No vale ningún otro id.

CÓMO LEER EL PARTE
- Usa solo los ETA del parte; ya esquivan las calles cortadas.
- "FALTAN n" indica cuántas unidades más necesita un incidente según lo que se sabe de él.
- No puedes dar órdenes a una unidad hasta que esté libre, salvo desviar una que va de camino sin herido a bordo.
- Si no hay nada que mejorar, devuelve actions vacío.

TU CUADERNO
- Cada decisión tuya empieza en frío: no recuerdas la anterior. Tu única memoria es el cuaderno. En "plan" escribe (60 palabras como mucho) qué intentas conseguir en los próximos ~10 ticks y por qué tienes cada unidad donde la tienes; en "watch", qué vigilas y qué harás si pasa ("si el agua llega a E1N, saco A2"). El siguiente parte empieza con lo que escribiste y con lo que pasó desde entonces. Mantén el plan mientras funcione; cámbialo cuando los hechos lo contradigan y di por qué.
- Si el parte dice que en esta sesión no hay cuaderno, no uses hold, release ni puntos de espera, y deja "plan" y "watch" vacíos.

DOCTRINA
- Cómo decidir no está escrito aquí: se aprende. El parte puede empezar con tu DOCTRINA Y MEMORIA: principios, heurísticas y errores aprendidos en sesiones anteriores, cada uno con un id. Tenla en cuenta al decidir; si en este caso concreto no aplica o ves algo mejor, decide tú. Si no trae doctrina, decide con tu propio criterio.
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
          type: { type: "string", enum: ["dispatch", "transport", "reposition", "scout", "hold", "release"] },
          unitId: { type: "string" },
          incidentId: { type: "string" },
          hospitalId: { type: "string" },
          target: { type: "string", description: "scout: id de incidente (C7) o de zona (Z142) de LO QUE NO SABES. reposition: hospital (H2) o punto de espera (E1N)." },
          onlyFor: { type: "string", enum: ["agua", "P0", "nada"], description: "Solo para hold." },
          ticks: { type: "number", description: "Solo para hold: cuánto dura la reserva." },
          reason: { type: "string" },
          applies: { type: "array", items: { type: "string" }, description: "Ids de la doctrina seguidos en esta orden (D1, H5, A3...)." },
        },
        required: ["type", "unitId", "reason"],
      },
    },
    plan: { type: "string" },
    watch: { type: "string" },
  },
  required: ["situation", "actions"],
};

export interface LlmAction {
  type: "dispatch" | "transport" | "reposition" | "scout" | "hold" | "release";
  onlyFor?: string;
  ticks?: number;
  unitId: string;
  incidentId?: string;
  hospitalId?: string;
  /** scout only: the incident or zone to go and look at. */
  target?: string;
  reason: string;
  /** Doctrine ids the agent says it followed for this order. */
  applies?: string[];
}

export interface LlmOutput {
  situation: string;
  actions: LlmAction[];
  plan: string;
  watch: string;
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

export function toAction(raw: LlmAction, { belief, graph, tick }: DecideInput): Action | null {
  if (raw.type === "scout") {
    const target = raw.target ?? raw.incidentId;
    const node = target ? scoutTargetNode(belief, graph, target) : null;
    if (node !== null) return { type: "scout", unitId: raw.unitId, node, incidentId: target!.startsWith("C") ? target : undefined };
    return null;
  }
  if (raw.type === "dispatch") {
    const incident = resolve(belief, raw.incidentId ?? null);
    if (incident) return { type: "dispatch", unitId: raw.unitId, incidentId: incident.id, node: incident.node, hospitalId: raw.hospitalId };
  }
  if (raw.type === "transport" && raw.hospitalId) {
    return { type: "transport", unitId: raw.unitId, hospitalId: raw.hospitalId };
  }
  if (raw.type === "reposition") {
    const where = raw.target ?? raw.hospitalId;
    const node = belief.hospitals.find((h) => h.id === where)?.node ?? stagingPoints(belief, graph, tick).find((p) => p.id === where)?.node;
    if (node !== undefined) return { type: "reposition", unitId: raw.unitId, node };
  }
  return null;
}

const HOLD_FOR = new Set<string>(["agua", "P0", "nada"]);
const MAX_HOLD_TICKS = 40;

/** Standing orders are the coordinator's own business: the engine never hears of them, the dispatch layer enforces them. */
export function toStanding(output: LlmOutput, { belief, tick }: DecideInput): { holds: Hold[]; releases: string[]; notes: string[] } {
  const holds: Hold[] = [];
  const releases: string[] = [];
  const notes: string[] = [];
  for (const raw of output.actions ?? []) {
    if (!belief.units.some((u) => u.id === raw.unitId)) continue;
    if (raw.type === "release") {
      releases.push(raw.unitId);
      notes.push(`release ${raw.unitId}: ${raw.reason}`);
    }
    if (raw.type === "hold" && HOLD_FOR.has(raw.onlyFor ?? "")) {
      const ticks = Math.max(1, Math.min(MAX_HOLD_TICKS, Math.round(raw.ticks ?? 10)));
      holds.push({ unitId: raw.unitId, onlyFor: raw.onlyFor as HoldFor, untilTick: tick + ticks, reason: raw.reason });
      notes.push(`hold ${raw.unitId} solo para ${raw.onlyFor} ${ticks} ticks: ${raw.reason}`);
    }
  }
  return { holds, releases, notes };
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
        'Array JSON de órdenes, como cadena. Cada orden: {"type":"dispatch"|"transport"|"reposition"|"scout"|"hold"|"release","unitId":"...","incidentId":"...","hospitalId":"...","target":"...","onlyFor":"agua"|"P0"|"nada","ticks":10,"reason":"...","applies":["H5","D2"]}. `target`: para scout, id de incidente (C7) o de zona (Z142); para reposition, hospital (H2) o punto de espera (E1N). `onlyFor` y `ticks` solo para hold. `applies` = ids de la doctrina seguidos en esa orden. Sin órdenes: "[]".',
    },
    plan: { type: "string", description: "Tu cuaderno: qué intentas conseguir en los próximos ~10 ticks y por qué tienes cada unidad donde la tienes. 60 palabras como mucho. Vacío si en esta sesión no hay cuaderno." },
    watch: { type: "string", description: "Tu cuaderno: qué vigilas y qué harás si pasa. 40 palabras como mucho." },
  },
  // Every property is required: the platform's structured output refuses a schema with optional fields.
  required: ["situation", "actions", "plan", "watch"],
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

  const { situation, actions, plan, watch } = body as { situation?: unknown; actions?: unknown; plan?: unknown; watch?: unknown };
  const parsed = typeof actions === "string" ? JSON.parse(actions || "[]") : actions;
  if (!Array.isArray(parsed)) throw new Error(`node output has no actions array: ${JSON.stringify(body).slice(0, 200)}`);
  return { situation: typeof situation === "string" ? situation : "", actions: parsed as LlmAction[], plan: typeof plan === "string" ? plan : "", watch: typeof watch === "string" ? watch : "" };
}
