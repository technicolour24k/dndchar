# VTT — Rearchitect Map Rendering: Layered DOM/SVG Compositing (replaces canvas map-draw)

## Why, precisely

Today, `renderVisionMaskedMap` (vision.js) draws the map image into the canvas multiple times per render — once per token, grayscale-filtered and clipped to that token's darkvision ring, plus once per token color-filtered and clipped to normal-vision range — all at native map pixel resolution (the canvas backing buffer isn't scaled for zoom; zoom is CSS-only). This is expensive by construction, and it's a per-render cost that would become a per-frame cost the moment the map source can animate — extending it, rather than replacing it, would mean running that same expensive pattern continuously.

**Decision**: replace map drawing with layered DOM elements (`<video>` or `<img>`, either works identically) composited via CSS `filter` and SVG `clip-path`, sitting behind the existing (unchanged) transparent canvas. The browser's own compositor does per-frame work natively — no JS render loop needed for animation, and the number of DOM layers is constant (roughly 2–3) regardless of token count, versus today's O(tokens) canvas draws per render.

**This is a real rewrite of `vision.js` and parts of `map.js`, not a patch.** Section 0 exists specifically to make sure nothing currently living on the canvas gets silently dropped in the split.

---

## 0. Audit — do this first, in full, before writing any new rendering code

Everything below needs a confirmed answer before Section 1 starts. Don't assume any of these — check the actual code.

1. **What else draws to the canvas today, besides the map?** Enumerate every caller of canvas drawing operations across the client (tokens, markers/AoE shapes, manually-painted fog if it exists, targeting highlights, vision-circle debug overlays if any, the touch-drag ghost/preview if the token-drag fix added one). Each of these must keep working, on the same canvas, once the map itself is no longer drawn there.
2. **Does GM-side manual fog painting exist today, in any form?** The original spec left this as optional/undecided and it's unclear from prior audits whether it was ever built. If it exists, find out exactly how it composites with the map today (same canvas pass? separate?) — this determines whether fog needs its own new DOM/SVG layer or can stay canvas-based.
3. **Where, precisely, is the pan/zoom CSS transform applied?** (`main.js:846-849` per the prior investigation.) Specifically: is it applied to the canvas element directly, or to a shared parent wrapper that canvas is a child of? This is the single most important finding in this audit — if it's a shared wrapper, the new video/image/SVG layers can be added as sibling children of that same wrapper and pan/zoom stays in sync for free. If it's applied to canvas specifically, that logic needs to be generalized to a wrapper first, or every new layer needs the transform duplicated and kept in lock-step manually (much more fragile, avoid if possible).
4. **Confirm canvas remains the sole interactive/hit-testable surface.** Token click-to-target, drag, and any other pointer interaction must continue to hit-test against canvas exactly as today. New DOM layers are purely visual — set `pointer-events: none` on all of them — verify nothing currently expects to receive pointer events from what's now going to be a DOM layer instead of a canvas pixel region.
5. **Confirm current map-switching lifecycle exactly.** `getImage()` (main.js:63-75) is a URL-keyed cache of `Image` objects that never evicts, with cache-miss triggering async load + re-render on `onload`. This pattern doesn't transfer directly to `<video>` — video elements need explicit `.load()`, `canplay`/`loadeddata` event handling, and a `loop` attribute for seamless looping; more importantly, switching away from a playing video needs explicit cleanup (pause + optionally clear `src`) or the old video keeps decoding/playing invisibly in the background, wasting resources indefinitely. Map this out explicitly before Section 3.
6. **Confirm SVG `clip-path` browser support is acceptable for the actual target devices**, including the XPPen tablet — modern Chrome supports it well, but per this project's established lesson, don't assume from spec sheets; a live check belongs in verification (Section 6), not just a compatibility table lookup here.

**Report all six findings back before Section 1 begins.**

---

## 1. New layer structure — player view

Bottom to top, all as children of the same transform-carrying wrapper identified in Section 0.3:

```
[wrapper — receives the existing pan/zoom CSS transform]
  ├─ black backdrop (div, solid black, full map dimensions — represents "unseen")
  ├─ grayscale map layer (<video> or <img>, filter: grayscale(1)), clip-path: url(#darkvision-clip)
  ├─ color map layer (<video> or <img>, no filter), clip-path: url(#normalvision-clip)
  ├─ <svg> (positioned absolutely, same dimensions, containing the two <clipPath> defs below — the SVG itself renders nothing visible, it only supplies clip geometry)
  └─ existing canvas (tokens, markers, fog-if-canvas-based, all current interactive content — UNCHANGED)
```

