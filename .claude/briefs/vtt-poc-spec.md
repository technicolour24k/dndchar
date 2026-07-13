# VTT Proof-of-Concept — Technical Spec

## Goal

Build a minimal, real-time virtual tabletop (VTT) proof of concept to validate:
1. WebSocket-based room/session sync between a GM and multiple players.
2. Server-authoritative session state with correct reconnect/resync behaviour.
3. Radius-based per-token vision (normal sight + darkvision), rendered per-player, with no wall/line-of-sight geometry.

This is a POC, not a product. Favor the simplest thing that proves the pattern works over robustness, auth, or polish. In-memory state is fine; no database is required for this phase.

## Stack

- **Runtime**: Node.js
- **Transport**: WebSockets (use the `ws` library directly — no need for Socket.IO for a POC this small)
- **Hosting**: Railway (persistent process, so raw WebSockets work fine)
- **Frontend**: Plain HTML5 Canvas + vanilla JS (no framework needed for POC; avoid React/build tooling overhead for this phase)
- **State storage**: In-memory JS object per session, on the server process. No persistence/database in this POC.

## Out of scope (explicitly, for this POC)

- Full auth integration (assume players are already logged in via the existing app/session; this POC just needs a `playerId`/`playerName` passed in — see Section 2a)
- Campaign-linked player rosters (GM pre-adding known players to a session before it opens) — noted as a future direction in Section 2a, not built now
- Wall-blocking / true line-of-sight geometry
- Character sheet integration (this is being built separately)
- Status effects / auto-applying conditions
- Persistence across server restarts
- Mobile-responsive UI
- Map image upload pipeline — a hardcoded static image URL is fine

---

## 1. Session Model

One **session** = one game session, identified by a short session ID (e.g. `ABCD12`, generated on creation).

Server holds one in-memory object per active session:

```js
session = {
  id: "ABCD12",
  gmSocketId: "socket-abc",
  map: {
    imageUrl: "/maps/dungeon1.png",
    widthPx: 1600,
    heightPx: 1200,
    gridSizePx: 50,       // pixels per grid square
    brightness: "bright", // "bright" | "dim" | "dark" — affects vision rendering
  },
  tokens: {
    "token-1": {
      id: "token-1",
      ownerId: "player-1",   // which player controls it; null/undefined for NPC/enemy
      name: "Grognak",
      type: "pc",             // "pc" | "npc" | "enemy"
      x: 400,                 // pixel position on map
      y: 300,
      imageUrl: "/tokens/barbarian.png",
      visionNormalFt: 30,
      visionDarkFt: 60,        // 0 if no darkvision
      hidden: false,           // GM-only visibility toggle, independent of fog/vision
      stats: {
        hp: 45,
        maxHp: 52,
        // free-form for POC; sheet integration comes later
      }
    }
  },
  players: {
    "player-1": { id: "player-1", name: "Tony", socketId: "socket-xyz", tokenIds: ["token-1"] }
  }
}
```

Sessions live only in server memory — restarting the process loses all sessions. That's acceptable for this POC.

---

## 2. Room Creation & Join Flow

Players are assumed to already be logged in via the existing app (character sheet system), so the POC doesn't need to build auth from scratch — it just needs a `playerId`/`playerName` handed to it from whatever login state already exists client-side. What the POC *does* need to build is room creation and the join-by-code flow.

### Creating a room (GM)

1. GM hits `POST /session/create` (plain HTTP, not WS — happens before any socket connects).
2. Server generates a short room code (e.g. 6 chars, uppercase alphanumeric, collision-checked against currently active in-memory sessions), creates the empty `session` object keyed by that code, and returns it.
3. GM's client then opens the WebSocket and sends `join` with `role: gm` and the code.

```json
// POST /session/create → response
{ "sessionId": "ABCD12" }
```

Room codes only need to be unique among *currently active* sessions (server restart wipes everything anyway, per Section 1) — no persistence or expiry logic needed for the POC.

### Joining a room (player)

