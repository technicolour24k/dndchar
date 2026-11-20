import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { previewAdvantage, rollManualAttack } from '$lib/rules/attackRoll';
import { gatherVttAdvantageSources, parseAttackOptions } from '$lib/server/vttAttackAdvantage';

// Server-side roll for a DM's manual stat-block attack (a monster's action:
// name + to-hit bonus + damage dice, entered directly on the token, no linked
// character). Kept server-side purely so the VTT reuses the one shared roll
// module and its display format - the vanilla client can't import $lib. The
// route is auth-gated by hooks.server.ts; GM-only enforcement of *who* may
// attack lives in the VTT socket layer (attack:resolve), not here - this
// endpoint only rolls dice and reveals nothing sensitive.
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const resolution = body?.resolution;
  const options = parseAttackOptions(body);

  // Only a weapon attack or a spell attack rolls a d20 (save/auto spells carry a fixed DC), so
  // only those take advantage sources. A manual monster has no sheet modifiers of its own, so
  // the sources are its token conditions, the target's, and the situational counters.
  const usesAttackRoll = resolution === undefined || resolution === 'attack';
  const isSpell = resolution === 'attack';
  // 'melee_weapon' matches rollAttack's own convention for a weapon attack.
  const baseContext = { attackType: isSpell ? 'spell' : 'melee_weapon' } as const;
  const attackerCandidates = [isSpell ? 'attack_roll.spell' : 'attack_roll.weapon'];
  const gathered = usesAttackRoll
    ? await gatherVttAdvantageSources({
        vtt: options.vtt, attackerSources: [], attackerCandidates,
        targetCandidates: [isSpell ? 'attacks_against.spell' : 'attacks_against.weapon'],
        context: baseContext, choices: options
      })
    : { extraSources: [], distanceFt: undefined };

  if (options.preview) {
    const preview = previewAdvantage([], attackerCandidates, { ...baseContext, distanceFt: gathered.distanceFt },
      gathered.extraSources, options.disabledSourceIds);
    return json({ usesAttackRoll, ...preview, primaryDamageDice: String(body?.damageRolls || '') });
  }

  const result = rollManualAttack({
    name: String(body?.name || 'Attack'),
    toHitBonus: Number(body?.toHitBonus) || 0,
    damageRolls: String(body?.damageRolls || ''),
    damageBonus: Number(body?.damageBonus) || 0
  }, undefined, {
    extraAdvantageSources: gathered.extraSources,
    disabledSourceIds: options.disabledSourceIds,
    manualDamageDice: options.manualDamageDice, // INTERIM
    allowCrit: usesAttackRoll // a save/auto spell's discarded d20 must not crit its damage
  });

  // A manual stat-block spell (kind 'spell' on the token's action) - same
  // result shape as roll-spell so the VTT's spell flow needs no special case.
  // Only 'attack' resolution has a to-hit roll; save/auto spells drop it and
  // carry the fixed DC instead.
  const damageType = String(body?.damageType || '').trim().toLowerCase() || undefined;
  if (resolution === 'attack' || resolution === 'save' || resolution === 'auto') {
    if (resolution === 'attack') return json({ ...result, resolution, damageType });
    const { attack, attackTotal, attackNatural, outcomes, attackPool, advantageSources, ...rest } = result;
    void attack; void attackTotal; void attackNatural; void outcomes; void attackPool; void advantageSources;
    return json({
      ...rest,
      resolution,
      damageType,
      outcomes: [],
      saveDc: resolution === 'save' ? Number(body?.saveDc) || 10 : undefined,
      saveAbility: resolution === 'save' ? String(body?.saveAbility || 'dex') : undefined,
      saveEffect: resolution === 'save' ? (body?.saveEffect === 'negate' ? 'negate' : 'half') : undefined
    });
  }
  return json({ ...result, damageType });
};
