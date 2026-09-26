import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import { castCharacterSpell, getPreparedSpellDamageSource } from '$lib/server/services/catalogue';
import { resolveCritThreshold, resolveD20Outcomes, resolveSpellDamage, totalLevel } from '$lib/rules/dnd5e';
import { characterStatsFor } from '$lib/rules/characterStats';
import { rollDamage, rollWithModifiers } from '$lib/rules/attackRoll';

// Server-side spell cast + damage roll for the VTT, mirroring roll-attack/+server.ts's
// posture exactly: the vanilla VTT client can't import $lib, so this is the one place a
// spell's full modifier-aware roll (and slot spend) can happen. Reuses castCharacterSpell()
// UNCHANGED for the known/prepared validation and slot spend/on_cast effects - one slot-spend
// implementation, not two - then layers damage/attack resolution on top for the VTT's combat flow.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const characterId = params.id!;
  const body = await request.json().catch(() => ({}));
  const instanceId = typeof body?.instanceId === 'string' ? body.instanceId : '';
  if (!instanceId) return json({ error: 'missing_instance' }, { status: 400 });

  const spell = await getPreparedSpellDamageSource(characterId, instanceId);
  if (!spell) return json({ error: 'spell_not_found' }, { status: 404 });

  const slotLevel = spell.spellLevel > 0 ? Math.max(spell.spellLevel, Number(body.slotLevel) || spell.spellLevel) : 0;

  const castForm = new FormData();
  castForm.set('instanceId', instanceId);
  if (body.slotType) castForm.set('slotType', String(body.slotType));
  if (slotLevel) castForm.set('slotLevel', String(slotLevel));

  let effects;
  try {
    effects = await castCharacterSpell(locals.user!.id, characterId, castForm);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Could not cast spell.' }, { status: 400 });
  }

  const character = await getCharacter(locals.user!.id, characterId);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const level = totalLevel(character.classes);
  // characterStatsFor resolves the spellcasting ability fallback chain (class -> metadata ->
  // 'int' - this endpoint used to hardcode 'int' and ignore metadata.spellcastingAbility, unlike
  // the sheet), plus overrides/adjustments and the proficiency cascade. spellAttackBonus/
  // spellSaveDc below now include spell_attack_roll/spell_save_dc modifiers and a manual
  // override/adjustment, both previously ignored here.
  const stats = characterStatsFor(character);

  let attack: { text: string; total: number; natural: number } | undefined;
  let outcomes: string[] = [];
  if (spell.resolutionType === 'attack') {
    const attackBonus = stats.spellAttackBonus.value;
    // flatModifiersIncluded: true - attackBonus already has spell_attack_roll/attack_roll.spell
    // bonus/penalty modifiers folded in via resolveCharacterStats(), so rollWithModifiers must
    // not add them again (see attackRoll.ts's flatModifiersIncluded comment).
    const rolled = rollWithModifiers(character.modifierSources, attackBonus, ['spell_attack_roll', 'attack_roll.spell'],
      [{ label: 'Spell Attack', value: attackBonus }], undefined, { flatModifiersIncluded: true });
    const critThreshold = resolveCritThreshold(character.modifierSources, { attackType: 'spell' });
    outcomes = resolveD20Outcomes(rolled.natural, critThreshold);
    attack = rolled;
  }

  const profile = resolveSpellDamage(spell, {
    castAtSlotLevel: slotLevel || spell.spellLevel,
    casterLevel: level,
    modifierSources: character.modifierSources,
    outcomes
  });

  const damage = rollDamage(profile.diceExpression, 0, 0, '', profile.flatBonuses, profile.extraDice);

  return json({
    title: spell.name,
    resolution: profile.resolution,
    damageType: profile.damageType,
    damage: damage.lines,
    damageTotal: damage.total,
    attack: attack?.text,
    attackTotal: attack?.total,
    attackNatural: attack?.natural,
    outcomes,
    saveDc: profile.resolution === 'save' ? stats.spellSaveDc.value : undefined,
    saveAbility: profile.saveAbility,
    saveEffect: profile.saveEffect,
    effects
  });
};
