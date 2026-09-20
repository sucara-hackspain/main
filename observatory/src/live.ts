// npm run live — the live mode: one process that owns the only session that may be running, and the 112 line's webhook.
//
//   :8112  POST /phone      where the HappyRobot voice workflow posts a call the moment the caller hangs up (the tunnel
//                           points here). The call goes into the live session; with none running it waits for the next.
//   :8113  GET  /           what is live now, the nights that can be played, the calls that came in
//          POST /start      { night, coordinator: "hr" | "reglas", tickMs, attention } — refused while one is running
//          POST /decision   { id, optionId, label, action? } — what the operator decided on a request the session is waiting on
//          POST /test-call  a made-up call, handled exactly like a real one: to rehearse the demo without phoning
//          POST /stop       ends the running session at its next tick
//
// The Control Center reaches :8113 through its own /api/live, so the button that starts a session lives there.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Graph, type Action, type EscalationRequest, type GraphData, type PhoneCall, type Simulation } from "./engine";
import { play, READINGS_DIR, type Attention, type Policy } from "./lab/play";
import { loadScenarios } from "./lab/scenario";
import { FollowupLine } from "./phone/followup";
import { HappyRobotPhoneLine } from "./phone/happyrobot";
import { startPhoneWebhook } from "./phone/webhook";
import { happyRobotCallGenerator, HappyRobotTriage } from "./triage/happyrobot";

const PHONE_PORT = Number(process.env.LIVE_PHONE_PORT ?? 8112);
const CONTROL_PORT = Number(process.env.LIVE_CONTROL_PORT ?? 8113);
/** Where the control API listens: this machine only, unless a deployment's viewer runs in another container. */
const CONTROL_HOST = process.env.LIVE_CONTROL_HOST ?? "127.0.0.1";
/** A call that found no session running is kept this long for the next one. */
const CALL_WAITS_MS = 15 * 60_000;

const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const nights = loadScenarios();

interface Live {
  id: string;
  night: string;
  title: string;
  coordinator: "hr" | "reglas";
  attention: Attention | "ninguno";
  tickMs: number;
  ticks: number;
  tick: number;
  dead: number;
  startedAt: string;
  sim: Simulation | null;
  abort: AbortController;
  /** In the live mode an escalation stops the night until the operator has decided on it. */
  approvals: boolean;
  awaiting: Awaited[];
  decided: Action[];
  /** Whoever is stopped until nothing is awaited: the night itself, at most twice (before a tick, after an escalation). */
  waiters: (() => void)[];
}
/** What the session is stopped on: a request of the escalation desk, or a real 112 call that has just come in. */
type Awaited =
  | (EscalationRequest & { type: "escalation"; since: string })
  | { type: "call"; id: string; policyId: "112"; title: string; incidentId: null; since: string; call: PhoneCall; via: string };
let live: Live | null = null;
let last: { id: string; endedAt: string; dead: number; victims: number; stopped: boolean; error: string | null } | null = null;
const calls: { at: string; street: string | null; text: string; via: string; session: string | null }[] = [];
let waiting: { call: PhoneCall; at: number }[] = [];
const heard = new Set<string>();

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);

// A session whose process died still says "running" on disk, and the viewers would follow it for ever.
if (existsSync("runs"))
  for (const id of readdirSync("runs")) {
    const file = `runs/${id}/meta.json`;
    if (!id.startsWith("live-") || !existsSync(file)) continue;
    const meta = JSON.parse(readFileSync(file, "utf8"));
    if (meta.status === "running") writeFileSync(file, JSON.stringify({ ...meta, status: "failed" }, null, 2));
  }

