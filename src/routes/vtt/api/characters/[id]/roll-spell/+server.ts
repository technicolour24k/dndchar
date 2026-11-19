import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import { castCharacterSpell, getPreparedSpellDamageSource } from '$lib/server/services/catalogue';
import { resolveCritThreshold, resolveD20Outcomes, resolveSpellDamage, totalLevel } from '$lib/rules/dnd5e';
import { characterStatsFor, resolveSpellcastingAbility } from '$lib/rules/characterStats';
import { adjustPrimaryDamageDice, previewAdvantage, rollDamage, rollWithModifiers, spellAttackAgainstCandidates, spellAttackCandidates } from '$lib/rules/attackRoll';
import { gatherVttAdvantageSources, parseAttackOptions } from '$lib/server/vttAttackAdvantage';


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
  const options = parseAttackOptions(body);

  // Preview: reports the advantage sources (and the damage dice) without casting. It must NEVER
  // call castCharacterSpell, which spends a slot - that stays below, after this early return.
  if (options.preview) {
    const previewCharacter = await getCharacter(locals.user!.id, characterId);
    if (!previewCharacter) return json({ error: 'not_found' }, { status: 404 });
    const previewProfile = resolveSpellDamage(spell, {
      castAtSlotLevel: slotLevel || spell.spellLevel,
      casterLevel: totalLevel(previewCharacter.classes),
      modifierSources: previewCharacter.modifierSources
    });
    if (spell.resolutionType !== 'attack') {
      return json({ usesAttackRoll: false, primaryDamageDice: previewProfile.diceExpression });
    }
    const previewContext = { classes: previewCharacter.classes, attackType: 'spell', ability: resolveSpellcastingAbility(previewCharacter.classes, previewCharacter.metadata) } as const;
    const previewGathered = await gatherVttAdvantageSources({
      vtt: options.vtt, attackerSources: previewCharacter.modifierSources, attackerCandidates: spellAttackCandidates,
      targetCandidates: spellAttackAgainstCandidates, context: previewContext, choices: options
    });
    const preview = previewAdvantage(previewCharacter.modifierSources, spellAttackCandidates,
      { ...previewContext, distanceFt: previewGathered.distanceFt }, previewGathered.extraSources, options.disabledSourceIds);
    return json({ usesAttackRoll: true, ...preview, primaryDamageDice: previewProfile.diceExpression });
  }

  // Gather the advantage sources BEFORE casting. This does DB work that can fail, and the cast
  // spends a slot, so a failure here must never leave a spent slot behind (the player would retry
  // and spend another). gatherVttAdvantageSources itself falls back to situational-only on error.
  let gathered: Awaited<ReturnType<typeof gatherVttAdvantageSources>> = { extraSources: [] };
  if (spell.resolutionType === 'attack') {
    const preCharacter = await getCharacter(locals.user!.id, characterId);
    if (!preCharacter) return json({ error: 'not_found' }, { status: 404 });
    gathered = await gatherVttAdvantageSources({
      vtt: options.vtt, attackerSources: preCharacter.modifierSources, attackerCandidates: spellAttackCandidates,
      targetCandidates: spellAttackAgainstCandidates,
      context: { classes: preCharacter.classes, attackType: 'spell', ability: resolveSpellcastingAbility(preCharacter.classes, preCharacter.metadata) },
      choices: options
    });
  }

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

  let attack: Awaited<ReturnType<typeof rollWithModifiers>> | undefined;
  let outcomes: string[] = [];
  if (spell.resolutionType === 'attack') {
    // Re-read after the cast (on_cast effects may have changed the sheet), but the target/token
    // sources were already gathered above, before the slot was spent.
    const rollContext = { classes: character.classes, attackType: 'spell', ability: resolveSpellcastingAbility(character.classes, character.metadata) } as const;
    const attackBonus = stats.spellAttackBonus.value;
    // flatModifiersIncluded: true - attackBonus already has spell_attack_roll/attack_roll.spell
    // bonus/penalty modifiers folded in via resolveCharacterStats(), so rollWithModifiers must
    // not add them again (see attackRoll.ts's flatModifiersIncluded comment).
    const rolled = rollWithModifiers(character.modifierSources, attackBonus, spellAttackCandidates,
      [{ label: 'Spell Attack', value: attackBonus }], undefined, {
        flatModifiersIncluded: true,
        context: { ...rollContext, distanceFt: gathered.distanceFt },
        extraAdvantageSources: gathered.extraSources,
        disabledSourceIds: options.disabledSourceIds
      });
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

  // INTERIM: manual damage-dice delta, applied after scaling and any spell multiplier.
  const adjusted = adjustPrimaryDamageDice(profile.diceExpression, options.manualDamageDice);
  // Homebrew crit rule applies to a spell attack that crits (outcomes is empty for save/auto spells).
  const damage = rollDamage(adjusted.expression, 0, 0, '', profile.flatBonuses, profile.extraDice, undefined, outcomes.includes('critical_hit'));

  return json({
    title: spell.name,
    resolution: profile.resolution,
    damageType: profile.damageType,
    damage: [...(adjusted.auditLine ? [adjusted.auditLine] : []), ...(profile.scalingNote ? [`Dice: ${profile.diceExpression} (${profile.scalingNote})`] : []), ...damage.lines],
    damageTotal: damage.total,
    manualDamageDice: adjusted.applied,
    attackPool: attack?.pool,
    advantageSources: attack?.advantageSources,
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
