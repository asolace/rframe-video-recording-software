/**
 * Recorder integration smoke. Run `npm run build && node scripts/smoke-recorder.mjs`.
 * Serves dist through Playwright route interception: no development server is started.
 * Camera/microphone use Chrome's real media APIs with its built-in fake devices.
 * Screen scenarios replace getDisplayMedia with an explicit canvas/audio fixture;
 * the meter scenario replaces only mic audio with a controlled oscillator.
 * Neither fixture tests the native screen-share picker or physical hardware.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await mkdir(path.join(root, "test-results"), { recursive: true });
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["camera", "microphone"],
});
await context.route("https://frame.test/**", async (route) => {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const target = path.resolve(
    dist,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  assert(
    target.startsWith(`${dist}${path.sep}`),
    "Static resource must remain inside dist",
  );
  try {
    await route.fulfill({
      status: 200,
      contentType: mime[path.extname(target)] || "application/octet-stream",
      body: await readFile(target),
    });
  } catch {
    await route.fulfill({ status: 404, body: "Not found" });
  }
});

await context.addInitScript(() => {
  window.__mediaTest = {
    tracks: [],
    captures: 0,
    delayInput: false,
    pending: null,
    screen: null,
    screens: [],
    cameraStreams: [],
    audioSources: [],
    recorders: [],
    rejectDisplay: false,
    delayDisplay: false,
    pendingDisplay: null,
    mockMicrophone: false,
    microphoneFixture: null,
    speakerConnections: 0,
  };
  const own = (stream) => {
    window.__mediaTest.tracks.push(...stream.getTracks());
    return stream;
  };
  const original = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices,
  );
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__mediaTest.captures++;
    let stream = own(await original(constraints));
    if (window.__mediaTest.mockMicrophone && constraints.audio) {
      const camera = stream.getVideoTracks();
      stream.getAudioTracks().forEach((track) => track.stop());
      const audio = new AudioContext();
      const destination = audio.createMediaStreamDestination();
      const oscillator = audio.createOscillator();
      oscillator.frequency.value = 660;
      const gain = audio.createGain();
      gain.gain.value = 0.004;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await audio.resume();
      const microphone = destination.stream.getAudioTracks()[0];
      const stop = microphone.stop.bind(microphone);
      let disposed = false;
      microphone.stop = () => {
        stop();
        if (disposed) return;
        disposed = true;
        oscillator.stop();
        gain.disconnect();
        void audio.close();
      };
      stream = own(new MediaStream([...camera, microphone]));
      window.__mediaTest.microphoneFixture = { audio, gain, microphone };
    }
    window.__mediaTest.cameraStreams.push(stream);
    if (window.__mediaTest.delayInput) {
      await new Promise((resolve) => {
        window.__mediaTest.pending = resolve;
      });
      window.__mediaTest.pending = null;
    }
    return stream;
  };
  const capture = HTMLCanvasElement.prototype.captureStream;
  HTMLCanvasElement.prototype.captureStream = function (...args) {
    return own(capture.apply(this, args));
  };
  const connectNode = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    if (args[0] instanceof AudioDestinationNode)
      window.__mediaTest.speakerConnections++;
    return connectNode.apply(this, args);
  };
  const destination = AudioContext.prototype.createMediaStreamDestination;
  AudioContext.prototype.createMediaStreamDestination = function (...args) {
    const node = destination.apply(this, args);
    own(node.stream);
    return node;
  };
  const source = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    const node = source.call(this, stream);
    const entry = {
      ids: stream.getTracks().map((track) => track.id),
      connected: false,
    };
    window.__mediaTest.audioSources.push(entry);
    const connect = node.connect.bind(node);
    const disconnect = node.disconnect.bind(node);
    node.connect = (...args) => {
      entry.connected = true;
      return connect(...args);
    };
    node.disconnect = (...args) => {
      entry.connected = false;
      return disconnect(...args);
    };
    return node;
  };
  const NativeRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends NativeRecorder {
    constructor(stream, options) {
      super(stream, options);
      this.testEntry = {
        recorder: this,
        stream,
        ids: stream.getTracks().map((track) => track.id),
        startedAt: 0,
      };
      window.__mediaTest.recorders.push(this.testEntry);
    }
    start(...args) {
      this.testEntry.startedAt = performance.now();
      return super.start(...args);
    }
  };
});

const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const allStopped = () =>
  page.evaluate(
    () =>
      window.__mediaTest.tracks.length > 0 &&
      window.__mediaTest.tracks.every((track) => track.readyState === "ended"),
  );
const readDatabase = () =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(["projects", "videos"], "readonly");
    const read = (name) =>
      new Promise((resolve, reject) => {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const [projects, videos] = await Promise.all([
      read("projects"),
      read("videos"),
    ]);
    db.close();
    const media = await Promise.all(
      videos.map(async ({ id, blob }) => ({
        id,
        size: blob.size,
        type: blob.type,
        hash: [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
          ),
        ]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join(""),
      })),
    );
    return { projects, media };
  });
const cameraSetup = async () => {
  await page.getByRole("button", { name: /Just you, on camera/ }).click();
  await expect(
    page.getByRole("button", { name: "Set up preview" }),
  ).toBeVisible();
};
const preview = async () => {
  await page.getByRole("button", { name: "Set up preview" }).click();
  await expect(
    page.getByRole("button", { name: "Start recording", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await expect
    .poll(() =>
      page
        .locator(".rc-video")
        .evaluate(
          (video) =>
            video.readyState >= 2 &&
            video.srcObject?.getVideoTracks().length === 1,
        ),
    )
    .toBe(true);
};

const assertRecordingStable = async (ids) => {
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeEnabled();
  const state = await page.evaluate(() => {
    const { recorder, stream } = window.__mediaTest.recorders.at(-1);
    return {
      state: recorder.state,
      ids: stream.getTracks().map((track) => track.id),
      live: stream.getTracks().every((track) => track.readyState === "live"),
    };
  });
  assert.equal(
    state.state,
    "recording",
    "Switching sources must not end MediaRecorder",
  );
  assert.deepEqual(
    state.ids,
    ids,
    "Source changes must preserve the exact encoded output tracks",
  );
  assert.equal(state.live, true, "Both output tracks must stay live");
};

const samplePreview = () =>
  page.locator(".rc-video").evaluate((video) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const drawing = canvas.getContext("2d");
    drawing.drawImage(
      video,
      video.videoWidth * 0.2,
      video.videoHeight * 0.5,
      video.videoWidth * 0.1,
      video.videoHeight * 0.1,
      0,
      0,
      1,
      1,
    );
    return [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
const isScreenBlue = (color) =>
  color.every((value, index) => Math.abs(value - [14, 98, 185][index]) < 20);

const assertMicrophoneRetained = async () => {
  const state = await page.evaluate(() => {
    const mic = window.__mediaTest.cameraStreams.at(-1).getAudioTracks()[0];
    const source = window.__mediaTest.audioSources.find((entry) =>
      entry.ids.includes(mic.id),
    );
    return {
      live: mic.readyState,
      enabled: mic.enabled,
      connected: source?.connected,
    };
  });
  assert.deepEqual(
    state,
    { live: "live", enabled: true, connected: true },
    "Stopping a screen share must retain the microphone connection",
  );
};
const assertDisplayReleased = async () => {
  const state = await page.evaluate(() => {
    const screen = window.__mediaTest.screen;
    const ids = screen.stream.getAudioTracks().map((track) => track.id);
    const sources = window.__mediaTest.audioSources.filter((entry) =>
      entry.ids.some((id) => ids.includes(id)),
    );
    return {
      ended: screen.stream
        .getTracks()
        .every((track) => track.readyState === "ended"),
      disconnected: sources.every((source) => !source.connected),
    };
  });
  assert.deepEqual(
    state,
    { ended: true, disconnected: true },
    "Removed display tracks must stop and their audio source must disconnect",
  );
};

const sampleSavedRecording = (id, moments) =>
  page.evaluate(
    async ({ id, moments }) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("frame-studio");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const blob = await new Promise((resolve, reject) => {
        const request = database
          .transaction("videos")
          .objectStore("videos")
          .get(id);
        request.onsuccess = () => resolve(request.result.blob);
        request.onerror = () => reject(request.error);
      });
      database.close();
      const video = document.createElement("video");
      video.muted = true;
      const url = URL.createObjectURL(blob);
      const waitUntil = (event, condition) =>
        new Promise((resolve, reject) => {
          if (condition()) return resolve();
          const timeout = setTimeout(() => {
            video.removeEventListener(event, changed);
            reject(new Error(`Decoded video timed out waiting for ${event}`));
          }, 10_000);
          const changed = () => {
            if (!condition()) return;
            clearTimeout(timeout);
            video.removeEventListener(event, changed);
            resolve();
          };
          video.addEventListener(event, changed);
        });
      try {
        video.src = url;
        await waitUntil("loadedmetadata", () => video.readyState >= 1);
        if (!Number.isFinite(video.duration)) {
          video.currentTime = Number.MAX_SAFE_INTEGER;
          await waitUntil("durationchange", () =>
            Number.isFinite(video.duration),
          );
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const drawing = canvas.getContext("2d");
        const colors = [];
        for (const moment of moments) {
          video.currentTime = Math.min(moment.time, video.duration - 0.05);
          await waitUntil(
            "seeked",
            () => !video.seeking && video.readyState >= 2,
          );
          drawing.drawImage(
            video,
            video.videoWidth * 0.2,
            video.videoHeight * 0.5,
            video.videoWidth * 0.1,
            video.videoHeight * 0.1,
            0,
            0,
            1,
            1,
          );
          colors.push({
            ...moment,
            color: [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3),
          });
        }
        return {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          colors,
        };
      } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
    },
    { id, moments },
  );

try {
  await page.goto("https://frame.test/");
  await expect(
    page.getByRole("heading", { name: "All projects" }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.__mediaTest.captures),
    0,
    "No permission request on page load",
  );

  // A normal preview can be cancelled without leaving any devices running.
  await cameraSetup();
  assert.equal(
    await page.evaluate(() => window.__mediaTest.captures),
    0,
    "Opening the studio must not request devices",
  );
  await preview();
  assert.equal(
    await page.evaluate(
      () =>
        window.__mediaTest.cameraStreams
          .flatMap((stream) => stream.getTracks())
          .filter((track) => track.readyState === "live").length,
    ),
    2,
  );
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect.poll(allStopped).toBe(true);

  // Late permission resolution after the user leaves must also release devices.
  await cameraSetup();
  await page.evaluate(() => {
    window.__mediaTest.delayInput = true;
  });
  await page.getByRole("button", { name: "Set up preview" }).click();
  await expect
    .poll(() => page.evaluate(() => !!window.__mediaTest.pending))
    .toBe(true);
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await page.evaluate(() => {
    window.__mediaTest.delayInput = false;
    window.__mediaTest.pending();
  });
  await expect.poll(allStopped).toBe(true);

  // Discarding an active recording must stop devices and save no project.
  await cameraSetup();
  await preview();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect(
    page.getByRole("dialog", { name: "Leave this recording?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep working" }).click();
  await expect(
    page.getByRole("button", { name: "Stop recording" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await page.getByRole("button", { name: "Discard and leave" }).click();
  await expect.poll(allStopped).toBe(true);
  assert.equal((await readDatabase()).projects.length, 0);

  // Real browser camera + microphone recording, including paused time exclusion.
  await cameraSetup();
  await preview();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.waitForTimeout(1700);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const pausedTime = await page.locator(".rc-timer").innerText();
  await page.waitForTimeout(1700);
  assert.equal(
    await page.locator(".rc-timer").innerText(),
    pausedTime,
    "Paused time must not increment",
  );
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.waitForTimeout(1300);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await expect.poll(allStopped).toBe(true);
  const captured = await readDatabase();
  assert.equal(captured.projects.length, 1);
  assert.equal(captured.projects[0].mode, "camera");
  assert(
    captured.projects[0].duration >= 2.7 && captured.projects[0].duration < 4.4,
    `Recorded duration ${captured.projects[0].duration} must exclude the pause`,
  );
  assert(
    captured.media[0].size > 1000,
    "Browser should encode a nonempty video",
  );
  assert(
    captured.projects[0].thumbnail.startsWith("data:image/jpeg"),
    "Recorded video should have a real thumbnail",
  );
  await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Camera smoke recording");
  await page
    .getByRole("textbox", { name: "A little context for your video" })
    .fill("A saved recorder smoke test");
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(root, "test-results", "editor.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(root, "test-results", "editor-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const edited = await readDatabase();
  assert.equal(edited.projects[0].name, "Camera smoke recording");
  assert.equal(edited.projects[0].edits.title, "A saved recorder smoke test");
  assert.equal(
    edited.media[0].hash,
    captured.media[0].hash,
    "Editing must preserve the original recording blob",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Camera smoke recording", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "A little context for your video" }),
  ).toHaveValue("A saved recorder smoke test");
  await page
    .getByRole("button", { name: "Save and return to projects" })
    .click();
  console.log(
    "PASS camera: permission timing, preview/cancel, pending permission cleanup, discard, pause/resume, recording, editing, IndexedDB persistence",
  );

  // Explicit SCREEN TEST FIXTURE. Native camera/mic APIs remain untouched.
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (window.__mediaTest.rejectDisplay) {
        window.__mediaTest.rejectDisplay = false;
        throw new DOMException("Test picker cancelled", "NotAllowedError");
      }
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const drawing = canvas.getContext("2d");
      let frame = 0;
      const paint = () => {
        drawing.fillStyle = "rgb(14,98,185)";
        drawing.fillRect(0, 0, 1280, 720);
        drawing.fillStyle = "#fff";
        drawing.fillRect((frame++ * 5) % 900, 30, 40, 40);
      };
      paint();
      const timer = setInterval(paint, 33);
      const screen = canvas.captureStream(30);
      const audio = new AudioContext();
      const destination = audio.createMediaStreamDestination();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      gain.gain.value = 0.05;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await audio.resume();
      const track = screen.getVideoTracks()[0];
      const stream = new MediaStream([
        track,
        ...destination.stream.getAudioTracks(),
      ]);
      window.__mediaTest.tracks.push(...destination.stream.getTracks());
      let cleaned = false;
      const fixture = {
        track,
        audio,
        timer,
        stream,
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          clearInterval(timer);
          oscillator.stop();
          void audio.close();
        },
      };
      window.__mediaTest.screen = fixture;
      window.__mediaTest.screens.push(fixture);
      for (const sourceTrack of stream.getTracks()) {
        const stop = sourceTrack.stop.bind(sourceTrack);
        sourceTrack.stop = () => {
          stop();
          if (stream.getTracks().every((item) => item.readyState === "ended"))
            fixture.cleanup();
        };
      }
      if (window.__mediaTest.delayDisplay) {
        await new Promise((resolve) => {
          window.__mediaTest.pendingDisplay = resolve;
        });
        window.__mediaTest.pendingDisplay = null;
      }
      return stream;
    };
  });
  await page
    .getByRole("button", { name: "New recording", exact: true })
    .click();
  await preview();
  const composite = await page.locator(".rc-video").evaluate((video) => {
    const output = video.srcObject;
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      audio: output.getAudioTracks().map((track) => track.id),
      sourceAudio: [
        ...window.__mediaTest.cameraStreams.flatMap((stream) =>
          stream.getTracks(),
        ),
        ...window.__mediaTest.screen.stream.getTracks(),
      ]
        .filter((track) => track.kind === "audio")
        .map((track) => track.id),
    };
  });
  assert.deepEqual([composite.width, composite.height], [1280, 720]);
  assert.equal(
    composite.audio.length,
    1,
    "Screen and microphone should be mixed to one audio track",
  );
  assert(
    !composite.sourceAudio.includes(composite.audio[0]),
    "Mixed audio should be a new destination track",
  );
  const sample = () =>
    page.locator(".rc-video").evaluate((video) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const drawing = canvas.getContext("2d");
      drawing.drawImage(video, 1050, 570, 160, 90, 0, 0, 1, 1);
      return [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
  await page.waitForTimeout(350);
  const withCamera = await sample();
  await page.getByRole("button", { name: "Turn camera off" }).click();
  await page.waitForTimeout(200);
  const withoutCamera = await sample();
  assert(
    withCamera.some(
      (value, index) => Math.abs(value - withoutCamera[index]) > 30,
    ),
    `Camera toggle must change composite pixels: ${withCamera} / ${withoutCamera}`,
  );
  assert(
    withoutCamera.every(
      (value, index) => Math.abs(value - [14, 98, 185][index]) < 10,
    ),
    `Camera off should reveal the screen fixture: ${withoutCamera}`,
  );
  await page.getByRole("button", { name: "Turn camera on" }).click();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const fixture = window.__mediaTest.screen;
    fixture.track.stop();
    fixture.track.dispatchEvent(new Event("ended"));
    fixture.cleanup();
  });
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeVisible();
  await assertDisplayReleased();
  await assertMicrophoneRetained();
  await page.waitForTimeout(500);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await expect.poll(allStopped).toBe(true);
  const combined = await readDatabase();
  const screenProject = combined.projects.find(
    (project) => project.mode === "screen-camera",
  );
  assert(
    screenProject,
    "The combined recording is saved when the user stops it",
  );
  assert.equal(screenProject.width, 1280);
  assert.equal(screenProject.height, 720);
  assert(
    combined.media.find((media) => media.id === screenProject.id)?.size > 1000,
  );
  console.log(
    "PASS screen fixture: 1280×720 camera composite, live toggle pixels, audio mixing, native share-ended keeps recording, source track cleanup",
  );

  // A single MediaRecorder stays alive while the user attaches and removes screens.
  await page
    .getByRole("button", { name: "Save and return to projects" })
    .click();
  const beforeSwitching = await readDatabase();
  if (
    await page.getByRole("button", { name: "Dismiss notification" }).isVisible()
  )
    await page.getByRole("button", { name: "Dismiss notification" }).click();
  await cameraSetup();
  await preview();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  const stableIds = await page.evaluate(
    () => window.__mediaTest.recorders.at(-1).ids,
  );
  const recorderCount = await page.evaluate(
    () => window.__mediaTest.recorders.length,
  );
  const stableDimensions = await page
    .locator(".rc-video")
    .evaluate((video) => [video.videoWidth, video.videoHeight]);
  assert.equal(
    stableIds.length,
    2,
    "Camera recording starts with a stable video and mixed audio output",
  );
  const moments = [];
  const mark = async (name, screen) => {
    await page.waitForTimeout(700);
    const time = await page.evaluate(
      () =>
        (performance.now() - window.__mediaTest.recorders.at(-1).startedAt) /
          1000 -
        0.3,
    );
    moments.push({ name, screen, time });
    await assertRecordingStable(stableIds);
    assert.equal(
      await page.evaluate(() => window.__mediaTest.recorders.length),
      recorderCount,
      "Source transitions keep the same MediaRecorder instance",
    );
    assert.equal(
      await page
        .locator(".rc-video")
        .evaluate((video) => video.classList.contains("rc-mirrored")),
      !screen,
      "Camera preview is mirrored; shared screen remains readable",
    );
    assert.equal(
      isScreenBlue(await samplePreview()),
      screen,
      `${name}: preview must show the current source`,
    );
  };
  await mark("camera before sharing", false);

  // Cancelling the picker does not interrupt the recording or touch the microphone.
  await page.evaluate(() => {
    window.__mediaTest.rejectDisplay = true;
  });
  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeEnabled();
  await assertRecordingStable(stableIds);
  await assertMicrophoneRetained();
  if (await page.getByRole("button", { name: "Dismiss error" }).isVisible())
    await page.getByRole("button", { name: "Dismiss error" }).click();

  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toBeEnabled();
  await mark("first screen", true);
  await page.screenshot({
    path: path.join(root, "test-results", "live-sharing.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Live sharing controls must fit a 390px mobile viewport",
  );
  await page.screenshot({
    path: path.join(root, "test-results", "mobile-live-sharing.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeEnabled();
  await assertDisplayReleased();
  await assertMicrophoneRetained();
  await mark("camera after stopping share", false);

  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toBeEnabled();
  await mark("second screen", true);
  await page.evaluate(() => {
    const screen = window.__mediaTest.screen;
    screen.track.stop();
    screen.track.dispatchEvent(new Event("ended"));
  });
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeEnabled();
  await assertDisplayReleased();
  await assertMicrophoneRetained();
  await mark("camera after native share ended", false);
  assert.equal(
    (await readDatabase()).projects.length,
    beforeSwitching.projects.length,
    "Source switching must not create separate saved projects",
  );

  // A picker can resolve after Stop recording; its returned tracks must be stopped.
  await page.evaluate(() => {
    window.__mediaTest.delayDisplay = true;
  });
  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => !!window.__mediaTest.pendingDisplay))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Choosing screen…", exact: true }),
  ).toBeDisabled();
  await assertRecordingStable(stableIds);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await page.evaluate(() => {
    window.__mediaTest.delayDisplay = false;
    window.__mediaTest.pendingDisplay();
  });
  await expect.poll(allStopped).toBe(true);
  await assertDisplayReleased();
  const switched = await readDatabase();
  assert.equal(
    switched.projects.length,
    beforeSwitching.projects.length + 1,
    "The entire switching session must save as one project",
  );
  const switchedProject = switched.projects.find(
    (project) =>
      !beforeSwitching.projects.some((previous) => previous.id === project.id),
  );
  assert(
    switchedProject.duration > moments.at(-1).time + 0.2,
    "Saved duration must include the final camera segment",
  );
  const decoded = await sampleSavedRecording(switchedProject.id, moments);
  assert.deepEqual(
    [decoded.width, decoded.height],
    stableDimensions,
    "Encoded dimensions remain fixed as screen sources switch",
  );
  assert(
    Math.abs(decoded.duration - switchedProject.duration) < 0.5,
    `Decoded duration ${decoded.duration} matches the complete session ${switchedProject.duration}`,
  );
  for (const sample of decoded.colors)
    assert.equal(
      isScreenBlue(sample.color),
      sample.screen,
      `Saved output preserves ${sample.name}: ${sample.color}`,
    );
  console.log(
    "PASS dynamic sharing: camera→screen→camera→screen→camera in one playable video; stable output IDs; mic retained; screen audio disconnected; cancelled picker harmless; late picker cleaned after Stop recording",
  );

  // Screen-only recording has no camera to fall back to, but remains recordable.
  await page
    .getByRole("button", { name: "Save and return to projects" })
    .click();
  await page.getByRole("button", { name: /Show, don’t tell/ }).click();
  await preview();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  const screenOnlyIds = await page.evaluate(
    () => window.__mediaTest.recorders.at(-1).ids,
  );
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const screen = window.__mediaTest.screen;
    screen.track.stop();
    screen.track.dispatchEvent(new Event("ended"));
  });
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeEnabled();
  await page.waitForTimeout(200);
  await assertRecordingStable(screenOnlyIds);
  assert(
    (await samplePreview()).every((value) => value < 35),
    "Screen-only capture falls back to a dark canvas when sharing ends",
  );
  await assertDisplayReleased();
  await assertMicrophoneRetained();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await page.getByRole("button", { name: "Discard and leave" }).click();
  await expect.poll(allStopped).toBe(true);
  console.log(
    "PASS screen-only: native share ending keeps stable recording and dark fallback; discarding releases all tracks",
  );

  // Meter readings come from the microphone signal, never the mixed screen audio.
  await page.evaluate(() => {
    window.__mediaTest.mockMicrophone = true;
  });
  await cameraSetup();
  const meter = page.getByRole("meter", {
    name: "Microphone input level",
    exact: true,
  });
  const meterValue = async () =>
    Number(await meter.getAttribute("aria-valuenow"));
  const microphoneGain = async (value) =>
    page.evaluate((value) => {
      const fixture = window.__mediaTest.microphoneFixture;
      fixture.gain.gain.setValueAtTime(value, fixture.audio.currentTime);
    }, value);
  await expect(meter).toBeVisible();
  await expect(meter).toHaveAttribute("aria-valuemin", "0");
  await expect(meter).toHaveAttribute("aria-valuemax", "100");
  await expect(meter).toHaveAttribute("aria-valuenow", "0");
  await preview();
  await expect.poll(meterValue).toBeGreaterThan(0);
  const quietMeter = await meterValue();
  await microphoneGain(0.2);
  await expect.poll(meterValue).toBeGreaterThan(quietMeter + 10);
  const loudMeter = await meterValue();
  assert(loudMeter <= 100, "The meter exposes a bounded percentage");
  await microphoneGain(0.999);
  await expect(page.getByText("Too loud", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Turn microphone off", exact: true })
    .click();
  await expect.poll(meterValue).toBe(0);
  await expect(page.getByText("Too loud", { exact: true })).toHaveCount(0, {
    timeout: 500,
  });
  await microphoneGain(0.2);
  await page
    .getByRole("button", { name: "Turn microphone on", exact: true })
    .click();
  await expect.poll(meterValue).toBeGreaterThan(quietMeter + 10);

  await microphoneGain(0);
  await expect.poll(meterValue).toBe(0);
  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toBeEnabled();
  await assertMicrophoneRetained();
  const screenAudioActive = await page.evaluate(() => {
    const audioIds = window.__mediaTest.screen.stream
      .getAudioTracks()
      .map((track) => track.id);
    return window.__mediaTest.audioSources.some(
      (source) =>
        source.connected && source.ids.some((id) => audioIds.includes(id)),
    );
  });
  assert(
    screenAudioActive,
    "A real display tone is connected while the enabled microphone fixture is silent",
  );
  await page.waitForTimeout(350);
  await expect.poll(meterValue).toBe(0);
  await microphoneGain(0.08);
  await expect.poll(meterValue).toBeGreaterThan(quietMeter + 5);
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await assertDisplayReleased();
  await page
    .getByRole("button", { name: "Change source", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Set up preview", exact: true }),
  ).toBeVisible();
  await expect.poll(meterValue).toBe(0);
  await expect.poll(allStopped).toBe(true);

  await preview();
  await microphoneGain(0.08);
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await expect.poll(meterValue).toBeGreaterThan(quietMeter + 5);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(meter).toBeVisible();
  await microphoneGain(0);
  await expect.poll(meterValue).toBe(0);
  await microphoneGain(0.12);
  await expect.poll(meterValue).toBeGreaterThan(quietMeter + 5);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(meterValue).toBeGreaterThan(quietMeter + 5);
  assert.equal(
    await page.locator(".rc-video").evaluate((video) => video.muted),
    true,
    "The preview must remain muted while metering",
  );
  assert.equal(
    await page.evaluate(() => window.__mediaTest.speakerConnections),
    0,
    "Measuring microphone input must not route audio to speakers",
  );
  await page.screenshot({
    path: path.join(root, "test-results", "mic-meter.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(meter).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "The live meter fits the mobile viewport",
  );
  await page.screenshot({
    path: path.join(root, "test-results", "mic-meter-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Back to workspace", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard and leave", exact: true })
    .click();
  await expect.poll(allStopped).toBe(true);
  await page.evaluate(() => {
    window.__mediaTest.mockMicrophone = false;
  });
  console.log(
    `PASS microphone meter: actual quiet/loud signal (${quietMeter}→${loudMeter}), clipping warning cleared on mute, silence isolated from screen tone, mute/unmute, idle reset, recording/paused response, mobile fit, no speaker monitoring or leaked tracks`,
  );

  // Responsive icon-only controls retain their accessible names.
  await page.setViewportSize({ width: 390, height: 844 });
  await cameraSetup();
  await expect(
    page.getByRole("button", { name: "Back to workspace" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Turn microphone off" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Turn camera off" }),
  ).toBeVisible();
  await preview();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Share screen", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Share screen", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop sharing", exact: true }),
  ).toBeEnabled();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Paused mobile sharing controls must fit the viewport",
  );
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await assertDisplayReleased();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await page.getByRole("button", { name: "Discard and leave" }).click();
  await expect.poll(allStopped).toBe(true);
  console.log(
    "PASS mobile: 390px back, microphone, camera, screen sharing, pause/resume controls retain accessible names and fit without overflow",
  );
  assert.deepEqual(errors, [], "No browser console/page errors");
  console.log(
    JSON.stringify(
      {
        cameraDuration: captured.projects[0].duration,
        cameraBytes: captured.media[0].size,
        screenDuration: screenProject.duration,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
