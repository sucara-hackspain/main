import { cutStreet, punctureAmbulance, spawnInjured } from "../actions.js";
import { OPENROUTER_MODEL, OPENROUTER_URL } from "../config.js";
import type { RoadMap } from "../map/road-map.js";
import type { Master } from "../simulation.js";
import { logEvent, type World } from "../world.js";
import { buildBriefing, type Briefing } from "./briefing.js";
import { MAX_PER_TURN, PlanSchema, planJsonSchema, TTL_RANGE, type Plan } from "./schema.js";

const SYSTEM_PROMPT = `Eres el Director de Escenario ("Master") de un simulador de emergencias: una DANA (lluvia torrencial e inundaciones) sobre València y l'Horta Sud. Cada turno equivale a ~1 minuto. Recibes el estado y listas de candidatos; solo puedes actuar sobre elementos de esas listas.

Tu trabajo es poner a prueba al coordinador de ambulancias de forma realista, progresiva y jugable:
- Empieza suave (pocos heridos, sin cortes) y escala: barrancos desbordados en el sur/suroeste (Paiporta, Catarroja, Benetússer, Alfafar) que cortan calles; después el caos llega a la ciudad.
- Corta preferentemente calles que estén en la ruta de alguna ambulancia (\`enRutaDeAmbulancia\`) para forzar desvíos, pero no todas a la vez.
- Heridos nuevos con ttl (turnos de vida) coherente con la gravedad: 4-8 críticos, 10-20 leves. Prefiere lugares lejos de las ambulancias libres.
- Pinchazos: raros (aprox. 1 de cada 8 turnos), nunca dos turnos seguidos.
Límites por turno: máximo 1 calle cortada, máximo 3 heridos nuevos, máximo 1 pinchazo. Un turno tranquilo (listas vacías) es válido.
Responde únicamente con el JSON del plan.`;

type ChatCompletion = { choices?: { message?: { content?: string } }[] };

/** Master IA vía OpenRouter (API compatible con OpenAI) con salida estructurada por JSON Schema. */
export const llmMaster: Master = async (w, map) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("falta OPENROUTER_API_KEY (ponla en backend/.env)");
  const briefing = buildBriefing(w, map);

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "dana-sim" },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(briefing.summary) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "plan", strict: true, schema: planJsonSchema() } },
      reasoning: { effort: "low" }, // ponytail: low = rápido por turno; sube si el master es tonto
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const content = ((await res.json()) as ChatCompletion).choices?.[0]?.message?.content ?? "";
  const plan = parsePlan(content);
  if (!plan) return logEvent(w, `MASTER: respuesta inválida: ${content.slice(0, 120)}`);
  applyPlan(w, map, plan, briefing);
};

function parsePlan(content: string): Plan | null {
  try {
    const result = PlanSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Aplica el plan validando contra los candidatos ofrecidos y los límites por turno. */
function applyPlan(w: World, map: RoadMap, plan: Plan, { streets, places }: Briefing) {
  logEvent(w, `MASTER: ${plan.narration}`);
  for (const name of plan.cut.filter((n) => streets.has(n)).slice(0, MAX_PER_TURN.cut)) cutStreet(w, map, name, streets.get(name)!.near);
  for (const { place, ttl } of plan.spawn.filter((x) => places[x.place] !== undefined).slice(0, MAX_PER_TURN.spawn))
    spawnInjured(w, map, places[place], Math.min(TTL_RANGE.max, Math.max(TTL_RANGE.min, ttl)));
  for (const id of plan.puncture.slice(0, MAX_PER_TURN.puncture)) punctureAmbulance(w, id);
}
