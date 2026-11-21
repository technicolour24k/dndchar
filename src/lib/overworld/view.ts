// Pan / zoom maths for the map viewer. Pure, so the fiddly part is unit tested.
//
// The viewer is one layer positioned with CSS `translate(x, y) scale(zoom)`, holding the image at its
// natural pixel size. So a point on the screen (relative to the viewport's top-left) maps to the image
// like this: image px = (screen - translate) / zoom.
import type { Dims, Pt } from '$lib/types/overworld';

export type View = { x: number; y: number; zoom: number };
export type Size = { width: number; height: number };

// Zoom limits: down to half of "fit" (a little breathing room), up to 4x natural size.
export const MAX_ZOOM = 4;

// Zoom that shows the whole image in the viewport.
export function fitZoom(viewport: Size, dims: Dims): number {
  // A zero-sized viewport (not laid out yet) must not give zoom 0 / NaN; fall back to 1.
  if (!(viewport.width > 0) || !(viewport.height > 0) || !(dims.width > 0) || !(dims.height > 0)) return 1;
  return Math.min(viewport.width / dims.width, viewport.height / dims.height);
}

// Whole image visible and centred.
export function fitView(viewport: Size, dims: Dims): View {
  const zoom = fitZoom(viewport, dims);
  return {
    zoom,
    x: (viewport.width - dims.width * zoom) / 2,
    y: (viewport.height - dims.height * zoom) / 2
  };
}

// Change zoom but keep the map point under `anchor` (a screen point) exactly where it is.
// Does not clamp; run the result through clampView.
export function zoomAt(view: View, anchor: Pt, newZoom: number): View {
  const mapX = (anchor.x - view.x) / view.zoom;
  const mapY = (anchor.y - view.y) / view.zoom;
  return { zoom: newZoom, x: anchor.x - mapX * newZoom, y: anchor.y - mapY * newZoom };
}

// Keep zoom within [fit / 2, MAX_ZOOM] and the image from being dragged away: on an axis where the
// scaled image is bigger than the viewport it must keep covering the viewport; where it is smaller it
// is centred.
export function clampView(view: View, viewport: Size, dims: Dims): View {
  const minZoom = fitZoom(viewport, dims) / 2;
  const zoom = Math.min(MAX_ZOOM, Math.max(minZoom, view.zoom));
  return {
    zoom,
    x: clampAxis(view.x, dims.width * zoom, viewport.width),
    y: clampAxis(view.y, dims.height * zoom, viewport.height)
  };
}

function clampAxis(offset: number, scaledSize: number, viewportSize: number): number {
  if (scaledSize <= viewportSize) return (viewportSize - scaledSize) / 2;
  return Math.min(0, Math.max(viewportSize - scaledSize, offset));
}

// Screen point (relative to the viewport) -> normalised map point (0..1 over the image). Not clamped:
// a tap outside the image comes back below 0 or above 1 and the caller decides what to do.
export function screenToMap(view: View, dims: Dims, screen: Pt): Pt {
  return {
    x: (screen.x - view.x) / view.zoom / dims.width,
    y: (screen.y - view.y) / view.zoom / dims.height
  };
}

// Inverse of screenToMap.
export function mapToScreen(view: View, dims: Dims, point: Pt): Pt {
  return {
    x: point.x * dims.width * view.zoom + view.x,
    y: point.y * dims.height * view.zoom + view.y
  };
}
