// Drawing for movement distance: the drag ghost and the planned-path preview
// share these so their look (and the over-budget red) can't drift apart.

// Dashed ring at (x, y) plus a "35 ft (of 30 ft)" label above it. Used for the
// drag ghost's end point and the last point of a path.
export function drawDistanceGhost(ctx, { x, y, radius, label, overBudget }) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = overBudget ? 'rgba(229,57,53,0.9)' : 'rgba(255,255,255,0.85)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = overBudget ? '#ff8a80' : '#fff';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeText(label, x, y - radius - 10);
  ctx.fillText(label, x, y - radius - 10);
  ctx.restore();
}

// Straight line between two points in the drag ghost's style (the line back to
// the token's real starting point).
export function drawDistanceLine(ctx, from, to, overBudget) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = overBudget ? 'rgba(229,57,53,0.6)' : 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// A planned path: polyline through `points` (origin first), a dot at each
// waypoint, and the ghost ring + label at the last point.
//   style 'local'  - the planner's own path, same white/red as the drag ghost.
//   style 'remote' - someone else's path, light-blue and dashed so it is clearly
//                    not yours (red only when the budget is shown and exceeded).
// showBudget controls "(of N ft)" in the label - remote viewers who do not own
// the token only get the distance, same as the movement-range overlay.
export function drawMovePath(ctx, { points, totalFt, remainingFt, showBudget, overBudget, gridSizePx, style }) {
  if (points.length < 1) return;
  const red = showBudget && overBudget;
  const remote = style === 'remote';
  const lineColour = red
    ? 'rgba(229,57,53,0.8)'
    : remote ? 'rgba(144,202,249,0.8)' : 'rgba(255,255,255,0.7)';

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = lineColour;
  ctx.lineWidth = 2.5;
  ctx.setLineDash(remote ? [8, 6] : []);
  ctx.stroke();

  // Dots at each waypoint (not the origin).
  ctx.setLineDash([]);
  ctx.fillStyle = lineColour;
  for (let i = 1; i < points.length; i++) {
    ctx.beginPath();
    ctx.arc(points[i].x, points[i].y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (points.length < 2) return;
  const last = points[points.length - 1];
  const label = showBudget && remainingFt !== null ? `${totalFt} ft (of ${remainingFt} ft)` : `${totalFt} ft`;
  drawDistanceGhost(ctx, { x: last.x, y: last.y, radius: gridSizePx * 0.4, label, overBudget: red });
}
