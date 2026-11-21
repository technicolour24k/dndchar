// Distance maths for overworld routes. Pure, importable from client code.
//
// Points are fractions of the image (0..1). Distances are straight-line (Euclidean) miles, NOT the
// VTT's grid-step feet: a gridless map has no squares, so a diagonal costs what it really measures.
// The scale is "miles across the full image width" (miles_across); without one there are no distances.
import { MAX_MILES_ACROSS, MILES_PER_DAY_NORMAL } from './palette';
import type { Dims, Pt } from '$lib/types/overworld';

export type Leg = { x1: number; y1: number; x2: number; y2: number };

// Straight-line miles between two points. The y difference is scaled by height / width so a tall or
// wide image measures the same in both directions. Null without a scale.
export function legMiles(a: Pt, b: Pt, dims: Dims, milesAcross: number | null): number | null {
  if (milesAcross === null || !(milesAcross > 0)) return null;
  const dx = b.x - a.x;
  const dy = (b.y - a.y) * (dims.height / dims.width);
  return Math.hypot(dx, dy) * milesAcross;
}

// Sum over every leg (gaps left by a deleted leg are simply not counted). Null without a scale.
export function routeMiles(legs: Leg[], dims: Dims, milesAcross: number | null): number | null {
  if (milesAcross === null || !(milesAcross > 0)) return null;
  let total = 0;
  for (const leg of legs) {
    total += legMiles({ x: leg.x1, y: leg.y1 }, { x: leg.x2, y: leg.y2 }, dims, milesAcross) ?? 0;
  }
  return total;
}

// Tap both ends of a known distance (e.g. the printed scale bar) and type the miles: gives the miles
// across the full width. Null if the two taps are the same point, the miles are not positive, or the scale would exceed MAX_MILES_ACROSS.
export function milesAcrossFromCalibration(a: Pt, b: Pt, miles: number, dims: Dims): number | null {
  if (!Number.isFinite(miles) || miles <= 0) return null;
  // Distance in "image widths" between the taps; milesAcross is how many miles one width is.
  const widths = legMiles(a, b, dims, 1);
  if (widths === null || widths <= 0) return null;
  const scale = miles / widths;
  return Number.isFinite(scale) && scale <= MAX_MILES_ACROSS ? scale : null;
}

// Days of travel, rounded to the nearest half day.
export function travelDays(miles: number, milesPerDay: number = MILES_PER_DAY_NORMAL): number {
  return Math.round((miles / milesPerDay) * 2) / 2;
}

// '' with no scale, '0.4 mi' / '4.2 mi' under 10 miles, '12 mi' from 10 up (whole miles), and
// ' - about 1.5 days' appended once the trip rounds to a day or more (so 18 miles and up).
export function formatDistance(miles: number | null): string {
  if (miles === null || !Number.isFinite(miles)) return '';
  const text = miles < 10 ? `${trimDecimal(miles)} mi` : `${Math.round(miles)} mi`;
  const days = travelDays(miles);
  if (days < 1) return text;
  return `${text} - about ${days} ${days === 1 ? 'day' : 'days'}`;
}

// One decimal place, no trailing '.0' (4 -> '4', 4.25 -> '4.3').
function trimDecimal(n: number): string {
  return String(Number(n.toFixed(1)));
}

// Shortest distance from point p to the segment a-b, all in the same units.
export function pointToSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type HitLeg = { routeId: string; legId: string; distance: number };

// The leg closest to a tapped map point, if one is within `tolerancePx` image pixels. Everything is
// measured in image pixels (not 0..1 fractions) so the tolerance is the same in both directions.
// The caller turns a screen tolerance into image pixels by dividing by the zoom.
export function nearestLeg(
  routes: { id: string; legs: { id: string; x1: number; y1: number; x2: number; y2: number }[] }[],
  point: Pt,
  dims: Dims,
  tolerancePx: number
): HitLeg | null {
  const p = { x: point.x * dims.width, y: point.y * dims.height };
  let best: HitLeg | null = null;
  for (const route of routes) {
    for (const leg of route.legs) {
      const distance = pointToSegmentDistance(
        p,
        { x: leg.x1 * dims.width, y: leg.y1 * dims.height },
        { x: leg.x2 * dims.width, y: leg.y2 * dims.height }
      );
      if (distance <= tolerancePx && (!best || distance < best.distance)) best = { routeId: route.id, legId: leg.id, distance };
    }
  }
  return best;
}
