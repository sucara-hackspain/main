// The researcher: reads how the current doctrine fared on the training nights and proposes what to try next.
// It never sees a validation or test game, only their verdict on its past ideas.
import { spawn } from "node:child_process";
import type { Finding } from "../memory/evaluate";
import { renderDoctrine, type Doctrine, type Edit } from "./doctrine";

export interface Hypothesis {
  name: string;
  /** What in the games makes the researcher think this. */
  rationale: string;
  /** What should change in the numbers if it is right. */
  expected: string;
  edit: Edit;
}

export interface ResearchOutput {
  analysis: string;
  hypotheses: Hypothesis[];
}

export interface PastTrial {
  generation: number;
  name: string;
  edit: string;
  trainDelta: number;
  validationDelta: number | null;
  verdict: string;
}

export interface ResearchInput {
  generation: number;
  doctrine: Doctrine;
  /** Mean deaths per training scenario with the current doctrine. */
  trainDeaths: { scenario: string; family: string; victims: number; dead: number }[];
  findings: { scenario: string; finding: Finding }[];
  ruleUse: { ruleId: string; times: number }[];
  past: PastTrial[];
  wanted: number;
}

export const RESEARCH_PROMPT = `Eres el investigador de un laboratorio que entrena a un coordinador de emergencias (un LLM) durante una DANA en una ciudad. El coordinador manda ambulancias, bomberos, rescate acuático, un helicóptero y drones, y decide con información incompleta: llamadas al 112 vagas o equivocadas, y lo que confirman las dotaciones al llegar. Antes de cada decisión lee una DOCTRINA: una lista corta de reglas. Tu trabajo es descubrir qué doctrina salva más vidas. La única medida es el número de muertos.

CÓMO FUNCIONA EL LABORATORIO
- Hay noches de entrenamiento, que tú estudias, y noches de validación, que nunca ves: solo se te dice si tu idea empeoró allí. Una regla que gana en entrenamiento y pierde en validación se rechaza por sobreajuste.
- Cada hipótesis es UN solo cambio sobre la doctrina actual: añadir una regla, reescribir una o quitar una. Así lo que pase en las partidas se le puede atribuir.
- Cada hipótesis se juega varias veces en las mismas noches que la doctrina actual y se comparan los muertos.

QUÉ ES UNA BUENA HIPÓTESIS
- Sale de los hechos: de las muertes y los viajes perdidos que tienes delante, con su causa. Di cuáles.
- Es GENERAL. Prohibido nombrar calles, barrios, hospitales concretos, ids de unidad, ids de incidente o ticks: eso es memorizar la noche, no aprender a decidir. Habla de tipos de situación (víctima atrapada, llamada vaga, incidente que el agua va a aislar, zona sin llamadas, hospital casi lleno...).
- Es accionable por el coordinador con lo que ve en su parte: prioridad P0-P3, ETA, "FALTAN n", señales de la llamada, avisos de aislamiento por agua, la sección LO QUE NO SABES, camas libres.
- Es corta: título de 3 a 7 palabras, cuerpo de 40 palabras como mucho, en imperativo.
- Las hipótesis de una misma tanda deben ser DISTINTAS entre sí: ataca causas de muerte diferentes, o la misma con mecanismos opuestos. No repitas una idea ya probada salvo que la reformules de verdad; si una regla de la doctrina no se cita nunca o no ayuda, quitarla también es una hipótesis válida.
- Tipos de regla: "driver" (qué pesa más cuando no cabe todo), "heuristic" (si pasa X, haz Y), "antipattern" (error que no repetir).

Responde solo con la salida estructurada, en español.`;

export const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    analysis: { type: "string", description: "De qué se está muriendo la gente con la doctrina actual y por qué, en 3-6 frases." },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          rationale: { type: "string" },
          expected: { type: "string" },
          op: { type: "string", enum: ["add", "rewrite", "remove"] },
          kind: { type: "string", enum: ["driver", "heuristic", "antipattern"] },
          id: { type: "string", description: "Solo para rewrite y remove: id de la regla." },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["name", "rationale", "expected", "op"],
      },
    },
  },
  required: ["analysis", "hypotheses"],
};

const MAX_FINDINGS = 60;

