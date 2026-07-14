# VTT Proof of Concept

Implements `.claude/briefs/vtt-poc-spec.md`. Vanilla JS/canvas client, no
bundler — in-memory session state only (a process restart wipes every room).

Originally a standalone Node + `ws` + `express` process on its own port. It's
now merged into the main app's single server process/port so there's only one
thing to run: the WebSocket layer attaches directly to the same `http.Server`
Vite (dev) or the custom `server.js` (prod) already owns, the same pattern
`src/lib/server/realtime.ts` had already sketched out for a future Socket.IO
server. `express`/`multer` are gone — the HTTP side (`/session/create`,
`/upload`) is now plain SvelteKit `+server.ts` routes.

Beyond the original spec: the GM can upload a custom image file on the fly for
the map background or for any token, instead of relying on a hardcoded URL. A
raw image URL can still be pasted in directly if you'd rather skip the upload.

## Run it

It runs alongside the main app automatically — no separate command:

```
npm run dev     # http://localhost:5173 — app + VTT, one process
npm run build && npm start   # production, also one process (node server.js)
```

Click **VTT** in the top nav (requires being logged in — same account system
as the rest of the app). That hits `/vtt`, which redirects to the static
client with your account's id/display name baked in as `?playerId=` /
`?playerName=`, so you're never asked to type a name separately. Opening
`/vtt-app/index.html` directly (no query params) still works standalone, with
manual name entry and a per-browser random id — handy for testing without
going through login.

## Architecture

```
vtt/server/           — plain untyped JS (@ts-nocheck) by design: it has to be
                         importable, unmodified, from three different contexts
                         in the same process — SvelteKit's bundled routes (via
                         the $vtt alias, see svelte.config.js), the Vite dev
                         plugin (vite.config.ts), and production server.js.
  store.js              — session shape, generateRoomCode, filterSessionForRole,
                           broadcast(). State lives on globalThis so all three
                           loading paths above share the same Maps even if the
                           module itself gets loaded more than once.
  wsServer.js            — attachVttWebSocketServer(httpServer): hooks the
                            'upgrade' event for /vtt-ws, wires the three
                            handlers below to each connection.
  handlers/
    join.js
    token.js              — add/remove/move/stat:update/hidden:toggle
    map.js                — map:set

src/routes/vtt/
  +page.server.ts         — redirects to /vtt-app/index.html with the signed-in
                             user's id/name (auth already enforced by
                             hooks.server.ts for any non-public route)
  api/session/+server.ts   — POST, creates a room, returns { sessionId }
  api/upload/+server.ts    — POST multipart image, writes to data/vtt-uploads/
  api/uploads/[filename]/+server.ts — GET, serves an uploaded image back

static/vtt-app/          — the actual client (served as-is, both dev & prod)
  index.html
  main.js                 — WS connection, join flow, sidebar UI, canvas drag-to-move
  style.css
  render/
    map.js                — base map + grid
    tokens.js               — token sprites, HP bars, condition badges
    vision.js                — per-player radius vision mask (color/gray/black bands)

vite.config.ts            — dev-mode plugin calling attachVttWebSocketServer
server.js                  — prod entry point (wraps build/handler.js the same way)
```

Note on the static client bypassing auth: `static/vtt-app/*` is served by
SvelteKit's/Vite's own static-file layer, which runs *before* `hooks.server.ts`
— so the HTML/JS/CSS itself is reachable without logging in (there's nothing
secret in it). The actual protected surface is the API routes above (gated by
the existing session cookie, same as every other route) and the WS connection
itself, which — per the original spec — trusts whatever `playerId`/`role` a
client sends; real auth for the socket handshake was explicitly out of scope
for this POC.

## Try the milestones from the spec

1. Log in, click **VTT** in the nav — note the room code shown in the sidebar
   after creating a room.
2. Open a second browser (or log in as a different user) and join with that
   code.
3. As GM: upload an image (or paste a URL) under **Map**, set a grid size and
   ambient light, click **Set map** — it should appear in both tabs.
4. As GM: add a token (optionally upload token art), assign it to the other
   player as its owner — drag it around on either tab, it moves in both once
   the server round-trips the move.
5. Add a second token with `type: enemy` and check **Hidden from players** —
   check the player tab's WS frames in devtools and confirm no message ever
   mentions it, not just that the UI hides it.
6. Edit HP on the GM token card — the player's card for their own token
   updates; for an enemy token, players never see the number, only a
   GM-set "condition" if you choose one.
7. Give the player two tokens far apart on the map and confirm the revealed
   area is the union of both vision circles.
8. Close the player tab, reopen, rejoin with the same code — confirm state
   comes back correctly (same `state:full` path as the initial join).

## Known POC gaps (intentional, per spec)

- No manual fog-of-war layer on top of the radius vision (spec marks this
  optional; the milestones never exercise it).
- No auth on the WS handshake itself — see the note above. Identity is now
  tied to the account system for anyone arriving via the nav link, but the
  socket protocol still trusts the client's stated role/playerId, per spec.
- No zoom/pan; the canvas is sized 1:1 to the map's pixel dimensions inside a
  scrollable container.
- Campaign-linked rosters (pre-populating a session from an existing campaign
  instead of a bare room code) are still future work per the spec's Section 8
  — joining a room is still by code, just with the name field pre-filled now.
