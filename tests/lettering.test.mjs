// renderer の unit テスト。DOM / OffscreenCanvas が無い Node でも動くよう、
// 関数ベースの偽 canvas を globalThis へ注入する。
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRenderer, makeStyle, waitForFonts } from "../src/index.mjs";

const defaultContextProps = () => ({
  textAlign: "start",
  textBaseline: "alphabetic",
  fillStyle: "#000",
  strokeStyle: "#000",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  miterLimit: 10,
  lineDashOffset: 0,
  lineDash: [],
  shadowColor: "rgba(0, 0, 0, 0)",
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
  filter: "none",
  imageSmoothingEnabled: true,
  direction: "inherit",
  fontKerning: "auto",
  fontStretch: "normal",
  fontVariantCaps: "normal",
  textRendering: "auto",
  letterSpacing: "0px",
  wordSpacing: "0px",
});

const makeFakeCanvasEnv = ({
  inkTop = 10,
  inkBottom = 20,
  failImageData = false,
  strictFont = false,
  singleton = false,
} = {}) => {
  const canvases = [];
  const snapshots = new WeakMap();
  let getImageDataCalls = 0;
  let createCount = 0;
  let shared = null;

  const makeCanvas = (initialWidth, initialHeight) => {
    const state = {
      width: initialWidth,
      height: initialHeight,
      calls: [],
      measureFonts: [],
    };
    let fontValue = "10px sans-serif";
    const ctx = {
      ...defaultContextProps(),
      measureText(text) {
        state.measureFonts.push(this.font);
        const match = /([\d.]+)px/.exec(this.font);
        const fontSize = match ? Number(match[1]) : 10;
        return { width: String(text).length * fontSize * 0.5 };
      },
      fillText(text, x, y, maxWidth) {
        const call = {
          op: "fill",
          text,
          x,
          y,
          maxWidth,
          font: this.font,
          textAlign: this.textAlign,
          textBaseline: this.textBaseline,
          fillStyle: this.fillStyle,
          globalAlpha: this.globalAlpha,
          shadowOffsetX: this.shadowOffsetX,
          shadowOffsetY: this.shadowOffsetY,
          shadowBlur: this.shadowBlur,
        };
        state.calls.push(call);
      },
      strokeText(text, x, y, maxWidth) {
        const call = {
          op: "stroke",
          text,
          x,
          y,
          maxWidth,
          font: this.font,
          textAlign: this.textAlign,
          textBaseline: this.textBaseline,
          strokeStyle: this.strokeStyle,
          lineWidth: this.lineWidth,
          globalAlpha: this.globalAlpha,
          shadowOffsetX: this.shadowOffsetX,
          shadowOffsetY: this.shadowOffsetY,
          shadowBlur: this.shadowBlur,
        };
        state.calls.push(call);
      },
      clearRect(x, y, width, height) {
        state.calls.push({ op: "clearRect", x, y, width, height });
      },
      save() {
        const props = defaultContextProps();
        for (const key of Object.keys(props)) { props[key] = ctx[key] }
        props.font = ctx.font;
        const stack = snapshots.get(ctx) ?? [];
        stack.push(props);
        snapshots.set(ctx, stack);
        state.calls.push({ op: "save" });
      },
      restore() {
        const stack = snapshots.get(ctx) ?? [];
        const props = stack.pop();
        if (props) { Object.assign(ctx, props) }
        state.calls.push({ op: "restore" });
      },
      setLineDash(value) { ctx.lineDash = [...value] },
      getImageData(x, y, width, height) {
        getImageDataCalls += 1;
        if (failImageData) { throw new Error("getImageData is unavailable") }
        const data = new Uint8ClampedArray(width * height * 4);
        const firstRow = 1 + inkTop;
        const lastRow = height - 2 - inkBottom;
        for (let row = Math.max(0, firstRow); row <= Math.min(height - 1, lastRow); row += 1) {
          for (let col = 0; col < width; col += 1) {
            data[(row * width + col) * 4 + 3] = 255;
          }
        }
        return { width, height, data };
      },
    };

    Object.defineProperty(ctx, "font", {
      get: () => fontValue,
      set: (value) => {
        if (!strictFont || !value.includes("pxpx")) { fontValue = value }
      },
    });

    const resetProps = () => {
      Object.assign(ctx, defaultContextProps());
      ctx.font = "10px sans-serif";
      ctx.lineDash = [];
    };

    const canvas = {};
    Object.defineProperties(canvas, {
      width: {
        get: () => state.width,
        set: (value) => {
          state.width = value;
          resetProps();
          state.calls.push({ op: "resize", width: value, height: state.height });
        },
      },
      height: {
        get: () => state.height,
        set: (value) => {
          state.height = value;
          resetProps();
          state.calls.push({ op: "resize", width: state.width, height: value });
        },
      },
    });
    canvas.getContext = (type) => (type === "2d" ? ctx : null);
    canvas.__state = state;
    canvas.__ctx = ctx;
    canvas.__calls = state.calls;
    canvas.__resetLog = () => {
      state.calls.length = 0;
      state.measureFonts.length = 0;
    };
    canvases.push(canvas);
    return canvas;
  };

  const FakeOffscreenCanvas = function FakeOffscreenCanvas(width, height) {
    createCount += 1;
    if (singleton) {
      if (shared === null) { shared = makeCanvas(width, height) }
      return shared;
    }
    return makeCanvas(width, height);
  };

  const FakeDocument = {
    createElement: (tag) => {
      if (tag !== "canvas") { throw new Error(`unexpected element: ${tag}`) }
      return makeCanvas(0, 0);
    },
  };

  return {
    FakeOffscreenCanvas,
    FakeDocument,
    canvases,
    create: makeCanvas,
    getCreateCount: () => createCount,
    getImageDataCalls: () => getImageDataCalls,
    resetImageDataCalls: () => { getImageDataCalls = 0 },
    clearLogs: () => {
      for (const canvas of canvases) { canvas.__resetLog() }
    },
  };
};

