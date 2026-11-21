import { describe, expect, it } from 'vitest';
import { clampView, fitView, fitZoom, MAX_ZOOM, mapToScreen, screenToMap, zoomAt } from './view';

const viewport = { width: 800, height: 600 };
const dims = { width: 4000, height: 2000 };

describe('fitView', () => {
  it('shows the whole image, centred', () => {
    const v = fitView(viewport, dims);
    expect(v.zoom).toBeCloseTo(0.2); // limited by width
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo((600 - 2000 * 0.2) / 2);
  });
});

describe('zero-sized viewport', () => {
  it('never gives zoom 0 or NaN', () => {
    for (const vp of [{ width: 0, height: 0 }, { width: 800, height: 0 }, { width: 0, height: 600 }]) {
      expect(fitZoom(vp, dims)).toBe(1);
      const v = fitView(vp, dims);
      expect(Number.isFinite(v.x) && Number.isFinite(v.y) && v.zoom > 0).toBe(true);
      const c = clampView({ x: 5, y: 5, zoom: 1 }, vp, dims);
      expect(Number.isFinite(c.x) && Number.isFinite(c.y) && c.zoom > 0).toBe(true);
    }
  });
});

describe('zoomAt', () => {
  it('keeps the map point under the anchor fixed', () => {
    const view = { x: -300, y: -120, zoom: 0.5 };
    const anchor = { x: 400, y: 250 };
    const before = screenToMap(view, dims, anchor);
    const zoomed = zoomAt(view, anchor, 1.7);
    const after = screenToMap(zoomed, dims, anchor);
    expect(zoomed.zoom).toBe(1.7);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});

describe('clampView', () => {
  const fit = fitZoom(viewport, dims);
  it('limits zoom to fit/2 .. 4x', () => {
    expect(clampView({ x: 0, y: 0, zoom: 0.001 }, viewport, dims).zoom).toBeCloseTo(fit / 2);
    expect(clampView({ x: 0, y: 0, zoom: 99 }, viewport, dims).zoom).toBe(MAX_ZOOM);
    expect(clampView({ x: 0, y: 0, zoom: 1 }, viewport, dims).zoom).toBe(1);
  });
  it('stops the image being dragged off when it is bigger than the viewport', () => {
    // At zoom 1 the image is 4000 x 2000 in an 800 x 600 viewport.
    const far = clampView({ x: 500, y: 500, zoom: 1 }, viewport, dims);
    expect(far.x).toBe(0);
    expect(far.y).toBe(0);
    const farOther = clampView({ x: -99999, y: -99999, zoom: 1 }, viewport, dims);
    expect(farOther.x).toBe(800 - 4000);
    expect(farOther.y).toBe(600 - 2000);
  });
  it('centres an axis where the image is smaller than the viewport', () => {
    const v = clampView({ x: 123, y: 456, zoom: fit }, viewport, dims);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo((600 - 2000 * fit) / 2);
  });
});

describe('screenToMap / mapToScreen', () => {
  it('are inverses', () => {
    const view = { x: -250, y: 40, zoom: 0.8 };
    const p = { x: 0.37, y: 0.62 };
    const back = screenToMap(view, dims, mapToScreen(view, dims, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
  it('maps the image corners', () => {
    const view = { x: 10, y: 20, zoom: 0.5 };
    expect(screenToMap(view, dims, { x: 10, y: 20 })).toEqual({ x: 0, y: 0 });
    const end = screenToMap(view, dims, { x: 10 + 2000, y: 20 + 1000 });
    expect(end.x).toBeCloseTo(1);
    expect(end.y).toBeCloseTo(1);
  });
});
