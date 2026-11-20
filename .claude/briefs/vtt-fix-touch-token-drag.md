# VTT Fix — Touch: Token Drag vs. Map Pan

## Why this exists

On tablets, touching anywhere on the map — including directly on a token — pans the map instead of moving the token. Desktop (mouse) dragging presumably already works correctly, since it's the same interaction weapon-attack targeting already relies on (click detection against tokens). This is specifically a touch-input gap.

## 0. Confirm the actual gap before fixing

Check the touch/pointer event handling in the VTT's canvas code (likely `render/tokens.js` or wherever pan/zoom is wired up) for one of two situations — the fix differs slightly depending on which:

- **Token dragging was never implemented for touch at all** (only mouse drag), and pan was wired to any touch-start unconditionally. In this case, token-drag-by-touch needs building, not just precedence fixing.
- **Token drag exists for touch but pan is winning** — e.g. both handlers are bound to the same event and pan's listener runs first or doesn't check for a token hit before acting. In this case it's a precedence fix only.

Report which one it is before proceeding — the two are different-sized changes.

## 1. Fix: hit-test tokens before starting a pan gesture

On touch/pointer-down:

1. Hit-test the touch point against token positions first — reuse whatever hit-test already backs mouse click-to-target (Phase 2 combat targeting) and mouse drag, don't write a second one.
2. **Hit → start a token-drag gesture** for that touch, using the same move/broadcast logic (`token:move`) desktop drag already uses. Suppress pan for the duration of this touch.
3. **Miss → fall through to existing pan behavior**, unchanged.

## 2. Don't break pinch-to-zoom

Single-finger-on-a-token (move), single-finger-on-empty-map (pan), and two-finger-anywhere (zoom) all need to keep working independently. The token-drag branch above should only ever engage for a single active touch point — if a second finger comes down mid-gesture, that's pinch-zoom territory, not token drag, and should hand off accordingly (or simply cancel the token-drag and let zoom take over, whichever is simpler to get right without breaking either gesture).

## 3. Verify

On an actual tablet (not just desktop devtools touch emulation, given the history in this project of automated checks not matching real-device behavior):

- Touch directly on a token and drag → token moves, map doesn't pan.
- Touch on empty map and drag → map pans as before, unchanged.
- Two-finger pinch anywhere → zoom still works.
- Touch a token, then add a second finger before lifting → doesn't break (either cleanly hands off to zoom or cleanly cancels the drag — either is fine, a stuck/broken gesture state is not).
- Confirm on more than one tablet if possible, given the touch-input quirks already seen from device to device in this project (the XPPen upload issue).

## Notes for whoever picks this up in Claude Code

- Reuse existing hit-test and move/broadcast logic — this should not need new server-side events, `token:move` already exists and already works from mouse drag.
- Keep this scoped to the gesture-precedence/touch-handling fix only. Don't use this as an opportunity to rework pan/zoom more broadly unless Section 0's investigation reveals that's actually necessary.
