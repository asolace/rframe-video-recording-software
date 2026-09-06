import type { RecordingMode } from "../types";

export interface CaptureOptions {
  mode: Exclude<RecordingMode, "import">;
  camera: boolean;
  microphone: boolean;
  cameraDevice?: string;
  microphoneDevice?: string;
  signal: AbortSignal;
  onScreenSharingChange?: (sharing: boolean) => void;
}

export interface CaptureSession {
  stream: MediaStream;
  width: number;
  height: number;
  hasCamera: boolean;
  hasMicrophone: boolean;
  readonly displayTrack?: MediaStreamTrack;
  readonly screenSharing: boolean;
  startScreenShare(): Promise<void>;
  stopScreenShare(): void;
  setCamera(enabled: boolean): void;
  setMicrophone(enabled: boolean): void;
  getMicrophoneLevel(): { level: number; peak: number };
  thumbnail(): string;
  dispose(): void;
}

export function recordingMimeType(): string | undefined {
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type));
}

export function captureError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Permission was declined or the picker was closed. Allow camera and microphone access in your browser’s site settings, then try again. For screen recording, select a tab, window, or screen and choose Share.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "The selected camera or microphone was not found. Connect your device, refresh the device list, or switch off the missing input.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your camera, microphone, or screen could not be opened. Close other apps using the device and check your system privacy settings, then try again.";
  }
  if (name === "OverconstrainedError")
    return "That device is no longer available. Choose the system default device and try again.";
  if (name === "AbortError")
    return "Capture was interrupted. Choose your sources and try again.";
  return error instanceof Error
    ? error.message
    : "Recording could not start. Check your connected devices and browser permissions, then try again.";
}

interface DisplaySource {
  stream: MediaStream;
  video?: HTMLVideoElement;
  audio?: MediaStreamAudioSourceNode;
  ended?: () => void;
}

interface PendingShare {
  generation: number;
  promise: Promise<void>;
  source?: DisplaySource;
}

/**
 * Keeps the MediaRecorder inputs stable while their visual/audio sources change.
 * Both this function and startScreenShare must be called directly from a click.
 */
