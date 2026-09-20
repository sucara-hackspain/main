import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { triggerAndWaitForNodeOutput } from "@happyrobot-ai/sdk/helpers";
import type { Call, Graph, Master, MasterAction, Rng, World } from "../engine";
import { buildMasterTurn, readMasterOutput, toMasterActions, unwrap, type MasterOutput } from "./protocol";

export interface MasterTrace {
  tick: number;
  turn: number;
  payload: Record<string, string>;
  response: unknown;
  actions: MasterAction[];
  dropped: string[];
  ms: number;
  error?: string;
}

export interface HappyRobotMasterOptions {
  apiKey?: string;
  workflowId?: string;
  /** `persistent_id` of the node that emits the turn. */
  nodeId?: string;
  cluster?: "us" | "eu";
  /** One turn of the master every this many ticks. */
  everyTicks?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  gameId?: string;
  onTrace?: (trace: MasterTrace) => void;
}

function clientFrom(options: { apiKey?: string; cluster?: "us" | "eu" }): HappyRobotClient {
  const apiKey = options.apiKey ?? process.env.HAPPYROBOT_API_KEY;
  if (!apiKey) throw new Error("HAPPYROBOT_API_KEY is not set (see .env.example)");
  return new HappyRobotClient({ apiKey, cluster: options.cluster ?? (process.env.HAPPYROBOT_CLUSTER as "us" | "eu") ?? "eu" });
}

/**
 * Master that thinks inside a HappyRobot workflow: every few ticks it is shown the night so far and
 * decides what happens next — where the water comes out, who gets hurt and where, what breaks.
 *
 * The simulation waits for its answer once per turn, then spreads what it decided over the ticks
 * of that turn, so the city does not change in bursts. The water, once out, advances on its own.
 * If the workflow fails, nothing new happens that turn: there is no scripted night behind it.
 */
export class HappyRobotMaster implements Master {
  readonly name = "happyrobot";
  private readonly client: HappyRobotClient;
  private readonly workflowId: string;
  private readonly nodeId: string;
  private readonly everyTicks: number;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly gameId: string;
  private readonly onTrace?: (trace: MasterTrace) => void;
  private scheduled: { tick: number; action: MasterAction }[] = [];
  /** What the master last said was going on: context for whoever words the calls. */
  narration = "";

  constructor(options: HappyRobotMasterOptions = {}) {
    const workflowId = options.workflowId ?? process.env.HAPPYROBOT_MASTER_WORKFLOW_ID;
    const nodeId = options.nodeId ?? process.env.HAPPYROBOT_MASTER_NODE_ID;
    if (!workflowId) throw new Error("HAPPYROBOT_MASTER_WORKFLOW_ID is not set (see .env.example)");
    if (!nodeId) throw new Error("HAPPYROBOT_MASTER_NODE_ID is not set (see .env.example)");
    this.client = clientFrom(options);
    this.workflowId = workflowId;
    this.nodeId = nodeId;
    this.everyTicks = options.everyTicks ?? 10;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.gameId = options.gameId ?? `sim-${Date.now()}`;
    this.onTrace = options.onTrace;
  }

  async act(world: Readonly<World>, graph: Graph, rng: Rng): Promise<MasterAction[]> {
    if (world.tick % this.everyTicks === 0) await this.playTurn(world, graph, rng);
    const due = this.scheduled.filter((s) => s.tick <= world.tick).map((s) => s.action);
    this.scheduled = this.scheduled.filter((s) => s.tick > world.tick);
    return due;
  }

  private async playTurn(world: Readonly<World>, graph: Graph, rng: Rng): Promise<void> {
    const turnNumber = world.tick / this.everyTicks + 1;
    const turn = buildMasterTurn(world, graph, rng, turnNumber, this.everyTicks, this.gameId);
    const started = Date.now();
    try {
      const result = await triggerAndWaitForNodeOutput(this.client, {
        workflowId: this.workflowId,
        nodePersistentId: this.nodeId,
        payload: turn.payload,
        timeoutMs: this.timeoutMs,
        pollIntervalMs: this.pollIntervalMs,
      });
      if (!result.ok) throw new Error(`run ${result.runId} ended as "${result.status}" without node output`);
      const output: MasterOutput = readMasterOutput(result.nodeOutput);
      const { actions, dropped } = toMasterActions(output, turn, world, graph, rng);
      this.narration = output.narration || this.narration;
      for (const action of actions) {
        // The story and the water start the turn; the rest happens some time during it.
        const now = action.type === "narrate" || action.type === "start_flood";
        this.scheduled.push({ tick: world.tick + (now ? 0 : rng.int(0, this.everyTicks - 1)), action });
      }
      this.onTrace?.({ tick: world.tick, turn: turnNumber, payload: turn.payload, response: result.nodeOutput, actions, dropped, ms: Date.now() - started });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.onTrace?.({ tick: world.tick, turn: turnNumber, payload: turn.payload, response: null, actions: [], dropped: [], ms: Date.now() - started, error });
    }
  }
}

