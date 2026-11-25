// 実機テスト用ページのエントリ。esbuild で bundle して /e2e/page-entry.js として配信する。
import * as Api from "../../src/index.mjs";
import { stats } from "./pixel-stats.mjs";

globalThis.e2e = {
  ...Api,
  stats,
};