export async function createCapture(
  options: CaptureOptions,
): Promise<CaptureSession> {
  const streams = new Set<MediaStream>();
  const videos = new Set<HTMLVideoElement>();
  const audioNodes = new Set<MediaStreamAudioSourceNode>();
  let width = 1280;
  let height = 720;
  let initialDisplaySize: { width: number; height: number } | undefined;
  let context: AudioContext | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let silence: ConstantSourceNode | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let drawing: CanvasRenderingContext2D | null = null;
  let inputs: MediaStream | undefined;
  let cameraVideo: HTMLVideoElement | undefined;
  let activeScreen: DisplaySource | undefined;
  let pendingShare: PendingShare | undefined;
  let screenGeneration = 0;
  let timer: number | undefined;
  let disposed = false;
  let cameraEnabled = options.camera;
  let microphoneAnalyser: AnalyserNode | undefined;
  const microphoneSamples = new Float32Array(1024);

  const cancelled = () =>
    new DOMException("Screen sharing was cancelled", "AbortError");
  const check = () => {
    if (options.signal.aborted || disposed)
      throw new DOMException("Capture cancelled", "AbortError");
  };
  const stopStream = (stream: MediaStream) => {
    stream.getTracks().forEach((track) => track.stop());
    streams.delete(stream);
  };
  const own = (stream: MediaStream) => {
    // A permission picker may resolve after cancellation or component unmount.
    if (options.signal.aborted || disposed) {
      stopStream(stream);
      throw new DOMException("Capture cancelled", "AbortError");
    }
    streams.add(stream);
    return stream;
  };
  const stopVideo = (video: HTMLVideoElement) => {
    video.pause();
    video.srcObject = null;
    videos.delete(video);
  };
  const makeVideo = (stream: MediaStream) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream(stream.getVideoTracks());
    videos.add(video);
    return video;
  };
  const connectAudio = (stream: MediaStream) => {
    if (!context || !destination || !stream.getAudioTracks().length)
      return undefined;
    const node = context.createMediaStreamSource(
      new MediaStream(stream.getAudioTracks()),
    );
    node.connect(destination);
    audioNodes.add(node);
    return node;
  };
  const releaseDisplay = (source: DisplaySource) => {
    if (source.ended) {
      source.stream
        .getVideoTracks()
        .forEach((track) => track.removeEventListener("ended", source.ended!));
      source.ended = undefined;
    }
    if (source.audio) {
      source.audio.disconnect();
      audioNodes.delete(source.audio);
      source.audio = undefined;
    }
    if (source.video) {
      stopVideo(source.video);
      source.video = undefined;
    }
    stopStream(source.stream);
  };

  const drawContained = (video: HTMLVideoElement) => {
    if (!drawing || video.readyState < 2) return;
    const sourceWidth = video.videoWidth || width;
    const sourceHeight = video.videoHeight || height;
    const ratio = Math.min(width / sourceWidth, height / sourceHeight);
    const w = sourceWidth * ratio;
    const h = sourceHeight * ratio;
    drawing.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
  };
  const paint = () => {
    if (disposed || !drawing) return;
    drawing.fillStyle = "#101116";
    drawing.fillRect(0, 0, width, height);
    const camera =
      cameraEnabled &&
      inputs?.getVideoTracks().some((track) => track.readyState === "live")
        ? cameraVideo
        : undefined;
    if (activeScreen?.video) {
      drawContained(activeScreen.video);
      if (camera && camera.readyState >= 2) {
        const scale = Math.min(width / 1280, height / 720);
        const x = width - 260 * scale,
          y = height - 178 * scale;
        const w = 232 * scale,
          h = 150 * scale,
          radius = 18 * scale;
        drawing.save();
        drawing.beginPath();
        drawing.roundRect(x, y, w, h, radius);
        drawing.clip();
        const cw = camera.videoWidth || width;
        const ch = camera.videoHeight || height;
        const crop = Math.max(w / cw, h / ch);
        drawing.drawImage(
          camera,
          x + (w - cw * crop) / 2,
          y + (h - ch * crop) / 2,
          cw * crop,
          ch * crop,
        );
        drawing.restore();
        drawing.strokeStyle = "rgba(255,255,255,.45)";
        drawing.lineWidth = 2 * scale;
        drawing.beginPath();
        drawing.roundRect(x, y, w, h, radius);
        drawing.stroke();
      }
    } else if (camera) {
      drawContained(camera);
    }
  };

  function stopScreenShare() {
    // Invalidate even unresolved pickers, which browsers cannot dismiss for us.
    screenGeneration++;
    const previous = activeScreen;
    const pending = pendingShare;
    activeScreen = undefined;
    pendingShare = undefined;
    if (previous) releaseDisplay(previous);
    if (pending?.source && pending.source !== previous)
      releaseDisplay(pending.source);
    paint();
    if (previous && !disposed && !options.signal.aborted)
      options.onScreenSharingChange?.(false);
  }

  function startScreenShare(): Promise<void> {
    try {
      check();
      if (activeScreen) return Promise.resolve();
      if (pendingShare) return pendingShare.promise;
      if (typeof navigator.mediaDevices.getDisplayMedia !== "function")
        throw new Error(
          "Screen capture is unavailable in this browser. Open Frame in a current desktop Chrome or Edge browser to share your screen.",
        );
      const operation: PendingShare = {
        generation: ++screenGeneration,
        promise: Promise.resolve(),
      };
      pendingShare = operation;
      operation.promise = (async () => {
        let source: DisplaySource | undefined;
        const checkOperation = () => {
          check();
          if (
            operation.generation !== screenGeneration ||
            pendingShare !== operation
          )
            throw cancelled();
        };
        try {
          // Keep this call before every await to preserve transient activation.
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
            audio: true,
          });
          if (
            disposed ||
            options.signal.aborted ||
            operation.generation !== screenGeneration ||
            pendingShare !== operation
          ) {
            stopStream(stream);
            throw cancelled();
          }
          source = { stream: own(stream) };
          operation.source = source;
          const track = stream.getVideoTracks()[0];
          if (!track || track.readyState === "ended")
            throw new DOMException(
              "Screen sharing ended before it was ready",
              "AbortError",
            );
          const attachedSource = source;
          source.ended = () => {
            if (
              activeScreen === attachedSource ||
              pendingShare?.source === attachedSource
            )
              stopScreenShare();
          };
          stream.getVideoTracks().forEach((videoTrack) =>
            videoTrack.addEventListener("ended", source!.ended!, {
              once: true,
            }),
          );
          source.video = makeVideo(stream);
          await source.video.play();
          checkOperation();
          if (stream.getVideoTracks()[0]?.readyState !== "live")
            throw cancelled();
          // Only connect audio once the new source is ready to become visible.
          source.audio = connectAudio(stream);
          activeScreen = source;
          pendingShare = undefined;
          paint();
          options.onScreenSharingChange?.(true);
        } catch (error) {
          if (source && activeScreen !== source) releaseDisplay(source);
          throw error;
        } finally {
          if (pendingShare === operation) pendingShare = undefined;
        }
      })();
      return operation.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopScreenShare();
    if (timer !== undefined) window.clearInterval(timer);
    audioNodes.forEach((node) => node.disconnect());
    audioNodes.clear();
    microphoneAnalyser?.disconnect();
    microphoneAnalyser = undefined;
    if (silence) {
      silence.stop();
      silence.disconnect();
    }
    streams.forEach(stopStream);
    videos.forEach(stopVideo);
    if (context && context.state !== "closed")
      void context.close().catch(() => undefined);
    options.signal.removeEventListener("abort", dispose);
  }
  options.signal.addEventListener("abort", dispose, { once: true });

  try {
    check();
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    drawing = canvas.getContext("2d");
    if (!drawing || typeof canvas.captureStream !== "function")
      throw new Error(
        "This browser cannot create a continuous recording. Use a current desktop Chrome or Edge browser.",
      );
    context = new AudioContext();
    destination = context.createMediaStreamDestination();
    own(destination.stream);
    // A silent source keeps the same live audio track even with every input off.
    silence = context.createConstantSource();
    silence.offset.value = 0;
    silence.connect(destination);
    silence.start();

    if (options.mode !== "camera") {
      await startScreenShare();
      const settings = activeScreen?.stream.getVideoTracks()[0]?.getSettings();
      initialDisplaySize = {
        width: activeScreen?.video?.videoWidth || settings?.width || width,
        height: activeScreen?.video?.videoHeight || settings?.height || height,
      };
    }
    const needsCamera =
      options.mode === "camera" ||
      (options.mode === "screen-camera" && options.camera);
    if (needsCamera || options.microphone) {
      inputs = own(
        await navigator.mediaDevices.getUserMedia({
          video: needsCamera
            ? {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 },
                ...(options.cameraDevice
                  ? { deviceId: { exact: options.cameraDevice } }
                  : {}),
              }
            : false,
          audio: options.microphone
            ? {
                echoCancellation: true,
                noiseSuppression: true,
                ...(options.microphoneDevice
                  ? { deviceId: { exact: options.microphoneDevice } }
                  : {}),
              }
            : false,
        }),
      );
      check();
      if (inputs.getVideoTracks().length) {
        inputs.getVideoTracks().forEach((track) => {
          track.enabled = cameraEnabled;
        });
        cameraVideo = makeVideo(inputs);
        await cameraVideo.play();
        check();
      }
      const microphoneNode = connectAudio(inputs);
      if (microphoneNode) {
        // Analyse only the microphone, before its audio mixes with a shared tab.
        // This side branch never connects to the speakers or changes recorded gain.
        microphoneAnalyser = context.createAnalyser();
        microphoneAnalyser.fftSize = microphoneSamples.length;
        microphoneNode.connect(microphoneAnalyser);
      }
    }
    // Retain the source resolution where possible; later source changes never
    // resize this canvas or replace its recording track.
    if (options.mode !== "screen-camera") {
      const cameraSettings = inputs?.getVideoTracks()[0]?.getSettings();
      const sourceWidth =
        options.mode === "camera"
          ? cameraVideo?.videoWidth || cameraSettings?.width || width
          : initialDisplaySize?.width || width;
      const sourceHeight =
        options.mode === "camera"
          ? cameraVideo?.videoHeight || cameraSettings?.height || height
          : initialDisplaySize?.height || height;
      const scale = Math.min(1, 1920 / Math.max(sourceWidth, sourceHeight));
      width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
      height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
      canvas.width = width;
      canvas.height = height;
    }
    await context.resume();
    check();
    paint();
    const composed = own(canvas.captureStream(30));
    const output = own(
      new MediaStream([
        ...composed.getVideoTracks(),
        ...destination.stream.getAudioTracks(),
      ]),
    );
    timer = window.setInterval(paint, 1000 / 30);

    return {
      stream: output,
      width,
      height,
      hasCamera: !!inputs?.getVideoTracks().length,
      hasMicrophone: !!inputs?.getAudioTracks().length,
      get displayTrack() {
        return activeScreen?.stream.getVideoTracks()[0];
      },
      get screenSharing() {
        return !!activeScreen;
      },
      startScreenShare,
      stopScreenShare,
      setCamera(enabled) {
        cameraEnabled = enabled;
        inputs?.getVideoTracks().forEach((track) => {
          track.enabled = enabled;
        });
        paint();
      },
      setMicrophone(enabled) {
        inputs?.getAudioTracks().forEach((track) => {
          track.enabled = enabled;
        });
      },
      getMicrophoneLevel() {
        if (
          disposed ||
          !microphoneAnalyser ||
          context?.state !== "running" ||
          !inputs
            ?.getAudioTracks()
            .some(
              (track) =>
                track.enabled && !track.muted && track.readyState === "live",
            )
        ) {
          return { level: 0, peak: 0 };
        }
        microphoneAnalyser.getFloatTimeDomainData(microphoneSamples);
        let sum = 0;
        let peak = 0;
        for (const sample of microphoneSamples) {
          sum += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        return {
          level: Math.min(1, Math.sqrt(sum / microphoneSamples.length)),
          peak: Math.min(1, peak),
        };
      },
      thumbnail() {
        try {
          paint();
          const thumb = document.createElement("canvas");
          thumb.width = 640;
          thumb.height = Math.round((640 * height) / width);
          thumb
            .getContext("2d")
            ?.drawImage(canvas!, 0, 0, thumb.width, thumb.height);
          return thumb.toDataURL("image/jpeg", 0.8);
        } catch {
          return "";
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
