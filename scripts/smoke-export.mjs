/** Actual browser/media validation. Run: node scripts/smoke-export.mjs
 * Uses an in-memory HTTPS route, never starts a development server.
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/lib/export-video.ts"],
  bundle: true,
  format: "iife",
  globalName: "exportTools",
  write: false,
});
let browser;
for (const channel of ["chrome", "msedge", undefined]) {
  try {
    browser = await chromium.launch({
      channel,
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    break;
  } catch (error) {
    if (channel === undefined) throw error;
  }
}
try {
  const page = await browser.newPage();
  await page.route("https://frame.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("https://frame.test/");
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = (target, event) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${event}`)),
          15000,
        );
        target.addEventListener(
          event,
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        target.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error(`Media error waiting for ${event}`));
          },
          { once: true },
        );
      });
    const hash = async (blob) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
        ),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 320;
    sourceCanvas.height = 180;
    document.body.appendChild(sourceCanvas);
    const ctx = sourceCanvas.getContext("2d");
    const audioContext = new AudioContext();
    await audioContext.resume();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const gain = audioContext.createGain();
    gain.gain.value = 0.2;
    const audioDestination = audioContext.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(audioDestination);
    const sourceStream = sourceCanvas.captureStream(30);
    audioDestination.stream
      .getAudioTracks()
      .forEach((track) => sourceStream.addTrack(track));
    const sourceRecorder = new MediaRecorder(sourceStream, {
      mimeType: "video/webm;codecs=vp9,opus",
    });
    const chunks = [];
    sourceRecorder.ondataavailable = (event) => chunks.push(event.data);
    const sourceStopped = until(sourceRecorder, "stop");
    sourceRecorder.start(100);
    oscillator.start();
    const began = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const elapsed = performance.now() - began;
        ctx.fillStyle = elapsed < 1250 ? "#ff0000" : "#0000ff";
        ctx.fillRect(0, 0, 320, 180);
        // The changing counter makes every source frame unambiguous to captureStream.
        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(Math.round(elapsed)), 12, 20);
        if (elapsed < 2500) requestAnimationFrame(frame);
        else resolve();
      };
      frame();
    });
    sourceRecorder.stop();
    await sourceStopped;
    oscillator.stop();
    sourceStream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
    sourceCanvas.remove();
    const source = new Blob(chunks, { type: "video/webm" });
    const originalHash = await hash(source);
    const originalSize = source.size;

    // Capture streams produced by export and assert cleanup, including cancellation.
    const capturedStreams = [];
    const pendingFrames = new Set();
    const originalRequestFrame = window.requestAnimationFrame;
    const originalCancelFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      const id = originalRequestFrame.call(window, (time) => {
        pendingFrames.delete(id);
        callback(time);
      });
      pendingFrames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pendingFrames.delete(id);
      originalCancelFrame.call(window, id);
    };
    const originalCapture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (...args) {
      const stream = originalCapture.apply(this, args);
      capturedStreams.push(stream);
      return stream;
    };
    const edits = {
      clips: [
        { id: "blue", start: 1.55, end: 2.3 },
        { id: "red", start: 0.15, end: 0.9 },
      ],
      muted: true,
      volume: 0.4,
      title: "FRAME TEST",
      aspectRatio: "1:1",
    };
    const expectedDuration = 1.5;
    const exported = [];
    let dimensions;
    let colors;
    let titlePixels;
    let outputDuration;
    for (const muted of [true, false]) {
      let progress = 0;
      const result = await exportTools.exportVideo({
        source,
        edits: { ...edits, muted },
        width: 320,
        height: 180,
        signal: new AbortController().signal,
        onProgress: (value) => {
          progress = value;
        },
      });
      const decoder = new AudioContext();
      const audio = await decoder.decodeAudioData(await result.arrayBuffer());
      const samples = audio.getChannelData(0);
      const rms = Math.sqrt(
        samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
      );
      await decoder.close();
      exported.push({
        muted,
        size: result.size,
        mimeType: result.type,
        progress,
        rms,
      });
      if (muted) {
        const video = document.createElement("video");
        document.body.appendChild(video);
        video.muted = true;
        const loaded = until(video, "loadeddata");
        const url = URL.createObjectURL(result);
        video.src = url;
        await loaded;
        dimensions = [video.videoWidth, video.videoHeight];
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = 320;
        sampleCanvas.height = 320;
        const sampler = sampleCanvas.getContext("2d");
        const sampleFrame = () => {
          sampler.drawImage(video, 0, 0, 320, 320);
          return Array.from(sampler.getImageData(160, 120, 1, 1).data);
        };
        await video.play();
        await sleep(220);
        const blue = sampleFrame();
        // Title sits in the lower black letterbox area; count bright glyph pixels.
        const titleArea = sampler.getImageData(50, 270, 220, 36).data;
        titlePixels = 0;
        for (let offset = 0; offset < titleArea.length; offset += 4) {
          if (
            titleArea[offset] > 150 &&
            titleArea[offset + 1] > 150 &&
            titleArea[offset + 2] > 150
          )
            titlePixels++;
        }
        await sleep(750);
        const red = sampleFrame();
        colors = { blue, red };
        await until(video, "ended");
        outputDuration = video.duration;
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
        URL.revokeObjectURL(url);
      }
    }
    const controller = new AbortController();
    let cancellation;
    try {
      await exportTools.exportVideo({
        source,
        edits,
        width: 320,
        height: 180,
        signal: controller.signal,
        onProgress: (value) => {
          if (value > 0.05) controller.abort();
        },
      });
      cancellation = "did not cancel";
    } catch (error) {
      cancellation = error.name;
    }
    HTMLCanvasElement.prototype.captureStream = originalCapture;
    window.requestAnimationFrame = originalRequestFrame;
    window.cancelAnimationFrame = originalCancelFrame;
    return {
      sourceBytes: originalSize,
      sourceUnchanged:
        originalSize === source.size && originalHash === (await hash(source)),
      expectedDuration,
      outputDuration,
      dimensions,
      colors,
      titlePixels,
      exported,
      cancellation,
      leakedVideos: document.querySelectorAll("video").length,
      capturedStreamCount: capturedStreams.length,
      liveTracks: capturedStreams
        .flatMap((stream) => stream.getTracks())
        .filter((track) => track.readyState !== "ended").length,
      pendingAnimationFrames: pendingFrames.size,
    };
  });
  assert.equal(
    results.sourceUnchanged,
    true,
    "Original source bytes must remain untouched",
  );
  assert.deepEqual(
    results.dimensions,
    [320, 320],
    "Export must apply square aspect ratio",
  );
  assert.ok(
    Math.abs(results.outputDuration - results.expectedDuration) < 0.25,
    `Trimmed duration ${results.outputDuration} must be close to ${results.expectedDuration}`,
  );
  assert.ok(
    results.colors.blue[2] > 180 && results.colors.blue[0] < 70,
    "First exported clip must be the reordered blue section",
  );
  assert.ok(
    results.colors.red[0] > 180 && results.colors.red[2] < 70,
    "Second exported clip must be the reordered red section",
  );
  assert.ok(
    results.titlePixels > 40,
    "Title overlay must be present in exported frames",
  );
  assert.ok(
    results.exported[0].rms < 0.001,
    "Muted export must contain silent audio",
  );
  assert.ok(
    results.exported[1].rms > 0.035 && results.exported[1].rms < 0.08,
    "40% volume export must contain appropriately attenuated audio",
  );
  for (const item of results.exported) {
    assert.equal(item.progress, 1);
    assert.ok(item.size > 1000);
  }
  assert.equal(
    results.cancellation,
    "AbortError",
    "Cancellation must reject with AbortError",
  );
  assert.equal(
    results.leakedVideos,
    0,
    "Export must remove temporary video elements",
  );
  assert.equal(
    results.liveTracks,
    0,
    "Export must stop all captured video and audio tracks",
  );
  assert.equal(
    results.pendingAnimationFrames,
    0,
    "Cancellation must not leave a playback or drawing loop running",
  );
  console.log(JSON.stringify(results, null, 2));
  console.log(
    "PASS: real video trims, reordered frames, square canvas, title, audio gain, mute, cancellation, and cleanup.",
  );
} finally {
  await browser?.close();
}