export function buildResearchInput(input: ResearchInput): string {
  const lines: string[] = [`GENERACIÓN ${input.generation}`, ""];
  lines.push("DOCTRINA ACTUAL", renderDoctrine(input.doctrine) || "(vacía: el coordinador decide sin ninguna regla aprendida)", "");

  lines.push("MUERTOS POR NOCHE DE ENTRENAMIENTO (media de las repeticiones)");
  for (const t of input.trainDeaths) lines.push(`- ${t.scenario} · ${t.family}: ${t.dead.toFixed(1)} muertos de ${t.victims} víctimas`);
  lines.push("");

  const counts = new Map<string, number>();
  for (const { finding } of input.findings) counts.set(finding.title, (counts.get(finding.title) ?? 0) + 1);
  lines.push("QUÉ SALIÓ MAL, EN TOTAL");
  for (const [title, n] of [...counts].sort((a, b) => b[1] - a[1])) lines.push(`- ${title}: ${n}`);
  lines.push("");

  if (input.ruleUse.length) {
    lines.push("REGLAS QUE EL COORDINADOR DICE HABER SEGUIDO (veces)", ...input.ruleUse.map((r) => `- ${r.ruleId}: ${r.times}`));
    const unused = input.doctrine.rules.filter((r) => !input.ruleUse.some((u) => u.ruleId === r.id)).map((r) => r.id);
    if (unused.length) lines.push(`- nunca citadas: ${unused.join(", ")}`);
    lines.push("");
  }

  // Deaths first: they are what counts. A sample is enough; the totals above carry the rest.
  const bad = input.findings.filter((f) => !f.finding.good).sort((a, b) => Number(b.finding.kind.startsWith("death")) - Number(a.finding.kind.startsWith("death")));
  lines.push(`CASOS (${Math.min(bad.length, MAX_FINDINGS)} de ${bad.length})`);
  for (const { scenario, finding } of bad.slice(0, MAX_FINDINGS)) lines.push(`- [${scenario}] ${finding.title}. ${finding.detail}${finding.ruleIds.length ? ` Reglas citadas en ese incidente: ${finding.ruleIds.join(", ")}.` : ""}`);
  lines.push("");

  if (input.past.length) {
    lines.push("HIPÓTESIS YA PROBADAS (Δ = muertos por noche respecto a la doctrina de entonces; negativo es mejor)");
    for (const p of input.past.slice(-30)) {
      lines.push(`- G${p.generation} «${p.name}» ${p.edit} → entrenamiento Δ${fmt(p.trainDelta)}${p.validationDelta === null ? "" : `, validación Δ${fmt(p.validationDelta)}`} · ${p.verdict}`);
    }
    lines.push("");
  }

  lines.push(`Propón exactamente ${input.wanted} hipótesis.`);
  return lines.join("\n");
}

const fmt = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;

interface RawHypothesis {
  name?: string;
  rationale?: string;
  expected?: string;
  op?: string;
  kind?: string;
  id?: string;
  title?: string;
  body?: string;
}

export function readResearchOutput(raw: unknown): ResearchOutput {
  const body = raw as { analysis?: string; hypotheses?: RawHypothesis[] };
  const hypotheses: Hypothesis[] = [];
  for (const h of body.hypotheses ?? []) {
    const kind = h.kind === "driver" || h.kind === "antipattern" ? h.kind : "heuristic";
    let edit: Edit | null = null;
    if (h.op === "add" && h.title && h.body) edit = { op: "add", kind, title: h.title, body: h.body };
    if (h.op === "rewrite" && h.id && h.title && h.body) edit = { op: "rewrite", id: h.id, title: h.title, body: h.body };
    if (h.op === "remove" && h.id) edit = { op: "remove", id: h.id };
    if (edit) hypotheses.push({ name: h.name ?? h.title ?? "sin nombre", rationale: h.rationale ?? "", expected: h.expected ?? "", edit });
  }
  return { analysis: body.analysis ?? "", hypotheses };
}

export interface Researcher {
  readonly name: string;
  propose(input: string): Promise<ResearchOutput>;
}

/** Claude Code's CLI, headless: no tools, no settings, just the prompt and a schema for the answer. */
export class ClaudeResearcher implements Researcher {
  readonly name: string;
  constructor(
    private readonly model = "claude-opus-5",
    private readonly timeoutMs = 600_000,
  ) {
    this.name = `claude-cli:${model}`;
  }

  propose(input: string): Promise<ResearchOutput> {
    const args = ["-p", "--model", this.model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands", "--system-prompt", RESEARCH_PROMPT, "--output-format", "json", "--json-schema", JSON.stringify(RESEARCH_SCHEMA)];
    const { CLAUDECODE: _nested, ...env } = process.env;
    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => (clearTimeout(timer), reject(err)));
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout);
          if (code !== 0 || parsed.is_error || !parsed.structured_output) throw new Error(String(parsed.result ?? stderr).slice(0, 300));
          resolve(readResearchOutput(parsed.structured_output));
        } catch (err) {
          reject(new Error(`claude exit ${code}: ${err instanceof Error ? err.message : err}`));
        }
      });
      child.stdin.end(input);
    });
  }
}
