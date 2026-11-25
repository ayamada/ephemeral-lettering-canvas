// worker の playwright 実機テスト。
// esbuild bundle 済みの /e2e/worker-entry.js を module worker として読み込む。
import assert from "node:assert/strict";

import { openTestPage } from "./browser-harness.mjs";

const { page, errors, close } = await openTestPage({ path: "/tests/fixtures/page.html" });

try {
  // 比較用の main thread 描画。worker と同じ条件にする
  const main = await page.evaluate(() => {
    const renderer = e2e.createRenderer({ examCharacter: "H" });
    const style = e2e.makeStyle({ fontWithoutSize: "sans-serif" });
    const canvas = renderer.renderText("Hello", style, { fontResolution: 64 });
    return { stats: e2e.stats(canvas) };
  });

  const worker = await page.evaluate(() => new Promise((resolve, reject) => {
    const instance = new Worker("/e2e/worker-entry.js", { type: "module" });
    const timer = setTimeout(() => {
      instance.terminate();
      reject(new Error("worker timeout"));
    }, 10000);
    instance.onerror = (event) => {
      clearTimeout(timer);
      instance.terminate();
      reject(new Error(event.message));
    };
    instance.onmessage = (event) => {
      clearTimeout(timer);
      instance.terminate();
      resolve(event.data);
    };
    instance.postMessage("run");
  }));

  assert.equal(worker.ok, true, `worker must succeed: ${worker.error}`);
  assert.equal(worker.isOffscreen, true, "worker must use OffscreenCanvas");
  assert.equal(worker.hasDocument, false, "worker must not have document");
  assert.equal(worker.stats.height, 64, "fontResolution must be the final canvas height");
  assert.ok(worker.stats.width > worker.stats.height, "worker text must be horizontal");
  assert.ok(worker.stats.ink > 0, "worker must render text ink");
  assert.ok(worker.stats.bbox, "worker text must have an ink bounding box");
  assert.ok(worker.stats.bbox.w > worker.stats.bbox.h, "worker text bbox must be horizontal");

  assert.ok(worker.omittedStats.ink > 0, "worker must render omitted-style ink");
  assert.equal(worker.omittedStats.height, 64, "omitted style must keep fontResolution");
  assert.ok(worker.omittedStats.width > worker.omittedStats.height, "omitted style text must be horizontal");
  assert.ok(worker.omittedStats.bbox, "omitted style must have an ink bounding box");

  assert.equal(worker.stats.width, main.stats.width, "worker and main thread must agree on the canvas width");
  assert.equal(worker.stats.height, main.stats.height, "worker and main thread must agree on the canvas height");
  assert.ok(
    Math.abs(worker.stats.ink - main.stats.ink) <= Math.max(1, main.stats.ink * 0.01),
    `worker and main thread must render the same ink (worker=${worker.stats.ink}, main=${main.stats.ink})`,
  );

  assert.deepEqual(errors, []);
  console.log(`OK: worker (${worker.stats.width}x${worker.stats.height}, ink=${worker.stats.ink}, main ink=${main.stats.ink}, omitted ink=${worker.omittedStats.ink})`);
} finally {
  await close();
}
