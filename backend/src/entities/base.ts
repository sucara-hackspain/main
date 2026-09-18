import type { Coords, NodeId } from "../map/graph.js";
import type { RoadMap } from "../map/road-map.js";

/** Base de ambulancias (hospital). */
export type Base = { position: NodeId };

export const createBase = (map: RoadMap, coords: Coords): Base => ({ position: map.nearest(coords) });
