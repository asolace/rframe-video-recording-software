import type { CropRect } from "../types";

export const MIN_CROP_SIZE = 0.05;
export type CropCorner = "nw" | "ne" | "sw" | "se";
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));
const finite = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? value! : fallback;

/** Invalid stored or user-provided coordinates can never draw outside the source. */
export function normalizeCrop(crop?: CropRect): CropRect {
  const width = clamp(finite(crop?.width, 1), MIN_CROP_SIZE, 1);
  const height = clamp(finite(crop?.height, 1), MIN_CROP_SIZE, 1);
  return {
    x: clamp(finite(crop?.x, 0), 0, 1 - width),
    y: clamp(finite(crop?.y, 0), 0, 1 - height),
    width,
    height,
  };
}

export function isFullCrop(crop?: CropRect): boolean {
  const box = normalizeCrop(crop);
  return box.x === 0 && box.y === 0 && box.width === 1 && box.height === 1;
}

export function moveCrop(crop: CropRect, dx: number, dy: number): CropRect {
  const box = normalizeCrop(crop);
  return normalizeCrop({
    ...box,
    x: box.x + finite(dx, 0),
    y: box.y + finite(dy, 0),
  });
}

/** Moves one corner while keeping the diagonally opposite corner stationary. */
export function resizeCrop(
  crop: CropRect,
  corner: CropCorner,
  dx: number,
  dy: number,
): CropRect {
  const box = normalizeCrop(crop);
  let left = box.x;
  let top = box.y;
  let right = left + box.width;
  let bottom = top + box.height;
  if (corner.includes("w"))
    left = clamp(left + finite(dx, 0), 0, right - MIN_CROP_SIZE);
  else right = clamp(right + finite(dx, 0), left + MIN_CROP_SIZE, 1);
  if (corner.includes("n"))
    top = clamp(top + finite(dy, 0), 0, bottom - MIN_CROP_SIZE);
  else bottom = clamp(bottom + finite(dy, 0), top + MIN_CROP_SIZE, 1);
  return normalizeCrop({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

export function updateCropField(
  crop: CropRect,
  field: keyof CropRect,
  value: number,
): CropRect {
  const box = normalizeCrop(crop);
  if (!Number.isFinite(value)) return box;
  if (field === "width")
    return { ...box, width: clamp(value, MIN_CROP_SIZE, 1 - box.x) };
  if (field === "height")
    return { ...box, height: clamp(value, MIN_CROP_SIZE, 1 - box.y) };
  return normalizeCrop({ ...box, [field]: value });
}

/** Preset ratio is expressed in source pixels, not normalized coordinates. */
export function cropForAspect(
  ratio: number,
  sourceWidth: number,
  sourceHeight: number,
  crop?: CropRect,
): CropRect {
  if (!Number.isFinite(ratio) || ratio <= 0) return normalizeCrop();
  const sourceRatio =
    Math.max(1, finite(sourceWidth, 1920)) /
    Math.max(1, finite(sourceHeight, 1080));
  const normalizedRatio = ratio / sourceRatio;
  const width = normalizedRatio < 1 ? normalizedRatio : 1;
  const height = normalizedRatio < 1 ? 1 : 1 / normalizedRatio;
  const current = normalizeCrop(crop);
  return normalizeCrop({
    x: current.x + current.width / 2 - width / 2,
    y: current.y + current.height / 2 - height / 2,
    width,
    height,
  });
}

export function cropSourceRect(
  crop: CropRect | undefined,
  sourceWidth: number,
  sourceHeight: number,
) {
  const box = normalizeCrop(crop);
  return {
    x: box.x * sourceWidth,
    y: box.y * sourceHeight,
    width: box.width * sourceWidth,
    height: box.height * sourceHeight,
  };
}
