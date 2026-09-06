/**
 * Real browser/ONNX smoke: npm run build && node scripts/smoke-transcription.mjs
 * Runs the production worker against HF's public JFK speech example and a
 * browser-encoded video. No server, microphone, paid API, or inference mock.
 * The first run downloads the ~45 MB timestamped Whisper model from Hugging Face.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const workerName = (await readdir(path.join(dist, "assets"))).find((file) =>
  /^transcription\.worker-.*\.js$/.test(file),
);
assert(
  workerName,
  "Run npm run build first to produce the transcription worker",
);
const engine = await build({
  stdin: {
    contents:
      'export * from "./transcription"; export * from "./audio-analysis"; export {validateTranscript} from "./transcript-edit";',
    resolveDir: path.join(root, "src/lib"),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext();
const errors = [];
const externalRequests = [];
let blockExternal = false;
await context.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== "https://frame.test") {
    externalRequests.push({
      url: url.href,
      method: route.request().method(),
      blocked: blockExternal,
    });
    if (blockExternal) await route.abort("internetdisconnected");
    else await route.continue();
    return;
  }
  if (url.pathname === "/engine.js") {
    await route.fulfill({
      contentType: "text/javascript",
      body: engine.outputFiles[0].text,
    });
    return;
  }
  const target =
    url.pathname === "/transcription.worker.ts"
      ? path.join(dist, "assets", workerName)
      : path.resolve(
          dist,
          `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
        );
  assert(target.startsWith(`${dist}${path.sep}`));
  try {
    await route.fulfill({
      contentType: mime[path.extname(target)] || "application/octet-stream",
      body: await readFile(target),
    });
  } catch {
    await route.fulfill({ status: 404, body: "Not found" });
  }
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
let lastProgress = "";
await page.exposeFunction("reportProgress", (progress) => {
  const marker = `${progress.stage}: ${progress.progress === null ? "working" : `${Math.floor(progress.progress * 5) * 20}%`}`;
  if (marker !== lastProgress) {
    console.log(marker);
    lastProgress = marker;
  }
});
await page.addInitScript(() => {
  window.__workers = { created: 0, terminated: 0 };
  const NativeWorker = Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      window.__workers.created++;
    }
    terminate() {
      window.__workers.terminated++;
      super.terminate();
    }
  };
  window.__contexts = [];
  const NativeAudioContext = AudioContext;
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      window.__contexts.push(this);
    }
  };
});

try {
  await page.goto("https://frame.test/");
  await page.evaluate(async () => {
    window.engine = await import("/engine.js");
  });
  assert.equal(
    externalRequests.length,
    0,
    "Opening the app must not download a speech model",
  );
  const first = await page.evaluate(async () => {
    const response = await fetch(
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
    );
    if (!response.ok)
      throw new Error(`Speech sample download failed: ${response.status}`);
    window.__speechSample = await response.blob();
    const source = await window.engine.decodeVideoAudio(window.__speechSample, {
      signal: new AbortController().signal,
    });
    const began = performance.now();
    const progress = [];
    const transcript = await window.engine.transcribeVideo(
      window.__speechSample,
      {
        signal: new AbortController().signal,
        onProgress: (value) => {
          progress.push(value);
          void window.reportProgress(value);
        },
      },
    );
    window.engine.validateTranscript(transcript, source.duration);
    window.__firstTranscript = transcript;
    const cacheEntries = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) cacheEntries.push(request.url);
    }
    return {
      transcript,
      duration: source.duration,
      elapsed: (performance.now() - began) / 1000,
      progress,
      cacheEntries,
    };
  });
  const text = first.transcript.words.map((word) => word.text).join(" ");
  console.log(`Actual model output: ${text}`);
  assert.match(text, /fellow Americans/i);
  assert.match(text, /country can do for you/i);
  assert(
    first.transcript.words.length >= 18 && first.transcript.words.length <= 30,
    "Expected word-level JFK speech output, not segment timestamps",
  );
  assert(
    new Set(first.transcript.words.map((word) => word.start)).size > 12,
    "Words should have individual aligned timestamps",
  );
  assert(
    first.transcript.words.some((word) => word.start > 8),
    "Alignment must span the original speech",
  );
  assert(
    first.cacheEntries.filter((url) => url.endsWith(".onnx")).length >= 2,
    "Both model graphs must be stored in browser CacheStorage",
  );
  assert(
    first.progress.some(
      (item) => /Loading/.test(item.stage) && item.progress !== null,
    ),
  );
  const modelProgress = first.progress
    .filter((item) => /Loading/.test(item.stage) && item.progress !== null)
    .map((item) => item.progress);
  assert(
    modelProgress.every(
      (value, index) => index === 0 || value >= modelProgress[index - 1],
    ),
    "Model-loading progress must not move backwards",
  );
  console.log(
    `PASS actual WASM speech inference: ${first.transcript.words.length} words, ${first.elapsed.toFixed(1)}s, ${first.cacheEntries.length} cached model files`,
  );

  const fixtures = await page.evaluate(async () => {
    const source = await window.engine.decodeVideoAudio(window.__speechSample, {
      signal: new AbortController().signal,
    });
    const context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    const buffer = context.createBuffer(1, source.samples.length, 16000);
    buffer.copyToChannel(source.samples, 0);
    const audio = context.createBufferSource();
    audio.buffer = buffer;
    const destination = context.createMediaStreamDestination();
    audio.connect(destination);
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const drawing = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    destination.stream
      .getAudioTracks()
      .forEach((track) => stream.addTrack(track));
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8,opus",
    });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    const paint = setInterval(() => {
      drawing.fillStyle = "#172537";
      drawing.fillRect(0, 0, 320, 180);
      drawing.fillStyle = "#fff";
      drawing.font = "16px sans-serif";
      drawing.fillText("Browser-recorded speech fixture", 30, 85);
    }, 50);
    recorder.start(250);
    audio.start();
    await new Promise((resolve) => {
      audio.onended = resolve;
    });
    recorder.stop();
    await stopped;
    clearInterval(paint);
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    window.__speechVideo = new Blob(chunks, { type: recorder.mimeType });
    const decoded = await window.engine.decodeVideoAudio(window.__speechVideo, {
      signal: new AbortController().signal,
    });
    return {
      bytes: window.__speechVideo.size,
      sampleRate: decoded.sampleRate,
      duration: decoded.duration,
    };
  });
  assert.equal(fixtures.sampleRate, 16000);
  assert(
    fixtures.bytes > 1000 && Math.abs(fixtures.duration - first.duration) < 0.2,
  );

  // All model-host requests are now blocked. Cached graphs plus the bundled
  // same-origin WASM must still transcribe the generated video successfully.
  blockExternal = true;
  const offline = await page.evaluate(async () => {
    const began = performance.now();
    const source = await window.engine.decodeVideoAudio(window.__speechVideo, {
      signal: new AbortController().signal,
    });
    const transcript = await window.engine.transcribeVideo(
      window.__speechVideo,
      {
        signal: new AbortController().signal,
        onProgress: (value) => {
          void window.reportProgress(value);
        },
      },
    );
    window.engine.validateTranscript(transcript, source.duration);
    return {
      transcript,
      duration: source.duration,
      elapsed: (performance.now() - began) / 1000,
    };
  });
  assert.match(
    offline.transcript.words.map((word) => word.text).join(" "),
    /fellow Americans/i,
  );
  assert.equal(
    externalRequests.filter((request) => request.blocked).length,
    0,
    "A cached transcription should not need external network requests",
  );
  console.log(
    `PASS browser-encoded video + cached/offline model: ${offline.transcript.words.length} words in ${offline.elapsed.toFixed(1)}s`,
  );

  const long = await page.evaluate(async () => {
    const source = await window.engine.decodeVideoAudio(window.__speechSample, {
      signal: new AbortController().signal,
    });
    const pause = 12_000;
    const samples = new Float32Array(source.samples.length * 3 + pause * 2);
    for (let index = 0; index < 3; index++)
      samples.set(source.samples, index * (source.samples.length + pause));
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => {
      [...value].forEach((char, index) =>
        view.setUint8(offset + index, char.charCodeAt(0)),
      );
    };
    text(0, "RIFF");
    view.setUint32(4, bytes.byteLength - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) =>
      view.setInt16(
        44 + index * 2,
        Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
        true,
      ),
    );
    const blob = new Blob([bytes], { type: "audio/wav" });
    const began = performance.now();
    const transcript = await window.engine.transcribeVideo(blob, {
      signal: new AbortController().signal,
      onProgress: (value) => {
        void window.reportProgress(value);
      },
    });
    window.engine.validateTranscript(transcript, samples.length / 16000);
    return {
      transcript,
      duration: samples.length / 16000,
      elapsed: (performance.now() - began) / 1000,
    };
  });
  assert(
    long.duration > 25,
    "Test audio must cross a Whisper processing window",
  );
  const repeated = long.transcript.words.map((word) => word.text).join(" ");
  console.log(
    `Long speech output (${long.transcript.words.length} words): ${repeated}`,
  );
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await writeFile(
    path.join(root, "test-results", "transcription-long.json"),
    JSON.stringify(long, null, 2),
  );
  assert.equal(
    (repeated.match(/fellow Americans/gi) || []).length,
    3,
    "Overlapping chunks must retain each spoken phrase exactly once",
  );
  assert(
    long.transcript.words.length >= 62 && long.transcript.words.length <= 70,
    "No repeated overlap words should be inserted",
  );
  assert(
    long.transcript.words.some((word) => word.start > 30),
    "Word timestamps must be absolute across chunk boundaries",
  );
  console.log(
    `PASS ${long.duration.toFixed(1)}s repeated speech across overlapping windows: ${long.transcript.words.length} monotonically aligned words, ${long.elapsed.toFixed(1)}s`,
  );

  const audioChecks = await page.evaluate(async () => {
    const rate = 48000;
    const count = rate * 3;
    const bytes = new ArrayBuffer(44 + count * 4);
    const view = new DataView(bytes);
    const text = (offset, value) => {
      [...value].forEach((char, index) =>
        view.setUint8(offset + index, char.charCodeAt(0)),
      );
    };
    text(0, "RIFF");
    view.setUint32(4, bytes.byteLength - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, count * 4, true);
    for (let index = 0; index < count; index++) {
      const tone =
        index >= rate && index < rate * 2
          ? 0
          : Math.sin((2 * Math.PI * 300 * index) / rate);
      view.setInt16(44 + index * 4, Math.round(tone * 12000), true);
      view.setInt16(46 + index * 4, Math.round(tone * 4000), true);
    }
    const blob = new Blob([bytes], { type: "audio/wav" });
    const decoded = await window.engine.decodeVideoAudio(blob, {
      signal: new AbortController().signal,
    });
    const silences = await window.engine.analyzeSilences(blob, {
      signal: new AbortController().signal,
      minDuration: 0.5,
      padding: 0.1,
    });
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const drawing = canvas.getContext("2d");
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const parts = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    const painter = setInterval(() => {
      drawing.fillStyle = "#273651";
      drawing.fillRect(0, 0, 160, 90);
    }, 100);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    recorder.stop();
    await stopped;
    clearInterval(painter);
    stream.getTracks().forEach((track) => track.stop());
    const before = window.__workers.created;
    let missingAudio = "";
    try {
      await window.engine.transcribeVideo(
        new Blob(parts, { type: recorder.mimeType }),
        { signal: new AbortController().signal, onProgress: () => {} },
      );
    } catch (error) {
      missingAudio = error.message;
    }
    return {
      sampleRate: decoded.sampleRate,
      length: decoded.samples.length,
      silences,
      missingAudio,
      workerStartedForMissingAudio: window.__workers.created !== before,
    };
  });
  assert.equal(audioChecks.sampleRate, 16000);
  assert.equal(audioChecks.length, 48000);
  assert.equal(audioChecks.silences.length, 1);
  assert(
    Math.abs(audioChecks.silences[0].start - 1.1) < 0.03 &&
      Math.abs(audioChecks.silences[0].end - 1.9) < 0.03,
  );
  assert.match(
    audioChecks.missingAudio,
    /no readable audio track|no audio track/i,
  );
  assert.equal(
    audioChecks.workerStartedForMissingAudio,
    false,
    "Missing-audio videos must fail before downloading/starting a model",
  );
  console.log(
    "PASS real 48kHz stereo→16kHz mono decoding, padded silence analysis, no-audio video error",
  );

  const cancellation = await page.evaluate(async () => {
    const early = new AbortController();
    early.abort();
    let earlyError = "";
    try {
      await window.engine.transcribeVideo(window.__speechSample, {
        signal: early.signal,
        onProgress: () => {},
      });
    } catch (error) {
      earlyError = error.name;
    }
    const controller = new AbortController();
    let errorName = "";
    const began = performance.now();
    try {
      await window.engine.transcribeVideo(window.__speechSample, {
        signal: controller.signal,
        onProgress: (value) => {
          if (/Transcribing English/.test(value.stage))
            setTimeout(() => controller.abort(), 80);
        },
      });
    } catch (error) {
      errorName = error.name;
    }
    return {
      earlyError,
      errorName,
      elapsed: (performance.now() - began) / 1000,
      workers: window.__workers,
      contexts: window.__contexts.map((item) => item.state),
    };
  });
  assert.equal(cancellation.earlyError, "AbortError");
  assert.equal(cancellation.errorName, "AbortError");
  assert.equal(
    cancellation.workers.created,
    cancellation.workers.terminated,
    "Every complete/cancelled worker must terminate",
  );
  assert(
    cancellation.contexts.every((state) => state === "closed"),
    "Audio decoding contexts must be released",
  );
  console.log(
    "PASS cancellation before decoding and during real ONNX inference, worker termination, audio context cleanup",
  );

  // Exercise the actual product integration too, using the same locally encoded
  // video and model cache. This catches editor duration/validation mismatches.
  const videoBytes = Buffer.from(
    await page.evaluate(async () => [
      ...new Uint8Array(await window.__speechVideo.arrayBuffer()),
    ]),
  );
  await page
    .getByLabel("Import video files", { exact: true })
    .setInputFiles({
      name: "transcription-smoke.webm",
      mimeType: "video/webm",
      buffer: videoBytes,
    });
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate transcript", exact: true })
    .click();
  await expect(
    page.getByLabel("Transcript words", { exact: true }),
  ).toBeVisible({ timeout: 120000 });
  await expect(
    page.getByLabel("Transcript words", { exact: true }),
  ).toContainText("Americans");
  await expect(
    page.getByRole("button", { name: "Save edits", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await mkdir(path.join(root, "test-results"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "test-results", "transcription-editor.png"),
    fullPage: true,
  });
  console.log(
    "PASS actual app Import video → Transcript → Generate transcript → aligned words → Save edits",
  );

  assert(
    externalRequests.every((request) =>
      ["GET", "HEAD"].includes(request.method),
    ),
    "Audio must never be uploaded",
  );
  assert.deepEqual(errors, [], "No browser console/page errors");
  await writeFile(
    path.join(root, "test-results", "transcription.json"),
    JSON.stringify(
      {
        first,
        fixtures,
        offline,
        long,
        audioChecks,
        cancellation,
        externalRequests,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
