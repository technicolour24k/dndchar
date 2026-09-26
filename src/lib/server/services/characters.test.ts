import { describe, expect, it } from 'vitest';
import { parseStatOverridesField } from './characters';

// Only the pure form-parsing helper is tested here - everything else in this service touches
// the database. Mirrors the pattern in effects.test.ts (a plain exported function from a
// service module that otherwise has DB-touching neighbours).
describe('parseStatOverridesField', () => {
  function formWith(value: string | undefined) {
    const form = new FormData();
    if (value !== undefined) form.set('statOverridesJson', value);
    return form;
  }

  it('returns undefined (leave stored overrides untouched) when the field is missing entirely', () => {
    expect(parseStatOverridesField(formWith(undefined))).toBeUndefined();
  });

  it('returns undefined on invalid JSON', () => {
    expect(parseStatOverridesField(formWith('{not json'))).toBeUndefined();
  });

  it('returns undefined for valid JSON that is not a plain object, instead of laundering it into {} via readStatOverrides and wiping stored overrides', () => {
    expect(parseStatOverridesField(formWith('null'))).toBeUndefined();
    expect(parseStatOverridesField(formWith('"x"'))).toBeUndefined();
    expect(parseStatOverridesField(formWith('42'))).toBeUndefined();
    expect(parseStatOverridesField(formWith('[]'))).toBeUndefined();
  });

  it('parses a genuine overrides object, including a reset to {} (all entries removed)', () => {
    expect(parseStatOverridesField(formWith('{}'))).toEqual({});
    expect(parseStatOverridesField(formWith(JSON.stringify({ armorClass: { adjustment: 2, override: 18 } }))))
      .toEqual({ armorClass: { adjustment: 2, override: 18 } });
  });
});
