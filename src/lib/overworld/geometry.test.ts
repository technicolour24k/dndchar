import { describe, expect, it } from 'vitest';
import { formatDistance, legMiles, milesAcrossFromCalibration, routeMiles, travelDays } from './geometry';

const square = { width: 1000, height: 1000 };
const wide = { width: 2000, height: 1000 };

describe('legMiles', () => {
  it('measures straight-line miles from the scale', () => {
    // Full width on a 100-mile map is 100 miles.
    expect(legMiles({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, square, 100)).toBeCloseTo(100);
    // A 3-4-5 diagonal on a square image: 0.3 x 0.4 widths = 0.5 widths.
    expect(legMiles({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }, square, 100)).toBeCloseTo(50);
  });
  it('aspect ratio matters: the same vertical fraction is shorter on a wide image', () => {
    const a = { x: 0.5, y: 0 };
    const b = { x: 0.5, y: 1 };
    expect(legMiles(a, b, square, 100)).toBeCloseTo(100);
    // Height is half the width on the 2:1 image, so top-to-bottom is 50 miles.
    expect(legMiles(a, b, wide, 100)).toBeCloseTo(50);
  });
  it('is null without a scale', () => {
    expect(legMiles({ x: 0, y: 0 }, { x: 1, y: 1 }, square, null)).toBeNull();
  });
});

describe('routeMiles', () => {
  const legs = [
    { x1: 0, y1: 0, x2: 0.5, y2: 0 },
    { x1: 0.5, y1: 0, x2: 0.5, y2: 0.5 }
  ];
  it('sums the legs', () => {
    expect(routeMiles(legs, square, 100)).toBeCloseTo(100);
  });
  it('counts nothing for an empty route and is null without a scale', () => {
    expect(routeMiles([], square, 100)).toBe(0);
    expect(routeMiles(legs, square, null)).toBeNull();
  });
});

describe('milesAcrossFromCalibration', () => {
  it('round-trips with legMiles', () => {
    const a = { x: 0.1, y: 0.2 };
    const b = { x: 0.6, y: 0.4 };
    const scale = milesAcrossFromCalibration(a, b, 37, wide);
    expect(scale).not.toBeNull();
    expect(legMiles(a, b, wide, scale)).toBeCloseTo(37);
  });
  it('is null when the scale would exceed 100000 miles', () => {
    expect(milesAcrossFromCalibration({ x: 0, y: 0 }, { x: 0.0001, y: 0 }, 50, square)).toBeNull();
    expect(milesAcrossFromCalibration({ x: 0, y: 0 }, { x: 1, y: 0 }, 100000, square)).toBeCloseTo(100000);
  });
  it('is null for the same point or non-positive miles', () => {
    const p = { x: 0.3, y: 0.3 };
    expect(milesAcrossFromCalibration(p, p, 10, square)).toBeNull();
    expect(milesAcrossFromCalibration(p, { x: 0.5, y: 0.5 }, 0, square)).toBeNull();
    expect(milesAcrossFromCalibration(p, { x: 0.5, y: 0.5 }, -3, square)).toBeNull();
    expect(milesAcrossFromCalibration(p, { x: 0.5, y: 0.5 }, NaN, square)).toBeNull();
  });
});

describe('travelDays', () => {
  it('rounds to the nearest half day at 24 miles a day', () => {
    expect(travelDays(0)).toBe(0);
    expect(travelDays(12)).toBe(0.5);
    expect(travelDays(24)).toBe(1);
    expect(travelDays(38)).toBe(1.5);
    expect(travelDays(17)).toBe(0.5); // 0.71 days
    expect(travelDays(19)).toBe(1); // 0.79 days
  });
  it('takes a custom pace', () => {
    expect(travelDays(30, 30)).toBe(1);
  });
});

describe('formatDistance', () => {
  it('is empty without a scale', () => {
    expect(formatDistance(null)).toBe('');
  });
  it('uses a decimal under 10 miles and whole miles from 10', () => {
    expect(formatDistance(0.4)).toBe('0.4 mi');
    expect(formatDistance(4.2)).toBe('4.2 mi');
    expect(formatDistance(4)).toBe('4 mi');
    expect(formatDistance(12)).toBe('12 mi');
    expect(formatDistance(12.4)).toBe('12 mi');
    // Pinned: rounds up to the next whole figure rather than showing '10.0'.
    expect(formatDistance(9.96)).toBe('10 mi');
  });
  it('adds travel time once it rounds to a day or more', () => {
    expect(formatDistance(17)).toBe('17 mi');
    expect(formatDistance(24)).toBe('24 mi - about 1 day');
    expect(formatDistance(38)).toBe('38 mi - about 1.5 days');
  });
});
