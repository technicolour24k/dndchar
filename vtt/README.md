# VTT Proof of Concept

Implements `.claude/briefs/vtt-poc-spec.md`. Vanilla JS/canvas client, no
bundler - in-memory session state only (a process restart wipes every room).

Originally a standalone Node + `ws` + `express` process on its own port. It's
now merged into the main app's single server process/port so there's only one
thing to run: the WebSocket layer attaches directly to the same `http.Server`
Vite (dev) or the custom `server.js` (prod) already owns, the same pattern
`src/lib/server/realtime.ts` had already sketched out for a future Socket.IO
server. `express`/`multer` are gone - the HTTP side (`/session/create`,
`/upload`) is now plain SvelteKit `+server.ts` routes.

Beyond the original spec: the GM can upload a custom image file on the fly for
the map background or for any token, instead of relying on a hardcoded URL. A
raw image URL can still be pasted in directly if you'd rather skip the upload.

## Run it

It runs alongside the main app automatically - no separate command:

```
npm run dev     # http://localhost:5173 - app + VTT, one process
npm run build && npm start   # production, also one process (node server.js)
```

Click **VTT** in the top nav (requires being logged in - same account system
as the rest of the app). That hits `/vtt`, the lobby (see "Campaign tables and
Quick rooms" below). Its Quick room link opens the static client with your
account's id/display name baked in as `?playerId=` / `?playerName=`, so you're
never asked to type a name separately. Opening
`/vtt-app/index.html` directly (no query params) still works standalone, with
manual name entry and a per-browser random id - handy for testing without
going through login.

## Campaign tables and Quick rooms

`/vtt` is a lobby. It lists the campaigns you belong to (with "Open as DM" for a DM or co-DM, and "Open as player"), and keeps a "Quick room" link for throwaway rooms.

- **Campaign room.** Each campaign has one long-lived room with a fixed 8-character code, created in memory on demand (a server restart empties it, the next open recreates it and re-attaches the active game session). It can only be joined with a **ticket**: the static client POSTs `/vtt/api/campaigns/<id>/ticket { role, takeoverOf }` (a SvelteKit route that has the login cookie and the database, and checks real campaign membership), then sends `{ type: 'join', sessionId, ticket }` on the websocket. Tickets are single use and last 60 seconds, so every connect and reconnect fetches a new one. The socket takes the user id, display name, role and GM-seat rank from the ticket and ignores whatever else the message says. A join without a ticket gets `join:error ticket_required`.
- **GM seat** (one per room). The primary DM takes it; the co-DM can when the primary is absent. If it is held, `join:error gm_seat_taken` carries `canTakeOver: true` and `heldBy` ('self' for the same user's older socket, 'other' for the co-DM). A ticket asked for with `takeoverOf: 'self'` (replace my own older socket) or `'co'` (the primary DM replacing the co-DM) replaces the holder, but only if that matches who holds the seat at join time (otherwise the asker just gets `gm_seat_taken` again, so a seat that changed hands in between is never taken silently): the old socket gets `gm:replaced` and closes with 4002, and the client rejoins as a player. Only the primary DM over the co-DM, or a DM over their own older socket, can take over; a co-DM never takes the seat from the primary (`gm_already_claimed`). A site admin who is not a member gets no ticket and is never the GM.
- **Kicks.** Removing a member, a member leaving, demoting a DM to player, and archiving a campaign send `kicked` (reason `removed_from_campaign` or `role_changed`) and close the socket with 4001. Unused tickets for that user or room are revoked first.
- **Client.** `static/vtt-app/campaign.js` runs the connection story (fresh ticket per attempt, takeover prompt, reconnects, notices); its decisions are pure functions in `static/vtt-app/shared/campaignJoin.js`. Opening the page with `?campaignId=` switches it on; without that the page is the Quick room flow, unchanged.
- **Character picker.** `GET /vtt/api/characters?roomId=<code>`: in a campaign room the GM gets every active-party character with its owner (the token is created owned by that player), anyone else gets their own characters in the campaign.
- **Overworld maps.** A campaign table's sidebar has an **Overworld** button that opens the campaign's overworld page (`/campaigns/<id>/overworld?embed=1`) in a full-screen overlay (Close, Esc, or open it in a new tab). A DM sharing a map sends `overworld:granted` to the room and players get a "New map" banner. Quick rooms have no button. The maps, pins and routes live in PostgreSQL (migration 040), not in the room. Overworld map images are uploaded through the app and stored on DISK under `UPLOAD_DIR` (production: `/data/uploads`, on the Railway volume mounted at `/data`; locally unset, so `./data`). They only survive deploys while that variable stays set. After the first production upload, check two things: (1) if uploads fail with `EACCES`, set `RAILWAY_RUN_UID=0` and redeploy; (2) upload a map, redeploy, and confirm the image still loads. VTT battle-map uploads (`data/vtt-uploads`) are still container-local and are lost on deploy, by choice.
- **Quick rooms** (typed 6-character code, no campaign) behave exactly as before: no tickets, the first GM in wins, no auth on the socket.

## Voice (Daily)

Campaign tables only (Quick rooms have no voice). Audio-only chat through Daily (daily.co), one private room per campaign, named `<DAILY_ROOM_PREFIX><campaign id without dashes>`. Nothing is stored: no migration.

- **Server.** `POST /vtt/api/campaigns/<id>/voice-token` gives a real campaign member (not an admin who isn't one, not an archived campaign) a 10 minute join token, creating or updating the room on first use (`src/lib/server/voice/`). The token only allows sending audio and ends the call after 6 hours (`DAILY_SESSION_CAP_HOURS`). The API key never leaves the server. Removing a member, a member leaving and archiving a campaign also eject them from the Daily room (`voiceEject.ts`, best effort: a Daily failure is logged and never fails the campaign action). A role change does not touch voice.
- **Client.** `static/vtt-app/voice.js` is a dock on the page itself (a direct child of `<body>`, outside the sidebar), so the call survives the overworld overlay, map switches, combat, sidebar re-renders, socket reconnects, GM-seat moves, demotion and a server restart. It does NOT survive leaving the page (a sheet, the campaign page) or a reload; after a reload the dock offers a highlighted "Rejoin voice" and never auto-joins. daily-js is loaded from a pinned unpkg URL (with an integrity hash) on the first Join; bump `DAILY_JS_VERSION` and the hash in `voice.js` now and then.
- **Idle rules** (`shared/voiceIdle.js`). Alone for 10 minutes leaves. 30 minutes with nobody speaking asks "Still in voice?" and leaves 60 s later if unanswered. Missing audio data counts as active. `?voiceIdleTest=1` divides the timings by 60.
- **Recording (DM / co-DM only).** The voice-token response carries `canRecord` (decided server-side from the campaign role). Record mixes all remote tracks plus your mic through Web Audio into a MediaRecorder (webm/opus, mp4 on Safari, 32 kbps), entirely in the browser, and downloads `<campaign>-<date-time>.<ext>` on Stop or when you leave, are kicked or auto-leave. Everyone sees a "Recording (by ...)" badge via a Daily app message (re-sent to people who join mid-recording). Keep the tab open; the audio is held in memory. Code: `voiceRecorder.js`, `shared/voiceRecord.js`.
- **Mic.** Blocked or missing mic offers "Join to listen only". Mic picker always, speaker picker only where `setSinkId` exists.
- **Env vars** (server only, never `PUBLIC_`): `DAILY_API_KEY`, `DAILY_DOMAIN`, `DAILY_ROOM_PREFIX` (`dev-` locally, `prod-` on Railway); optional `DAILY_MAX_PARTICIPANTS` (default 10) and `DAILY_SESSION_CAP_HOURS` (default 6). Unset key or domain means voice is off (the route answers 503 `voice_not_configured`).
- **CSP.** The app sends none today. If one is added it must allow `script-src https://unpkg.com https://c.daily.co`, `connect-src https://*.daily.co wss://*.daily.co`, `media-src blob:`, and keep the microphone permitted.

## Architecture

```
vtt/server/           - plain untyped JS (@ts-nocheck) by design: it has to be
                         importable, unmodified, from three different contexts
                         in the same process - SvelteKit's bundled routes (via
                         the $vtt alias, see svelte.config.js), the Vite dev
                         plugin (vite.config.ts), and production server.js.
  store.js              - session shape, generateRoomCode, filterSessionForRole,
                           broadcast(). State lives on globalThis so all three
                           loading paths above share the same Maps even if the
                           module itself gets loaded more than once.
                           db-traffic-reduction Phase 5 added a second,
                           unauthenticated subscription kind alongside a real
                           session join: setWatches/removeWatcher/publish let a
                           sheet tab "watch" a topic ("room:<sessionId>" or
                           "game-session:<id>") without joining a session at
                           all - broadcast() forwards a narrow allow-list of
                           types (combat:state/combat:log/roll:log/
                           game_session:state) to room:<sessionId> watchers
                           automatically; game_session:note is published to
                           its own topic explicitly (see gameSessions.ts) since
                           a note can be posted with no room in scope.
  wsServer.js            - attachVttWebSocketServer(httpServer): hooks the
                            'upgrade' event for /vtt-ws, wires the three
                            handlers below to each connection, plus a
                            'watch' case (see store.js above) and a 30s
                            ping/pong heartbeat (dead sockets get terminated;
                            a watcher-only socket also gets an app-level
                            {type:'hb'} frame so a client with no other VTT
                            traffic can still detect a dead path).
  handlers/
    join.js
    token.js              - add/remove/move/stat:update/hidden:toggle
    map.js                - map:set

src/routes/vtt/
  +page.svelte,
  +page.server.ts         - the lobby: the user's campaign tables plus a Quick
                             room link to /vtt-app/index.html with the signed-in
                             user's id/name (auth already enforced by
                             hooks.server.ts for any non-public route)
  api/campaigns/[id]/ticket/+server.ts - POST, one-use join ticket for a campaign room
  api/session/+server.ts   - POST, creates a room, returns { sessionId }
  api/upload/+server.ts    - POST multipart image, writes to data/vtt-uploads/
  api/uploads/[filename]/+server.ts - GET, serves an uploaded image back

static/vtt-app/          - the actual client (served as-is, both dev & prod)
  index.html
  main.js                 - WS connection, join flow, sidebar UI, canvas drag-to-move
  style.css
  render/
    map.js                - base map + grid
    tokens.js               - token sprites, HP bars, condition badges
    vision.js                - per-player radius vision mask (color/gray/black bands)

vite.config.ts            - dev-mode plugin calling attachVttWebSocketServer
server.js                  - prod entry point (wraps build/handler.js the same way)
```

Note on the static client bypassing auth: `static/vtt-app/*` is served by
SvelteKit's/Vite's own static-file layer, which runs *before* `hooks.server.ts`
- so the HTML/JS/CSS itself is reachable without logging in (there's nothing
secret in it). The actual protected surface is the API routes above (gated by
the existing session cookie, same as every other route) and the WS connection
itself, which - per the original spec - trusts whatever `playerId`/`role` a
client sends; real auth for the socket handshake was explicitly out of scope
for this POC.

## Try the milestones from the spec

1. Log in, click **VTT** in the nav - note the room code shown in the sidebar
   after creating a room.
2. Open a second browser (or log in as a different user) and join with that
   code.
3. As GM: upload an image (or paste a URL) under **Map**, set a grid size and
   ambient light, click **Set map** - it should appear in both tabs.
4. As GM: add a token (optionally upload token art), assign it to the other
   player as its owner - drag it around on either tab, it moves in both once
   the server round-trips the move.
5. Add a second token with `type: enemy` and check **Hidden from players** -
   check the player tab's WS frames in devtools and confirm no message ever
   mentions it, not just that the UI hides it.
6. Edit HP on the GM token card - the player's card for their own token
   updates; for an enemy token, players never see the number, only a
   GM-set "condition" if you choose one.
7. Give the player two tokens far apart on the map and confirm the revealed
   area is the union of both vision circles.
8. Close the player tab, reopen, rejoin with the same code - confirm state
   comes back correctly (same `state:full` path as the initial join).

## Known POC gaps (intentional, per spec)

- No manual fog-of-war layer on top of the radius vision (spec marks this
  optional; the milestones never exercise it).
- No auth on the WS handshake itself - see the note above. Identity is now
  tied to the account system for anyone arriving via the nav link, but the
  socket protocol still trusts the client's stated role/playerId, per spec.
- No zoom/pan; the canvas is sized 1:1 to the map's pixel dimensions inside a
  scrollable container.
- Campaign-linked rosters (pre-populating a session from an existing campaign
  instead of a bare room code) are still future work per the spec's Section 8
  - joining a room is still by code, just with the name field pre-filled now.
