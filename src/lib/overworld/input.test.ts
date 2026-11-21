import { describe, expect, it } from 'vitest';
import { parseMapFields, parsePinInput, parseRouteFields, parseRoutePoints } from './input';

const form = (values: Record<string, string>) => new Map(Object.entries(values));
const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i / 1000, y: 0.5 }));

describe('parseRoutePoints', () => {
  it('accepts a JSON string or an array', () => {
    const arr = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(parseRoutePoints(JSON.stringify(arr))).toEqual({ ok: true, points: arr });
    expect(parseRoutePoints(arr)).toEqual({ ok: true, points: arr });
  });
  it('rejects 1 point and 202 points, accepts 2 and 201', () => {
    expect(parseRoutePoints(pts(1)).ok).toBe(false);
    expect(parseRoutePoints(pts(202)).ok).toBe(false);
    expect(parseRoutePoints(pts(2)).ok).toBe(true);
    expect(parseRoutePoints(pts(201)).ok).toBe(true);
  });
  it('rejects NaN, out of range, non-numbers, non-arrays and bad JSON', () => {
    const ok = { x: 0.5, y: 0.5 };
    expect(parseRoutePoints([ok, { x: NaN, y: 0.5 }]).ok).toBe(false);
    expect(parseRoutePoints([ok, { x: Infinity, y: 0.5 }]).ok).toBe(false);
    expect(parseRoutePoints([ok, { x: -0.1, y: 0.5 }]).ok).toBe(false);
    expect(parseRoutePoints([ok, { x: 0.5, y: 1.1 }]).ok).toBe(false);
    expect(parseRoutePoints([ok, { x: '0.5', y: 0.5 }]).ok).toBe(false);
    expect(parseRoutePoints([ok, null]).ok).toBe(false);
    expect(parseRoutePoints({ x: 1 }).ok).toBe(false);
    expect(parseRoutePoints('not json').ok).toBe(false);
    expect(parseRoutePoints(null).ok).toBe(false);
  });
  it('accepts the 0 and 1 edges', () => {
    expect(parseRoutePoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]).ok).toBe(true);
  });
  it('drops consecutive duplicates and still needs two points', () => {
    const r = parseRoutePoints([{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]);
    expect(r).toEqual({ ok: true, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] });
    expect(parseRoutePoints([{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }]).ok).toBe(false);
  });
  it('keeps a non-consecutive repeat (a route can double back)', () => {
    const a = { x: 0.1, y: 0.1 };
    const b = { x: 0.2, y: 0.2 };
    expect(parseRoutePoints([a, b, a])).toEqual({ ok: true, points: [a, b, a] });
  });
});

describe('parsePinInput', () => {
  it('create: needs a position, reads everything, trims text', () => {
    const r = parsePinInput(
      form({ x: '0.25', y: '0.75', label: '  Inn ', note: ' hi ', colour: 'blue', icon: 'star', visibility: 'private', kind: 'party' }),
      'create'
    );
    expect(r).toEqual({
      ok: true,
      fields: { x: 0.25, y: 0.75, kind: 'party', label: 'Inn', note: 'hi', colour: 'blue', icon: 'star', visibility: 'private' }
    });
  });
  it('create: missing or out-of-range position fails', () => {
    expect(parsePinInput(form({ label: 'x' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ x: '1.2', y: '0.5' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ x: 'abc', y: '0.5' }), 'create').ok).toBe(false);
  });
  it('rejects unknown colour, icon, visibility, kind and over-long text', () => {
    const base = { x: '0.5', y: '0.5' };
    expect(parsePinInput(form({ ...base, colour: 'pink' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ ...base, icon: 'skull' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ ...base, visibility: 'dm' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ ...base, kind: 'boss' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ ...base, label: 'x'.repeat(61) }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ ...base, note: 'x'.repeat(1001) }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ ...base, label: 'x'.repeat(60), note: 'x'.repeat(1000) }), 'create').ok).toBe(true);
  });
  it('update: ignores position and kind, leaves missing fields out', () => {
    const r = parsePinInput(form({ x: '0.1', y: '0.1', kind: 'party', label: 'New' }), 'update');
    expect(r).toEqual({ ok: true, fields: { label: 'New' } });
  });
  it('move: only reads the position', () => {
    expect(parsePinInput(form({ x: '0.4', y: '0.6', label: 'ignored' }), 'move')).toEqual({
      ok: true,
      fields: { x: 0.4, y: 0.6 }
    });
    expect(parsePinInput(form({ x: '0.4' }), 'move').ok).toBe(false);
  });
});

