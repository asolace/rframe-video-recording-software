import type { TimeRange } from "../types";

export interface AnalysisProgress {
  stage: string;
  /** Fraction from 0 to 1, or null when the browser cannot report progress. */
  progress: number | null;
}

export interface AudioAnalysisOptions {
  signal: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
}

export interface SilenceOptions {
  thresholdDb?: number;
  minDuration?: number;
  padding?: number;
}

export const ANALYSIS_SAMPLE_RATE = 16_000;
export const MAX_ANALYSIS_DURATION = 20 * 60;
export const MAX_ANALYSIS_BYTES = 512 * 1024 * 1024;

export function analysisAborted(): DOMException {
  return new DOMException("Audio processing was cancelled.", "AbortError");
}

function checkSignal(signal: AbortSignal) {
  if (signal.aborted) throw analysisAborted();
}

/** decodeAudioData itself is not abortable; release its context and ignore late results. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(analysisAborted());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function inspectDuration(
  blob: Blob,
  signal: AbortSignal,
): Promise<number | null> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.preload = "metadata";
  video.muted = true;
  try {
    return await new Promise<number | null>((resolve, reject) => {
      let seekingEnd = false;
      const cleanup = () => {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        video.removeEventListener("loadedmetadata", inspect);
        video.removeEventListener("durationchange", inspect);
        video.removeEventListener("seeked", inspect);
        video.removeEventListener("error", unavailable);
      };
      const finish = (duration: number | null) => {
        cleanup();
        resolve(duration);
      };
      const abort = () => {
        cleanup();
        reject(analysisAborted());
      };
      const unavailable = () => finish(null);
      const inspect = () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          finish(video.duration);
          return;
        }
        // MediaRecorder WebM often omits a duration; seeking forces Chrome to
        // inspect the last cluster without playing or uploading the recording.
        if (video.duration === Infinity && !seekingEnd) {
          seekingEnd = true;
          try {
            video.currentTime = 1e100;
          } catch {
            finish(null);
          }
        } else if (
          seekingEnd &&
          Number.isFinite(video.currentTime) &&
          video.currentTime > 0 &&
          video.currentTime < 1e90
        ) {
          finish(video.currentTime);
        }
      };
      const timeout = window.setTimeout(unavailable, 12_000);
      signal.addEventListener("abort", abort, { once: true });
      video.addEventListener("loadedmetadata", inspect);
      video.addEventListener("durationchange", inspect);
      video.addEventListener("seeked", inspect);
      video.addEventListener("error", unavailable);
      if (signal.aborted) abort();
      else video.src = url;
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Decode only the audio track locally. AudioContext resamples to 16 kHz while
 * decoding, avoiding an extra full-resolution PCM copy and a second resampler.
 */
export async function decodeVideoAudio(
  blob: Blob,
  { signal, onProgress }: AudioAnalysisOptions,
): Promise<{ samples: Float32Array; sampleRate: number; duration: number }> {
  checkSignal(signal);
  if (!blob.size)
    throw new Error(
      "This recording is empty. Choose a video with an audio track.",
    );
  if (blob.size > MAX_ANALYSIS_BYTES)
    throw new Error(
      "Local audio processing supports files up to 512 MB. Export a shorter section and try again.",
    );
  if (typeof AudioContext === "undefined")
    throw new Error(
      "This browser cannot decode audio. Use a current desktop Chrome or Edge browser.",
    );
  onProgress?.({ stage: "Reading the audio track", progress: null });
  const durationHint = await inspectDuration(blob, signal);
  checkSignal(signal);
  if (durationHint !== null && durationHint > MAX_ANALYSIS_DURATION)
    throw new Error(
      "Local audio processing supports recordings up to 20 minutes. Export a shorter section and try again.",
    );
  const context = new AudioContext({ sampleRate: ANALYSIS_SAMPLE_RATE });
  const close = () => {
    if (context.state !== "closed") void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", close, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const encoded = await abortable(blob.arrayBuffer(), signal);
    checkSignal(signal);
    onProgress?.({ stage: "Decoding audio on this device", progress: null });
    const decoded = await abortable(
      Promise.race([
        context.decodeAudioData(encoded),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "Audio decoding took too long. Try a shorter video with AAC or Opus audio.",
                ),
              ),
            90_000,
          );
        }),
      ]),
      signal,
    ).catch((error: unknown) => {
      if (signal.aborted) throw analysisAborted();
      if (error instanceof DOMException && error.name === "EncodingError")
        throw new Error(
          "This video has no readable audio track. Record with your microphone on, or import a video with AAC or Opus audio.",
        );
      throw error;
    });
    checkSignal(signal);
    if (!decoded.numberOfChannels || !decoded.length)
      throw new Error(
        "This video has no audio track. Record with your microphone on and try again.",
      );
    if (
      !Number.isFinite(decoded.duration) ||
      decoded.duration > MAX_ANALYSIS_DURATION
    )
      throw new Error(
        "Local audio processing supports recordings up to 20 minutes. Export a shorter section and try again.",
      );
    if (decoded.sampleRate !== ANALYSIS_SAMPLE_RATE)
      throw new Error(
        "This browser cannot prepare 16 kHz audio. Use a current desktop Chrome or Edge browser.",
      );
    if (decoded.numberOfChannels > 8)
      throw new Error(
        "This audio has too many channels to process locally. Import a mono or stereo version.",
      );
    // Opus codec padding can decode slightly past the source video's end.
    // Keep word timestamps within the same source duration used by the editor.
    const sampleCount =
      durationHint === null
        ? decoded.length
        : Math.min(
            decoded.length,
            Math.floor(durationHint * ANALYSIS_SAMPLE_RATE),
          );
    const samples = new Float32Array(sampleCount);
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index),
    );
    // Yield while downmixing longer files so Cancel remains responsive.
    const block = ANALYSIS_SAMPLE_RATE * 10;
    for (let offset = 0; offset < samples.length; offset += block) {
      checkSignal(signal);
      const end = Math.min(samples.length, offset + block);
      for (let index = offset; index < end; index++) {
        let value = 0;
        for (const channel of channels) value += channel[index];
        if (!Number.isFinite(value))
          throw new Error(
            "The audio contains invalid samples. Try another recording.",
          );
        samples[index] = Math.max(-1, Math.min(1, value / channels.length));
      }
      onProgress?.({
        stage: "Preparing audio",
        progress: end / samples.length,
      });
      if (end < samples.length)
        await abortable(
          new Promise<void>((resolve) => setTimeout(resolve, 0)),
          signal,
        );
    }
    return {
      samples,
      sampleRate: ANALYSIS_SAMPLE_RATE,
      duration: samples.length / ANALYSIS_SAMPLE_RATE,
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", close);
    close();
  }
}

