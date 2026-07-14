D&D Character Sheet Website - Migration Handover

Purpose of this document: This captures the project context, decisions, intent, unresolved questions, and working constraints discussed outside the repository. It deliberately avoids code and reproduces the distinction between confirmed decisions, older ideas that were superseded, and things merely discussed. The new assistant should treat the repository as the source of truth for implementation details, while this document explains why those details may exist.

Scope warning: This is the fullest available record from the project discussions. Some early conversations pre-date the current rewrite and therefore describe a PHP/MySQL implementation or an exploratory architecture. They are retained because they explain the user’s priorities, but are explicitly marked where later decisions override them.

---

1. PROJECT OVERVIEW

What the project is

This is a character-management website primarily for Dungeons & Dragons 5th Edition (2014 rules). It is not meant to be a narrow, rules-locked character builder in the style of D&D Beyond. The aim is a flexible, digital replacement for paper character sheets that can cope with a large amount of homebrew, custom systems, custom articles, custom items, custom spells, custom effects, and campaign-specific mechanics.

The desired end result is a character-centric tool where a user can:

- create and maintain characters;
- use them in campaigns and parties;
- view and interact with the important parts of a character sheet digitally;
- add custom content freely, without the application refusing something merely because it violates an official D&D 5e progression limit;
- roll anything written on the sheet, including modifiers;
- let the site do useful maths, duration tracking, resource management, spell/ability scaling, and round-based automation;
- preserve character history over time rather than treating a sheet as a disposable current-state form.

The project should begin from D&D 5e (2014), but the longer-term architectural intent is that the engine does not permanently hard-code itself into 5e. Future expansion to other systems is explicitly wanted. The user described the fundamental goal as: the sheet should feel like a paper sheet, but digital; a user should be able to add anything to a character and roll for anything it says with relevant modifiers.

The application is intended for the user and a small group of friends, not a mass-market SaaS. That affects cost, scale, permissions, and the appetite for complicated commercial-platform features.

Project character and philosophy

The project is heavily homebrew-oriented. It must be able to represent:

- official-ish 5e content where useful;
- custom spells;
- custom features and traits;
- custom equipment and magical items;
- custom modifiers;
- custom effects and conditions;
- custom resources and charges;
- temporary and permanent changes;
- campaign-specific mechanics;
- pets, familiars, summons, and similar dependent entities;
- custom articles / rules content.

The point is not to force all homebrew into a tiny handful of “official” categories. The point is to give it a sensible structure so that it can be assembled, displayed, rolled, tracked, and modified consistently.

The user wants fewer places and fewer different mechanisms through which a modifier can work. The project should centralise repeatable mechanics rather than duplicating special cases across spells, items, class features, conditions, and individual character fields.

Current overall status

The project had an existing PHP/MySQL character-sheet application or prototype. In June 2026, the decision was made to rewrite it rather than carry its implementation forward mechanically. The stated instruction for the rewrite was to preserve useful behaviour and product intent, not to translate the old PHP/MySQL code line by line.

The current work is at the architectural/design and migration stage. The most recent substantive design work focused on:

- the reusable modifier/effect model;
- how items, equipment, spells, feats, and abilities should assemble lower-level pieces;
- the administration/content-editor UI for modifiers and items;
- supporting one-off actions, passive rules changes, effects, features, spell grants, and charges from an item;
- avoiding a data model that becomes a tangle when trying to represent the many hundreds of 5e effects plus homebrew.

There are UI mock-ups for the direction of modifier and item editors, but the screenshots/images themselves are not reproduced here. The conceptual layout and requirements are documented below.

There is no confirmed claim here that a complete SvelteKit rewrite already exists, or that all infrastructure is live. Railway and Neon were set up or being set up, and the user was preparing to feed a rewrite brief into Codex / an AI coding assistant. Treat the repository and deployment configuration as the factual source for whether each piece has actually been implemented.

Technology, tools, frameworks, and platforms discussed

Legacy / existing implementation context

- PHP
- MySQL
- HTML
- CSS
- JavaScript
- likely traditional shared-hosting / cPanel assumptions in the old project, though those are no longer the target architecture

Selected rewrite direction

- SvelteKit - explicitly SvelteKit, not plain Svelte
- TypeScript
- Node.js runtime
- PostgreSQL
- Railway for application hosting
- Neon for PostgreSQL hosting
- "pg" / direct PostgreSQL access with SQL migrations was preferred for simplicity and maintainability
- Socket.IO was preferred for rooms/reconnect behaviour if real-time updates are implemented
- server actions for writes
- WebSockets for live-update notifications/reconnects only, not authoritative application state

Discussed but not adopted as the selected stack

- Drizzle ORM - mentioned in an earlier general recommendation, but not confirmed as chosen
- Supabase - mentioned in an earlier general recommendation for auth/database/realtime/storage, but not selected after Railway + Neon
- Vercel, Netlify, Cloudflare, Render, DigitalOcean - discussed as possible hosts, not selected
- PWA / offline support - desired future capability, not a committed initial implementation
- normal shared PHP/cPanel hosting - specifically not considered suitable as the main hosting direction after moving to Node/SvelteKit

Hosting/cost context

The project is a hobby application for the user and a handful of friends. It does not require enterprise scale. Cost matters.

Railway and Neon were selected as the practical Node/PostgreSQL route. At the time of discussion, the user was considering a development/test database and a separate production database. The intended split was:

- one database for development/testing;
- one database for production.

It was not confirmed in the discussions whether those two databases/projects were actually created, merely that this was the planned approach and the user was checking Neon limits/branches/databases.

Do not make hosting decisions based on old vendor-plan numbers from earlier chats. Free-plan limits, billing, and instance specifications change frequently. The enduring constraint is low cost for a small hobby group, not any particular historical marketing number.

---

2. DECISIONS AND RATIONALE

This section separates firm/current decisions from older context and open trade-offs.

2.1 Rewrite rather than translate the existing PHP application

Decision

Rewrite the existing character-sheet web application into SvelteKit on Node/PostgreSQL rather than trying to preserve the PHP/MySQL implementation line by line.

Rationale

The user was open to starting again and wanted to choose the right hosting architecture rather than remain attached to the old technical stack. The product has grown beyond a static-ish PHP form site: it needs rich stateful interaction, round tracking, autosave/history, flexible homebrew content, and potentially live campaign updates.

The rewrite should preserve useful behaviour and user-facing intent, not legacy implementation accidents.

Consequences

- Do not treat old PHP structures as inherently authoritative.
- Do not create a “Svelte copy of PHP pages” merely because those pages exist.
- Do retain product behaviours that the old app got right, especially paper-sheet readability and freedom to customise content.
- The existing repo will likely contain implementation evidence which may be useful, but it should be evaluated against this newer architecture and not copied blindly.

2.2 SvelteKit, not plain Svelte

Decision

Use SvelteKit, not a plain Svelte front end.

Rationale

The app needs a full web application framework, server-side operations, routing, form actions, authentication integration, database interaction, and a natural place for real-time delivery. A pure client-only Svelte application would push too much complexity into ad hoc backend arrangements.

Consequences

- New work should use SvelteKit conventions where appropriate.
- Treat server actions / server-side writes as the standard write path.
- Avoid inventing a detached API layer unless a specific need genuinely calls for it.

2.3 Node + Railway + Neon PostgreSQL

Decision

The rewrite target is Node on Railway with Neon PostgreSQL.

Rationale

The user had already set up Railway and Neon and wanted a practical hosting path for a hobby application. PostgreSQL is a better fit for a flexible, evolving app than trying to perpetuate a traditional shared PHP/MySQL setup.

Consequences

- PostgreSQL is the selected primary datastore.
- Use database migrations.
- Do not re-propose normal shared PHP/cPanel hosting as the primary solution.
- Do not confuse the legacy MySQL context with a current requirement.

