import { describe, expect, it } from "vitest";
import { detectSilences } from "./audio-analysis";

const rate = 16_000;
function signal(parts: { duration: number; amplitude: number }[]) {
  const samples = new Float32Array(
    Math.round(parts.reduce((total, part) => total + part.duration, 0) * rate),
  );
  let offset = 0;
  for (const part of parts) {
    const end = offset + Math.round(part.duration * rate);
    for (let index = offset; index < end; index++)
      samples[index] =
        part.amplitude * Math.sin((2 * Math.PI * 200 * index) / rate);
    offset = end;
  }
  return samples;
}

describe("detectSilences", () => {
  it("preserves padding around speech without retaining padding at the file edges", () => {
    const ranges = detectSilences(
      signal([
        { duration: 0.7, amplitude: 0 },
        { duration: 1, amplitude: 0.3 },
        { duration: 0.8, amplitude: 0 },
        { duration: 1, amplitude: 0.3 },
        { duration: 0.7, amplitude: 0 },
      ]),
      rate,
      { padding: 0.1 },
    );
    expect(ranges).toHaveLength(3);
    expect(ranges[0].start).toBe(0);
    expect(ranges[0].end).toBeCloseTo(0.6, 5);
    expect(ranges[1].start).toBeCloseTo(1.8, 5);
    expect(ranges[1].end).toBeCloseTo(2.4, 5);
    expect(ranges[2].start).toBeCloseTo(3.6, 5);
    expect(ranges[2].end).toBeCloseTo(4.2, 5);
  });

  it("keeps short pauses and never bridges a speech burst", () => {
    const ranges = detectSilences(
      signal([
        { duration: 0.4, amplitude: 0 },
        { duration: 0.1, amplitude: 0.5 },
        { duration: 0.49, amplitude: 0 },
        { duration: 0.1, amplitude: 0.5 },
        { duration: 0.6, amplitude: 0 },
      ]),
      rate,
      { minDuration: 0.5, padding: 0 },
    );
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toBeCloseTo(1.09, 5);
    expect(ranges[0].end).toBeCloseTo(1.69, 5);
  });

  it("uses RMS dB rather than peak amplitude or signed average", () => {
    const samples = signal([{ duration: 1, amplitude: 0.012 }]);
    expect(detectSilences(samples, rate, { thresholdDb: -40 })).toEqual([
      { start: 0, end: 1 },
    ]);
    expect(detectSilences(samples, rate, { thresholdDb: -45 })).toEqual([]);
    const alternating = new Float32Array(rate).map((_, index) =>
      index % 2 ? 0.5 : -0.5,
    );
    expect(detectSilences(alternating, rate)).toEqual([]);
  });

  it("handles fully silent audio, final partial windows, and empty input", () => {
    expect(detectSilences(new Float32Array(16007), rate)).toEqual([
      { start: 0, end: 16007 / rate },
    ]);
    expect(detectSilences(new Float32Array(), rate)).toEqual([]);
  });

  it("does not return negative ranges when padding consumes the pause", () => {
    const samples = signal([
      { duration: 1, amplitude: 0.3 },
      { duration: 0.5, amplitude: 0 },
      { duration: 1, amplitude: 0.3 },
    ]);
    expect(detectSilences(samples, rate, { padding: 0.3 })).toEqual([]);
  });

  it("rejects invalid input rather than classifying corrupted samples as silence", () => {
    expect(() => detectSilences(new Float32Array([NaN]), rate)).toThrow(
      "invalid samples",
    );
    expect(() => detectSilences(new Float32Array(20), 0)).toThrow(
      "Sample rate",
    );
    expect(() =>
      detectSilences(new Float32Array(20), rate, { thresholdDb: 1 }),
    ).toThrow("threshold");
    expect(() =>
      detectSilences(new Float32Array(20), rate, { minDuration: 0 }),
    ).toThrow("Minimum");
    expect(() =>
      detectSilences(new Float32Array(20), rate, { padding: -1 }),
    ).toThrow("padding");
  });
});
