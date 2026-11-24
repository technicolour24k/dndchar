import { describe, expect, it } from 'vitest';
import {
  clampVolume, elementVolume, gainFor, needsGain, parseVolumes, serialiseVolumes, stepVolume, volumeKey, volumeText, withVolume
} from '../../../static/vtt-app/shared/voiceVolume.js';

describe('clampVolume', () => {
  it('clamps, rounds and coerces', () => {
    expect(clampVolume(150)).toBe(150);
    expect(clampVolume(250)).toBe(200);
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(99.6)).toBe(100);
    expect(clampVolume('120')).toBe(120);
    expect(clampVolume(150, 100)).toBe(100);
  });
  it('gives the default for non-numbers', () => {
    expect(clampVolume(NaN)).toBe(100);
    expect(clampVolume(undefined)).toBe(100);
    expect(clampVolume('abc')).toBe(100);
  });
});

describe('stepVolume', () => {
  it('snaps to the grid', () => {
    expect(stepVolume(95, 1)).toBe(100);
    expect(stepVolume(95, -1)).toBe(90);
    expect(stepVolume(100, 1)).toBe(110);
    expect(stepVolume(100, -1)).toBe(90);
  });
  it('stops at the ends', () => {
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(200, 1)).toBe(200);
    expect(stepVolume(100, 1, 10, 100)).toBe(100);
  });
  it('takes a custom step', () => {
    expect(stepVolume(100, 1, 5)).toBe(105);
    expect(stepVolume(98, -1, 5)).toBe(95);
  });
});

describe('volumeKey', () => {
  it('uses the user id', () => {
    expect(volumeKey('3f2a-uuid', 's1')).toBe('3f2a-uuid');
  });
  it('is null for missing, blank or session-id values', () => {
    for (const v of ['', '   ', null, undefined]) expect(volumeKey(v as any, 's1')).toBeNull();
    expect(volumeKey('s1', 's1')).toBeNull();
  });
});

describe('parseVolumes', () => {
  it('gives an empty map for junk', () => {
    for (const raw of [null, '', 'not json', '[]', '5', 'null']) expect(parseVolumes(raw as any).size).toBe(0);
  });
  it('keeps valid entries, clamps, drops defaults and invalid values', () => {
    const m = parseVolumes('{"a":150,"b":100,"c":"x","d":999}');
    expect([...m.entries()]).toEqual([['a', 150], ['d', 200]]);
  });
  it('treats __proto__ as plain data', () => {
    const m = parseVolumes('{"__proto__":50}');
    expect(m.get('__proto__')).toBe(50);
    expect(({} as any).polluted).toBeUndefined();
  });
  it('drops over-long keys', () => {
    expect(parseVolumes(JSON.stringify({ ['k'.repeat(101)]: 50 })).size).toBe(0);
    expect(parseVolumes(JSON.stringify({ ['k'.repeat(100)]: 50 })).size).toBe(1);
  });
});

describe('serialiseVolumes', () => {
  it('round-trips and omits 100s', () => {
    const m = new Map([['a', 150], ['b', 100], ['c', 0]]);
    const back = parseVolumes(serialiseVolumes(m));
    expect([...back.entries()]).toEqual([['a', 150], ['c', 0]]);
  });
});

describe('withVolume', () => {
  it('does not mutate and clamps', () => {
    const m = new Map([['a', 50]]);
    const n = withVolume(m, 'b', 500);
    expect(m.has('b')).toBe(false);
    expect(n.get('b')).toBe(200);
  });
  it('removes the key at 100', () => {
    expect(withVolume(new Map([['a', 50]]), 'a', 100).has('a')).toBe(false);
  });
});

describe('conversions', () => {
  it('gainFor', () => {
    expect(gainFor(200)).toBe(2);
    expect(gainFor(0)).toBe(0);
    expect(gainFor(50)).toBe(0.5);
  });
  it('needsGain is false only at 100', () => {
    expect(needsGain(100)).toBe(false);
    expect(needsGain(99)).toBe(true);
    expect(needsGain(101)).toBe(true);
    expect(needsGain(0)).toBe(true);
  });
  it('elementVolume', () => {
    expect(elementVolume(150)).toBe(1);
    expect(elementVolume(40)).toBe(0.4);
  });
  it('volumeText', () => {
    expect(volumeText(150)).toBe('150%');
  });
});