2.4 Simplicity and maintainability over clever architecture

Decision

Prefer simple, understandable, heavily commented code and data flows. Maintainability is more valuable than elegant abstraction for its own sake.

Rationale

The application is a long-running personal/community tool. It needs to remain understandable when revisited, extended for homebrew, or handed to another assistant. The user explicitly prefers simple systems.

Consequences

- Prefer plain "pg" and SQL migrations over adopting an ORM merely to look modern.
- Avoid over-engineered event sourcing, distributed systems, a rules-engine framework that cannot be understood, or a full generic no-code schema designer unless the actual need forces it.
- Add comments where the domain rules are non-obvious.
- Make complicated behaviour inspectable and testable.
- This does not mean “duplicate logic everywhere”; the modifier/effect redesign exists precisely to reduce duplication.

2.5 Database is authoritative; do not keep canonical game state only in memory

Decision

The database is the source of truth. Character and encounter state must not live only in application memory.

Rationale

The site may have multiple people viewing/using campaign sheets, connections may drop, and browser sessions/server processes can restart. Round tracking, buffs, resource usage, history, and campaign interaction must survive reconnects.

Consequences

- Any state that matters after a refresh/restart belongs in PostgreSQL.
- WebSocket connections are not the state store.
- In-memory objects may be caches or transient UI state, but not the canonical encounter/character state.
- “Next round” processing needs a persisted result or transaction, not merely a front-end decrement.

2.6 Server actions for writes; WebSockets for live update delivery only

Decision

Use server actions for writes. Use WebSockets only for real-time notifications/live updates/reconnect support.

Rationale

The app needs reliable, auditable writes that are straightforward to secure and persist. WebSockets are useful for notifying other viewers that a sheet/encounter changed, but should not become a second, opaque command channel or an in-memory authority.

Consequences

- Normal user actions should be persisted through server-side request/action handling.
- A Socket.IO room can broadcast “this campaign / character changed; reload or reconcile” after a successful write.
- Do not use sockets as the sole mechanism for applying game state.
- Do not assume a live socket must exist for the app to work.

2.7 Socket.IO preference, conditional on real-time needs

Decision

Socket.IO was preferred if/when real-time updates are implemented, particularly because it supports reconnection and rooms well.

Rationale

Campaigns and encounters may have several people looking at related sheets. Rooms map naturally to campaigns, encounters, or characters, and reconnection matters on mobile/browser networks.

Consequences

- This is a preferred tool, not proof that it is already installed in the repo.
- Realtime should be additive: useful for notification and shared visibility, not a prerequisite for ordinary save/load.
- Avoid premature real-time complexity until the user-facing shared workflow actually needs it.

2.8 Paper-sheet feel, digital advantages

Decision

The UI should retain the feel and readability of a paper character sheet, while making it digital, dynamic, and more capable.

Rationale

The user does not want a bureaucratic form-builder or a rigid, black-box character builder. Paper sheets are familiar and let a player see the important information. Digital should add calculation, interactions, rolls, tracking, history, and compact navigation without losing the “this is my character sheet” experience.

Consequences

- Character views should prioritise readable sheet-like groupings over dense admin dashboards.
- Mobile friendliness matters.
- Collapsible panels/sections are preferred.
- Keep player-facing interaction clear rather than making every sheet feel like a CMS page.
- Printable/PDF output is useful but secondary to a good digital experience.

2.9 Character-centred rather than ownership-gated

Decision

Use a simple campaign-centred access model: people create characters, use/join campaigns with them, and campaign members can view/interact with all campaign sheets. Do not make permissions, claims, locks, or strict ownership enforcement a major feature.

Rationale

The application is for a trusted small group, not a public service with adversarial users. The user explicitly rejected complicated gates and rules enforcement. A DM and group need to work on one another’s material without artificial ownership walls.

Consequences

- Users/campaigns/membership relationships still need to exist for organisation and access scope.
- “Ownership” may exist as an association or provenance record, but should not be used to make a character untouchable by other campaign members.
- Do not introduce character locks, claim workflows, approval queues, or permission hierarchies unless the user later asks for them.
- Do not build D&D Beyond-style “you cannot do that” restriction logic.

2.10 Freedom over rules enforcement

Decision

The application should help with 5e structure but never rigidly enforce every official constraint.

Rationale

The user specifically cited D&D Beyond being too rigid: a character might have extra cantrips or spells, homebrew progression, or exceptions. A level-up helper should automate common additions but manual additions/removals must always remain possible.

Consequences

- A Level-Up Wizard is a convenience tool, not the final authority.
- Do not hard-block “too many spells”, “wrong class feature”, “unofficial item”, etc.
- Validation should distinguish helpful warnings from prohibitions.
- Custom/homebrew content must be first-class enough that it does not feel like a hack.
- Data models should allow entries outside official 5e catalogues.

2.11 Start with D&D 5e (2014), keep the engine extensible

Decision

D&D 5e (2014) is the initial rules baseline. Longer term, other systems may be supported.

Rationale

The immediate project is for 5e 2014, and all current domain/UI discussions are rooted there. However, the user does not want the deepest engine concepts permanently inseparable from 5e.

Intended generic foundations

Earlier discussion framed the reusable engine around:

- blocks;
- variables;
- formulas;
- a dice roller;
- templates;
- a per-character "system_key";
- optional, template-driven system helpers.

Consequences

- Keep generic concepts such as actions, resources, modifiers, effects, formulas, templates, and rolls distinct from 5e-specific labels where reasonable.
- Do not pursue an abstract generic RPG engine so aggressively that 5e becomes painful to build. 5e is the actual first customer.
- This is a direction, not a requirement to implement multi-system support immediately.
- The current repository may reasonably be 5e-first while leaving clear seams for system templates later.

2.12 Earlier JSON-sheet / relational metadata model - historical decision with unresolved current status

Earlier decision / proposal

In December 2025, the preferred simple campaign-centric approach was:

- relational DB records for users, campaigns, membership, and ownership/associations;
- character sheet data stored as JSON;
- a rules system storing "template_json";
- new characters created by generating a character JSON document from a template;
- updates performed by decoding/mutating/re-encoding the character JSON;
- homebrew actions/items/etc. living within that character JSON.

Rationale at the time

It promised maximum flexibility for a homebrew-heavy tool, minimal schema churn, and easy “paper sheet but digital” structure. The user explicitly preferred a JSON + DB split at that time.

Later development / tension

By June 2026, the rewrite direction named a large number of core domains and insisted PostgreSQL is authoritative, but it did not explicitly state whether every sheet element remains JSON, becomes relational, or becomes hybrid. The later modifier/effect/item conversations point towards reusable libraries and relationships, which may favour more relational or hybrid structures than an entirely self-contained sheet blob.

Current handling

This is not safely resolved from the conversation alone. The new assistant should:

- inspect the actual repository/migrations for the implemented direction;
- treat “PostgreSQL is the authoritative store” as the firm current rule;
- retain the preference for flexibility and low-friction homebrew;
- not assume that an all-JSON monolith is mandatory;
- not force a fully normalised relational schema merely because it is technically tidy;
- make an explicit decision only when the actual implementation and intended sharing/reuse semantics make the trade-off clear.

This unresolved point should not be papered over. It is one of the most important architecture questions in the project.

2.13 Modifiers/effects must be reusable ingredients, not hundreds of bespoke systems

Decision

Use a small number of reusable modifier behaviours, even though the game needs to represent a very large catalogue of individual official effects and homebrew variations.

Rationale

The user estimated there may be roughly 200 effects in a particular earlier view, then clarified the practical requirement could be around 600 or more entries once comprehensively covering conditions, buffs, debuffs, spell effects, and variations. Building a one-off code path for every effect would become unmaintainable.

