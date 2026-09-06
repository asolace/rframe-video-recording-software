/** Build first. Uses Playwright file routes and real video encoding; no server. */
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const dist = resolve("dist");
const output = resolve("test-results");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
await page.route("https://frame.test/**", async (route) => {
  const url = new URL(route.request().url());
  const file = resolve(
    dist,
    `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  assert(file.startsWith(dist + sep));
  try {
    await route.fulfill({
      contentType: mime[extname(file)] || "application/octet-stream",
      body: await readFile(file),
    });
  } catch {
    await route.fulfill({ status: 404, body: "Not found" });
  }
});
try {
  await page.goto("https://frame.test/");
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 320, 180);
    recorder.start();
    const began = performance.now();
    let frame;
    const draw = () => {
      const time = (performance.now() - began) / 1000;
      ctx.fillStyle = time < 0.8 ? "red" : time < 1.6 ? "lime" : "blue";
      ctx.fillRect(0, 0, 320, 180);
      frame = requestAnimationFrame(draw);
    };
    draw();
    await new Promise((resolve) => setTimeout(resolve, 2450));
    recorder.stop();
    await stopped;
    cancelAnimationFrame(frame);
    stream.getTracks().forEach((track) => track.stop());
    return [
      ...new Uint8Array(
        await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer(),
      ),
    ];
  });
  await page.getByLabel("Import video files", { exact: true }).setInputFiles({
    name: "Section test.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(bytes),
  });
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "9:16", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Crop this clip", exact: true }),
  ).toHaveCount(0);
  const sourceDuration = await page
    .locator(".ed-source-video")
    .evaluate((video) => video.duration);
  await page
    .getByRole("button", { name: "Select section", exact: true })
    .click();
  const initialStart = Number(
    await page.getByLabel("Section start in seconds").inputValue(),
  );
  await page.getByLabel("Selection start handle").focus();
  await page.keyboard.press("ArrowRight");
  assert(
    Number(await page.getByLabel("Section start in seconds").inputValue()) >
      initialStart,
  );
  await expect(
    page.getByRole("button", { name: "Save edits", exact: true }),
  ).toBeDisabled();
  const endBeforeDrag = Number(
    await page.getByLabel("Section end in seconds").inputValue(),
  );
  const endHandle = await page.getByLabel("Selection end handle").boundingBox();
  const handleMax = Number(
    await page.getByLabel("Selection end handle").getAttribute("max"),
  );
  const endX =
    endHandle.x + 6 + (endBeforeDrag / handleMax) * (endHandle.width - 12);
  await page.mouse.move(endX, endHandle.y + endHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(endX - 50, endHandle.y + endHandle.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  assert(
    Number(await page.getByLabel("Section end in seconds").inputValue()) <
      endBeforeDrag,
    "Selection handle responds to pointer dragging",
  );
  await page.getByLabel("Section start in seconds").fill("0.8");
  await page.getByLabel("Section end in seconds").fill("1.6");
  await page.screenshot({
    path: resolve(output, "section-selection.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(output, "section-selection-mobile.png"),
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Section controls fit mobile",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: /Delete selected section/ }).click();
  await expect(page.locator(".ed-clip")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.locator(".ed-clip")).toHaveCount(1);
  await page.getByRole("button", { name: "Redo edit", exact: true }).click();
  await expect(page.locator(".ed-clip")).toHaveCount(2);
  await page.getByRole("button", { name: "Save edits", exact: true }).click();
  const saved = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("frame-studio");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const project = await new Promise((resolve) => {
      const request = db
        .transaction("projects")
        .objectStore("projects")
        .getAll();
      request.onsuccess = () => resolve(request.result[0]);
    });
    db.close();
    return project;
  });
  assert.equal(saved.edits.clips[0].end, 0.8);
  assert.equal(saved.edits.clips[1].start, 1.6);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const download = await downloadEvent;
  const encoded = await readFile(await download.path());
  const decoded = await page.evaluate(
    async (bytes) => {
      const video = document.createElement("video");
      video.muted = true;
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: "video/webm" }),
      );
      const once = (event) =>
        new Promise((resolve) =>
          video.addEventListener(event, resolve, { once: true }),
        );
      let loaded = once("loadeddata");
      video.src = url;
      await loaded;
      if (!Number.isFinite(video.duration)) {
        const sought = once("seeked");
        video.currentTime = 1e100;
        await sought;
      }
      const duration = video.duration;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      const colors = [];
      for (const time of [0.3, 1.05]) {
        const sought = once("seeked");
        video.currentTime = time;
        await sought;
        ctx.drawImage(video, 0, 0);
        colors.push([...ctx.getImageData(160, 90, 1, 1).data]);
      }
      const size = [video.videoWidth, video.videoHeight];
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      return { duration, colors, size };
    },
    [...encoded],
  );
  assert.deepEqual(decoded.size, [320, 180]);
  assert(
    decoded.colors[0][0] > 180 && decoded.colors[0][1] < 60,
    "Export retains red before deleted section",
  );
  assert(
    decoded.colors[1][2] > 180 && decoded.colors[1][1] < 60,
    "Export jumps to blue after deleted green section",
  );
  if (Number.isFinite(sourceDuration))
    assert(
      Math.abs(decoded.duration - (sourceDuration - 0.8)) < 0.18,
      "Export duration reflects removed interval",
    );
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Section test", exact: true })
    .click();
  await expect(page.locator(".ed-clip")).toHaveCount(2);
  await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS sections: locked canvas, numeric/keyboard selection, unchanged edits until apply, delete middle, undo/redo, saved ranges, real exported red→blue frames/duration, reload, mobile layout.",
  );
} catch (error) {
  await page
    .screenshot({
      path: resolve(output, "section-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
