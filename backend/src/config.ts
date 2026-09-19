// Parámetros del simulador. Un turno ≈ 1 minuto.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env"); // OPENROUTER_API_KEY, OPENROUTER_MODEL

export const SPEED_M_PER_TURN = 600; // ~36 km/h. ponytail: knob de calibración
export const PUNCTURE_REPAIR_TURNS = 3; // turnos parada tras un pinchazo
export const CUT_RADIUS_M = 500; // un corte afecta a los tramos a menos de esta distancia
export const LOG_KEEP = 60; // eventos recientes que conserva el mundo

export const BASE_COORDS: [lat: number, lon: number] = [39.4419, -0.3752]; // Hospital La Fe
export const MAP_FILE = "data/valencia.json";
export const STATE_FILE = "state.json";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-5";

// HappyRobot: agente de triaje (una ejecución por llamada), coordinador 112 (cada N turnos genera llamadas simuladas) y seguimiento (llamada real).
export const HAPPYROBOT_API_KEY = process.env.HAPPYROBOT_API_KEY;
export const HAPPYROBOT_BASE_URL = process.env.HAPPYROBOT_BASE_URL ?? "https://platform.eu.happyrobot.ai/api/v2";
export const HAPPYROBOT_TIMEOUT_MS = Number(process.env.HAPPYROBOT_TIMEOUT_MS ?? 90_000);
export const TRIAGE_WORKFLOW = process.env.HAPPYROBOT_TRIAGE_WORKFLOW ?? "01a0ba99-6f31-7fc8-a336-20eea7a1f42d"; // 112-triage
export const TRIAGE_NODE = process.env.HAPPYROBOT_TRIAGE_NODE ?? "01a0baa7-bc35-700e-a2fb-040db5e4c531"; // nodo "Incidents Response" (persistent_id)
export const COORDINATOR_WORKFLOW = process.env.HAPPYROBOT_COORDINATOR_WORKFLOW ?? "01a0bac2-283b-7174-8857-5ea031bf4cf5"; // 112-coordinator
export const COORDINATOR_NODE = process.env.HAPPYROBOT_COORDINATOR_NODE ?? "01a0bac6-6b48-77ed-ad34-0a72b8065592"; // nodo "Call sim-112-inbound": una llamada por iteración
export const OUTBOUND_WORKFLOW = process.env.HAPPYROBOT_OUTBOUND_WORKFLOW ?? "01a0ba28-1760-7bcc-8ba5-f6a7385db05b"; // 112-outbound: llamada real de seguimiento
export const SIM_OUTBOUND_WORKFLOW = process.env.HAPPYROBOT_SIM_OUTBOUND_WORKFLOW ?? "01a0baaa-bf1e-75b3-8e33-cbbb68ed71b4"; // sim-112-outbound: seguimiento simulado (sin llamada)
export const SIM_OUTBOUND_NODE = process.env.HAPPYROBOT_SIM_OUTBOUND_NODE ?? "01a0baad-a565-7b3b-acfb-f36b7edda56f"; // nodo "Generate Followup Details"
export const FOLLOWUP_SIMULATED = (process.env.FOLLOWUP_SIMULATED ?? "on") === "on"; // llamadas sin teléfono (coordinador 112, Master): seguimiento simulado
export const FOLLOWUP_PRIORITIES = (process.env.FOLLOWUP_PRIORITIES ?? "low").split(","); // prioridades con llamada de seguimiento tras el rescate
export const FOLLOWUP_AFTER_TURNS = Number(process.env.FOLLOWUP_AFTER_TURNS ?? 10); // turnos tras el rescate antes de la llamada de seguimiento (y entre reintentos)
export const COORDINATOR_EVERY_TURNS = Number(process.env.COORDINATOR_EVERY_TURNS ?? 5);
export const SCENARIO = "DANA: lluvia torrencial e inundaciones sobre València y l'Horta Sud";
export const TTL_BY_PRIORITY = { critical: 5, high: 8, medium: 14, low: 25 }; // turnos de vida de un herido que entra por llamada, según el triaje
export const PHONE_PORT = Number(process.env.PHONE_PORT ?? 8112); // POST /phone y /followup: los workflows de voz envían aquí sus registros (PUBLIC_URL vía ngrok)
