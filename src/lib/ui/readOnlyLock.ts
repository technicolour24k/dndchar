// Svelte action: disables every form control inside `node` while `locked` is true (the read-only
// sheet for campaign members who can view but not edit).
//
// Why not just <fieldset disabled>? A disabled fieldset disables EVERY descendant, with no way to
// exempt a few. Viewers must still be able to open the "?" formula breakdowns, the Saving Throws /
// Skill Checks / Player Modifications read-outs and the Close buttons (the audit trail is for
// everyone), and those sit right in the middle of the editable controls. So controls are locked
// here instead, and an element opts out by being a ".formula-help-button" or carrying
// `data-viewer-ok`.
//
// A MutationObserver keeps it locked when Svelte re-renders: new rows (an {#each} adding inventory
// items) are locked as they appear, and a control Svelte re-enables (e.g. `disabled={contentBusy}`
// going false) is locked again. The server refuses every write from a viewer anyway; this is the UI.

const CONTROLS = 'input, textarea, select, button';
const EXEMPT = '[data-viewer-ok], .formula-help-button';

export function readOnlyLock(node: HTMLElement, locked: boolean) {
  let observer: MutationObserver | null = null;
  const lockedByUs = new Set<HTMLInputElement>();

  function lockElement(el: Element) {
    if (!el.matches(CONTROLS) || el.matches(EXEMPT)) return;
    const control = el as HTMLInputElement;
    // Only write when needed: setting `disabled` again would queue another mutation record.
    if (!control.disabled) {
      control.disabled = true;
      lockedByUs.add(control);
    }
  }

  function lockTree(root: Element) {
    lockElement(root);
    root.querySelectorAll(CONTROLS).forEach(lockElement);
  }

  function start() {
    node.dataset.readonlyLock = '';
    lockTree(node);
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          record.addedNodes.forEach((added) => {
            if (added.nodeType === Node.ELEMENT_NODE) lockTree(added as Element);
          });
        } else if (record.target instanceof Element) {
          lockElement(record.target);
        }
      }
    });
    observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    delete node.dataset.readonlyLock;
    for (const control of lockedByUs) control.disabled = false;
    lockedByUs.clear();
  }

  if (locked) start();
  return {
    update(next: boolean) {
      if (next === locked) return;
      locked = next;
      if (locked) start();
      else stop();
    },
    destroy: stop
  };
}
