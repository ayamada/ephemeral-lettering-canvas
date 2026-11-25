// 文字列を canvas へ描画するレンダラ。
//
// - 公開 API は `createRenderer()` / `waitForFonts()` / `renderText()`
// - `renderText()` は canvas を直接返す。出力 canvas 省略時は renderer 毎に 1 個を使い回す
// - `style` 省略時は `Style.fallbackStyle`(`makeStyle()` 既定値)を適用する
// - 出力 canvas とは別に、renderer 毎に 1 個の examCanvas を `measureMetrics()` で使い回す
// - モジュール読み込み時には DOM / OffscreenCanvas へ触らない

import * as IsDev from "@tir.jp/is-dev";
import * as Style from "./lettering-style.mjs";

const defaultFontResolution = 62;
const defaultSizeLimit = 2046;
// 既定描画高さとは無関係な、メトリクス計測専用のサイズ
const metricsCanvasSize = 62;
const metricsFontSize = metricsCanvasSize - 2;

const renderOptionKeys = new Set(["canvas", "fontResolution", "sizeLimit"]);
const rendererOptionKeys = new Set(["examCharacter", "fallbackCanvasHeight"]);

const isPlainObject = (value) => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);

export const roundEven = (value) => Math.round(value / 2) * 2;

export const normalizeRenderOptions = (options, defaults) => {
  const height = options.fontResolution ?? defaults.fontResolution;
  const limit = options.sizeLimit ?? defaults.sizeLimit;
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`${Style.errorPrefix} fontResolution must be a finite number > 0`);
  }
  if (!Number.isInteger(limit) || limit < 2 || limit % 2 !== 0) {
    throw new Error(`${Style.errorPrefix} sizeLimit must be an even integer >= 2`);
  }
  return {
    fontResolution: Math.max(2, roundEven(height)),
    sizeLimit: limit,
  };
};

const devCheckParams = (params, knownKeys) => {
  if (!IsDev.isDev) { return }
  const invalids = Object.fromEntries(
    Object.entries(params).filter(([key]) => !knownKeys.has(key)),
  );
  IsDev.assertOnlyValidParams(invalids);
};

// {size} は makeStyle() で高々 1 個に制限済み。無い場合は先頭へサイズを付与する
const buildCssFont = (fontWithoutSize, fontSizePx) => {
  const size = `${fontSizePx}px`;
  return fontWithoutSize.includes("{size}")
    ? fontWithoutSize.split("{size}").join(size)
    : `${size} ${fontWithoutSize}`;
};

// Canvas 2D は不正な CSS font の代入を黙って無視する為、prod でも読み戻して確認する
const setFont = (ctx, style, fontSize) => {
  const font = buildCssFont(style.fontWithoutSize, fontSize);
  ctx.font = font;
  if (!String(ctx.font).includes(`${fontSize}px`)) {
    throw new Error(`${Style.errorPrefix} fontWithoutSize produced an invalid CSS font (${font})`);
  }
};

const applyPropertiesToCtx = (ctx, properties) => {
  for (const [key, value] of Style.safeEntries(properties, "properties")) {
    if (value !== undefined) { ctx[key] = value }
  }
};

const resetContext = (ctx) => {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.imageSmoothingEnabled = true;
  ctx.lineWidth = 1;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.miterLimit = 10;
  ctx.lineDashOffset = 0;
  ctx.shadowColor = "rgba(0, 0, 0, 0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
  ctx.direction = "inherit";
  ctx.fontKerning = "auto";
  ctx.fontStretch = "normal";
  ctx.fontVariantCaps = "normal";
  ctx.textRendering = "auto";
  ctx.letterSpacing = "0px";
  ctx.wordSpacing = "0px";
  if (typeof ctx.setLineDash === "function") { ctx.setLineDash([]) }
};

const get2dContext = (canvas) => {
  if (typeof canvas?.getContext !== "function") {
    throw new Error(`${Style.errorPrefix} canvas.getContext must be a function`);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) { throw new Error(`${Style.errorPrefix} failed to get a 2D canvas context`) }
  return ctx;
};

// DOM へ触るのは実際に canvas が必要になった時だけ
const createCanvas = (width, height) => {
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error(`${Style.errorPrefix} no 2D canvas implementation available`);
};

const determineX = {
  left: (left) => left,
  center: (left, right) => (left + right) / 2,
  right: (left, right) => right,
};

// 指定高さでのレイアウト。測定と描画を必ず同じ fontSize で行う
const computeLayout = (ctx, text, style, height) => {
  const padding = Style.paddingPxAt(style.padding, height);
  const fontSize = Math.max(1, Math.round(height - padding.top - padding.bottom));
  setFont(ctx, style, fontSize);
  const measuredWidth = ctx.measureText(text).width;
  if (!Number.isFinite(measuredWidth) || measuredWidth < 0) {
    throw new Error(`${Style.errorPrefix} measureText returned an invalid width`);
  }
  return {
    height,
    width: padding.left + measuredWidth + padding.right,
    fontSize,
    padding,
  };
};

