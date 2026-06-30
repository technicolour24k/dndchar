# CLAUDE.md — D&D Character Sheet Rewrite

This file is read automatically at the start of every session. Keep it short and rule-shaped. Full reasoning, worked examples, and the "why" behind every decision below live in `docs/` — read those before doing any non-trivial work on modifiers, items, feats, effects, actions, or version history.

**Read first, in order, before starting substantial work:**
1. `docs/project-handover.md` — full project background, stack, hosting, product philosophy, and everything NOT covered by #2.
2. `docs/architecture/modifier-primacy.md` — the target data model for modifiers/items/feats/effects/actions, stated as a flat specification. This is what the system *should be* — it makes no claims about what currently exists in code.
3. `docs/architecture/modifier-primacy-status.md` — how far the actual repository currently is from #2, organized as matches / needs reshaping / missing entirely / direct conflicts. This is a snapshot, not a guarantee of currency — re-audit and regenerate it rather than trusting it blindly if it looks stale or if substantial migration work has happened since its last update.

If #2 and #3 ever seem to disagree about what the target model *should be* (as opposed to what's built), #2 wins — #3 only reports distance to the target, it never redefines the target.

---

## Before changing anything in this codebase

Check `docs/architecture/modifier-primacy-status.md` first — it should already describe how far the repo is from the spec. If it looks current, trust it rather than re-deriving it from scratch. If it looks stale (a meaningful amount of work has happened since it was last generated, or something in the repo contradicts what it claims), re-audit and regenerate it before proceeding, and say so explicitly rather than silently working from outdated assumptions. Documents describe intent or last-known state; the repo itself is always the final source of truth for what currently exists.

## Stack (confirmed — see project-handover.md for full rationale)

- SvelteKit (not plain Svelte) + TypeScript, Node runtime
- PostgreSQL via Railway (app hosting) + Neon (DB hosting)
- Plain `pg` + SQL migrations — no ORM adopted (Drizzle/Supabase were discussed, never selected; do not assume either is a dependency unless the repo proves it)
- Server actions for all writes. Socket.IO (if/when implemented) is for live-update notification and reconnects only — never the authoritative state store.
- PostgreSQL is authoritative for all state that must survive a refresh/restart. Nothing meaningful lives only in memory or only in a socket.

## Modifier-Primacy — the core rule (full detail in docs/architecture/modifier-primacy.md)

**Modifier is the only mechanical primitive.** Everything else — Item, Feat, Spell, Effect, Action, Attack — is a **Container**: a named, sourced, costed wrapper that grants one or more Modifier instances. Containers never invent their own mechanical vocabulary; they only point at Modifiers.

A Modifier states: *for [target], change [value], when [condition holds].* Targets can be derived stats, roll categories, discrete rules (e.g. crit threshold), or character resource pools (HP, actions, Soulfire, Vowfire). Modifier definitions are shared and reusable — e.g. `luck_dice` is one definition referenced by both a homebrew ring and the Lucky feat, each with different parameter values.

Firm rules:
- **Duration, lifecycle, and cost belong to the Container, never the Modifier.** A Modifier definition is timeless; how long a given grant lasts and what it costs to use are properties of the specific Container granting it.
- **Cost is a structured list, not a scalar** — `[{ pool: "action", amount: 1 }, { pool: "vowfire", amount: 1 }]` — to support multi-action costs and multiple resource pools (action economy, Soulfire, Vowfire).
- **Stacking is implied by operation type, not opted into per-modifier.** Advantage/disadvantage uses a **dice-pool mechanic**, a deliberate homebrew departure from standard 5e: net advantage sources against disadvantage sources by simple subtraction within a roll-category bucket, discard whatever cancels exactly, and roll `1 + |net|` dice — taking the highest if net is positive, the lowest if negative, or just 1 die flat if net is zero. (Example: 3 advantage + 1 disadvantage = net +2 = roll 3 dice, take highest. 2 advantage + 2 disadvantage = net 0 = flat, no extra dice.) Resistance/vulnerability stays simple binary net cancellation per damage-type bucket for now — extending it to the same dice-pool-style pattern is wanted later but not yet designed. Flat numeric adds sum normally. Resource grants (e.g. luck dice, Vowfire charges) sum by count. A "doesn't stack with itself" flag exists for genuine exceptions only — it is not the primary mechanism.
- **A Modifier instance's source and target-of-effect are tracked independently.** Usually the same character, but not always (e.g. a menu-driven ability lets one character grant a temporary buff to a different party member).
- **A Container may grant other Containers, not only raw Modifiers.** This is how reusable named states work — e.g. the Rage class feature is a Container whose grant is one instance of a separate Container, Raging, which carries the actual Modifiers. No separate "Effect" entity type is needed for this.
- **Authoring mechanics is gated to DM/admin; applying predefined content to oneself is not.** Players may apply existing Containers (Conditions, known spells) to their own character, and may create purely descriptive, grant-free Containers (mundane inventory items). Only DM/admin may create or edit a Modifier, or attach any grant to a Container. A player-created descriptive item that later needs mechanics is replaced wholesale by a DM-authored Container, never edited in place.
- **Every resolved value must produce a source-attributed audit trail**, not just a final number — applies to AC, saves, skill checks, and damage alike, not only combat rolls.
- **Version history: quantity/presence is historical, mechanics is current.** A snapshot freezes what a character had and how much (which modifier definition, what parameter values, which source). It does NOT freeze what that modifier mechanically does — that always resolves against the live, current definition. Restoring an old snapshot is time-travel for character state, not for rules text. Version-history UI must distinguish character-state diffs (what the character did) from modifier-definition drift (what a shared definition's meaning has changed to since) — compute drift at view time, don't bake it in at save time.
- **Modifier definitions are soft-deleted only, never hard-deleted.** Any historical reference must always resolve against something live.

## Product philosophy (non-negotiable, see project-handover.md §6 for full list)

- Never D&D-Beyond-rigid. Don't block homebrew, extra spells, custom progression, or non-official content. Automate and suggest; never hard-enforce.
- Prefer simple, well-commented code over clever abstraction. This is a hobby app for a small trusted group, not a public SaaS — don't over-engineer permissions, scale, or infrastructure.
- Campaign members can view/interact with all campaign sheets. No ownership locks, claims, or approval queues unless explicitly requested later.
- Mobile-friendly, collapsible-panel UI. Paper-sheet readability first; PDF export and offline support are real but secondary goals.
- Be explicit about confirmed vs. unresolved. Never silently invent a decision that hasn't actually been made — say what's open and why.