**SVG clip-path mechanics, precisely**: each `<clipPath>` contains one `<circle>` per one of the viewing player's own tokens (per Section 5's vision-union rule, unowned tokens contribute nothing). Multiple shapes inside a single `<clipPath>` union automatically per the SVG spec — the visible region is the union of all child shapes' areas. This is exactly what's needed for "vision is the union of all my tokens' circles," and it comes for free from the platform rather than needing custom union math.

- `#darkvision-clip`: one `<circle>` per owned token with `visionDarkFt > 0`, radius = `visionDarkFt` converted to pixels via the existing grid-scale conversion, centered on that token's current `x, y`.
- `#normalvision-clip`: one `<circle>` per owned token, radius = `visionNormalFt` in pixels, same centering. (Every owned token contributes here, even ones with no darkvision.)

Layer order does the rest: the color layer sits above the grayscale layer, so within the smaller normal-vision circle you see full color; between normal-vision and darkvision radius, the color layer's clip doesn't reach, so the grayscale layer shows through; beyond darkvision radius, neither layer's clip reaches, and the black backdrop shows through unmodified. No manual "three-band" compositing logic needed — it falls out of two independently-clipped layers stacked correctly.

A token with `visionDarkFt: 0` (no darkvision) simply contributes no circle to `#darkvision-clip` — normal vision only, black immediately beyond, exactly matching current behavior.

---

## 2. GM view — simplified, not just unmasked

Today's GM path (`map.js`, plain `drawMap`) is already separate from the player path. Under this rearchitecture, it gets simpler still: a single unclipped color layer (video or image, no `filter`, no `clip-path`) — no SVG needed at all for the GM. If Section 0.2 finds manual GM fog painting exists, that stays wherever it currently lives (likely canvas, per the "everything interactive stays on canvas" principle) — this section only concerns the map layer itself, not fog.

---

## 3. Video/image element lifecycle & map switching

Replaces `getImage()`'s caching model with something video-aware:

- On `map:set` (new map assigned), determine file type (extension or a `mapType: 'image' | 'video'` field on the map object, whichever Section 0's findings suggest fits the existing data shape best — check what `map.imageUrl` currently implies and whether a type needs to be explicit or can be inferred from extension).
- **Switching to a video map**: create (or reuse a pooled) `<video>` element, set `src`, `loop = true`, `muted = true` (mandatory — see Section 6), call `.load()`, wait for `canplay`/`loadeddata` before treating it as ready to display (show the previous map or a loading state until then, don't flash an unready frame), then `.play()`.
- **Switching away from a video map**: explicitly `.pause()` the outgoing video and clear its `src` (or fully remove the element) before/as the new layer takes over — don't let it silently keep decoding in the background. This is the single most important cleanup step in this section; skipping it is the most likely source of a slow memory/CPU leak from repeated map switches within a session.
- **Switching to a static image map**: same layer slots, just an `<img>` instead of `<video>` — no `.play()`/`.pause()` lifecycle, otherwise identical clip-path/filter treatment. This must be exactly the same code path as video, differing only in element type, not a separate branch of logic — that's the whole point of choosing this architecture.
- **Reconnect/late-join** (`state:full`): the joining client needs the current map's video (if it is one) to start playing from *some* reasonable point, not necessarily frame-synced with everyone else — per the original POC spec's framing, background/ambient content has never needed tight sync, and that principle still holds here. Starting from 0 and looping is fine.

---

## 4. Token-move / vision update wiring

On `token:move` (or any event changing an owned token's vision-relevant fields — position, `visionNormalFt`, `visionDarkFt`), update only the relevant `<circle>` elements' `cx`/`cy`/`r` attributes directly — no full re-render of the map layers needed, since the map elements themselves aren't being redrawn, only the clip geometry referencing them changes. This should be strictly cheaper than today's full-canvas-redraw-on-move, since it's a handful of DOM attribute writes rather than N drawImage calls.

The existing canvas still needs its own redraw on these events for tokens/markers, exactly as today — this section only removes the map-redraw portion of that work, not the token/marker redraw.

---

## 5. Ambient light (`map.brightness`) within the new architecture

Preserve existing semantics, expressed through the same two-layer mechanism:

- `"bright"`: no gray band regardless of darkvision — skip rendering `#darkvision-clip`'s effect entirely (either don't add darkvision circles to that clip-path at all while brightness is bright, or simplify further by not rendering the grayscale layer at all in this mode and letting the color layer's clip extend to cover the full visible area — pick whichever is less special-casing once Section 1 is actually implemented).
- `"dim"`: per original spec framing, treat as "grayscale within normal vision too" for tokens without darkvision — achievable by having the color layer's clip-path only include darkvision-equipped tokens' full range in this mode, falling back to gray for everyone else. Exact mechanics worth confirming against the original spec's Section 4 once this is being built, since "dim" was already flagged there as the one brightness tier allowed to skip nuance for POC purposes.
- `"dark"`: full logic as described in Section 1, unchanged.

---

## 6. Upload path changes (needed regardless of the rendering rework, bundle in here)

- Accept video MIME types / extensions in `upload/+server.ts` (currently `invalid_type`-rejects anything not `image/*` or `audio/*`) — add a `video/*` branch with its own size cap, following the existing per-form-field-type pattern already used for images (15MB) vs audio (25MB).
- Set the video cap under `BODY_SIZE_LIMIT` (currently 20M) or raise `BODY_SIZE_LIMIT` in tandem — do not repeat the existing audio-cap-vs-body-limit mismatch (audio's advertised 25MB cap already silently fails between ~20-25MB because of this exact gap). Whatever the video cap becomes, verify it against the real global limit, not just the route's own advertised number.
- **Mandate muted/no-audio video.** Either strip audio server-side on upload (more robust, more work) or simply always set `muted = true` client-side on the `<video>` element (simpler, sufficient — the embedded track never plays regardless of file content) and document that any audio in an uploaded map video is inert by design. This sidesteps both the ambient-music-system conflict (zero coordination exists today) and the browser's unmuted-autoplay block, in one decision. Recommend the client-side `muted` approach — simpler, and consistent with this project's general preference for the smaller fix.
- **Add Range/206 support to the upload-serving route.** It currently `fs.readFile`s the whole file into memory and returns one buffer — fine for images, but `<video>` elements rely on Range requests for seeking and can behave poorly (or refuse to play at all in some browsers) without it. This is a real, separate piece of backend work, not a side effect of the rendering change — flag it as its own checklist item so it isn't accidentally skipped because it's "just" a serving-route detail.
- Confirm the Railway persistent-volume question via the dashboard (one-minute check, previously flagged as unverifiable from the repo) — a lost video map is a much larger loss than a lost static one, worth knowing the actual risk before this becomes the normal workflow.

---

## 7. What explicitly does not change

- The canvas remains the only interactive/hit-testable surface — token click-to-target, drag, marker placement, all unchanged in mechanism.
- The WS event model (`map:set`, `token:move`, etc.) is unchanged — this is a client-side rendering rearchitecture only, no new server-side events needed beyond whatever Section 6's type/size handling requires at the upload endpoint.
- Session state remains in-memory only, per existing design — a map's `videoUrl`/`imageUrl` is just a string in the session object either way.
- The dependency-free, build-step-free nature of the VTT client is preserved — `<video>`/SVG/`clip-path` are all native browser APIs, nothing here requires a bundler or new package.

---

## Verification — live, on real devices, not just automated checks

Given this project's repeated lesson that automated/headless checks have not reliably predicted real-device behavior:

1. Player view: normal-vision color circle, darkvision gray ring, black beyond, on a token with darkvision — confirmed visually correct, not just "no errors in console."
2. A second owned token for the same player, positioned apart from the first — confirm vision is the *union* of both circles (SVG clip-path union behavior), not just the most-recently-moved token's circle.
3. A token with `visionDarkFt: 0` — confirm no gray ring at all, hard black edge at normal-vision radius.
4. Pan and zoom — confirm map layers, SVG clip circles, and canvas (tokens/markers) all move and scale together with no visible drift between them, on both desktop and the tablet.
5. Switch from a video map to a static image map and back — confirm the outgoing video actually stops (check dev tools' Network/Media tab or a visible resource/CPU check, not just visual disappearance) and no dangling playback persists.
6. A late-joining/reconnecting client — confirm the video map loads and plays correctly from a fresh join, not just for clients present when the map was first set.
7. GM view — confirm full-color, unmasked, all tokens visible, exactly as before.
8. Run steps 1-6 on the XPPen tablet specifically, not only desktop — given this device's history in this project (upload failures, touch-drag issues), it's the honest bar for "confirmed working," not a nice-to-have extra check.
9. Confirm existing functionality that must be unaffected: token click-to-target still arms combat actions correctly, marker/AoE placement still works, fog-of-war (if it exists per Section 0.2) still works.

## Sequencing

0 (audit, full findings reported back) → 1 (player layer structure) → 2 (GM simplification, small, can happen alongside or right after 1) → 3 (video lifecycle/map-switching) → 4 (token-move wiring) → 5 (brightness modes) → 6 (upload path — can happen in parallel with 1-5, fully independent backend work) → verification (all of it, including the tablet, before calling this done).
