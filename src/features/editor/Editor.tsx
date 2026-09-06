import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  LoaderCircle,
  Maximize,
  Pause,
  Play,
  Redo2,
  Save,
  Scissors,
  SkipBack,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { EditState, Project } from "../../types";
import {
  drawVideoFrame,
  exportVideo,
  outputDimensions,
} from "../../lib/export-video";
import {
  MIN_CLIP,
  moveClip,
  removeClip,
  sourceToTimeline,
  splitClip,
  timelineDuration,
  timelineToSource,
  trimClip,
} from "../../lib/timeline";
import "./editor.css";

interface Props {
  project: Project;
  blob: Blob;
  onSave: (edits: EditState, name: string) => Promise<void>;
  onBack: () => void;
}
const timecode = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, seconds) % 60)
    .toString()
    .padStart(2, "0")}.${Math.floor((Math.max(0, seconds) % 1) * 10)}`;
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const fileName = (name: string) =>
  name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() ||
  "Untitled recording";

export default function Editor({ project, blob, onSave, onBack }: Props) {
  const initial = {
    ...project.edits,
    clips: project.edits.clips.length
      ? project.edits.clips
      : [
          {
            id: crypto.randomUUID(),
            start: 0,
            end: Math.max(MIN_CLIP, project.duration),
          },
        ],
  };
  const [edits, setEdits] = useState<EditState>(initial);
  const [past, setPast] = useState<EditState[]>([]);
  const [future, setFuture] = useState<EditState[]>([]);
  const [name, setName] = useState(project.name);
  const [saved, setSaved] = useState(
    JSON.stringify({ edits: initial, name: project.name }),
  );
  const [selectedId, setSelectedId] = useState(initial.clips[0].id);
  const [sourceTime, setSourceTime] = useState(initial.clips[0].start);
  const [duration, setDuration] = useState(project.duration);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [url, setUrl] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editsRef = useRef(edits);
  const activeRef = useRef(0);
  const transitioningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const cancelExportRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  editsRef.current = edits;
  const selectedIndex = Math.max(
    0,
    edits.clips.findIndex((clip) => clip.id === selectedId),
  );
  const selectedClip = edits.clips[selectedIndex];
  const total = timelineDuration(edits.clips);
  const editedTime = sourceToTimeline(edits.clips, selectedIndex, sourceTime);
  const dimensions = outputDimensions(
    project.width,
    project.height,
    edits.aspectRatio,
  );
  const dirty = saved !== JSON.stringify({ edits, name });
  const busy = saving || exporting;

  useEffect(() => {
    if (!dirty && !exporting) return;
    const protectChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectChanges);
    return () => window.removeEventListener("beforeunload", protectChanges);
  }, [dirty, exporting]);
  useEffect(() => {
    if (!exporting) return;
    cancelExportRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.preventDefault();
        cancelExportRef.current?.focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        abortRef.current?.abort();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      exportButtonRef.current?.focus();
    };
  }, [exporting]);

  useEffect(() => {
    mountedRef.current = true;
    const nextUrl = URL.createObjectURL(blob);
    setUrl(nextUrl);
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      URL.revokeObjectURL(nextUrl);
    };
  }, [blob]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = edits.volume;
      video.muted = edits.muted;
    }
  }, [edits.volume, edits.muted, url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    let frame = 0;
    let lastUpdate = 0;
    const render = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas) drawVideoFrame(canvas, video, editsRef.current.title);
      if (now - lastUpdate > 70) {
        setSourceTime(video.currentTime);
        lastUpdate = now;
      }
      const clips = editsRef.current.clips;
      const clip = clips[activeRef.current];
      if (
        !video.paused &&
        clip &&
        !transitioningRef.current &&
        video.currentTime >= clip.end - 0.025
      ) {
        if (activeRef.current < clips.length - 1) {
          transitioningRef.current = true;
          activeRef.current += 1;
          const next = clips[activeRef.current];
          setSelectedId(next.id);
          video.currentTime = next.start;
        } else {
          video.pause();
          setPlaying(false);
        }
      }
      frame = requestAnimationFrame(render);
    };
    const seeked = () => {
      transitioningRef.current = false;
    };
    const ended = () => {
      const clips = editsRef.current.clips;
      if (activeRef.current < clips.length - 1) {
        activeRef.current += 1;
        const next = clips[activeRef.current];
        setSelectedId(next.id);
        video.currentTime = next.start;
        void video.play().catch(() => setPlaying(false));
      } else setPlaying(false);
    };
    video.addEventListener("seeked", seeked);
    video.addEventListener("ended", ended);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener("seeked", seeked);
      video.removeEventListener("ended", ended);
    };
  }, [url]);

  const pause = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
  }, []);
  const seekTo = useCallback((index: number, time: number) => {
    const clip = editsRef.current.clips[index];
    if (!clip) return;
    activeRef.current = index;
    transitioningRef.current = false;
    setSelectedId(clip.id);
    setSourceTime(time);
    if (videoRef.current) videoRef.current.currentTime = time;
  }, []);
  function change(next: EditState) {
    if (JSON.stringify(next) === JSON.stringify(edits)) return;
    pause();
    setPast((previous) => [...previous.slice(-79), edits]);
    setFuture([]);
    setEdits(next);
    const index = Math.max(
      0,
      next.clips.findIndex((clip) => clip.id === selectedId),
    );
    activeRef.current = index;
    const clip = next.clips[index];
    setSelectedId(clip.id);
    const nextTime = Math.max(
      clip.start,
      Math.min(videoRef.current?.currentTime ?? clip.start, clip.end),
    );
    if (videoRef.current) videoRef.current.currentTime = nextTime;
    setSourceTime(nextTime);
    setNotice("");
  }
  function restore(next: EditState) {
    pause();
    setEdits(next);
    activeRef.current = 0;
    setSelectedId(next.clips[0].id);
    if (videoRef.current) videoRef.current.currentTime = next.clips[0].start;
    setSourceTime(next.clips[0].start);
  }
  function undo() {
    if (!past.length) return;
    setFuture((previous) => [edits, ...previous]);
    restore(past[past.length - 1]);
    setPast((previous) => previous.slice(0, -1));
  }
  function redo() {
    if (!future.length) return;
    setPast((previous) => [...previous, edits]);
    restore(future[0]);
    setFuture((previous) => previous.slice(1));
  }
  async function togglePlay() {
    const video = videoRef.current;
    if (!video || !ready || busy) return;
    if (!video.paused) {
      pause();
      return;
    }
    if (video.currentTime >= edits.clips[activeRef.current].end - 0.03)
      seekTo(0, edits.clips[0].start);
    try {
      await video.play();
      setPlaying(true);
    } catch {
      setError(
        "Preview could not start. Try selecting a clip or reopening the project.",
      );
    }
  }
  async function save(): Promise<boolean> {
    setSaving(true);
    setError("");
    try {
      const cleanName = name.trim() || "Untitled recording";
      await onSave(edits, cleanName);
      setName(cleanName);
      setSaved(JSON.stringify({ edits, name: cleanName }));
      setNotice("Edits saved");
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save your edits.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function leave() {
    pause();
    if (!dirty || (await save())) onBack();
  }
  async function startExport() {
    pause();
    if (dirty && !(await save())) return;
    setExporting(true);
    setProgress(0);
    setError("");
    setNotice("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await exportVideo({
        source: blob,
        edits,
        width: project.width,
        height: project.height,
        signal: controller.signal,
        onProgress: setProgress,
      });
      download(
        result,
        `${fileName(name)}.${result.type.includes("mp4") ? "mp4" : "webm"}`,
      );
      if (mountedRef.current)
        setNotice("Your edited video is ready. Download started.");
    } catch (cause) {
      if (mountedRef.current) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          setNotice("Export cancelled. Your edits are saved.");
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "The video could not be exported.",
          );
      }
    } finally {
      if (mountedRef.current) setExporting(false);
      abortRef.current = null;
    }
  }
  function trim(edge: "start" | "end", value: number) {
    change({
      ...edits,
      clips: trimClip(edits.clips, selectedClip.id, edge, value, duration),
    });
  }
  function split() {
    change({
      ...edits,
      clips: splitClip(
        edits.clips,
        selectedClip.id,
        sourceTime,
        crypto.randomUUID(),
      ),
    });
  }
  const canSplit =
    sourceTime - selectedClip.start >= MIN_CLIP &&
    selectedClip.end - sourceTime >= MIN_CLIP;

  return (
    <>
      <div className="ed-workspace" inert={exporting}>
        <header className="ed-header">
          <button
            className="ed-icon ed-back"
            onClick={() => void leave()}
            disabled={busy}
            aria-label="Save and return to projects"
          >
            <ArrowLeft size={19} />
          </button>
          <span className="ed-header-divider" />
          <div className="ed-project-name">
            <input
              aria-label="Project name"
              value={name}
              maxLength={100}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <span>
              <span className={`ed-status-dot ${dirty ? "is-dirty" : ""}`} />
              {dirty ? "Unsaved changes" : "Saved on this device"}
            </span>
          </div>
          <div className="ed-header-actions">
            <button
              className="ed-button ed-save"
              aria-label="Save edits"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {saving ? (
                <LoaderCircle size={16} className="ed-spin" />
              ) : (
                <Save size={16} />
              )}
              <span>Save edits</span>
            </button>
            <button
              ref={exportButtonRef}
              className="ed-button ed-primary"
              disabled={busy || !ready}
              onClick={() => void startExport()}
            >
              <ArrowDownToLine size={17} /> Export video
            </button>
          </div>
        </header>

        {(error || notice) && (
          <div
            className={`ed-message ${error ? "ed-error" : ""}`}
            role={error ? "alert" : "status"}
          >
            {error || (
              <>
                <Check size={16} />
                {notice}
              </>
            )}
            <button
              aria-label="Dismiss message"
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}

        <main className="ed-main">
          <section className="ed-preview-panel" aria-label="Video preview">
            <div className="ed-panel-heading">
              <span>
                <span className="ed-preview-dot" /> PREVIEW
              </span>
              <span>
                {dimensions.width} × {dimensions.height}
                <span className="ed-heading-dot">·</span>
                {edits.aspectRatio === "original"
                  ? "Original"
                  : edits.aspectRatio}
              </span>
            </div>
            <div className="ed-preview-space">
              <div
                className="ed-canvas-shell"
                style={{
                  aspectRatio: `${dimensions.width} / ${dimensions.height}`,
                }}
              >
                <canvas
                  ref={canvasRef}
                  width={dimensions.width}
                  height={dimensions.height}
                  aria-label={`Video preview${edits.title ? ` with title ${edits.title}` : ""}`}
                />
                {!ready && (
                  <div className="ed-loading">
                    <LoaderCircle className="ed-spin" size={25} />
                    <span>Loading your recording</span>
                  </div>
                )}
                <button
                  className={`ed-preview-play ${playing ? "is-playing" : ""}`}
                  onClick={() => void togglePlay()}
                  aria-label={playing ? "Pause video" : "Play video"}
                  disabled={!ready || busy}
                >
                  {playing ? (
                    <Pause size={24} fill="currentColor" />
                  ) : (
                    <Play size={24} fill="currentColor" />
                  )}
                </button>
              </div>
            </div>
            <video
              ref={videoRef}
              src={url || undefined}
              preload="auto"
              playsInline
              className="ed-source-video"
              onLoadedData={() => {
                const video = videoRef.current;
                if (!video) return;
                if (Number.isFinite(video.duration) && video.duration > 0)
                  setDuration(video.duration);
                video.currentTime = editsRef.current.clips[0].start;
                setReady(true);
              }}
              onError={() =>
                setError(
                  "This browser could not open the recording. Try Chrome or Edge, or import a supported video.",
                )
              }
            />
            <div className="ed-transport">
              <div className="ed-playback-buttons">
                <button
                  className="ed-icon"
                  onClick={() => {
                    pause();
                    seekTo(0, edits.clips[0].start);
                  }}
                  aria-label="Return to start"
                  disabled={!ready || busy}
                >
                  <SkipBack size={17} />
                </button>
                <button
                  className="ed-play-button"
                  onClick={() => void togglePlay()}
                  aria-label={playing ? "Pause" : "Play"}
                  disabled={!ready || busy}
                >
                  {playing ? (
                    <Pause size={19} fill="currentColor" />
                  ) : (
                    <Play size={19} fill="currentColor" />
                  )}
                </button>
                <span className="ed-time">
                  <b>{timecode(editedTime)}</b>
                  <span>/</span>
                  {timecode(total)}
                </span>
              </div>
              <button
                className="ed-icon"
                aria-label="Fullscreen preview"
                onClick={() =>
                  void canvasRef.current
                    ?.requestFullscreen()
                    .catch(() =>
                      setNotice("Fullscreen is unavailable in this browser."),
                    )
                }
              >
                <Maximize size={16} />
              </button>
            </div>
          </section>

          <aside className="ed-inspector">
            <div className="ed-inspector-heading">
              <h2>Video settings</h2>
              <span>Make it yours</span>
            </div>
            <fieldset disabled={busy}>
              <section className="ed-setting">
                <h3>
                  <Film size={16} /> Canvas
                </h3>
                <span className="ed-label" id="ed-aspect-label">
                  Aspect ratio
                </span>
                <div
                  className="ed-aspect-options"
                  role="group"
                  aria-labelledby="ed-aspect-label"
                >
                  {(["original", "16:9", "9:16", "1:1"] as const).map(
                    (ratio) => (
                      <button
                        key={ratio}
                        className={
                          edits.aspectRatio === ratio ? "is-active" : ""
                        }
                        aria-pressed={edits.aspectRatio === ratio}
                        onClick={() => change({ ...edits, aspectRatio: ratio })}
                      >
                        <span
                          className={`ed-ratio-shape ed-ratio-${ratio.replace(":", "-")}`}
                        />
                        <span>{ratio === "original" ? "Original" : ratio}</span>
                      </button>
                    ),
                  )}
                </div>
                <p className="ed-hint">
                  Your full video stays in frame. Extra space is filled with
                  black.
                </p>
              </section>
              <section className="ed-setting">
                <h3>
                  <Volume2 size={16} /> Audio
                </h3>
                <div className="ed-setting-row">
                  <label htmlFor="ed-mute">Mute video</label>
                  <button
                    id="ed-mute"
                    role="switch"
                    aria-checked={edits.muted}
                    className={`ed-switch ${edits.muted ? "is-on" : ""}`}
                    onClick={() => change({ ...edits, muted: !edits.muted })}
                  >
                    <span />
                  </button>
                </div>
                <label
                  className="ed-setting-row ed-volume-label"
                  htmlFor="ed-volume"
                >
                  <span>Volume</span>
                  <b>
                    {edits.muted
                      ? "Muted"
                      : `${Math.round(edits.volume * 100)}%`}
                  </b>
                </label>
                <div className="ed-volume">
                  {edits.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  <input
                    id="ed-volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={edits.volume}
                    disabled={edits.muted}
                    onChange={(event) =>
                      change({ ...edits, volume: Number(event.target.value) })
                    }
                  />
                </div>
              </section>
              <section className="ed-setting">
                <h3>
                  <Type size={16} /> Title overlay
                </h3>
                <label className="ed-label" htmlFor="ed-title">
                  A little context for your video
                </label>
                <textarea
                  id="ed-title"
                  value={edits.title}
                  maxLength={100}
                  rows={3}
                  placeholder="Add a title…"
                  onChange={(event) =>
                    change({ ...edits, title: event.target.value })
                  }
                />
                <div className="ed-hint ed-title-hint">
                  <span>Appears throughout the video</span>
                  <span>{edits.title.length}/100</span>
                </div>
              </section>
              <section className="ed-setting ed-original">
                <span>Original recording</span>
                <p>
                  {project.width || "—"} × {project.height || "—"} ·{" "}
                  {(blob.size / 1024 / 1024).toFixed(1)} MB
                </p>
                <button
                  className="ed-text-button"
                  onClick={() =>
                    download(
                      blob,
                      `${fileName(name)}-original.${blob.type.includes("mp4") ? "mp4" : blob.type.includes("quicktime") ? "mov" : "webm"}`,
                    )
                  }
                >
                  <Download size={14} /> Download original
                </button>
              </section>
            </fieldset>
          </aside>
        </main>

        <section className="ed-timeline" aria-label="Video timeline">
          <div className="ed-timeline-top">
            <div>
              <h2>Timeline</h2>
              <span>
                {edits.clips.length}{" "}
                {edits.clips.length === 1 ? "clip" : "clips"}
                <span className="ed-heading-dot">·</span>
                {timecode(total)}
              </span>
            </div>
            <div className="ed-edit-tools">
              <button
                className="ed-icon"
                onClick={undo}
                disabled={!past.length || busy}
                aria-label="Undo edit"
              >
                <Undo2 size={17} />
              </button>
              <button
                className="ed-icon"
                onClick={redo}
                disabled={!future.length || busy}
                aria-label="Redo edit"
              >
                <Redo2 size={17} />
              </button>
              <span className="ed-tool-divider" />
              <button
                className="ed-button ed-split"
                onClick={split}
                disabled={!canSplit || busy}
              >
                <Scissors size={15} />
                Split at playhead
              </button>
              <button
                className="ed-icon"
                onClick={() =>
                  change({
                    ...edits,
                    clips: removeClip(edits.clips, selectedClip.id),
                  })
                }
                disabled={edits.clips.length <= 1 || busy}
                aria-label="Delete selected clip"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
          <div className="ed-seek-ruler">
            <span>{timecode(0)}</span>
            <span>{timecode(total / 4)}</span>
            <span>{timecode(total / 2)}</span>
            <span>{timecode((total * 3) / 4)}</span>
            <span>{timecode(total)}</span>
          </div>
          <div className="ed-track">
            <div className="ed-track-label">
              <Film size={17} />
              <span>Video</span>
            </div>
            <div className="ed-track-clips">
              {edits.clips.map((clip, index) => (
                <button
                  key={clip.id}
                  className={`ed-clip ${selectedId === clip.id ? "is-selected" : ""}`}
                  style={{
                    flexGrow: clip.end - clip.start,
                    backgroundImage: project.thumbnail
                      ? `linear-gradient(0deg, rgba(20, 21, 30, .88), rgba(20, 21, 30, .36)), url("${project.thumbnail}")`
                      : undefined,
                  }}
                  onClick={() => {
                    pause();
                    seekTo(index, clip.start);
                  }}
                  aria-label={`Select clip ${index + 1}, ${timecode(clip.end - clip.start)} long`}
                  aria-pressed={selectedId === clip.id}
                  disabled={busy}
                >
                  <span className="ed-clip-name">Clip {index + 1}</span>
                  <span className="ed-clip-length">
                    {timecode(clip.end - clip.start)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="ed-scrubber-row">
            <span />
            <input
              type="range"
              aria-label="Timeline playhead"
              min="0"
              max={Math.max(total, MIN_CLIP)}
              step="0.01"
              value={Math.min(total, editedTime)}
              disabled={!ready || busy}
              onChange={(event) => {
                pause();
                const position = timelineToSource(
                  edits.clips,
                  Number(event.target.value),
                );
                seekTo(position.index, position.time);
              }}
            />
          </div>
          <fieldset className="ed-trim-controls" disabled={busy}>
            <div className="ed-selected-label">
              <span className="ed-selected-dot" />
              <b>Clip {selectedIndex + 1}</b>
              <span>{timecode(selectedClip.end - selectedClip.start)}</span>
            </div>
            <div className="ed-trim-field">
              <label htmlFor="ed-trim-start">Start</label>
              <input
                id="ed-trim-start"
                aria-label="Clip start in seconds"
                type="number"
                min="0"
                max={Math.max(0, selectedClip.end - MIN_CLIP)}
                step="0.1"
                value={Number(selectedClip.start.toFixed(2))}
                onChange={(event) => trim("start", Number(event.target.value))}
              />
              <span>s</span>
              <input
                type="range"
                aria-label="Trim clip start"
                min="0"
                max={Math.max(0, selectedClip.end - MIN_CLIP)}
                step="0.01"
                value={selectedClip.start}
                onChange={(event) => trim("start", Number(event.target.value))}
              />
            </div>
            <div className="ed-trim-field">
              <label htmlFor="ed-trim-end">End</label>
              <input
                id="ed-trim-end"
                aria-label="Clip end in seconds"
                type="number"
                min={selectedClip.start + MIN_CLIP}
                max={duration}
                step="0.1"
                value={Number(selectedClip.end.toFixed(2))}
                onChange={(event) => trim("end", Number(event.target.value))}
              />
              <span>s</span>
              <input
                type="range"
                aria-label="Trim clip end"
                min={selectedClip.start + MIN_CLIP}
                max={Math.max(duration, selectedClip.start + MIN_CLIP)}
                step="0.01"
                value={selectedClip.end}
                onChange={(event) => trim("end", Number(event.target.value))}
              />
            </div>
            <div className="ed-reorder">
              <button
                className="ed-icon"
                aria-label="Move selected clip earlier"
                onClick={() =>
                  change({
                    ...edits,
                    clips: moveClip(edits.clips, selectedClip.id, -1),
                  })
                }
                disabled={selectedIndex === 0}
              >
                <ChevronLeft size={17} />
              </button>
              <button
                className="ed-icon"
                aria-label="Move selected clip later"
                onClick={() =>
                  change({
                    ...edits,
                    clips: moveClip(edits.clips, selectedClip.id, 1),
                  })
                }
                disabled={selectedIndex === edits.clips.length - 1}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </fieldset>
          <div className="ed-timeline-note">
            Trim times refer to the original recording. Your source video is
            always preserved.
          </div>
        </section>
      </div>
      {exporting && (
        <div className="ed-export-backdrop">
          <section
            className="ed-export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ed-export-title"
            aria-describedby="ed-export-description"
          >
            <div className="ed-export-icon">
              <Film size={25} />
            </div>
            <h2 id="ed-export-title">Creating your video</h2>
            <p id="ed-export-description">
              Rendering your clips, audio, and title. Export runs in real time;
              keep this tab visible.
            </p>
            <div className="ed-progress-info">
              <span>
                Exporting {timecode(progress * total)} / {timecode(total)}
              </span>
              <strong>{Math.floor(progress * 100)}%</strong>
            </div>
            <progress
              value={progress}
              max={1}
              aria-label="Video export progress"
            />
            <button
              ref={cancelExportRef}
              autoFocus
              className="ed-button"
              onClick={() => abortRef.current?.abort()}
            >
              <X size={16} />
              Cancel export
            </button>
          </section>
        </div>
      )}
    </>
  );
}