const withGlobals = async (values, fn) => {
  const originals = new Map();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, {
      has: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: globalThis[key],
    });
    if (value === undefined) { delete globalThis[key] }
    else { globalThis[key] = value }
  }
  try {
    return await fn();
  } finally {
    for (const [key, original] of originals) {
      if (original.has) { globalThis[key] = original.value }
      else { delete globalThis[key] }
    }
  }
};

const withFakeCanvas = (options, fn) => {
  const env = makeFakeCanvasEnv(options);
  return withGlobals(
    { OffscreenCanvas: env.FakeOffscreenCanvas, document: env.FakeDocument },
    () => fn(env),
  );
};

const drawCalls = (canvas) => canvas.__calls.filter((call) => call.op === "fill" || call.op === "stroke");

test("renderText: サイズ・フォント・描画順・maxWidth", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const style = makeStyle({
      fontWithoutSize: "italic bold {size} sans-serif",
      offsetYRatio: 0,
      offsetXRatio: 0,
    });
    env.clearLogs();
    const canvas = renderer.renderText("abc", style, { fontResolution: 100 });
    assert.equal(canvas.height, 100);
    assert.equal(canvas.width, 138);
    const calls = drawCalls(canvas);
    assert.deepEqual(calls.map((call) => call.op), ["stroke", "fill"]);
    for (const call of calls) {
      assert.equal(call.font, "italic bold 75px sans-serif");
      assert.equal(call.textBaseline, "middle");
      assert.equal(call.textAlign, "center");
      assert.equal(call.maxWidth, 113);
      assert.equal(call.text, "abc");
    }
    assert.equal(calls[0].x, 69);
    assert.equal(calls[0].y, 56);
    assert.ok(Math.abs(calls[0].lineWidth - (2 / 16) * 75) < 1e-9);
    assert.ok(Math.abs(calls[0].shadowOffsetX - (3 / 32) * 75) < 1e-9);
  });
});

test("renderText: useMaxWidth=false / drawMode / textAlign", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const noMax = makeStyle({ useMaxWidth: false, offsetYRatio: 0 });
    env.clearLogs();
    assert.equal(drawCalls(renderer.renderText("abc", noMax, { fontResolution: 100 }))[0].maxWidth, undefined);

    const fill = makeStyle({ drawMode: "fill" });
    env.clearLogs();
    assert.deepEqual(drawCalls(renderer.renderText("abc", fill, { fontResolution: 100 })).map((call) => call.op), ["fill"]);
    const stroke = makeStyle({ drawMode: "stroke" });
    env.clearLogs();
    assert.deepEqual(drawCalls(renderer.renderText("abc", stroke, { fontResolution: 100 })).map((call) => call.op), ["stroke"]);

    const left = makeStyle({ properties: { textAlign: "left" }, offsetYRatio: 0 });
    env.clearLogs();
    assert.equal(drawCalls(renderer.renderText("abc", left, { fontResolution: 100 }))[0].x, 13);
    const right = makeStyle({ properties: { textAlign: "right" }, offsetYRatio: 0 });
    env.clearLogs();
    assert.equal(drawCalls(renderer.renderText("abc", right, { fontResolution: 100 }))[0].x, 126);
  });
});

