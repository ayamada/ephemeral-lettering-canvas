# CHANGELOG

## 1.0.0 (2026-11-26)

- 初回リリース。version を `1.0.0` へ確定し、`package.json` へ公開リポジトリ / homepage / Issues のメタデータを追加。README のステータスをリリース済みへ更新。
- `@tir.jp/lettering-texture` パッケージの `Lettering` 相当を最小 API で移植。
    - `TextTexture` / 参照カウント / `waitUntilReady` / host 契約は非移植。
    - 公開面を `createRenderer()` / `makeStyle()` / `waitForFonts()` の名前付き export へ整理。
    - `renderText()` は結果オブジェクトではなく canvas を直接返すよう変更。
    - `renderText(text, style, { canvas?, fontResolution?, sizeLimit? })` に明示 canvas を追加。省略時は renderer 単位の出力 canvas を 1 個使い回し、計測用 `examCanvas` は常に別に 1 個保持。
    - 既定 `examCharacter` は CJK 向けの `"鷹"` を維持。実機テストでは `"H"` を明示して差し替え。
    - 独自 `src/assert.mjs` を廃し、`@tir.jp/is-dev` の dev 専用検証と prod 必須ガードへ分離。
    - `esbuild@0.28.2` を devDependency に追加。実機テストの bundle と prod DCE 確認に利用。
    - `tests/package.test.mjs` / `tests/docs.test.mjs` は過剰な為移植しない。
    - unit / playwright 実機テストを新 API と canvas 使い回し契約へ合わせて移植。
- `renderText()` の第 2 引数 `style` を省略可能にした。省略 / `undefined` 時は `src/lettering-style.mjs` の固定 `fallbackStyle`(`makeStyle()` 由来)を適用し、metrics cache のキーを安定化。
- unit / browser / prod DCE に style 省略のテストを追加し、README / FOR_AGENTS を更新。