function takeCall(call: PhoneCall, via: string, again = false) {
  // A real call can arrive twice: posted by the workflow when it ends, and read again from the workflow's runs.
  const key = `${call.street}|${call.text}`;
  if (heard.has(key) && !again) return;
  heard.add(key);
  calls.unshift({ at: new Date().toISOString(), street: call.street, text: call.text, via, session: live?.id ?? null });
  calls.splice(30);
  if (live?.sim && live.approvals) {
    // A real person has just phoned: the night stops until the operator has looked at the call.
    live.awaiting.push({ type: "call", id: `call:${Date.now()}`, policyId: "112", title: `Llamada real al 112${call.street ? ` · ${call.street}` : ""}`, incidentId: null, since: new Date().toISOString(), call, via });
    log(`112: llamada real (${via}) → ${live.id} se para y espera al operador · ${call.street ?? "sin calle"} · ${call.text}`);
  } else if (live?.sim) {
    live.sim.phone(call);
    log(`112: llamada real (${via}) → ${live.id} · ${call.street ?? "sin calle"} · ${call.text}`);
  } else {
    waiting.push({ call, at: Date.now() });
    log(`112: llamada real (${via}) sin sesión en vivo: espera a la siguiente · ${call.street ?? "sin calle"}`);
  }
}

const phoneLine = process.env.HAPPYROBOT_PHONE_WORKFLOW_ID
  ? new HappyRobotPhoneLine({ onCall: (call, runId) => takeCall(call, `sondeo ${runId}`), onError: (error) => log(`112: ${error}`) })
  : null;
startPhoneWebhook({
  port: PHONE_PORT,
  onCall: (call) => takeCall(call, "webhook"),
  // The post came without the record: the call has just ended, read it from the platform (it takes a moment to be there).
  onPing: () => [0, 2000, 5000].forEach((ms) => setTimeout(() => void phoneLine?.poll(), ms)),
  onError: (error) => log(`112: ${error}`),
});

/**
 * The 112 desk and the ring-backs of a live session, as `run.ts --desk happyrobot --phone` has them: the triage agent
 * prioritises every call as it comes in, the call generator invents callers every 9 ticks, and whoever phoned on the
 * real line about a low or medium case is rung back 10 ticks later. Traced next to the session (desk.jsonl, followups.jsonl).
 */
function liveAgents(id: string) {
  const trace = (file: string, entry: unknown) => appendFileSync(`runs/${id}/${file}`, JSON.stringify(entry) + "\n");
  const triage = new HappyRobotTriage({
    onTrace: (t) => {
      trace("desk.jsonl", { agent: "112-triage", ...t });
      const v = t.verdict;
      log(`TRIAJE 112 t${t.tick} ${t.callId} (${(t.ms / 1000).toFixed(1)} s): ${t.error ? `SIN RESPUESTA [${t.error}]` : `${v!.matchedNewIncident ? "incidente nuevo" : `→ ${v!.matchedIncidentId}`} · ${v!.incidents.find((i) => i.callIds.includes(t.callId) || i.id === v!.matchedIncidentId)?.priority ?? "?"}`}`);
    },
  });
  const generate = happyRobotCallGenerator({
    streets: () => [...new Set(Array.from({ length: 40 }, () => graph.streetAt(Math.floor(Math.random() * graph.nodeCount))).filter((s): s is string => !!s))].slice(0, 12),
    onTrace: (t) => {
      trace("desk.jsonl", { agent: "112-coordinator", ...t });
      log(`MESA 112 t${t.tick}: ${t.error ? `sin llamadas [${t.error}]` : `${t.calls.length} llamadas inventadas`} (${(t.ms / 1000).toFixed(1)} s)`);
    },
  });
  const followups = new FollowupLine({
    afterTicks: 10,
    onTrace: (t) => {
      trace("followups.jsonl", t);
      log(`SEGUIMIENTO 112 t${t.tick} ${t.callId} (${t.phone}): ${t.outcome}${t.why ? ` · ${t.why}` : ""}${t.report ? ` · contesta ${t.report.reached}, ${t.report.evolution}, siguiente ${t.report.nextAction}` : ""}${t.error ? ` [${t.error}]` : ""}`);
    },
  });
  return {
    desk: { everyTicks: 9, triageEvery: 1, generate, triage: (input: Parameters<HappyRobotTriage["triage"]>[0]) => triage.triage(input) },
    followup: (input: Parameters<FollowupLine["tick"]>[0]) => followups.tick(input),
    stop: () => followups.stop(),
  };
}

