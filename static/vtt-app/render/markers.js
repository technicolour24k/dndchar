// Player/GM-placed AOE markers (spell templates etc). One shape per marker,
// dispatched by marker.shape - each shape gets its own draw path, sharing the
// fill/stroke/label conventions established by the original circle-only pass.
export function drawMarkers(ctx, markers, gridSizePx) {
  const pxPerFoot = gridSizePx / 5;

  ctx.save();
  for (const marker of markers) {
    if (marker.shape === 'cone') drawCone(ctx, marker, pxPerFoot);
    else if (marker.shape === 'cube') drawCube(ctx, marker, pxPerFoot);
    else drawCircle(ctx, marker, pxPerFoot); // 'circle' and 'sphere' share identical math
  }
  ctx.restore();
}

function drawCircle(ctx, marker, pxPerFoot) {
  const radius = (marker.radiusFt || 0) * pxPerFoot;
  if (radius <= 0) return;
  const color = marker.color || '#ff5252';

  ctx.beginPath();
  ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
  fillAndStroke(ctx, color);
  drawOrigin(ctx, marker.x, marker.y, color);
  drawLabel(ctx, marker, `${marker.radiusFt}ft`, marker.x, marker.y - radius - 8);
}

function drawCone(ctx, marker, pxPerFoot) {
  const length = (marker.lengthFt || 0) * pxPerFoot;
  if (length <= 0) return;
  const color = marker.color || '#ff5252';
  const angleRad = ((marker.angleDeg || 0) * Math.PI) / 180;
  const halfSpread = ((marker.coneAngleDeg || 60) / 2) * (Math.PI / 180);

  ctx.beginPath();
  ctx.moveTo(marker.x, marker.y);
  ctx.arc(marker.x, marker.y, length, angleRad - halfSpread, angleRad + halfSpread);
  ctx.closePath();
  fillAndStroke(ctx, color);
  drawOrigin(ctx, marker.x, marker.y, color);

  const labelX = marker.x + Math.cos(angleRad) * length * 0.6;
  const labelY = marker.y + Math.sin(angleRad) * length * 0.6;
  drawLabel(ctx, marker, `${marker.lengthFt}ft cone`, labelX, labelY);
}

function drawCube(ctx, marker, pxPerFoot) {
  const length = (marker.lengthFt || 0) * pxPerFoot;
  const width = (marker.widthFt || 0) * pxPerFoot;
  if (length <= 0 || width <= 0) return;
  const color = marker.color || '#ff5252';
  const angleRad = ((marker.angleDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  // Anchored at the near-edge midpoint (see shapeGeometry.js's pointInCube
  // comment) - the four corners in local space are (0, ±w/2) and (L, ±w/2).
  const corners = [
    [0, -width / 2],
    [length, -width / 2],
    [length, width / 2],
    [0, width / 2],
  ].map(([fx, fy]) => [marker.x + fx * cos - fy * sin, marker.y + fx * sin + fy * cos]);

  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  fillAndStroke(ctx, color);
  drawOrigin(ctx, marker.x, marker.y, color);

  const centerX = marker.x + (length / 2) * cos;
  const centerY = marker.y + (length / 2) * sin;
  drawLabel(ctx, marker, `${marker.lengthFt}x${marker.widthFt}ft`, centerX, centerY - width / 2 - 8);
}

function fillAndStroke(ctx, color) {
  ctx.fillStyle = hexToRgba(color, 0.2);
  ctx.fill();
  ctx.setLineDash([]);
  ctx.strokeStyle = hexToRgba(color, 0.9);
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawOrigin(ctx, x, y, color) {
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawLabel(ctx, marker, fallback, x, y) {
  const label = marker.label ? `${marker.label} (${fallback})` : fallback;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeText(label, x, y);
  ctx.fillText(label, x, y);
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(255,82,82,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