/**
 * Detect quiet runs using 10 ms RMS windows. Padding preserves room around
 * speech; it is not applied at the outer edge of the recording. Returned ranges
 * are the actual removable portions, in source-video seconds.
 */
export function detectSilences(
  samples: Float32Array,
  sampleRate: number,
  { thresholdDb = -40, minDuration = 0.5, padding = 0.08 }: SilenceOptions = {},
): TimeRange[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new RangeError("Sample rate must be positive.");
  if (!Number.isFinite(thresholdDb) || thresholdDb < -100 || thresholdDb > 0)
    throw new RangeError("Silence threshold must be between -100 and 0 dB.");
  if (!Number.isFinite(minDuration) || minDuration <= 0)
    throw new RangeError("Minimum silence must be greater than zero.");
  if (!Number.isFinite(padding) || padding < 0)
    throw new RangeError("Speech padding cannot be negative.");
  if (!samples.length) return [];
  const windowSize = Math.max(1, Math.round(sampleRate * 0.01));
  const thresholdPower = 10 ** (thresholdDb / 10);
  const duration = samples.length / sampleRate;
  const ranges: TimeRange[] = [];
  let quietStart: number | null = null;
  const finish = (endSample: number) => {
    if (quietStart === null) return;
    const rawStart = quietStart / sampleRate;
    const rawEnd = endSample / sampleRate;
    if (rawEnd - rawStart + 1e-9 >= minDuration) {
      const start = rawStart + (quietStart === 0 ? 0 : padding);
      const end = rawEnd - (endSample === samples.length ? 0 : padding);
      if (end - start > 1 / sampleRate)
        ranges.push({
          start: Math.max(0, start),
          end: Math.min(duration, end),
        });
    }
    quietStart = null;
  };
  for (let offset = 0; offset < samples.length; offset += windowSize) {
    const end = Math.min(samples.length, offset + windowSize);
    let power = 0;
    for (let index = offset; index < end; index++) {
      if (!Number.isFinite(samples[index]))
        throw new Error("The audio contains invalid samples.");
      power += samples[index] * samples[index];
    }
    if (power / (end - offset) <= thresholdPower) quietStart ??= offset;
    else finish(offset);
  }
  finish(samples.length);
  return ranges;
}

export async function analyzeSilences(
  blob: Blob,
  options: AudioAnalysisOptions & SilenceOptions,
): Promise<TimeRange[]> {
  const { samples, sampleRate } = await decodeVideoAudio(blob, options);
  checkSignal(options.signal);
  options.onProgress?.({ stage: "Finding quiet sections", progress: null });
  await abortable(
    new Promise<void>((resolve) => setTimeout(resolve, 0)),
    options.signal,
  );
  const ranges = detectSilences(samples, sampleRate, options);
  checkSignal(options.signal);
  options.onProgress?.({ stage: "Silence analysis complete", progress: 1 });
  return ranges;
}
