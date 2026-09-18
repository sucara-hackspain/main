import { z } from "zod";

/** Límites por turno: la IA propone, el código recorta. */
export const MAX_PER_TURN = { cut: 1, spawn: 3, puncture: 1 };
export const TTL_RANGE = { min: 3, max: 30 };

export const PlanSchema = z.object({
  narration: z.string().describe("Una frase en español describiendo lo que pasa este turno"),
  cut: z.array(z.string()).describe("Calles a cortar, valores exactos de `streets[].name`. Máximo 1"),
  spawn: z
    .array(z.object({ place: z.int().describe("índice en `places`"), ttl: z.int().describe(`turnos de vida, ${TTL_RANGE.min}-${TTL_RANGE.max}`) }))
    .describe("Heridos nuevos. Máximo 3"),
  puncture: z.array(z.string()).describe("Ids de ambulancia que pinchan. Máximo 1, poco frecuente"),
});

export type Plan = z.infer<typeof PlanSchema>;

/** JSON Schema para `response_format`, sin los límites ±2^53 de `z.int()` ni `$schema` (los modos strict los rechazan). */
export const planJsonSchema = () =>
  JSON.parse(JSON.stringify(z.toJSONSchema(PlanSchema), (key, value) => (["minimum", "maximum", "$schema"].includes(key) ? undefined : value)));
