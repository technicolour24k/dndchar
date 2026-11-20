# VTT Phase 11 — Animated Tokens

## Why

A batch of free animated token art exists and is ready to use. This is mostly plumbing, not new design — the map rendering rework already solved the hard problem (accepting and playing video) for a much harder case (large area, vision-masked). Tokens are smaller, fewer, and already interactive on canvas — the constraints are different enough that the right architecture here is the opposite of the map's: **stay on canvas, don't migrate to DOM layers.**

---

## 0. Confirm before building

- **Does the token-art upload path already accept video**, given it's confirmed to be the same underlying upload endpoint as map/music art (per the earlier infrastructure investigation)? Check whether the token-art form field is wired to the video-type handling added for maps, or still hardcoded to the image-only branch. This may already work with zero backend changes — confirm rather than assume either way.
- **Confirm the current token rendering call** (`drawTokens()` or equivalent) — exactly how it draws a token's art today (a cached `Image` via `getImage()`), so the video case can be added as a minimal branch rather than a rewrite.
- **Confirm whether any token art is already using animated GIF/WebP** (a cheaper animation format than video, decoded natively by `drawImage` in most browsers without any extra rendering loop at all) — if the "free animated tokens" batch turns out to be GIFs rather than video files, this phase may be dramatically smaller than assumed, since animated GIF drawn via canvas `drawImage` already animates on its own in some browsers/contexts. Check the actual file formats in the batch before assuming video-specific work is needed.

---

## 1. Upload path

If Section 0 finds token art doesn't yet route through video handling, add it — same size cap and validation pattern already established for map video uploads, applied to the token-art form field.

---

## 2. Rendering — minimal animation loop, canvas-based

Unlike the map, **don't move tokens off canvas.** Tokens are small in count and screen area, so the per-frame cost that justified the map's move to GPU-composited DOM layers doesn't apply here — and moving tokens off canvas would drag hit-testing/click-to-target/drag interactivity along with it, which is real scope this phase shouldn't take on.

Instead:
- For a token whose art is a video file, create a `<video>` element (muted, looped, `playsInline`, same treatment as map videos) but **don't display it directly** — use it purely as a frame source, drawn into the canvas via `drawImage(videoElement, ...)` at the token's current position/size, exactly like an `Image` is drawn today.
- Add a lightweight `requestAnimationFrame` loop that runs **only while at least one currently-visible token is a playing video** — redrawing just enough to keep that token's frame current, not necessarily a full canvas redraw every frame if that can be avoided (worth checking whether a partial/targeted redraw is feasible given the existing render structure, or whether a full redraw is simpler and still cheap enough at token scale — token counts are small enough this is likely a non-issue either way, but confirm rather than assume it's free).
- When no video tokens are currently visible, the loop should stop entirely — falling back to the existing event-driven render model with zero continuous cost, same as today when no animated content exists.

---

## 3. What's explicitly not this phase

- No token-specific vision/masking interaction — animated tokens render exactly like static ones from a visibility/filtering standpoint, this phase only changes how the art itself is drawn.
- No per-token animation controls (play/pause, speed) — tokens just loop continuously like map videos do.

---

## Verification

Live check: upload an animated token from the actual batch, confirm it plays correctly on canvas at token scale, confirm token drag/click-to-target still works identically to a static token, confirm the animation loop stops (check for continued rAF calls) once no video tokens are on screen, confirm multiple simultaneous animated tokens don't cause visible stutter on the XPPen tablet specifically, given its established track record in this project.

## Sequencing

0 (confirm upload path + actual file formats in the batch) → 1 (upload path, only if needed) → 2 (rendering).
