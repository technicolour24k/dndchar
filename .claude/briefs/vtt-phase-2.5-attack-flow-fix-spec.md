# VTT Phase 2.5 — Fix Attack Flow (prerequisite for Phase 3)

## Why this exists

`vtt-current-state.md` documented Phase 2's click-to-target weapon attack flow as built and verified. In practice: clicking does nothing at all. That's a real discrepancy between what got documented and what actually works in a live browser, and it matters beyond this one bug — `vtt-phase-3-spec.md` Section 2a explicitly reuses this exact path as the foundation for spell casting ("identical to weapon attacks... already built and verified"). Building magic on top of broken plumbing means debugging both at once. Fix this first.

This also means the current-state doc's "verified" claims elsewhere shouldn't be taken at face value going forward without a live-browser check — whatever verification method produced that claim (automated/headless test, code review, or something else) didn't match reality here, worth asking Claude Code directly what "verified" meant when it wrote that, so future phases don't inherit the same false confidence.

---

## 0. Reproduce and diagnose, live

Before writing any fix: reproduce the exact failure in a real browser session (not a headless test, not code review) — open the VTT as a player with an owned token that has a weapon action, open the mini-sheet, click the weapon action, click an enemy token. Confirm and report back, precisely, at which step nothing happens:

- Does clicking the weapon action in the mini-sheet do *anything* (visual state change, console log, network activity)?
- If yes — does clicking a target token afterward do anything (check the browser's WS/network tab for a `target:select` event actually being sent)?
- If a `target:select` event *is* sent — does the server receive and rebroadcast it (check server logs), and does the receiving client do anything with it?
- Check the browser console for JS errors at each step — a silent JS exception breaking the click handler is the most likely single cause of "nothing happens at all."

Report the exact break point before proceeding to Section 1 — "nothing happens" could be a broken click handler, an event that's sent but never handled, a filter silently dropping it, or several other distinct bugs, and the fix differs for each.

---

## 1. Rebuild as an explicit Attack flow (not just a silent patch)

Rather than patching whatever's broken in the current implicit click-to-target flow, replace it with an explicit, visible sequence — this is a better design independent of the bug, and it's the flow Phase 3's spells will reuse, so it's worth getting right once:

1. Player clicks a weapon action in their mini-sheet. This visibly arms targeting — some clear UI state change (e.g. valid enemy tokens get a highlight ring, cursor changes, an "Attacking with [weapon] — select a target" prompt appears). No more silent "click and hope."
2. Player clicks a target token. This does **not** immediately resolve — it shows a confirm step: target name, then an explicit **"Attack" button**.
3. Clicking Attack triggers the roll, reusing the **same dice-roll component/utility the character sheet already uses** for attack rolls — don't reimplement roll logic or roll display for the VTT; if the character sheet's roll UI isn't directly reusable as a component here, that's worth flagging rather than quietly rewriting it, since divergent roll logic in two places is exactly the kind of thing that causes silent mismatches later.
4. To-hit roll displays visibly (roll result vs. target AC — though per existing filtering rules, if AC needs to be hidden from the player for non-owned tokens, resolve hit/miss server-side or via whatever the current AC-visibility rule already is, rather than exposing a number that shouldn't be visible; check this against Phase 2's existing filtering rather than assuming).
5. On a hit, damage roll displays visibly, then applies via the existing `target:select` → `token:stat:update` path (unchanged from Phase 2's design — that part of the plumbing may well be fine; the bug may be entirely upstream of it, per Section 0's diagnosis).
6. On a miss, show that clearly too — no damage event sent.

### What stays the same

The underlying event model (`target:select`, `token:stat:update`, server-side field authorization from Phase 2 Section 0a) doesn't need to change — this section is about the *client-side UX and trigger* around that plumbing, making each step visible and explicit instead of implicit and silent. If Section 0's diagnosis finds the plumbing itself is also broken, fix that as part of this section rather than treating it as separate.

---

## 2. Verification

Don't mark this done from a code read or an automated test alone, given what happened last time — actually click through the full flow in a live browser as a player, against a live enemy token, and confirm: targeting arms visibly, target selection prompts a confirm step, Attack button triggers a visible to-hit roll, hit applies visible damage roll and updates state, miss shows clearly and applies nothing. Do this from two separate browser sessions (GM + player, same as Phase 2's original verification approach) so the full round-trip through the server is actually exercised, not just one client's local state.

---

## 3. Update Phase 3

Once this is verified live, Phase 3 Section 2a's "identical to weapon attacks, already built and verified" should point at *this* flow (the explicit Attack-button version), not the original Phase 2 description. Spells should reuse the same visible arm → target → confirm → roll → apply sequence, just triggered from a spell click instead of a weapon-action click, with the roll step using spell-appropriate dice from `resolveSpellDamage()` instead of weapon damage dice.

---

## Notes for whoever picks this up in Claude Code

- Section 0 first, always — don't skip straight to rebuilding before you know what's actually broken. It's possible the fix is small (one broken click handler) and Section 1's larger UX rework is separable from it; it's also possible they're the same fix. Find out before assuming.
- Reuse the character sheet's existing roll component rather than building a second one for the VTT — this was implicit in earlier specs but worth stating directly given it's now the explicit ask.
- Don't mark anything "verified" in the next current-state update without having actually clicked through it live — that's the specific thing that broke trust this round.
