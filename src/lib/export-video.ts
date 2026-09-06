import type { CropRect, EditState } from "../types";
import { cropSourceRect } from "./crop";
import { timelineDuration } from "./timeline";

export function outputDimensions(
  width: number,
  height: number,
  aspect: EditState["aspectRatio"],
) {
  const originalWidth = width || 1920;
  const originalHeight = height || 1080;
  const ratio =
    aspect === "original"
      ? originalWidth / originalHeight
      : aspect === "16:9"
        ? 16 / 9
        : aspect === "9:16"
          ? 9 / 16
          : 1;
  const maxSide = Math.min(1920, Math.max(originalWidth, originalHeight));
  return {
    width: Math.max(
      2,
      Math.round((ratio >= 1 ? maxSide : maxSide * ratio) / 2) * 2,
    ),
    height: Math.max(
      2,
      Math.round((ratio >= 1 ? maxSide / ratio : maxSide) / 2) * 2,
    ),
  };
}

/** Used by both preview and export to keep framing and title placement identical. */
export function drawVideoFrame(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  title: string,
  crop?: CropRect,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  context.fillStyle = "#08090d";
  context.fillRect(0, 0, width, height);
  if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
    const source = cropSourceRect(crop, video.videoWidth, video.videoHeight);
    const scale = Math.min(width / source.width, height / source.height);
    const dw = source.width * scale;
    const dh = source.height * scale;
    context.drawImage(
      video,
      source.x,
      source.y,
      source.width,
      source.height,
      (width - dw) / 2,
      (height - dh) / 2,
      dw,
      dh,
    );
  }
  if (title.trim()) {
    const fontSize = Math.max(
      14,
      Math.round(Math.min(width / 22, height / 13)),
    );
    context.font = `600 ${fontSize}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const maxWidth = width * 0.85;
    const words = title.trim().split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const proposed = line ? `${line} ${word}` : word;
      if (context.measureText(proposed).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = proposed;
    }
    if (line) lines.push(line);
    const visibleLines = lines.slice(0, 3);
    const lineHeight = fontSize * 1.4;
    const padding = fontSize * 0.7;
    const boxHeight = visibleLines.length * lineHeight + padding;
    const bottom = height - height * 0.065;
    const boxWidth = Math.min(
      width * 0.93,
      Math.max(...visibleLines.map((text) => context.measureText(text).width)) +
        padding * 2,
    );
    context.fillStyle = "rgba(8, 9, 13, 0.78)";
    context.beginPath();
    context.roundRect(
      (width - boxWidth) / 2,
      bottom - boxHeight,
      boxWidth,
      boxHeight,
      fontSize * 0.35,
    );
    context.fill();
    context.fillStyle = "#ffffff";
    visibleLines.forEach((text, index) =>
      context.fillText(
        text,
        width / 2,
        bottom - boxHeight + padding / 2 + lineHeight * (index + 0.5),
        maxWidth,
      ),
    );
  }
}

const abortError = () => new DOMException("Export cancelled", "AbortError");
function eventOnce(
  target: EventTarget,
  event: string,
  signal: AbortSignal,
  timeout = 20000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, success);
      target.removeEventListener("error", failure);
      signal.removeEventListener("abort", aborted);
    };
    const success = () => {
      cleanup();
      resolve();
    };
    const failure = () => {
      cleanup();
      reject(
        new Error(
          "The browser could not read this video. Try importing a different format.",
        ),
      );
    };
    const aborted = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Video processing timed out. Keep this tab visible and try again.",
        ),
      );
    }, timeout);
    target.addEventListener(event, success, { once: true });
    target.addEventListener("error", failure, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
async function seek(
  video: HTMLVideoElement,
  time: number,
  signal: AbortSignal,
) {
  if (Math.abs(video.currentTime - time) < 0.015 && video.readyState >= 2)
    return;
  const ready = eventOnce(video, "seeked", signal);
  video.currentTime = time;
  await ready;
}

export async function exportVideo(options: {
  source: Blob;
  edits: EditState;
  width: number;
  height: number;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}): Promise<Blob> {
  const { source, edits, signal, onProgress } = options;
  if (
    typeof MediaRecorder === "undefined" ||
    !HTMLCanvasElement.prototype.captureStream
  )
    throw new Error(
      "This browser does not support video export. Use a recent version of Chrome or Edge.",
    );
  const mimeType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType)
    throw new Error(
      "No supported video export format was found in this browser.",
    );
  const total = timelineDuration(edits.clips);
  if (total <= 0) throw new Error("Add a video clip before exporting.");
  const video = document.createElement("video");
  video.preload = "auto";
  video.playsInline = true;
  video.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-100px;";
  document.body.appendChild(video);
  const url = URL.createObjectURL(source);
  const canvas = document.createElement("canvas");
  const size = outputDimensions(
    options.width,
    options.height,
    edits.aspectRatio,
  );
  canvas.width = size.width;
  canvas.height = size.height;
  let audioContext: AudioContext | undefined;
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let frame = 0;
  let stopped: Promise<Blob> | undefined;
  try {
    if (signal.aborted) throw abortError();
    const loaded = eventOnce(video, "loadeddata", signal);
    video.src = url;
    video.load();
    await loaded;
    audioContext = new AudioContext();
    await audioContext.resume();
    const sourceNode = audioContext.createMediaElementSource(video);
    const gain = audioContext.createGain();
    gain.gain.value = edits.muted ? 0 : edits.volume;
    const destination = audioContext.createMediaStreamDestination();
    sourceNode.connect(gain);
    gain.connect(destination);
    // The audio graph feeds only the recorder, preventing duplicate playback.
    stream = canvas.captureStream(30);
    destination.stream
      .getAudioTracks()
      .forEach((track) => stream!.addTrack(track));
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks: BlobPart[] = [];
    let recordingError: Error | undefined;
    stopped = new Promise<Blob>((resolve, reject) => {
      recorder!.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder!.onerror = () => {
        recordingError = new Error(
          "Video export failed. Your original recording and edits are still saved.",
        );
        reject(recordingError);
      };
      recorder!.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });
    // Install a rejection handler while the export loop is still running.
    void stopped.catch(() => undefined);
    let activeCrop = edits.clips[0]?.crop;
    const draw = () => {
      drawVideoFrame(canvas, video, edits.title, activeCrop);
      frame = requestAnimationFrame(draw);
    };
    draw();
    let completed = 0;
    for (const [index, clip] of edits.clips.entries()) {
      if (signal.aborted) throw abortError();
      activeCrop = clip.crop;
      await seek(video, clip.start, signal);
      drawVideoFrame(canvas, video, edits.title, activeCrop);
      if (index === 0) recorder.start(200);
      else recorder.resume();
      await video.play();
      await new Promise<void>((resolve, reject) => {
        let tick = 0;
        let watchdog = 0;
        const cleanup = () => {
          cancelAnimationFrame(tick);
          clearTimeout(watchdog);
          signal.removeEventListener("abort", aborted);
          video.removeEventListener("error", failed);
        };
        const aborted = () => {
          cleanup();
          reject(abortError());
        };
        const failed = () => {
          cleanup();
          reject(new Error("Playback failed while exporting this clip."));
        };
        const check = () => {
          if (signal.aborted) {
            aborted();
            return;
          }
          if (recordingError) {
            cleanup();
            reject(recordingError);
            return;
          }
          onProgress(
            Math.min(
              0.999,
              (completed + Math.max(0, video.currentTime - clip.start)) / total,
            ),
          );
          // A progress consumer can cancel synchronously; do not schedule a new frame.
          if (signal.aborted) {
            aborted();
            return;
          }
          if (video.currentTime >= clip.end || video.ended) {
            video.pause();
            cleanup();
            resolve();
            return;
          }
          tick = requestAnimationFrame(check);
        };
        signal.addEventListener("abort", aborted, { once: true });
        video.addEventListener("error", failed, { once: true });
        watchdog = window.setTimeout(
          () => {
            cleanup();
            reject(
              new Error(
                "Export took too long. Keep this tab visible and retry.",
              ),
            );
          },
          (clip.end - clip.start) * 2000 + 30000,
        );
        check();
        if (signal.aborted) aborted();
      });
      completed += clip.end - clip.start;
      if (index < edits.clips.length - 1) recorder.pause();
    }
    recorder.stop();
    const result = await stopped;
    if (signal.aborted) throw abortError();
    if (!result.size)
      throw new Error("The exported video was empty. Please try again.");
    onProgress(1);
    return result;
  } finally {
    cancelAnimationFrame(frame);
    video.pause();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed")
      await audioContext.close();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
