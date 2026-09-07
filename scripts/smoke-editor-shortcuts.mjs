/** Build first. Real browser media + routed dist; never starts a dev server. */
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const dist = resolve("dist");
const output = resolve("test-results");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const focusFailures = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
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

const workspace = page.locator(".ed-workspace");
const clips = page.locator(".ed-clip");
const video = page.locator(".ed-source-video");
const playhead = page.getByLabel("Timeline playhead", { exact: true });
async function key(value) {
  await workspace.focus();
  await page.keyboard.press(value);
}
async function checkFocus(locator, reason) {
  await expect(locator)
    .toBeFocused()
    .catch(() => focusFailures.push(reason));
}
async function sourceAt(expected, tolerance = 0.025) {
  await expect
    .poll(async () =>
      Math.abs(
        (await video.evaluate((element) => element.currentTime)) - expected,
      ),
    )
    .toBeLessThan(tolerance);
}
async function timelineAt(expected, tolerance = 0.025) {
  await expect
    .poll(async () => Math.abs(Number(await playhead.inputValue()) - expected))
    .toBeLessThan(tolerance);
}
async function goTo(time) {
  await key("Home");
  for (let whole = 0; whole < Math.floor(time); whole++)
    await key("Shift+ArrowRight");
  for (let tenth = 0; tenth < Math.round((time % 1) * 10); tenth++)
    await key("ArrowRight");
  await timelineAt(time);
}
async function readSaved() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise((resolve, reject) => {
      const transaction = db.transaction(["projects", "videos"]);
      const project = transaction.objectStore("projects").getAll();
      const media = transaction.objectStore("videos").getAll();
      transaction.oncomplete = () =>
        resolve({
          project: project.result[0],
          mediaCount: media.result.length,
          mediaSize: media.result[0]?.blob?.size,
        });
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return result;
  });
}
async function zoomGeometry(level, firstDuration, secondDuration) {
  await expect(page.getByLabel("Timeline zoom", { exact: true })).toHaveValue(
    String(level),
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const viewport = document.querySelector(".tt-scroll");
        const content = document.querySelector(".tt-content");
        return content.clientWidth / viewport.clientWidth;
      }),
    )
    .toBeCloseTo(level, 2);
  const widths = await clips.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  assert(
    Math.abs(widths[0] / widths[1] - firstDuration / secondDuration) < 0.01,
    "Zoom keeps clip widths proportional to their actual edited durations",
  );
}

