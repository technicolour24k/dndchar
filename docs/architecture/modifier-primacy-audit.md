# Modifier-Primacy Audit - Document vs. Live Code

**Purpose:** This is a factual discrepancy report comparing `docs/architecture/modifier-primacy.md` (as revised, particularly §2.6, §4.5, §5, and §6) against the actual repository state as of this audit. It does not propose a migration plan - it only records what matches, what doesn't, and what's outstanding, so that decision-making about next steps starts from an accurate picture rather than the document's own framing.

**Scope:** Schema (`src/lib/server/db/migrations/001`-`018`), service layer (`rule-engine.ts`, `action-engine.ts`, `rules-admin.ts`, `effects.ts`, `catalogue.ts`, `content-admin.ts`), TypeScript types (`src/lib/types/rules.ts`, `content.ts`, `character.ts`), and UI (`src/routes/admin/rules/**`, `src/lib/components/admin/ContentTypeAdmin.svelte`, `src/lib/components/character/CharacterSheetForm.svelte`).

**Housekeeping note:** `CLAUDE.md` and the entire `docs/` folder are untracked in git (`git ls-files docs/` returns nothing). They exist only in this local working copy. `CLAUDE.md` itself is unchanged from the prior revision - all substantive changes are within `modifier-primacy.md`.

---

## 1. Section 6 fact-check

`modifier-primacy.md` §6 states it was written from "a manual walkthrough of the live application's screens... not mockups." Each sub-claim was checked directly against the code it describes.

