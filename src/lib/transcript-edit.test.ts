import { describe, expect, it } from "vitest";
import type { Clip, TranscriptData } from "../types";
import {
  cutTranscriptRanges,
  isFillerWord,
  selectionCuts,
  transcriptOccurrences,
  validateTranscript,
} from "./transcript-edit";

const crop = { x: 0.2, y: 0.1, width: 0.5, height: 0.7 };
const source: Clip[] = [{ id: "first", start: 0, end: 10, crop }];
const transcript: TranscriptData = {
  language: "en",
  model: "corrected",
  createdAt: 1,
  words: [
    { id: "a", text: "Hello", start: 1, end: 2 },
    { id: "b", text: "um,", start: 2.3, end: 2.6 },
    { id: "c", text: "world", start: 3, end: 4 },
  ],
};

describe("transcript timeline cuts", () => {
  it("cuts at word boundaries and keeps crop data and the first surviving ID", () => {
    const result = cutTranscriptRanges(
      source,
      [{ clipId: "first", start: 2.3, end: 2.6 }],
      () => "new",
    );
    expect(result).toEqual([
      { id: "first", start: 0, end: 2.3, crop },
      { id: "new", start: 2.6, end: 10, crop },
    ]);
    expect(source[0].end).toBe(10);
  });
  it("unions overlapping cuts instead of removing footage twice", () => {
    expect(
      cutTranscriptRanges(
        source,
        [
          { start: 1, end: 4 },
          { start: 3, end: 6 },
          { start: 6, end: 7 },
        ],
        () => "after",
      ),
    ).toEqual([
      { ...source[0], end: 1 },
      { ...source[0], id: "after", start: 7 },
    ]);
  });
  it("shows words in reordered playback order, including repeated source occurrences", () => {
    const clips = [
      { id: "late", start: 3, end: 5 },
      { id: "early", start: 0, end: 3 },
      { id: "repeat", start: 3, end: 5 },
    ];
    const occurrences = transcriptOccurrences(clips, transcript.words);
    expect(occurrences.map((item) => [item.clipId, item.word.text])).toEqual([
      ["late", "world"],
      ["early", "Hello"],
      ["early", "um,"],
      ["repeat", "world"],
    ]);
    const selection = selectionCuts(occurrences, new Set([occurrences[0].key]));
    const result = cutTranscriptRanges(clips, selection);
    expect(result).toEqual([
      { id: "late", start: 4, end: 5 },
      clips[1],
      clips[2],
    ]);
  });
  it("removes gaps within a contiguous selection but preserves unselected words", () => {
    const occurrences = transcriptOccurrences(source, transcript.words);
    expect(
      selectionCuts(
        occurrences,
        new Set([occurrences[0].key, occurrences[1].key]),
      ),
    ).toEqual([{ clipId: "first", start: 1, end: 2.6 }]);
    expect(
      selectionCuts(
        occurrences,
        new Set([occurrences[0].key, occurrences[2].key]),
      ),
    ).toEqual([
      { clipId: "first", start: 1, end: 2 },
      { clipId: "first", start: 3, end: 4 },
    ]);
  });
  it("applies source silence ranges to every occurrence while retaining each crop", () => {
    const clips = [
      { id: "a", start: 0, end: 4, crop },
      { id: "b", start: 0, end: 4, crop: { ...crop, x: 0.1 } },
    ];
    let id = 0;
    const result = cutTranscriptRanges(
      clips,
      [{ start: 1, end: 2 }],
      () => `split-${++id}`,
    );
    expect(
      result.map((clip) => [clip.id, clip.start, clip.end, clip.crop?.x]),
    ).toEqual([
      ["a", 0, 1, 0.2],
      ["split-1", 2, 4, 0.2],
      ["b", 0, 1, 0.1],
      ["split-2", 2, 4, 0.1],
    ]);
  });
  it("retains short spoken remnants but prevents deleting the whole timeline", () => {
    expect(
      cutTranscriptRanges(
        [{ id: "short", start: 0, end: 1 }],
        [{ start: 0.03, end: 0.5 }],
        () => "tail",
      )[0],
    ).toEqual({ id: "short", start: 0, end: 0.03 });
    expect(() =>
      cutTranscriptRanges(source, [{ start: 0, end: 9.95 }]),
    ).toThrow("whole video");
    expect(() => cutTranscriptRanges(source, [{ start: 0, end: 10 }])).toThrow(
      "whole video",
    );
    expect(cutTranscriptRanges(source, [{ start: 30, end: 40 }])).toEqual(
      source,
    );
  });
  it("uses conservative exact fillers, keeping content words and longer sounds", () => {
    expect(["um", "Uh,", "(erm)", "er", "hmm!"].every(isFillerWord)).toBe(true);
    expect(
      ["like", "so", "actually", "umm", "summer", "um-um"].some(isFillerWord),
    ).toBe(false);
  });
});

describe("corrected transcript import", () => {
  it("accepts bounded word data and strips unrelated fields", () => {
    expect(validateTranscript({ ...transcript, extra: "ignored" }, 10)).toEqual(
      transcript,
    );
  });
  it("rejects out-of-video, reversed, duplicate, unordered, and non-numeric timings", () => {
    for (const words of [
      [{ id: "bad", text: "bad", start: -1, end: 1 }],
      [{ id: "bad", text: "bad", start: 9, end: 11 }],
      [{ id: "bad", text: "bad", start: 3, end: 2 }],
      [{ id: "bad", text: "bad", start: "1", end: 2 }],
      [transcript.words[0], transcript.words[0]],
      [transcript.words[2], transcript.words[0]],
    ])
      expect(() => validateTranscript({ ...transcript, words }, 10)).toThrow();
  });
  it("retains instantaneous model words for seeking without inventing cut duration", () => {
    const data = validateTranscript(
      {
        ...transcript,
        words: [{ id: "instant", text: "uh", start: 2, end: 2 }],
      },
      10,
    );
    const occurrences = transcriptOccurrences(source, data.words);
    expect(occurrences).toHaveLength(1);
    expect(
      cutTranscriptRanges(
        source,
        selectionCuts(occurrences, new Set([occurrences[0].key])),
      ),
    ).toEqual(source);
  });
});
