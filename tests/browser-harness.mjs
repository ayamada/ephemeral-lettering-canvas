// playwright 実機テストの共通ハーネス。
//
// - esbuild で page / worker entry をメモリ上へ bundle し、bare specifier を解決する
// - import map は worker に適用されない為使わない
// - `node:http` で page.html と生成済み bundle だけを 127.0.0.1 の一時ポートへ配信する
// - chromium は playwright 同梱のものだけを使う

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const pageHtmlUrl = new URL("./fixtures/page.html", import.meta.url);
const pageEntryPath = fileURLToPath(new URL("./fixtures/page-entry.mjs", import.meta.url));
const workerEntryPath = fileURLToPath(new URL("./fixtures/worker-entry.mjs", import.meta.url));

const assertBrowsersPath = () => {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    throw new Error("PLAYWRIGHT_BROWSERS_PATH is required (run via npm run test:browser)");
  }
};

let bundlesPromise = null;
const getBundles = () => {
  if (bundlesPromise === null) {
    bundlesPromise = build({
      absWorkingDir: rootPath,
      entryPoints: {
        "page-entry": pageEntryPath,
        "worker-entry": workerEntryPath,
      },
      outdir: "/e2e",
      entryNames: "[name]",
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      define: { IS_DEV: "true", IS_PROD: "false" },
      logLevel: "silent",
      legalComments: "none",
    }).then((result) => {
      const files = new Map();
      for (const file of result.outputFiles) {
        const name = file.path.split("/").pop();
        files.set(`/e2e/${name}`, file.contents);
      }
      return files;
    });
  }
  return bundlesPromise;
};

const startStaticServer = async (bundles, pageHtml) => {
  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      response.writeHead(400).end("bad request");
      return;
    }
    if (pathname === "/tests/fixtures/page.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pageHtml);
      return;
    }
    if (bundles.has(pathname)) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(bundles.get(pathname));
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => {
      server.close(resolveClose);
      server.closeAllConnections();
    }),
  };
};

export const openTestPage = async ({
  path = "/tests/fixtures/page.html",
  viewport = { width: 800, height: 600 },
} = {}) => {
  assertBrowsersPath();
  const [bundles, pageHtml] = await Promise.all([getBundles(), readFile(pageHtmlUrl)]);
  const server = await startStaticServer(bundles, pageHtml);
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`pageerror: ${error}`));
    page.on("console", (message) => {
      if (message.type() === "error") { errors.push(`console.error: ${message.text()}`) }
    });
    await page.goto(`${server.origin}${path}`);
    await page.waitForFunction(() => globalThis.e2e !== undefined, null, { timeout: 5000 });
    return {
      page,
      context,
      errors,
      origin: server.origin,
      close: async () => {
        await browser.close();
        await server.close();
      },
    };
  } catch (error) {
    await browser?.close();
    await server.close();
    const detail = errors.length > 0 ? `\n${errors.join("\n")}` : "";
    throw new Error(`${error.message}${detail}`);
  }
};
