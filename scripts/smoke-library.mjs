import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Run `npm run build`, then `node scripts/smoke-library.mjs`.
// The production build is served through Playwright routing; no server is started.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const output = resolve(root, "test-results");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.route("https://frame.test/**", async (route) => {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const file = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(dist + sep))
    return route.fulfill({ status: 403, body: "Forbidden" });
  try {
    await route.fulfill({
      contentType: types[extname(file)] ?? "application/octet-stream",
      body: await readFile(file),
    });
  } catch {
    await route.fulfill({ status: 404, body: "Not found" });
  }
});
// Keep the run reproducible offline. The UI's local font fallback is used.
await page.route("https://fonts.googleapis.com/**", (route) =>
  route.fulfill({ contentType: "text/css", body: "" }),
);

async function dismissNotification() {
  const dismiss = page.getByRole("button", { name: "Dismiss notification" });
  if (await dismiss.isVisible()) await dismiss.click();
}

async function projectMenu(name) {
  await page
    .getByRole("button", { name: `Options for ${name}`, exact: true })
    .click();
}

try {
  await page.goto("https://frame.test/");
  await expect(
    page.getByRole("heading", { name: "All projects", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your first take starts here" }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);

  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Folder name", { exact: true }).fill("Tutorials");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Project folders" })
      .getByRole("button", { name: "Tutorials 0" }),
  ).toBeVisible();
  await dismissNotification();

  const fixtureBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const drawing = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    const mimeType = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    let frame = 0;
    const draw = () => {
      const gradient = drawing.createLinearGradient(0, 0, 960, 540);
      gradient.addColorStop(0, "#1b2834");
      gradient.addColorStop(1, "#395f62");
      drawing.fillStyle = gradient;
      drawing.fillRect(0, 0, 960, 540);
      drawing.strokeStyle = "#7baba4";
      drawing.lineWidth = 2;
      drawing.beginPath();
      drawing.arc(815, 110, 185 + Math.sin(frame / 7) * 7, 0, Math.PI * 2);
      drawing.stroke();
      drawing.beginPath();
      drawing.arc(815, 110, 140, 0, Math.PI * 2);
      drawing.stroke();
      drawing.fillStyle = "#a6d9c3";
      drawing.font = "18px sans-serif";
      drawing.fillText(
        "A LITTLE LESS EXPLAINING. A LITTLE MORE SHOWING.",
        72,
        125,
      );
      drawing.fillStyle = "#f4f6ef";
      drawing.font = "bold 62px sans-serif";
      drawing.fillText("Project", 68, 240);
      drawing.fillText("walkthrough", 68, 317);
      drawing.fillStyle = "#b9c9c4";
      drawing.font = "21px sans-serif";
      drawing.fillText("A quick look at what comes next.", 72, 381);
      drawing.font = "16px sans-serif";
      drawing.fillText(
        `FRAME STUDIO                                      TAKE 01 · ${frame++}`,
        72,
        475,
      );
    };
    recorder.start(100);
    draw();
    const interval = setInterval(draw, 50);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    recorder.stop();
    clearInterval(interval);
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(
      new Uint8Array(
        await new Blob(chunks, { type: "video/webm" }).arrayBuffer(),
      ),
    );
  });
  await page
    .getByLabel("Import video files", { exact: true })
    .setInputFiles({
      name: "Studio demo.webm",
      mimeType: "video/webm",
      buffer: Buffer.from(fixtureBytes),
    });
  await expect(
    page.getByRole("button", { name: "Save and return to projects" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("textbox", { name: "Project name", exact: true }),
  ).toHaveValue("Studio demo");
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  await page
    .getByRole("button", { name: "Save and return to projects" })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Studio demo", exact: true }),
  ).toBeVisible();
  await dismissNotification();

  await projectMenu("Studio demo");
  await page
    .getByRole("button", { name: "Rename or move", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Project name", { exact: true })
    .fill("Product walkthrough");
  await page
    .getByRole("dialog")
    .getByRole("combobox")
    .selectOption({ label: "Tutorials" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Edit Product walkthrough", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-meta")).toContainText("Tutorials");
  await dismissNotification();
  await projectMenu("Product walkthrough");
  await page
    .getByRole("button", { name: "Add to favorites", exact: true })
    .click();
  await expect(page.locator(".favorite-star")).toHaveCount(1);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: /^Favorites/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Favorites", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(1);

  await page
    .getByRole("textbox", { name: "Search projects", exact: true })
    .fill("walkthrough");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Search projects", exact: true })
    .fill("something else");
  await expect(
    page.getByRole("heading", { name: "No projects found" }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "List view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".projects-list .project-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Grid view", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".projects-grid .project-card")).toHaveCount(1);

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Edit Product walkthrough", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".favorite-star")).toHaveCount(1);
  await expect(page.locator(".project-meta")).toContainText("Tutorials");
  await expect(
    page
      .getByRole("navigation", { name: "Project folders" })
      .getByRole("button", { name: "Tutorials 1" }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(output, "library.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import video", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Workspace settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Options for Product walkthrough",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Grid view", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "List view", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve(output, "library-mobile.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("navigation", { name: "Project folders" })
    .getByRole("button", { name: "Tutorials 1" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tutorials", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Delete this folder", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete folder", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "All projects", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Project folders" })
      .getByRole("button", { name: /^Tutorials/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit Product walkthrough", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".project-meta")).not.toContainText("Tutorials");
  await page
    .getByRole("button", { name: "Edit Product walkthrough", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export video", exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  await page
    .getByRole("button", { name: "Save and return to projects" })
    .click();
  await dismissNotification();

  await projectMenu("Product walkthrough");
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(page.locator(".project-card")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Your first take starts here" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your first take starts here" }),
  ).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);
  const counts = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("frame-studio");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readCounts = await Promise.all(
      ["projects", "videos", "folders"].map(
        (store) =>
          new Promise((resolve, reject) => {
            const request = database
              .transaction(store)
              .objectStore(store)
              .count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    database.close();
    return readCounts;
  });
  expect(counts).toEqual([0, 0, 0]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log(
    "PASS library: empty state, folders, real WebM import, editor, rename/move, favorites, search, layouts, reload persistence, mobile navigation, preservation on folder deletion, permanent project deletion.",
  );
  console.log(
    `Screenshots: ${resolve(output, "library.png")} and ${resolve(output, "library-mobile.png")}`,
  );
} catch (error) {
  console.error("Browser errors:", errors);
  await page
    .screenshot({
      path: resolve(output, "library-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
