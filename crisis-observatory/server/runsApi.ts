import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { DEFAULT_ESCALATION, parseEscalationPolicies } from "../../gabriel/src/engine/escalation";

const engineRoot = resolve(__dirname, "../../gabriel");
const SAFE = /^[\w.-]+$/;
const LIVE = `http://127.0.0.1:${process.env.LIVE_CONTROL_PORT ?? 8113}`;

/** The escalation catalogue the engine applies: the same file, whoever edits it. */
const POLICY_FILE = resolve(engineRoot, "policies/escalation.json");

function readBody(req: { on: (event: string, listener: (chunk?: Buffer) => void) => void }): Promise<string> {
  return new Promise((done, fail) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) fail(new Error("catálogo demasiado grande"));
    });
    req.on("end", () => done(body));
    req.on("error", () => fail(new Error("no se pudo leer la petición")));
  });
}

/** Serves run traces straight from runs/ so the UI can follow a run while its records are being written. */
export function runsApi(): Plugin {
  // The same handler serves `vite dev` and `vite preview`: a preview deployment reads the runs the engine writes next to it.
  // A block, not an expression: whatever the hook returns Vite takes for a post-middleware installer.
  const serve = (server: ViteDevServer | PreviewServer): void => {
    // With CONTROL_CENTER_PASSWORD set (a deployment), everything is behind HTTP basic auth; unset, nothing changes.
    const password = process.env.CONTROL_CENTER_PASSWORD;
    if (password) {
      const expected = Buffer.from(`Basic ${Buffer.from(`${process.env.CONTROL_CENTER_USER || "hackspain"}:${password}`).toString("base64")}`);
      server.middlewares.use((req, res, next) => {
        const given = Buffer.from(req.headers.authorization ?? "");
        if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Basic realm="Control Center"');
        res.end("Unauthorized");
      });
    }
    server.middlewares.use("/api", (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const [kind, name] = url.pathname.split("/").filter(Boolean);
        const json = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (name && !SAFE.test(name)) return json({ error: "bad name" }, 400);

        // The live mode is another process (gabriel: pnpm live): the page talks to it through here.
        if (kind === "live") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => {
            fetch(`${LIVE}/${name ?? ""}`, { method: req.method, body: req.method === "POST" ? Buffer.concat(chunks) : undefined, headers: { "content-type": "application/json" } })
              .then(async (r) => json(await r.json(), r.status))
              .catch(() => json({ off: true, error: "El modo en vivo está apagado. Arráncalo con: cd gabriel && pnpm live" }, 503));
          });
          return;
        }

        // The catalogue an operator writes and the engine applies, read and saved in place.
        if (kind === "policies") {
          if (req.method === "GET")
            return json(existsSync(POLICY_FILE) ? parseEscalationPolicies(JSON.parse(readFileSync(POLICY_FILE, "utf8"))).policies : DEFAULT_ESCALATION);
          if (req.method !== "PUT") return json({ error: "method not allowed" }, 405);
          return readBody(req)
            .then((body) => {
              const { policies, skipped } = parseEscalationPolicies(JSON.parse(body));
              if (skipped.length) return json({ error: `El catálogo tiene políticas no válidas: ${skipped.join("; ")}` }, 400);
              if (!policies.length) return json({ error: "El catálogo no puede quedarse vacío." }, 400);
              mkdirSync(resolve(engineRoot, "policies"), { recursive: true });
              writeFileSync(POLICY_FILE, JSON.stringify(policies, null, 2) + "\n");
              return json(policies);
            })
            .catch((err: Error) => json({ error: err.message }, 400));
        }

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
  };
  return { name: "runs-api", configureServer: serve, configurePreviewServer: serve };
}