The goal is to be able to list individual effects appropriately while having them reuse a much smaller set of underlying mechanical behaviours.

Conceptual vocabulary adopted

The user accepted the “ingredients/cake” model:

- Modifiers and Effects are ingredients.
- Items, equipment, spells, feats, abilities (and by extension similar finished content) are the stitched-together/assembled pieces.

This is the controlling conceptual model for future content design.

Consequences

- Do not make items/spells/features each invent their own independent modifier syntax.
- A reusable modifier should represent a small mechanical change or rule change.
- An effect can package or apply a set of modifiers and related behaviour, particularly temporary/ongoing behaviour.
- Finished content should grant, reference, configure, or invoke those ingredients.

2.14 Modifier vs Effect distinction

Direction

The exact final schema was not pinned down in prose, but the intended distinction is:

Modifier

- a reusable atomic rule change;
- examples of the kind of thing: an AC increase, movement increase/reduction, damage bonus, advantage/disadvantage rule, stat adjustment, resistance/immunity/vulnerability, alteration to a roll or derived value;
- should have a limited number of reusable behaviours.

Effect

- a named/applicable package, usually temporary or contextual;
- may contain multiple modifiers;
- may represent a condition, buff, debuff, aura, ongoing status, or similar;
- may have duration and round-related behaviour;
- can be granted by an item, spell, feature, etc.

The term “Rule Hooks (Advanced)” was proposed for more exceptional/complex behaviour that cannot be expressed by ordinary modifier configurations. This is a UI and modelling escape hatch, not an excuse to encode every normal 5e effect as a custom script.

Examples discussed

- Rage: damage bonus / related changes.
- Haste: movement-speed change and other effects.
- Shield: temporary AC increase for a turn.
- permanent Haste from an item.
- Aura of Terror from an item.
- conditions such as blind/poisoned.
- debuffs such as movement reduction or disadvantage.
- buffs such as movement increase, advantage, and potentially things like Sneak Attack-related changes.

Important constraint

The user wants the individual effects available/listable, but does not want hundreds of independently implemented mechanics. A big effect library and a small modifier-behaviour library should coexist.

2.15 Items/equipment/spells are assembly points

Decision

Items/equipment/spells are “stitch it all together” pieces. They can grant or contain:

- one-off actions;
- passive modifiers;
- ongoing or granted effects;
- granted features;
- spell grants/access;
- resources/charges.

Rationale

A magical item may not only give a static numerical bonus. It may:

- change a stat or rule continuously;
- grant permanent Haste;
- project an Aura of Terror;
- let the user cast a spell;
- have a bespoke heal/damage action;
- consume or track charges;
- grant a feature.

Putting each of these into separate bespoke item code would make content editing impossible to scale.

Consequences

- Item editing needs composition, not one massive free-text description plus a few numerical fields.
- An item should be able to reference existing reusable definitions and configure them.
- Item-level grants are the correct place for item-granted spell access; this was explicitly recognised as an “item-level include” need.
- Do not force spell grants to be copied into a character’s permanent spell list without preserving their source/context.

2.16 Item-granted spells are required but design details remain open

Decision

Items need to be able to grant spell access.

Rationale

The user explicitly identified this as a real requirement after agreeing that items are assembly points.

What remains unresolved

The conversation did not settle:

- whether a grant means “known”, “prepared”, “always available”, “castable only from this item”, or several of these;
- how spell slot use is represented;
- whether a spell uses the wielder’s casting stat, fixed item DC/attack bonus, a specified class list, or custom configuration;
- whether it has charges, frequency limits, or only grants the spell’s text/action;
- what happens when the item is removed;
- how duplicate grants from different sources behave;
- whether the item can provide specific upcast/casting rules.

A new assistant should not assume a simplistic Boolean "grants_spell" covers the actual need. The conceptual requirement is firm; its detailed data contract needs deliberate design.

2.17 One-off actions are a distinct requirement

Decision

Items must support one-off actions directly, not only passive modifiers/effects.

Examples explicitly given

- “Heal 2d4+3”
- “Deal 1d8 damage”

Rationale

Many item abilities are active and do not cleanly map to a passive modifier or a named ongoing condition/effect. The UI must let content authors add them.

Consequences

- Actions need to be first-class entities/structures, whether embedded, reusable, or both.
- An action should support a visible name and a resolvable roll/effect, rather than being only descriptive text.
- The new assistant should inspect existing structures before deciding whether actions are generic records, JSON objects, or a hybrid.
- This needs to work for spells, items, features, and perhaps attacks; do not create incompatible action models for each source type.

2.18 Modifier editor UI direction

Direction

A previously generated/editor mock-up was reconsidered after the data-model discussion. The agreed direction was to redesign it so that modifiers are central.

Intended workflow/layout

Keep a three-column workflow:

1. Library - find existing content/definitions.
2. Editor - create or edit the selected modifier/effect/etc.
3. Attach/configure - attach an existing component to the relevant content and configure source-specific parameters.

Intended top-level tabs

- Modifiers
- Effects
- Rule Hooks (Advanced)

The earlier label “Rule Change” should become “Modifier”.

Important UI behaviour

The right-hand/attachment side should prefer attaching an existing modifier first, rather than encouraging duplicate definitions. Reuse is a core product goal.

Consequences

- This is not merely a character-sheet UI; it is content administration tooling for homebrew.
- Avoid a UI that makes users recreate the same “+1 AC while worn” logic in every item.
- Avoid making the advanced rules-hook path the default. It should remain visibly advanced and reserved for truly exceptional cases.

2.19 Item editor UI direction

Decision / requirement

Items need their own separate UI mock-up/page rather than being merged conceptually into the modifier editor. The user explicitly asked for the modifier and item mock-ups to be separate.

Required item-editor sections

The item/equipment editor should support assembling:

- Passive Modifiers
- Granted Effects
- Granted Features
- Granted Spells
- Actions
- Resources / Charges

Rationale

An item is a composed finished object. It should not visually look like a modifier definition, even though it can reuse modifiers.

Consequences

- Keep the distinction between defining ingredients and assembling finished content obvious in the UI.
- An item author should be able to add/edit all required categories without jumping through unrelated editor modes.
- The content author needs enough context to see what each attachment will do, but not be buried in implementation detail.

2.20 Effects catalogue and free data source question - not resolved

Problem

The user needs to build database/content entries for all relevant effects. The scale felt “manic”: potentially roughly 600 official or quasi-official effects when including conditions, buffs, debuffs, spells, and varied effects.

Question raised

Whether there are free resources, such as SRD-derived material, downloadable in JSON to seed the effects catalogue.

Current status

No final resource import plan is recorded here. This remains open.

Consequences

- Do not assume a legal, complete, free JSON source exists for all official 5e 2014 material.
- SRD licensing/content coverage versus non-SRD official material must be considered separately.
- The project needs a way to create and maintain a comprehensive effect catalogue, but the data-source/licensing/import workflow has not been finalised.
- Avoid automatically importing dubious datasets without checking provenance and content rights.

2.21 Timing is not a priority now; rounds are the internal practical unit

Decision

Timing precision is not important “right now”. Store duration in rounds internally and display appropriate equivalents (rounds/minutes/hours) as needed.

Rationale

The immediate use case is tabletop gameplay and round progression, not a high-fidelity real-time simulation. Rounds are enough for buff timers, damage-over-time, healing-over-time, and encounters.

Consequences

- Do not build a real-time scheduler or clock-driven rules system at this stage.
- Design durations so they can be represented as rounds now and presented in more player-friendly terms.
- Do not tie temporary effects to client timers that can drift, pause, or disappear on refresh.
- Future display conversions should not force an internal redesign.