const resolveY = (style, metrics, fontSize, padding, height) => {
  const top = padding.top;
  const bottom = height - padding.bottom;
  if (style.valign === "top") {
    return Math.round(style.offsetYRatio * fontSize + top + (0.5 + metrics.topRatio) * fontSize);
  }
  if (style.valign === "bottom") {
    return Math.round(style.offsetYRatio * fontSize + bottom + (metrics.bottomRatio - 0.5) * fontSize);
  }
  return Math.round(style.offsetYRatio * fontSize + (top + bottom) / 2 + metrics.middleRatio * fontSize);
};

const shadowKeys = [
  { key: "shadowOffsetX", ratio: (style) => style.shadowOffsetXRatio },
  { key: "shadowOffsetY", ratio: (style) => style.shadowOffsetYRatio },
  { key: "shadowBlur", ratio: (style) => style.shadowBlurRatio },
];

const applyModeShadow = (ctx, modeProperties, style, fontSize) => {
  for (const entry of shadowKeys) {
    ctx[entry.key] = modeProperties[entry.key]
      ?? style.properties[entry.key]
      ?? entry.ratio(style) * fontSize;
  }
};

const drawTextMode = (ctx, { op, text, x, y, maxWidth, style, props, align, fontSize }) => {
  ctx.save();
  try {
    applyPropertiesToCtx(ctx, props);
    if (op === "stroke") {
      ctx.lineWidth = style.strokeProperties.lineWidth ?? style.properties.lineWidth ?? style.lineWidthRatio * fontSize;
    }
    ctx.textAlign = align;
    applyModeShadow(ctx, props, style, fontSize);
    const method = op === "stroke" ? "strokeText" : "fillText";
    if (style.useMaxWidth) { ctx[method](text, x, y, maxWidth) }
    else { ctx[method](text, x, y) }
  } finally {
    ctx.restore();
  }
};

export const waitForFonts = async (fonts = globalThis.document?.fonts ?? globalThis.self?.fonts) => {
  // Chromium の worker では status が "loaded" でも ready が解決しない(実測)
  if (!fonts) { return }
  if (fonts.status === "loaded") { return }
  if (typeof fonts.ready?.then === "function") { await fonts.ready }
};