try {
  await page.goto("https://frame.test/");
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks = [];
    recorder.ondataavailable = ({ data }) => {
      if (data.size) chunks.push(data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    let frame;
    const began = performance.now();
    const draw = () => {
      const time = (performance.now() - began) / 1000;
      context.fillStyle = `hsl(${time * 75} 65% 35%)`;
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = "white";
      context.font = "24px sans-serif";
      context.fillText(time.toFixed(1), 30, 100);
      frame = requestAnimationFrame(draw);
    };
    draw();
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 4450));
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
  await page
    .getByLabel("Import video files", { exact: true })
    .setInputFiles({
      name: "Shortcut test.webm",
      mimeType: "video/webm",
      buffer: Buffer.from(bytes),
    });
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled();
  await expect(workspace).toHaveAttribute("tabindex", "-1");
  const duration = await video.evaluate((element) => element.duration);
  assert(
    duration > 4 && duration < 5.5,
    "Real fixture has enough duration for edited-timeline seeking",
  );

  await key("Space");
  await expect
    .poll(() => video.evaluate((element) => element.paused))
    .toBe(false);
  await key("Space");
  await expect
    .poll(() => video.evaluate((element) => element.paused))
    .toBe(true);
  await goTo(0);

  // These keys must edit their focused fields, never trigger workspace actions.
  const name = page.getByLabel("Project name", { exact: true });
  await name.fill("");
  await name.pressSequentially("Shortcut s i o ?");
  await name.press("Backspace");
  await expect(name).toHaveValue("Shortcut s i o ");
  await name.fill("Shortcut regression saved");
  const title = page.locator("#ed-title");
  await title.fill("");
  await title.pressSequentially("s i o ?");
  await title.press("Backspace");
  await title.press("Enter");
  await title.pressSequentially("Safe typing");
  await expect(title).toHaveValue("s i o \nSafe typing");
  await expect(clips).toHaveCount(1);
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => video.evaluate((element) => element.paused))
    .toBe(true);
  await page.locator("#ed-volume").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#ed-volume")).toHaveValue("0.99");
  await sourceAt(0);
  // A native button receives one Space activation without also playing video.
  await page
    .getByRole("button", { name: "Select section", exact: true })
    .focus();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Section start in seconds")).toBeVisible();
  await expect
    .poll(() => video.evaluate((element) => element.paused))
    .toBe(true);
  await page
    .getByRole("button", { name: "Close section selection", exact: true })
    .click();
  await playhead.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await timelineAt(0.01, 0.003);
  await sourceAt(0.01, 0.003);
  await page.keyboard.press("Space");
  await expect
    .poll(() => video.evaluate((element) => element.paused))
    .toBe(true);
  await page.getByLabel("Timeline zoom", { exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("Timeline zoom", { exact: true })).toHaveValue(
    "2",
  );
  await sourceAt(0.01, 0.003);
  await page
    .getByRole("button", { name: "Fit timeline to view", exact: true })
    .click();

  await key("?");
  const dialog = page.getByRole("dialog", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  assert(
    await dialog.evaluate(
      (element) => element.tagName === "DIALOG" && element.open,
    ),
    "Shortcut help uses the native modal dialog",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await checkFocus(workspace, "Escape after ? returns focus to the workspace");
  const help = page.getByRole("button", {
    name: "Keyboard shortcuts",
    exact: true,
  });
  await help.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await checkFocus(help, "Escape returns focus to the shortcut help button");

  await goTo(1);
  await key("s");
  await expect(clips).toHaveCount(2);
  await key("Control+z");
  await expect(clips).toHaveCount(1);
  await key("Control+Shift+z");
  await expect(clips).toHaveCount(2);
  await key("Meta+z");
  await expect(clips).toHaveCount(1);
  await key("Meta+Shift+z");
  await expect(clips).toHaveCount(2);
  await key("Control+z");
  await expect(clips).toHaveCount(1);
  await key("Control+y");
  await expect(clips).toHaveCount(2);
  await clips.first().click();
  await page.keyboard.press("Delete");
  await expect(clips).toHaveCount(1);
  await expect(workspace).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect(clips).toHaveCount(2);
  await clips.nth(1).click();
  await key("Backspace");
  await expect(clips).toHaveCount(1);
  await key("Control+z");
  await expect(clips).toHaveCount(2);
  await key("Control+z");
  await expect(clips).toHaveCount(1);

  await goTo(0.8);
  await key("i");
  await expect(page.getByLabel("Section start in seconds")).toHaveValue("0.8");
  await goTo(1.6);
  await key("o");
  await expect(page.getByLabel("Section end in seconds")).toHaveValue("1.6");
  await key("Delete");
  await expect(clips).toHaveCount(2);
  await key("Control+z");
  await expect(clips).toHaveCount(1);
  await key("Control+y");
  await expect(clips).toHaveCount(2);
  if (
    await page
      .getByRole("button", { name: "Close section selection", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Close section selection", exact: true })
      .click();
  await goTo(0.7);
  await key("ArrowRight");
  await timelineAt(0.8);
  await sourceAt(1.6);
  await key("ArrowRight");
  await timelineAt(0.9);
  await sourceAt(1.7);
  await key("ArrowLeft");
  await key("ArrowLeft");
  await sourceAt(0.7);
  await key("Shift+ArrowRight");
  await timelineAt(1.7);
  await sourceAt(2.5);
  await key("Shift+ArrowLeft");
  await timelineAt(0.7);
  await sourceAt(0.7);
  await key("End");
  await timelineAt(duration - 0.8);
  await sourceAt(duration);
  await key("Home");
  await sourceAt(0);

  // Imported alignment is explicitly a test fixture, not an inference substitute.
  await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await page
    .getByLabel("Import transcript JSON", { exact: true })
    .setInputFiles({
      name: "shortcut-fixture.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          language: "en",
          model: "keyboard-regression-fixture",
          createdAt: 1,
          words: [
            { id: "word-a", text: "Keyboard", start: 2, end: 2.3 },
            { id: "word-b", text: "safety", start: 2.5, end: 2.8 },
          ],
        }),
      ),
    });
  const word = page.getByRole("button", { name: /^Keyboard, clip/ });
  await expect(word).toBeVisible();
  await word.click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Delete");
  await expect(clips).toHaveCount(2);
  await word.click();
  await page.keyboard.press("Backspace");
  await expect(clips).toHaveCount(3);
  await timelineAt(1.2);
  await expect(
    page.getByRole("button", { name: /^safety, clip/ }),
  ).toBeVisible();
  await key("Control+z");
  await expect(clips).toHaveCount(2);
  await page.locator("#ed-video-tab").click();

  await page
    .getByRole("button", { name: "Zoom in timeline", exact: true })
    .click();
  await zoomGeometry(2, 0.8, duration - 1.6);
  const scrollArea = page.getByRole("region", {
    name: "Scrollable video timeline",
    exact: true,
  });
  await scrollArea.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const sourceBeforePan = await video.evaluate(
    (element) => element.currentTime,
  );
  await scrollArea.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => scrollArea.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await sourceAt(sourceBeforePan, 0.003);
  await page
    .getByRole("button", { name: "Zoom in timeline", exact: true })
    .click();
  await zoomGeometry(4, 0.8, duration - 1.6);
  await page
    .getByRole("button", { name: "Zoom out timeline", exact: true })
    .click();
  await zoomGeometry(2, 0.8, duration - 1.6);
  await page
    .getByRole("button", { name: "Fit timeline to view", exact: true })
    .click();
  await zoomGeometry(1, 0.8, duration - 1.6);
  assert(
    await page
      .locator(".tt-scroll")
      .evaluate((element) => element.scrollWidth === element.clientWidth),
    "Fit removes timeline horizontal overflow",
  );
  await key("Control+s");
  await expect(
    page.getByRole("button", { name: "Save edits", exact: true }),
  ).toBeDisabled();
  const saved = await readSaved();
  assert.equal(saved.project.name, "Shortcut regression saved");
  assert.equal(saved.project.edits.clips.length, 2);
  assert(Math.abs(saved.project.edits.clips[0].end - 0.8) < 0.001);
  assert(Math.abs(saved.project.edits.clips[1].start - 1.6) < 0.001);
  assert.equal(saved.project.edits.title, "s i o \nSafe typing");
  assert.equal(saved.mediaCount, 1);
  assert.equal(
    saved.mediaSize,
    bytes.length,
    "Keyboard edits preserve the separately stored source blob",
  );

  await page.screenshot({
    path: resolve(output, "editor-shortcuts-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Timeline zoom", { exact: true }).selectOption("8");
  await zoomGeometry(8, 0.8, duration - 1.6);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Zoomed timeline scrolls internally without mobile page overflow",
  );
  await help.click();
  await expect(dialog).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Shortcut dialog fits mobile",
  );
  await page.screenshot({
    path: resolve(output, "editor-shortcuts-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await checkFocus(help, "Mobile dialog returns focus to shortcut help button");
  await page.reload();
  await page
    .getByRole("button", {
      name: "Edit Shortcut regression saved",
      exact: true,
    })
    .click();
  await expect(clips).toHaveCount(2);
  await expect(title).toHaveValue("s i o \nSafe typing");
  assert.deepEqual(errors, []);
  assert.deepEqual(focusFailures, []);
  await writeFile(
    resolve(output, "editor-shortcuts.json"),
    JSON.stringify({ sourceDuration: duration, saved, errors }, null, 2),
  );
  console.log(
    "PASS shortcuts: playback, split, I/O section marks, Delete/Backspace, Ctrl/Meta undo/redo, edited-timeline seeking, native field/button/range/select behavior, transcript isolation, save/reload/source preservation, native help dialog/focus, proportional zoom, mobile overflow.",
  );
} catch (error) {
  await page
    .screenshot({
      path: resolve(output, "editor-shortcuts-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
