import type { UnitKind } from "../engineTrace";

// Map markers are plain DOM: icons as SVG markup. Flame and life buoy are Lucide paths (ISC).
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const unitIcon: Record<UnitKind, string> = {
  ambulance: svg(
    '<path d="M3 5h11v12H3zM14 10h4l3 4v3h-7M7 8v6m-3-3h6"/><circle cx="7" cy="18" r="2" fill="white"/><circle cx="18" cy="18" r="2" fill="white"/>',
  ),
  fire: svg(
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  ),
  rescue: svg(
    '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>',
  ),
  helicopter: svg(
    '<path d="M3 4h18M12 4v4"/><path d="M4 12c0-2.2 2.2-4 5-4h6l4 4-4 4H9c-2.8 0-5-1.8-5-4z"/><path d="M19 12h3M8 16l-1 3M15 16l1 3M5 19h14"/>',
  ),
};

export const hospitalIcon =
  '<span class="hospital-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18M2 22h20M12 6v4M10 8h4M10 14h4M10 18h4"/></svg></span>';