test("renderText: fontResolution / padding / 既定値 / sizeLimit", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const style = makeStyle({ offsetYRatio: 0 });
    env.clearLogs();
    const tall = renderer.renderText("x", style, { fontResolution: 200 });
    assert.equal(tall.height, 200);
    assert.match(drawCalls(tall)[0].font, /150px/);
    env.clearLogs();
    const padded = renderer.renderText("x", makeStyle({ padding: 0, offsetYRatio: 0 }), { fontResolution: 100 });
    assert.equal(padded.height, 100);
    assert.match(drawCalls(padded)[0].font, /100px/);
    env.clearLogs();
    const fallback = renderer.renderText("x", makeStyle({ offsetYRatio: 0 }));
    assert.equal(fallback.height, 62);
    assert.match(drawCalls(fallback)[0].font, /47px/);
    env.clearLogs();
    const limited = renderer.renderText("abcdefghij", makeStyle({ offsetYRatio: 0 }), {
      fontResolution: 200,
      sizeLimit: 100,
    });
    assert.equal(limited.width, 100);
    assert.equal(limited.width % 2, 0);
    assert.equal(limited.height % 2, 0);
    assert.ok(Math.abs((limited.width / limited.height) - (800 / 200)) < 0.3);
  });
});

test("renderText: 最小サイズ / 空文字列 / clearRect / trim", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    env.clearLogs();
    const tiny = renderer.renderText("", makeStyle({ offsetYRatio: 0 }), { fontResolution: 2, sizeLimit: 2 });
    assert.equal(tiny.width, 2);
    assert.equal(tiny.height, 2);

    env.clearLogs();
    const normal = renderer.renderText("abc", makeStyle({ offsetYRatio: 0 }), { fontResolution: 100 });
    const calls = normal.__calls;
    const clearIndex = calls.findIndex((call) => call.op === "clearRect");
    const drawIndex = calls.findIndex((call) => call.op === "fill" || call.op === "stroke");
    assert.ok(clearIndex >= 0 && drawIndex >= 0 && clearIndex < drawIndex);
    assert.equal(calls.filter((call) => call.op === "clearRect").length, 1);

    env.clearLogs();
    const trimmed = renderer.renderText("abc", makeStyle({ offsetYRatio: 0, trimOutermostPixels: true }), { fontResolution: 100 });
    assert.equal(trimmed, normal, "既定 canvas は使い回される");
    assert.equal(trimmed.__calls.filter((call) => call.op === "clearRect").length, 5);
  });
});

test("renderText: valign / metrics cache / getImageData 失敗", async () => {
  await withFakeCanvas({ inkTop: 10, inkBottom: 20 }, (env) => {
    const renderer = createRenderer();
    const make = (valign) => makeStyle({ valign, offsetYRatio: 0, offsetXRatio: 0, drawMode: "fill" });
    const top = env.create(2, 2);
    env.clearLogs();
    assert.equal(drawCalls(renderer.renderText("abc", make("top"), { canvas: top, fontResolution: 100 }))[0].y, 38);
    const middle = env.create(2, 2);
    env.clearLogs();
    assert.equal(drawCalls(renderer.renderText("abc", make("middle"), { canvas: middle, fontResolution: 100 }))[0].y, 56);
    const bottom = env.create(2, 2);
    env.clearLogs();
    assert.equal(drawCalls(renderer.renderText("abc", make("bottom"), { canvas: bottom, fontResolution: 100 }))[0].y, 75);

    const style = makeStyle({ offsetYRatio: 0 });
    env.clearLogs();
    env.resetImageDataCalls();
    renderer.renderText("a", style);
    renderer.renderText("b", style);
    assert.equal(env.getImageDataCalls(), 1);
    renderer.clearMetricsCache();
    renderer.renderText("c", style);
    assert.equal(env.getImageDataCalls(), 2);
  });

  await withFakeCanvas({ failImageData: true }, (env) => {
    const renderer = createRenderer();
    const style = makeStyle({ offsetYRatio: 0 });
    env.clearLogs();
    renderer.renderText("a", style);
    renderer.renderText("b", style);
    assert.equal(env.getImageDataCalls(), 2);
  });
});

