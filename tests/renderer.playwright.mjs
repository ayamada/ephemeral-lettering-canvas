// main thread の playwright 実機テスト。
// esbuild bundle 済みの /e2e/page-entry.js 経由で公開 API を読み込む。
import assert from "node:assert/strict";

import { openTestPage } from "./browser-harness.mjs";

const { page, context, errors, origin, close } = await openTestPage({ path: "/tests/fixtures/page.html" });

try {
  // 1. 自動検出(OffscreenCanvas)+ 描画。fontResolution は設計時の高さ
  const base = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const style = e2e.makeStyle({ fontWithoutSize: "sans-serif" });
    const canvas = renderer.renderText("Hello", style, { fontResolution: 64 });
    return {
      isOffscreen: canvas instanceof OffscreenCanvas,
      width: canvas.width,
      height: canvas.height,
      stats: e2e.stats(canvas),
    };
  });
  assert.equal(base.isOffscreen, true, "main thread must use OffscreenCanvas");
  assert.equal(base.height, 64, "fontResolution must be the final canvas height when no scaling applies");
  assert.ok(base.width > base.height, `text must be horizontal (${base.width}x${base.height})`);
  assert.ok(base.stats.ink > 0, `main thread must render ink (ink=${base.stats.ink})`);
  assert.equal(base.stats.maxAlpha, 255, "ink must be opaque at its core");
  assert.ok(base.stats.bbox, "text must have an ink bounding box");
  assert.ok(base.stats.bbox.w > base.stats.bbox.h, "text bbox must be horizontal");
  assert.ok(base.stats.bbox.x >= 0 && base.stats.bbox.y >= 0, "ink bbox must be inside the canvas");

  // 2. HTMLCanvasElement フォールバック。OffscreenCanvas を隠すと document 側が選ばれる
  const html = await page.evaluate(() => {
    const saved = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = undefined;
    try {
      const renderer = e2e.createRenderer({ examCharacter: "H" });
      const style = e2e.makeStyle({ fontWithoutSize: "sans-serif" });
      const canvas = document.createElement("canvas");
      const result = renderer.renderText("Hello", style, { canvas, fontResolution: 64 });
      return {
        isHtmlCanvas: result instanceof HTMLCanvasElement,
        isSame: result === canvas,
        stats: e2e.stats(result),
      };
    } finally {
      globalThis.OffscreenCanvas = saved;
    }
  });
  assert.equal(html.isHtmlCanvas, true, "fallback must return an HTMLCanvasElement");
  assert.equal(html.isSame, true, "explicit canvas must be returned as-is");
  assert.ok(html.stats.ink > 0, "HTML canvas must render ink");
  assert.ok(
    Math.abs(html.stats.ink - base.stats.ink) <= Math.max(1, base.stats.ink * 0.01),
    `OffscreenCanvas and HTMLCanvasElement must render the same text (offscreen=${base.stats.ink}, html=${html.stats.ink})`,
  );

  // 3. trimOutermostPixels。再利用の影響を避ける為、明示 canvas を 2 個渡す
  const trim = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const makeStyle = (trimOutermostPixels) => e2e.makeStyle({
      fontWithoutSize: "sans-serif",
      padding: 0,
      properties: { textAlign: "left" },
      offsetXRatio: -0.2,
      trimOutermostPixels,
    });
    const plainCanvas = new OffscreenCanvas(2, 2);
    const trimmedCanvas = new OffscreenCanvas(2, 2);
    const plain = renderer.renderText("Hello", makeStyle(false), { canvas: plainCanvas, fontResolution: 64 });
    const trimmed = renderer.renderText("Hello", makeStyle(true), { canvas: trimmedCanvas, fontResolution: 64 });
    return { plain: e2e.stats(plain), trimmed: e2e.stats(trimmed) };
  });
  assert.ok(trim.plain.edgeInk > 0, `test setup must put ink on the edge (edgeInk=${trim.plain.edgeInk})`);
  assert.equal(trim.trimmed.edgeInk, 0, "trimOutermostPixels must clear the edge");
  assert.ok(trim.trimmed.ink > 0, "trimOutermostPixels must keep the inner ink");

  // 4. drawMode。色優勢ピクセルで fill / stroke / both を区別する
  const modes = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const baseStyle = { fontWithoutSize: "sans-serif" };
    const fillProperties = { fillStyle: "rgb(255 0 0)" };
    const strokeProperties = { strokeStyle: "rgb(0 0 255)", lineWidth: 4 };
    const run = (style) => {
      const canvas = new OffscreenCanvas(2, 2);
      const result = renderer.renderText("Hello", style, { canvas, fontResolution: 64 });
      return e2e.stats(result);
    };
    return {
      fill: run(e2e.makeStyle({ ...baseStyle, drawMode: "fill", fillProperties })),
      stroke: run(e2e.makeStyle({ ...baseStyle, drawMode: "stroke", strokeProperties })),
      both: run(e2e.makeStyle({ ...baseStyle, fillProperties, strokeProperties })),
    };
  });
  assert.ok(modes.fill.red > 0, "fill must render red pixels");
  assert.equal(modes.fill.blue, 0, "fill-only must not render stroke pixels");
  assert.ok(modes.stroke.blue > 0, "stroke must render blue pixels");
  assert.equal(modes.stroke.red, 0, "stroke-only must not render fill pixels");
  assert.ok(modes.both.red > 0 && modes.both.blue > 0, "both must render fill and stroke");

  // 5. valign。CJK フォント依存を避ける為 examCharacter は "H" に固定
  const valign = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const run = (value) => {
      const canvas = new OffscreenCanvas(2, 2);
      const style = e2e.makeStyle({ fontWithoutSize: "sans-serif", valign: value });
      const result = renderer.renderText("Hello", style, { canvas, fontResolution: 64 });
      return e2e.stats(result).bbox.y;
    };
    return { top: run("top"), middle: run("middle"), bottom: run("bottom") };
  });
  assert.ok(
    valign.top < valign.middle && valign.middle < valign.bottom,
    `valign must move ink down in order (top=${valign.top}, middle=${valign.middle}, bottom=${valign.bottom})`,
  );

  // 6. sizeLimit。幅が上限で clamp され、高さはアスペクト比から丸められる
  const limit = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const style = e2e.makeStyle({ fontWithoutSize: "sans-serif" });
    const text = "Hello world Hello world";
    const smallCanvas = new OffscreenCanvas(2, 2);
    const largeCanvas = new OffscreenCanvas(2, 2);
    const small = renderer.renderText(text, style, { canvas: smallCanvas, fontResolution: 256, sizeLimit: 100 });
    const large = renderer.renderText(text, style, { canvas: largeCanvas, fontResolution: 256, sizeLimit: 100000 });
    return {
      small: { width: small.width, height: small.height },
      large: { width: large.width, height: large.height },
    };
  });
  assert.equal(limit.small.width, 100, "sizeLimit must clamp the width");
  assert.ok(Math.max(limit.small.width, limit.small.height) <= 100, "sizeLimit must cap every side");
  assert.ok(limit.small.height >= 2, "sizeLimit must keep a drawable height");
  const expectedHeight = Math.round((limit.small.width / (limit.large.width / limit.large.height)) / 2) * 2;
  assert.ok(
    Math.abs(limit.small.height - expectedHeight) <= 2,
    `sizeLimit must keep the aspect ratio (height=${limit.small.height}, expected≈${expectedHeight})`,
  );

  // 7. canvas の使い回しと明示 canvas
  const lifecycle = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const style = e2e.makeStyle({ fontWithoutSize: "sans-serif" });
    const first = renderer.renderText("Hello", style, { fontResolution: 64 });
    const firstStats = e2e.stats(first);
    const second = renderer.renderText("World", style, { fontResolution: 64 });
    const secondStats = e2e.stats(second);
    const own = new OffscreenCanvas(2, 2);
    const explicit = renderer.renderText("Own", style, { canvas: own, fontResolution: 64 });
    const explicitStats = e2e.stats(explicit);
    return {
      same: first === second,
      explicitReturned: explicit === own,
      firstInk: firstStats.ink,
      secondInk: secondStats.ink,
      explicitInk: explicitStats.ink,
    };
  });
  assert.equal(lifecycle.same, true, "省略時は同じ canvas を使い回す");
  assert.equal(lifecycle.explicitReturned, true, "明示 canvas はそのまま返す");
  assert.ok(lifecycle.firstInk > 0 && lifecycle.secondInk > 0 && lifecycle.explicitInk > 0, "各描画に ink がある");

  // 8. 再利用時に前回の色 / context state が残らない
  const stale = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const common = { fontWithoutSize: "sans-serif", drawMode: "fill" };
    const red = e2e.makeStyle({ ...common, properties: { fillStyle: "rgb(255 0 0)" } });
    const blue = e2e.makeStyle({ ...common, properties: { fillStyle: "rgb(0 0 255)" } });
    const first = renderer.renderText("Hello", red, { fontResolution: 64 });
    const firstStats = e2e.stats(first);
    const second = renderer.renderText("Hello", blue, { fontResolution: 64 });
    const secondStats = e2e.stats(second);
    return {
      same: first === second,
      firstRed: firstStats.red,
      secondRed: secondStats.red,
      secondBlue: secondStats.blue,
    };
  });
  assert.equal(stale.same, true);
  assert.ok(stale.firstRed > 0, "1 回目は赤い ink がある");
  assert.equal(stale.secondRed, 0, "2 回目に赤い ink が残らない");
  assert.ok(stale.secondBlue > 0, "2 回目は青い ink がある");

  // 9. waitForFonts は fonts が無い / ready が無い環境でも解決する
  const fonts = await page.evaluate(() => e2e.waitForFonts().then(() => true));
  assert.equal(fonts, true, "waitForFonts must resolve");

  // 9b. main thread で実際に読み込みが始まると FontFaceSet.status は同期で loading になる
  const probe = await context.newPage();
  try {
    await probe.goto(`${origin}/tests/fixtures/page.html`);
    await probe.waitForFunction(() => globalThis.e2e !== undefined, null, { timeout: 5000 });
    const transition = await probe.evaluate(async () => {
      const face = new FontFace("E2EProbe", "url(http://127.0.0.1:1/nope.woff2)");
      document.fonts.add(face);
      const loading = document.fonts.load("16px E2EProbe", "x");
      loading.catch(() => {});
      const statusWhileLoading = document.fonts.status;
      const loadedEarly = await Promise.race([
        e2e.waitForFonts({ status: "loaded", ready: new Promise(() => {}) }).then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
      ]);
      const loadingWaits = await Promise.race([
        e2e.waitForFonts({ status: "loading", ready: Promise.resolve() }).then(() => "returned"),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
      ]);
      return { statusWhileLoading, loadedEarly, loadingWaits };
    });
    assert.equal(transition.statusWhileLoading, "loading", "font loading must flip status synchronously");
    assert.equal(transition.loadedEarly, "returned", "worker workaround must keep the early return");
    assert.equal(transition.loadingWaits, "returned", "loading status must await ready");
  } finally {
    await probe.close();
  }

  // 10. 不正な CSS font は実ブラウザで黙って既定フォントへ落ちず例外になる
  const invalidFont = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const style = e2e.makeStyle({ fontWithoutSize: "{size}px serif" });
    const canvas = new OffscreenCanvas(2, 2);
    try {
      renderer.renderText("x", style, { canvas });
      return "no-error";
    } catch (error) {
      return error.message.includes("invalid CSS font") ? "rejected" : `wrong:${error.message}`;
    }
  });
  assert.equal(invalidFont, "rejected", `invalid font must be rejected (${invalidFont})`);

  // 11. style 省略 / undefined 時は makeStyle() 既定値と同じ描画になる
  const omitted = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    // 既定 canvas は次の renderText で上書きされる為、描画直後に集計する
    const omittedStats = e2e.stats(renderer.renderText("Hello", undefined, { fontResolution: 64 }));
    const explicitCanvas = new OffscreenCanvas(2, 2);
    const explicit = renderer.renderText("Hello", e2e.makeStyle(), { canvas: explicitCanvas, fontResolution: 64 });
    return { omittedStats, explicitStats: e2e.stats(explicit) };
  });
  assert.ok(omitted.omittedStats.ink > 0, "style 省略時も ink を描画する");
  assert.equal(omitted.omittedStats.width, omitted.explicitStats.width, "省略時と makeStyle() で幅が一致する");
  assert.equal(omitted.omittedStats.height, omitted.explicitStats.height, "省略時と makeStyle() で高さが一致する");
  assert.deepEqual(omitted.omittedStats.bbox, omitted.explicitStats.bbox, "省略時と makeStyle() で ink 位置が一致する");
  assert.equal(omitted.omittedStats.ink, omitted.explicitStats.ink, "省略時と makeStyle() で ink 量が一致する");

  assert.deepEqual(errors, []);
  console.log(`OK: main thread (${base.width}x${base.height}, ink=${base.stats.ink}, html ink=${html.stats.ink}, trim=${trim.plain.edgeInk}->${trim.trimmed.edgeInk}, modes=${modes.fill.red}/${modes.stroke.blue}/${modes.both.red + modes.both.blue}, valign=${valign.top}/${valign.middle}/${valign.bottom}, sizeLimit=${limit.small.width}x${limit.small.height}, omitted ink=${omitted.omittedStats.ink})`);
} finally {
  await close();
}
