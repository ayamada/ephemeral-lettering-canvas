// canvas のピクセル集計(実機テスト共用)。
//
// - ink: alpha > 0 のピクセル数
// - bbox: ink の外接矩形。無ければ null
// - edgeInk: 外周1pxのink数(trimOutermostPixels の検証用)
// - red / blue: 各色優勢のピクセル数(drawMode の検証用)
//
// page.evaluate / postMessage で送れるよう、返すのは plain object のみ。

export const stats = (canvas) => {
  const { width, height } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  let ink = 0;
  let maxAlpha = 0;
  let red = 0;
  let blue = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha === 0) { continue }
      ink += 1;
      if (alpha > maxAlpha) { maxAlpha = alpha }
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      if (r >= 192 && g <= 64 && b <= 64) { red += 1 }
      if (b >= 192 && r <= 64 && g <= 64) { blue += 1 }
      if (x < minX) { minX = x }
      if (y < minY) { minY = y }
      if (x > maxX) { maxX = x }
      if (y > maxY) { maxY = y }
    }
  }

  // 角を二重に数えないよう、上下の行と左右の列(角を除く)を別々に走査する
  let edgeInk = 0;
  const countEdge = (x, y) => {
    if (data[(y * width + x) * 4 + 3] !== 0) { edgeInk += 1 }
  };
  for (let x = 0; x < width; x += 1) {
    countEdge(x, 0);
    if (height > 1) { countEdge(x, height - 1) }
  }
  for (let y = 1; y < height - 1; y += 1) {
    countEdge(0, y);
    if (width > 1) { countEdge(width - 1, y) }
  }

  return {
    width,
    height,
    ink,
    maxAlpha,
    red,
    blue,
    edgeInk,
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
  };
};
