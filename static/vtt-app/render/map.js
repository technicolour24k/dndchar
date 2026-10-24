// The map image itself is no longer drawn here - it lives in DOM layers
// behind the canvas (see render/mapLayers.js). All that's left on the canvas
// from the old drawMap() is the grid overlay, GM-only as before.
// style = { colour: '#rrggbb', opacity: 0-1 }; defaults: #757575 at 50%.
export function drawGrid(ctx, map, style = {}) {
  ctx.save();
  ctx.strokeStyle = style.colour || '#757575';
  ctx.globalAlpha = style.opacity ?? 0.5;
  ctx.lineWidth = 1;
  for (let x = 0; x <= map.widthPx; x += map.gridSizePx) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, map.heightPx);
    ctx.stroke();
  }
  for (let y = 0; y <= map.heightPx; y += map.gridSizePx) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(map.widthPx, y + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}
