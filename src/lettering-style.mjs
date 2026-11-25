// 文字描画 style の正規化。
//
// - `makeStyle()` の戻り値だけを renderer へ渡す
// - `style` 省略時用に `makeStyle()` 由来の固定 `fallbackStyle` を 1 個だけ保持する
// - CanvasGradient 等の非 plain オブジェクトは参照のまま保持する
// - 詳細な入力検証は `@tir.jp/is-dev` の dev ブロックへ閉じ込める
// - 破壊的なキーと壊れた値だけは prod にも残す通常チェックで拒否する

import * as IsDev from "@tir.jp/is-dev";

export const errorPrefix = "ephemeral-lettering-canvas:";

const STYLE_KEYS = new Set([
  "fontWithoutSize",
  "properties",
  "fillProperties",
  "strokeProperties",
  "padding",
  "useMaxWidth",
  "trimOutermostPixels",
  "valign",
  "drawMode",
  "lineWidthRatio",
  "shadowOffsetXRatio",
  "shadowOffsetYRatio",
  "shadowBlurRatio",
  "offsetXRatio",
  "offsetYRatio",
]);

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROPERTY_RESERVED_KEYS = new Set(["font", "textBaseline", "valign"]);
const SUB_PROPERTY_RESERVED_KEYS = new Set(["font", "textBaseline", "textAlign", "valign"]);
const PADDING_KEYS = new Set(["left", "top", "right", "bottom"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const VALIGNS = new Set(["top", "middle", "bottom"]);
const DRAW_MODES = new Set(["both", "fill", "stroke"]);
const RATIO_KEYS = [
  "lineWidthRatio",
  "shadowOffsetXRatio",
  "shadowOffsetYRatio",
  "shadowBlurRatio",
  "offsetXRatio",
  "offsetYRatio",
];
const FONT_SIZE_TOKEN = /\d+(?:\.\d+)?(?:px|pt|pc|em|rem|ex|ch|in|cm|mm|q|vw|vh|vmin|vmax|%)/i;

const defaultStyle = {
  fontWithoutSize: "serif",
  properties: {
    textAlign: "center",
    fillStyle: "rgb(255 255 255 / 1)",
    strokeStyle: "rgb(0 0 0 / 0.2)",
    miterLimit: 2,
    shadowColor: "rgb(0 0 0 / 0.8)",
  },
  fillProperties: {},
  strokeProperties: {},
  padding: 2 / 16,
  useMaxWidth: true,
  trimOutermostPixels: false,
  valign: "middle",
  drawMode: "both",
  lineWidthRatio: 2 / 16,
  shadowOffsetXRatio: 3 / 32,
  shadowOffsetYRatio: 3 / 32,
  shadowBlurRatio: 1 / 32,
  offsetXRatio: 0,
  offsetYRatio: -1 / 32,
};

const styleRegistry = new WeakSet();

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { return false }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const fail = (message) => {
  throw new Error(`${errorPrefix} ${message}`);
};

// `to[key] = ...` で __proto__ を踏ませない為、prod でも必ず通す
export const safeEntries = (value, label) => {
  if (value === undefined) { return [] }
  if (!isPlainObject(value)) { fail(`${label} must be a plain object`) }
  const entries = [];
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) { fail(`${label}.${key} is not allowed`) }
    entries.push([key, child]);
  }
  return entries;
};

const copyValue = (value, label) => {
  if (Array.isArray(value)) { return Object.freeze(value.map((child) => copyValue(child, label))) }
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, child] of safeEntries(value, label)) {
      copy[key] = copyValue(child, label);
    }
    return Object.freeze(copy);
  }
  return value;
};

const mergeProperties = (base, params, label) => {
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = copyValue(value, label);
  }
  for (const [key, value] of safeEntries(params, label)) {
    result[key] = copyValue(value, label);
  }
  return Object.freeze(result);
};

const normalizePadding = (padding) => {
  if (typeof padding === "number") {
    if (!Number.isFinite(padding) || padding < 0 || padding >= 0.5) { fail("padding must be a finite number >= 0 and < 0.5") }
    return Object.freeze({ left: padding, top: padding, right: padding, bottom: padding });
  }
  if (!isPlainObject(padding)) { fail("padding must be a number or a plain object") }
  const result = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const [key, value] of safeEntries(padding, "padding")) {
    if (!PADDING_KEYS.has(key)) { fail(`padding.${key} is not allowed`) }
    if (!Number.isFinite(value) || value < 0 || value >= 0.5) { fail(`padding.${key} must be a finite number >= 0 and < 0.5`) }
    result[key] = value;
  }
  if (result.left + result.right >= 1) { fail("padding.left + padding.right must be < 1") }
  if (result.top + result.bottom >= 1) { fail("padding.top + padding.bottom must be < 1") }
  return Object.freeze(result);
};

