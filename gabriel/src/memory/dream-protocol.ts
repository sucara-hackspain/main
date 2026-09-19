import type { Evaluation, Finding } from "./evaluate";
import { CONCEPTS, type RuleKind } from "./seed";
import type { MemoryStore } from "./store";

// The dream's contract with whatever model runs it (a HappyRobot workflow, or Claude as a stand-in).
// Kept in git next to the coordinator's protocol; `pnpm hr:sync --dream` pushes it to the platform.

export const MAX_RULES = 34;
const MAX_FINDINGS = 30;

export const DREAM_PROMPT = `Eres la memoria a largo plazo de un coordinador de emergencias. La sesión ha terminado. Ahora, sin prisa y con toda la información —incluida la que el coordinador no tenía cuando decidía—, repasas lo ocurrido y reorganizas su doctrina para que la próxima noche decida mejor.

RECIBES
- El resultado de la sesión y los HALLAZGOS: cada muerte y cada viaje perdido con su causa, y los casos críticos que salieron bien. Cada hallazgo tiene un id (E1, E2...) y la doctrina que el coordinador citó en ese incidente.
- Cuánto se usó cada regla de la doctrina.
- La MEMORIA ACTUAL: principios (D), heurísticas (H) y errores a evitar (A), con su estado y confianza.

QUÉ HACES
1. Busca patrones, no anécdotas: una causa que se repite en varios hallazgos vale más que un caso suelto.
2. Distingue mala suerte de mala decisión. Si el hallazgo dice que no había unidades libres o que quedó dentro del agua sin medios para llegar, quizá no había nada que decidir mejor.
3. Contrasta con la memoria: ¿qué regla, de haberse seguido, lo habría evitado? ¿Qué regla se siguió y salió mal? ¿Qué falta?
4. Devuelve operaciones sobre la memoria:
   - reinforce {id, evidence, reason}: la regla se aplicó o habría evitado algo, y los hechos la respaldan.
   - weaken {id, evidence, reason}: se siguió y el resultado fue malo por seguirla, o los hechos la contradicen.
   - rewrite {id, title, body, evidence, reason}: la idea es buena pero el umbral o la redacción están mal.
   - add {kind, title, body, about, evidence, reason}: algo que la memoria no cubre. Entra EN PRUEBA.
   - merge {ids, kind, title, body, about, reason}: dos o más reglas dicen lo mismo; quedan en una.
   - retire {id, evidence, reason}: no se sostiene.

REGLAS PARA ESCRIBIR REGLAS
- Generales y accionables: qué hacer y cuándo, con umbrales si los hay. Nada de ids de incidentes, víctimas, unidades concretas ni ticks de esta sesión.
- title: 8 palabras como mucho. body: 40 palabras como mucho. En español.
- Toda operación cita en "evidence" los hallazgos que la justifican (menos merge, que puede no tenerlos).
- Como mucho 4 "add" por sesión. La memoria no debe pasar de ${MAX_RULES} reglas vivas: si va justa, fusiona o retira antes de añadir.
- Los principios (D) cambian poco: tócalos solo con evidencia fuerte y repetida.
- "about" usa solo estos conceptos: ${Object.keys(CONCEPTS).join(", ")}.
- Si la sesión no enseña nada nuevo, devuelve pocas operaciones o ninguna. No inventes lecciones.

"lessons": de 3 a 6 frases para una persona: qué pasó esta noche, por qué, y qué cambia en la doctrina.`;

export interface DreamOp {
  op: "reinforce" | "weaken" | "rewrite" | "add" | "merge" | "retire";
  id?: string;
  ids?: string[];
  kind?: RuleKind;
  title?: string;
  body?: string;
  about?: string[];
  evidence?: string[];
  reason: string;
}

export interface DreamOutput {
  lessons: string;
  ops: DreamOp[];
}

const OP_PROPERTIES = {
  op: { type: "string", enum: ["reinforce", "weaken", "rewrite", "add", "merge", "retire"] },
  id: { type: "string" },
  ids: { type: "array", items: { type: "string" } },
  kind: { type: "string", enum: ["driver", "heuristic", "antipattern"] },
  title: { type: "string" },
  body: { type: "string" },
  about: { type: "array", items: { type: "string" } },
  evidence: { type: "array", items: { type: "string" } },
  reason: { type: "string" },
};

export const DREAM_SCHEMA = {
  type: "object",
  properties: {
    lessons: { type: "string" },
    ops: { type: "array", items: { type: "object", properties: OP_PROPERTIES, required: ["op", "reason"] } },
  },
  required: ["lessons", "ops"],
};

/** Same contract for a HappyRobot node: `ops` travels as a JSON string, like the coordinator's `actions`. */
export const DREAM_HR_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "reorganizar_memoria",
  description: "Lecciones de la sesión y operaciones sobre la doctrina.",
  type: "object",
  properties: {
    lessons: { type: "string", description: "De 3 a 6 frases: qué pasó, por qué y qué cambia en la doctrina." },
    ops: {
      type: "string",
      description:
        'Array JSON de operaciones, como cadena. Cada una: {"op":"reinforce"|"weaken"|"rewrite"|"add"|"merge"|"retire","id":"H5","ids":["H1","H2"],"kind":"heuristic"|"antipattern"|"driver","title":"...","body":"...","about":["water"],"evidence":["E3"],"reason":"..."}. Solo los campos que pida cada operación. Sin cambios: "[]".',
    },
  },
  required: ["lessons", "ops"],
} as const;

