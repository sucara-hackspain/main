import { parseArgs } from "node:util";
import { cutStreet, punctureAmbulance, spawnInjured } from "./actions.js";
import { MAP_FILE } from "./config.js";
import { loadGraph, type Coords } from "./map/graph.js";
import { RoadMap } from "./map/road-map.js";
import { printEvents, printStatus } from "./render.js";
import { step, type Master } from "./simulation.js";
import { createWorld, loadWorld, saveWorld, type World } from "./world.js";

const HELP = `uso: npm run sim -- <cmd>
  init [-n 4]                        nueva partida (base en La Fe)
  status                             estado actual
  step [k] [--master llm|none]       avanza k turnos (Coordinador → mover → Master → t++)
  spawn [--at lat,lon] [--ttl 10]    herido (aleatorio si no hay --at)
  cut <calle> [--at lat,lon]         corta la calle (entera, o solo 500 m alrededor de --at)
  puncture <A1>                      pincha una ambulancia`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ambulances: { type: "string", short: "n", default: "4" },
    ttl: { type: "string", default: "10" },
    at: { type: "string" }, // lat,lon
    master: { type: "string" }, // llm | none (por defecto: llm si hay OPENROUTER_API_KEY en .env)
  },
});
const [command = "help", ...args] = positionals;
const parseCoords = (s: string) => s.split(",").map(Number) as Coords;

type Command = (w: World, map: RoadMap) => void | Promise<void>;
const commands: Record<string, Command> = {
  status: printStatus,
  async step(w, map) {
    const useLlm = opt.master ? opt.master === "llm" : !!process.env.OPENROUTER_API_KEY;
    if (!useLlm && !opt.master) console.log("(sin OPENROUTER_API_KEY en .env: turno sin Master; usa spawn/cut/puncture a mano o --master llm)");
    const master: Master | undefined = useLlm ? (await import("./master/llm-master.js")).llmMaster : undefined;
    for (let i = 0; i < Number(args[0] ?? 1); i++) await step(w, map, { master });
  },
  spawn(w, map) {
    spawnInjured(w, map, opt.at ? map.nearest(parseCoords(opt.at)) : map.randomNode(), Number(opt.ttl));
  },
  cut(w, map) {
    const near = opt.at ? map.nearest(parseCoords(opt.at)) : undefined;
    if (!cutStreet(w, map, args.join(" "), near)) console.log("ninguna calle con ese nombre (o ya cortada)");
  },
  puncture(w) {
    if (!punctureAmbulance(w, args[0])) console.log(`no existe la ambulancia ${args[0]}`);
  },
};

if (command === "help") {
  console.log(HELP);
} else {
  const map = new RoadMap(loadGraph(MAP_FILE));
  if (command === "init") {
    const w = createWorld(map, Number(opt.ambulances));
    saveWorld(w);
    console.log(`Base en ${map.streetOf(w.base.position)} (La Fe), ${w.ambulances.length} ambulancias, mapa: ${Object.keys(map.graph.nodes).length} nodos`);
  } else if (commands[command]) {
    const w = loadWorld();
    const logBefore = w.log.length;
    await commands[command](w, map);
    if (command !== "status") printEvents(w, logBefore), printStatus(w, map);
    saveWorld(w);
  } else {
    console.error(`comando desconocido: ${command}\n\n${HELP}`);
    process.exit(1);
  }
}
