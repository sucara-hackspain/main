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
