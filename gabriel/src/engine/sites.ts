import type { Graph } from "./graph";
import { projectedRadius } from "./water";
import type { Belief, KnownSite, SiteKind, Unit, World } from "./types";

export const SITES: Record<SiteKind, { label: string; selfRate: number }> = {
  // People a site moves to safety per tick on its own once it has been warned.
  residence: { label: "Residencia de mayores", selfRate: 1 },
  school: { label: "Colegio", selfRate: 2 },
  garage: { label: "Garaje subterráneo", selfRate: 4 },
};
/** People per tick a crew on the spot moves to safety, on top of what the site manages alone. */
export const CREW_RATE = 3;

const helps = (unit: Unit, node: number) => unit.node === node && unit.mission === "idle" && unit.route.length === 0 && !unit.victimId && unit.brokenUntil === null && unit.kind !== "drone";

/** One tick at every site: people move to safety, and the water catches whoever is left when it arrives. */
export function advanceSites(world: World, graph: Graph, spawn: (site: World["sites"][number]) => string | null): void {
  for (const site of world.sites) {
    if (site.floodedTick !== null) continue;
    const crews = world.units.filter((u) => helps(u, site.node)).length;
    // A crew at the door is a warning in itself.
    if (crews > 0 && site.warnedTick === null) site.warnedTick = world.tick;
    if (site.warnedTick !== null) site.safe = Math.min(site.people.length, site.safe + SITES[site.kind].selfRate + crews * CREW_RATE);

    if (!world.floods.some((f) => graph.distanceM(f.node, site.node) <= f.radiusM)) continue;
    site.floodedTick = world.tick;
    const caught = site.people.length - site.safe;
    world.log.push({ type: "site_flooded", tick: world.tick, siteId: site.id, sceneId: caught > 0 ? spawn(site) : null, caught, safe: site.safe });
  }
}

/** Ticks until the water is expected at a node, from the gauges and the official flood maps. null = nothing points that way. */
export function waterArrivalTicks(belief: Belief, graph: Graph, node: number): number | null {
  let soonest: number | null = null;
  const consider = (ticks: number) => {
    if (soonest === null || ticks < soonest) soonest = Math.max(0, Math.round(ticks));
  };
  for (const g of belief.gauges) {
    if (g.growthM <= 0) continue;
    const spreading = Math.max(0, belief.tick - g.overflowTick);
    const reach = g.radiusM + g.growthM * spreading;
    consider(Math.max(0, g.overflowTick - belief.tick) + Math.max(0, graph.distanceM(g.node, node) - reach) / g.growthM);
  }
  for (const f of belief.floods) {
    if (f.growthM <= 0) continue;
    consider(Math.max(0, graph.distanceM(f.node, node) - projectedRadius(f, belief.tick)) / f.growthM);
  }
  return soonest;
}

/** Sites still worth acting on: not flooded, not everybody safe, and water expected within the horizon. */
export function sitesAtRisk(belief: Belief, graph: Graph, horizonTicks = 45): { site: KnownSite; arrival: number }[] {
  return belief.sites
    .filter((s) => s.floodedTick === null && s.safe < s.people)
    .flatMap((site) => {
      const arrival = waterArrivalTicks(belief, graph, site.node);
      return arrival !== null && arrival <= horizonTicks ? [{ site, arrival }] : [];
    })
    .sort((a, b) => a.arrival - b.arrival);
}