| § | Claim | Verdict | Evidence |
|---|---|---|---|
| 6.1 | Dot-notation targets (`ability_check.str`, `attack_roll.all`, etc.); ~16-entry Conditions catalogue | **Mostly accurate** | Dot-notation confirmed in `scripts/seed-core-effects.ts`. Count is off: roughly **8** core effects are seeded (Poisoned, Rage, Bless, Haste, Shield, Dodge, Half Cover, Three-Quarters Cover), not 16. |
| 6.2 | Three-column Library/Editor/Create UI; dedup by target+operation+value; "Used By" panel; "Confirm shared update" checkbox | **Accurate** | `src/routes/admin/rules/modifiers/+page.svelte` is a literal three-column layout. Dedup: `ON CONFLICT(target, modifier_type, COALESCE(default_value_expression,''))` in `rules-admin.ts:121`. "Used By" panel + reference count rendered; checkbox enforced server-side at `rules-admin.ts:113` (`if (!id \|\| form.get('confirmShared') !== 'on') throw ...`). |
| 4.5 | "Create a copy for this entry" option alongside in-place update | **Accurate - fully implemented** | `copy` form action exists (`modifiers/+page.server.ts:8`), wired to `saveModifier(form, 'copy')` (`rules-admin.ts:104`). Not a stub. |
| 6.3 | Permission tiers (player vs. DM/admin authoring); grant-free descriptive-only items | **Discrepancy - not implemented** | A `role: 'user' \| 'admin'` column exists on the session/user model, but no route in `content-admin.ts` or `rules-admin.ts` checks it. Any authenticated user can create/edit modifiers, effects, and content through the same routes. No grant-free inventory-item authoring path exists. |
| 6.4 | Catalogue tab already removed from Player Modifications | **Discrepancy - contradicted** | `CharacterSheetForm.svelte:129` lists `{ key: 'catalogue', label: 'Catalogue' }` as a live, primary tab in `modifierFilters`, alongside Active/Conditions/Spells/Combat/Class/Environment. Still present as a top-level player-facing tab. |
| 6.5 | Container/content authoring supports attaching multiple independent modifier instances | **Accurate** | `ContentTypeAdmin.svelte` has a repeatable `?/attachModifier` form; each submission adds a row to `content_modifier_links`. |
| 6.6 | Two-phase roll resolution (resolve to-hit/crit first, gate damage modifiers on that outcome) | **Discrepancy - doesn't exist** | `rollBattleAction`/`rollDamageExpression` in `CharacterSheetForm.svelte` (~lines 484-570) computes damage in a single pass. No crit detection, no threshold check, no conditional gating on the attack roll's outcome exists to be "one-phase" or "two-phase" about. |
| 6.7 | `derived_from_sibling` value source; crit bonus = "roll once, add die's max as flat bonus" | **Discrepancy - doesn't exist** | `resolveModifierNumericValue` (`dnd5e.ts:113-118`) handles only a literal number or the single hardcoded `rage_damage_bonus` case. No sibling-modifier lookup. No crit-bonus mechanic in any form. |
| 2.6 | Audit-trail roll breakdown, claimed to generalize beyond combat | **Real, but overstated** | `rollDamageExpression` does build a labelled, source-attributed `lines[]` (dice rolls, flat bonuses, ability modifier, each modifier's `.label`, running totals, final `Total:`) - genuinely working for combat rolls. No equivalent breakdown exists for AC, saving throws, or skill checks, despite §2.6 asserting the requirement applies "uniformly... not specific to combat rolls." |

**Summary:** of Section 6's seven sub-claims, four (6.1, 6.2, 6.5, and 4.5) are accurate or close to accurate; three (6.3, 6.4, 6.6/6.7) describe behavior as already decided-and-built or already working when it does not exist in code at all.

---

## 2. What already conforms - no change needed

- **Dot-notation modifier targets** (`ability_check.str`, `attack_roll.all`, `damage_taken.bludgeoning`, etc.) - `modifier_targets` table, used consistently through `effect_modifier_links` and `content_modifier_links`.
- **Modifier Library admin UI** - three-column Library/Editor/Create layout, dedup-on-save by `(target, modifier_type, value)`, "Used By" panel with live reference counts, "Confirm shared update" checkbox gating propagation server-side.
- **Update-vs-copy on shared Modifiers** - both paths exist and are wired end to end (`create`/`update`/`copy` actions → `saveModifier(form, mode)`).
- **Soft-delete only on definitions** - `is_archived` on `modifier_targets`, `modifier_definitions`, `effect_definitions`, `content_definitions`, `action_definitions`; no hard-delete code path touches these tables.
- **Version history resolves mechanics live** - `character_versions.snapshot_json` stores full state, but `rule-engine.ts` always re-resolves against current `modifier_definitions`/`effect_modifier_links`/`content_modifier_links`, never frozen values. Matches §4.2's rule in practice, even though the storage shape (full JSON, not definition-ID + params) differs from the doc's literal description.
- **Combat roll audit trail** - the labelled, source-attributed breakdown for attack/damage rolls described in §2.6 is real and working, scoped to combat only.
- **Multiple modifiers per content record** - repeatable attach UI in `ContentTypeAdmin.svelte`, one row per `content_modifier_links` entry.
- **Content-grants-content** - `content_grants` (item/feat/spell granting other catalogue content) is implemented and used in `catalogue.ts` to surface granted content as active character-content instances.

---

## 3. What needs to be reshaped - still structured around the old Effect/Catalogue-Content split

- The entire schema is the four-layer model the document declares superseded: `modifier_targets` → `modifier_definitions` → `effect_definitions` (+ `effect_modifier_links`) → `content_definitions` (+ `spell_definitions`/`item_definitions` as separate joined tables). There is no `Container` table or type anywhere; Items and Spells remain different shapes, not the same shape distinguished only by metadata.
- `action_definitions`/`action_steps` is a fully separate execution engine for one-off effects (heal, damage, resource changes), parallel to and disjoint from the Modifier/Effect machinery. §9 says "an action is a Container... granting one or more Modifiers" - the code has no such unification; actions execute steps, they don't grant modifier instances.
- **Effects cannot grant other effects.** `content_grants` only links `content_definitions` to `content_definitions` (items/feats/spells/class_features). `effect_definitions` has no analogous self-referencing grant mechanism. Concretely: `Rage` is seeded as one flat `effect_definitions` row with its own modifiers directly attached - there is no separate `Raging` effect that `Rage` grants. §5's worked example (Rage-the-Container granting Raging-the-Container) describes a pattern that does not exist for effects today, only for catalogue content.
- Cost is still scalar/string everywhere it appears (`content_spell_access.resource_cost_expression`, `action_steps.value_expression`) - not the structured `[{pool, amount}]` list §2.3 specifies.
- The Player Modifications panel's tab set (`Active/Automated/Potential/Condition/Spell/Combat/Class/Environment/All/Catalogue`) is built around the four-layer model's categories (filtering by effect source-type), not around a single unified Container apply-list.

---

## 4. Referenced in the document but doesn't exist in code yet

- **Permission tiers (§6.3)** - no role-gated authoring anywhere; `role` column exists on users but is unchecked in any content/modifier/effect mutation path. No player-facing grant-free descriptive-item creation flow.
- **Two-phase roll resolution (§6.6)** - no crit detection or outcome-dependent modifier gating; damage resolves in a single pass regardless of the to-hit result.
- **`derived_from_sibling` value source (§6.7)** - only a literal number or the one hardcoded `rage_damage_bonus` case is supported; no general sibling-modifier lookup, no crit-bonus mechanic in either form discussed in the doc.
- **Audit trails on non-combat calculations (§2.6's closing claim)** - AC, saving throws, and skill checks have no equivalent source-attributed breakdown UI; only attack/damage rolls do.
- **Container-grants-Container, generally (§5)** - exists in the narrow case of catalogue content granting catalogue content; does not exist for effects granting effects, and does not exist at all for the not-yet-built unified Container concept.

(Note: the copy-vs-update choice, §4.5, was originally a candidate for this list but turned out to be fully implemented - see §1 above.)

---

## 5. Document claims that conflict with the actual schema/code today

- **§6.4 states the Catalogue tab "is removed"** as a settled fact - it is not; `'catalogue'` is live in `CharacterSheetForm.svelte`'s primary tab list.
- **§6.1's "16 entries observed"** - actual seed data has roughly 8 core effect rows, not 16.
- **§6.3 frames permission tiers as "a clear three-way split [that] emerged from walking through real authoring scenarios... now a firm requirement"** - phrased as something confirmed by inspecting the live app's actual behavior, but the live app has no such behavior; this reads as aspirational design wrongly framed as an observation.
- **§5/§9's "Rage is a Container whose grant is one instance of a different Container: Raging"** - the schema's actual `Rage` is a single, flat effect with modifiers attached directly; there is no second `Raging` entity and no entity-grants-entity mechanism for effects, so this worked example describes a restructuring, not a confirmed-by-inspection pattern.
- More generally, §6's framing throughout ("the repository turned out to contain... some genuinely well-built, working pieces... The decisions below are about which of those pieces survive") reads as reporting confirmed observations, but for 6.3/6.4/6.6/6.7 specifically it states intended *future* behavior as if already built or explicitly decided through a walkthrough. These four should be treated as pending design decisions, not facts about the current app.

---

## Background context (from the prior, broader audit)

For reference, the wider architectural picture established before this Section-6-focused pass:

- `CLAUDE.md` and `docs/` are untracked in git; only `.codex/CODEX_BRIEF.md` and `.codex/UPDATE_TECHSTACK.md` are tracked and describe the (matching) stack baseline.
- Stack matches docs: SvelteKit + `@sveltejs/adapter-node`, TypeScript, `pg` (no ORM), `socket.io`, `bcryptjs`, cookie sessions. No Drizzle, no Supabase.
- The live schema is a mature, iteratively-migrated four-layer rules engine (migrations 004→017), not the Container model. Migration 016 (`content_modifier_links`) was a real step toward letting Modifiers attach directly to Content, but Items/Spells/Feats remain separate table shapes and Actions remain a separate engine.
- No "Container" concept, and none of the doc's worked-example identifiers (`luck_dice`, `Vowfire`, `Soulfire`) appear anywhere in code - the model's central worked example was never implemented.
