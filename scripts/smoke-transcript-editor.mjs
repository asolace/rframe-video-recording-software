/** Build first, then run with node. Routes dist in memory; no server or model download. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
  permissions: ["camera", "microphone"],
});
// Deterministic lifecycle fixture only: real speech inference has a separate smoke.
// Camera recording/audio decoding stay real; no AI output is claimed by this test.
await page.addInitScript(() => {
  window.__autoTranscript = { mode: "hold", workers: [], requests: 0 };
  const NativeWorker = window.Worker;
  window.Worker = class {
    constructor(url, options) {
      if (!String(url).includes("transcription.worker"))
        return new NativeWorker(url, options);
      this.entry = {
        terminated: false,
        mode: window.__autoTranscript.mode,
        requests: 0,
      };
      window.__autoTranscript.workers.push(this.entry);
    }
    postMessage(data) {
      this.entry.requests++;
      window.__autoTranscript.requests++;
      queueMicrotask(() => {
        if (this.entry.terminated) return;
        this.onmessage?.({
          data: {
            type: "progress",
            progress: { stage: "Transcribing fixture audio", progress: 0.5 },
          },
        });
        if (this.entry.mode === "failure")
          this.onmessage?.({
            data: {
              type: "error",
              message: "Test transcription unavailable. Please try again.",
            },
          });
        else if (this.entry.mode === "success")
          this.onmessage?.({
            data: {
              type: "complete",
              transcript: {
                language: "en",
                model: "deterministic-lifecycle-fixture",
                createdAt: 1,
                words: [
                  {
                    id: "auto-hello",
                    text: "Automatically",
                    start: 0.1,
                    end: Math.min(0.35, data.duration),
                  },
                  {
                    id: "auto-saved",
                    text: "transcribed",
                    start: 0.4,
                    end: data.duration + 0.02,
                  },
                ],
              },
            },
          });
      });
    }
    terminate() {
      this.entry.terminated = true;
    }
  };
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
await page.route("https://frame.test/**", async (route) => {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const file = path.resolve(
    dist,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  assert(file.startsWith(dist + path.sep));
  try {
    await route.fulfill({
      contentType: types[path.extname(file)] ?? "application/octet-stream",
      body: await readFile(file),
    });
  } catch {
    await route.fulfill({ status: 404, body: "Not found" });
  }
});
const transcript = {
  language: "en",
  model: "human-corrected-test-fixture",
  createdAt: 1,
  words: [
    { id: "hello", text: "Hello", start: 0.2, end: 0.5 },
    { id: "um", text: "um", start: 0.6, end: 0.8 },
    { id: "world", text: "world", start: 0.9, end: 1.3 },
    { id: "so", text: "so", start: 2.7, end: 3.0 },
    { id: "like", text: "like", start: 3.2, end: 3.45 },
    { id: "uh", text: "uh", start: 3.6, end: 3.9 },
    { id: "again", text: "again", start: 4.1, end: 4.6 },
    { id: "thanks", text: "thanks", start: 4.8, end: 5.0 },
  ],
};
const openTranscriptTools = async () => {
  if (
    !(await page
      .getByRole("button", { name: "Import JSON", exact: true })
      .isVisible())
  )
    await page.locator(".tp-tools > summary").click();
};
const importTranscript = async (value) => {
  await openTranscriptTools();
  return page
    .getByLabel("Import transcript JSON", { exact: true })
    .setInputFiles({
      name: "corrected.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(value)),
    });
};
const save = async () => {
  const button = page.getByRole("button", { name: "Save edits", exact: true });
  if (await button.isEnabled()) await button.click();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
};
const snapshot = () =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const [projects, videos] = await Promise.all([
      read("projects"),
      read("videos"),
    ]);
    db.close();
    const blob = videos[0].blob;
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return { project: projects[0], sourceHash: hash };
  });
const expectFullSource = (project) => {
  for (const clip of project.edits.clips)
    assert.equal(
      clip.crop,
      undefined,
      "Transcript edits preserve the full fixed canvas",
    );
};
const readProjects = () =>
  page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
    });
    const projects = await new Promise((resolve) => {
      const request = db
        .transaction("projects")
        .objectStore("projects")
        .getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return projects.sort((a, b) => b.createdAt - a.createdAt);
  });
const recordForAutoTranscript = async (mode) => {
  const before = await page.evaluate((mode) => {
    window.__autoTranscript.mode = mode;
    return window.__autoTranscript.requests;
  }, mode);
  await page.getByRole("button", { name: /Just you, on camera/ }).click();
  await page
    .getByRole("button", { name: "Set up preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start recording", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.waitForTimeout(1500);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Transcript", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => page.evaluate(() => window.__autoTranscript.requests), {
      timeout: 20_000,
    })
    .toBe(before + 1);
  return before + 1;
};

try {
  await page.goto("https://frame.test/");
  const fixture = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const drawing = canvas.getContext("2d");
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    const stream = new MediaStream([
      ...canvas.captureStream(25).getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8,opus",
    });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start(100);
    const began = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const elapsed = (performance.now() - began) / 1000;
        gain.gain.value = elapsed >= 1.5 && elapsed <= 2.4 ? 0 : 0.15;
        drawing.fillStyle = "#e02020";
        drawing.fillRect(0, 0, 160, 180);
        drawing.fillStyle = "#10c030";
        drawing.fillRect(160, 0, 160, 180);
        drawing.fillStyle = "white";
        drawing.fillText(elapsed.toFixed(2), 10, 20);
        if (elapsed >= 5.6) resolve();
        else requestAnimationFrame(frame);
      };
      frame();
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    oscillator.stop();
    await audio.close();
    return Array.from(
      new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      ),
    );
  });
  await page.getByLabel("Import video files", { exact: true }).setInputFiles({
    name: "Transcript smoke.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(fixture),
  });
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  await expect(
    page.getByLabel("Crop width percent", { exact: true }),
  ).toHaveCount(0);
  assert.equal(
    await page.evaluate(() => window.__autoTranscript.requests),
    0,
    "Importing a video does not start automatic transcription",
  );
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await importTranscript({
    ...transcript,
    words: [{ id: "bad", text: "bad", start: 10, end: 11 }],
  });
  await expect(page.getByRole("alert")).toContainText("invalid timing");
  await page.getByRole("button", { name: "Dismiss transcript error" }).click();
  await importTranscript({
    ...transcript,
    words: [{ id: "instant", text: "uh", start: 2, end: 2 }],
  });
  const instantWord = page.getByRole("button", {
    name: /^uh, clip 1,.*timing unavailable/,
  });
  await instantWord.click();
  await instantWord.press("Delete");
  await expect(
    page.getByText(/Timing is unavailable for these words/),
  ).toBeVisible();
  await expect(page.locator(".ed-clip")).toHaveCount(1);
  await importTranscript(transcript);
  await expect(page.locator(".tp-word")).toHaveCount(8);
  await save();
  const original = await snapshot();
  expectFullSource(original.project);
  const hello = page.getByRole("button", { name: /^Hello, clip 1,/ });
  await hello.click();
  await expect(hello).toHaveAttribute("aria-pressed", "true");
  await expect(hello).toHaveClass(/is-current/);
  await hello.press("Delete");
  await expect(page.locator(".tp-word")).toHaveCount(7);
  await save();
  const firstCut = await snapshot();
  expectFullSource(firstCut.project);
  assert.equal(firstCut.project.edits.clips[0].end, 0.2);
  assert.equal(firstCut.project.edits.clips[1].start, 0.5);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.locator(".tp-word")).toHaveCount(8);

  await page.getByRole("button", { name: /^world, clip 1,/ }).click();
  await page
    .getByRole("button", { name: /^again, clip 1,/ })
    .click({ modifiers: ["Shift"] });
  await page
    .getByRole("button", { name: "Delete selected words (5)", exact: true })
    .click();
  await expect(page.locator(".tp-word")).toHaveCount(3);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove filler words (2)", exact: true })
    .click();
  await expect(page.locator(".tp-word")).toHaveCount(6);
  await expect(page.getByRole("button", { name: /^so, clip / })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^like, clip / }),
  ).toBeVisible();
  await save();
  expectFullSource((await snapshot()).project);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();

  // Hold the result of a real decode, then cancel; stale completion must not edit.
  await page.evaluate(() => {
    window.__originalTranscriptDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (...args) {
      return window.__originalTranscriptDecode.apply(this, args).then(
        (decoded) =>
          new Promise((resolve) => {
            window.__releaseTranscriptDecode = () => resolve(decoded);
          }),
      );
    };
  });
  await page
    .getByRole("button", { name: "Find silences", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!window.__releaseTranscriptDecode))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Undo edit", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Regenerate transcript", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Cancel transcript operation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Find silences", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__releaseTranscriptDecode();
    AudioContext.prototype.decodeAudioData = window.__originalTranscriptDecode;
  });
  await expect(page.locator(".ed-clip")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Apply silence cuts", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Find silences", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply silence cuts", exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  await expect(
    page.getByRole("list", { name: "Silence preview" }).locator("li"),
  ).not.toHaveCount(0);
  await expect(page.locator(".ed-clip")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Apply silence cuts", exact: true })
    .click();
  await save();
  const quietCut = await snapshot();
  expectFullSource(quietCut.project);
  const quietDuration = quietCut.project.edits.clips.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0,
  );
  assert(
    quietDuration < original.project.duration - 0.4,
    "Silence preview must apply real quiet-audio cuts",
  );
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await save();

  // Repeated-source fixture exercises occurrence-scoped deletion after reordering.
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("projects", "readwrite");
    const store = tx.objectStore("projects");
    const request = store.getAll();
    request.onsuccess = () => {
      const project = request.result[0];
      const crop = project.edits.clips[0].crop;
      project.edits.clips = [
        { id: "late", start: 4, end: 5.3, crop },
        { id: "early", start: 0, end: 1.4, crop },
        { id: "repeat", start: 4, end: 5.3, crop },
      ];
      store.put(project);
    };
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Transcript smoke", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("button", { name: /^again, clip / })).toHaveCount(
    2,
  );
  const firstAgain = page.getByRole("button", { name: /^again, clip 1,/ });
  await firstAgain.click();
  await firstAgain.press("Backspace");
  await expect(page.getByRole("button", { name: /^again, clip / })).toHaveCount(
    1,
  );
  await save();
  const occurrenceCut = await snapshot();
  expectFullSource(occurrenceCut.project);
  assert.deepEqual(
    occurrenceCut.project.edits.clips.find((clip) => clip.id === "repeat"),
    {
      id: "repeat",
      start: 4,
      end: 5.3,
      crop: undefined,
    },
  );
  assert.equal(
    occurrenceCut.sourceHash,
    original.sourceHash,
    "Transcript cuts must preserve original bytes",
  );
  const jsonDownload = page.waitForEvent("download");
  await openTranscriptTools();
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const jsonFile = await (await jsonDownload).path();
  assert.deepEqual(JSON.parse(await readFile(jsonFile, "utf8")), transcript);
  await page.locator(".tp-tools > summary").click();
  await page.screenshot({
    path: path.join(output, "transcript-editor.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Remove filler words (1)", exact: true }),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Transcript editing fits mobile without overflow",
  );
  await page.screenshot({
    path: path.join(output, "transcript-editor-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  const exportDownload = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const exportedFile = await (await exportDownload).path();
  const exportedBytes = await readFile(exportedFile);
  assert(exportedBytes.length > 1000);
  const decoded = await page.evaluate(async (bytes) => {
    const video = document.createElement("video");
    video.muted = true;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: "video/webm" }),
    );
    const until = (event) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Decode timeout: ${event}`)),
          10_000,
        );
        video.addEventListener(
          event,
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    const loaded = until("loadedmetadata");
    video.src = url;
    await loaded;
    if (!Number.isFinite(video.duration)) {
      const ended = until("durationchange");
      video.currentTime = Number.MAX_SAFE_INTEGER;
      await ended;
    }
    const seeked = until("seeked");
    video.currentTime = 0.3;
    await seeked;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const drawing = canvas.getContext("2d");
    drawing.drawImage(
      video,
      video.videoWidth / 4,
      video.videoHeight / 2,
      1,
      1,
      0,
      0,
      1,
      1,
    );
    const left = [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3);
    drawing.drawImage(
      video,
      video.videoWidth * 0.75,
      video.videoHeight / 2,
      1,
      1,
      0,
      0,
      1,
      1,
    );
    const result = {
      duration: video.duration,
      left,
      right: [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3),
    };
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    return result;
  }, Array.from(exportedBytes));
  const expectedDuration = occurrenceCut.project.edits.clips.reduce(
    (sum, clip) => sum + clip.end - clip.start,
    0,
  );
  assert(
    Math.abs(decoded.duration - expectedDuration) < 0.3,
    "Rendered duration follows transcript cuts",
  );
  assert(
    decoded.left[0] > 150 &&
      decoded.left[1] < 70 &&
      decoded.right[1] > 140 &&
      decoded.right[0] < 50,
    `Rendered fixed canvas keeps both source halves: ${decoded.left} / ${decoded.right}`,
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Transcript smoke", exact: true })
    .click();
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("button", { name: /^again, clip / })).toHaveCount(
    1,
  );
  // A short transcript-cut remnant at source 4s must start there, not restart.
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction("projects", "readwrite");
    const store = tx.objectStore("projects");
    const request = store.getAll();
    request.onsuccess = () => {
      const project = request.result[0];
      const crop = project.edits.clips[0].crop;
      project.edits.clips = [{ id: "uncut", start: 0, end: 5.3, crop }];
      store.put(project);
    };
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Transcript smoke", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await importTranscript({
    ...transcript,
    words: [
      { id: "lead", text: "lead", start: 0.1, end: 0.5 },
      { id: "before", text: "before", start: 0.8, end: 4 },
      { id: "blink", text: "blink", start: 4, end: 4.02 },
      { id: "after", text: "after", start: 4.02, end: 4.8 },
      { id: "tail", text: "tail", start: 4.8, end: 5.2 },
    ],
  });
  await page.getByRole("button", { name: /^before, clip 1,/ }).click();
  await page
    .getByRole("button", { name: /^after, clip 1,/ })
    .click({ modifiers: ["Control"] });
  await page
    .getByRole("button", { name: "Delete selected words (2)", exact: true })
    .click();
  await expect(page.locator(".ed-clip")).toHaveCount(3);
  await page.getByRole("button", { name: /^blink, clip 2,/ }).click();
  await page.evaluate(() => {
    window.__transcriptPlayStarts = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      this.addEventListener(
        "play",
        () => window.__transcriptPlayStarts.push(this.currentTime),
        { once: true },
      );
      return play.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__transcriptPlayStarts.length))
    .toBeGreaterThan(0);
  assert(
    await page.evaluate(() => window.__transcriptPlayStarts[0] >= 3.99),
    "Playing a 20ms selected fragment preserves its nonzero source position",
  );
  await page
    .getByRole("button", { name: "Save and return to projects", exact: true })
    .click();

  // Full-app lifecycle: recording is persisted before the automatic job begins.
  const beforeAutoCount = (await readProjects()).length;
  const cancelledRequest = await recordForAutoTranscript("hold");
  assert.equal((await readProjects()).length, beforeAutoCount + 1);
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Cancel transcript operation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Generate transcript", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText(/Transcription cancelled. Your recording is saved/),
  ).toBeVisible();
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.__autoTranscript.requests),
    cancelledRequest,
    "Cancellation must not schedule another automatic attempt",
  );
  assert.equal(
    await page.evaluate(
      () => window.__autoTranscript.workers.at(-1).terminated,
    ),
    true,
  );
  assert.equal((await readProjects())[0].edits.transcript, undefined);
  await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Auto cancelled");
  await page
    .getByRole("button", { name: "Save and return to projects", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit Auto cancelled", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled();
  assert.equal(
    await page.evaluate(() => window.__autoTranscript.requests),
    cancelledRequest,
    "Reopening a cancelled recording does not automatically retry",
  );
  await page
    .getByRole("button", { name: "Save and return to projects", exact: true })
    .click();

  const failedRequest = await recordForAutoTranscript("failure");
  await expect(page.getByRole("alert")).toContainText(
    "Test transcription unavailable",
  );
  await expect(page.getByRole("alert")).toContainText(
    "Your recording remains saved",
  );
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.__autoTranscript.requests),
    failedRequest,
    "Failure must not loop automatic transcription",
  );
  await page.evaluate(() => {
    window.__autoTranscript.mode = "success";
  });
  await page
    .getByRole("button", { name: "Generate transcript", exact: true })
    .click();
  await expect(page.locator(".tp-word")).toHaveCount(2);
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Auto retried");
  await page
    .getByRole("button", { name: "Save and return to projects", exact: true })
    .click();

  const successfulRequest = await recordForAutoTranscript("success");
  await expect(page.locator(".tp-word")).toHaveCount(2);
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save edits", exact: true }),
  ).toBeDisabled();
  const automaticProject = (await readProjects())[0];
  assert.equal(
    automaticProject.edits.transcript.model,
    "deterministic-lifecycle-fixture",
  );
  assert.equal(
    await page.evaluate(() => window.__autoTranscript.requests),
    successfulRequest,
    "Successful automatic persistence does not launch another job",
  );
  await page.reload();
  await page
    .getByRole("button", { name: `Edit ${automaticProject.name}`, exact: true })
    .click();
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect(page.locator(".tp-word")).toHaveCount(2);
  assert.equal(
    await page.evaluate(() => window.__autoTranscript.requests),
    0,
    "An automatically saved transcript reopens without transcription",
  );

  // Development StrictMode deliberately performs effect setup/cleanup twice.
  const harness = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
      import React, {useEffect, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import TranscriptPanel from './src/features/editor/TranscriptPanel';
      window.__strictAuto = {mounts:0, changes:0, saves:0, busy:false};
      function Harness({blob,duration}) {
        const [edits,setEdits] = useState({clips:[{id:'strict',start:0,end:duration}],muted:false,volume:1,title:'',aspectRatio:'original'});
        const [,rerender] = useState(0);
        useEffect(()=>{window.__strictAuto.mounts++},[]);
        return <><button onClick={()=>rerender(value=>value+1)}>Rerender harness</button><TranscriptPanel blob={blob} duration={duration} edits={edits} disabled={false} sourceTime={0} activeClipId="strict" autoGenerate={true} onSeek={()=>{}} onBusyChange={busy=>{window.__strictAuto.busy=busy}} onChange={next=>{window.__strictAuto.changes++;setEdits(next)}} onAutoGenerated={async next=>{window.__strictAuto.saves++;await new Promise(resolve=>setTimeout(resolve,75));window.__strictAuto.saved=next}} /></>;
      }
      window.mountStrictAuto = (blob,duration) => {window.__strictAuto.sourceDuration=duration;createRoot(document.getElementById('strict-root')).render(<React.StrictMode><Harness blob={blob} duration={duration}/></React.StrictMode>)};
    `,
    },
    bundle: true,
    format: "esm",
    write: false,
    define: { "process.env.NODE_ENV": '"development"' },
    loader: { ".css": "empty" },
    jsx: "automatic",
  });
  await page.route("https://frame.test/strict-mode", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><div id="strict-root"></div></body></html>',
    }),
  );
  await page.goto("https://frame.test/strict-mode");
  await page.addScriptTag({
    type: "module",
    content: harness.outputFiles[0].text,
  });
  await page.evaluate(async () => {
    window.__autoTranscript.mode = "success";
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
    });
    const read = (store) =>
      new Promise((resolve) => {
        const request = db.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
      });
    const [projects, videos] = await Promise.all([
      read("projects"),
      read("videos"),
    ]);
    db.close();
    const project = projects.find(
      (project) => project.name === "Transcript smoke",
    );
    window.mountStrictAuto(
      videos.find((video) => video.id === project.id).blob,
      project.duration,
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__strictAuto.saved?.transcript.words.length),
    )
    .toBe(2);
  assert.deepEqual(
    await page.evaluate(() => ({
      mounts: window.__strictAuto.mounts,
      changes: window.__strictAuto.changes,
      saves: window.__strictAuto.saves,
      requests: window.__autoTranscript.requests,
    })),
    { mounts: 2, changes: 1, saves: 1, requests: 1 },
  );
  await expect
    .poll(() => page.evaluate(() => window.__strictAuto.busy))
    .toBe(false);
  assert(
    await page.evaluate(() =>
      window.__strictAuto.saved.transcript.words.every(
        (word) => word.end <= window.__strictAuto.sourceDuration,
      ),
    ),
    "Generated timestamps are clipped to the source duration before automatic save",
  );
  await page
    .getByRole("button", { name: "Rerender harness", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.__autoTranscript.requests), 1);
  assert.deepEqual(
    errors,
    [],
    "No browser errors during transcript-driven editing",
  );
  console.log(
    "PASS transcript editor: strict import, word cuts/fillers, silence preview/apply and cancellation, occurrence-scoped cuts, undo, full source/canvas export, persistence/mobile,20ms fragment playback, automatic recording transcription/save/reopen, cancel/failure/manual retry, StrictMode exactly-once lifecycle",
  );
} catch (error) {
  console.error("Browser errors:", errors);
  await page
    .screenshot({
      path: path.join(output, "transcript-editor-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
