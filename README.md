# @tir.jp/ephemeral-lettering-canvas

文字列を Canvas 2D で描画し、**canvas そのもの**を返す小さなライブラリです。WebGL / WebGPU には依存しません。

- 公開 API は `createRenderer()` / `makeStyle()` / `waitForFonts()` の 3 関数だけ
- 描画先は `OffscreenCanvas` を優先し、無ければ `HTMLCanvasElement`
- モジュール読み込み時に DOM へ触らない(worker / Node.js から import できる)
- 出力 canvas は省略時 renderer 単位で 1 個を使い回す。保持したい時は明示 canvas を渡す
- 縦位置補正用の `examCanvas` は出力 canvas とは別に 1 個だけ保持する
- 暗黙の利用前提は **CJK 向け**

> **ステータス**: リリース済み (`1.0.0`)。現在のところ型定義 (`.d.ts`) は提供していません。

## インストール

```bash
npm install @tir.jp/ephemeral-lettering-canvas
```

## 使い方

```js
import {
    createRenderer,
    makeStyle,
    waitForFonts,
} from "@tir.jp/ephemeral-lettering-canvas";

await waitForFonts();

const renderer = createRenderer();
const style = makeStyle({ fontWithoutSize: "bold {size} sans-serif" });

// 省略時: renderer 内で 1 個だけ作った canvas を使い回し、それを返す
const ephemeralCanvas = renderer.renderText("こんにちは", style, { fontResolution: 64 });

// 明示時: 渡した canvas を偶数寸法へリサイズして描画し、同じオブジェクトを返す
const ownCanvas = renderer.renderText("こんにちは", style, {
    canvas: new OffscreenCanvas(2, 2),
    fontResolution: 64,
});
```

`ephemeralCanvas` は **同じ renderer の次の `renderText()` まで**有効です。内容を保持したい場合は `options.canvas` に自分の canvas を渡すか、ピクセルをコピーしてください。明示 canvas も呼び出し毎に寸法と内容が上書きされます。

## 公開 API

### `createRenderer(options?)`

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `examCharacter` | `"鷹"` | 縦位置補正に使う単一の非空白グリフ。CJK 向けの既定 |
| `fallbackCanvasHeight` | `62` | `fontResolution` 省略時の設計高さ px(偶数へ正規化) |

戻り値は `{ renderText, clearMetricsCache }` です。`clearMetricsCache()` は style 単位のメトリクス cache を捨てます。フォントは最初の `renderText()` 前に読み込ませ、後からフォントが変わった場合はこのメソッドを呼んでください。

### `renderer.renderText(text, style?, options?) -> canvas`

**結果オブジェクトではなく canvas を直接返します。** `options` の許可キーは次の 3 個だけです。

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `canvas` | 省略時は renderer 内部の 1 個 | 描画対象。渡すとその canvas をリサイズ・クリアして返す |
| `fontResolution` | `fallbackCanvasHeight` | 設計時のキャンバス高さ px(偶数へ正規化)。`sizeLimit` 縮小が無ければ最終高さと一致 |
| `sizeLimit` | `2046` | 1 辺の上限 px(**偶数かつ 2 以上の整数**)。超える場合は幅・高さに同じ縮小率を掛ける |

幅・高さは常に偶数です。`canvas` を省略した場合、renderer は出力用 canvas を 1 個だけ遅延生成して使い回します。どちらの場合も計測用 `examCanvas` は別に 1 個だけ生成され、`measureMetrics()` で使い回されます。

`style` を省略、または `undefined` を渡すと、`makeStyle()` と同じ既定値を持つ固定 `fallbackStyle` を適用します。`options` は第三引数のままなので、`renderText(text, undefined, { fontResolution: 64 })` のように渡してください。`null` は常に例外です。`makeStyle()` 由来でないオブジェクトは dev で拒否され、prod では呼び出し側が正常な引数を保証してください。

省略時も metrics は `fallbackStyle` をキーに renderer 毎の `WeakMap` へ cache され、`clearMetricsCache()` で無効化できます。

### `makeStyle(params?)`

