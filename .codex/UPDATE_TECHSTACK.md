We are rewriting the existing D&D character sheet webapp into a modern SvelteKit application.

Target hosting stack:

* Frontend/backend: SvelteKit running on Node.js
* Hosting: Railway
* Database: Neon PostgreSQL
* Deployment: automatic deploys from GitHub
* Runtime: Node.js
* Build command: `npm run build`
* Start command: `node build`
* SvelteKit adapter: `@sveltejs/adapter-node`

Core technical requirements:

1. Use SvelteKit, not plain Svelte.
2. Use TypeScript where practical, but keep the code simple and readable.
3. Use PostgreSQL via Neon.
4. Use environment variables for configuration.
5. Use server-side routes/actions for database writes.
6. Use WebSockets only for live update notifications.
7. Persist all important state to PostgreSQL.
8. Do not rely on server memory for character state, encounter state, buffs, temporary effects, spell slots, HP, or round timers.
9. Keep the structure simple and heavily commented.
10. Prioritise maintainability over clever architecture.

Required environment variables:

```env
DATABASE_URL=
SESSION_SECRET=
PUBLIC_APP_NAME="D&D Character Manager"
PUBLIC_APP_URL=
NODE_ENV=production
```

Recommended project structure:

```txt
src/
  lib/
    components/
      character/
      combat/
      layout/
      ui/
    server/
      db/
        index.ts
        migrations/
      auth/
      services/
        characters.ts
        campaigns.ts
        encounters.ts
        spells.ts
        effects.ts
    stores/
      characterStore.ts
      encounterStore.ts
      websocketStore.ts
    types/
      character.ts
      campaign.ts
      encounter.ts
      spell.ts
      effect.ts

  routes/
    +layout.svelte
    +page.svelte
    login/
    logout/
    dashboard/
    characters/
      +page.svelte
      [id]/
        +page.svelte
        +page.server.ts
    campaigns/
    encounters/
    api/
      websocket/
```

Database approach:

Use PostgreSQL as the source of truth.

Use either:

* simple SQL files and the `pg` package, or
* Drizzle ORM if migrations/type-safety are useful.

Do not introduce a heavy framework unless needed.

Preferred simple option:

* `pg` package
* parameterised SQL queries
* small service files per domain
* migration SQL files stored in the repo

Example database connection expectations:

* Use `DATABASE_URL`
* Use SSL for Neon
* Use a small connection pool, e.g. max 5 connections
* Never hard-code credentials

Authentication:

Implement simple email/password login.

Use:

* hashed passwords using bcrypt or argon2
* secure HTTP-only session cookies
* server-side session validation
* no JWT unless there is a clear reason

This is a single webapp, not a public API platform, so simple cookie sessions are preferred.

Core app domains:

* Users
* Campaigns
* Parties
* Characters
* Character stats
* Skills
* Saving throws
* Attacks
* Spells
* Inventory/items
* Features/traits
* Resources, e.g. rage uses, spell slots, inspiration
* Conditions
* Temporary effects
* Encounters
* Round tracking
* Pets/summons/familiars

Important gameplay behaviour:

The app needs to support active, interactive character sheets rather than just static records.

Examples:

* A character may toggle Rage on/off.
* Buffs may modify stats temporarily.
* Effects may expire after a number of rounds.
* A “Next Round” button should process ongoing effects.
* Damage-over-time and healing-over-time effects should apply automatically.
* Spell casting may ask for spell slot level and calculate the result.
* Character resources should be updated immediately when spent or restored.

The correct pattern for live updates is:

```txt
User clicks button
  -> SvelteKit server action/API route validates request
  -> PostgreSQL is updated
  -> WebSocket event is emitted
  -> connected clients refresh the affected character/encounter
```

Do not use this pattern:

```txt
User clicks button
  -> Node memory object is updated
  -> clients trust memory state
```

WebSockets:

Use WebSockets for party/session synchronisation.

Acceptable options:

* Socket.IO for easier reconnects and rooms
* ws for a lighter implementation

Prefer Socket.IO if it keeps implementation simpler.

Expected WebSocket behaviour:

* clients connect after login
* clients join rooms by campaign/party/encounter
* when a character changes, emit an event such as `character:updated`
* when an encounter advances, emit `encounter:updated`
* clients should reconnect automatically
* clients should reload state from the API after reconnecting

Example event names:

```txt
character:updated
encounter:updated
effect:expired
round:advanced
resource:changed
```

UI expectations:

The app should be mobile-friendly first.

Use collapsible sections for character sheets.

Suggested sections:

* Header / identity / level / class
* HP / AC / initiative / movement
* Ability scores
* Saving throws
* Skills
* Attacks and spellcasting
* Features and traits
* Inventory
* Resources
* Conditions and active effects
* Pets/summons

For attacks and spells, support this kind of structure:

```txt
Name
Range/Target
Effect
Duration in rounds
Notes
Cast/Use button
```

The Cast/Use button should eventually support contextual popups, for example:

```txt
Cast Cure Wounds
Choose spell slot level: 1 / 2 / 3 / 4
Show calculated healing: 1d8 / 2d8 / 3d8 / 4d8 + modifier
Confirm cast
Update spell slots/resources
```

Version history/autosave:

The app should support autosaving and version history.

Minimum behaviour:

* save changes automatically where safe
* store character snapshots or change logs
* show the latest few history entries on the sheet
* provide a full version history page later

Use a database table for version history rather than relying on files.

Suggested version history table concept:

```sql
character_versions
  id
  character_id
  created_by_user_id
  created_at
  change_summary
  snapshot_json
```

Keep this simple initially.

Deployment requirements:

Railway should run the SvelteKit app using adapter-node.

Expected commands:

```json
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "start": "node build"
  }
}
```

Railway settings:

* Build command: `npm run build`
* Start command: `npm run start`
* Add environment variables in Railway dashboard
* Use GitHub auto-deploy from the main branch
* Add custom domain later
* HTTPS should be handled by Railway

Neon database:

* Use Neon PostgreSQL connection string
* Store connection string in `DATABASE_URL`
* Do not commit secrets
* Use migrations for schema changes
* Keep regular backups/export plans in mind

Testing:

Include basic tests where practical.

Priority test areas:

* ability modifier calculation
* proficiency bonus calculation
* skill modifier calculation
* saving throw calculation
* HP/resource updates
* round advancement
* effect expiry
* spell slot usage
* permission/auth checks

Avoid over-engineering the test setup initially.

Migration goal:

The rewrite should preserve the useful behaviour of the current app, but does not need to preserve the exact PHP/MySQL structure.

Do not blindly port old code line-by-line.

Instead:

1. identify current features
2. recreate them in SvelteKit
3. design clean PostgreSQL tables
4. keep business logic in server-side service files
5. keep UI components small and reusable

Coding style:

* keep functions small
* use clear names
* comment non-obvious D&D/homebrew logic
* avoid unnecessary abstractions
* avoid clever patterns unless they clearly reduce complexity
* optimise for one developer being able to understand and modify it later

Initial milestone:

Create a working SvelteKit app with:

1. Railway-ready Node adapter config
2. Neon PostgreSQL connection
3. basic user login/session support
4. dashboard page
5. character list page
6. character detail page
7. editable character basics
8. autosave or manual save
9. basic version history table
10. placeholder WebSocket connection with reconnect support

Once that works, expand into combat, effects, spellcasting, and round tracking.