2.22 “Next round” button for encounter automation

Decision

The user plans a “Next round” button which automatically triggers:

- damage-over-time damage;
- damage-over-time healing;
- buff duration timers;
- related round-based automatic processing.

Rationale

This is a practical GM/table workflow. It replaces manually remembering every ongoing effect rather than attempting real-time automation.

Consequences

- Round tracking/encounter state is a core domain, not a cosmetic counter.
- The command needs to be persistent, deterministic, and able to survive refresh/reconnect.
- It will eventually need careful ordering, logging/history, and possibly a way to review or undo/correct automatic outcomes.
- It should not silently destroy player choices; the exact interaction/confirmation model has not been decided.
- This remains a feature requirement, not evidence that it is already built.

2.23 Attacks and spellcasting presentation / cast workflow

Intended visible fields

For attacks/spells/abilities, the user was considering:

- Name
- Range/Target
- Effect
- Duration (in rounds)
- Notes

Cast interaction requirement

A “Cast” button should help calculate spell level and effectiveness. The stated example:

- cast Cure Wounds;
- prompt for spell-slot level, e.g. 1 / 2 / 3 / 4;
- as the selected level changes, show the appropriate roll/effect, such as healing "[1,2,3,4]d8" with the relevant modifier as appropriate.

Rationale

The sheet should be useful at the table rather than merely a static reference list.

Consequences

- Spells/actions need enough structured data to calculate scaling.
- The UI should expose the calculation rather than requiring the user to mentally reconstruct it.
- Do not assume all casting has standard 5e slot progression; homebrew and item-granted spells may need custom configurations.
- This is one reason items/spells/actions should use common action mechanics where possible.

2.24 Version history and autosave

Decision / strong product preference

The user strongly liked a generated-character-sheet concept’s inclusion of autosaving and Version History. This was described as an “absolutely amazing idea”.

The requirement is not merely a few undo steps:

- version history should be available for every save, within reasonable storage limits;
- the UI may display only the last three entries by default;
- clicking “Version History” should expose the entire collection;
- history should cover the sheet from “first born, to final death”.

Rationale

Characters are long-lived artefacts. Their changes matter: level-ups, injuries, death, homebrew item changes, campaign events, and general sheet evolution. A few transient undos would not meet the requirement.

Consequences

- Autosave and history are first-class product requirements.
- Avoid an implementation that only stores the latest state or only keeps a tiny fixed window of snapshots.
- “Every save” needs an operational interpretation: ordinary reliable saves must produce recoverable history, not just manually labelled checkpoints.
- Storage/diff/snapshot strategy has not been finalised.
- A history UI should eventually allow the user to inspect old versions, likely restore or compare them, but restore/compare requirements were not explicitly finalised.
- This should not be casually dropped as scope creep; the user explicitly values it.

2.25 Parties and campaigns

Decision / requirement

The system is character-focused but supports parties. Characters should be able to move in/out of parties. Campaigns should group relevant characters and users.

Rationale

A character belongs to a larger tabletop context, but the character sheet remains the central entity.

Consequences

- Do not make the party a permanent ownership container.
- The data model needs campaign membership and party composition in some form.
- Campaign members can interact with all campaign sheets under the trust-based model.
- Exact distinctions between campaign, party, encounter, and session have not been fully designed in the recorded discussions.

2.26 Pets, summons, and familiars

Requirement

The rewrite’s core domains were explicitly said to include pets, summons, and familiars.

Rationale

They are meaningful character-adjacent game entities and should not be forced into a plain notes field.

Consequences

- They likely need links to a character/campaign and may have their own stats/actions/effects/resources.
- Their exact data model, inheritance model, lifecycle, and display are not finalised in the discussions.
- Do not omit them from higher-level domain planning even if they are not part of the first UI milestone.

2.27 Level-Up Wizard: assist, never police

Decision

A Level-Up Wizard is a core desired feature. It should automate expected additions such as features and spells, but manual additions/removals remain allowed.

Rationale

The user wants fast, helpful character progression but not D&D Beyond-style rigidity. Homebrew characters may get extra spells/cantrips/features or different progression.

Consequences

- The wizard should add suggested/default content based on a chosen template/class/subclass/etc.
- It should not become a hard validation gate.
- User edits remain authoritative.
- Exact level-up content sources, official data import, and UI workflow are not recorded as final.

2.28 Dice roller is core, but must be broad enough for homebrew

Decision / requirement

A dice roller is a core feature.

Rationale

The sheet’s purpose includes rolling anything stated on it with modifiers, not just displaying numbers.

Consequences

- Formulas, variables, action rolls, attacks, healing, damage, and perhaps resource effects must be representable enough for the dice roller.
- Do not limit it only to official 5e d20 attacks/saves.
- The exact dice-expression language and security/evaluation approach have not been finalised.
- It needs to support homebrew formulas without allowing arbitrary unsafe execution.

2.29 Mobile optimisation and collapsible layout

Decision

Mobile optimisation is a core expected feature. Character sections should be organised into collapsible panels.

Rationale

The app is likely to be used at a table, potentially from phones. A full traditional paper sheet does not fit comfortably on a narrow display.

Consequences

- Mobile is not an afterthought.
- Information hierarchy and progressive disclosure matter.
- Do not depend exclusively on hover behaviour or desktop-only dense tables.
- Collapsible sections are a preferred UI pattern, although individual implementation details are not prescribed.

2.30 PDF export is useful but secondary

Decision

Export as PDF is an expected core feature, but printing is secondary to the digital sheet experience.

Rationale

A printable backup/reference is useful; however, the project should not contort its main UI into a printable static page at the expense of digital usability.

Consequences

- Do not let print layout drive all character-sheet architecture.
- PDF export should be planned, but not used as a reason to avoid dynamic/collapsible/mobile interaction.
- No renderer/library/format strategy has been decided in the recorded history.

2.31 Import/export JSON, session logs, offline mode are future features

Status

These were listed as future rather than core initial requirements:

- import/export as JSON;
- session log tracker;
- offline-friendly capability.

Consequences

- Do not claim they are implemented unless present in the repo.
- Keep data/export design clean enough that JSON export remains feasible.
- Offline/PWA work should not be allowed to derail the core online product until needed.
- Session logging may later intersect with version history and encounter rounds, but no final integration has been decided.

2.32 Map drawing canvas with version history - exploratory, not committed

Discussion

The user asked whether the site could embed a drawing canvas with a woodland/battle map underneath, allowing people to draw on it and preserve version history.

Status

This was an exploration of feasibility. No selected library, schema, UI design, or implementation plan is recorded.

Consequences

- Treat it as a possible future feature, not a current architectural commitment.
- It reinforces the broader value placed on history/versioning.
- Do not add it automatically simply because an existing character-sheet product needs a map. It is separate scope.

2.33 Avoid normal shared PHP/cPanel hosting as the new default

Decision

After considering the growing needs of the application, normal shared PHP/cPanel hosting was not considered the best primary platform for this product.

Rationale

Node/SvelteKit, reliable persistence, real-time updates, and application behaviour were seen as a better fit for Railway/Neon-style hosting.

Consequences

- Do not recommend returning to PHP-only shared hosting as the obvious path.
- The initial stack was PHP/MySQL; the product decision moved on.

2.34 Earlier alternative tech suggestions were not final decisions

Context

Before Railway + Neon were chosen, an earlier recommendation mentioned:

- SvelteKit + TypeScript + PostgreSQL + Drizzle;
- Supabase for auth/database/realtime/storage;
- potentially Vercel/Netlify/Cloudflare or Render/Railway/DigitalOcean.

Current position

These are options that were discussed, not necessarily installed/adopted. The actual selected direction is Railway + Neon, plain PostgreSQL access/migrations, and Socket.IO if real-time is needed.

