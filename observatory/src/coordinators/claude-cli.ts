import { spawn } from "node:child_process";
import { buildBriefing, GreedyCoordinator, type Coordinator, type DecideInput, type Decision } from "../engine";
import { composePrompt, SCHEMA, SYSTEM_PROMPT, toActions, type LlmOutput, type LlmTrace } from "./protocol";

export type { LlmTrace };

export interface ClaudeCliOptions {
  model?: string;
  timeoutMs?: number;
  onTrace?: (trace: LlmTrace) => void;
  /** The agent's doctrine, rendered fresh for each decision and placed before the briefing. */
  memory?: () => string;
}

/** Coordinator that thinks with a headless Claude Code process (`claude -p`), so it needs no API key. */
export class ClaudeCliCoordinator implements Coordinator {
  readonly name = "claude-cli";
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly onTrace?: (trace: LlmTrace) => void;
  private readonly memory?: () => string;
  private readonly fallback = new GreedyCoordinator();

  constructor(options: ClaudeCliOptions = {}) {
    this.model = options.model ?? "haiku";
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.onTrace = options.onTrace;
    this.memory = options.memory;
  }

  async decide(input: DecideInput): Promise<Decision> {
    const briefing = buildBriefing(input);
    if (!briefing.actionable) return { actions: [], source: "rules", situation: "Sin decisiones pendientes." };

    const prompt = composePrompt(briefing.text, this.memory);
    const started = Date.now();
    try {
      const result = await this.ask(prompt, input);
      const ms = Date.now() - started;
      this.onTrace?.({ tick: input.tick, model: this.model, prompt, response: result.output, ms, costUsd: result.costUsd });

      const { actions, reasons, applies } = toActions(result.output, input);
      return { actions, reasons, applies, source: "llm", situation: result.output.situation, ms, costUsd: result.costUsd };
    } catch (err) {
      // The integration is down: keep the city covered with the rule-based dispatcher.
      const error = err instanceof Error ? err.message : String(err);
      const ms = Date.now() - started;
      this.onTrace?.({ tick: input.tick, model: this.model, prompt, response: null, ms, costUsd: 0, error });
      return {
        actions: this.fallback.decide(input),
        source: "fallback",
        situation: "LLM no disponible: decide el despachador por reglas.",
        ms,
        error,
      };
    }
  }

  private ask(prompt: string, _input: DecideInput) {
    const system = SYSTEM_PROMPT;
    const args = [
      "-p",
      "--model", this.model,
      // A dispatcher cannot think for a minute per call: the city does not wait.
      "--effort", "low",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--system-prompt", system,
      "--output-format", "json",
      "--json-schema", JSON.stringify(SCHEMA),
    ];
    // CLAUDECODE is unset so this also works when launched from inside a Claude Code session.
    const { CLAUDECODE: _nested, ...env } = process.env;

    return new Promise<{ output: LlmOutput; costUsd: number }>((resolve, reject) => {
      const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout);
          if (code !== 0 || parsed.is_error || !parsed.structured_output) {
            throw new Error(`claude exit ${code}: ${String(parsed.result ?? stderr).slice(0, 300)}`);
          }
          resolve({ output: parsed.structured_output, costUsd: parsed.total_cost_usd ?? 0 });
        } catch (err) {
          reject(err instanceof SyntaxError ? new Error(`claude exit ${code}: ${(stderr || stdout).slice(0, 300)}`) : err);
        }
      });
      child.stdin.end(prompt);
    });
  }
}