function start(body: { night?: string; coordinator?: string; tickMs?: number; attention?: string; approvals?: boolean }): { status: number; body: unknown } {
  if (live) return { status: 409, body: { error: `Ya hay una sesión en vivo (${live.id}). Párala antes de empezar otra.`, live: view() } };
  const night = nights.find((n) => n.id === (body.night ?? "H1"));
  if (!night) return { status: 400, body: { error: `No existe la noche ${body.night}` } };
  const coordinator = body.coordinator === "reglas" ? "reglas" : "hr";
  if (coordinator === "hr" && !process.env.HAPPYROBOT_API_KEY) return { status: 400, body: { error: "Faltan las credenciales de HappyRobot en observatory/.env" } };
  const tickMs = Math.min(60_000, Math.max(1000, Number(body.tickMs) || 30_000));
  // The agent's reading of a night's citizen channel is done once and kept; a night nobody has read gets a control room.
  const asked = (body.attention ?? "agente") as Attention | "ninguno";
  const attention = asked === "agente" && !existsSync(`${READINGS_DIR}/${night.id}.json`) ? "sala" : asked;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const session: Live = {
    id: `live-${stamp}-${night.id}-${coordinator}`, night: night.id, title: night.title, coordinator, attention, tickMs,
    ticks: night.ticks, tick: 0, dead: 0, startedAt: new Date().toISOString(), sim: null, abort: new AbortController(),
    approvals: body.approvals !== false, awaiting: [], decided: [], waiters: [],
  };
  // Stopping the session also ends any wait for the operator.
  session.abort.signal.addEventListener("abort", () => release(session, true), { once: true });
  live = session;
  // The voice workflow may post its calls somewhere else (the VPS, another laptop): while a session runs, the platform
  // is also asked every few seconds for the calls that have just ended, so a real call gets here either way.
  phoneLine?.start();
  const policy: Policy = coordinator === "hr" ? { kind: "agent", doctrine: { rules: [] }, harness: "plan" } : { kind: "registry" };
  // With the platform's key, the 112 desk and the ring-backs come with the session, whoever coordinates.
  const agents = process.env.HAPPYROBOT_API_KEY ? liveAgents(session.id) : null;
  log(`EN VIVO: empieza ${session.id} (${night.title}) · ${coordinator === "hr" ? "coordina el agente de HappyRobot" : "coordinan las reglas"} · ${tickMs / 1000} s por tick${agents ? " · mesa 112 y seguimientos activos" : ""}`);
  play(night, policy, graph, {
    channel: attention === "ninguno" ? undefined : { attention, outbound: attention === "agente" || attention === "perfecto" },
    traceId: session.id,
    tickMs,
    desk: agents?.desk,
    followup: agents?.followup,
    background: true,
    everyTicks: 6,
    signal: session.abort.signal,
    onTick: (tick, dead) => { session.tick = tick; session.dead = dead; },
    gate: () => settled(session),
    onEscalations: session.approvals ? async (raised, tick) => {
      session.tick = tick;
      session.awaiting.push(...raised.map((r) => ({ ...r, type: "escalation" as const, since: new Date().toISOString() })));
      for (const r of raised) log(`OPERADOR: ${session.id} espera una decisión · ${r.policyId} · ${r.title}${r.incidentId ? ` · ${r.incidentId}` : ""}`);
      await settled(session);
      return session.decided.splice(0);
    } : undefined,
    onSim: (sim) => {
      session.sim = sim;
      const fresh = waiting.filter((w) => Date.now() - w.at <= CALL_WAITS_MS);
      waiting = [];
      for (const w of fresh) {
        if (session.approvals) session.awaiting.push({ type: "call", id: `call:${w.at}`, policyId: "112", title: `Llamada real al 112${w.call.street ? ` · ${w.call.street}` : ""}`, incidentId: null, since: new Date().toISOString(), call: w.call, via: "en espera" });
        else sim.phone(w.call);
        log(`112: ${session.approvals ? "espera al operador en" : "entra en"} ${session.id} una llamada que había llegado sin sesión · ${w.call.street ?? "sin calle"}`);
      }
    },
  })
    .then((game) => {
      last = { id: session.id, endedAt: new Date().toISOString(), dead: game.dead, victims: game.victims, stopped: session.abort.signal.aborted, error: null };
      log(`EN VIVO: ${session.abort.signal.aborted ? "parada" : "termina"} ${session.id} · ${game.dead} muertos de ${game.victims}`);
    })
    .catch((error) => {
      last = { id: session.id, endedAt: new Date().toISOString(), dead: session.dead, victims: 0, stopped: false, error: String(error?.message ?? error) };
      const file = `runs/${session.id}/meta.json`;
      if (existsSync(file)) writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "failed" }, null, 2));
      log(`EN VIVO: ${session.id} ha fallado · ${last.error}`);
    })
    .finally(() => {
      agents?.stop();
      if (live === session) { live = null; phoneLine?.stop(); }
    });
  return { status: 200, body: view() };
}