Player already has `playerId`/`playerName` from existing login state. They enter the room code (shared verbally/via chat/whatever — out of scope) and their client opens a WebSocket, sending `join` with that code, `role: player`, and their identity.

### Connection & Join Flow (both roles)

1. Client connects via WebSocket to `wss://<host>/ws`.
2. Client immediately sends a `join` event, including the room code from creation (GM) or manual entry (player).
3. Server validates the room code exists as an active session. If not, respond with an error and close — only `POST /session/create` should create sessions, so GM stays the sole originator.
4. Server responds with the **full current session state** (not a diff) — same code path whether it's a brand-new join or a reconnect after a dropped connection. This single decision eliminates most "special case" resync bugs.
5. Server adds the client to the session's broadcast list and tags the socket with `sessionId`, `playerId` (or `role: gm`).

### `join` (client → server)
```json
{
  "type": "join",
  "sessionId": "ABCD12",
  "role": "gm",            // "gm" | "player"
  "playerId": "player-1",  // from existing login state; omit/ignore if role is gm
  "playerName": "Tony"
}
```

### `join:error` (server → client, if room code invalid)
```json
{ "type": "join:error", "reason": "session_not_found" }
```

### `state:full` (server → joining client only)
```json
{
  "type": "state:full",
  "session": { /* full session object as above, but filtered — see Section 5 */ }
}
```

### `player:joined` (server → everyone else in session)
```json
{ "type": "player:joined", "playerId": "player-1", "playerName": "Tony" }
```

If a GM reconnects, they resume `role: gm` for that session. For POC purposes, whoever connects first as GM claims the role — no auth needed.

---

## 3. Core Event Types

All state-changing actions follow one pattern: **client sends an intent event → server validates + mutates in-memory state → server rebroadcasts the same (or filtered) event to the room.** This is the only pattern you need for all six actions below; don't build bespoke handling per feature.

| Event | Direction | Who can send |
|---|---|---|
| `map:set` | client → server → broadcast | GM only |
| `token:add` | client → server → broadcast | GM only |
| `token:remove` | client → server → broadcast | GM only |
| `token:move` | client → server → broadcast | GM (any token) or player (own tokens only) |
| `token:stat:update` | client → server → broadcast (filtered) | GM (any) or player (own, limited fields) |
| `token:hidden:toggle` | client → server → broadcast (filtered) | GM only |
| `fog:reveal` / `fog:hide` | client → server → broadcast | GM only |

### Example payloads

**`token:move`**
```json
{ "type": "token:move", "tokenId": "token-1", "x": 420, "y": 310 }
```
Server validates: does this tokenId exist, does the sender own it (or is GM)? Updates `session.tokens[tokenId].x/y`. Broadcasts identical event to all clients in session.

**`token:stat:update`**
```json
{ "type": "token:stat:update", "tokenId": "token-1", "stat": "hp", "value": 38 }
```
Server updates `session.tokens[tokenId].stats[stat]`. Broadcast to all — HP isn't secret info in most games, but see Section 5 for the hidden-token case.

**`token:add`** (GM only)
```json
{
  "type": "token:add",
  "token": { "id": "token-2", "name": "Goblin", "type": "enemy", "x": 100, "y": 100,
             "visionNormalFt": 60, "visionDarkFt": 0, "hidden": true, "stats": { "hp": 7, "maxHp": 7 } }
}
```

**`token:remove`**
```json
{ "type": "token:remove", "tokenId": "token-2" }
```

Every mutating event follows this shape: server is the only thing that actually writes to `session` state. Clients render optimistically if you want snappier UX later, but for the POC, simplest is: client sends intent, waits for server broadcast, renders on broadcast receipt (including to itself). This avoids state divergence entirely and is worth keeping even after the POC.

---

## 4. Vision & Blackout Rendering (radius-based, no walls)

This is computed **per player**, not per token, and not on the server — send raw token/vision data to clients and let each client compute its own masked view. The server doesn't need to know about rendering.

### Per-player visible token set

For a given player, their visible area is the **union** of vision circles from all tokens they own (`tokenIds` on the `players` map). If a player controls two tokens, both contribute.

