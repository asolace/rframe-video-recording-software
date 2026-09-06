import type { Clip } from "../types";

export const MIN_CLIP = 0.1;
export function timelineDuration(clips: Clip[]): number {
  return clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.end - clip.start),
    0,
  );
}
export function splitClip(
  clips: Clip[],
  id: string,
  at: number,
  newId: string,
): Clip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0) return clips;
  const clip = clips[index];
  if (at - clip.start < MIN_CLIP || clip.end - at < MIN_CLIP) return clips;
  return [
    ...clips.slice(0, index),
    { ...clip, end: at },
    { id: newId, start: at, end: clip.end },
    ...clips.slice(index + 1),
  ];
}
export function removeClip(clips: Clip[], id: string): Clip[] {
  return clips.length <= 1 ? clips : clips.filter((clip) => clip.id !== id);
}
export function moveClip(clips: Clip[], id: string, direction: -1 | 1): Clip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= clips.length) return clips;
  const next = [...clips];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
export function trimClip(
  clips: Clip[],
  id: string,
  edge: "start" | "end",
  value: number,
  duration: number,
): Clip[] {
  if (!Number.isFinite(value)) return clips;
  return clips.map((clip) => {
    if (clip.id !== id) return clip;
    return edge === "start"
      ? { ...clip, start: Math.max(0, Math.min(value, clip.end - MIN_CLIP)) }
      : {
          ...clip,
          end: Math.min(duration, Math.max(value, clip.start + MIN_CLIP)),
        };
  });
}
export function sourceToTimeline(
  clips: Clip[],
  index: number,
  sourceTime: number,
): number {
  const clip = clips[index];
  if (!clip) return 0;
  return (
    timelineDuration(clips.slice(0, index)) +
    Math.max(0, Math.min(sourceTime - clip.start, clip.end - clip.start))
  );
}
export function timelineToSource(
  clips: Clip[],
  time: number,
): { index: number; time: number } {
  let remaining = Math.max(0, time);
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const length = Math.max(0, clip.end - clip.start);
    if (remaining < length || index === clips.length - 1)
      return { index, time: clip.start + Math.min(remaining, length) };
    remaining -= length;
  }
  return { index: 0, time: 0 };
}