`params` は既定値へ merge され、freeze 済みの style を返します。描画側が管理する予約キー、未知キー、`__proto__` / `constructor` / `prototype` は拒否されます。`CanvasGradient` 等非 plain オブジェクトは参照のまま保持します。

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `fontWithoutSize` | `"serif"` | CSS font のサイズ以外。`{size}` で `NNpx` を埋める。サイズトークンは禁止 |
| `properties` | 下記 | 2D context へ代入する共通プロパティ |
| `fillProperties` | `{}` | fill の時だけ上書き |
| `strokeProperties` | `{}` | stroke の時だけ上書き |
| `padding` | `2 / 16` | 最終高さに対する割合。数値か `{ left, top, right, bottom }` |
| `useMaxWidth` | `true` | 内側幅を `fillText` / `strokeText` の maxWidth に渡す |
| `trimOutermostPixels` | `false` | 外周 1px をクリアする |
| `valign` | `"middle"` | `"top"` / `"middle"` / `"bottom"` |
| `drawMode` | `"both"` | `"both"` / `"fill"` / `"stroke"` |
| `lineWidthRatio` | `2 / 16` | `lineWidth = ratio * fontSize` |
| `shadowOffsetXRatio` | `3 / 32` | `shadowOffsetX = ratio * fontSize` |
| `shadowOffsetYRatio` | `3 / 32` | `shadowOffsetY = ratio * fontSize` |
| `shadowBlurRatio` | `1 / 32` | `shadowBlur = ratio * fontSize` |
| `offsetXRatio` | `0` | 横方向の微調整(× `fontSize`) |
| `offsetYRatio` | `-1 / 32` | 縦方向の微調整(× `fontSize`) |

`properties` の既定値は `textAlign: "center"` / `fillStyle: "rgb(255 255 255 / 1)"` / `strokeStyle: "rgb(0 0 0 / 0.2)"` / `miterLimit: 2` / `shadowColor: "rgb(0 0 0 / 0.8)"` です。`font` / `textBaseline` / `valign`、および mode 側の `textAlign` は予約です。

不正な CSS font は Canvas 2D が代入を黙って無視する為、`ctx.font` を読み戻して例外にします。

### `waitForFonts(fonts?)`

`document.fonts` / worker の `self.fonts` の `ready` を待ちます。`fonts.status === "loaded"` の場合は待たずに返ります(Chromium worker で `ready` が解決しない事への回避策)。フォントが無い環境では何もしません。

## prod ビルドと `@tir.jp/is-dev`

開発時の入力検証には `@tir.jp/is-dev` を使い、`if (IsDev.isDev) { ... }` ブロックへ閉じ込めています。prod では詳細な型・キー検証が除去される前提の為、**呼び出し側は正常な引数を保証してください**。以下は prod にも残る必須ガードです。

- `getContext("2d")` / `ctx.font` 読み戻し / `measureText()` の有限性
- `examCanvas` と出力 canvas の同一化防止
- 危険キーの拒否、偶数寸法、`sizeLimit` の偶数整数制約
- 再利用時の resize / `clearRect` / context state 再適用

DCE は利用側 bundler が `IS_DEV` / `IS_PROD` を define した時にのみ成立します。`NODE_ENV` だけでは効きません。esbuild では **両方**を定義して下さい。

```bash
esbuild app.mjs --bundle --minify \
    --define:IS_DEV=false --define:IS_PROD=true
```

`@tir.jp/is-dev` は `typeof IS_DEV` / `typeof IS_PROD` を経由する為、esbuild 1 パス目の minify で `if (!1) { ... }` が残る事があります。本パッケージの `tests/is-dev.test.mjs` は必要に応じて 2 パス目の `transform()` で除去を確認し、文字列が残る場合でも runtime no-op だけを検証します。

## 制約

- 複数行は非対応です。改行は空白として扱われます。
- `renderText()` は呼び出したスレッドで同期的に Canvas 2D へ描画します。
- `sizeLimit` は偶数整数のみです。奇数を渡すと例外になります。
- 既定の `examCharacter` は `"鷹"` 、 CJK 向けです。実機テストでは `createRenderer({ examCharacter: "H" })` で差し替えてフォント依存を避けています。
- `style` を省略して `options` を渡す場合は第 2 引数に `undefined` を置いてください。`renderText(text, options)` 形式はサポートしません。
- ビルド無し。`src/` をそのまま配布し、`dist/` は作りません。

## リポジトリ / バグ報告

- 公開リポジトリ: <https://github.com/ayamada/ephemeral-lettering-canvas>
- Issues: <https://github.com/ayamada/ephemeral-lettering-canvas/issues>

## テスト

```bash
npm test
npm run lint
npm run install:browsers # 初回のみ
npm run test:browser
npm pack --dry-run
```

## ライセンス

Zlib
