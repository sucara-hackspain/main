import type { GraphData, LonLat } from "../engineTrace";

// Trim the first edge at the reported GPS position. No chord cutting across a street bend.
export function remainingRoute(
  a: { pos: LonLat; route: [number, 0 | 1][] },
  graph: GraphData,
): [number, number][] {
  const coords: [number, number][] = [a.pos];
  a.route.forEach(([edge, forward], i) => {
    const source = graph.edges[edge]?.geom;
    if (!source) return;
    const points = forward ? source : [...source].reverse();
    if (i !== 0) {
      coords.push(...points);
      return;
    }
    let best = Infinity,
      segment = 0;
    for (let j = 0; j < points.length - 1; j++) {
      const [x, y] = points[j],
        [xx, yy] = points[j + 1];
      const dx = xx - x,
        dy = yy - y,
        k = Math.max(
          0,
          Math.min(
            1,
            ((a.pos[0] - x) * dx + (a.pos[1] - y) * dy) /
              (dx * dx + dy * dy || 1),
          ),
        );
      const d = (a.pos[0] - x - k * dx) ** 2 + (a.pos[1] - y - k * dy) ** 2;
      if (d < best) {
        best = d;
        segment = j;
      }
    }
    coords.push(...points.slice(segment + 1));
  });
  return coords;
}

/** Ring of `meters` around a point, for water fronts and location uncertainty. */
export function circle(
  [lon, lat]: LonLat,
  meters: number,
  steps = 48,
): [number, number][] {
  const dLat = meters / 111320,
    dLon = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)];
  });
}
