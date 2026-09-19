import { spawn } from "node:child_process";
import {
  buildBriefing,
  GreedyCoordinator,
  resolve,
  type Action,
  type Coordinator,
  type DecideInput,
  type Decision,
} from "../engine";

const SYSTEM_PROMPT = `Eres el coordinador de emergencias de una ciudad en plena crisis: mandas ambulancias, bomberos, rescate acuático y un helicóptero. Cada vez que algo cambia recibes un parte de situación y decides qué órdenes dar. Objetivo único: salvar el máximo de vidas.

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

Responde solo con la salida estructurada, en español. "situation": una frase con lo que más importa ahora. Cada acción lleva "reason" de 15 palabras como mucho.`;

const SCHEMA = {
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
        },
        required: ["type", "unitId", "reason"],
      },
    },
  },
  required: ["situation", "actions"],
};

interface LlmAction {
  type: "dispatch" | "transport" | "reposition";
  unitId: string;
  incidentId?: string;
  hospitalId?: string;
  reason: string;
}

export interface LlmTrace {
  tick: number;
  model: string;
  prompt: string;
  response: unknown;
  ms: number;
  costUsd: number;
  error?: string;
}

export interface ClaudeCliOptions {
  model?: string;
  timeoutMs?: number;
  onTrace?: (trace: LlmTrace) => void;
}

/** Coordinator that thinks with a headless Claude Code process (`claude -p`), so it needs no API key. */
export class ClaudeCliCoordinator implements Coordinator {
  readonly name = "claude-cli";
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly onTrace?: (trace: LlmTrace) => void;
  private readonly fallback = new GreedyCoordinator();

  constructor(options: ClaudeCliOptions = {}) {
    this.model = options.model ?? "haiku";
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.onTrace = options.onTrace;
  }

  async decide(input: DecideInput): Promise<Decision> {
    const briefing = buildBriefing(input);
    if (!briefing.actionable) return { actions: [], source: "rules", situation: "Sin decisiones pendientes." };

    const started = Date.now();
    try {
      const result = await this.ask(briefing.text, input);
      const ms = Date.now() - started;
      this.onTrace?.({ tick: input.tick, model: this.model, prompt: briefing.text, response: result.output, ms, costUsd: result.costUsd });

      const actions: Action[] = [];
      const reasons: string[] = [];
      for (const raw of result.output.actions ?? []) {
        const action = toAction(raw, input);
        if (!action) continue;
        actions.push(action);
        reasons.push(raw.reason);
      }
      return { actions, reasons, source: "llm", situation: result.output.situation, ms, costUsd: result.costUsd };
    } catch (err) {
      // The integration is down: keep the city covered with the rule-based dispatcher.
      const error = err instanceof Error ? err.message : String(err);
      const ms = Date.now() - started;
      this.onTrace?.({ tick: input.tick, model: this.model, prompt: briefing.text, response: null, ms, costUsd: 0, error });
      return {
        actions: this.fallback.decide(input),
        source: "fallback",
        situation: "LLM no disponible: decide el despachador por reglas.",
        ms,
        error,
      };
    }
  }

  private ask(prompt: string, _input: DecideInput) {
    const system = SYSTEM_PROMPT;
    const args = [
      "-p",
      "--model", this.model,
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--system-prompt", system,
      "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA),
    ];
    // CLAUDECODE is unset so this also works when launched from inside a Claude Code session.
    const { CLAUDECODE: _nested, ...env } = process.env;

    return new Promise<{ output: { situation: string; actions: LlmAction[] }; costUsd: number }>((resolve, reject) => {
      const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout);
          if (code !== 0 || parsed.is_error || !parsed.structured_output) {
            throw new Error(`claude exit ${code}: ${String(parsed.result ?? stderr).slice(0, 300)}`);
          }
          resolve({ output: parsed.structured_output, costUsd: parsed.total_cost_usd ?? 0 });
        } catch (err) {
          reject(err instanceof SyntaxError ? new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 300)}`) : err);
        }
      });
      child.stdin.end(prompt);
    });
  }
}

function toAction(raw: LlmAction, { belief }: DecideInput): Action | null {
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
