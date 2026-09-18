import { spawn } from "node:child_process";
import {
  buildBriefing,
  GreedyCoordinator,
  type Action,
  type Coordinator,
  type DecideInput,
  type Decision,
} from "../engine";

const SYSTEM_PROMPT = `Eres el coordinador de ambulancias de una ciudad en plena crisis. Cada vez que algo cambia recibes un parte de situación y decides qué órdenes dar. Objetivo único: salvar el máximo de vidas.

REGLAS DEL MUNDO
- Un herido muere cuando sus ticks de vida llegan a 0. Esperando en la calle pierde 1 por tick; a bordo de una ambulancia pierde {DECAY} por tick. Recogerlo cuesta {PICKUP} ticks.
- Un herido se salva al entregarlo en un hospital con cama libre. Un hospital lleno rechaza la ambulancia.
- Una ambulancia lleva un solo herido. Una averiada no acepta órdenes.
- Los partes pueden quedarse viejos: calles cortadas, averías y heridos nuevos aparecen sin avisar.

ÓRDENES
- dispatch {ambulanceId, patientId, hospitalId}: ambulancia SIN herido a bordo va a por un herido y después sigue sola al hospital indicado. Puedes desviar una que ya iba a por otro herido; ese otro se queda sin ambulancia.
- transport {ambulanceId, hospitalId}: ambulancia CON herido a bordo va a ese hospital.
- reposition {ambulanceId, hospitalId}: ambulancia vacía va a esperar junto a ese hospital.

CÓMO DECIDIR
- Usa solo los ETA del parte; ya esquivan las calles cortadas.
- Antes de mandar una ambulancia comprueba que sirve: ETA hasta el herido menor que su vida, y que aguanta el viaje al hospital.
- No gastes una ambulancia en quien no va a llegar vivo si con ella puedes salvar a otro.
- No reasignes por reasignar: desvía una ambulancia solo si con ello se salva alguien más.
- Si la ambulancia que antes llegaría está a punto de quedar libre, puede compensar esperar en vez de mandar una lejana. No puedes darle órdenes hasta que esté libre.
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
          ambulanceId: { type: "string" },
          patientId: { type: "string" },
          hospitalId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["type", "ambulanceId", "reason"],
      },
    },
  },
  required: ["situation", "actions"],
};

interface LlmAction {
  type: "dispatch" | "transport" | "reposition";
  ambulanceId: string;
  patientId?: string;
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

  private ask(prompt: string, { config }: DecideInput) {
    const system = SYSTEM_PROMPT.replace("{DECAY}", String(config.ttlDecayInAmbulance)).replace(
      "{PICKUP}",
      String(config.pickupTicks),
    );
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
  if (raw.type === "dispatch" && raw.patientId) {
    return { type: "dispatch", ambulanceId: raw.ambulanceId, patientId: raw.patientId, hospitalId: raw.hospitalId };
  }
  if (raw.type === "transport" && raw.hospitalId) {
    return { type: "transport", ambulanceId: raw.ambulanceId, hospitalId: raw.hospitalId };
  }
  if (raw.type === "reposition") {
    const hospital = belief.hospitals.find((h) => h.id === raw.hospitalId);
    if (hospital) return { type: "reposition", ambulanceId: raw.ambulanceId, node: hospital.node };
  }
  return null;
}
