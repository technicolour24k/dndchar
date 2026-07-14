# VTT POC - Current State

Living document. Structured as a diff against [`.claude/briefs/vtt-poc-spec.md`](../.claude/briefs/vtt-poc-spec.md) - read that first if you haven't. Each spec section below is marked:

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
- GM claim: `if (meta.role === 'gm' && !session.gmSocketId) session.gmSocketId = playerId || 'gm'` - first GM claim wins, matching spec's "whoever connects first as GM claims the role, no auth needed."

**Deviation worth flagging**: `gmSocketId` is written once and never read again anywhere in the codebase (confirmed by grep). Nothing rejects a *second* client claiming `role: 'gm'` on an already-GM'd session - they'd get full GM broadcast privileges too. The spec's phrasing ("claims the role") implies later claims should be turned away; in practice they aren't. Low-stakes for a trusted-group POC, but worth knowing before extending anything that assumes "there is exactly one GM."

**🔁 Real deviation from spec's assumed standalone flow**: joining now goes through the app's account system. `/vtt` (`src/routes/vtt/+page.server.ts`) is an authenticated SvelteKit route that redirects to the static client with `?playerId=&playerName=` pre-filled from the logged-in user, so nobody types a name manually when arriving via the nav link. Opening `/vtt-app/index.html` directly still works with manual entry + a random per-browser id, which is how the spec originally envisioned it and remains useful for quick multi-tab testing.

