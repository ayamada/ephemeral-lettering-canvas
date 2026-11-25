// style 正規化の最小 unit テスト。
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeStyle } from "../src/index.mjs";
import * as Style from "../src/lettering-style.mjs";

test("makeStyle: 既定値・freeze・padding 正規化", () => {
  const style = makeStyle();
  assert.equal(style.fontWithoutSize, "serif");
  assert.equal(style.drawMode, "both");
  assert.equal(style.useMaxWidth, true);
  assert.equal(style.trimOutermostPixels, false);
  assert.deepEqual(style.padding, { left: 2 / 16, top: 2 / 16, right: 2 / 16, bottom: 2 / 16 });
  assert.equal(Object.isFrozen(style), true);
  assert.equal(Object.isFrozen(style.properties), true);
  assert.equal(Object.isFrozen(style.padding), true);
  assert.equal(Style.isStyle(style), true);
  assert.equal(Style.isStyle({ ...style }), false);

  assert.deepEqual(makeStyle({ padding: 0.1 }).padding, { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 });
  assert.deepEqual(makeStyle({ padding: { top: 0.1 } }).padding, { left: 0, top: 0.1, right: 0, bottom: 0 });
});

test("makeStyle: fallbackStyle は makeStyle() 由来の固定 style", () => {
  assert.equal(Style.isStyle(Style.fallbackStyle), true);
  assert.equal(Object.isFrozen(Style.fallbackStyle), true);
  assert.equal(Object.isFrozen(Style.fallbackStyle.properties), true);
  assert.equal(Object.isFrozen(Style.fallbackStyle.padding), true);
  assert.deepEqual(Style.fallbackStyle, makeStyle());
  assert.notEqual(Style.fallbackStyle, makeStyle(), "fallbackStyle は毎回の makeStyle() とは別オブジェクト");
});

test("makeStyle: 未知キー・予約キー・不正値", () => {
  assert.throws(() => makeStyle({ unknown: 1 }), /found invalid parameters/);
  assert.throws(() => makeStyle({ properties: { valign: "top" } }), /properties\.valign is managed/);
  assert.throws(() => makeStyle({ fillProperties: { textAlign: "left" } }), /fillProperties\.textAlign is managed/);
  assert.throws(() => makeStyle({ properties: { textAlign: "start" } }), /textAlign must be left/);
  assert.throws(() => makeStyle({ drawMode: "outline" }), /drawMode must be both/);
  assert.throws(() => makeStyle({ useMaxWidth: 1 }), /useMaxWidth must be a boolean/);
  assert.throws(() => makeStyle({ lineWidthRatio: NaN }), /lineWidthRatio must be a finite number/);
  assert.throws(() => makeStyle({ padding: 0.5 }), /padding must be a finite number/);
});

test("makeStyle: fontWithoutSize はサイズを含めず {size} は高々 1 個", () => {
  assert.doesNotThrow(() => makeStyle({ fontWithoutSize: "bold {size} sans-serif" }));
  assert.throws(() => makeStyle({ fontWithoutSize: "bold 12px serif" }), /must not contain a font size/);
  assert.throws(() => makeStyle({ fontWithoutSize: "2em serif" }), /must not contain a font size/);
  assert.throws(() => makeStyle({ fontWithoutSize: "bold {size} {size} serif" }), /at most one \{size\}/);
});

test("makeStyle: 危険キーを拒否し、配列は置換して freeze する", () => {
  const withProto = JSON.parse('{"properties":{"__proto__":{"polluted":true}}}');
  assert.throws(() => makeStyle(withProto), /properties\.__proto__ is not allowed/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => makeStyle({ properties: { constructor: 1 } }), /properties\.constructor is not allowed/);
  assert.throws(() => makeStyle({ fillProperties: { prototype: 1 } }), /fillProperties\.prototype is not allowed/);

  const base = makeStyle({ properties: { lineDash: [1, 2, 3] } });
  assert.deepEqual(base.properties.lineDash, [1, 2, 3]);
  assert.equal(Object.isFrozen(base.properties.lineDash), true);
  assert.deepEqual(makeStyle({ properties: { lineDash: [9] } }).properties.lineDash, [9]);
});

test("makeStyle: 非 plain オブジェクトは参照のまま", () => {
  const FakeGradient = function FakeGradient() { this.addColorStop = () => {} };
  const gradient = new FakeGradient();
  const style = makeStyle({ properties: { fillStyle: gradient } });
  assert.equal(style.properties.fillStyle, gradient);
  assert.equal(Object.isFrozen(gradient), false);
});

test("paddingPxAt: 割合を高さ基準の px へ変換する", () => {
  const style = makeStyle({ padding: { left: 0.1, top: 0.2, right: 0, bottom: 0.05 } });
  assert.deepEqual(Style.paddingPxAt(style.padding, 200), { left: 20, top: 40, right: 0, bottom: 10 });
  assert.deepEqual(Style.paddingPxAt(style.padding, 0), { left: 0, top: 0, right: 0, bottom: 0 });
});
