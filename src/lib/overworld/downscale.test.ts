import { describe, expect, it } from 'vitest';
import { targetSize } from './downscale';

describe('targetSize', () => {
  it('shrinks the Sword Coast map (10200 x 6600) inside both caps, keeping its shape', () => {
    const t = targetSize(10200, 6600);
    expect(t.scaled).toBe(true);
    expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(5000);
    expect(t.width * t.height).toBeLessThanOrEqual(16_000_000);
    // About 4972 x 3217, as in the plan.
    expect(t.width).toBe(4972);
    expect(t.height).toBe(3217);
    expect(t.width / t.height).toBeCloseTo(10200 / 6600, 2);
  });
  it('cuts a 5000 x 5000 image with the pixel cap, not just the edge cap', () => {
    const t = targetSize(5000, 5000);
    expect(t).toEqual({ width: 4000, height: 4000, scaled: true });
  });
  it('leaves a 3000 x 2000 image alone', () => {
    expect(targetSize(3000, 2000)).toEqual({ width: 3000, height: 2000, scaled: false });
  });
  it('never upscales and handles a long thin image by the edge cap', () => {
    expect(targetSize(100, 100).scaled).toBe(false);
    const t = targetSize(12000, 1000);
    expect(t.width).toBeLessThanOrEqual(5000);
    expect(t.height).toBeGreaterThanOrEqual(1);
  });
  it('takes custom limits and rejects nonsense sizes', () => {
    expect(targetSize(4000, 2000, { maxEdge: 1000 })).toEqual({ width: 1000, height: 500, scaled: true });
    expect(() => targetSize(0, 100)).toThrow();
    expect(() => targetSize(NaN, 100)).toThrow();
  });
});
