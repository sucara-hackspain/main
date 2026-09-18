import { spawn } from "node:child_process";
import {
  buildBriefing,
  GreedyCoordinator,
  type Action,
  type Coordinator,
  type DecideInput,
  type Decision,
} from "../engine";

const SYSTEM_PROMPT = `Eres el coordinador de emergencias de una ciudad en plena crisis. Cada vez que algo cambia recibes un parte de situación y decides qué órdenes dar. Objetivo único: salvar el máximo de vidas (un crítico salvado vale 3 puntos, un grave 2, un leve 1).

LO QUE SABES Y LO QUE NO
- Solo sabes lo que te llega por partes. Las llamadas del 112 llegan con retraso y la gravedad que dan es una estimación de un ciudadano; pasa a ser exacta cuando una unidad valora al herido in situ.
- Una calle cortada solo la conoces si viene de un incidente, del boletín de inundación o si una unidad tuya se la ha encontrado (pierde tiempo dando la vuelta). Los ETA del parte solo esquivan lo conocido.
- De una zona sin cobertura no salen llamadas: puede haber heridos que desconoces. Una unidad que pase cerca los detecta.
- El radio de la inundación que ves es el del último boletín; el agua sigue avanzando.

REGLAS DEL MUNDO
- Un herido muere cuando sus ticks de vida llegan a 0. En la calle pierde 1 por tick. A bordo pierde menos según la unidad: medicalizada o helicóptero 0,35 (crítico) / 0,3 (grave); básica 1 (crítico) / 0,6 (grave); bomberos 1 / 0,8. Un crítico en una básica NO mejora: necesita medicalizada o helicóptero, o un hospital muy cerca.
- Recoger cuesta {PICKUP} ticks (el helicóptero {HELI} más por aterrizar). Un herido ATRAPADO no se puede cargar hasta que lo liberen bomberos ({EXTRICATE} ticks por persona); una ambulancia junto a él lo mantiene con vida mientras tanto. El helicóptero puede izar atrapados solo en inundaciones.
- Se salva al entregarlo en un hospital con cama y en servicio. Si el hospital no tiene la especialidad que necesita (trauma, quemados) vale un 40 % menos. El helicóptero solo aterriza en hospitales con helipuerto.
- En zona inundada solo entran bomberos (muy despacio) y el helicóptero. Un fuego activo sigue generando quemados hasta que bomberos lo apagan. Policía o bomberos despejan una calle bloqueada por un incidente.

ÓRDENES
- dispatch {unitId, patientId, hospitalId}: unidad SIN herido (ambulancia, helicóptero o bomberos) va a por un herido y después sigue sola a ese hospital. Puedes desviar una que iba a por otro; ese otro se queda sin unidad.
- transport {unitId, hospitalId}: unidad CON herido a bordo va a ese hospital.
- assist {unitId, incidentId}: bomberos o policía van a trabajar en un incidente. Con una ambulancia o el helicóptero significa "ve al lugar y valora": al llegar descubre y comunica a los heridos de ese incidente que nadie ha avisado todavía; luego tendrás que darle un dispatch.
- reposition {unitId, hospitalId}: unidad vacía va a esperar junto a ese hospital (p. ej. para sacarla del avance del agua).
- request_backup {kind}: pide a municipios vecinos una unidad más (svb, sva, fire, police). Tarda mucho y hay pocas: pídela pronto si ves que no das abasto.

CÓMO DECIDIR
- Comprueba que la unidad sirve: ETA menor que la vida estimada y que aguanta el traslado con esa unidad.
- Reserva medicalizadas y helicóptero para críticos; no las gastes en leves si hay una básica razonable.
- No gastes una unidad en quien no llegará vivo si con ella salvas a otro. Un leve puede esperar mucho.
- A un incidente con atrapados manda bomberos Y ambulancia: la ambulancia estabiliza mientras liberan.
- No reasignes por reasignar. Si lo que hay ya es bueno, devuelve actions vacío.

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
          type: { type: "string", enum: ["dispatch", "transport", "assist", "reposition", "request_backup"] },
          unitId: { type: "string" },
          patientId: { type: "string" },
          hospitalId: { type: "string" },
          incidentId: { type: "string" },
          kind: { type: "string", enum: ["svb", "sva", "fire", "police"] },
          reason: { type: "string" },
        },
        required: ["type", "reason"],
      },
    },
  },
  required: ["situation", "actions"],
};

interface LlmAction {
  type: "dispatch" | "transport" | "assist" | "reposition" | "request_backup";
  unitId?: string;
  patientId?: string;
  hospitalId?: string;
  incidentId?: string;
  kind?: "svb" | "sva" | "fire" | "police";
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
  private lastSignature = "";

  constructor(options: ClaudeCliOptions = {}) {
    this.model = options.model ?? "haiku";
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.onTrace = options.onTrace;
  }

  async decide(input: DecideInput): Promise<Decision> {
    const briefing = buildBriefing(input);
    if (!briefing.actionable) return { actions: [], source: "rules", situation: "Sin decisiones pendientes." };
    // Same open problems and same free units as the last time we asked: the answer would be the same.
    if (!briefing.urgent && briefing.signature === this.lastSignature) return { actions: [], source: "rules", situation: "Sin cambios desde la última decisión." };
    this.lastSignature = briefing.signature;

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
    const system = SYSTEM_PROMPT.replace("{PICKUP}", String(config.pickupTicks))
      .replace("{HELI}", String(config.heliLandingTicks))
      .replace("{EXTRICATE}", String(config.extricateTicks));
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
    // Extended thinking is off: it took a decision from ~5 s to over a minute, and minutes are lives here.
    // The "situation" field comes first in the schema and does the job of a short scratchpad.
    const { CLAUDECODE: _nested, ...inherited } = process.env;
    const env = { ...inherited, MAX_THINKING_TOKENS: "0" };

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
  if (raw.type === "request_backup") return raw.kind ? { type: "request_backup", kind: raw.kind } : null;
  if (!raw.unitId) return null;
  if (raw.type === "dispatch" && raw.patientId) {
    return { type: "dispatch", unitId: raw.unitId, patientId: raw.patientId, hospitalId: raw.hospitalId };
  }
  if (raw.type === "transport" && raw.hospitalId) return { type: "transport", unitId: raw.unitId, hospitalId: raw.hospitalId };
  if (raw.type === "assist" && raw.incidentId) return { type: "assist", unitId: raw.unitId, incidentId: raw.incidentId };
  if (raw.type === "reposition") {
    const hospital = belief.hospitals.find((h) => h.id === raw.hospitalId);
    if (hospital) return { type: "reposition", unitId: raw.unitId, node: hospital.node };
  }
  return null;
}
