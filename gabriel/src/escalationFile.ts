import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_ESCALATION, EscalationDesk, parseEscalationPolicies, type EscalationPolicy } from "./engine";

/** Where the catalogue an operator edits lives. The Control Center reads and writes this same file. */
export const ESCALATION_FILE = "policies/escalation.json";

/**
 * The escalation catalogue in force, from the file if there is one. A file that cannot be read at all
 * falls back to the catalogue the engine ships with: a night must never run without anybody watching.
 */
export function readEscalation(path = ESCALATION_FILE, log: (line: string) => void = console.log): EscalationPolicy[] {
  if (!existsSync(path)) return DEFAULT_ESCALATION;
  try {
    const { policies, skipped } = parseEscalationPolicies(JSON.parse(readFileSync(path, "utf8")));
    for (const why of skipped) log(`escalation: política descartada · ${why}`);
    if (policies.length === 0) {
      log(`escalation: ${path} no tiene ninguna política usable; se usa el catálogo del motor`);
      return DEFAULT_ESCALATION;
    }
    return policies;
  } catch (err) {
    log(`escalation: no se pudo leer ${path} (${err instanceof Error ? err.message : err}); se usa el catálogo del motor`);
    return DEFAULT_ESCALATION;
  }
}

export const escalationDesk = (policies: EscalationPolicy[]) => new EscalationDesk(policies);
