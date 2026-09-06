import { env, pipeline } from "@huggingface/transformers";
import type { TranscriptData, TranscriptWord } from "../types";

// This export includes cross-attention outputs and alignment_heads required for
// true word timestamps. The plain whisper-tiny.en export does not suffice.
// https://huggingface.co/onnx-community/whisper-tiny.en_timestamped
const MODEL = "onnx-community/whisper-tiny.en_timestamped";
const REVISION = "aeaa13760958b03fac5062f457d317d3319c3168";

env.allowLocalModels = false;
env.useBrowserCache = true;
// Run CPU inference off the UI thread without requiring cross-origin isolation.
env.backends.onnx.wasm!.numThreads = 1;
env.backends.onnx.wasm!.proxy = false;
// Resolve the binary ourselves. In development ONNX otherwise looks beside a
// prebundled dependency in .vite/deps, where Vite's SPA fallback returns HTML.
// Vite rewrites this exact asset reference to a hashed URL in production.
const runtimeUrl = new URL(
  "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm",
  import.meta.url,
).href;
env.backends.onnx.wasm!.wasmPaths = { wasm: runtimeUrl };

async function loadRuntime() {
  try {
    const response = await fetch(runtimeUrl);
    if (!response.ok) throw new Error(`Runtime request returned HTTP ${response.status}.`);
    const binary = new Uint8Array(await response.arrayBuffer());
    if (binary.length < 8 || binary[0] !== 0 || binary[1] !== 0x61 || binary[2] !== 0x73 || binary[3] !== 0x6d)
      throw new Error("Runtime response was not a WebAssembly binary.");
    // Passing validated bytes also prevents ONNX from making a second request
    // using an inferred path. Worker termination releases this buffer as well.
    env.backends.onnx.wasm!.wasmBinary = binary;
  } catch (cause) {
    const error = new Error("The local transcription engine could not load. Reload the app and try again.", { cause });
    error.name = "TranscriptionRuntimeError";
    throw error;
  }
}

interface TimedChunk {
  text: string;
  timestamp: [number | null, number | null];
}
interface AlignedOutput {
  text: string;
  chunks?: TimedChunk[];
}

function normalizeWords(
  output: AlignedOutput,
  duration: number,
): TranscriptWord[] {
  if (
    (!Array.isArray(output.chunks) || !output.chunks.length) &&
    !output.text?.trim()
  )
    return [];
  if (!Array.isArray(output.chunks) || !output.chunks.length)
    throw new Error(
      "No word alignment was returned. Try a shorter recording with clear English speech.",
    );
  const words: TranscriptWord[] = [];
  for (const chunk of output.chunks) {
    const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
    if (!text) continue;
    const [rawStart, rawEnd] = Array.isArray(chunk.timestamp)
      ? chunk.timestamp
      : [null, null];
    if (
      typeof rawStart !== "number" ||
      typeof rawEnd !== "number" ||
      !Number.isFinite(rawStart) ||
      !Number.isFinite(rawEnd) ||
      rawEnd < rawStart
    )
      throw new Error(
        "The model could not align every word. Try a shorter recording with clear English speech.",
      );
    const start = Math.max(0, Math.min(duration, rawStart));
    const end = Math.max(start, Math.min(duration, rawEnd));
    const previous = words[words.length - 1];
    // Native Whisper stride merging handles overlapping windows. Discard only
    // exact repeated alignments, preserving deliberately repeated spoken words.
    if (
      previous &&
      previous.text === text &&
      Math.abs(previous.start - start) < 0.005 &&
      Math.abs(previous.end - end) < 0.005
    )
      continue;
    if (previous && start < previous.start)
      throw new Error(
        "The model returned inconsistent word timing. Try a shorter recording with clear English speech.",
      );
    // Keep zero-duration model alignments as instants; inventing a duration would
    // make destructive transcript edits appear more precise than the model is.
    words.push({ id: crypto.randomUUID(), text, start, end });
  }
  if (!words.length && output.text?.trim())
    throw new Error(
      "No word alignment was returned. Try a shorter recording with clear English speech.",
    );
  return words;
}