const devCheckParams = (params) => {
  if (!IsDev.isDev) { return }
  const invalids = Object.fromEntries(
    Object.entries(params).filter(([key]) => !STYLE_KEYS.has(key)),
  );
  IsDev.assertOnlyValidParams(invalids);
  IsDev.assert(params.fontWithoutSize === undefined || typeof params.fontWithoutSize === "string", "dev: fontWithoutSize must be a string");
  IsDev.assert(params.useMaxWidth === undefined || typeof params.useMaxWidth === "boolean", "dev: useMaxWidth must be a boolean");
  IsDev.assert(params.trimOutermostPixels === undefined || typeof params.trimOutermostPixels === "boolean", "dev: trimOutermostPixels must be a boolean");
};

const checkReserved = (properties, reserved, label) => {
  for (const [key] of safeEntries(properties, label)) {
    if (reserved.has(key)) { fail(`${label}.${key} is managed by the renderer`) }
  }
};

export const makeStyle = (params = {}) => {
  if (!isPlainObject(params)) { fail("style params must be a plain object") }
  devCheckParams(params);

  const merged = {};
  for (const key of STYLE_KEYS) {
    merged[key] = params[key] ?? defaultStyle[key];
  }
  merged.properties = mergeProperties(defaultStyle.properties, params.properties, "properties");
  merged.fillProperties = mergeProperties({}, params.fillProperties, "fillProperties");
  merged.strokeProperties = mergeProperties({}, params.strokeProperties, "strokeProperties");

  if (typeof merged.fontWithoutSize !== "string" || !merged.fontWithoutSize.trim()) { fail("fontWithoutSize must be a non-empty string") }
  if (FONT_SIZE_TOKEN.test(merged.fontWithoutSize.replaceAll("{size}", ""))) { fail("fontWithoutSize must not contain a font size; use {size}") }
  if ((merged.fontWithoutSize.match(/\{size\}/g) ?? []).length > 1) { fail("fontWithoutSize must contain at most one {size}") }

  checkReserved(merged.properties, PROPERTY_RESERVED_KEYS, "properties");
  checkReserved(merged.fillProperties, SUB_PROPERTY_RESERVED_KEYS, "fillProperties");
  checkReserved(merged.strokeProperties, SUB_PROPERTY_RESERVED_KEYS, "strokeProperties");
  if (merged.properties.textAlign !== undefined && !TEXT_ALIGNS.has(merged.properties.textAlign)) {
    fail("properties.textAlign must be left, center, or right");
  }
  if (!VALIGNS.has(merged.valign)) { fail("valign must be top, middle, or bottom") }
  if (!DRAW_MODES.has(merged.drawMode)) { fail("drawMode must be both, fill, or stroke") }
  if (typeof merged.useMaxWidth !== "boolean") { fail("useMaxWidth must be a boolean") }
  if (typeof merged.trimOutermostPixels !== "boolean") { fail("trimOutermostPixels must be a boolean") }
  for (const key of RATIO_KEYS) {
    if (!Number.isFinite(merged[key])) { fail(`${key} must be a finite number`) }
  }
  if (merged.lineWidthRatio < 0) { fail("lineWidthRatio must be >= 0") }
  if (merged.shadowBlurRatio < 0) { fail("shadowBlurRatio must be >= 0") }

  const style = Object.freeze({ ...merged, padding: normalizePadding(merged.padding) });
  styleRegistry.add(style);
  return style;
};

// renderText() で style が省略された時の固定キー。registry 登録と freeze は makeStyle() に任せる
export const fallbackStyle = makeStyle();

export const isStyle = (value) => styleRegistry.has(value);

// padding の割合を最終キャンバス高さ基準の px へ変換する
export const paddingPxAt = (padding, height) => ({
  left: padding.left * height,
  top: padding.top * height,
  right: padding.right * height,
  bottom: padding.bottom * height,
});
