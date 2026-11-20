// Shared "close a modal when the backdrop is pressed" handler.
//
// Closing on pointerdown (not click) means pressing inside a modal and
// releasing over the backdrop never closes it. The catch is touch: once the
// overlay disappears on pointerdown, the tap's follow-up compatibility
// mousedown/mouseup/click would land on whatever sits underneath. So we
// preventDefault() (suppresses the compat mouse events per the Pointer Events
// spec) and swallow the next click for a short window.

// Duplicated in static/vtt-app/main.js (unbundled, can't import this) - keep in step.
// One-shot capture-phase click eater. Removes itself on first click or after 500ms.
function swallowNextClick(): void {
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    done();
  };
  const timer = setTimeout(() => done(), 500);
  function done() {
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
  }
  window.addEventListener('click', swallow, true);
}

export function backdropPress(close: () => void): (event: PointerEvent) => void {
  return (event) => {
    // Only a primary-button press on the backdrop itself, not one bubbling up from the panel.
    if (event.target !== event.currentTarget || event.button !== 0) return;
    event.preventDefault();
    swallowNextClick();
    close();
  };
}