### Per-token vision bands (client-side canvas rendering)

For each of the player's own tokens, convert feet to pixels using `map.gridSizePx` (assume standard D&D: 1 grid square = 5ft, so `pxPerFoot = gridSizePx / 5`):

- **0 to `visionNormalFt`**: full color, fully revealed.
- **`visionNormalFt` to `visionDarkFt`**: grayscale/desaturated (darkvision band). If `visionDarkFt` is 0 or equals `visionNormalFt`, skip this band.
- **Beyond `visionDarkFt`**: black (unrevealed).

Rendering approach: draw the full-color map to an offscreen canvas, then composite a radial mask on top using canvas `globalCompositeOperation` — two concentric radial gradients (or hard-edged circles for POC simplicity, no need for soft falloff yet) per token, unioned via `lighter` or by drawing all token masks into one mask layer first.

### Ambient light interaction

`map.brightness` shifts the whole calculation:
- `"bright"`: everyone sees in full color everywhere within `visionNormalFt` — darkvision is irrelevant, no gray band.
- `"dim"`: treat as visible in gray band even within `visionNormalFt` for tokens without darkvision (POC can skip nuance here — treat dim as "everyone gets grayscale within normal vision" if easier).
- `"dark"`: full logic as described above (normal=color, darkvision=gray, beyond=black).

For the POC, hardcode `brightness` per map and don't build a UI toggle yet unless it's trivial — the point is proving the vision-circle rendering works.

### What the GM sees

GM always sees the full map, unmasked, all tokens (including `hidden: true` ones), regardless of vision. Vision masking is a player-only concept.

---

## 5. Filtering: what gets sent to whom

Two things are hidden from players and must be filtered server-side before broadcast, not just hidden by the client UI (never trust the client to hide GM secrets):

1. **Tokens with `hidden: true`** — omit from `state:full` and from any broadcast event entirely when sending to player sockets. Only include in the payload sent to the GM socket.
2. **Enemy/NPC stats, always** — players never receive `hp`/`maxHp`/`stats` for any `enemy` or `npc` token, visible or not. Only the GM socket gets real numbers. If players need *some* visual signal (e.g. a health bar), that has to be a coarse, GM-controlled indicator (e.g. `condition: "healthy" | "bloodied" | "critical"`, set explicitly by the GM alongside HP edits) rather than the raw number — never derive it automatically from HP, since that reintroduces exact values back into player-visible state through the back door.

Implementation: maintain one canonical `session` object server-side, but write a small `filterSessionForRole(session, role, playerId)` function used both for `state:full` on join and for filtering any broadcast that includes token data. For player role, this function should strip `stats` entirely from any `enemy`/`npc` token (replacing with the coarse `condition` field only, if present) and drop `hidden: true` tokens outright. This is the one function to get right — everything else reuses it.

---

## 6. Minimal File/Folder Structure

```
/server
  index.js          — WS server bootstrap, session map, connection handling
  session.js         — session state shape, filterSessionForRole()
  handlers/
    join.js
    token.js          — add/remove/move/stat:update/hidden:toggle
    map.js            — map:set
    fog.js            — reveal/hide (if doing manual fog on top of vision — optional for POC)
/client
  index.html
  main.js             — WS connection, event send/receive, render loop
  render/
    map.js            — draw base map
    tokens.js          — draw token sprites
    vision.js           — compute + draw vision mask per player
```

No build step needed — plain script tags are fine for a POC.

---

## 7. Suggested POC Milestones (in order)

1. **Room creation + WS plumbing**: `POST /session/create` returns a room code, GM client connects and joins with it, server responds with `state:full`. Then have a second client join with that same code as a player, and a third attempt with a bogus code to confirm `join:error` fires. Prove reconnect works (kill/reopen the WS with the same code, confirm state comes back correctly).
2. **Map + tokens render**: static map image, hardcoded tokens array, canvas draws them at their x/y.
3. **`token:move` round-trip**: drag a token on one client, confirm it moves on a second client (open two browser tabs, one as GM one as player).
4. **`token:add` / `token:remove`**: GM can spawn/despawn tokens live.
5. **`token:stat:update`**: edit HP on GM view, confirm player view updates.
6. **Hidden token filtering**: add a `hidden: true` enemy, confirm player client never receives it (check network tab, not just UI — the point is testing the server-side filter).
7. **Vision rendering**: implement the radius-based mask for a single player token, no darkvision band yet — just full color circle, black beyond.
8. **Darkvision band**: add the second radius/grayscale ring.
9. **Multi-token union**: give one player two tokens, confirm vision is the union not just the last-moved token.

