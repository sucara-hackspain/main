// What each kind of unit can do, and the default configuration the tests build runs with.
import type { SimConfig, UnitKind } from "./types";

export const UNIT_KINDS: Record<UnitKind, { label: string; carries: boolean; extricates: boolean; wades: boolean; flies: boolean; observes: boolean }> = {
  ambulance: { label: "ambulancia", carries: true, extricates: false, wades: false, flies: false, observes: false },
  fire: { label: "bomberos", carries: false, extricates: true, wades: false, flies: false, observes: false },
  rescue: { label: "rescate acuático", carries: true, extricates: true, wades: true, flies: false, observes: false },
  helicopter: { label: "helicóptero", carries: true, extricates: false, wades: false, flies: true, observes: true },
  drone: { label: "dron", carries: false, extricates: false, wades: false, flies: true, observes: true },
};

export const DEFAULT_CONFIG: SimConfig = {
  tickSeconds: 30, ambulances: 5, fireUnits: 3, rescueUnits: 2, helicopters: 1, drones: 2, hospitals: 6, hospitalCapacity: 14,
  ambulanceSpeedFactor: 1.3, pickupTicks: 2, dropoffTicks: 1, treatTicks: 2, extricateTicks: 3, searchRadiusM: 600, scoutRadiusM: 500, scoutTicks: 2,
};

/** Streets this kind of unit treats as closed / as slow, given a set of closures and which of them are water. */
export function closuresFor(kind: UnitKind, closed: number[], flooded: number[]): { closed: Set<number>; slow: Set<number> } {
  if (!UNIT_KINDS[kind].wades) return { closed: new Set(closed), slow: new Set() };
  const water = new Set(flooded);
  return { closed: new Set(closed.filter((e) => !water.has(e))), slow: water };
}
