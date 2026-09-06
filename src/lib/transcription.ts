import type { TranscriptData } from "../types";
import {
  analysisAborted,
  decodeVideoAudio,
  type AnalysisProgress,
} from "./audio-analysis";

export const TRANSCRIPTION_MODEL = "onnx-community/whisper-tiny.en_timestamped";
/** Quantized model + tokenizer/config files; the inference runtime is additional. */
export const TRANSCRIPTION_DOWNLOAD_MB = 45;

export interface TranscriptionOptions {
  signal: AbortSignal;
  onProgress: (progress: AnalysisProgress) => void;
}

type WorkerMessage =
  | { type: "progress"; progress: AnalysisProgress }
  | { type: "complete"; transcript: TranscriptData }
  | { type: "error"; message: string };

/** Creates a dedicated worker only after the user explicitly starts transcription. */
export async function transcribeVideo(
  blob: Blob,
  { signal, onProgress }: TranscriptionOptions,
): Promise<TranscriptData> {
  if (signal.aborted) throw analysisAborted();
  if (typeof Worker === "undefined")
    throw new Error(
      "This browser cannot run local transcription. Use a current desktop Chrome or Edge browser.",
    );
  const audio = await decodeVideoAudio(blob, { signal, onProgress });
  if (signal.aborted) throw analysisAborted();
  let energy = 0;
  for (let index = 0; index < audio.samples.length; index++)
    energy += audio.samples[index] ** 2;
  if (Math.sqrt(energy / audio.samples.length) < 0.0001)
    throw new Error(
      "This recording is silent. Choose a video with audible speech or record with your microphone on.",
    );
  onProgress({ stage: "Starting local transcription", progress: null });
  return new Promise<TranscriptData>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./transcription.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      reject(
        new Error(
          "The local transcription worker could not start. Reload the app and try again.",
        ),
      );
      return;
    }
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      // Terminating interrupts in-flight ONNX inference and model downloads.
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(analysisAborted());
    };
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.type === "progress") onProgress(data.progress);
      else if (data.type === "complete") {
        cleanup();
        resolve(data.transcript);
      } else if (data.type === "error") {
        cleanup();
        reject(new Error(data.message));
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      cleanup();
      reject(
        new Error(
          "Local transcription could not run. Check your connection for the first model download, then try again in desktop Chrome or Edge.",
        ),
      );
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(
        new Error(
          "The transcription worker returned unreadable data. Try again.",
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.postMessage({ samples: audio.samples, duration: audio.duration }, [
      audio.samples.buffer,
    ]);
  });
}
