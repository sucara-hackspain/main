import { GreedyCoordinator, resolve, SITES, sitesAtRisk, whatWasSeen, type Action, type Coordinator, type DecideInput, type Decision } from "../engine";

/**
 * The rule-based dispatcher that also acts on the registry of sites and the gauges, saying why it does each thing.
 * Rules have reasons too: written down, a night played by rules can be read decision by decision like one played by
 * the agent, and set against the dispatcher that ignores the registry.
 */
export class ExplainedRules implements Coordinator {
  readonly name = "reglas+registro";
  private readonly rules = new GreedyCoordinator(undefined, true);
  private readonly today = new GreedyCoordinator();

  decide(input: DecideInput): Decision {
    const actions = this.rules.decide(input);
    if (actions.length === 0) return { actions, source: "rules" };
    const saw = whatWasSeen(input);
    return {
      actions,
      source: "rules",
      situation: saw[0],
      plan: "Avisar a cada sitio con gente dentro por orden de llegada del agua y poner una dotación donde solos no les da tiempo. El resto: lo más grave primero, con la unidad adecuada más cercana.",
      reasons: actions.map((action) => this.why(action, input)),
      saw,
      baseline: this.today.decide(input),
    };
  }

  private why(action: Action, { belief, graph }: DecideInput): string {
    const risk = sitesAtRisk(belief, graph, 200);
    if (action.type === "warn") {
      const at = risk.find((x) => x.site.id === action.siteId);
      return at ? `dentro hay ${at.site.people - at.site.safe} personas sin avisar y el agua llega en ~${at.arrival} ticks` : "sitio con gente dentro en el camino del agua";
    }
    if (action.type === "reposition") {
      const at = risk.find((x) => x.site.node === action.node);
      if (!at) return "la zona donde esperaba va a quedar aislada por el agua";
      const alone = SITES[at.site.kind].selfRate;
      return `solos ponen a salvo ${alone} por tick: en ${at.arrival} ticks quedarían ${Math.max(0, at.site.people - at.site.safe - alone * at.arrival)} dentro; una dotación allí saca 3 más por tick`;
    }
    if (action.type === "dispatch") {
      const incident = resolve(belief, action.incidentId);
      return `${incident ? `P${incident.priority}` : "incidente"}: es la unidad adecuada libre que antes llega${incident?.unreachable ? " (no hay ruta por carretera)" : ""}`;
    }
    if (action.type === "transport") return "hospital con cama libre más cercano";
    return "zona donde ahora mismo se decide a ciegas";
  }
}
