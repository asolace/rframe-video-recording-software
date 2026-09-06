import { describe, expect, it } from "vitest";
import {
  cropForAspect,
  cropSourceRect,
  isFullCrop,
  moveCrop,
  normalizeCrop,
  resizeCrop,
  updateCropField,
} from "./crop";

describe("source-relative cropping", () => {
  it("keeps malformed rectangles finite, within the source, and nonempty", () => {
    expect(normalizeCrop()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(
      normalizeCrop({ x: Infinity, y: -4, width: NaN, height: 0 }),
    ).toEqual({ x: 0, y: 0, width: 1, height: 0.05 });
    const bounded = normalizeCrop({
      x: 0.99,
      y: 0.95,
      width: 0.8,
      height: 0.5,
    });
    expect(bounded.x + bounded.width).toBeLessThanOrEqual(1);
    expect(bounded.y + bounded.height).toBeLessThanOrEqual(1);
  });
  it("pans without changing selection size or modifying the original", () => {
    const crop = { x: 0.2, y: 0.1, width: 0.4, height: 0.5 };
    expect(moveCrop(crop, 10, -10)).toEqual({
      x: 0.6,
      y: 0,
      width: 0.4,
      height: 0.5,
    });
    expect(crop.x).toBe(0.2);
  });
  it("resizes from a corner while preserving the opposite corner", () => {
    const resized = resizeCrop(
      { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
      "nw",
      0.1,
      0.15,
    );
    expect(resized.x).toBeCloseTo(0.3);
    expect(resized.y).toBeCloseTo(0.35);
    expect(resized.x + resized.width).toBeCloseTo(0.7);
    expect(resized.y + resized.height).toBeCloseTo(0.7);
    const minimum = resizeCrop(resized, "se", -10, -10);
    expect(minimum.width).toBeCloseTo(0.05);
    expect(minimum.height).toBeCloseTo(0.05);
  });
  it("fits aspect presets in actual source pixel coordinates", () => {
    const square = cropSourceRect(cropForAspect(1, 1920, 1080), 1920, 1080);
    expect(square.width).toBe(1080);
    expect(square.height).toBe(1080);
    expect(square.x).toBe(420);
    const portrait = cropSourceRect(
      cropForAspect(9 / 16, 1920, 1080),
      1920,
      1080,
    );
    expect(portrait.width / portrait.height).toBeCloseTo(9 / 16);
    expect(portrait.x + portrait.width / 2).toBeCloseTo(960);
  });
  it("numeric resizing preserves position and respects available space", () => {
    const box = { x: 0.6, y: 0.25, width: 0.3, height: 0.5 };
    expect(updateCropField(box, "width", 1)).toEqual({ ...box, width: 0.4 });
    expect(updateCropField(box, "height", -1)).toEqual({
      ...box,
      height: 0.05,
    });
    expect(isFullCrop(undefined)).toBe(true);
    expect(isFullCrop(box)).toBe(false);
  });
});
