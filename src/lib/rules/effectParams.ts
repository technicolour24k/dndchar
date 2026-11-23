// Per-instance parameters for applied conditions. A condition's link expression may contain
// {name} placeholders; the applied effect row stores the values in metadata_json.params.

export type EffectParams = Record<string, number>;

/**
 * Replaces {name} with the instance's value. A missing or non-numeric name becomes 0.
 * An expression with no placeholders is returned unchanged, so existing conditions behave as before.
 */
export function substituteParams(expression: string, params: EffectParams | null | undefined): string {
  if (!expression || !expression.includes('{')) return expression;
  const substituted = expression.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_match, name: string) => {
    const value = params && Object.prototype.hasOwnProperty.call(params, name) ? Number(params[name]) : 0;
    return String(Number.isFinite(value) ? value : 0);
  });
  return collapseIntegerArithmetic(substituted);
}

// "2+-3", "--3" and "-3" are not valid for the Number()-based evaluators, so pure +/- integer
// arithmetic is folded to one number. Anything else (dice such as "-3d6") is left as it is.
function collapseIntegerArithmetic(text: string): string {
  const compact = text.replace(/\s+/g, '');
  if (!/^[+-]*\d+([+-]+\d+)*$/.test(compact)) return text;
  let total = 0;
  for (const [, signs, digits] of compact.matchAll(/([+-]*)(\d+)/g)) {
    const negative = (signs.match(/-/g) ?? []).length % 2 === 1;
    total += negative ? -Number(digits) : Number(digits);
  }
  return String(total);
}

/** Reads params and label out of an effect row's metadata_json, tolerating anything. */
export function readEffectMetadata(metadata: unknown): { params: EffectParams; sourceLabel: string } {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const params: EffectParams = {};
  if (meta.params && typeof meta.params === 'object') {
    for (const [name, value] of Object.entries(meta.params as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) params[name] = value;
    }
  }
  return { params, sourceLabel: typeof meta.sourceLabel === 'string' ? meta.sourceLabel : '' };
}
