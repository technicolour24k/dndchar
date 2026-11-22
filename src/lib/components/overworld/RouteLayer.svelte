<script lang="ts">
  import { COLOURS } from '$lib/overworld/palette';
  import type { Pt, RouteView } from '$lib/types/overworld';

  // Saved routes and the route being traced, drawn in an SVG over the map in screen space (so line
  // widths and dots stay the same size at every zoom). It takes no pointer events at all: taps on a leg
  // are found by the page with nearestLeg(), so dragging from a route still pans the map.
  let {
    routes,
    toScreen,
    selectedRouteId = null,
    selectedLegId = null,
    tracing = null,
    previews = []
  }: {
    routes: RouteView[];
    toScreen: (p: Pt) => Pt;
    selectedRouteId?: string | null;
    selectedLegId?: string | null;
    // The route being drawn: its points, the mouse-hover end (desktop), colour and the running label.
    tracing?: { points: Pt[]; hover: Pt | null; colour: string; label: string } | null;
    // Other people's in-progress routes (live preview): faint dashed light blue, like the VTT's remote paths.
    previews?: { id: string; points: Pt[]; label: string }[];
  } = $props();

  const trace = $derived(tracing ? tracing.points.map(toScreen) : []);
  const hover = $derived(tracing?.hover ? toScreen(tracing.hover) : null);
  const last = $derived(trace.length > 0 ? trace[trace.length - 1] : null);
</script>

<svg class="ow-svg" aria-hidden="true">
  {#each routes as route (route.id)}
    {@const hex = COLOURS[route.colour].hex}
    {@const dim = selectedRouteId !== null && selectedRouteId !== route.id}
    <g opacity={dim ? 0.55 : 1} class:private={route.visibility === 'private'}>
      {#each route.legs as leg (leg.id)}
        {@const a = toScreen({ x: leg.x1, y: leg.y1 })}
        {@const b = toScreen({ x: leg.x2, y: leg.y2 })}
        {@const picked = leg.id === selectedLegId}
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#000" stroke-width={picked ? 8 : 5.5} stroke-linecap="round" />
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke={hex}
          stroke-width={picked ? 5 : 3}
          stroke-linecap="round"
          stroke-dasharray={route.visibility === 'private' ? '8 5' : undefined}
        />
      {/each}
    </g>
  {/each}

  {#each previews as preview (preview.id)}
    {@const pts = preview.points.map(toScreen)}
    {@const end = pts[pts.length - 1]}
    {#if pts.length > 1}
      <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#7fd4ff" stroke-width="3" stroke-dasharray="7 5" stroke-linejoin="round" stroke-linecap="round" opacity="0.6" />
    {/if}
    <circle cx={end.x} cy={end.y} r="4" fill="#7fd4ff" opacity="0.8" />
    <text x={end.x + 9} y={end.y - 9} class="ow-svg-label" opacity="0.85">{preview.label}</text>
  {/each}

  {#if tracing}
    {#if trace.length > 1}
      <polyline points={trace.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#000" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round" />
      <polyline points={trace.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={tracing.colour} stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
    {/if}
    {#if last && hover}
      <line x1={last.x} y1={last.y} x2={hover.x} y2={hover.y} stroke={tracing.colour} stroke-width="2.5" stroke-dasharray="6 5" opacity="0.8" />
    {/if}
    {#each trace as p, i (i)}
      <circle cx={p.x} cy={p.y} r="4.5" fill="#fff" stroke="#000" stroke-width="1.5" />
    {/each}
    {#if last && tracing.label}
      <text x={last.x + 9} y={last.y - 9} class="ow-svg-label">{tracing.label}</text>
    {/if}
  {/if}
</svg>
