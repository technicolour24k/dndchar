import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { getCharacterForRoll } from '$lib/server/services/characters';
import { getCharacterAccess } from '$lib/server/services/access';
import { payTurnActivation } from '$lib/server/services/catalogue';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { CostShortfallError } from '$lib/server/services/cost-engine';
import type { Activation } from '$lib/types/cost';
import { costShortfallBody, openCostGate, runWithGate } from '$lib/server/vttCostGate';
import { abilityMap, equippedAttackItems } from '$lib/rules/dnd5e';
import { characterStatsFor } from '$lib/rules/characterStats';
import { attackAgainstCandidatesFor, attackCandidatesFor, previewAdvantage, rollAttack } from '$lib/rules/attackRoll';
import { gatherVttAdvantageSources, parseAttackOptions } from '$lib/server/vttAttackAdvantage';

// Server-side attack roll for the VTT. The vanilla VTT client can't import $lib (no build step),
// and the token it holds only carries a flattened `actions` array - it doesn't have the character's
// modifierSources, so it physically cannot reproduce the sheet's rich roll (advantage/disadvantage
// dice-pool, Bless/extra dice, crit outcomes). So the roll runs here, against the LIVE character,
// using the exact same rollAttack() the character sheet uses. One roll implementation, two callers.
//
// Deliberately NOT owner-scoped (getCharacterForRoll, not getCharacter) - a GM rolling a weapon
// attack for a player's token (e.g. the player stepped away) is a pure dice-roll read with no
// state mutation, and this app's product philosophy is campaign members can interact with all
// campaign sheets. GM-only enforcement of *who* may trigger a given token's attack in the first
// place already lives in the VTT socket layer (attack:resolve), not here.
//
// The attack's ACTION is paid here too (action economy): when the actor may act for the character
// (owner or campaign DM), a real roll pays the weapon attack's turn line through the cost engine, with
// the usual ask-the-DM flow on a shortfall. The roll is computed first and only returned once the
// action was paid. If the actor can't act for the character (a Quick-room GM rolling someone else's
// token), the attack rolls unpaid, as before, and the response says `turn: null`. A preview never pays.
// Body extras: timing ('action' | 'bonus_action' | 'reaction', default action), followup ('use' | 'skip',
// default use: Extra Attack is the default choice while follow-ups wait), approvalId / override / roomId.
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const character = await getCharacterForRoll(params.id!);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const itemName = typeof body?.itemName === 'string' ? body.itemName : '';
  if (!itemName) return json({ error: 'missing_item' }, { status: 400 });

  // Match against the same equipped-attack set the mini-sheet's action list was built from, so a
  // clicked action always resolves to a real inventory item (with its full category/ability/
  // proficient/effects data that the flattened token action dropped).
  const item = equippedAttackItems(character.inventory).find((entry) => entry.name === itemName);
  if (!item) return json({ error: 'item_not_found' }, { status: 404 });

  // Advantage inputs. The client only sends its CHOICES (unticked sources, situational counts,
  // damage-dice delta); every source is recomputed here from live data.
  const options = parseAttackOptions(body);
  const attackerCandidates = attackCandidatesFor(item);
  const baseContext = { classes: character.classes, ability: item.attackAbility, attackType: 'melee_weapon' } as const;
  const gathered = await gatherVttAdvantageSources({
    vtt: options.vtt,
    attackerSources: character.modifierSources,
    attackerCandidates,
    targetCandidates: attackAgainstCandidatesFor(item),
    context: baseContext,
    choices: options
  });

  // Preview: same sources and netting as the real roll, but nothing is rolled or changed.
  if (options.preview) {
    const preview = previewAdvantage(character.modifierSources, attackerCandidates, { ...baseContext, distanceFt: gathered.distanceFt },
      gathered.extraSources, options.disabledSourceIds);
    return json({ usesAttackRoll: true, ...preview, primaryDamageDice: item.damageRolls, turn: character.turn });
  }

  // characterStatsFor resolves the proficiency override/adjustment cascade the same way the
  // sheet does, so a manually-set proficiency shows up in a VTT-triggered attack roll too.
  const result = rollAttack(item, {
    modifierSources: character.modifierSources,
    abilityScores: abilityMap(character.abilities),
    proficiencyBonus: characterStatsFor(character).proficiency.value,
    classes: character.classes,
    distanceFt: gathered.distanceFt,
    extraAdvantageSources: gathered.extraSources,
    disabledSourceIds: options.disabledSourceIds,
    manualDamageDice: options.manualDamageDice // INTERIM
  });

  const timing = ['action', 'bonus_action', 'reaction'].includes(body?.timing) ? body.timing : 'action';
  const followup = body?.followup === 'skip' ? 'skip' : 'use';
  const characterId = params.id!;
  const access = locals.user ? await getCharacterAccess({ query }, locals.user.id, characterId) : null;
  if (!access?.canAct) return json({ ...result, turn: null });

  const activation: Activation = { kind: 'weapon_attack', inventoryId: item.id ?? null, timing, followup };
  const gate = await openCostGate({ userId: locals.user!.id, characterId, activation, approvalId: body.approvalId, override: body.override, roomId: body.roomId });
  if (!gate.ok) return json(gate.body, { status: gate.status });
  try {
    const paid = await runWithGate(gate, (override) => payTurnActivation(locals.user!.id, characterId, activation, override));
    emitRealtimeEvent('resource:changed', { characterId });
    const used = paid.paid.find((line) => line.pool === 'followup');
    return json({
      ...result,
      turn: { paid: paid.paid.map((line) => ({ label: line.label, delta: line.delta })), usedFollowup: Boolean(used), followupsLeft: paid.turn.followups.map((f) => ({ cls: f.cls, label: f.label, remaining: f.remaining })), view: paid.turn }
    });
  } catch (error) {
    if (error instanceof CostShortfallError) return json(costShortfallBody(gate, error), { status: 409 });
    return json({ error: error instanceof Error ? error.message : 'Could not pay for the attack.' }, { status: 400 });
  }
};