test("renderText: style を書き換えない / 入力検証", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const style = makeStyle({ properties: { fillStyle: "red" }, offsetYRatio: 0 });
    env.clearLogs();
    renderer.renderText("abc", style, { fontResolution: 100 });
    assert.equal(style.properties.font, undefined);
    assert.equal(style.properties.textBaseline, undefined);
    assert.equal(style.properties.fillStyle, "red");

    assert.throws(() => renderer.renderText("abc", {}), /dev: style/);
    assert.throws(() => renderer.renderText(123, style), /dev: text/);
    assert.throws(() => renderer.renderText("abc", style, { fontResolution: 0 }), /fontResolution/);
    assert.throws(() => renderer.renderText("abc", style, { sizeLimit: 1 }), /even integer >= 2/);
    assert.throws(() => renderer.renderText("abc", style, { unknown: 1 }), /found invalid parameters/);
  });
});

test("renderText: style 省略 / undefined は makeStyle() 既定値と等価", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    env.clearLogs();
    const omittedCanvas = renderer.renderText("abc");
    const omittedDraws = drawCalls(omittedCanvas).map((call) => ({ ...call }));
    const explicitCanvas = env.create(2, 2);
    renderer.renderText("abc", makeStyle(), { canvas: explicitCanvas });
    assert.deepEqual(omittedDraws, drawCalls(explicitCanvas));

    const undefinedCanvas = env.create(2, 2);
    renderer.renderText("abc", undefined, { canvas: undefinedCanvas, fontResolution: 100 });
    const optionsCanvas = env.create(2, 2);
    renderer.renderText("abc", makeStyle(), { canvas: optionsCanvas, fontResolution: 100 });
    assert.deepEqual(drawCalls(undefinedCanvas), drawCalls(optionsCanvas));

    assert.throws(() => renderer.renderText("abc", null), /dev: style/);
    assert.throws(() => renderer.renderText("abc", {}), /dev: style/);
  });
});

test("renderText: 省略 style は固定 fallbackStyle を metrics cache のキーにする", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    env.clearLogs();
    env.resetImageDataCalls();
    renderer.renderText("a");
    renderer.renderText("b", undefined, { fontResolution: 100 });
    assert.equal(env.getImageDataCalls(), 1, "省略 / undefined / 異なる解像度で cache を共有する");
    renderer.clearMetricsCache();
    renderer.renderText("c");
    assert.equal(env.getImageDataCalls(), 2, "clearMetricsCache() で fallback も再計測する");
    renderer.renderText("d", makeStyle());
    assert.equal(env.getImageDataCalls(), 3, "makeStyle() の明示 style は別キー");
  });

  await withFakeCanvas({}, (env) => {
    const first = createRenderer({ examCharacter: "鷹" });
    const second = createRenderer({ examCharacter: "H" });
    env.clearLogs();
    env.resetImageDataCalls();
    first.renderText("a");
    second.renderText("a");
    assert.equal(env.getImageDataCalls(), 2, "renderer 毎の WeakMap は共有されない");
  });
});

test("canvas 検出: OffscreenCanvas / HTMLCanvasElement / 実装なし", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    env.clearLogs();
    const canvas = renderer.renderText("x", makeStyle());
    assert.equal(canvas, env.canvases[1]);
    assert.notEqual(canvas, env.canvases[0]);
  });

  await withFakeCanvas({}, (env) => withGlobals(
    { OffscreenCanvas: undefined, document: env.FakeDocument },
    () => {
      const renderer = createRenderer();
      env.clearLogs();
      const canvas = renderer.renderText("x", makeStyle());
      assert.equal(canvas.getContext("2d") instanceof Object, true);
    },
  ));

  await withGlobals({ OffscreenCanvas: undefined, document: undefined }, () => {
    const renderer = createRenderer();
    assert.equal(typeof renderer.renderText, "function");
    assert.throws(() => renderer.renderText("x", makeStyle()), /no 2D canvas implementation/);
  });
});

test("waitForFonts: 3 分岐", async () => {
  await waitForFonts();
  await waitForFonts({});
  await waitForFonts({ ready: Promise.resolve() });
  const loaded = await Promise.race([
    waitForFonts({ status: "loaded", ready: new Promise(() => {}) }).then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);
  assert.equal(loaded, "resolved");
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve });
  const pending = waitForFonts({ status: "loading", ready }).then(() => "resolved");
  resolveReady();
  assert.equal(await pending, "resolved");
});