export interface CallWriterOptions {
  apiKey?: string;
  workflowId?: string;
  nodeId?: string;
  cluster?: "us" | "eu";
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Where the workflow is published. */
  environment?: "production" | "staging" | "development";
  /** What is going on in the city, for colour. */
  context?: () => string;
  onTrace?: (trace: { callId: string; seed: string; text: string | null; ms: number; error?: string }) => void;
}

const ANSWER = { yes: "sí", no: "no", unknown: "no lo sabe" } as const;
export const WHO = { victim: "el propio herido", family: "un familiar", bystander: "un testigo a pie", driver: "un conductor que pasaba" } as const;
const WHAT: Record<string, string> = {
  vehicle_trapped: "un coche atrapado por el agua con gente dentro", flooded_home: "una planta baja que se inunda con gente dentro", swept_away: "el agua ha arrastrado a una persona",
  building_collapse: "se ha derrumbado parte de un edificio", collapse: "una persona se ha desplomado", fall: "una persona se ha caído", traffic: "un accidente de tráfico",
};

/**
 * Words a 112 call through the `sim-112` workflow. The facts are the engine's — who calls, what they
 * could tell, how sure they were of the place — and only the telling is the agent's: it is given the
 * call as the operator filed it and nothing of the truth behind it, so it cannot leak a diagnosis.
 */
export function happyRobotCallWriter(options: CallWriterOptions = {}): (call: Call) => Promise<string | null> {
  const workflowId = options.workflowId ?? process.env.HAPPYROBOT_CALLS_WORKFLOW_ID;
  const nodeId = options.nodeId ?? process.env.HAPPYROBOT_CALLS_NODE_ID;
  if (!workflowId) throw new Error("HAPPYROBOT_CALLS_WORKFLOW_ID is not set (see .env.example)");
  if (!nodeId) throw new Error("HAPPYROBOT_CALLS_NODE_ID is not set (see .env.example)");
  const client = clientFrom(options);

  return async (call) => {
    const where = call.street ? `${call.street}${call.locationErrorM > 100 ? ", sin saber a qué altura" : call.locationErrorM > 40 ? ", más o menos" : ""}` : "no sabe decir la calle";
    const seed = [
      `Contexto de la noche: ${options.context?.() || "temporal de lluvias muy fuertes en València"}.`,
      `Llama ${WHO[call.caller]}. Qué ha pasado: ${call.mechanism ? WHAT[call.mechanism] : "no sabe explicarlo, hay alguien en el suelo"}. Dónde: ${where}.`,
      `Respuestas al protocolo — consciente: ${ANSWER[call.conscious]}; respira: ${call.breathing === "unknown" ? "no lo sabe" : { normal: "bien", difficult: "con dificultad", none: "no respira" }[call.breathing]}; sangra mucho: ${ANSWER[call.bleeding]}; atrapado, no puede salir: ${ANSWER[call.trapped]}; edad: ${{ child: "un niño", adult: "adulto", elderly: "persona mayor", unknown: "no lo dice" }[call.ageGroup]}; heridos: ${call.victims ?? "no sabe cuántos"}.`,
      `Escribe el campo text EN ESPAÑOL, en 2 o 3 frases, como lo contaría esa persona por teléfono, nerviosa. No añadas ningún dato clínico que no esté arriba ni cambies ninguna respuesta: lo que "no sabe", no lo sabe.`,
    ].join(" ");
    const started = Date.now();
    try {
      const result = await triggerAndWaitForNodeOutput(client, {
        workflowId, nodePersistentId: nodeId, payload: { narrative_seed: seed, tick: String(call.tick), call_id: call.id },
        environment: options.environment ?? (process.env.HAPPYROBOT_CALLS_ENVIRONMENT as CallWriterOptions["environment"]) ?? "production",
        timeoutMs: options.timeoutMs ?? 30_000, pollIntervalMs: options.pollIntervalMs ?? 500,
      });
      if (!result.ok) throw new Error(`run ${result.runId} ended as "${result.status}"`);
      const reply = unwrap(result.nodeOutput, "text");
      // The workflow files the call under the id it was given. Another id means our facts never reached it
      // (a trigger that does not take an API payload) and the call it made up is about something else.
      if (reply.id !== call.id) throw new Error(`the workflow did not receive the call (answered as ${String(reply.id)})`);
      const text = String(reply.text ?? "").trim();
      if (!text) throw new Error("no text in the node output");
      const worded = `${WHO[call.caller][0].toUpperCase()}${WHO[call.caller].slice(1)}: «${text.replace(/^[«"]|[»"]$/g, "")}»`;
      options.onTrace?.({ callId: call.id, seed, text: worded, ms: Date.now() - started });
      return worded;
    } catch (err) {
      options.onTrace?.({ callId: call.id, seed, text: null, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
}