/** Resolves once the session is waiting on nothing (or has been stopped). */
function settled(session: Live): Promise<void> {
  return new Promise((resolve) => (session.awaiting.length === 0 || session.abort.signal.aborted ? resolve() : session.waiters.push(resolve)));
}
function release(session: Live, force = false) {
  if (!force && session.awaiting.length) return;
  if (force) session.awaiting = [];
  for (const go of session.waiters.splice(0)) go();
}

/** Calls to rehearse with: what the voice agent would file, on streets the map knows. */
const REHEARSAL: PhoneCall[] = [
  { caller: "family", mechanism: "flooded_home", street: "Carrer de Sant Vicent Màrtir", locationErrorM: 120, conscious: "yes", breathing: "difficult", bleeding: "no", trapped: "yes", ageGroup: "elderly", victims: 1,
    text: "Llamada real al 112: «Mi madre tiene 82 años, vive en un bajo y el agua le llega por la cintura. No puede subir las escaleras y casi no me contesta»" },
  { caller: "driver", mechanism: "vehicle_trapped", street: "Avinguda del Cid", locationErrorM: 200, conscious: "yes", breathing: "normal", bleeding: "no", trapped: "yes", ageGroup: "adult", victims: 3,
    text: "Llamada real al 112: «Estamos tres en el coche, el agua ha entrado hasta los asientos y las puertas no abren. La corriente nos está moviendo»" },
  { caller: "bystander", mechanism: "collapse", street: "Carrer de Sueca", locationErrorM: 150, conscious: "no", breathing: "unknown", bleeding: "yes", trapped: "unknown", ageGroup: "adult", victims: 2,
    text: "Llamada real al 112: «Se ha venido abajo el muro de un garaje y había dos personas delante. Una no se mueve y la otra sangra mucho de la cabeza»" },
];
let rehearsed = 0;

