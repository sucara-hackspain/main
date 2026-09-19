import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const engineRoot = resolve(__dirname, "../../gabriel");
const SAFE = /^[\w.-]+$/;

/** Serves run traces straight from runs/ so the UI can follow a run while its records are being written. */
export function runsApi(): Plugin {
  return {
    name: "runs-api",
    configureServer(server) {
      server.middlewares.use("/api", (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const [kind, name] = url.pathname.split("/").filter(Boolean);
        const json = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (name && !SAFE.test(name)) return json({ error: "bad name" }, 400);

        if (kind === "runs" && !name) {
          const dir = resolve(engineRoot, "runs");
          const ids = existsSync(dir) ? readdirSync(dir).filter((id) => existsSync(resolve(dir, id, "meta.json"))) : [];
          const metas = ids.map((id) => JSON.parse(readFileSync(resolve(dir, id, "meta.json"), "utf8")));
          return json(metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
        }
        if (kind === "runs") {
          const dir = resolve(engineRoot, "runs", name);
          if (!existsSync(resolve(dir, "meta.json"))) return json({ error: "unknown run" }, 404);
          const from = Number(url.searchParams.get("from") ?? 0);
          const lines = readFileSync(resolve(dir, "ticks.jsonl"), "utf8").split("\n").filter(Boolean);
          const ticks = lines.slice(from).flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return []; // last line still being written
            }
          });
          return json({ meta: JSON.parse(readFileSync(resolve(dir, "meta.json"), "utf8")), ticks });
        }
        if (kind === "graph") {
          const file = resolve(engineRoot, "data", `${name}.json`);
          if (!existsSync(file)) return json({ error: "unknown map" }, 404);
          res.setHeader("Content-Type", "application/json");
          return createReadStream(file).pipe(res);
        }
        json({ error: "not found" }, 404);
      });
    },
  };
}
