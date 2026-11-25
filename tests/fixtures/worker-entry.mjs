// worker 側の実機テストエントリ。esbuild で bundle して /e2e/worker-entry.js として配信する。
import * as Api from "../../src/index.mjs";
import { stats } from "./pixel-stats.mjs";

const run = async () => {
  await Api.waitForFonts();
  const renderer = Api.createRenderer({ examCharacter: "H" });
  // 既定 canvas は次の renderText で上書きされる為、それぞれ描画直後に集計する
  const omittedStats = stats(renderer.renderText("Hello", undefined, { fontResolution: 64 }));
  const style = Api.makeStyle({ fontWithoutSize: "sans-serif" });
  const result = renderer.renderText("Hello", style, { fontResolution: 64 });
  const pixelStats = stats(result);
  return {
    isOffscreen: typeof OffscreenCanvas === "function" && result instanceof OffscreenCanvas,
    hasDocument: typeof document !== "undefined",
    stats: pixelStats,
    omittedStats,
  };
};

self.onmessage = async () => {
  try {
    self.postMessage({ ok: true, ...(await run()) });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error?.stack ?? error) });
  }
};