const BAD_FIRST: Finding["kind"][] = [
  "death_never_dispatched",
  "death_late",
  "death_trapped_waiting",
  "death_left_waiting",
  "death_in_transport",
  "wasted_trapped_no_fire",
  "hospital_rejected",
  "wasted_turned_back",
  "wasted_nobody_there",
  "death_in_water",
  "saved_critical",
];

/** Everything the dream gets to read, as text. Finding ids are shortened to E1, E2... for the model. */
export function buildDreamInput(evaluation: Evaluation, store: MemoryStore): string {
  const { summary: s, counts, decisions } = evaluation;
  const short = (id: string) => id.split(":").pop()!;
  const lines: string[] = [];

  lines.push(`SESIÓN ${evaluation.session} · coordinador ${evaluation.coordinator} · semilla ${evaluation.seed} · ${evaluation.ticks} ticks (1 tick = 30 s)`, "");
  lines.push("RESULTADO");
  lines.push(`- ${s.saved} atendidos, ${s.dead} muertos, ${s.waiting + s.inAmbulance} sin resolver al cortar, de ${s.victims} víctimas. Supervivencia ${(s.survivalRate * 100).toFixed(0)} % (${(s.reachableSurvivalRate * 100).toFixed(0)} % entre los alcanzables); ${s.inWater} quedaron dentro del agua.`);
  if (evaluation.criticalResponseTicks !== null) lines.push(`- Respuesta media a víctimas con riesgo vital: ${evaluation.criticalResponseTicks.toFixed(1)} ticks.`);
  lines.push(`- Decisiones del agente: ${decisions.llm} respondidas${decisions.meanMs ? ` (${(decisions.meanMs / 1000).toFixed(0)} s de media)` : ""}, ${decisions.fallback} resueltas por reglas porque el agente no contestó a tiempo.`);
  lines.push(`- Hospitales (entregados/camas): ${evaluation.hospitalLoad.map((h) => `${h.id} ${h.delivered}/${h.capacity}`).join(", ")}.`);
  lines.push(`- Causas: ${Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(", ") || "sin hallazgos"}.`);

  lines.push("", "USO DE LA DOCTRINA (veces citada por el agente)");
  lines.push(evaluation.ruleUse.length ? `- ${evaluation.ruleUse.map((u) => `${u.ruleId} ×${u.times}`).join(", ")}` : "- El agente no citó ninguna regla.");
  const used = new Set(evaluation.ruleUse.map((u) => u.ruleId));
  const unused = store.rules().filter((r) => !used.has(r.id)).map((r) => r.id);
  if (unused.length) lines.push(`- Nunca citadas: ${unused.join(", ")}.`);

  const findings = [...evaluation.findings].sort((a, b) => BAD_FIRST.indexOf(a.kind) - BAD_FIRST.indexOf(b.kind) || a.tick - b.tick).slice(0, MAX_FINDINGS);
  lines.push("", `HALLAZGOS (${findings.length} de ${evaluation.findings.length})`);
  for (const f of findings) {
    lines.push(`- ${short(f.id)} [${f.kind}] ${f.detail}${f.ruleIds.length ? ` Doctrina citada en ese incidente: ${f.ruleIds.join(", ")}.` : ""}`);
  }

  lines.push("", `MEMORIA ACTUAL (${store.rules().length} reglas vivas, máximo ${MAX_RULES})`);
  for (const r of store.rules()) {
    lines.push(`- ${r.id} [${r.kind}, ${r.status === "candidate" ? "EN PRUEBA" : "activa"}, confianza ${(r.confidence ?? 0).toFixed(2)}, origen: ${r.origin}] ${r.title}: ${r.body}`);
  }
  return lines.join("\n");
}

/** Pull `{lessons, ops}` out of whatever the platform wrapped the node output in. */
export function readDreamOutput(raw: unknown): DreamOutput {
  let body = raw;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof body === "string") body = JSON.parse(body);
    if (!body || typeof body !== "object") break;
    const record = body as Record<string, unknown>;
    if ("ops" in record || "lessons" in record) break;
    const wrapper = ["data", "response", "output", "result"].find((key) => key in record);
    if (!wrapper) break;
    body = record[wrapper];
  }
  if (!body || typeof body !== "object") throw new Error(`unreadable dream output: ${JSON.stringify(raw).slice(0, 200)}`);
  const { lessons, ops } = body as { lessons?: unknown; ops?: unknown };
  const parsed = typeof ops === "string" ? JSON.parse(ops || "[]") : ops;
  if (!Array.isArray(parsed)) throw new Error(`dream output has no ops array: ${JSON.stringify(body).slice(0, 200)}`);
  return { lessons: typeof lessons === "string" ? lessons : "", ops: parsed as DreamOp[] };
}
