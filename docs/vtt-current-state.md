# VTT POC - Current State

Living document. Structured as a diff against [`.claude/briefs/vtt-poc-spec.md`](../.claude/briefs/vtt-poc-spec.md) (Sections 1-10 below) and, as of the Phase 2 pass, also against [`.claude/briefs/vtt-phase-2-spec.md`](../.claude/briefs/vtt-phase-2-spec.md) (its own "Phase 2" section further down) - read whichever spec you haven't yet. Each spec section below is marked:

- ✅ **As designed** - matches spec intent, deviations are cosmetic
- 🔁 **Deviated** - built, but differently than spec described, with rationale
- 🧱 **Stubbed** - partial/placeholder
- ⛔ **Not started**

Update this doc at the end of each work session that touches `vtt/`, `static/vtt-app/`, or `src/routes/vtt/`. Add a new dated entry to the changelog at the bottom; don't rewrite history in the body sections - edit them in place to reflect current truth, and let the changelog carry the "what changed and when."

---

## 1. Session Model - ✅ As designed, 🔁 extended

In-memory only (`globalThis.__vttStore__`), exactly per spec - a server restart wipes every room, and that's accepted as fine for a POC.

**Why `globalThis` instead of a plain module-level object:** `vtt/server/store.js` has to be importable unmodified from three different loading contexts in the same process (SvelteKit's `$vtt`-aliased routes, the Vite dev plugin, and prod `server.js`). If the module gets loaded more than once under different specifiers, a plain top-level `const sessions = new Map()` could end up as two separate Maps. Stashing state on `globalThis` guarantees all three paths share it. This wasn't in the spec because the spec assumed a single standalone process - see Section 6 for the bigger structural reason.

Shape actually in use (`createSession`, `vtt/server/store.js`):

```js
{ id, gmSocketId: null, map: null, tokens: {}, players: {}, markers: {} }
```

Deviations from the spec's example JSON:
- **`markers: {}`** - new top-level collection, not in spec. See Section 8 (features beyond spec).
- **Token fields added**: `visionTrueFt`, `visionDevilFt` (truesight / devil's sight - see truncated all-or-nothing radius override in Section 4), `speedFt` / `speedRemainingFt` (movement budget), `condition` (`healthy`/`bloodied`/`critical` - spec Section 5 *suggested* this, it's now actually built). `imageUrl` is mutable post-creation via `token:stat:update`, not just at `token:add` time.
- Room codes exclude visually ambiguous characters (`0/O/1/I`) - refinement, not a deviation.
- `players[id]` doesn't store `socketId` directly (spec's example does) - connection identity lives on the per-socket `meta` object instead. Functionally equivalent, structured differently.

**How to verify**: open two browser tabs, create/join a room, and inspect the WS frames in devtools - `state:full`'s `session` payload shows the shape above.

---

## 2. Room Creation & Join Flow - ✅ As designed, 🔁 one gap

`POST /vtt/api/session` (`src/routes/vtt/api/session/+server.ts`) matches spec verbatim: plain HTTP, generates a code, creates the session, returns `{ sessionId }`.

