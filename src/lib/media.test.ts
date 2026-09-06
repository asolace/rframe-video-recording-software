import { describe, expect, it } from "vitest";
import { readVideoMetadata } from "./media";

describe("video imports", () => {
  it("rejects an empty video before attempting browser decoding", async () => {
    await expect(
      readVideoMetadata(new Blob([], { type: "video/mp4" })),
    ).rejects.toThrow("empty");
  });

  it("rejects non-video files before attempting browser decoding", async () => {
    await expect(
      readVideoMetadata(new Blob(["not a video"], { type: "text/plain" })),
    ).rejects.toThrow("choose a video file");
  });
});
