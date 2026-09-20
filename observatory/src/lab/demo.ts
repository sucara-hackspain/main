// pnpm lab:demo <night> [sala|palabras|agente|perfecto|ninguno] — records a night the viewers can open, played by the
// rules that give their reasons. No HappyRobot call is made: it is for looking at the world, not at the agent.
import { readFileSync } from "node:fs";
import { Graph, type GraphData } from "../engine";
import { play, type Attention } from "./play";
import { loadScenarios } from "./scenario";

const [nightId = "H1", attention = "agente"] = process.argv.slice(2);
const graph = new Graph(JSON.parse(readFileSync("data/valencia.json", "utf8")) as GraphData);
const night = loadScenarios().find((s) => s.id === nightId);
if (!night) throw new Error(`no night called ${nightId}`);
const channel = attention === "ninguno" ? undefined : { attention: attention as Attention, outbound: attention === "agente" || attention === "perfecto" };
const traceId = `demo-${night.id}-${attention}`;
const game = await play(night, { kind: "registry" }, graph, { channel, traceId });
console.log(`${traceId}: ${game.dead} muertos de ${game.victims}`, game.channel ?? "");
