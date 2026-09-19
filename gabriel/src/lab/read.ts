// pnpm lab:read H1 H2 ... — the agent reads a night's citizen channel once, and the reading is kept in lab/readings.
// A night never changes, so neither does what it says: every later game of that night reuses the reading for free.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Graph, type GraphData, type Signal, type Verdict } from "../engine";
import { pool, READINGS_DIR, signalsOf } from "./play";
import { loadScenarios } from "./scenario";

const MODEL = process.env.LAB_READER_MODEL ?? "claude-haiku-4-5-20251001";
const BATCH = 140;
const PARALLEL = 5;

const PROMPT = `Eres el lector del canal ciudadano de una sala de emergencias durante una DANA en Valencia. Te llegan mensajes de redes sociales, WhatsApp municipal y sensores, casi todos ruido. Tu trabajo: encontrar los pocos que hablan de una persona REAL en apuros AHORA y AQUÍ, para que el 112 pueda mandar a alguien.

CUENTA como relevante: alguien atrapado, en el agua, herido o sin poder salir; una persona (sobre todo mayor o que vive sola) de la que no se sabe nada y podría estar dentro de una casa inundada; un testigo que ve a alguien en peligro; una alarma de ascensor con ocupante.
NO cuenta: comentarios sobre la lluvia, la luz o el transporte; bromas e ironías aunque digan "socorro" o "atrapado"; noticias, recuerdos de otras riadas o consejos; rumores sin testigo directo ("dicen que", "me han dicho"); gente que dice estar bien.
Lo más valioso suele NO llevar ninguna palabra de alarma: «mi tía no coge el teléfono, vive en el bajo de...» vale más que un «SOCORRO» en broma.

Devuelve SOLO los mensajes con credibilidad 0,3 o más; los demás se dan por ruido. Para cada uno: credible (0-1: probabilidad de persona real en apuros ahora), urgency (alta: en el agua, atrapado con el agua subiendo o no responde; media: sin contacto o en peligro probable; baja: el resto), mechanism (flooded_home: casa o bajo inundado · vehicle_trapped: coche atrapado por el agua · swept_away: arrastrado por el agua · building_collapse: derrumbe · fall: caída · collapse: persona desplomada · null si no se sabe), trapped (yes/no/unknown), ageGroup (child/adult/elderly/unknown), victims (número o null) y summary (una frase de 20 palabras como mucho, para el operador).`;

const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          credible: { type: "number" },
          urgency: { type: "string", enum: ["alta", "media", "baja"] },
          mechanism: { type: ["string", "null"], enum: ["flooded_home", "vehicle_trapped", "swept_away", "building_collapse", "fall", "collapse", null] },
          trapped: { type: "string", enum: ["yes", "no", "unknown"] },
          ageGroup: { type: "string", enum: ["child", "adult", "elderly", "unknown"] },
          victims: { type: ["number", "null"] },
          summary: { type: "string" },
        },
        required: ["id", "credible", "urgency", "trapped", "ageGroup", "summary"],
      },
    },
  },
  required: ["verdicts"],
};

function ask(input: string): Promise<{ verdicts: Partial<Verdict>[] }> {
  const args = ["-p", "--model", MODEL, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands", "--system-prompt", PROMPT, "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)];
  const { CLAUDECODE: _nested, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("timeout"))), 240_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", (err) => (clearTimeout(timer), reject(err)));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.structured_output) throw new Error(String(parsed.result ?? "no structured output").slice(0, 200));
        resolve(parsed.structured_output);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(input);
  });
}

const noise = (s: Signal): Verdict => ({ id: s.id, relevant: false, credible: 0.05, urgency: "baja", mechanism: null, trapped: "unknown", ageGroup: "unknown", victims: null, summary: "" });

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const wanted = process.argv.slice(2);
mkdirSync(READINGS_DIR, { recursive: true });
for (const night of loadScenarios().filter((s) => wanted.includes(s.id))) {
  const file = `${READINGS_DIR}/${night.id}.json`;
  const reading: Record<string, Verdict> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const todo = signalsOf(night, graph).signals.filter((s) => !reading[s.id]);
  const batches = Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, n) => todo.slice(n * BATCH, (n + 1) * BATCH));
  console.log(`${night.id}: ${todo.length} mensajes por leer en ${batches.length} tandas (${MODEL})`);
  const started = Date.now();
  let done = 0;
  await pool(batches, PARALLEL, async (batch) => {
    const input = batch.map((s) => `${s.id} | ${s.channel} | ${s.street ?? "sin ubicación"} | ${s.text}`).join("\n");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { verdicts } = await ask(input);
        const found = new Map(verdicts.filter((v) => v.id).map((v) => [v.id!, v]));
        for (const s of batch) {
          const v = found.get(s.id);
          reading[s.id] = v ? { ...noise(s), ...v, id: s.id, relevant: (v.credible ?? 0) >= 0.3, mechanism: v.mechanism ?? null, victims: v.victims ?? null } as Verdict : noise(s);
        }
        writeFileSync(file, JSON.stringify(reading));
        console.log(`  ${night.id} tanda ${++done}/${batches.length}: ${found.size} relevantes de ${batch.length} (${Math.round((Date.now() - started) / 1000)} s)`);
        return;
      } catch (err) {
        console.log(`  ${night.id}: tanda fallida (${err instanceof Error ? err.message : err}), reintento ${attempt + 1}`);
      }
    }
  });
}
