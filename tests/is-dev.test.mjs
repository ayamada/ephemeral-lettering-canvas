// @tir.jp/is-dev の dev / prod 挙動と esbuild bundle の確認。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import * as Api from "../src/index.mjs";

const rootPath = fileURLToPath(new URL("../", import.meta.url));

test("dev: 未知キーは例外", () => {
  assert.throws(() => Api.makeStyle({ unknown: 1 }), /found invalid parameters/);
  assert.throws(() => Api.createRenderer({ unknown: 1 }), /found invalid parameters/);
  const renderer = Api.createRenderer();
  assert.throws(
    () => renderer.renderText("x", Api.makeStyle(), { unknown: 1 }),
    /found invalid parameters/,
  );
});

test("prod bundle: dev 専用検証は runtime で no-op / style 省略も動く", async () => {
  const entry = [
    "const makeCtx = () => ({",
    '  font: "10px sans-serif",',
    "  measureText: (text) => ({ width: text.length * 10 }),",
    "  fillText() {},",
    "  strokeText() {},",
    "  clearRect() {},",
    "  save() {},",
    "  restore() {},",
    "  setLineDash() {},",
    "  getImageData: (x, y, width, height) => ({",
    "    width,",
    "    height,",
    "    data: new Uint8ClampedArray(width * height * 4),",
    "  }),",
    "});",
    "globalThis.OffscreenCanvas = function OffscreenCanvas(width, height) {",
    "  this.width = width;",
    "  this.height = height;",
    "  const ctx = makeCtx();",
    "  this.getContext = () => ctx;",
    "};",
    'import { makeStyle, createRenderer } from "./src/index.mjs";',
    "const style = makeStyle({ unknown: 1 });",
    "const renderer = createRenderer({ unknown: 1 });",
    'const canvas = renderer.renderText("x");',
    'globalThis.__dceOk = typeof style === "object" && typeof renderer.renderText === "function" && canvas.width >= 2;',
  ].join("\n");

  const bundled = await esbuild.build({
    stdin: { contents: entry, resolveDir: rootPath, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    minify: true,
    define: { IS_DEV: "false", IS_PROD: "true" },
    logLevel: "silent",
    legalComments: "none",
  });
  // 1 パス目は `if (!1) { ... }` を残す事がある為、2 パス目で定数畳み込みを進める
  const compact = await esbuild.transform(bundled.outputFiles[0].text, {
    loader: "js",
    format: "esm",
    minify: true,
  });

  // esbuild 側の DCE が不完全な場合は文字列 assertion だけ諦める(ユーザー指示)
  if (!compact.code.includes("dev:")) {
    assert.ok(!compact.code.includes("found invalid parameters"));
  }

  const dataUrl = `data:text/javascript;base64,${Buffer.from(compact.code).toString("base64")}`;
  const savedOffscreenCanvas = globalThis.OffscreenCanvas;
  try {
    await import(dataUrl);
    assert.equal(globalThis.__dceOk, true);
  } finally {
    delete globalThis.__dceOk;
    if (savedOffscreenCanvas === undefined) { delete globalThis.OffscreenCanvas }
    else { globalThis.OffscreenCanvas = savedOffscreenCanvas }
  }
});

test("src/index.mjs は DOM 無しで import できる", () => {
  const script = [
    "delete globalThis.OffscreenCanvas;",
    "delete globalThis.document;",
    "await import('./src/index.mjs');",
    "console.log('ok');",
  ].join("\n");
  const output = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: rootPath, encoding: "utf8" },
  );
  assert.equal(output.trim(), "ok");
});
