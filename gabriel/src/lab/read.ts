// pnpm lab:read H1 H2 ... — the agent reads a night's citizen channel once, and the reading is kept in lab/readings.
// A night never changes, so neither does what it says: every later game of that night reuses the reading for free.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CallObserver, Graph, GreedyCoordinator, Simulation, type Call, type GraphData, type Signal, type Verdict } from "../engine";
import { pool, READINGS_DIR, signalsOf } from "./play";
import { loadScenarios, ScriptedMaster } from "./scenario";

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

const CALLS_PROMPT = `Eres quien escucha las llamadas al 112 enteras. Con cuarenta llamadas en espera, el operador teclea la dirección y pasa a la siguiente: detalles de vida o muerte que el llamante SÍ dijo se quedan en el texto y nunca llegan a su campo del formulario. Para cada llamada, di qué campos se deducen de lo que se dijo: trapped ("yes" si no puede salir por sí mismo: puerta que no abre, ventanilla que no baja, algo encima), breathing ("none" si no respira, "difficult" si respira con dificultad) y ageGroup ("elderly" o "child"). Incluye un campo SOLO si el texto lo sostiene; si no dice nada, no lo pongas. Devuelve una entrada por llamada que tenga algo que añadir.`;
const CALLS_SCHEMA = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: { n: { type: "number" }, trapped: { type: "string", enum: ["yes"] }, breathing: { type: "string", enum: ["none", "difficult"] }, ageGroup: { type: "string", enum: ["elderly", "child"] } },
        required: ["n"],
      },
    },
  },
  required: ["calls"],
};

function ask<T = { verdicts: Partial<Verdict>[] }>(input: string, prompt = PROMPT, schema: object = SCHEMA): Promise<T> {
  const args = ["-p", "--model", MODEL, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands", "--system-prompt", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema)];
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

/** The calls a night produces when its details get buried, as the dispatcher by rules would hear them. */
async function callsOf(night: ReturnType<typeof loadScenarios>[number], graph: Graph): Promise<Call[]> {
  const sim = new Simulation({ graph, seed: night.seed, master: new ScriptedMaster(night), coordinator: new GreedyCoordinator(), config: night.config, observer: new CallObserver({ buried: night.buried }) });
  await sim.run(night.ticks);
  return sim.belief.calls.filter((c) => c.buried);
}

const noise = (s: Signal): Verdict => ({ id: s.id, relevant: false, credible: 0.05, urgency: "baja", mechanism: null, trapped: "unknown", ageGroup: "unknown", victims: null, summary: "" });

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const wanted = process.argv.slice(2);
mkdirSync(READINGS_DIR, { recursive: true });
for (const night of loadScenarios().filter((s) => wanted.includes(s.id))) {
  if (night.buried) {
    const callsFile = `${READINGS_DIR}/${night.id}.calls.json`;
    const heard: Record<string, Call["buried"]> = existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, "utf8")) : {};
    const texts = [...new Set((await callsOf(night, graph)).map((c) => c.text))].filter((text) => !(text in heard));
    if (texts.length) {
      const { calls } = await ask<{ calls: ({ n: number } & NonNullable<Call["buried"]>)[] }>(texts.map((text, n) => `${n} | ${text}`).join("\n"), CALLS_PROMPT, CALLS_SCHEMA);
      for (const text of texts) heard[text] = {};
      for (const { n, ...fields } of calls) if (texts[n]) heard[texts[n]] = fields;
      writeFileSync(callsFile, JSON.stringify(heard, null, 1));
      console.log(`${night.id}: ${texts.length} llamadas escuchadas enteras, ${calls.length} con detalles que el formulario perdió`);
    }
  }
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
