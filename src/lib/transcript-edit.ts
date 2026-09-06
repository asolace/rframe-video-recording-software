import type { Clip, TimeRange, TranscriptData, TranscriptWord } from "../types";

export interface TranscriptOccurrence extends TimeRange {
  key: string;
  clipId: string;
  word: TranscriptWord;
  timelineStart: number;
}
export interface TranscriptCut extends TimeRange {
  clipId?: string;
}
const EPSILON = 0.000001;
const FILLERS = new Set(["um", "uh", "erm", "er", "hmm"]);

export function transcriptOccurrences(
  clips: Clip[],
  words: TranscriptWord[],
): TranscriptOccurrence[] {
  const occurrences: TranscriptOccurrence[] = [];
  let offset = 0;
  for (const clip of clips) {
    for (const word of words) {
      const start = Math.max(clip.start, word.start);
      const end = Math.min(clip.end, word.end);
      const instant =
        word.start === word.end &&
        word.start >= clip.start &&
        word.start < clip.end;
      if (end - start <= EPSILON && !instant) continue;
      occurrences.push({
        key: JSON.stringify([clip.id, word.id]),
        clipId: clip.id,
        word,
        start,
        end,
        timelineStart: offset + start - clip.start,
      });
    }
    offset += clip.end - clip.start;
  }
  return occurrences;
}

export function isFillerWord(text: string): boolean {
  return FILLERS.has(
    text
      .trim()
      .toLocaleLowerCase()
      .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""),
  );
}

/** A contiguous text selection also removes the gaps between its selected words. */
export function selectionCuts(
  occurrences: TranscriptOccurrence[],
  selected: ReadonlySet<string>,
): TranscriptCut[] {
  const cuts: TranscriptCut[] = [];
  let previousSelected = false;
  for (const occurrence of occurrences) {
    if (!selected.has(occurrence.key)) {
      previousSelected = false;
      continue;
    }
    const previous = cuts.at(-1);
    if (previousSelected && previous?.clipId === occurrence.clipId)
      previous.end = Math.max(previous.end, occurrence.end);
    else
      cuts.push({
        clipId: occurrence.clipId,
        start: occurrence.start,
        end: occurrence.end,
      });
    previousSelected = true;
  }
  return cuts;
}

function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + EPSILON)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Cut source-time ranges from individual clip occurrences, retaining their crops. */
export function cutTranscriptRanges(
  clips: Clip[],
  cuts: TranscriptCut[],
  newId: () => string = () => crypto.randomUUID(),
): Clip[] {
  if (!cuts.length) return clips;
  const next: Clip[] = [];
  for (const clip of clips) {
    const ranges = mergeRanges(
      cuts
        .filter(
          (cut) =>
            (!cut.clipId || cut.clipId === clip.id) &&
            Number.isFinite(cut.start) &&
            Number.isFinite(cut.end),
        )
        .map((cut) => ({
          start: Math.max(clip.start, cut.start),
          end: Math.min(clip.end, cut.end),
        }))
        .filter((cut) => cut.end - cut.start > EPSILON),
    );
    if (!ranges.length) {
      next.push(clip);
      continue;
    }
    let cursor = clip.start;
    let usedOriginalId = false;
    const keep = (start: number, end: number) => {
      if (end - start <= EPSILON) return;
      next.push({
        ...clip,
        id: usedOriginalId ? newId() : clip.id,
        start,
        end,
      });
      usedOriginalId = true;
    };
    for (const range of ranges) {
      keep(cursor, range.start);
      cursor = Math.max(cursor, range.end);
    }
    keep(cursor, clip.end);
  }
  if (
    next.reduce((sum, clip) => sum + clip.end - clip.start, 0) <
    0.1 - EPSILON
  ) {
    throw new Error(
      "This would remove the whole video. Keep at least 0.1 seconds of footage, or select fewer words.",
    );
  }
  return next;
}

export function validateTranscript(
  value: unknown,
  duration: number,
): TranscriptData {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(
      "Wait for the source video's duration before importing a transcript.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Choose a transcript JSON object with words, language, model, and createdAt.",
    );
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.words) || data.words.length > 100_000)
    throw new Error(
      "The transcript must contain a words array with at most 100,000 entries.",
    );
  if (
    typeof data.language !== "string" ||
    !data.language.trim() ||
    data.language.length > 50 ||
    typeof data.model !== "string" ||
    !data.model.trim() ||
    data.model.length > 200 ||
    typeof data.createdAt !== "number" ||
    !Number.isFinite(data.createdAt) ||
    data.createdAt < 0
  ) {
    throw new Error(
      "Transcript language, model, and numeric createdAt fields are required.",
    );
  }
  const ids = new Set<string>();
  let previousStart = -1;
  const words = data.words.map(
    (entry: unknown, index: number): TranscriptWord => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error(`Word ${index + 1} must be an object.`);
      const word = entry as Record<string, unknown>;
      if (
        typeof word.id !== "string" ||
        !word.id.trim() ||
        word.id.length > 200 ||
        ids.has(word.id)
      )
        throw new Error(`Word ${index + 1} needs a unique, nonempty id.`);
      if (
        typeof word.text !== "string" ||
        !word.text.trim() ||
        word.text.length > 250
      )
        throw new Error(
          `Word ${index + 1} needs nonempty text of at most 250 characters.`,
        );
      if (
        typeof word.start !== "number" ||
        typeof word.end !== "number" ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end < word.start ||
        word.end > duration + EPSILON
      ) {
        throw new Error(
          `Word ${index + 1} has invalid timing. Use seconds within the source video (0–${duration.toFixed(2)}), with end no earlier than start.`,
        );
      }
      if (word.start < previousStart)
        throw new Error(
          "Transcript words must be ordered by their source start time.",
        );
      ids.add(word.id);
      previousStart = word.start;
      return {
        id: word.id,
        text: word.text.trim(),
        start: word.start,
        end: Math.min(duration, word.end),
      };
    },
  );
  return {
    words,
    language: data.language.trim(),
    model: data.model.trim(),
    createdAt: data.createdAt,
  };
}