Join (`vtt/server/handlers/join.js`):
- `join:error` / `reason: 'session_not_found'` on bad code - matches spec's example payload exactly.
- `state:full` sent to the joining socket only, filtered through `filterSessionForRole`, on **the same code path** for fresh join and reconnect - this was the spec's explicit ask ("eliminates most special-case resync bugs") and it's honored.
- `player:joined` broadcasts to everyone *else* in the session, player-role joins only (a GM join doesn't emit it).
- GM claim: first GM claim wins, matching spec's "whoever connects first as GM claims the role, no auth needed." **Now enforced** (Phase 2 Section 0b, see below) - a second live GM socket is rejected with `join:error`/`gm_already_claimed`; a stale claim (GM disconnected, nothing currently holds it) is reclaimable.
- **Disconnect cleanup** (Phase 2 Section 0c): a departing player broadcasts `player:left` and is marked `connected: false` (not deleted - they reappear correctly on reconnect); a departing GM clears `gmSocketId` so 0b's reclaim logic can pick up a new one.

**🔁 Real deviation from spec's assumed standalone flow**: joining now goes through the app's account system. `/vtt` (`src/routes/vtt/+page.server.ts`) is an authenticated SvelteKit route that redirects to the static client with `?playerId=&playerName=` pre-filled from the logged-in user, so nobody types a name manually when arriving via the nav link. Opening `/vtt-app/index.html` directly still works with manual entry + a random per-browser id, which is how the spec originally envisioned it and remains useful for quick multi-tab testing.

**How to verify**: log in, click **VTT** in the nav, note the room code in the sidebar. Open a second browser (or a different logged-in account) and join with that code - confirm `player:joined` fires (visible in the first tab's sidebar player list and in devtools WS frames). Try a bogus code in a third tab and confirm `join:error`. Kill and reopen a tab's connection with the same code to confirm reconnect replays `state:full` correctly.

---

## 3. Core Event Types - 🔁 5.5 of 6, plus one net-new family

All handlers live in `vtt/server/handlers/{token,map,marker}.js`, dispatched from a switch in `wsServer.js`, following the spec's validate→mutate→broadcast(filtered) pattern with no per-feature bespoke plumbing.

| Event | State | Notes |
|---|---|---|
| `map:set` | ✅ | GM-only gate (`meta.role !== 'gm'` → reject). Broadcasts unfiltered - matches spec (map has no secret fields). |
| `token:add` | 🔁 | GM (any) **or a player adding a `pc` token for themselves** (Phase 2 Section 1a — see below). Filtered per-recipient. |
| `token:remove` | ✅ | GM-only. A hidden token's removal is invisible to players who never knew it existed. |
| `token:move` | ✅ | GM (any token) or player (`canEditToken`: `token.ownerId === meta.playerId`) - matches spec's payload shape exactly. |
| `token:stat:update` | 🔁 | GM (any) or owning player, now field-limited via an allowlist (Phase 2 Section 0a) - see updated caveat below. |
| `token:hidden:toggle` | 🔁 | GM-only. Improves on the spec's literal wording - see snippet below. |
| `fog:reveal` / `fog:hide` | ⛔ | Not implemented - no handler, no client code. Spec explicitly marked this optional ("if doing manual fog on top of vision") and no milestone exercises it, so this is a deliberate skip, not an oversight. |
| `target:select` / `target:clear` | ✅ | Phase 2 Section 3a. Any joined socket may send it - no ownership/role check, per the spec's own "weakest validation in the codebase" framing. Thin pass-through, rebroadcast verbatim. |

**`token:stat:update` caveat (resolved in Phase 2)**: previously, `canEditToken` verified ownership only, not which `stat` key was being written. Phase 2 Section 0a added `PLAYER_EDITABLE_FIELDS`/`isFieldEditAllowed(role, isOwner, field)` in `vtt/server/handlers/token.js` - a player can now only write `hp`, `maxHp`, `speedRemainingFt`, `visionNormalFt`, `visionDarkFt`, `x`, `y`, `spellSlots` on their own token; everything else (`condition`, `defeated`, `ac`, `saves`, `actions`, `characterId`, `preparedSpells`, any other free-form `stats.*` key) is GM-only by default. Disallowed writes get an explicit `token:stat:update:error` back to the sender instead of silently no-oping. Note `hp`/`maxHp` are deliberately included in the player-editable list - that's pre-existing, already-shipped self-service HP tracking, not the risk this allowlist closes (see Phase 2 section below for the reasoning).

**`token:hidden:toggle` improvement over spec**: rather than literally broadcasting a toggle event to players (which would leak "something changed here" even if the token's other data is hidden), the server translates it into the same `token:add`/`token:remove` events players already handle:

```js
// vtt/server/handlers/token.js
return token.hidden
  ? { type: 'token:remove', tokenId: token.id }
  : { type: 'token:add', token: filterTokenForPlayer(token) };
```

**How to verify**: as GM, add a `type: enemy` token with **Hidden from players** checked - watch the player tab's WS frames (not just the UI) and confirm no message ever references it. Uncheck it and confirm a `token:add` appears in the player's frames.

---

## 4. Vision & Blackout Rendering - ✅ As designed, 🔁 extended

Implemented client-side in `static/vtt-app/render/vision.js`, computed per-player (unioned across owned tokens), never on the server - matches spec's core architectural call.

`computeVisionRadii(ownedTokens, map)` derives `colorRadius`/`grayRadius` per token; `renderVisionMaskedMap` draws all gray-band circles first (grayscale-filtered map, clipped), then all color-band circles on top (full-color map, clipped) - as two full passes across *all* tokens rather than one pass per token, so multi-token union is correct regardless of draw order (spec milestone 9).

`map.brightness` handling matches the three spec-defined modes, **corrected post-launch** (see changelog) to follow 5e RAW's darkvision text more faithfully - darkvision sees dim light as if it were bright light (full color), and true darkness as if it were dim light but explicitly without color (grayscale only):

```js
if (brightness === 'dim') {
  colorRadius = darkFt * pxPerFoot;               // darkvision = full color in dim light (RAW)
  grayRadius = Math.max(normalFt, darkFt) * pxPerFoot;
} else if (brightness === 'bright') {
  colorRadius = Math.max(normalFt, BRIGHT_LIGHT_RADIUS_FT) * pxPerFoot;   // 150ft floor, no gray band
} else { // 'dark'
  colorRadius = normalFt * pxPerFoot;
  grayRadius = darkFt > normalFt ? darkFt * pxPerFoot : colorRadius;
}
```

The original POC version had `colorRadius = 0` unconditionally in `dim` mode (everyone grayscale, no exception for darkvision) - the spec itself flagged this as an allowed simplification ("POC can skip nuance here... if easier"), but it produced a genuinely backwards result: a darkvision creature got *less* color in dim light than in true darkness, when RAW says the opposite (dim = as bright for darkvision; darkness = grayscale only, never color). Fixed so `dim` mode's color radius depends on `darkFt`, same as everything else already did.

**🔁 Extension beyond spec**: `bright` mode's color radius is no longer capped at the token's own `visionNormalFt` (typically 30ft) - it now uses a 150ft floor (`Math.max(normalFt, 150)`), following a user observation that 5e doesn't actually cap unaided daylight sight at a fixed distance the way it caps darkvision; `visionNormalFt` is a POC fog-of-war convenience, not a RAW-defined range, and 30ft made outdoor daylight scenes feel far more constrained than they should. `dim`/`dark` are unaffected - vision genuinely is the meaningful constraint there, which is exactly where the token-specific radius stat should still apply.

Hard-edged circles, no soft falloff - exactly what the spec allowed for POC simplicity.

**🔁 Extension beyond spec**: `visionTrueFt` (truesight) and `visionDevilFt` (devil's sight) were added as extra vision bands not in the original spec. Both extend the color/gray radius regardless of brightness (`colorRadius = Math.max(colorRadius, specialRadius)`), modeling "sees clearly even in darkness/magical darkness."

GM view is unmasked (full map, all tokens including hidden) - `main.js`'s render loop branches on `role === 'gm'` and skips vision masking entirely.

**🔁 Extension**: zoom (25%-400%, buttons + ctrl/cmd+scroll) and pan (scroll) were added. The spec doesn't mention zoom/pan at all - it implicitly assumed a 1:1 canvas. This is a **pure CSS scale** of the canvas element; the backing pixel buffer stays at the map's native size (`static/vtt-app/main.js:44` comment: *"CSS-only scale of the canvas; the backing pixel buffer stays at native map size"*), so vision-mask math and click/drag coordinate translation (`canvasCoords()`) both operate in unscaled map-space and divide out the zoom factor - vision rendering itself is zoom-agnostic. Note: `vtt/README.md` currently still says "No zoom/pan" under "Known POC gaps" - that line is **stale** and should be corrected next time the README is touched.

**How to verify**: give a player two tokens placed far apart with different `visionNormalFt`/`visionDarkFt`, confirm the revealed area is the union of both circles, not just the most-recently-moved token's. Toggle `map.brightness` via a `map:set` and confirm the three modes render as described.

---

## 5. Filtering - ✅ As designed, fully implemented, no gaps found

`filterSessionForRole(session, role, playerId)` lives exactly where spec asked (`vtt/server/store.js`), and is applied both on `join`'s `state:full` and on **every** token/marker-bearing broadcast (via `filterTokenForPlayer`/`broadcastToken` in `token.js`, and an analogous `shouldPlayerSeeMarker` for the new marker feature) - not client-UI-only.

```js
export function filterTokenForPlayer(token) {
  if (token.type === 'enemy' || token.type === 'npc') {
    const { stats, ...rest } = token;
    if (token.condition !== undefined) rest.condition = token.condition;
    return rest;
  }
  return token;
}
```

`stats` is genuinely absent from the payload (key omitted, not zeroed/nulled) for enemy/npc tokens sent to players; hidden tokens are dropped outright. This is the one spec mandate ("the one function to get right") that's fully and consistently honored everywhere it needs to be, including in the marker feature that didn't exist when the spec was written.

**How to verify**: same steps as Section 3's hidden-token check, plus: set HP on an enemy token as GM, confirm the player's WS frames never carry a `stats` key for that token, only `condition` if one's been set.

**🔁 Extension beyond spec (client-side, not protocol-level)**: PC tokens' `stats` are still sent over the wire unfiltered to all players (unchanged, matches the spec's "HP isn't secret between allies" stance) - but as of a later user request, the client itself now only *displays* a token's real HP bar/number if the viewer owns that token, falling back to the coarse `condition` badge for everything else regardless of type. This closes an inconsistency (players could see exact HP for other players' PCs but not enemies) without changing what the server actually sends - see the "Raw HP no longer shown for any non-owned token" changelog entry below.

---

## 6. File/Component Map

Deliberately doesn't match the spec's proposed `/server` + `/client` tree - the app is SvelteKit, not a standalone Node process, so the spec's flat layout got adapted to fit inside it while keeping the same conceptual split (server/client/handlers/render).

```
vtt/server/                              plain untyped JS (@ts-nocheck) - see below for why
  store.js                                 session shape, generateRoomCode, filterSessionForRole, broadcast()
  wsServer.js                              attachVttWebSocketServer(httpServer) - 'upgrade' handling + event dispatch
  tokenLibrary.js                          indexes the bundled Forgotten Adventures token art pack
  handlers/
    join.js                                join / state:full / player:joined / join:error / player:left / GM-claim enforcement (Phase 2)
    token.js                                add / remove / move / stat:update / hidden:toggle, field-level auth + valid-target hp exception (Phase 2)
    map.js                                  map:set
    marker.js                               marker:add / remove / visibility:toggle, now cone/cube/sphere-aware (Phase 2 Section 4)
    target.js                               target:select / target:clear  - NEW, Phase 2 Section 3a

src/routes/vtt/                          SvelteKit HTTP surface, auth-gated by hooks.server.ts
  +page.server.ts                          redirects to the static client with ?playerId=&playerName= from the account system
  api/session/+server.ts                   POST → creates room, returns { sessionId }  (spec's POST /session/create)
  api/upload/+server.ts                    POST multipart image → data/vtt-uploads/    - NOT in spec
  api/uploads/[filename]/+server.ts        GET, serves an uploaded image back           - NOT in spec
  api/token-library/+server.ts             GET, JSON index of bundled token art          - NOT in spec
  api/token-library/[...path]/+server.ts   GET, serves a bundled token image             - NOT in spec
  api/characters/+server.ts               GET, minimal character list for the picker combobox  - NEW, Phase 2 Section 1a
  api/characters/[id]/+server.ts          GET, full computed combat snapshot (hp/speed/vision/ac/saves/actions/spellSlots/preparedSpells)  - NEW, Phase 2 Sections 1a/1b/2

static/vtt-app/                          the actual client - served as static files, bypasses SvelteKit auth (see Section 9)
  index.html, style.css
  main.js                                  WS connection, join flow, sidebar UI, canvas drag, zoom/pan, image/token pickers, character picker, mini-sheet, action targeting, shape-drag placement (Phase 2)
  render/
    map.js                                 base map + grid
    tokens.js                              token sprites, HP bars, condition badges
    vision.js                              per-player radius vision mask
    movement.js                            remaining-movement radius overlay  - NOT in spec
    markers.js                             AoE/point marker rendering, cone/cube/sphere dispatch (Phase 2 Section 4)
    targeting.js                           target-ring overlay  - NEW, Phase 2 Section 3a
    shapeGeometry.js                       getTokensInShape/isPointInShape - circle/cone/cube point-containment math  - NEW, Phase 2 Section 4b

src/lib/rules/dnd5e.ts                   shared D&D formula engine (pre-existing) - extended in Phase 2 with armorClass/initiativeBonus/speedFt/passiveScore/visionRadii/equippedAttackItems, extracted out of CharacterSheetForm.svelte so the VTT API routes above can compute the same live numbers the sheet displays
src/lib/server/db/migrations/021_vtt_vision_targets.sql   seeds vision.normal_ft/dark_ft/true_ft/devil_ft as registered modifier_targets  - NEW, Phase 2 Section 1.0

vite.config.ts                           dev-mode plugin: attaches the VTT WS server to Vite's http.Server
server.js                                prod entry point: wraps adapter-node's handler, attaches the VTT WS server
svelte.config.js                         defines the `$vtt` alias → vtt/server, so SvelteKit routes can import the plain-JS module
assets/images/tokens/Forgotten_Adventures_Tokens/   1,436 bundled token images (committed to repo, served at runtime - see Section 10)
```

**Why `vtt/server/*.js` is untyped JS living outside `src/`**: it has to be imported unmodified from three different contexts in the same process - SvelteKit's bundled `+server.ts` routes (via the `$vtt` alias), the Vite dev plugin, and the production `server.js` entry point. Keeping it as plain `@ts-nocheck` JS sidesteps build/type friction across those three load paths. This is the biggest structural deviation from the spec's proposed layout, and it's a direct consequence of merging what the spec imagined as a standalone process into the main app's single server/port (see `vtt/README.md`'s architecture note - the WS server used to be its own Express+ws process and was folded in).

---

## 7. Explicit Exclusions (spec'd, deliberately skipped)

- **`fog:reveal`/`fog:hide`** - spec marked this optional from the start ("if doing manual fog on top of vision - optional for POC"), and no milestone exercises it. Skipped, not forgotten. Still true as of Phase 2 - see Phase 2 section below for current priority.
- **Campaign-linked player rosters** (original spec Section 8 future direction) - correctly deferred, not built. `playerId` is still passed explicitly on `join` per the spec's own forward-compatibility note, so swapping in roster validation later shouldn't require reworking the event shape.
- ~~Player-driven damage application / targeting~~ - **built in Phase 2** (Section 3, see below).
- ~~Mini character sheet in-VTT~~ - **built in Phase 2** (Section 2, see below).
- **WS handshake auth** - spec explicitly out of scope for the POC, and Phase 2's own framing reaffirmed this is intentionally not being hardened at this trust level/scale. Still true: the socket trusts whatever `playerId`/`role` a client states. Real identity now flows in via the account system for anyone arriving through the nav link (Section 2), but nothing stops a client from hand-crafting a `join` with `role: 'gm'` or someone else's `playerId` directly against `/vtt-ws`. Same posture spec asked for, worth remembering before this app is ever exposed outside a trusted group.
- **Server-side damage computation** (Phase 2 Section 3b's explicit open question) - resolved as client-side, per the phase-2 spec's own recommendation given the trust level. A player's browser rolls the dice and sends the result; the server only enforces *who* may write *which* field on *which* token, never re-derives the number itself.

---

## 8. Features Beyond the Spec

None of these were requested by the spec; all were added during implementation because they made the POC materially more usable for actually running a session.

- **Marker/AoE placement** (`marker:add/remove/visibility:toggle`) - players and GM can drop circular markers (spell templates, points of interest) on the map, private to owner+GM by default with a GM togglable "visible to all." New session collection (`markers`), own filter logic (`shouldPlayerSeeMarker`) mirroring the token-hiding pattern.
- **Movement range visualization** - `speedFt`/`speedRemainingFt` fields, `+5/-5/Reset` sidebar controls, a translucent remaining-movement radius (`render/movement.js`), and a live drag-distance readout that turns red when a drag exceeds the token's remaining budget. Players only ever see this circle for their *own* tokens (fixed - see changelog); the GM has a "Show movement ranges" toggle to declutter their own view of all tokens' circles at once.
- **Forgotten Adventures token library** - 1,436 bundled token images, indexed and served via `GET /vtt/api/token-library`, browsable in an in-app picker (filter by source/category/free text).
- **Image upload pipeline** for both map and token art (`POST /vtt/api/upload`, writes to gitignored `data/vtt-uploads/`, extension/size/mimetype validated, served back with path-traversal protection). Spec explicitly said a hardcoded static URL would be fine and called upload pipelines out of scope - this went beyond that because typing raw URLs turned out to be annoying in practice. Pasting a URL directly still works as a fallback.
- **Truesight / devil's sight vision bands** (Section 4).
- **Zoom & pan** (Section 4).
- **Coarse `condition` badge** - the spec *suggested* this as a way to give players a non-numeric enemy-health signal (Section 5); it's actually built: a GM dropdown (`healthy`/`bloodied`/`critical`) rendered as a colored badge on the player's view of that token.
- **Batch token spawning** - a "Quantity" field on the GM's Add Token form (default 1, max 50). Quantity 1 behaves exactly as before (bare name, no suffix); quantity > 1 sends one `token:add` per copy, auto-numbered `"Name 1"`, `"Name 2"`, etc., arranged in a grid centered on the map (spaced by `gridSizePx`) rather than stacked exactly on top of each other. No new event or server-side concept - purely a client-side loop over the existing `token:add`.
- **Standard 5e status conditions** - `token.conditions` (a plural array - Poisoned, Prone, etc., can stack) alongside the pre-existing singular `token.condition` (the coarse healthy/bloodied/critical HP signal). Set via a checkbox modal, visible to all players for any token (not secret like HP), editable by the GM for any token or a player for their own.

---

## 9. Known Fragility / Untested Edges

- **No automated tests** for anything under `vtt/` or `static/vtt-app/`. Repo-wide test coverage is limited to `src/lib/server/services/effects.test.ts` and `src/lib/rules/dnd5e.test.ts` - nothing VTT-related, and `vtt/server/*.js` is `@ts-nocheck` so `svelte-check`/`tsc` don't cover it either. Everything here is verified only by manually walking the milestone checklist in `vtt/README.md`.
- ~~`gmSocketId` is vestigial~~ - **fixed in Phase 2 Section 0b**: a live GM socket now rejects a second claim; a stale one is reclaimable.
- **Client-generated token/marker IDs** with no server-side uniqueness check beyond "is an id present" - `session.tokens[token.id] = token` on `token:add` will silently overwrite an existing token if a colliding or malicious ID is sent. Low risk from a trusted GM client, but worth knowing now that `token:add` authorization has loosened (Phase 2 Section 1a lets a player add their own PC token) - a player could theoretically send a colliding id, though `type`/`ownerId` scoping still limits what they can overwrite to their own tokens in practice.
- ~~No cleanup on socket close~~ - **fixed in Phase 2 Section 0c**: `player:left` broadcasts on disconnect, `connected` flag tracked, `gmSocketId` cleared when the GM leaves.
- **In-memory schema drift across incremental development** - `main.js` defensively does `session.markers = session.markers || {}` on receipt, implying the marker feature landed after some sessions might already be running. Harmless given no persistence (a restart resets everyone to the current schema), but a pattern to watch if any future feature adds required fields to `tokens`/`players`.
- **Unbounded room-code collision loop** (`generateRoomCode`) - `do {...} while (existingSessions.has(code))` has no retry cap. Not a practical concern at a 33-character alphabet × 6 chars for POC-scale usage, but note it before any load-testing.
- **`vtt/README.md` has drifted from the code** - still lists only `join.js`/`token.js`/`map.js` (missing `marker.js`, and now also missing `target.js`), doesn't mention `movement.js`/`markers.js`/`targeting.js`/`shapeGeometry.js`, the token library, the upload pipeline, or any Phase 2 work, in its file tree, and its "Known POC gaps" section incorrectly claims "no zoom/pan" (Section 4). This doc supersedes it; the README should be trimmed down to just the "how to run it" section or updated wholesale next time someone's in there.
- **Phase 2's `TARGET_WINDOW_MS` (5 minutes) is a hand-picked constant** (`vtt/server/handlers/target.js`) with no design rationale beyond "roughly one combat turn's worth of back-and-forth" - if actual play reveals it's too short (slow turns) or too long (stale targets get attacked accidentally), it's a one-line tune, not a redesign.
- **Prepared spells are display-only, not wired to combat resolution** - the mini-sheet lists a character's prepared spells (name + level), but clicking one doesn't do anything; only weapon-style `actions` (with `damageRolls`/`toHitBonus`/`damageBonus`) are wired to the attack-targeting flow. Proper spell damage would need per-spell damage formulas, which don't exist anywhere in the current data model (spells are pulled from `content_definitions`/`character_content_instances` with no damage-expression field) - a real gap if spell-slinging PCs are common at the table, not addressed in this phase.
- **`token:add`'s GM path is still fully unrestricted** - the Phase 2 change only added a narrow *additional* allowance for players (their own `pc` token); a GM can still add a token with any `id`/`ownerId`/`stats` combination, same trust level as the original POC.
- **Cone/cube placement UX is functional but minimal** - a single click-drag sets both facing and length in one gesture; there's no way to adjust cone angle or cube width after arming placement (must cancel and re-open the form to change them), and no snapping to grid angles (45°/90° etc.). Fine for the current scale, a candidate for polish if cone/cube placement turns out to be fiddly in real play.
- ~~Character-sheet pull-through is a one-time snapshot~~ - **superseded**: a 30-second polling resync was added (see changelog below) covering only the reference fields with **no editable control anywhere in the VTT** - `ac`, `saves`, `actions`, `preparedSpells`. Everything else that's read-only-on-the-sheet-but-editable-in-the-VTT (`hp`, `maxHp`, `speedFt`, all four vision fields) is deliberately excluded from the poll, not just `hp`/`spellSlots` as first scoped - a first pass also synced vision/speed/maxHp and was found (via a real user report) to silently revert a GM's manual in-session override (e.g. temporarily granting darkvision for a spell/potion) back to the sheet's baseline on the next poll tick. The dividing line is "if a human can edit it in the VTT, the poll must never touch it," and that's a property of the data model, not the poll-vs-push transport - a future push-based system (sheet save → VTT) would need the exact same exclusion list, not just faster delivery. See the Phase 2 Follow-Up Priorities below for the push-based direction.

---

## 10. Follow-Up Priorities (superseded by Phase 2's own section below)

This section described priorities as of the initial POC audit (2026-07-14, before Phase 2). Three of its five items (mini character sheet, player-initiated targeting/damage, and the gmSocketId/disconnect fragility items) are now done - see the Phase 2 section below for what's built and what's next. Kept here verbatim for history rather than deleted, per this doc's own "don't rewrite history" convention; **the live priority list is now the one at the end of the Phase 2 section.**

1. ~~Mini character sheet in-VTT~~ - **done, Phase 2 Section 2.**
2. **Campaign-linked player rosters** - spec Section 8, still legitimately future work. The `playerId`-on-`join` shape was kept spec-compliant specifically to make this swap-in easy later; no rework needed to start it. Still not started as of Phase 2 - see Phase 2 priorities below.
3. ~~Player-initiated targeting/damage application~~ - **done, Phase 2 Section 3.**
4. ~~gmSocketId enforcement / disconnect cleanup~~ - **done, Phase 2 Section 0.**
5. **Fog-of-war (`fog:reveal`/`fog:hide`)** - still spec-optional and still unbuilt. No signal from actual use that this is needed over the radius-vision approach; leave deprioritized unless a real session hits a case radius-vision can't express (e.g. a corridor that should stay dark despite being in radius). Unchanged as of Phase 2.

---

---

# Phase 2 - Character Sheet Pull-Through & Combat Actions

Diff against [`.claude/briefs/vtt-phase-2-spec.md`](../.claude/briefs/vtt-phase-2-spec.md), using this doc's numbered sections 1-10 above (the POC) as the baseline. Section numbers below mirror the phase-2 spec's own (0 through 4), not a continuation of 1-10.

## 0. Foundations - ✅ As designed

All three foundation fixes were implemented before any Section 1-4 work, per the spec's explicit sequencing instruction.

**0a. Field-level authorization on `token:stat:update`** - `PLAYER_EDITABLE_FIELDS`/`isFieldEditAllowed(role, isOwner, field)` in `vtt/server/handlers/token.js`, exactly as spec'd, with one deliberate deviation from the spec's own example list: **`hp`/`maxHp` are included** in the player-editable set. The spec's illustrative `GM_ONLY_FIELDS` example listed them as GM-only, but that would have regressed real, already-shipped behavior (`ownTokenListHtml`/`wirePlayerSidebar` in `main.js` already let a player edit their own token's HP - confirmed by reading the code before implementing). A player self-tracking their own HP isn't the "self-buff" risk 0a exists to close; that risk is about *other* fields (`condition`, `defeated`) and about editing *other tokens'* HP, both of which stay blocked. Disallowed writes now get an explicit `token:stat:update:error` back to the sender (`{ tokenId, stat, reason: 'field_not_editable' }`) instead of a silent no-op.

**0b. Single-GM claim enforcement** - `findLiveGmSocket()` in `vtt/server/handlers/join.js` checks `socketsBySession` for a live (`ws.readyState === OPEN`) GM socket before allowing a claim. A second live GM is rejected with `join:error`/`gm_already_claimed`; a stale claim (GM disconnected) falls through to reclaim.

**0c. Disconnect cleanup** - `wsServer.js`'s `ws.on('close', ...)` now looks up the session and, for a departing player, sets `connected: false` on their `session.players` entry and broadcasts `player:left`; for a departing GM whose id matches `session.gmSocketId`, clears it. Player objects gained a `connected` boolean (defaults `true` on join/reconnect).

**A structural bug caught during implementation, not in the spec**: the first pass gated the field-allowlist check entirely behind the pre-existing `canEditToken(meta, token)` ownership check. Since Section 3b's whole point is allowing a write on a token the sender does *not* own (an enemy they've targeted), that ownership gate would have made 3b's exception unreachable once built. Restructured to `(canEditToken(meta, token) && isFieldEditAllowed(...)) || isValidHpTarget(...)` - two parallel authorization paths, not one narrowing the other. Caught by writing the Section 3 verification test before assuming the code was right, not by inspection.

**How to verify**: see the Phase 2 changelog entry below for the exact WS-script test sequence used (join races, disconnect/reconnect, disallowed-field rejection) - all four checks pass against the live dev server.

---

## 1. Character Sheet Pull-Through - ✅ As designed, 🔁 one major reinterpretation

### 1.0 Shared derived-stat extraction (prerequisite work, not explicitly itemized in the spec)

The spec's Section 2 flagged, as an explicit pre-check: is the math engine "cleanly callable from the VTT's context"? It wasn't. `armorClass`, `initiativeBonus`, `speedFt`, `passiveScore` (generalizing perception/insight/investigation), and a new `visionRadii` were extracted from inline `$derived` formulas in `CharacterSheetForm.svelte` into `src/lib/rules/dnd5e.ts` as plain, narrow, pure functions (same style as the pre-existing `spellSaveDc`/`spellAttackBonus`), callable from both the Svelte component and the new server-side VTT API routes. `equippedAttackItems(inventory)` was similarly extracted from the sheet's inline "battle action items" filter. The component now delegates to these instead of recomputing inline; `combatFormulaHelp`'s tooltip-breakdown text (a second, parallel computation used only for hover text) was left as-is since it already read the shared `computed*` values for its "Total" lines - the actual duplication there is cheap re-derivation of intermediate bonus arrays for display, not a source of possible disagreement.

**Verified two ways**: (1) a direct unit-level script (`tsx`) exercising each extracted function against hand-computed expected values, including the speed formula's exact order of operations (base/set → additive bonuses → chained multipliers → floor/clamp) and the new vision-modifier resolution; (2) `svelte-check` (0 errors) plus an actual character sheet page fetch confirming the SSR'd HTML still shows `Armor Class = 10` with the correct formula breakdown for a fresh level-1 human fighter.

### Vision derivation - 🔁 reinterpreted, not a feat-name lookup table

The spec's Section 1b assumed a small hardcoded feat→vision-field mapping table, using Darkvision as its example. Two things made that the wrong shape for this codebase: Darkvision is a **racial trait**, not a feat, and this codebase has no structured race/trait data at all (confirmed: zero hits for "darkvision" anywhere in the schema, and `character.metadata.race` is freeform text). The actual correction, confirmed with the project owner: per `docs/architecture/modifier-primacy-architecture.md`, Darkvision isn't tied to any specific container type - it's just an ordinary Modifier targeting a vision stat, attached via whatever Container grants it (racial-trait container, feat, item, doesn't matter).

Implemented as such: `visionRadii(modifierSources, context)` resolves `vision.normal_ft`/`vision.dark_ft`/`vision.true_ft`/`vision.devil_ft` through the exact same `resolvedAdditiveModifiers()` machinery already used for AC/speed/etc, additive on top of a standard-human baseline (30/0/0/0). A new migration (`021_vtt_vision_targets.sql`) registers those four target keys in `modifier_targets` with `runtime_supported: true` (verified applied against the dev DB), so they show up properly labeled in `/admin/rules/hooks` immediately. **No feat-name or race-string matching exists anywhere.**

**Deliberately not built in this pass**: actually authoring a "Darkvision (Racial)" Container/Modifier and attaching it to specific characters. That's real campaign content, a DM decision via the existing `/admin/rules/hooks` → `/admin/rules/modifiers` → `/admin/rules/effects` flow (confirmed to already fully support it) plus the character's own owner self-selecting it on their sheet (also an existing, unmodified flow) - not a code gap. Until a DM does this, every character resolves to the 30/0/0/0 baseline, which is correct behavior, not a bug.

### 1a/1b. Character combobox + token pre-population - 🔁 one authorization change the spec didn't explicitly call out

`GET /vtt/api/characters` (minimal list, reuses `listCharacters` unchanged - no portrait field exists anywhere in this codebase, confirmed, so the picker shows name + class/level text only) and `GET /vtt/api/characters/[id]` (full computed snapshot: hp/maxHp, speedFt, vision, ac, saves, actions, spellSlots, preparedSpells - ownership-scoped exactly like `getCharacter()`, confirmed via a cross-account 404 test) both exist under `src/routes/vtt/api/characters/`, following the existing no-manual-auth-check pattern (`hooks.server.ts` already gates the route).

Client: a new "Pick Your Character" modal (`static/vtt-app/main.js`, `#characterPickerModal`), opened via a new **Add My Character…** button in the player sidebar, following the same modal-overlay pattern as the existing image picker. Selecting a character fetches the detail snapshot and builds a `token:add` payload client-side, exactly like the existing manual "Add token" flow already does - just pre-filled from real data instead of blank, plus new fields (`characterId`, `ac`, `saves`, `actions`, `spellSlots`, `preparedSpells`) riding along on the same payload.

**Authorization change, flagged explicitly since the spec's own Section 0 foundations list didn't call it out**: `token:add` was GM-only in the POC. Section 1a's "selecting a character creates their token" flow requires a *player* to create their own token, so `token:add` now also allows `meta.role === 'player' && token.type === 'pc' && token.ownerId === meta.playerId` - GM's own privileges (any type, any owner) are unchanged.

**How to verify**: log in as a user with an existing character (equip a weapon, prepare a spell if a caster), join a VTT session as that player, click **Add My Character…**, confirm the resulting token's HP/speed/vision/AC match the character sheet. Try `token:add` with `type: 'enemy'` from devtools as that player - rejected. Try adding a `pc` token with someone else's id as `ownerId` - rejected. All four checked against the live dev server via a WS+HTTP script; see changelog.

---

## 2. Mini Character Sheet In-VTT - ✅ As designed, one deliberate scope cut

Renders inline in each owned PC token's card in the player sidebar (`miniSheetHtml()` in `main.js`) - AC (read-only), saves (read-only tags), actions (clickable rows, wired to Section 3's targeting), spell slots (current/max per level with Use/Reset controls sending `token:stat:update` with a whole-array replace), and prepared spells (read-only list). **No new network calls** - everything was already pulled onto the token at creation time (Section 1) and stays in sync via the existing token broadcast plumbing; opening the panel doesn't re-fetch anything. This directly satisfies the spec's "populate once at creation, don't auto-resync" limitation by construction - there's only one pull point, not two.

