export type RecordingMode = "camera" | "screen" | "screen-camera" | "import";

export interface Clip {
  id: string;
  start: number;
  end: number;
}
export interface EditState {
  clips: Clip[];
  muted: boolean;
  volume: number;
  title: string;
  aspectRatio: "original" | "16:9" | "9:16" | "1:1";
}
export interface Project {
  id: string;
  name: string;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  duration: number;
  thumbnail: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  mode: RecordingMode;
  favorite: boolean;
  edits: EditState;
}
export interface Folder {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}
export interface RecordingResult {
  blob: Blob;
  duration: number;
  thumbnail: string;
  width: number;
  height: number;
  mode: RecordingMode;
}
