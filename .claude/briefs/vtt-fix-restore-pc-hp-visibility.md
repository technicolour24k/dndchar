# VTT Fix — Revert: PC HP Should Be Visible to All Players Again

## Why this exists

2026-07-14's changelog entry "Raw HP no longer shown for any non-owned token, not just enemy/npc" deliberately hid PC-to-PC HP, simplifying to one rule ("no raw HP for anything you don't own"). That's being reverted: the wanted policy is the *original* split — **players always see other players' real HP; enemy/NPC HP stays hidden, unchanged.** This is a deliberate policy reversal, not a bug fix — worth being explicit about that in the commit/changelog so it doesn't read as a regression later.

## What changes

Two known call sites from that 2026-07-14 fix, both need to go back to branching on token *type*, not just ownership:

- **`otherTokenListHtml()` (`main.js`)** — currently always shows `condition`/"No status known" regardless of type. Restore the `hasStats`-style branch: real HP for `pc` tokens (any owner), condition-badge-only for `enemy`/`npc`.
- **`drawTokens()` (`render/tokens.js`)** — currently gates the on-canvas HP bar on `viewerId === null || token.ownerId === viewerId`. Change back to: show the real HP bar for any `pc` token regardless of owner, condition-badge fallback only for `enemy`/`npc` tokens the viewer doesn't own.

No server-side change needed — `filterTokenForPlayer` already only strips `stats` from `enemy`/`npc` tokens server-side (this was never changed; the 2026-07-14 fix was purely a client-side display choice on top of data the server always sent for PCs). This revert is symmetric: purely client-side again, same as the change it's undoing.

## Phase 8 interaction

This directly changes Phase 8's overheal-leak requirement (Section 3): with PC HP visible again, showing an exact overheal number for another player's token is no longer a leak — their HP was already visible before the heal happened. The leak concern only remains relevant for the (unusual, but not impossible) case of healing an enemy/NPC token, which should stay capped the same way their HP already is everywhere else. Update Phase 8's spec to reflect this narrower scope before or during that phase's work — no need to build the non-owned-PC suppression logic Phase 8 originally called for.

## Verification

Two players, each owning their own PC token: confirm each can see the other's real HP number, both in the sidebar list and as an on-canvas bar. Confirm an enemy/NPC token still shows condition-badge-only for both, unchanged. Confirm the GM's own view is unaffected either way (it already shows real bars for everything).
