import { describe, expect, it } from "vitest";
import {
  moveClip,
  removeClip,
  sourceToTimeline,
  splitClip,
  timelineDuration,
  timelineToSource,
  trimClip,
} from "./timeline";

describe("non-destructive timeline", () => {
  const clips = [
    { id: "a", start: 2, end: 8 },
    { id: "b", start: 12, end: 16 },
  ];
  it("splits without losing duration or changing source intervals", () => {
    const split = splitClip(clips, "a", 5, "c");
    expect(split).toEqual([
      { id: "a", start: 2, end: 5 },
      { id: "c", start: 5, end: 8 },
      clips[1],
    ]);
    expect(timelineDuration(split)).toBe(10);
    expect(clips[0].end).toBe(8);
    expect(splitClip(clips, "a", 2.01, "c")).toBe(clips);
  });
  it("maps a reordered timeline to the correct original source positions", () => {
    const reordered = moveClip(clips, "b", -1);
    expect(timelineToSource(reordered, 5)).toEqual({ index: 1, time: 3 });
    expect(sourceToTimeline(reordered, 1, 3)).toBe(5);
    expect(timelineToSource(reordered, 4)).toEqual({ index: 1, time: 2 });
    expect(timelineToSource(reordered, 100)).toEqual({ index: 1, time: 8 });
  });
  it("keeps crop on both split fragments and supports short speech fragments", () => {
    const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
    expect(
      splitClip([{ ...clips[0], crop }], "a", 5, "c").map((clip) => clip.crop),
    ).toEqual([crop, crop]);
    const short = [{ id: "word-tail", start: 0, end: 0.04 }];
    expect(trimClip(short, "word-tail", "start", 0, 20)).toEqual(short);
    expect(trimClip(short, "word-tail", "end", 0.02, 20)).toEqual(short);
  });
  it("keeps trims within source bounds and prevents empty clips", () => {
    expect(trimClip(clips, "a", "start", -12, 20)[0].start).toBe(0);
    expect(trimClip(clips, "a", "start", 12, 20)[0].start).toBe(7.9);
    expect(trimClip(clips, "b", "end", 100, 20)[1].end).toBe(20);
    expect(trimClip(clips, "b", "end", 0, 20)[1].end).toBe(12.1);
  });
  it("preserves at least one clip and rejects moves outside the sequence", () => {
    expect(removeClip(clips, "a")).toEqual([clips[1]]);
    expect(removeClip([clips[0]], "a")).toEqual([clips[0]]);
    expect(moveClip(clips, "a", -1)).toBe(clips);
    expect(moveClip(clips, "b", 1)).toBe(clips);
  });
});