export const createRenderer = (params = {}) => {
  if (!isPlainObject(params)) {
    throw new Error(`${Style.errorPrefix} renderer params must be a plain object`);
  }
  if (IsDev.isDev) {
    devCheckParams(params, rendererOptionKeys);
    IsDev.assert(params.examCharacter === undefined || typeof params.examCharacter === "string", "dev: examCharacter must be a string");
    IsDev.assert(params.fallbackCanvasHeight === undefined || Number.isFinite(params.fallbackCanvasHeight), "dev: fallbackCanvasHeight must be finite");
  }

  const examCharacter = params.examCharacter ?? "鷹";
  const fallbackCanvasHeight = params.fallbackCanvasHeight ?? defaultFontResolution;
  if (typeof examCharacter !== "string" || [...examCharacter].length !== 1 || !examCharacter.trim()) {
    throw new Error(`${Style.errorPrefix} examCharacter must be a single non-whitespace character`);
  }
  if (!Number.isFinite(fallbackCanvasHeight) || fallbackCanvasHeight <= 0) {
    throw new Error(`${Style.errorPrefix} fallbackCanvasHeight must be a finite number > 0`);
  }

  const rendererDefaults = Object.freeze({
    fontResolution: Math.max(2, roundEven(fallbackCanvasHeight)),
    sizeLimit: defaultSizeLimit,
  });

  let metricsCache = new WeakMap();
  let examCanvas = null;
  let resultCanvas = null;

  const getExamCanvas = () => {
    if (examCanvas === null) {
      examCanvas = createCanvas(metricsCanvasSize, metricsCanvasSize);
    }
    return examCanvas;
  };

  const getRenderCanvas = (provided) => {
    const exam = getExamCanvas();
    if (provided !== undefined) {
      if (provided === exam) {
        throw new Error(`${Style.errorPrefix} render canvas must not be the exam canvas`);
      }
      return provided;
    }
    if (resultCanvas === null) {
      resultCanvas = createCanvas(2, 2);
    }
    if (resultCanvas === exam) {
      throw new Error(`${Style.errorPrefix} canvas factory returned a shared canvas`);
    }
    return resultCanvas;
  };

  // 縦位置補正用のメトリクス。examCharacter のインクの上下余白を測る
  const measureMetrics = (style) => {
    const canvas = getExamCanvas();
    canvas.width = metricsCanvasSize;
    canvas.height = metricsCanvasSize;
    const ctx = get2dContext(canvas);
    resetContext(ctx);
    ctx.save();
    let measurementFailed = false;
    let firstRow = -1;
    let lastRow = -1;
    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      applyPropertiesToCtx(ctx, style.properties);
      applyPropertiesToCtx(ctx, style.fillProperties);
      setFont(ctx, style, metricsFontSize);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "white";
      ctx.strokeStyle = "transparent";
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.fillText(examCharacter, metricsCanvasSize / 2, metricsCanvasSize / 2);

      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        for (let y = 0; y < imageData.height; y += 1) {
          let hasInk = false;
          for (let x = 0; x < imageData.width; x += 1) {
            if (imageData.data[(y * imageData.width + x) * 4 + 3] !== 0) {
              hasInk = true;
              break;
            }
          }
          if (hasInk) {
            if (firstRow < 0) { firstRow = y }
            lastRow = y;
          }
        }
      } catch {
        // getImageData が使えない環境では中央揃えへ戻す。失敗を正常値として cache しない
        measurementFailed = true;
      }
    } finally {
      ctx.restore();
    }

    const offset = (metricsCanvasSize - metricsFontSize) / 2;
    let upperMarginPx = 0;
    let lowerMarginPx = 0;
    if (firstRow >= 0) {
      upperMarginPx = firstRow - offset;
      lowerMarginPx = (metricsCanvasSize - 1 - lastRow) - offset;
    }
    const metrics = {
      topRatio: -upperMarginPx / metricsFontSize,
      middleRatio: (lowerMarginPx - upperMarginPx) / (2 * metricsFontSize),
      bottomRatio: lowerMarginPx / metricsFontSize,
    };
    if (!measurementFailed) { metricsCache.set(style, metrics) }
    return metrics;
  };

  const getMetrics = (style) => metricsCache.get(style) ?? measureMetrics(style);

  const renderText = (text, styleArg, options = {}) => {
    // metricsCache のキーを安定させる為、undefined は検証より先に固定 style へ解決する
    const style = styleArg === undefined ? Style.fallbackStyle : styleArg;
    if (IsDev.isDev) {
      IsDev.assert(typeof text === "string", "dev: text must be a string");
      IsDev.assert(Style.isStyle(style), "dev: style must be created by makeStyle()");
      IsDev.assert(isPlainObject(options), "dev: render options must be a plain object");
      devCheckParams(options, renderOptionKeys);
    }
    if (typeof text !== "string") {
      throw new Error(`${Style.errorPrefix} text must be a string`);
    }
    if (!style || typeof style !== "object") {
      throw new Error(`${Style.errorPrefix} style must be an object created by makeStyle()`);
    }
    if (!isPlainObject(options)) {
      throw new Error(`${Style.errorPrefix} render options must be a plain object`);
    }

    const { fontResolution, sizeLimit } = normalizeRenderOptions(options, rendererDefaults);
    const canvas = getRenderCanvas(options.canvas);
    const ctx = get2dContext(canvas);

    // 1) 指定解像度で一度だけ測り、縮小率を 1 つだけ求める
    resetContext(ctx);
    applyPropertiesToCtx(ctx, style.properties);
    ctx.textBaseline = "middle";
    const design = computeLayout(ctx, text, style, fontResolution);
    const scale = Math.min(1, sizeLimit / design.width, sizeLimit / design.height);
    const finalHeight = Math.max(2, roundEven(design.height * scale));
    const finalWidth = Math.max(2, Math.min(sizeLimit, roundEven(design.width * scale)));

    // 2) 毎回 resize して bitmap / context state をリセットし、全プロパティを再適用する
    canvas.width = finalWidth;
    canvas.height = finalHeight;
    resetContext(ctx);
    ctx.clearRect(0, 0, finalWidth, finalHeight);
    applyPropertiesToCtx(ctx, style.properties);

    const padding = Style.paddingPxAt(style.padding, finalHeight);
    const fontSize = Math.max(1, Math.round(finalHeight - padding.top - padding.bottom));
    const innerWidth = finalWidth - padding.left - padding.right;
    const maxWidth = Math.max(1, Math.ceil(innerWidth));
    setFont(ctx, style, fontSize);
    ctx.textBaseline = "middle";
    const align = style.properties.textAlign ?? "center";
    ctx.textAlign = align;

    const metrics = getMetrics(style);
    const x = Math.round(
      style.offsetXRatio * fontSize + determineX[align](padding.left, finalWidth - padding.right),
    );
    const y = resolveY(style, metrics, fontSize, padding, finalHeight);

    if (style.drawMode !== "fill") {
      drawTextMode(ctx, { op: "stroke", text, x, y, maxWidth, style, props: style.strokeProperties, align, fontSize });
    }
    if (style.drawMode !== "stroke") {
      drawTextMode(ctx, { op: "fill", text, x, y, maxWidth, style, props: style.fillProperties, align, fontSize });
    }

    if (style.trimOutermostPixels) {
      ctx.clearRect(0, 0, finalWidth, 1);
      ctx.clearRect(0, finalHeight - 1, finalWidth, 1);
      ctx.clearRect(0, 0, 1, finalHeight);
      ctx.clearRect(finalWidth - 1, 0, 1, finalHeight);
    }

    return canvas;
  };

  return {
    renderText,
    clearMetricsCache: () => { metricsCache = new WeakMap() },
  };
};