Consequence

Do not reintroduce Drizzle or Supabase as though they are existing project dependencies unless the repo proves they are. A prior assistant recommendation is not a user decision.

2.35 Fundamental system redesign conversation - separate, not the character-site’s immediate rules baseline

Context

In March 2025 there was a discussion of a “true redesign” of a game system rather than a 5e variant, including an exploratory 2d6 + stat resolution and outcome tiers.

Important boundary

This was not a decision to replace D&D 5e (2014) as the character-site’s starting system. The character management site still starts with 5e (2014) and may later support other systems.

Consequence

Do not accidentally build the website around the experimental 2d6 system. It is relevant only as evidence that the user may want broader system support eventually and dislikes unnecessarily rigid 5e assumptions.

---

3. DATA STRUCTURES / SCHEMAS (CONCEPTUAL ONLY)

The actual schema belongs in the repository. This section describes the intended domain shape, relationships, and semantics.

3.1 Users

Users are the human participants in the system.

They are relevant for:

- login/authentication;
- campaign membership;
- creating/managing characters;
- shared access to campaign sheets;
- possibly recording who made a change for history/audit purposes.

Important permission philosophy:

- users are not expected to be isolated owners of locked character records;
- campaign members should be able to view/interact with all campaign sheets;
- user/character association can exist without becoming a hard permission barrier.

No final authentication provider/model was selected in the recorded discussion.

3.2 Campaigns

A campaign is the trusted group/workspace containing related characters, users, parties, encounters, and likely campaign-specific homebrew content.

Likely conceptual relationships:

- a campaign has many members/users;
- a campaign has many characters available within it;
- a campaign may have many parties;
- a campaign may have many encounters;
- a campaign may own or reference campaign-specific content/article definitions.

The exact distinction between globally reusable homebrew and campaign-scoped homebrew is not finalised. The project needs both flexibility and reuse.

3.3 Campaign membership

This represents a user’s participation in a campaign.

Its purpose is organisation and shared access scope, not a complex hierarchy of permissions.

Important constraint:

- all campaign members should be able to view/interact with all campaign sheets;
- do not infer roles/locks/claims that were not requested.

There may still be useful distinctions such as creator/GM/player in the UI later, but they were not established as an access-control requirement.

3.4 Parties

A party is a grouping of characters within a campaign. Characters should be able to move into and out of a party.

The user described the product as character-focused, with party support-not party-first.

Likely conceptual relationships:

- a party belongs to a campaign;
- a party has many character memberships;
- a character may move between parties over time;
- whether a character can be in several active parties at once was not settled.

Avoid treating a party as an immutable character container.

3.5 Characters

A character is the central sheet entity.

A character needs to support, at minimum:

- basic identity and presentation;
- an applicable system/rules template, initially D&D 5e 2014;
- stats;
- skills;
- saving throws;
- attacks;
- spells;
- inventory/items;
- features/traits;
- resources;
- conditions;
- temporary effects;
- campaign association;
- party association(s);
- version history;
- pets/summons/familiars;
- potentially character-specific homebrew.

The generic-system direction suggests a character should carry a "system_key" or equivalent identifying the rules framework/template. A template can generate an initial sheet structure, while the individual character remains freely editable.

The exact storage granularity is unresolved:

- earlier plan: a substantial character JSON document generated from "template_json";
- newer plan: PostgreSQL authoritative with reusable relational content domains;
- likely eventual direction may be hybrid, but this must be decided from the actual implementation rather than assumed.

3.6 System templates / system key / template JSON

The intended future-proofing mechanism is a system-aware template layer:

- "system_key" identifies the rules system used by a character;
- a system template can define the initial sheet’s structure/expected data;
- helpers are optional and template-driven;
- generic engine concepts should serve different systems later.

The character site’s actual initial system remains D&D 5e 2014.

The template should assist creation and presentation; it should not make the sheet rigid or prohibit manual homebrew changes.

3.7 Stats, skills, and saving throws

These are explicitly named core domains for the rewrite.

Conceptually:

- stats are primary character values;
- skills and saves derive from or reference relevant stats/modifiers/proficiencies;
- custom modifiers and effects may change outcomes temporarily or permanently;
- rolls should be able to read relevant values and modifier rules.

No exact 5e formula/schema or custom-stat representation was finalised in this record. The generic-system objective argues against embedding every calculation only in UI code.

3.8 Actions, attacks, spells, and castable abilities

Actions are conceptually broader than attacks:

- weapon attacks;
- spell casts;
- item activations;
- feature/trait actions;
- healing actions;
- damage actions;
- possibly utility rolls or actions with no dice.

A finished content object may grant one or more actions. Actions should be able to drive the dice roller and display enough information for the player/table:

- name;
- range/target;
- effect;
- duration;
- notes;
- dice/formula or other outcome logic;
- scaling configuration where relevant;
- resource/charge/slot implications where relevant.

The explicit examples “Heal 2d4+3” and “Deal 1d8 damage” make clear that actions need straightforward homebrew-friendly formula/effect support.

A spell’s Cast interaction may prompt for cast level and dynamically calculate scaled output.

3.9 Spells

Spells are a type of finished content/action source. They can:

- supply a castable action;
- have range/target/effect/duration/notes;
- potentially apply effects;
- potentially grant modifiers;
- consume a slot/resource;
- scale with casting level;
- be granted by an item.

Spell grants need source-aware semantics. An item-granted spell should retain that it comes from the item, and may need details around charges, DC, casting stat, availability, slots, and removal.

The model must not assume all spells are official or follow ordinary prepared/known limits.

3.10 Items and equipment

Items/equipment are finished/composed content. They can include or grant:

- passive modifiers;
- granted effects;
- granted features;
- granted spells;
- actions;
- resources/charges.

The item is therefore a composition root rather than a narrow inventory row.

Items may be:

- inventory entries;
- equipment/worn/active entities;
- reusable definitions/templates;
- character-specific copies;
- campaign homebrew;
- permanent/temporary sources.

The exact split between reusable item definition and a character-owned item instance was not explicitly designed, but it is likely necessary once individual charges, attunement, notes, damage, or custom configuration exist. This is an area for the repo/new implementation to clarify.

3.11 Features and traits

Features/traits are explicitly named core domains and are another type of finished content/source.

They may:

- provide passive modifiers;
- grant effects;
- provide actions;
- grant spells;
- supply resources;
- have narrative text/notes.

They should use the same compositional machinery as items and spells wherever practical, rather than recreate it.

3.12 Modifiers

Modifiers are reusable atomic mechanical pieces. They should represent limited/repeatable forms of rule changes rather than entire named conditions or items.

Potential conceptual fields/behaviours, without prescribing schema:

- what target/property/roll they affect;
- the mode of change: add, subtract, set, multiply, grant advantage/disadvantage, resistance, etc.;
- a numeric/value/formula payload where appropriate;
- applicability/context rules;
- source metadata when attached;
- stacking/priority semantics where required.

The important product objective is fewer reusable behaviours, not a separate hard-coded class for every official effect.

A modifier library should permit reuse across multiple items/spells/features/effects.

3.13 Effects and conditions

Effects are named packages or applied instances that may include:

- one or more modifiers;
- temporary/permanent duration;
- round-based ticking;
- damage-over-time/healing-over-time;
- condition labels;
- activation/deactivation context;
- source information;
- potentially advanced behaviour via rule hooks.

Conditions are likely a kind of effect or a category/tag of effect rather than a wholly separate custom mechanics universe. The earlier discussion categorised broad content as conditions, debuffs, and buffs, but exact taxonomy is not final.

Effects must cover both official-style statuses and homebrew:

- Blind/poisoned-like conditions;
- movement penalties;
- advantage/disadvantage;
- Haste-like buffs;
- Shield-like short duration bonuses;
- aura-style effects;
- permanent effects from items.

The actual effect catalogue/import workflow is unresolved.

3.14 Rule Hooks (Advanced)

Rule Hooks are a conceptual advanced mechanism for exceptional logic not expressible through ordinary modifiers/effects.

They were proposed as a third tab alongside Modifiers and Effects.

Rules:

- keep them advanced;
- do not use them as a default escape route;
- normal mechanics should stay in reusable modifier behaviours;
- their exact execution model, such as data-driven clauses, scripts, or callbacks, was not decided.

This is likely one of the trickiest future technical design areas because it needs flexibility without unsafe arbitrary code or unmaintainable special cases.

3.15 Resources and charges

Resources are explicitly expected on characters and in item editor composition. They represent finite/use-tracked values such as:

- item charges;
- class/feature uses;
- spell slots;
- custom homebrew currencies/pools;
- possibly temporary counters.

Resources may be granted by items/features/spells and consumed by actions. Their exact reset/recharge rules and schema were not finalised.

3.16 Conditions and temporary effects

Conditions and temporary effects are core domains. They need:

- application/removal;
- source context;
- duration/round tracking;
- possibly tick behaviour;
- consequences expressed via modifiers/effects;
- visibility on the sheet/encounter;
- persistence in the database.

This is tied directly to the “Next round” feature. Effects should not depend on a browser timer to expire.

3.17 Encounters and round tracking

Encounters and round tracking are explicit core domains.

An encounter likely needs:

- participants, including characters and perhaps NPCs/creatures;
- current round;
- current turn/order if initiative is included;
- active effects;
- automated round processing;
- persistent history/logging of progression.

The only definite interaction requirement currently recorded is a “Next round” button that triggers DOT damage, DOT healing, and buff-duration timers. Initiative order, combatant model, undo, log detail, and turn automation were not fully specified.

3.18 Pets, summons, familiars

These are character-adjacent entities and should not be lost in generic notes. They may need:

- a parent/owner character;
- their own stats/actions/resources/effects;
- campaign/encounter participation;
- lifecycle rules such as temporary summons versus permanent companions.

No final architecture is recorded. They should be included in domain planning but not falsely presented as already implemented.

3.19 Version history / snapshots

Version history is required for all meaningful saves.

Conceptually it needs:

- a link to the versioned entity, at least characters;
- saved state or reconstructable change;
- creation time;
- possibly actor/source;
- a way to list recent versions and browse all versions;
- eventual recovery/restore/compare capabilities if implemented.

The user’s key requirement is retention and visibility from creation to character death, not merely a small undo stack.

Whether history should use complete snapshots, diffs, event records, or a hybrid is not decided. Given the simplicity preference and hobby scale, a simple reliable approach is likely preferable, but that is an implementation decision for the new assistant/repo.

3.20 Articles and custom content

The project is intended to encompass a huge array of homebrew/custom systems and articles. Articles/rule content should be considered part of the broader content ecosystem.

The recorded discussions do not establish a complete article schema, publication workflow, visibility model, or relationship to campaigns. This is a known content-area requirement with no settled technical design.

3.21 Drawing maps / annotations, future

The exploratory drawing-canvas idea implies future data for:

- base map/background;
- drawing strokes or document state;
- versions/history;
- campaign/session context;
- collaborative access.

Nothing more is settled. Do not mix this into character-sheet data prematurely.

---

4. OPEN QUESTIONS AND UNRESOLVED ITEMS

This section is intentionally explicit. These are not omissions to “fix” silently; many require a product decision.

4.1 How much of a character sheet is JSON versus relational PostgreSQL data?

This is the largest unresolved architecture question.

Historical preference:

- DB holds user/campaign/membership/ownership metadata;
- a character sheet is a flexible JSON document generated from a template;
- homebrew lives inside that JSON.

Newer rewrite direction:

- PostgreSQL is the authoritative store;
- named domains include characters, stats, skills, saves, spells, inventory/items, features, resources, conditions, temporary effects, encounters, rounds, pets/summons/familiars;
- reusable modifiers/effects/items imply cross-reference and library reuse.

Not settled:

- all sheet data inside a JSON payload;
- entirely normalised relational records;
- a deliberate hybrid with relational top-level/relationships and JSON/configuration for flexible homebrew.

The migration assistant must inspect existing work before changing this. A purely philosophical rewrite either way would be risky. The correct answer should preserve:

- flexibility;
- homebrew freedom;
- version history practicality;
- queryability where sharing/reuse/encounters need it;
- simple maintainability.

4.2 Exact modifier vocabulary and stacking rules

The project wants a small catalogue of reusable modifier behaviours, but the full list is not finalised.

Open questions include:

- exactly which operations are supported initially;
- how simultaneous modifiers stack;
- priority/order when values are set versus added versus multiplied;
- how multiple advantage/disadvantage sources combine;
- whether rules should model 5e’s exact special cases or a general applicability system;
- whether a modifier can target arbitrary named/custom variables;
- how to show a player why a calculated value has changed;
- how to deal with exceptions without bloating Rule Hooks.

This is a major design task. The goal is clear; the precise language is not.

4.3 Effect taxonomy and source catalogue

Open:

- whether conditions are a subtype of effect, tag/category, or separate linked entity;
- how buffs/debuffs/conditions are classified in the UI;
- whether official conditions get bespoke display affordances;
- which effects are seeded from SRD/legal data;
- how non-SRD official effects are added/maintained;
- how homebrew effects are named, versioned, and reused.

The user asked for comprehensive listings/data but no final catalogue/import pipeline is recorded.

4.4 Rule Hooks implementation and safety

Rule Hooks are only conceptually named “Advanced”.

Open:

- whether they are data-driven composable rules;
- whether they invoke predefined server-side hooks;
- whether custom scripts are allowed at all;
- how they are made safe;
- how they interact with history/replay/recalculation;
- how they are prevented from becoming the default path for normal content.

This needs cautious design. The simplicity preference argues against an arbitrary scripting language being introduced casually.

4.5 Spell grants from items

The requirement is definite; the exact behaviour is not.

Need decisions on:

- known vs prepared vs always available vs item-only access;
- spell slot vs charge use;
- source-specific DC/spell attack/casting stat;
- item removal;
- duplicate grants;
- at-will / per-rest / per-day / charge-limited rules;
- upcasting and custom scaling;
- whether item spells appear alongside normal spells or in a separate item action list.

This should be designed before building a database/UI that can only represent one narrow case.

4.6 Generic action model

The application needs actions for spells, weapon attacks, item abilities, feature abilities, healing/damage, and likely general checks. The intended commonality is clear, but the final action contract is not.

Open:

- how formulae are stored/evaluated;
- targeting;
- range;
- saving throws;
- attack rolls;
- damage/healing multiple components;
- scaling;
- effects applied on success/failure;
- resource costs;
- choice prompts;
- display versus execution;
- logging and history.

The user’s examples require at least dice formulas and scaling prompts, but not a fully specified automation engine.

4.7 “Next round” ordering, logs, confirmations, undo

The user wants automatic DOT damage/healing and duration ticks.

Open:

- exact event order;
- whether effects tick at start/end of turn, start/end of round, or configurable;
- how to avoid double-processing if a request retries;
- how to handle choice-dependent/conditional effects;
- how users see what happened;
- whether automatic results are confirmed before saving;
- whether Next Round supports undo/reversal;
- how it works with initiative/turn order, which was not fully specified.

This is tricky because a simple button can mutate many entities and therefore intersects with persistence, history, auditability, and shared updates.

4.8 Version-history storage and restoration design

The requirement is robust history, not the specific mechanism.

Open:

- snapshot vs diff vs event-sourced storage;
- how often autosave creates a version;
- how to prevent noisy excessive snapshots without violating “every save” spirit;
- whether restoring creates a new version rather than deleting history;
- comparison UI;
- retention/performance;
- whether version history extends only to characters or also content definitions/maps/encounters.

The user is positive about comprehensive history; do not reduce it to only three records. Three was merely a possible default display count.

4.9 Autosave semantics and conflict handling

Autosaving is wanted, but no precise workflow is decided.

Open:

- debounce timing;
- manual save visibility;
- errors/offline behaviour;
- multiple editors;
- conflict resolution;
- whether each autosave creates a history record;
- temporary edit drafts versus saved versions.

This becomes especially important if campaign members can all interact with sheets.

4.10 Real-time collaboration scope

The project wants Socket.IO available for live update notifications/reconnection; it does not yet require Google-Docs-style concurrent editing.

Open:

- what updates should be broadcast;
- whether clients reload whole sheet data or apply patches;
- presence indicators;
- concurrent edit/conflict strategy;
- room naming/scope;
- whether encounters have stronger real-time needs than sheets.

The firm constraint is that persistence remains server/database driven.

4.11 Authentication and account flows

Users are part of the domain, but the recorded discussions do not settle:

- auth provider;
- password/email flow;
- invitations;
- account recovery;
- user/profile management;
- guest access;
- campaign join process.

Do not invent a restrictive access system based on normal SaaS assumptions. The trusted-group model should guide choices.

4.12 Campaign/homebrew library scoping

Open:

- which modifiers/effects/items/spells/features are global reusable library entries;
- which are campaign-specific;
- which are character-private copies;
- how an existing reusable definition is copied versus referenced;
- what happens when a definition changes after being attached to a character;
- versioning/pinning of homebrew content.

This is particularly important because the project values version history and reusable ingredients. Changes to a shared “effect definition” should not unexpectedly rewrite historical character states without a clear policy.

4.13 Item definition versus item instance

Items are composition roots, but there is no explicit final model for:

- reusable item templates;
- a character-owned item instance;
- individual charge state;
- bespoke notes/damage/attunement;
- duplicate copies;
- whether editing an instance changes the library definition or only that copy.

This needs an intentional answer to avoid confusing library/content editing with a player’s actual inventory.

4.14 Resources and reset/recharge rules

Resources/charges are required, but:

- rest/reset cadence;
- manual reset;
- recharge rolls;
- source-specific pools;
- sharing a resource between actions;
- UI display;
- history/round interactions

are not finalised.

4.15 Pets/summons/familiars data model and UI

These entities are in scope but not designed.

Open:

- whether they are full character-like sheets;
- how temporary summons are created/removed;
- whether they consume actions/resources from their owner;
- encounter integration;
- which companion types are templates vs instances.

4.16 PDF export implementation

PDF export is desired but no:

- rendering engine;
- visual template strategy;
- page-break behaviour;
- export scope;
- print CSS approach

has been selected.

It is secondary to the digital experience and should not dictate early UI architecture.

4.17 JSON import/export design

Future feature. It has no settled:

- format/versioning;
- import validation;
- sharing scope;
- conflict policy;
- handling of referenced library content;
- whether it is character-only or campaign/content-inclusive.

The old JSON-sheet preference means it may eventually be natural, but that is not an implementation mandate.

4.18 Offline/PWA support

Future feature. No implementation decision, caching policy, conflict model, or service-worker plan is recorded.

It should not block core app progress.

4.19 Session log tracker

Future feature. No functional specification is recorded. It may later integrate with:

- character versions;
- encounter events;
- map annotations;
- campaign notes.

It is not currently defined enough to implement.

4.20 Map drawing/annotation feature

Exploratory only. Needs a fresh design before implementation:

- rendering/canvas library;
- storage representation;
- collaboration;
- versioning;
- map assets;
- permission/group workflow.

4.21 Content/articles subsystem

The project aims to support a huge array of homebrew/custom systems and articles, but the content-management and publishing rules are not yet specified:

- article structure;
- edit/view permissions;
- campaign versus global visibility;
- versioning;
- links from article content to items/spells/effects;
- search/navigation.

4.22 Existing UI mock-ups need implementation interpretation

There are mock-up images from discussions, but their exact layout/styling details are not present in this handover. The functional direction is:

- paper-sheet readability;
- mobile-friendly collapsible panels;
- separate Modifier and Item editor experiences;
- three-column library/editor/attach workflow for content work;
- explicit item assembly sections.

The new assistant should inspect any image assets/design notes in the repo or ask the user for those screenshots if exact pixel/layout fidelity matters. Do not infer specific colours, spacing, or visual style from this text alone.

4.23 Known bugs

No concrete current code bugs were described in the recorded project discussions.

The known risk areas, not confirmed bugs, are:

- accidental loss of state if real-time/in-memory design is used;
- over-rigid rules enforcement;
- over-normalisation or overuse of JSON without a deliberate hybrid decision;
- duplicated modifiers/effects instead of reuse;
- version history being reduced to a tiny undo list;
- item spell grants represented too narrowly;
- round processing double-applying effects or becoming untraceable;
- making mobile/print feel like afterthoughts.

---

5. NEXT STEPS

No single day-by-day implementation plan was formally finalised. The priorities below are reconstructed from the most recent and strongest design discussions, with the key caveat that the repository may already have completed some of them.

Priority 1 - Inspect the existing rewrite state before proposing changes

The new assistant should first inspect:

- actual SvelteKit/Node setup;
- PostgreSQL migrations/schema;
- Railway/Neon configuration;
- whether "pg", Drizzle, another ORM, or another setup is actually present;
- authentication approach;
- current character storage approach: JSON, relational, or hybrid;
- any existing modifier/effect/item/action code;
- existing UI/design assets and mock-ups;
- version history/autosave implementation status;
- realtime/socket setup status.

The user explicitly wants a handover because the new assistant will have direct codebase access. The assistant must not assume this document supersedes code on implementation facts.

Priority 2 - Confirm the character-sheet storage boundary

Before building much more domain functionality, establish and document:

- what is relational;
- what is flexible JSON/configuration;
- how character templates create sheets;
- how reusable library content references are represented;
- how snapshots/version history work with that choice.

This is the largest unresolved architecture decision and affects modifiers, actions, items, campaigns, history, and import/export.

The answer should be simple enough to maintain and free enough for homebrew. It should not be selected solely because it is fashionable.

Priority 3 - Formalise the modifier/effect/action vocabulary

Build a short, explicit domain specification before implementing a massive effect catalogue:

- Modifier: atomic mechanics and allowed operations.
- Effect: applied/package-level status, duration, modifiers, ticks.
- Condition: effect classification or subtype decision.
- Rule Hook: constrained advanced escape hatch.
- Action: reusable executable/displayable ability with formula/effect/cost/scaling.
- Source/Grant: how items/spells/features attach these pieces.

The purpose is to prevent a different bespoke model being invented for every content type.

Priority 4 - Design item composition and spell grants properly

The next piece of the recent discussion was the item UI/data model.

Must support an item having:

- passive modifiers;
- granted effects;
- granted features;
- granted spells;
- actions;
- resources/charges.

Resolve item spell grant semantics before hard-coding an insufficient version.

Decide definition-versus-instance handling if not already present, especially for charges and character-specific state.

Priority 5 - Implement/validate the content-editor workflow

Implement or refine distinct content management interfaces:

- Modifiers | Effects | Rule Hooks (Advanced) with reusable library/editor/attach configuration workflow;
- a separate Items editor that assembles the correct categories.

Key goal: attach existing reusable components before duplicating new ones.

Priority 6 - Establish character-facing sheet workflow

Make the sheet work as a digital paper sheet:

- readable desktop presentation;
- mobile-friendly collapsible sections;
- core stats/skills/saves/attacks/spells/inventory/features/resources/effects;
- dice roller hooks;
- manual freeform additions/removals;
- no heavy rules policing.

The UI should remain pleasant in actual tabletop use, not only administratively correct.

Priority 7 - Implement autosave and full version history early enough to matter

Because the user values it strongly, version history should be built into ordinary save flows rather than bolted on after years of data have accumulated.

At a minimum:

- reliable saves;
- durable version records;
- recent-history display;
- full-history browsing.

Resolve restoration/comparison progressively, but do not omit long-term retention.

Priority 8 - Build encounters/rounds after effects have a sound model

Implement:

- persisted encounter state;
- Next Round;
- duration decrement;
- DOT damage/healing;
- result visibility/logging;
- realtime notifications if helpful.

Avoid building it before modifiers/effects/actions can represent the things it must process.

Priority 9 - Add Level-Up Wizard and system templates as convenience, not enforcement

Once the character/content model exists:

- create a guided level-up experience;
- add expected features/spells/etc.;
- always preserve manual edit freedom.

This should build on templates/system definitions rather than hard-coded page logic.

Priority 10 - Future / later milestones

After the core:

- PDF export;
- JSON import/export;
- session log tracker;
- offline/PWA improvements;
- map/drawing canvas with version history;
- deeper multi-system support;
- content/articles workflow;
- richer campaign/party/companion features.

These are not empty promises; they are explicitly discussed future scope. They should not displace the foundation.

---

6. WORKING PREFERENCES AND CONSTRAINTS

6.1 Explain and build things simply

The user prefers the simplest system that will genuinely solve the need. Code and architecture should be heavily commented where complex domain logic exists. Maintainability matters more than impressive abstraction.

This applies especially to:

- database access;
- migrations;
- modifier/effect interpretation;
- automated round processing;
- history/versioning;
- custom formulas.

Avoid needlessly clever architecture.

6.2 Do not be rigid like D&D Beyond

This is one of the clearest product constraints.

Do not:

- block additional spells/cantrips because official progression says no;
- prevent custom features/items/effects;
- make users jump through workarounds for homebrew;
- enforce character ownership/claim locks;
- design the application as an official-rules validator first.

Do:

- automate expected things;
- offer warnings/helpful defaults;
- preserve manual override/add/remove freedom.

6.3 Preserve reusable mechanics, avoid duplication

The user wants to reduce the number of places and ways modifiers work. Reuse is important:

- define modifiers/effects once where possible;
- attach/configure existing components from items/spells/features;
- do not duplicate a rules change for every source;
- reserve advanced hooks for genuinely exceptional requirements.

6.4 Keep D&D 5e 2014 practical now; avoid painting the future into a corner

The app starts with 5e 2014. The user wants eventual other-system support, but not at the price of making the first 5e implementation vague or unusable.

A good rule:

- generic concepts where they genuinely help: actions, resources, modifiers, formulas, templates;
- 5e-specific helpers where 5e needs them;
- no premature generic-RPG framework that becomes its own project.

6.5 Database persistence is non-negotiable for meaningful state

Character/encounter state must not exist only in a browser, socket, or server memory.

Use:

- persisted writes;
- PostgreSQL as source of truth;
- durable version history;
- realtime only as notification/synchronisation support.

6.6 WebSockets are not the backend

The user’s chosen model is server actions for writes plus WebSockets for live updates/reconnection. Do not turn Socket.IO into the canonical data mutation channel or state store.

6.7 Small trusted group, low-cost hobby constraints

The project is for the user and a small group of friends. Design implications:

- do not add enterprise permission complexity without a real reason;
- avoid expensive infrastructure;
- do not optimise prematurely for public-scale traffic;
- still make persistence, data safety, and shared access reliable;
- Railway/Neon were chosen with affordability and practicality in mind.

6.8 Mobile support matters

This is likely used at the table. Avoid desktop-only assumptions.

Preferred patterns:

- collapsible character-sheet panels;
- clear content hierarchy;
- tap-friendly actions;
- mobile-friendly display of rolls, effects, and duration information.

6.9 Printing is useful, but digital is the primary product

PDF export is wanted, but it is not allowed to dictate a worse digital UX. Keep the sheet interactive/dynamic first.

6.10 Timing should stay round-oriented for now

Do not introduce real-time ticking/scheduling just because effects can have duration. The current intended gameplay loop is round-based via Next Round. Store/track durations in rounds and convert for display as useful.

6.11 Version history should be treated seriously

The user’s language here was emphatic: full history, from first character creation through “final death”, not merely three versions. Only displaying three recent entries is a UI convenience, not a retention limit.

Avoid suggesting a small undo stack as a substitute.

6.12 Content should be composable

Items, equipment, spells, feats, abilities, features, and similar “finished” objects should compose ingredients:

- modifiers;
- effects;
- actions;
- spell grants;
- features;
- resources/charges.

Keep the distinction visible in data/UI:

- library definitions are ingredients;
- items/etc. are assembled content.

6.13 Separate authoring UI from player-sheet UI

The modifier/item editor is an authoring/content-management tool. The character sheet is a player/table tool.

Do not let complex authoring configuration leak unnecessarily into ordinary sheet viewing. Conversely, do not make homebrew authoring impossible by hiding everything behind a simplified player UI.

6.14 Do not repeat abandoned or only-discussed technical suggestions as settled decisions

Specific examples:

- Do not state that Drizzle is chosen just because it was once recommended.
- Do not state that Supabase is chosen just because it was once recommended.
- Do not use normal PHP/cPanel hosting as the default new target.
- Do not build a plain Svelte app when SvelteKit was explicitly chosen.
- Do not assume the old PHP/MySQL implementation should be ported verbatim.
- Do not build the app around an unrelated exploratory 2d6 system rather than 5e 2014.
- Do not make real-time websockets the authoritative state mechanism.
- Do not force a D&D Beyond-style rules enforcement model.

6.15 Be explicit about confirmed versus unresolved

The user values clear reasoning and does not want later assistants silently fabricating a decision. When a decision has not been made:

- say it is unresolved;
- explain the options/trade-off;
- inspect the codebase;
- make a recommendation grounded in existing project intent;
- do not pretend the choice was already made.

The JSON-versus-relational question, exact modifier operations, rule hooks, item spell grants, and version-history implementation are all examples.

6.16 Use British English and a collaborative, practical tone

Project discussion has been in British English. The user prefers practical, direct reasoning, with assumptions challenged rather than waved through.

For implementation discussions:

- be clear about trade-offs;
- avoid jargon where a plain explanation will do;
- preserve their intentional flexibility;
- offer a best recommendation instead of endlessly asking for confirmation when enough context exists.

6.17 Relevant broader project instruction

Within this D&D Character Sheet Website project, the standing development direction was:

- act as a senior web developer;
- focus on simple systems;
- provide plenty of comments;
- the broader end product is a D&D 5e character management system around a huge array of homebrew/custom systems and articles.

The historical PHP/MySQL wording of that project instruction must be read in context: the current rewrite decision supersedes it technically with SvelteKit/Node/Neon PostgreSQL. The “simple system with comments” requirement remains fully applicable.

---

Closing migration note

The project’s north star is not “implement every 5e rule.” It is: make a flexible, reliable digital character sheet and campaign tool that gives a small trusted group the freedom of paper/homebrew plus the useful automation of software.

The highest-risk mistake is making the system either:

1. Too rigid and official-rules-driven to support the user’s actual games; or
2. So generically flexible that every spell, item, and effect becomes an opaque bespoke blob and nothing can be reused, calculated, tracked, or maintained.

The agreed modifier/effect/finished-content composition model is the main answer to that tension. Keep it central.