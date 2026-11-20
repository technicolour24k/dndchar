import { describe, expect, it } from 'vitest';
// Relative import into static/: the same file the browser loads, also used by the Node server.
import { chebyshevFt, pathFt, snapToSquareCentre } from '../../../static/vtt-app/shared/gridDistance.js';

describe('chebyshevFt', () => {
  it('measures orthogonal moves', () => {
    expect(chebyshevFt(0, 0, 100, 0, 50)).toBe(10);
    expect(chebyshevFt(0, 0, 0, 150, 50)).toBe(15);
  });

  it('charges diagonals the same as orthogonals', () => {
    expect(chebyshevFt(0, 0, 150, 150, 50)).toBe(15);
  });

  it('uses the larger axis for mixed moves', () => {
    expect(chebyshevFt(0, 0, 150, 50, 50)).toBe(15);
  });

  it('does not care about direction', () => {
    expect(chebyshevFt(150, 150, 0, 0, 50)).toBe(15);
    expect(chebyshevFt(0, 150, 150, 0, 50)).toBe(15);
    expect(chebyshevFt(100, 0, 0, 0, 50)).toBe(10);
  });

  it('rounds to the nearest foot, half up', () => {
    expect(chebyshevFt(0, 0, 24, 0, 50)).toBe(2);
    expect(chebyshevFt(0, 0, 25, 0, 50)).toBe(3);
    expect(chebyshevFt(0, 0, 26, 0, 50)).toBe(3);
    expect(chebyshevFt(0, 0, 96, 0, 96)).toBe(5);
    expect(chebyshevFt(0, 0, 48, 0, 96)).toBe(3);
  });

  it('returns null for unusable input', () => {
    expect(chebyshevFt(0, 0, 10, 0, 0)).toBeNull();
    expect(chebyshevFt(0, 0, 10, 0, NaN)).toBeNull();
    expect(chebyshevFt(0, 0, NaN, 0, 50)).toBeNull();
  });
});

describe('pathFt', () => {
  it('sums the legs', () => {
    expect(pathFt([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 50)).toBe(20);
    expect(pathFt([{ x: 0, y: 0 }, { x: 100, y: 100 }], 50)).toBe(10);
  });

  it('rounds per leg, not on the total', () => {
    expect(pathFt([{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 48, y: 0 }], 50)).toBe(4);
  });

  it('is 0 for fewer than two points', () => {
    expect(pathFt([], 50)).toBe(0);
    expect(pathFt([{ x: 1, y: 1 }], 50)).toBe(0);
  });

  it('returns null for invalid input', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }];
    expect(pathFt(pts, 0)).toBeNull();
    expect(pathFt(pts, NaN)).toBeNull();
    expect(pathFt([{ x: 0, y: 0 }, { x: NaN, y: 0 }], 50)).toBeNull();
  });
});

describe('snapToSquareCentre', () => {
  it('snaps to the centre of the containing square', () => {
    expect(snapToSquareCentre(10, 10, 50)).toEqual({ x: 25, y: 25 });
    expect(snapToSquareCentre(50, 50, 50)).toEqual({ x: 75, y: 75 });
    expect(snapToSquareCentre(49.9, 0, 50)).toEqual({ x: 25, y: 25 });
  });
});
