export function drawMap(ctx, mapImage, map) {
  ctx.clearRect(0, 0, map.widthPx, map.heightPx);
  if (mapImage && mapImage.complete && mapImage.naturalWidth) {
    ctx.drawImage(mapImage, 0, 0, map.widthPx, map.heightPx);
  } else {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, map.widthPx, map.heightPx);
  }
  drawGrid(ctx, map);
}

function drawGrid(ctx, map) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
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
