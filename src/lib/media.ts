import type { Project, RecordingResult } from "../types";

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
    : `${minutes}:${remainder}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  );
  return `${Number((bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1))} ${units[index]}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Give the browser time to start reading the URL before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function createProject(
  result: RecordingResult,
  name: string,
  folderId: string | null,
): Project {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: name.trim() || "Untitled recording",
    folderId,
    createdAt: now,
    updatedAt: now,
    duration: result.duration,
    thumbnail: result.thumbnail,
    mimeType: result.blob.type || "video/webm",
    size: result.blob.size,
    width: result.width,
    height: result.height,
    mode: result.mode,
    favorite: false,
    edits: {
      clips: [{ id: crypto.randomUUID(), start: 0, end: result.duration }],
      muted: false,
      volume: 1,
      title: "",
      aspectRatio: "original",
    },
  };
}

export async function readVideoMetadata(blob: Blob): Promise<{
  duration: number;
  thumbnail: string;
  width: number;
  height: number;
}> {
  if (!blob.size)
    throw new Error("This video file is empty. Please choose another file.");
  if (blob.type && !blob.type.toLowerCase().startsWith("video/")) {
    throw new Error("Please choose a video file, such as an MP4 or WebM.");
  }

  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  return new Promise((resolve, reject) => {
    let duration = 0;
    let targetTime = 0;
    let findingEnd = false;
    let settled = false;
    const events = [
      "loadedmetadata",
      "durationchange",
      "loadeddata",
      "canplay",
      "seeked",
      "timeupdate",
    ] as const;
    const cleanup = () => {
      window.clearTimeout(timeout);
      for (const event of events) video.removeEventListener(event, inspect);
      video.removeEventListener("error", fail);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const fail = () =>
      rejectOnce(
        new Error(
          "This video could not be opened. It may be damaged or use an unsupported codec. Try an MP4 with H.264 video or a WebM file.",
        ),
      );
    const inspect = () => {
      if (settled || video.readyState < 1) return;
      try {
        if (!duration) {
          if (Number.isFinite(video.duration) && video.duration > 0) {
            duration = video.duration;
            if (!video.videoWidth || !video.videoHeight) {
              fail();
              return;
            }
            targetTime = Math.min(0.2, duration / 2);
            video.currentTime = targetTime;
            return;
          }
          // Browser MediaRecorder WebM files often lack a duration header. Seeking
          // beyond the end makes the browser scan the final timestamp.
          if (!findingEnd) {
            findingEnd = true;
            video.currentTime = Number.MAX_SAFE_INTEGER;
          }
          return;
        }
        if (
          video.seeking ||
          video.readyState < 2 ||
          Math.abs(video.currentTime - targetTime) > 0.1
        )
          return;
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error(
            "Your browser could not generate a video preview. Please try again.",
          );
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const metadata = {
          duration,
          thumbnail: canvas.toDataURL("image/jpeg", 0.8),
          width: video.videoWidth,
          height: video.videoHeight,
        };
        settled = true;
        cleanup();
        resolve(metadata);
      } catch (error) {
        rejectOnce(
          error instanceof Error
            ? error
            : new Error("This video could not be read."),
        );
      }
    };
    const timeout = window.setTimeout(() => {
      rejectOnce(
        new Error(
          "This video took too long to read. Try a smaller file or re-export it as an MP4 with H.264 video or WebM.",
        ),
      );
    }, 15_000);
    for (const event of events) video.addEventListener(event, inspect);
    video.addEventListener("error", fail);
    video.src = url;
    video.load();
  });
}
