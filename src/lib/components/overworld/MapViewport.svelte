<script lang="ts">
  import type { Snippet } from 'svelte';
  import { clampView, fitView, mapToScreen, screenToMap, zoomAt, type View } from '$lib/overworld/view';
  import type { Dims, Pt } from '$lib/types/overworld';

  // The pan / zoom surface: the map image at its natural size inside one transformed layer, with
  // pins (or anything else) drawn on top in screen space by the `overlay` snippet. All the maths is in
  // $lib/overworld/view.ts (unit tested); this file is pointer handling only.
  //
  //  - one finger / mouse drag pans; a press that moves less than TAP_SLOP_PX is a tap
  //  - wheel and the zoom methods zoom around a fixed point; two fingers pinch
  //  - the view is remembered per map in localStorage
  let {
    imageUrl,
    dims,
    mapId,
    armed = false,
    ontap,
    onhover,
    oncontext,
    overlay
  }: {
    imageUrl: string;
    dims: Dims;
    mapId: string;
    // True while the page is waiting for a placement tap (crosshair cursor).
    armed?: boolean;
    // A tap on the map: the point as 0..1 fractions of the image (only when inside the image).
    // The zoom is passed too, so the page can turn a screen tolerance into image pixels.
    // pointerType ('mouse' | 'touch' | 'pen') lets the page use a bigger tolerance for fingers.
    ontap?: (point: Pt, zoom: number, pointerType: string) => void;
    // Mouse only: where the pointer is over the map (null when it leaves). Used for the route preview leg.
    onhover?: (point: Pt | null) => void;
    // Right-click on the map (the page decides whether to prevent the menu and what it does).
    oncontext?: (event: MouseEvent) => void;
    overlay?: Snippet<[{ view: View; toScreen: (p: Pt) => Pt }]>;
  } = $props();

  const TAP_SLOP_PX = 8;
  const storageKey = $derived(`overworld-view:${mapId}`);

  let box = $state<HTMLDivElement | null>(null);
  let size = $state({ width: 0, height: 0 });
  let view = $state<View>({ x: 0, y: 0, zoom: 1 });
  let ready = $state(false);
  let imageState = $state<'loading' | 'ok' | 'missing'>('loading');

  const toScreen = (p: Pt) => mapToScreen(view, dims, p);

  function apply(next: View) {
    view = clampView(next, size, dims);
  }

  // Fit on first layout, or restore the remembered view.
  $effect(() => {
    if (!box || ready || size.width === 0 || size.height === 0) return;
    let restored: View | null = null;
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      // Ignore a view saved for a different image size (the image was replaced).
      if (
        parsed &&
        parsed.w === dims.width &&
        parsed.h === dims.height &&
        [parsed.x, parsed.y, parsed.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        restored = parsed;
      }
    } catch {
      // ignore a bad saved view
    }
    view = restored ? clampView(restored, size, dims) : fitView(size, dims);
    ready = true;
  });

  // Keep the viewport size up to date (rotation, resizing, the keyboard).
  $effect(() => {
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (!box) return;
      const first = size.width === 0;
      size = { width: box.clientWidth, height: box.clientHeight };
      if (!first && ready) apply(view);
    });
    observer.observe(box);
    size = { width: box.clientWidth, height: box.clientHeight };
    return () => observer.disconnect();
  });

  // Remember the view (debounced).
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!ready) return;
    const snapshot = JSON.stringify({ x: view.x, y: view.y, zoom: view.zoom, w: dims.width, h: dims.height });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, snapshot);
      } catch {
        // storage full or blocked: not important
      }
    }, 400);
  });

  // ---- Methods the page calls from its toolbar ----
  export function zoomBy(factor: number) {
    apply(zoomAt(view, { x: size.width / 2, y: size.height / 2 }, view.zoom * factor));
  }
  export function fit() {
    view = fitView(size, dims);
  }
  // Centre a map point on screen, zooming in a little if the whole map is showing.
  export function centerOn(p: Pt) {
    const fitZ = fitView(size, dims).zoom;
    const zoom = Math.max(view.zoom, fitZ * 2);
    apply({ zoom, x: size.width / 2 - p.x * dims.width * zoom, y: size.height / 2 - p.y * dims.height * zoom });
  }

  // ---- Pointer handling ----
  type Tracked = { x: number; y: number };
  const pointers = new Map<number, Tracked>();
  let startPoint: Tracked | null = null; // where a single press began
  let moved = false;
  let pinch: { distance: number; zoom: number } | null = null;

  const localPoint = (e: PointerEvent): Tracked => {
    const rect = box!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  function onpointerdown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    box!.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, localPoint(e));
    if (pointers.size === 1) {
      startPoint = localPoint(e);
      moved = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.zoom };
      moved = true; // a two-finger gesture is never a tap
    }
  }

  function onpointermove(e: PointerEvent) {
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      // No button down: a mouse hovering. Touch never gets here, so a finger lifting cannot leave a ghost leg.
      if (e.pointerType === 'mouse' && onhover) onhover(screenToMap(view, dims, localPoint(e)));
      return;
    }
    const now = localPoint(e);
    pointers.set(e.pointerId, now);

    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      apply(zoomAt(view, mid, pinch.zoom * (distance / pinch.distance)));
      return;
    }

    if (!moved && startPoint && Math.hypot(now.x - startPoint.x, now.y - startPoint.y) > TAP_SLOP_PX) moved = true;
    if (moved) apply({ ...view, x: view.x + (now.x - prev.x), y: view.y + (now.y - prev.y) });
  }

  function onpointerup(e: PointerEvent) {
    const wasSingle = pointers.size === 1;
    const at = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (wasSingle && at && !moved) {
      const p = screenToMap(view, dims, at);
      if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) ontap?.(p, view.zoom, e.pointerType);
    }
    if (pointers.size === 0) startPoint = null;
  }

  function onpointercancel(e: PointerEvent) {
    pointers.delete(e.pointerId);
    pinch = null;
    if (pointers.size === 0) startPoint = null;
  }

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    const rect = box!.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    apply(zoomAt(view, { x: e.clientX - rect.left, y: e.clientY - rect.top }, view.zoom * factor));
  }
</script>

<div
  class="ow-viewport"
  class:armed
  bind:this={box}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  {onpointercancel}
  onpointerleave={(e) => e.pointerType === 'mouse' && onhover?.(null)}
  oncontextmenu={oncontext}
  onlostpointercapture={onpointercancel}
  onwheel={onwheel}
  role="application"
  aria-label="Map"
>
  {#if ready}
    <div
      class="ow-layer"
      style="width: {dims.width}px; height: {dims.height}px; transform: translate({view.x}px, {view.y}px) scale({view.zoom});"
    >
      {#if imageState !== 'missing'}
        <img
          src={imageUrl}
          alt=""
          draggable="false"
          width={dims.width}
          height={dims.height}
          onload={() => (imageState = 'ok')}
          onerror={() => (imageState = 'missing')}
        />
      {:else}
        <div class="ow-missing"></div>
      {/if}
    </div>
    {@render overlay?.({ view, toScreen })}
  {/if}

  {#if imageState === 'loading'}
    <p class="ow-status">Loading map...</p>
  {:else if imageState === 'missing'}
    <p class="ow-status">This map's image is missing - a DM can upload it again.</p>
  {/if}
</div>