**How to verify**: log in, click **VTT** in the nav, note the room code in the sidebar. Open a second browser (or a different logged-in account) and join with that code - confirm `player:joined` fires (visible in the first tab's sidebar player list and in devtools WS frames). Try a bogus code in a third tab and confirm `join:error`. Kill and reopen a tab's connection with the same code to confirm reconnect replays `state:full` correctly.

---

## 3. Core Event Types - 🔁 5.5 of 6, plus one net-new family

All handlers live in `vtt/server/handlers/{token,map,marker}.js`, dispatched from a switch in `wsServer.js`, following the spec's validate→mutate→broadcast(filtered) pattern with no per-feature bespoke plumbing.

| Event | State | Notes |
|---|---|---|
| `map:set` | ✅ | GM-only gate (`meta.role !== 'gm'` → reject). Broadcasts unfiltered - matches spec (map has no secret fields). |
| `token:add` | ✅ | GM-only. Filtered per-recipient. |
| `token:remove` | ✅ | GM-only. A hidden token's removal is invisible to players who never knew it existed. |
| `token:move` | ✅ | GM (any token) or player (`canEditToken`: `token.ownerId === meta.playerId`) - matches spec's payload shape exactly. |
| `token:stat:update` | 🔁 | GM (any) or owning player - but **not field-limited**, see caveat below. |
| `token:hidden:toggle` | 🔁 | GM-only. Improves on the spec's literal wording - see snippet below. |
| `fog:reveal` / `fog:hide` | ⛔ | Not implemented - no handler, no client code. Spec explicitly marked this optional ("if doing manual fog on top of vision") and no milestone exercises it, so this is a deliberate skip, not an oversight. |

**`token:stat:update` caveat**: spec says players get "limited fields." The actual `canEditToken` check only verifies ownership, not which `stat` key is being written - an owning player can currently overwrite *any* field on their own token, including `visionNormalFt`/`speedFt`/etc. This is presently intentional and used (players self-adjust their own vision/speed in the sidebar), but there's no explicit allowlist distinguishing "safe for a player to self-edit" from "should stay GM-only even on the player's own token." Nothing currently needs that distinction - flag it if a future feature (e.g. GM-locked stat blocks) needs it.

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

`map.brightness` handling matches the three spec-defined modes:

```js
if (brightness === 'dim') {
  colorRadius = 0; grayRadius = maxFt * pxPerFoot;                // no color band
} else if (brightness === 'bright') {
  colorRadius = normalFt * pxPerFoot; grayRadius = colorRadius;   // no gray band
} else { // 'dark'
  colorRadius = normalFt * pxPerFoot;
  grayRadius = darkFt > normalFt ? darkFt * pxPerFoot : colorRadius;
}
```

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

---

## 6. File/Component Map

Deliberately doesn't match the spec's proposed `/server` + `/client` tree - the app is SvelteKit, not a standalone Node process, so the spec's flat layout got adapted to fit inside it while keeping the same conceptual split (server/client/handlers/render).

```
vtt/server/                              plain untyped JS (@ts-nocheck) - see below for why
  store.js                                 session shape, generateRoomCode, filterSessionForRole, broadcast()
  wsServer.js                              attachVttWebSocketServer(httpServer) - 'upgrade' handling + event dispatch
  tokenLibrary.js                          indexes the bundled Forgotten Adventures token art pack
  handlers/
    join.js                                join / state:full / player:joined / join:error
    token.js                                add / remove / move / stat:update / hidden:toggle
    map.js                                  map:set
    marker.js                               marker:add / remove / visibility:toggle  - NOT in spec

src/routes/vtt/                          SvelteKit HTTP surface, auth-gated by hooks.server.ts
  +page.server.ts                          redirects to the static client with ?playerId=&playerName= from the account system
  api/session/+server.ts                   POST → creates room, returns { sessionId }  (spec's POST /session/create)
  api/upload/+server.ts                    POST multipart image → data/vtt-uploads/    - NOT in spec
  api/uploads/[filename]/+server.ts        GET, serves an uploaded image back           - NOT in spec
  api/token-library/+server.ts             GET, JSON index of bundled token art          - NOT in spec
  api/token-library/[...path]/+server.ts   GET, serves a bundled token image             - NOT in spec

static/vtt-app/                          the actual client - served as static files, bypasses SvelteKit auth (see Section 9)
  index.html, style.css
  main.js                                  WS connection, join flow, sidebar UI, canvas drag, zoom/pan, image/token pickers
  render/
    map.js                                 base map + grid
    tokens.js                              token sprites, HP bars, condition badges
    vision.js                              per-player radius vision mask
    movement.js                            remaining-movement radius overlay  - NOT in spec
    markers.js                             AoE/point marker rendering          - NOT in spec

vite.config.ts                           dev-mode plugin: attaches the VTT WS server to Vite's http.Server
server.js                                prod entry point: wraps adapter-node's handler, attaches the VTT WS server
svelte.config.js                         defines the `$vtt` alias → vtt/server, so SvelteKit routes can import the plain-JS module
assets/images/tokens/Forgotten_Adventures_Tokens/   1,436 bundled token images (committed to repo, served at runtime - see Section 10)
```

**Why `vtt/server/*.js` is untyped JS living outside `src/`**: it has to be imported unmodified from three different contexts in the same process - SvelteKit's bundled `+server.ts` routes (via the `$vtt` alias), the Vite dev plugin, and the production `server.js` entry point. Keeping it as plain `@ts-nocheck` JS sidesteps build/type friction across those three load paths. This is the biggest structural deviation from the spec's proposed layout, and it's a direct consequence of merging what the spec imagined as a standalone process into the main app's single server/port (see `vtt/README.md`'s architecture note - the WS server used to be its own Express+ws process and was folded in).

---

## 7. Explicit Exclusions (spec'd, deliberately skipped)

- **`fog:reveal`/`fog:hide`** - spec marked this optional from the start ("if doing manual fog on top of vision - optional for POC"), and no milestone exercises it. Skipped, not forgotten.
- **Campaign-linked player rosters** (spec Section 8 future direction) - correctly deferred, not built. `playerId` is still passed explicitly on `join` per the spec's own forward-compatibility note, so swapping in roster validation later shouldn't require reworking the event shape.
- **Player-driven damage application / targeting** (spec Section 8 future direction) - correctly deferred.
- **Mini character sheet in-VTT** (spec Section 8 future direction) - correctly deferred; spec explicitly gated this on the character sheet math engine being further along.
- **WS handshake auth** - spec explicitly out of scope for the POC. Still true: the socket trusts whatever `playerId`/`role` a client states. Real identity now flows in via the account system for anyone arriving through the nav link (Section 2), but nothing stops a client from hand-crafting a `join` with `role: 'gm'` or someone else's `playerId` directly against `/vtt-ws`. Same posture spec asked for, worth remembering before this app is ever exposed outside a trusted group.

---

## 8. Features Beyond the Spec

None of these were requested by the spec; all were added during implementation because they made the POC materially more usable for actually running a session.

- **Marker/AoE placement** (`marker:add/remove/visibility:toggle`) - players and GM can drop circular markers (spell templates, points of interest) on the map, private to owner+GM by default with a GM togglable "visible to all." New session collection (`markers`), own filter logic (`shouldPlayerSeeMarker`) mirroring the token-hiding pattern.
- **Movement range visualization** - `speedFt`/`speedRemainingFt` fields, `+5/-5/Reset` sidebar controls, a translucent remaining-movement radius (`render/movement.js`), and a live drag-distance readout that turns red when a drag exceeds the token's remaining budget.
- **Forgotten Adventures token library** - 1,436 bundled token images, indexed and served via `GET /vtt/api/token-library`, browsable in an in-app picker (filter by source/category/free text).
- **Image upload pipeline** for both map and token art (`POST /vtt/api/upload`, writes to gitignored `data/vtt-uploads/`, extension/size/mimetype validated, served back with path-traversal protection). Spec explicitly said a hardcoded static URL would be fine and called upload pipelines out of scope - this went beyond that because typing raw URLs turned out to be annoying in practice. Pasting a URL directly still works as a fallback.
- **Truesight / devil's sight vision bands** (Section 4).
- **Zoom & pan** (Section 4).
- **Coarse `condition` badge** - the spec *suggested* this as a way to give players a non-numeric enemy-health signal (Section 5); it's actually built: a GM dropdown (`healthy`/`bloodied`/`critical`) rendered as a colored badge on the player's view of that token.

---

## 9. Known Fragility / Untested Edges

- **No automated tests** for anything under `vtt/` or `static/vtt-app/`. Repo-wide test coverage is limited to `src/lib/server/services/effects.test.ts` and `src/lib/rules/dnd5e.test.ts` - nothing VTT-related, and `vtt/server/*.js` is `@ts-nocheck` so `svelte-check`/`tsc` don't cover it either. Everything here is verified only by manually walking the milestone checklist in `vtt/README.md`.
- **`gmSocketId` is vestigial** (Section 2) - set once, never enforced. A second client can self-declare `role: 'gm'` on an already-claimed session and get full GM broadcast rights.
- **Client-generated token/marker IDs** with no server-side uniqueness check beyond "is an id present" - `session.tokens[token.id] = token` on `token:add` will silently overwrite an existing token if a colliding or malicious ID is sent. Low risk from a trusted GM client, but worth knowing if `token:add` authorization ever loosens.
- **No cleanup on socket close beyond removing the socket itself** - a disconnected player still shows up in the sidebar player list indefinitely and still "owns" their tokens; a GM who drops and never reclaims leaves `gmSocketId` stale (moot, since it's unenforced anyway per above).
- **In-memory schema drift across incremental development** - `main.js` defensively does `session.markers = session.markers || {}` on receipt, implying the marker feature landed after some sessions might already be running. Harmless given no persistence (a restart resets everyone to the current schema), but a pattern to watch if any future feature adds required fields to `tokens`/`players`.
- **Unbounded room-code collision loop** (`generateRoomCode`) - `do {...} while (existingSessions.has(code))` has no retry cap. Not a practical concern at a 33-character alphabet × 6 chars for POC-scale usage, but note it before any load-testing.
- **`vtt/README.md` has drifted from the code** - still lists only `join.js`/`token.js`/`map.js` (missing `marker.js`), doesn't mention `movement.js`/`markers.js`, the token library, or the upload pipeline in its file tree, and its "Known POC gaps" section incorrectly claims "no zoom/pan" (Section 4). This doc supersedes it; the README should be trimmed down to just the "how to run it" section or updated wholesale next time someone's in there.

---

## 10. Follow-Up Priorities

Checked against spec Section 8 ("Future Direction") rather than invented fresh:

1. **Mini character sheet in-VTT** - spec explicitly called this "a fast follow-up immediately after the POC proves out, not a distant future item," gated only on the character sheet's math engine being far enough along. **Re-evaluate this gate now**: given how far the POC has come (marker system, movement tracking, condition badges - real session-usability features already exist that the mini-sheet would naturally sit alongside), check current status of the modifier-primacy migration (`docs/architecture/modifier-primacy-status.md`) to see if the math engine has caught up enough to make this unblockable. This is very plausibly the single highest-value next step, per the spec's own framing.
2. **Campaign-linked player rosters** - spec Section 8, still legitimately future work. The `playerId`-on-`join` shape was kept spec-compliant specifically to make this swap-in easy later; no rework needed to start it.
3. **Player-initiated targeting/damage application** - spec Section 8. The spec notes `token:stat:update` is already generic enough that "player casts fireball, three enemies take damage" is just three of that event sent by a player instead of the GM - the main gap is authorization (currently player writes are ownership-gated to their own tokens only, Section 3) plus a `target:select` broadcast for UI highlighting, which spec describes as a thin pass-through with no new server model needed.
4. **Not in the spec, but surfaced by this audit** - closing two of the fragility items above (Section 9) is cheap and worth bundling into whichever pass touches `join.js`/`wsServer.js` next: enforce `gmSocketId` (reject a second self-declared GM) and clean up departed players/stale GM state on socket close. Neither blocks anything, but both are small and currently silently wrong.
5. **Fog-of-war (`fog:reveal`/`fog:hide`)** - still spec-optional and still unbuilt. No signal from the POC's actual use that this is needed over the radius-vision approach; leave deprioritized unless a real session hits a case radius-vision can't express (e.g. a corridor that should stay dark despite being in radius).

Nothing has come up during implementation that reorders spec Section 8's stated priority (mini-sheet first) - if anything, the amount of session-usability tooling already built (markers, movement, condition badges) makes the mini-sheet a more natural next step than when the spec was written, not less.

---

## Changelog

### 2026-07-14 - Initial audit
First "current state" pass, written after the POC had already accreted markers, movement tracking, the token library, upload pipeline, and zoom/pan beyond the original spec (per git log: `fdee6e0`, `a7a90cb`, `5132f2b`, `d60f1e9`, `c296b9a`). Audited by reading `vtt/server/`, `src/routes/vtt/`, `static/vtt-app/`, and cross-checking `vtt/README.md` (found stale in two places - missing files in its tree, incorrect zoom/pan claim). No code changes made in this pass - documentation only.