Steps 1–3 prove the hard part (sync + reconnect). Steps 7–9 prove the vision concept you specifically asked about. Everything in between is comparatively mechanical.

---

## 8. Future Direction (not built now, noted for context)

Post-POC, GMs should be able to pre-populate a session with a known player roster tied to a campaign (from the existing character sheet system) rather than relying purely on an open room code — e.g. GM selects "Tuesday Night Campaign," the players linked to that campaign are pre-listed, and joining validates against that roster instead of (or in addition to) the code. This POC's room-code join is intentionally a stepping stone toward that, not a dead end — keep `join` taking an explicit `playerId` (rather than inferring identity purely from the socket) so swapping the validation logic later doesn't require reworking the event shape.

Post-POC, players should be able to interact directly with enemy/NPC tokens rather than only the GM editing HP — e.g. a player selects a target token (or an AoE spell auto-highlights all tokens caught in its area) and the resulting damage/heal is applied automatically, sourced from the character sheet's math engine rather than typed in by hand. Since players never see enemy HP at all (Section 5), this doesn't change the visibility rule — the damage calculation and application can happen without the player ever learning the enemy's actual number, only that their attack landed (and, if the GM has set a coarse `condition` field, a vague sense of how the enemy's holding up). A few implications worth keeping in mind now even though it's not being built:

- `token:stat:update` already being a generic event (Section 3) means "player casts fireball, three enemy tokens take damage" is just three of that same event in quick succession, sent by a player instead of the GM — the event shape doesn't need to change, only who's authorized to send it and for which targets, and the existing server-side filter (Section 5) already ensures the *result* isn't leaked back to the player who caused it, same as it isn't leaked to any other player.
- Death/downed state should stay a GM-controlled flag (e.g. `defeated`), never auto-derived client-side or server-side from `hp <= 0`, so the GM can still narrate a "bloodied but not dead" moment on their own timeline, decoupled entirely from the underlying HP math.
- Targeting/highlighting is a client-side selection concern layered on top of existing token data — no new server model needed, just a `target:select` broadcast so all clients see what's been selected, which the server can treat like any other pass-through event.

Post-POC, players will likely need a lightweight in-session "mini sheet" pulled from their full character sheet — combat stats (AC, current HP/max, saves), available battle actions, and remaining spell/magic availability (slots, prepared spells) — surfaced directly in the VTT so they aren't tabbing out to the main character sheet mid-combat. **This is intended as a fast follow-up immediately after the POC proves out, not a distant future item** — it's really "character sheet meets VTT," the eventual merge point the whole project is heading toward, and it's the piece that makes the VTT actually usable at the table rather than just a map/token demo. It's excluded from this POC only because the character sheet's math engine is still mid-build separately; as soon as that's far enough along, this should be next in line. The data shape decisions above (generic `token:stat:update`, GM-controlled `defeated`, coarse enemy `condition`) are written to not conflict with it: a player's own token stats can eventually pull live from the sheet's math engine rather than being separately tracked VTT-side state, without needing to redesign the event model described here.

## Notes for whoever picks this up in Claude Code

- Keep server state mutation centralized — one handler function per event type, all living in `handlers/`, all following the same "validate → mutate → broadcast (filtered)" shape described in Section 3.
- Auth itself isn't being built here — assume `playerId`/`playerName` arrive already-authenticated from the wider app. The POC's own job is just the room code generation/validation layer described in Section 2.
- Resist the urge to add Socket.IO, a database, or a frontend framework at this stage — the goal is proving the sync + vision pattern, not building the real product.