let running = false;
self.onmessage = async ({
  data,
}: MessageEvent<{ samples: Float32Array; duration: number }>) => {
  if (running) return;
  running = true;
  const sendProgress = (stage: string, progress: number | null) =>
    self.postMessage({ type: "progress", progress: { stage, progress } });
  try {
    if (
      !(data.samples instanceof Float32Array) ||
      !data.samples.length ||
      !Number.isFinite(data.duration) ||
      data.duration <= 0
    )
      throw new Error("The recording did not contain usable audio.");
    sendProgress("Loading the local transcription engine", null);
    await loadRuntime();
    sendProgress("Loading the English speech model", null);
    // Sizes belong to the pinned q8 revision above. Tracking both graphs from
    // the outset prevents a small config download showing 100%, then jumping
    // backwards when a model graph starts. Cache reads use the same callback.
    const downloads = new Map<string, { loaded: number; total: number }>([
      ["onnx/encoder_model_quantized.onnx", { loaded: 0, total: 10_097_112 }],
      [
        "onnx/decoder_model_merged_quantized.onnx",
        { loaded: 0, total: 30_729_881 },
      ],
    ]);
    const transcriber = await pipeline("automatic-speech-recognition", MODEL, {
      revision: REVISION,
      device: "wasm",
      dtype: "q8",
      progress_callback: (event) => {
        if (event.status === "progress" && downloads.has(event.file)) {
          const previous = downloads.get(event.file)!;
          downloads.set(event.file, {
            loaded: Math.max(previous.loaded, event.loaded),
            total: event.total || previous.total,
          });
          const files = [...downloads.values()];
          const total = files.reduce((sum, file) => sum + file.total, 0);
          const loaded = files.reduce((sum, file) => sum + file.loaded, 0);
          sendProgress(
            "Loading the English speech model",
            total > 0 ? Math.min(1, loaded / total) : null,
          );
        }
      },
    });
    // Numeric window ownership avoids the tokenizer's longest-common-text
    // merge, which can duplicate repeated phrases across overlapping chunks.
    // Every word keeps the model's real alignment, offset to source seconds.
    const sampleRate = 16_000;
    const windowSamples = sampleRate * 25;
    // Six seconds of context keep partial phrases at each window edge outside
    // its owned region; shorter context can retain Whisper's repeated tail text.
    const contextSamples = sampleRate * 6;
    const jumpSamples = windowSamples - contextSamples * 2;
    const totalWindows =
      data.samples.length <= windowSamples
        ? 1
        : 1 + Math.ceil((data.samples.length - windowSamples) / jumpSamples);
    const words: TranscriptWord[] = [];
    const wordKey = (text: string) =>
      text.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}']/gu, "");
    for (
      let offset = 0, index = 0;
      index < totalWindows;
      offset += jumpSamples, index++
    ) {
      const samples = data.samples.subarray(offset, offset + windowSamples);
      const isLast = index === totalWindows - 1;
      const coreStart =
        index === 0 ? 0 : (offset + contextSamples) / sampleRate;
      const coreEnd = isLast
        ? data.duration
        : (offset + windowSamples - contextSamples) / sampleRate;
      sendProgress(
        `Transcribing English speech on this device (${index + 1} of ${totalWindows})`,
        index / totalWindows,
      );
      let energy = 0;
      for (let sample = 0; sample < samples.length; sample++)
        energy += samples[sample] ** 2;
      if (Math.sqrt(energy / samples.length) < 0.0001) continue;
      const output = await transcriber(samples, {
        return_timestamps: "word",
        chunk_length_s: 0,
        do_sample: false,
        num_beams: 1,
      });
      if (Array.isArray(output))
        throw new Error(
          "The model returned an unexpected batch of transcripts.",
        );
      for (const word of normalizeWords(
        output as AlignedOutput,
        samples.length / sampleRate,
      )) {
        word.start = Math.min(data.duration, word.start + offset / sampleRate);
        word.end = Math.min(data.duration, word.end + offset / sampleRate);
        const midpoint = (word.start + word.end) / 2;
        if (midpoint < coreStart || (!isLast && midpoint >= coreEnd)) continue;
        // Separate windows can align a boundary word a few frames differently.
        // Remove only matching words with overlapping temporal evidence, never
        // matching text elsewhere in the recording (including repeated speech).
        const duplicate =
          index > 0 &&
          midpoint < coreStart + 1 &&
          words.slice(-4).some((previous) => {
            if (
              !wordKey(word.text) ||
              wordKey(previous.text) !== wordKey(word.text)
            )
              return false;
            const overlap =
              Math.min(previous.end, word.end) -
              Math.max(previous.start, word.start);
            const shorter = Math.min(
              previous.end - previous.start,
              word.end - word.start,
            );
            return shorter > 0
              ? overlap / shorter >= 0.5
              : Math.abs(previous.start - word.start) <= 0.04;
          });
        if (!duplicate) words.push(word);
      }
    }
    if (!words.length)
      throw new Error(
        "No speech was found. Try a recording with clearer English audio.",
      );
    if (
      words.some(
        (word, index) => index > 0 && word.start < words[index - 1].start,
      )
    )
      throw new Error(
        "The model returned inconsistent word timing across a recording boundary. Try a shorter section.",
      );
    let unalignedRun = 0;
    for (const word of words) {
      unalignedRun = word.end === word.start ? unalignedRun + 1 : 0;
      if (unalignedRun >= 4)
        throw new Error(
          "The model could not align a phrase to the audio. Try a shorter section with clear English speech.",
        );
    }
    const transcript: TranscriptData = {
      words,
      language: "en",
      model: MODEL,
      createdAt: Date.now(),
    };
    sendProgress("Transcript ready", 1);
    await transcriber.dispose();
    self.postMessage({ type: "complete", transcript });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = error instanceof Error && error.name === "TranscriptionRuntimeError" ? detail
      : /fetch|network|download|could not locate|not found/i.test(
      detail,
    )
      ? "The speech model could not download. Check your internet connection and try again. Your audio stays on this device."
      : `Local transcription failed. ${detail}`;
    self.postMessage({ type: "error", message });
  }
};