function decide(body: { id?: string; optionId?: string; label?: string; action?: Action; approved?: boolean; accept?: boolean }): { status: number; body: unknown } {
  const session = live;
  const request = session?.awaiting.find((r) => r.id === body.id);
  if (!session || !request) return { status: 409, body: { error: "La sesión en vivo no está esperando esa decisión.", ...view() } };
  session.awaiting = session.awaiting.filter((r) => r !== request);
  if (request.type === "call") {
    // The operator takes the call in, or sets it aside: only then does the night go on.
    const accept = body.accept !== false;
    if (accept) session.sim?.phone(request.call);
    appendFileSync(`runs/${session.id}/operator.jsonl`, JSON.stringify({ at: new Date().toISOString(), tick: session.tick, requestId: request.id, kind: "call", accepted: accept, street: request.call.street, text: request.call.text, waitedMs: Date.now() - Date.parse(request.since) }) + "\n");
    log(`OPERADOR: ${accept ? "da entrada a" : "descarta"} la llamada real · ${request.call.street ?? "sin calle"}`);
    release(session);
    return { status: 200, body: view() };
  }
  if (body.action) session.decided.push(body.action);
  const decision = { at: new Date().toISOString(), tick: session.tick, requestId: request.id, policyId: request.policyId, kind: request.kind, incidentId: request.incidentId, optionId: body.optionId ?? null, label: body.label ?? null, approved: body.approved ?? null, action: body.action ?? null, waitedMs: Date.now() - Date.parse(request.since) };
  appendFileSync(`runs/${session.id}/operator.jsonl`, JSON.stringify(decision) + "\n");
  log(`OPERADOR: decide «${body.label ?? "continuar"}» sobre ${request.policyId}${request.incidentId ? ` · ${request.incidentId}` : ""}${body.action ? ` → ${JSON.stringify(body.action)}` : ""}`);
  release(session);
  return { status: 200, body: view() };
}

/** Where on the map the caller said they were, if the map knows that street. */
function whereIs(call: PhoneCall): [number, number] | null {
  const node = call.node ?? (call.street ? graph.findStreet(call.street) : null);
  return node === null || node === undefined ? null : (graph.data.nodes[node] ?? null);
}

function view() {
  return {
    live: live && { id: live.id, night: live.night, title: live.title, coordinator: live.coordinator, attention: live.attention, tickMs: live.tickMs, tick: live.tick, ticks: live.ticks, dead: live.dead, startedAt: live.startedAt, stopping: live.abort.signal.aborted, approvals: live.approvals, awaiting: live.awaiting.map((a) => (a.type === "call" ? { type: a.type, id: a.id, policyId: a.policyId, title: a.title, incidentId: null, since: a.since, street: a.call.street, text: a.call.text, via: a.via, call: a.call, at: whereIs(a.call) } : a)) },
    last,
    nights: nights.map((n) => ({ id: n.id, title: n.title, family: n.family, ticks: n.ticks, victims: n.stats.victims, read: existsSync(`${READINGS_DIR}/${n.id}.json`) })),
    agent: Boolean(process.env.HAPPYROBOT_API_KEY),
    phone: { port: PHONE_PORT, line: Boolean(phoneLine), waiting: waiting.length, calls },
  };
}

createServer((req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const path = (req.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (req.method === "GET") return reply(200, view());
  if (req.method !== "POST") return reply(405, { error: "GET o POST" });
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (path === "/stop") {
      if (!live) return reply(200, view());
      live.abort.abort();
      log(`EN VIVO: se pide parar ${live.id}`);
      return reply(200, view());
    }
    if (path === "/test-call") {
      if (!live) return reply(409, { error: "Empieza una sesión en vivo para ensayar una llamada dentro de ella.", ...view() });
      takeCall(REHEARSAL[rehearsed++ % REHEARSAL.length], "simulacro", true);
      return reply(200, view());
    }
    if (path === "/decision") {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: "cuerpo no válido" }); }
      const out = decide(body);
      return reply(out.status, out.body);
    }
    if (path === "/start") {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: "cuerpo no válido" }); }
      const out = start(body);
      return reply(out.status, out.body);
    }
    reply(404, { error: "no existe" });
  });
}).listen(CONTROL_PORT, CONTROL_HOST);

log(`Modo en vivo listo · control en http://127.0.0.1:${CONTROL_PORT} · llamadas del 112 en :${PHONE_PORT}/phone${phoneLine ? "" : " (sin línea de HappyRobot configurada: solo webhook)"}`);
