/**
 * Regression for Vite dev's HTML-at-the-WASM-path failure.
 * Run npm run build, then this script while the user's dev server is already
 * running. FRAME_DEV_URL may override http://localhost:5173. This script never
 * starts a server. Production files are served only through Playwright routing.
 * Uses the real timestamped Whisper model and public HF JFK speech sample.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const origin = new URL(process.env.FRAME_DEV_URL || "http://localhost:5173")
  .origin;
try {
  const response = await fetch(
    `${origin}/src/lib/transcription.worker.ts?worker_file&type=module`,
  );
  assert(
    response.ok &&
      (await response.text()).includes("whisper-tiny.en_timestamped"),
  );
} catch {
  throw new Error(
    `An existing Frame dev server is required at ${origin}. Start it manually, or set FRAME_DEV_URL. This check does not start servers.`,
  );
}
const workerName = (await readdir(path.join(dist, "assets"))).find((name) =>
  /^transcription\.worker-.*\.js$/.test(name),
);
assert(workerName, "Run npm run build first");
const engine = await build({
  entryPoints: [path.join(root, "src/lib/transcription.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const sampleResponse = await fetch(
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
);
assert(sampleResponse.ok, "Public speech sample must be available");
const speech = Buffer.from(await sampleResponse.arrayBuffer());
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext();
const page = await context.newPage();
const html =
  "<!doctype html><html><head><title>Frame runtime regression</title></head><body>Local transcription runtime check</body></html>";
const errors = [];
const runtimeResponses = [];
const remoteRequests = [];
let mode = "development";
let returnHtmlForRuntime = false;
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (event) => {
  if (event.type() === "error") errors.push(event.text());
});
context.on("response", (response) => {
  if (!/\.wasm(?:\?|$)/.test(response.url())) return;
  if (response.request().headers()["x-frame-runtime-check"]) return;
  runtimeResponses.push({
    mode,
    url: response.url(),
    status: response.status(),
    mime: response.headers()["content-type"],
    bytes: Number(response.headers()["content-length"]) || null,
  });
});
context.on("request", (request) => {
  if (new URL(request.url()).origin !== origin)
    remoteRequests.push({ mode, url: request.url(), method: request.method() });
});
await context.route(`${origin}/__runtime-check.html*`, (route) =>
  route.fulfill({ contentType: "text/html", body: html }),
);
await context.route(`${origin}/__speech.wav`, (route) =>
  route.fulfill({ contentType: "audio/wav", body: speech }),
);
await page.exposeFunction("reportRuntimeProgress", ({ stage }) =>
  console.log(`${mode}: ${stage}`),
);

async function infer(modulePath) {
  await page.goto(`${origin}/__runtime-check.html?mode=${mode}`);
  return page.evaluate(
    async ({ modulePath }) => {
      const { transcribeVideo } = await import(modulePath);
      const blob = await (await fetch("/__speech.wav")).blob();
      const stages = [];
      const began = performance.now();
      const transcript = await transcribeVideo(blob, {
        signal: new AbortController().signal,
        onProgress: (progress) => {
          if (stages.at(-1) !== progress.stage) {
            stages.push(progress.stage);
            void window.reportRuntimeProgress(progress);
          }
        },
      });
      return {
        words: transcript.words.length,
        text: transcript.words.map((word) => word.text).join(" "),
        elapsed: (performance.now() - began) / 1000,
        stages,
      };
    },
    { modulePath },
  );
}

async function checkAsset(asset) {
  // Chrome's inspector can evict the 21 MB worker response before response.body()
  // reads it. Probe the exact asset in the browser and return only its header.
  const header = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: { "X-Frame-Runtime-Check": "1", Range: "bytes=0-7" },
    });
    const reader = response.body.getReader();
    const bytes = [];
    while (bytes.length < 8) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes.push(...value.subarray(0, 8 - bytes.length));
    }
    await reader.cancel();
    return {
      ok: response.ok,
      mime: response.headers.get("content-type"),
      magic: bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  }, asset.url);
  assert(header.ok);
  assert.match(header.mime, /^application\/wasm/);
  assert.equal(header.magic, "0061736d01000000");
  asset.magic = header.magic;
}

try {
  const dev = await infer("/src/lib/transcription.ts");
  assert.match(dev.text, /fellow Americans/i);
  assert(dev.words >= 18);
  const devAssets = runtimeResponses.filter(
    (item) => item.mode === "development",
  );
  assert.equal(
    devAssets.length,
    1,
    "Dev must fetch exactly one explicitly located WASM binary",
  );
  assert(
    devAssets[0].url.includes("/node_modules/@huggingface/transformers/dist/"),
  );
  assert.equal(devAssets[0].status, 200);
  assert.match(devAssets[0].mime, /^application\/wasm/);
  await checkAsset(devAssets[0]);
  console.log(
    `PASS actual running Vite development worker: ${dev.words} words, ${dev.elapsed.toFixed(1)}s; correct WASM MIME and magic`,
  );

  // Reuse this isolated test context's model cache while substituting only the
  // current production build for same-origin app requests. Never touch the user
  // server's files or browser data. All external requests are blocked now.
  mode = "production";
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      await route.abort("internetdisconnected");
      return;
    }
    if (url.pathname === "/__runtime-check.html") {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    if (url.pathname === "/__speech.wav") {
      await route.fulfill({ contentType: "audio/wav", body: speech });
      return;
    }
    if (url.pathname === "/__runtime-engine.js") {
      await route.fulfill({
        contentType: "text/javascript",
        body: engine.outputFiles[0].text,
      });
      return;
    }
    if (returnHtmlForRuntime && url.pathname.endsWith(".wasm")) {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    const target =
      url.pathname === "/transcription.worker.ts"
        ? path.join(dist, "assets", workerName)
        : path.resolve(dist, `.${url.pathname}`);
    assert(target.startsWith(`${dist}${path.sep}`));
    try {
      const mime = target.endsWith(".wasm")
        ? "application/wasm"
        : "text/javascript";
      await route.fulfill({ contentType: mime, body: await readFile(target) });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  const production = await infer("/__runtime-engine.js");
  assert.match(production.text, /fellow Americans/i);
  const productionAssets = runtimeResponses.filter(
    (item) => item.mode === "production",
  );
  assert.equal(productionAssets.length, 1);
  assert(
    productionAssets[0].url.includes("/assets/ort-wasm-simd-threaded.jsep-"),
  );
  assert.equal(productionAssets[0].status, 200);
  assert.match(productionAssets[0].mime, /^application\/wasm/);
  await checkAsset(productionAssets[0]);
  assert.equal(
    remoteRequests.filter((item) => item.mode === "production").length,
    0,
    "Production inference should use the cached model without CDN requests",
  );
  console.log(
    `PASS production worker: ${production.words} words, ${production.elapsed.toFixed(1)}s; hashed WASM URL, correct MIME/magic, cached model`,
  );

  mode = "invalid-runtime";
  returnHtmlForRuntime = true;
  let fallbackError = "";
  try {
    await infer("/__runtime-engine.js");
  } catch (error) {
    fallbackError = error.message;
  }
  assert.match(fallbackError, /local transcription engine could not load/i);
  assert(
    !fallbackError.includes("expected magic word"),
    "HTML responses must be rejected before WebAssembly compilation",
  );
  assert.equal(
    remoteRequests.filter((item) => item.mode === "invalid-runtime").length,
    0,
    "A bad runtime must fail before requesting model files",
  );
  console.log(
    "PASS HTML fallback guard: actionable load error before ONNX/model initialization",
  );

  assert.deepEqual(errors, [], "No browser errors or WASM compilation errors");
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results", "transcription-runtime.json"),
    JSON.stringify(
      {
        dev,
        production,
        runtimeResponses,
        fallbackError,
        remoteRequests,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