test("renderText: 奇数 fontResolution / fallbackCanvasHeight / sizeLimit", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const style = makeStyle({ offsetYRatio: 0 });
    env.clearLogs();
    const canvas = renderer.renderText("abc", style, { fontResolution: 101 });
    assert.equal(canvas.height, 102);
    const state = canvas.__state;
    const drawn = state.calls.find((call) => call.op === "fill");
    assert.equal(state.measureFonts.length, 1);
    assert.equal(state.measureFonts[0], drawn.font);
    assert.match(drawn.font, /77px/);
  });

  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer({ fallbackCanvasHeight: 101 });
    env.clearLogs();
    assert.equal(renderer.renderText("x", makeStyle({ offsetYRatio: 0 })).height, 102);
  });

  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    assert.throws(() => renderer.renderText("x", makeStyle(), { sizeLimit: 99 }), /even integer >= 2/);
    assert.throws(() => renderer.renderText("x", makeStyle(), { sizeLimit: 1.5 }), /even integer >= 2/);
    env.clearLogs();
    assert.doesNotThrow(() => renderer.renderText("x", makeStyle(), { sizeLimit: 100 }));
  });
});

test("renderText: 不正な CSS font は例外", async () => {
  await withFakeCanvas({ strictFont: true }, (env) => {
    const renderer = createRenderer();
    const style = makeStyle({ fontWithoutSize: "{size}px serif" });
    env.clearLogs();
    assert.throws(() => renderer.renderText("abc", style, { fontResolution: 100 }), /invalid CSS font/);
  });
});

test("createRenderer: examCharacter の既定と差し替え", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    env.clearLogs();
    renderer.renderText("x", makeStyle());
    const examTexts = env.canvases[0].__calls
      .filter((call) => call.op === "fill")
      .map((call) => call.text);
    assert.ok(examTexts.includes("鷹"));
  });

  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer({ examCharacter: "H" });
    env.clearLogs();
    renderer.renderText("x", makeStyle());
    const examTexts = env.canvases[0].__calls
      .filter((call) => call.op === "fill")
      .map((call) => call.text);
    assert.ok(examTexts.includes("H"));
    assert.ok(!examTexts.includes("鷹"));
  });

  await withFakeCanvas({}, () => {
    assert.throws(() => createRenderer({ examCharacter: " " }), /single non-whitespace character/);
    assert.throws(() => createRenderer({ examCharacter: "ab" }), /single non-whitespace character/);
    assert.doesNotThrow(() => createRenderer({ examCharacter: "H" }));
  });
});

test("canvas 使い回し: 省略時は同一 / 明示時は引数を返す / exam は別", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const style = makeStyle();
    env.clearLogs();
    const first = renderer.renderText("a", style);
    const second = renderer.renderText("b", style);
    assert.equal(first, second);
    assert.equal(env.getCreateCount(), 2);
    assert.notEqual(first, env.canvases[0]);

    const own = env.create(2, 2);
    const explicit = renderer.renderText("c", style, { canvas: own });
    assert.equal(explicit, own);
    assert.notEqual(explicit, first);
    assert.equal(env.getCreateCount(), 2, "明示 canvas では resultCanvas を増やさない");
  });

  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const own = env.create(2, 2);
    const result = renderer.renderText("x", makeStyle(), { canvas: own });
    assert.equal(result, own);
    assert.equal(env.getCreateCount(), 1, "examCanvas だけ生成する");
    assert.notEqual(result, env.canvases[1], "examCanvas は別に生成される");
  });
});

test("canvas 使い回し: 前回の pixels / context state が残らない", async () => {
  await withFakeCanvas({}, (env) => {
    const renderer = createRenderer();
    const firstStyle = makeStyle({
      drawMode: "fill",
      properties: { fillStyle: "red", globalAlpha: 0.5, shadowBlur: 9 },
    });
    const secondStyle = makeStyle({
      drawMode: "fill",
      properties: { fillStyle: "blue" },
    });
    env.clearLogs();
    const first = renderer.renderText("x", firstStyle);
    const firstCall = drawCalls(first)[0];
    assert.equal(firstCall.fillStyle, "red");
    assert.equal(firstCall.globalAlpha, 0.5);
    assert.equal(firstCall.shadowBlur, 9);

    env.clearLogs();
    const second = renderer.renderText("x", secondStyle);
    assert.equal(second, first);
    const secondCall = drawCalls(second)[0];
    assert.equal(secondCall.fillStyle, "blue");
    assert.equal(secondCall.globalAlpha, 1);
    assert.notEqual(secondCall.shadowBlur, 9);
  });
});

test("canvas 使い回し: シングルトン生成は例外", async () => {
  await withFakeCanvas({ singleton: true }, (env) => {
    const renderer = createRenderer();
    env.clearLogs();
    assert.throws(() => renderer.renderText("x", makeStyle()), /shared canvas|exam canvas/);
  });
});