describe('parseMapFields', () => {
  it('reads a name and an optional scale', () => {
    expect(parseMapFields(form({ name: ' Faerun ', milesAcross: '1500' }))).toEqual({
      ok: true, name: 'Faerun', milesAcross: 1500
    });
    expect(parseMapFields(form({ name: 'Feywild', milesAcross: '' }))).toEqual({
      ok: true, name: 'Feywild', milesAcross: null
    });
    expect(parseMapFields(form({ name: 'Feywild' }))).toEqual({ ok: true, name: 'Feywild', milesAcross: null });
  });
  it('rejects a blank or 81 character name and a bad scale', () => {
    expect(parseMapFields(form({ name: '   ' })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'x'.repeat(81) })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'x'.repeat(80) })).ok).toBe(true);
    expect(parseMapFields(form({ name: 'a', milesAcross: '0' })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'a', milesAcross: '-5' })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'a', milesAcross: 'far' })).ok).toBe(false);
  });
});

describe('strict numbers', () => {
  it('rejects empty, whitespace and hex for pin positions', () => {
    for (const bad of ['', ' ', '0x1', '0x10', '1e0', 'Infinity']) {
      expect(parsePinInput(form({ x: bad, y: '0.5' }), 'create').ok).toBe(false);
      expect(parsePinInput(form({ x: '0.5', y: bad }), 'move').ok).toBe(false);
    }
  });
  it('accepts plain decimals, with padding', () => {
    expect(parsePinInput(form({ x: ' 0.5 ', y: '.25' }), 'move')).toEqual({ ok: true, fields: { x: 0.5, y: 0.25 } });
    expect(parsePinInput(form({ x: '1', y: '0' }), 'move').ok).toBe(true);
  });
  it('rejects hex and exponent scales', () => {
    expect(parseMapFields(form({ name: 'a', milesAcross: '0x10' })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'a', milesAcross: '1e3' })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'a', milesAcross: ' ' }))).toEqual({ ok: true, name: 'a', milesAcross: null });
  });
});

describe('control characters', () => {
  it('rejects NUL and other C0 characters in labels, notes and map names', () => {
    expect(parsePinInput(form({ x: '0.5', y: '0.5', label: 'a\u0000b' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ x: '0.5', y: '0.5', label: 'a\nb' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ x: '0.5', y: '0.5', note: 'a\u0000b' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ x: '0.5', y: '0.5', note: 'a\u001Bb' }), 'create').ok).toBe(false);
    expect(parsePinInput(form({ x: '0.5', y: '0.5', note: 'a\u007Fb' }), 'create').ok).toBe(false);
    expect(parseMapFields(form({ name: 'Fae\u0000run' })).ok).toBe(false);
    expect(parseMapFields(form({ name: 'Fae\trun' })).ok).toBe(false);
  });
  it('allows newlines and tabs in notes', () => {
    const r = parsePinInput(form({ x: '0.5', y: '0.5', note: 'line one\r\nline\ttwo\nthree' }), 'create');
    expect(r.ok).toBe(true);
  });
});

describe('limits', () => {
  it('caps the scale at 100000 miles', () => {
    expect(parseMapFields(form({ name: 'a', milesAcross: '100000' })).ok).toBe(true);
    expect(parseMapFields(form({ name: 'a', milesAcross: '100001' })).ok).toBe(false);
  });
  it('refuses a route string over 50000 characters before parsing', () => {
    const big = '[' + '{"x":0.1,"y":0.1},'.repeat(3000) + '{"x":0.2,"y":0.2}]';
    expect(big.length).toBeGreaterThan(50_000);
    const r = parseRoutePoints(big);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/too long/);
  });
});

describe('parseRouteFields', () => {
  it('returns only the fields that were sent', () => {
    expect(parseRouteFields(form({}))).toEqual({ ok: true, fields: {} });
    expect(parseRouteFields(form({ label: ' Road ', colour: 'teal', visibility: 'private' }))).toEqual({
      ok: true, fields: { label: 'Road', colour: 'teal', visibility: 'private' }
    });
  });
  it('rejects bad colour, visibility, long label and control characters', () => {
    expect(parseRouteFields(form({ colour: 'pink' })).ok).toBe(false);
    expect(parseRouteFields(form({ visibility: 'dm' })).ok).toBe(false);
    expect(parseRouteFields(form({ label: 'x'.repeat(61) })).ok).toBe(false);
    expect(parseRouteFields(form({ label: 'a\u0000b' })).ok).toBe(false);
  });
});
