// Player/GM-placed AOE markers (spell templates etc). Circle-only for now —
// shape is on the data already so cone/line/cube can be added as new
// branches here later without touching the sync/visibility plumbing.
export function drawMarkers(ctx, markers, gridSizePx) {
  const pxPerFoot = gridSizePx / 5;

  ctx.save();
  for (const marker of markers) {
    if (marker.shape !== 'circle') continue;
    const radius = (marker.radiusFt || 0) * pxPerFoot;
    if (radius <= 0) continue;

    const color = marker.color || '#ff5252';
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.2);
    ctx.fill();
    ctx.setLineDash([]);
    ctx.strokeStyle = hexToRgba(color, 0.9);
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(marker.x, marker.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    const label = marker.label ? `${marker.label} (${marker.radiusFt}ft)` : `${marker.radiusFt}ft`;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.strokeText(label, marker.x, marker.y - radius - 8);
    ctx.fillText(label, marker.x, marker.y - radius - 8);
  }
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(255,82,82,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