**Deliberate scope cut vs. the spec's sequencing note**: the spec mentions, without detailing, a "click any token for a details panel" feature reusing the same data. Not built as a separate surface in this pass - the mini-sheet only shows for the player's *own* tokens right now. Low cost to add later (same card markup, read-only mode, driven by whichever token's data is present), deprioritized to keep this pass focused; noted as a follow-up below rather than silently dropped.

**Known limitation surfaced during implementation, not fully solvable without new data**: prepared spells render but aren't wired to the attack-targeting flow (see Known Fragility above) - only weapon-style `actions` are, since only those carry `damageRolls`/`toHitBonus`/`damageBonus`. Spell damage resolution would need a data-model addition (per-spell damage expressions) that doesn't exist yet.

**How to verify**: with a player-created PC token, confirm the mini-sheet shows correct AC/saves/actions/spell slots matching the character sheet. Consume a spell slot via the panel's Use button, confirm the card updates and the GM's view reflects it too (same broadcast as HP). Verified visually via a headless-browser screenshot (Playwright) in addition to the underlying data checks.

---

## 3. Combat Actions & Targeting - ✅ As designed, plus one leak the spec explicitly warned to check for

### 3a. Target selection

`vtt/server/handlers/target.js` (new) - genuinely the "thin pass-through" the spec asked for: no role/ownership check at all (any joined socket may send it), rebroadcasts `{ sourceTokenId, targetTokenIds }` verbatim, and stashes `lastTargetTokenIds`/`lastTargetAt` on the sender's own `meta` object for 3b to consult. Client: `render/targeting.js`'s `drawTargetRings()`, a dashed ring around each targeted token, wired into `main.js`'s render loop and `handleMessage` switch.

### 3b. Applying results

A player may now write `hp` on a token they don't own if it's present in their own most recent `target:select` within a 5-minute window (`TARGET_WINDOW_MS` in `target.js`) - implemented as `isValidHpTarget()` in `token.js`, a parallel authorization path alongside (not instead of) the existing ownership+field-allowlist check (see the Section 0 structural-bug note above for why this had to be a genuine OR-branch). `defeated`/`condition` remain excluded from `PLAYER_EDITABLE_FIELDS` regardless of targeting, so a player's attack can lower an enemy's HP but never itself flags a kill - matching both this spec and the original POC spec's "GM decides death on their own timeline" rule.

**A genuine leak the spec explicitly flagged as "worth a manual check, not an assumption" - found and fixed, not just re-verified.** `broadcastToken()`'s `extra` payload (`{ tokenId, stat, value }`) was shared verbatim across all recipients. Even though the enclosed `token` object was correctly filtered (`stats` stripped for enemy/npc), the *top-level* `value` field - e.g. an enemy's new HP after a hit - rode along unfiltered to every player. This was dormant in the POC (only the GM could ever trigger a `stat:update` on an enemy token, and the GM already sees real values), but became live and exploitable the moment Section 3b let players trigger it. Fixed by making `broadcastToken`'s `extra` accept a per-recipient function, omitting `value` for non-GM recipients on enemy/npc stat fields; client-side, `token:stat:update`'s handler now guards `msg.value !== undefined` before applying anything.

This surfaced a second, related design gap not explicit in the spec: **an attacking player never receives an enemy's HP at all, so they can't compute a new absolute value the way the GM's direct HP input does.** `token:stat:update` gained an optional `delta` field (used only via the `isValidHpTarget` path) - the server computes `Math.max(0, currentHp + delta)` server-side, so the player only ever says "this hits for 8," never learning the number before or after. `value` (absolute set) is unchanged for every other case (GM editing directly, a player editing their own HP).

Damage was originally rolled **client-side** (a small standalone `rollDamageDice()` in `main.js`, since the vanilla client can't import `$lib/rules/dnd5e` - no build step, no `$lib` alias resolution). **Superseded in Phase 2.5** (see the Phase 2.5 section and changelog below): both to-hit and damage now roll **server-side** via `POST /vtt/api/characters/[id]/roll-attack`, reusing the exact `rollAttack()` the character sheet uses, so the VTT shows the full advantage/disadvantage-pool + extra-dice + crit breakdown instead of a flat `XdY+Z`. The client still applies the resulting damage via the same `token:stat:update` `delta` path described here.

**How to verify**: with a player-created PC token (weapon equipped) and a GM-added enemy token, click a weapon action in the mini-sheet, click the enemy on the map - confirm a target ring renders in all tabs, the attack fires, the enemy's HP visibly drops in the GM's view. Explicitly re-checked (not assumed) via a headless-browser test: inspected the attacking player's own rendered "other tokens" panel post-attack and confirmed no real HP number ever appears, only "No status known" (or a GM-set `condition` if present). Confirmed a player cannot write an enemy's `hp` without a recent `target:select` on that token.

---

## 4. AoE Shape Types - ✅ As designed

`vtt/server/handlers/marker.js`'s `marker:add` now trusts `input.shape` from a fixed allowlist (`circle`, `cone`, `cube`, `sphere`) instead of hardcoding `'circle'`, and carries the new geometry fields (`angleDeg`, `lengthFt`, `widthFt`, `coneAngleDeg`) through opaquely - the server stays fully geometry-agnostic, exactly as the existing circle-only code's own comment anticipated ("shape is on the data already so cone/line/cube can be added as new branches here later without touching the sync/visibility plumbing" - that comment turned out to be accurate).

**4a/4b.** New standalone `static/vtt-app/render/shapeGeometry.js` - `isPointInShape()`/`getTokensInShape()`, covering circle/sphere (identical distance-check math, sphere is a semantic alias per spec's "cheapest shape to add" framing), cone (angle + distance test from an origin point), and cube (point-in-rotated-rectangle, anchored at the near-edge midpoint - the same anchor convention as a cone's origin, so the placement UI works identically for both). `render/markers.js` dispatches per-shape draw functions instead of the old single circle-only branch.

**4c.** Placement UI extends the existing "arm placement mode" banner pattern: circle/sphere keep the original single-click placement; cone/cube start a drag on mousedown (origin), live-preview the shape during `mousemove` (reusing `drawMarkers()` directly with a synthetic in-progress marker - no separate preview-rendering code needed), and confirm on `mouseup` with the drag's angle/distance converted to `angleDeg`/`lengthFt` (rounded to the nearest 5ft). The marker-controls form (shape select + radius vs. width/cone-angle fields) was factored into one shared `markerFormHtml()`/`wireMarkerForm()` pair used by both the GM and player sidebars, rather than duplicating the new shape UI in four places.

**Auto-targeting (spec 4b's second bullet)**: implemented as a shared `placeMarker()` helper - every shape placement (not just cone/cube) computes `getTokensInShape()` against the placed marker and sends `target:select` for whatever it catches, wiring Sections 3a and 4 together exactly as the spec anticipated ("removes the need to manually multi-select targets for an AoE").

**Cosmetic bug caught during verification, fixed**: the sidebar's marker-list entries showed "0 ft" for cone/cube markers (the label logic only ever read `radiusFt`, which directional shapes don't set). Fixed with a small `markerSizeLabel()` helper covering all three size conventions.

**How to verify**: place a cone and a cube near a cluster of enemy tokens (drag to aim, release to confirm) - confirm the rendered shape's orientation matches the drag direction, confirm tokens caught inside get auto-highlighted with target rings, confirm tokens outside are not targeted. Verified visually via headless-browser screenshots showing a 90° cone correctly catching two of three placed enemies (and excluding the third, positioned outside the cone's arc) with visible target rings on the caught tokens, plus a cube rendering correctly oriented along its drag direction.

---

## Phase 2 Follow-Up Priorities

Per the spec's own sequencing note, Section 4 was independent of 1-3 and didn't gate on character data - all five sections (0-4) are now built and verified. What's next, in rough priority order:

1. ~~Character resync~~ - **done**, via 30-second polling (see changelog below). A real push-based system (character sheet save → VTT, no poll delay) is legitimate future work once the app has an actual realtime layer - `emitRealtimeEvent('character:updated', ...)` already exists as a call site in the character sheet's save path, but is currently just a stub for a separate, not-yet-built Socket.IO system (`src/lib/server/realtime.ts`). Wiring push-based sync would mean either building that system out for real, or having the character-save action reach directly into the VTT's in-memory session store - a decision to make once the realtime system's shape is actually decided, not before.
2. **Wire prepared spells into combat resolution** - currently display-only (Known Fragility above). Needs a data-model decision (where does a spell's damage expression live?) before it's buildable, not just UI work - the actual blocker, similar in kind to Section 1's original "is the math engine reachable" check.
3. **"Click any token for a read-only details panel"** - the deliberate scope cut from Section 2. Low cost (reuse `miniSheetHtml()`'s markup in read-only mode for whichever token was clicked), not done in this pass to keep it focused.
4. **Campaign-linked player rosters** - still legitimately future work per the original POC spec's Section 8, unchanged by Phase 2. The `playerId`-on-`join` shape remains kept compatible with this.
5. **Fog-of-war** - still spec-optional, still unbuilt, still no signal from actual use that it's needed over radius-vision. Unchanged priority.
6. **Cone/cube placement polish** - adjustable cone-angle/cube-width mid-drag, angle snapping. Only worth doing if real play shows the current single-gesture placement is fiddly - no signal either way yet.

Nothing in this phase's implementation surfaced a reason to reorder this list - the two items with genuine data-model dependencies (spell damage, and the eventual push-based resync) are appropriately ranked above pure-UI or already-deprioritized items.

---

---

# Phase 2.5 - Fix Attack Flow (server-side shared roll)

Diff against [`.claude/briefs/vtt-phase-2.5-attack-flow-fix-spec.md`](../.claude/briefs/vtt-phase-2.5-attack-flow-fix-spec.md).

## 0. Diagnosis - 🔁 root cause was upstream of the click plumbing

The reported "clicking does nothing at all" was **not** a broken click handler or dropped event. A full read of the arm→click→resolve path found the wiring correct and the app initialising cleanly (so no load-time exception). The actual cause, confirmed with the user against a live session: the player's mini-sheet showed **"No equipped weapons"** - there was literally no action row to click. The VTT's Actions list is built from `equippedAttackItems()` (items with `location === 'equipped'`/`equipped === true`), so a weapon sitting un-equipped in inventory produces no action. This also answered a parallel user question ("I've not seen anything about inventory") - the mini-sheet only surfaces *equipped attack items* as clickable rows, never a full inventory list. Once a weapon was equipped, the original flow did fire.

The prior "verified" claim for this path (Phase 2 Section 3) came from a headless test that exercised the data/event layer, not a real two-client UI click-through - the specific trust gap this spec was written to close.

## 1. Explicit Attack flow + shared server-side roll - ✅ built (live verification pending)

Rather than patch the flat client-side roll, the flow was rebuilt per the spec's Section 1, and the roll logic was unified so the VTT and the character sheet can't diverge:

- **Shared roll module** - `src/lib/rules/attackRoll.ts` (new): `rollAttack()`, `rollWithModifiers()`, `rollDamage()`, `battleDamageBonuses()`, `damageCandidatesFor()`, extracted **verbatim** from `CharacterSheetForm.svelte`'s `rollBattleAction`/`rollText`/`rollDamageExpression` (which now delegate to it - no sheet behaviour change; the component keeps thin wrappers that pass its own reactive `modifierSources`/`classRows`/ability scores/RNG). One roll implementation, two callers.
- **Server endpoint** - `POST /vtt/api/characters/[id]/roll-attack` (new): ownership-scoped like the sibling GET route, loads the **live** character, matches the clicked action to a real equipped inventory item by name, and runs `rollAttack()` against the character's full `modifierSources`. This is the only place the rich roll can happen - the vanilla VTT client can't import `$lib`, and the token only carries a *flattened* action (`toHitBonus`/`damageBonus`/`damageRolls`), not the modifier graph that drives advantage/disadvantage/Bless/crit.
- **Rebuilt client flow** (`static/vtt-app/main.js`, `index.html`, `style.css`): arm (banner names the weapon + valid targets get a yellow highlight ring) → click a target → **confirm card with an explicit Attack button** (no more instant resolve) → on Attack, call the endpoint → render the *exact same* to-hit + damage breakdown the sheet shows → apply damage via the existing `token:stat:update` `delta` path. Hit/miss is decided client-side **only when this client is allowed to know the target's AC** (own/PC token, or GM); for a hidden-AC enemy it shows the to-hit total and leaves the hit call to human adjudication rather than fabricating or leaking AC. On a determined miss, no damage event is sent.

**Known limitation carried forward**: conditions set *in the VTT* (`token.conditions`, e.g. flipping Poisoned on a token) are not wired into the character's `modifierSources`, so the roll reflects the sheet's persistent effects, not VTT-transient ones. Bridging that is a real follow-up, not part of this fix.

**Verification status** - ⚠️ **automated only so far; live two-browser check still owed.** Passing: `svelte-check` (0/0), a deterministic parity test proving `rollAttack()` reproduces the sheet's "Pokey Sword" (Poisoned + Bless) breakdown byte-for-byte, dev server boots clean, endpoint registers and is auth-gated. **Not yet done**: the actual GM+player live click-through the spec (and this doc's own hard-won lesson) require before this is called "verified." Section 3 of the spec - repointing Phase 3 Section 2a at this flow - is deliberately deferred until that live check passes.

---

## Changelog

### 2026-07-14 - Initial audit
First "current state" pass, written after the POC had already accreted markers, movement tracking, the token library, upload pipeline, and zoom/pan beyond the original spec (per git log: `fdee6e0`, `a7a90cb`, `5132f2b`, `d60f1e9`, `c296b9a`). Audited by reading `vtt/server/`, `src/routes/vtt/`, `static/vtt-app/`, and cross-checking `vtt/README.md` (found stale in two places - missing files in its tree, incorrect zoom/pan claim). No code changes made in this pass - documentation only.

### 2026-07-14 - Phase 2 implementation (character sheet pull-through, mini sheet, combat actions, AoE shapes)
Implemented `.claude/briefs/vtt-phase-2-spec.md` Sections 0-4 in full, in the spec's own sequencing order, verifying each section against the live dev server before moving to the next rather than batching everything into one untested pass. Two real design gaps were resolved with the project owner before implementation (see the Phase 2 section above): AC/speed/etc. formulas were extracted from `CharacterSheetForm.svelte` into shared `dnd5e.ts` functions rather than left server-unreachable, and vision derivation was corrected from the spec's assumed feat-name lookup table to ordinary modifier resolution (per `docs/architecture/modifier-primacy-architecture.md`), once research showed Darkvision is a racial trait with no structured data in this codebase, not a feat.

Verification method: no `chromium-cli` available in this environment, so Playwright + a real Chromium binary were used directly (already cached locally) for actual browser-driven checks (character picker → token creation → mini-sheet rendering; attack targeting → damage resolution → HP-leak check; cone/cube placement → auto-targeting), backed by raw WS-protocol test scripts for the server-side authorization logic (GM-claim races, disconnect cleanup, field-level rejection) where a full browser round-trip wasn't the most direct way to exercise the behavior. All temporary test scripts and users were cleaned up after use; none were committed.

Two real bugs were caught during this implementation (not present in the spec, not carried over from the POC) and fixed before considering any section done: (1) the Section 0/3b authorization logic initially gated the new "player attacks a non-owned target" exception behind the pre-existing ownership check, which would have made it permanently unreachable once built - caught by writing the verification test before trusting the code; (2) `broadcastToken`'s shared `extra` payload leaked an enemy's raw HP value to all players via the top-level `value` field even though the enclosed token object was correctly filtered - dormant in the POC, made live and exploitable by Section 3b, and explicitly the kind of thing the spec asked to verify manually rather than assume. Both fixed and re-verified against the live server before moving on.

Deliberate scope decision, flagged rather than silently applied: `token:add` (GM-only in the POC) was loosened to also allow a player to add a `pc` token they own, since Section 1a's "picking a character creates the token" flow requires it - not explicitly called out in the spec's own Section 0 foundations list, but a direct and necessary consequence of it.

### 2026-07-14 - Two post-verification bugs reported and fixed
User-reported after the Phase 2 pass above, both real regressions from Section 0a's field allowlist and pre-existing sidebar logic, neither caught by the section-by-section verification because that testing exercised the *new* capabilities each section added, not every pre-existing control on an owned token:

1. **Players could no longer change their own token's image.** Section 0a's `PLAYER_EDITABLE_FIELDS` allowlist (`vtt/server/handlers/token.js`) was built by walking the phase-2 spec's own example list plus the specific fields Section 1-4 needed; `imageUrl` - pre-existing, already-shipped functionality via the "Change Image..." button - was never on that list and so silently started being rejected once the allowlist went live. Fixed by adding `imageUrl` to the allowlist. This is the same class of gap `hp`/`maxHp` were deliberately checked for during the original implementation (see the Section 0 write-up above) - `imageUrl` should have gotten the same audit and didn't.
2. **"Other tokens in view" wasn't actually filtered by vision, and didn't refresh on `token:move`.** `playerSidebarHtml()`'s `otherTokens` was `allTokens.filter(t => t.ownerId !== playerId)` - never vision-filtered at all, despite the label - so any other player's token showed there (and kept live-updating) regardless of whether it was actually within the viewer's vision radius. Separately, `token:move` never called `renderSidebar()`, so even a correctly vision-filtered list wouldn't have refreshed when a token's position changed. Both are pre-existing POC-era gaps, not something Phase 2 introduced - Phase 2 just added more reasons a token's data changes live (mini-sheet, targeting), making the staleness more noticeable. Fixed by (a) sourcing `otherTokens` from `currentRenderedTokens` (render()'s already-vision-filtered set for a player) instead of `allTokens`, (b) adding `renderSidebar()` to the `token:move` case, and (c) swapping `state:full`'s call order (`render()` before `renderSidebar()`) so the very first render after joining/reconnecting has a populated `currentRenderedTokens` to read, rather than an empty stale array.

Both verified via a headless-browser script: confirmed a player's own-token image change is no longer rejected server-side, confirmed a far-away enemy is absent from "Other tokens in view," and confirmed it appears live once dragged into vision range.

The third item raised alongside these two - polling the character sheet periodically, or pushing an update on save, to resync a token's pulled-in stats after the source character changes mid-session - is a real gap (documented above as "Character-sheet pull-through is a one-time snapshot") but is a design decision, not a bug fix, and wasn't implemented in this pass pending that discussion.

### 2026-07-14 - Character resync polling (interim, pending a real push-based system)
User confirmed a real push-based realtime system is wanted eventually, but asked for polling now since it's more effective for current POC purposes - a smaller, self-contained change that doesn't depend on building out the separate, not-yet-real realtime layer.

Implemented as `syncOwnedCharacterTokens()` in `static/vtt-app/main.js`: every 30 seconds, for each of the player's own tokens carrying a `characterId`, re-fetches `GET /vtt/api/characters/[id]` and pushes any changed field through the existing `token:stat:update` event. Deliberately excludes `hp` and `spellSlots` from the synced field set - both are VTT-session-authoritative once a token exists (current combat HP, spent spell slots), so a poll tick landing mid-fight must not silently overwrite them with the sheet's at-rest values; only reference data (`ac`, `saves`, `actions`, `preparedSpells`, base `speedFt`, all four vision fields, `maxHp`) is synced. Required adding those same fields (plus `speedFt`, which turned out to already be missing - see below) to `PLAYER_EDITABLE_FIELDS` in `vtt/server/handlers/token.js`, on the reasoning that a player pushing their own character's derived reference data onto their own token is the same trust boundary `token:add` already extends, not a new risk.

**A third instance of the same regression class as the `imageUrl` bug fixed earlier today** was caught during this work, before it could be reported: players can already edit their own token's base **Speed (ft)** field via the existing sidebar input (`wirePlayerSidebar`'s `speedInput` handler, pre-dating Phase 2), but `speedFt` had never been added to `PLAYER_EDITABLE_FIELDS` either. Found by auditing every pre-existing player-facing `token:stat:update` call site before assuming the allowlist was complete, rather than waiting for a fourth bug report. Fixed alongside the polling-required fields.

**A genuine, separate bug surfaced by the polling verification test itself, not present before Phase 2**: the VTT character-detail route (`src/routes/vtt/api/characters/[id]/+server.ts`) computed AC's equipped-item bonus using `equippedAttackItems()` - the filter meant for "which equipped items are weapon-like enough to show as attack options" (requires `isEquipment`/`damageRolls`/`toHitBonus`/`damageBonus`). A shield or other armor has none of those fields, so it silently never counted toward the VTT's computed AC, even though it correctly does on the actual character sheet (which uses a broader "is this item equipped at all" filter for its own AC calculation). Caught only because the polling test equipped a shield mid-session and checked for the expected AC change - a curl against the API directly confirmed AC stayed at 10 instead of 12. Fixed by extracting the sheet's broader filter as a new shared `equippedItems()` in `dnd5e.ts` (used for the AC bonus sum) and keeping `equippedAttackItems()` only for the actions list; `CharacterSheetForm.svelte`'s own inline copy of the same broader filter was also switched to call the new shared function, for consistency now that both need it.

All three fixes verified via a headless-browser script: created a token from a character, simulated in-session combat damage (HP dropped client-side to a value the sheet doesn't know about), equipped a shield on the character mid-session via a direct DB update (simulating an out-of-session gear change), waited one poll cycle (~32s), and confirmed both properties held - AC updated from 10 to 12, and HP stayed at the VTT-tracked value rather than being reset to the sheet's stored value.

### 2026-07-14 - Polling clobbered GM-granted temporary vision (user-reported, fixed same day)
User reported: cycling map brightness (dark → bright → dim → dark) caused a player's Darkvision checkbox and the "Advanced Vision" modal to revert to unchecked/0. Initial reproduction attempts (cycling brightness quickly, then with realistic ~95s pacing across multiple poll cycles, on a character with a real test-granted darkvision effect) found no spurious behavior from brightness changes or from the poll running against unchanged data - the poll was stable in isolation. The actual repro only appeared once the user clarified the real sequence: they were the one manually checking the Darkvision box / setting a value in the Advanced Vision modal on the player's token (a legitimate GM action - granting temporary darkvision for an in-fiction spell or potion), and *that* value was what reverted, not something the poll spontaneously produced.

Root cause: the character resync poll added earlier today synced `speedFt`, all four vision fields, and `maxHp` in addition to `ac`/`saves`/`actions`/`preparedSpells` - but unlike the latter four, the former group all have editable controls somewhere in the VTT (the Speed field, the Darkvision checkbox, the Advanced Vision modal, the Max HP field). A GM's manual override of any of these was silently reverted on the very next 30-second poll tick, since the poll always re-applies whatever the source character sheet currently says, with no concept of "this was deliberately changed in-session and shouldn't be touched."

Fixed by narrowing the poll to only ever sync `ac`/`saves`/`actions`/`preparedSpells` - the only fields with genuinely no editable UI anywhere in the VTT. `visionTrueFt`/`visionDevilFt` were also removed from `PLAYER_EDITABLE_FIELDS` (added for the poller in the same pass as this bug, no longer needed now that the poller doesn't touch them; nothing else writes them for a player). Verified via a headless-browser script: GM manually toggles Darkvision on for a player's token, a poll cycle elapses (~35s), and the override is confirmed to survive (still checked) while AC sync for an unrelated, genuinely out-of-session gear change (equipping a shield) still works correctly in the same run.

Separately clarified with the user: this is a data-ownership property, not a transport-mechanism one - a future push-based resync (character sheet save → VTT) would need this exact same exclusion boundary, since the underlying conflict (GM's in-session-only override vs. the sheet's computed value) exists regardless of whether the VTT learns about sheet changes via a 30-second poll or an instant push.

### 2026-07-14 - Dim/dark brightness bands were backwards for darkvision (user-caught)
User question: "why does dim light show darkvision range in grey, and dark light show vision range in color + darkvision range in grey - shouldn't it be the other way around?" Correct on inspection - this traced to the original POC spec's own text, which explicitly allowed "dim: everyone gets grayscale, no color band" as a simplification, without noting that it inverts 5e RAW's actual darkvision rule: *"you can see in dim light... as if it were bright light, and in darkness as if it were dim light. You can't discern color in darkness, only shades of gray"* (PHB). Per RAW, a darkvision creature should get **full color** in dim light (dim = bright, for them) and only **grayscale** in true darkness - the POC's simplified version gave the opposite (zero color in dim, some color in dark), making `dark` accidentally better than `dim` for a darkvision creature when it should be the reverse.

Fixed in `render/vision.js`'s `getTokenVisionRadii()`: `dim` mode's `colorRadius` now scales with `visionDarkFt` (0 if no darkvision, full color out to darkvision range if the token has it) instead of being hardcoded to 0; `dark` mode is unchanged (already RAW-correct: color within normal vision, grayscale beyond via darkvision, matching the "darkness never restores color" rule). Verified two ways: a direct unit-level check of `getTokenVisionRadii()` confirming the exact radii for darkvision/no-darkvision tokens across all three brightness modes (including an explicit "dim gives more color than dark" severity check), and a visual headless-browser test against a real four-color test map, screenshotted in all three brightness modes - `bright` shows color to 30ft, `dim` now shows full color all the way to 60ft (previously would have shown zero color), `dark` shows color to 30ft with grayscale from 30-60ft (unchanged).

### 2026-07-14 - Bright light no longer capped at the token's short indoor vision radius
Follow-up to the same conversation as the dim/dark fix above. User observation: unaided daylight sight isn't capped at a fixed distance in reality (or in 5e RAW) - only darkvision has a defined range - so treating `bright` mode's reveal radius as the same ~30ft `visionNormalFt` used for indoor/dark scenes made outdoor daylight maps feel far more fog-of-war-constrained than the scenario calls for.

Added a `BRIGHT_LIGHT_RADIUS_FT = 150` constant in `render/vision.js`; `bright` mode's `colorRadius` is now `Math.max(normalFt, 150) * pxPerFoot` instead of just `normalFt * pxPerFoot` - a floor, not a replacement, so a token with an unusually large `visionNormalFt` (e.g. from a future homebrew effect) still gets its own larger value rather than being clamped down to 150. `dim` and `dark` are untouched - the token-specific radius is still the meaningful constraint in both, which is exactly where vision *should* matter. Verified via a direct unit-level check (`getTokenVisionRadii` returns 1500px/150ft for a standard 30ft-normal-vision token in bright light, confirmed the 150ft floor doesn't clamp down a token whose own `visionNormalFt` already exceeds it, and confirmed `dim`/`dark` results are unchanged).

150ft is a flat, un-derived number - picked as "large enough to feel like daylight, small enough to still be a number" rather than computed from any rule. Worth revisiting if actual play shows it's too small (very large outdoor maps) or unnecessary (if fog-of-war for bright scenes turns out not to matter enough to warrant a floor at all, vs. just fully unbounded/whole-map reveal).

### 2026-07-14 - Batch token spawning ("make 10 spiders at once")
User request: fill in a token's details once, pick a quantity, get that many copies auto-numbered ("Spider 1", "Spider 2", ...) instead of repeating the whole Add Token form per enemy.

Added a "Quantity" field (default 1, max 50) next to Name in the GM's Add Token form (`static/vtt-app/main.js`). The `addTokenBtn` handler now builds one shared `baseToken` (everything except id/name/x/y) and loops `quantity` times, sending a separate `token:add` per copy with a unique id, name suffixed `" {n}"` only when quantity > 1 (quantity 1 keeps the exact bare-name behavior from before - no regression for the common single-token case), and position arranged in a roughly square grid centered on the map (`Math.ceil(Math.sqrt(quantity))` columns, spaced by `map.gridSizePx`) so a batch of enemies doesn't spawn stacked exactly on top of each other. No new event type or server-side concept - the server already treats each `token:add` independently, so this is purely a client-side loop over the existing event.

Verified via headless browser: quantity=1 still produces a bare "Goblin" token card (no suffix); quantity=10 with name "Spider" produces ten token cards named "Spider 1" through "Spider 10" exactly, visually confirmed arranged in a clean grid rather than stacked.

### 2026-07-14 - Movement-range circles leaked to players for tokens they don't own
User report: players could see the translucent remaining-movement circle for enemy tokens and other players' tokens, not just their own. Root cause: `render()`'s player branch called `drawMovementRange(ctx, visibleTokens, ...)` - every token within the player's vision, rather than being scoped to their own tokens the way vision-masking and the mini-sheet already are.

Fixed by changing that call to `drawMovementRange(ctx, ownedTokens, ...)` - a player now only ever sees the remaining-movement circle for tokens they own, same trust boundary as HP/other tactical information. Also added a GM-only "Show movement ranges" checkbox (new `showMovementRanges` client-side view-preference state, default on, not synced to `session` - purely a local declutter toggle) in the Tokens section of the GM sidebar, gating the GM's own `drawMovementRange` call.

Verified via headless browser with a player-owned PC token and a separate enemy token: player's canvas shows only their own token's movement circle, confirmed the enemy's circle is entirely absent (previously both would have rendered); GM's toggle correctly hides/shows both circles at once when unchecked/checked.

### 2026-07-14 - Hidden tokens render at 50% opacity on the GM's canvas
User request: a visual affordance for the GM to tell at a glance which tokens on the map are hidden from players, without opening each token's card to check the checkbox.

Added `HIDDEN_TOKEN_OPACITY = 0.5` in `render/tokens.js`; `drawTokens()` now sets `ctx.globalAlpha` per-token before drawing (image/fill, border, name label, HP bar/condition badge all affected uniformly, wrapped in an outer save/restore around the existing per-token drawing so it doesn't leak into the next token's alpha). No role-branching needed - hidden tokens never reach a player's client at all (`filterSessionForRole` strips them entirely), so this function only ever sees `hidden: true` tokens when called from the GM's own render path.

Verified visually via headless browser: a hidden enemy token renders clearly faded (muted color, dimmer name label) next to a normal, fully-opaque enemy token of the same type.

### 2026-07-14 - Raw HP no longer shown for any non-owned token, not just enemy/npc
Follow-up to a user report while testing the vision fix: "Other tokens in view" was showing exact HP numbers (e.g. "HP 1000/1000") for other players' PC tokens. This was working as originally spec'd - the POC spec's Section 3 explicitly says "HP isn't secret info in most games" for PC-to-PC visibility, so the server never strips PC stats the way it strips enemy/npc stats - but the user decided they'd rather not show raw HP for anything that isn't the viewer's own token, PC or otherwise, and simplify to one consistent rule.

This is a client-side display change, not a protocol/security one - the server still sends real PC stats to all players (unchanged, still matches the spec's data model), the client just chooses not to display them for tokens it doesn't own. Two places needed the same treatment:
- `otherTokenListHtml()` in `main.js` - dropped the `hasStats` branch entirely, now always shows `condition` (if the GM has set one) or "No status known," regardless of token type.
- `drawTokens()` in `render/tokens.js` - gained a `viewerId` parameter (`null` for the GM, meaning "show every token's real bar"; the viewing player's own id otherwise). The on-canvas HP bar now only renders for a token if `viewerId === null || token.ownerId === viewerId`; everything else falls back to the condition badge, same rule as the sidebar list. Both `render()` call sites updated (`null` for the GM branch, `playerId` for the player branch).

Verified via headless browser with two separate players (Alice, Bob) each owning their own PC token: Alice's sidebar list shows "No status known" for Bob's token (previously would have shown his exact HP), and Alice's canvas shows a real HP bar over her own token but none over Bob's; the GM's canvas still shows real bars for both, confirming the GM's view is unaffected.

### 2026-07-14 - Standard 5e status conditions (Poisoned, Prone, etc.)
User request: a way to track the standard 5e status conditions on tokens, via a modal with checkboxes.

Added as a genuinely new field, not an extension of the existing one - `token.conditions` (a plural array, e.g. `['poisoned', 'prone']`) is entirely separate from the pre-existing singular `token.condition` (the GM's coarse "healthy"/"bloodied"/"critical" HP-severity signal). The two serve different purposes and have different cardinality: conditions genuinely stack in 5e (a creature can be both Poisoned and Prone at once), while the health signal is a single mutually-exclusive value. Conflating them would have broken the single-select health dropdown the moment two conditions were needed simultaneously.

Visibility: conditions are treated as observable battlefield state, not secret like HP - `filterTokenForPlayer` already only strips `stats` from enemy/npc tokens (confirmed by reading `vtt/server/store.js`), so the new field passes through unfiltered for every token type with no server-side change needed. Editing follows the existing ownership rule: `conditions` was added to `PLAYER_EDITABLE_FIELDS` in `vtt/server/handlers/token.js` (a player can toggle conditions on their own token - "I just got poisoned by a trap" is the same self-service pattern as tracking their own HP) and to `TOKEN_LEVEL_STAT_FIELDS` in both the server and client (a top-level token field, not nested under the free-form `stats` bucket).

Client: a new `conditionsModal` (`static/vtt-app/index.html`) with checkboxes for the 14 standard 5e conditions (Blinded, Charmed, Deafened, Exhaustion, Frightened, Grappled, Incapacitated, Invisible, Paralyzed, Petrified, Poisoned, Prone, Restrained, Stunned, Unconscious - hardcoded list, not configurable, matching POC scope), generated dynamically rather than hand-written per checkbox. A "Conditions…" button was added to both the GM's token card (any token) and a player's own token card (their own only), opening the same modal; saving sends one `token:stat:update` with the full checked array. A small `conditionTagsHtml()` helper renders the active list as read-only tags, reused in the GM card, the player's own card, and the "Other tokens in view" list (all three contexts, since none of them are secret).

Canvas: `drawTokens()` in `render/tokens.js` gained `drawConditionsRow()` - a compact row of 3-letter abbreviations (e.g. "POI PRO") drawn above the token, positioned above the HP bar/health-condition badge so it can coexist with either.

Verified via headless browser: GM sets Poisoned + Prone on a hidden-stats enemy token, confirms both tags show on the GM's card and the canvas renders "POI PRO"; confirms a player (whose session never receives that enemy's `stats`) still sees "Poisoned Prone" in their "Other tokens in view" list, proving the new field isn't accidentally being stripped alongside `stats`; confirms a player can independently set a condition on their own token via the same modal.

### 2026-07-15 - Phase 2.5: attack flow fixed, roll logic unified server-side
Implements [`.claude/briefs/vtt-phase-2.5-attack-flow-fix-spec.md`](../.claude/briefs/vtt-phase-2.5-attack-flow-fix-spec.md) - see the Phase 2.5 section above for the full write-up. Short version:

- **Diagnosis first (spec Section 0)**: the "clicking does nothing" report was root-caused, with the user against a live session, to the mini-sheet showing "No equipped weapons" (nothing to click) because the character's weapon wasn't flagged equipped - not a broken handler. The old flat client-side roll did fire once a weapon was equipped.
- **Refactor**: extracted `rollBattleAction`/`rollText`/`rollDamageExpression` verbatim from `CharacterSheetForm.svelte` into a new pure shared module `src/lib/rules/attackRoll.ts`; the sheet now delegates to it (thin wrappers, no behaviour change - confirmed by `svelte-check` 0/0 and a deterministic parity test reproducing the sheet's exact "Pokey Sword" Poisoned+Bless breakdown).
- **New endpoint**: `POST /vtt/api/characters/[id]/roll-attack` (ownership-scoped) loads the live character and runs the shared `rollAttack()` - the only place the VTT can get the full modifier-driven roll, since the vanilla client can't import `$lib` and the token only carries a flattened action.
- **New client flow** (`main.js`/`index.html`/`style.css`): arm (weapon-named banner + yellow valid-target rings) → click target → **confirm card with explicit Attack button** → server roll → visible to-hit + damage breakdown identical to the sheet → apply via existing `delta` path. Hit/miss shown only when the client legitimately knows the target's AC (never fabricated/leaked for a hidden-AC enemy); no damage sent on a determined miss. The old standalone `rollDamageDice()` and its instant-resolve `alert()` are gone.

**Verification: automated only.** `svelte-check` 0/0, deterministic roll-parity test, dev server boots + endpoint registered/auth-gated. **The live GM+player two-browser click-through of the actual attack flow (arm → target → confirm → roll → hit/miss → damage) is still outstanding** - deliberately NOT marked verified, per this spec's whole reason for existing. (Production access itself was separately blocked and then fixed - see the 2026-07-15 infra changelog entry below - but that only confirms the deploy is reachable and current, not that this flow works end to end once clicked through.) Phase 3 Section 2a's "identical to weapon attacks, already verified" pointer is left untouched until that live click-through passes (spec Section 3).

**A note on the recurring "verified" trust gap**: the spec asked what "verified" meant when the Phase 2 doc claimed this path worked. Answer, on inspection: Phase 2's verification drove the data/event layer (WS scripts, headless data checks), never a real two-client UI click on the actual mini-sheet action → canvas target sequence, so a "No equipped weapons" empty state (and any pure-UI break) was invisible to it. Future phases: a claim of "verified" for a UI-triggered flow should mean a real click-through, not a data-layer proxy for one.

### 2026-07-15 - Editable AC on all tokens, server-side hit/miss with AC discovery, DM manual attacks
User follow-up to the Phase 2.5 attack flow, three interlocking asks: (1) AC on all tokens, editable - player AC derived at creation but then player-editable; (2) the DM able to run the same attack flow for enemy/NPC tokens; (3) enemy AC hidden from players but *discoverable through play*.

- **Editable AC**: the player mini-sheet AC field is now editable (was read-only) and `ac` was removed from the 30-second resync poll's field set - it now has an in-VTT editable control, so polling it would revert a manual change on the next tick (the exact clobber the vision/speed fields hit before; the poll's exclusion rule is "if a human can edit it in the VTT, the poll must never touch it"). The GM's Add Token form and each GM token card gained an AC input. True AC lives top-level (`token.ac`) for both PCs and enemies; `filterTokenForPlayer` now strips `ac` (alongside `stats`) for enemy/npc tokens, and `token:stat:update` treats `ac` as a sensitive field for enemy/npc so its value never rides out on the event either.
- **Server-side hit/miss + AC discovery** (new `attack:resolve` WS event, handled in `vtt/server/handlers/token.js`): the client rolls to-hit/damage (shared module, as before) but no longer decides hit/miss - it sends the roll to the server, which alone knows the target's hidden AC. The server computes hit (crit auto-hits, fumble auto-misses, no-AC-set auto-hits), applies damage on a hit, and replies with an `attack:result` carrying only hit/miss + the *rolled* damage (never the capped applied amount, which would leak exact remaining HP on an overkill, and never the AC). AC discovery: on a hit that genuinely cleared AC, the server records the *lowest* such roll as the token's `knownAc` and broadcasts it to everyone - rendered under the token as `AC ≤ X`, a bound players tighten through play (swing 16 and hit → shows 16; later swing 14 and hit → shows 14). A crit that auto-hit below AC deliberately does **not** update the bound. `knownAc` is top-level so it survives the player filter, distinct from the stripped true `ac`.
- **DM manual stat-block attacks**: since enemies aren't full characters, each GM token card has a small attacks editor (name + to-hit + damage dice, stored in the token's `actions` array). Clicking a row arms the same targeting/confirm/roll/resolve flow a player's weapon uses; the roll goes through a new `POST /vtt/api/roll-manual` (reusing a new `rollManualAttack()` in the shared module - a plain `d20 + toHit` / `damage` roll with no modifier graph, same result shape and display as a character attack). `resolveAttack()` picks the character endpoint when the source token has a `characterId`, the manual endpoint otherwise.

**Verification: automated only, live check still owed** (same discipline as the Phase 2.5 entry above). `svelte-check` 0/0 across 440 files, all vanilla-JS files pass `node --check`, dev server boots clean. **Not yet exercised live**: GM sets an enemy AC → player attacks and cannot see the AC, only discovers `AC ≤ X` on a hit; a miss reveals nothing; the DM adds a manual attack on an enemy token and attacks a PC; the AC-discovery bound tightens correctly across several hits. Handed to the user for the two-browser click-through - still outstanding as of the 2026-07-15 infra fixes below (those fixes made the *deploy* reachable/current; they did not exercise this feature's actual click-through).

### 2026-07-15 - Production infra: stale-deploy edge caching, and large map uploads silently rejected
Two separate production-only bugs, both hit while the user tried to live-verify the attack-flow work above - neither is a VTT logic bug, both are `server.js`/hosting-layer issues that happened to surface at the same time.

1. **Deploys weren't showing up.** Diagnosed by fetching the deployed `main.js` two ways: the plain URL returned a stale 2026-07-14 build (missing even Phase 2 features), while `main.js?v=<random>` returned the current 2026-07-15 build - proof the origin had the right file and a URL-keyed edge cache (Railway fronts requests with Cloudflare, which caches `.js`/`.css` by extension) was serving a stale copy. Root cause: `static/vtt-app/*` (`index.html`, `main.js`, `style.css`, `render/*.js`) are plain, unhashed filenames that never change between deploys, served with no `Cache-Control` header - unlike SvelteKit's own hashed `/_app/immutable` assets, which are safe to cache forever precisely because their names *do* change per build. Fixed in `server.js` by setting `Cache-Control: no-cache` on every `/vtt-app` request, forcing revalidation on each load. **User confirmed fixed after deploying.**
2. **Large map/token image uploads silently failed** (a 230KB image uploaded fine, a 3.12MB map did not) despite the upload route's own 15MB limit. Root cause: `@sveltejs/adapter-node` caps every request body at `BODY_SIZE_LIMIT` (default 512KB, read once at module load) and rejects anything larger *before* it reaches the route - a production-only ceiling (`vite dev` has no such cap, which is why the same large map "always worked" in local testing). Fixed in `server.js` by setting `process.env.BODY_SIZE_LIMIT = '20M'` before dynamically importing the handler module (must happen pre-import, since the limit is read once at that module's top level). **User confirmed fixed after deploying.**

Both fixes live in the same `server.js`, committed separately (`1e96fb3`, `d3b17d2`) since they're independent root causes that happened to be diagnosed back-to-back. No VTT feature code changed in either fix.

Known limitation, noted rather than addressed: Exhaustion is 5e's one condition with levels (1-6) rather than being binary - it's tracked here as a simple on/off checkbox like the other 13, not a level counter. Fine for the POC; revisit if exhaustion tracking in practice needs the granularity.