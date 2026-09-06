import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { EditState, Project, TimeRange } from "../../types";
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
import { cutTranscriptRanges } from "../../lib/transcript-edit";
import ClipSectionSelector from "./ClipSectionSelector";
import TranscriptPanel from "./TranscriptPanel";
import "./editor.css";

interface Props {
  project: Project;
  blob: Blob;
  autoTranscribe?: boolean;
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

export default function Editor({
  project,
  blob,
  autoTranscribe = false,
  onSave,
  onBack,
}: Props) {
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
  const [processingTranscript, setProcessingTranscript] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"video" | "transcript">(
    autoTranscribe ? "transcript" : "video",
  );
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [url, setUrl] = useState("");
  const [selectingSection, setSelectingSection] = useState(false);
  const [sectionSelection, setSectionSelection] = useState<
    (TimeRange & { clipId: string }) | null
  >(null);
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
  const sectionRange =
    sectionSelection?.clipId === selectedClip.id &&
    sectionSelection.start >= selectedClip.start &&
    sectionSelection.end <= selectedClip.end
      ? sectionSelection
      : {
          start:
            selectedClip.start + (selectedClip.end - selectedClip.start) / 4,
          end: selectedClip.end - (selectedClip.end - selectedClip.start) / 4,
        };
  const total = timelineDuration(edits.clips);
  const editedTime = sourceToTimeline(edits.clips, selectedIndex, sourceTime);
  const dimensions = outputDimensions(
    project.width,
    project.height,
    edits.aspectRatio,
  );
  const editSnapshot = useMemo(
    () => JSON.stringify({ edits, name }),
    [edits, name],
  );
  const dirty = saved !== editSnapshot;
  const busy = saving || exporting || processingTranscript;

  useEffect(() => {
    if (!dirty && !exporting && !processingTranscript) return;
    const protectChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectChanges);
    return () => window.removeEventListener("beforeunload", protectChanges);
  }, [dirty, exporting, processingTranscript]);
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
      if (canvas)
        drawVideoFrame(
          canvas,
          video,
          editsRef.current.title,
          editsRef.current.clips[activeRef.current]?.crop,
        );
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
        video.currentTime >= clip.end
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
    if (
      !next.clips.length ||
      timelineDuration(next.clips) < MIN_CLIP - 0.000001
    ) {
      setError("Keep at least 0.1 seconds of video in the timeline.");
      return;
    }
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
    if (
      videoRef.current &&
      Math.abs(videoRef.current.currentTime - nextTime) > 0.00001
    )
      videoRef.current.currentTime = nextTime;
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
    if (video.currentTime >= edits.clips[activeRef.current].end)
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
  const clipMinLength = Math.min(
    MIN_CLIP,
    selectedClip.end - selectedClip.start,
  );
  const transcriptBusyChanged = useCallback(
    (value: boolean) => {
      if (value) pause();
      setProcessingTranscript(value);
    },
    [pause],
  );
  async function saveAutomaticTranscript(next: EditState) {
    const cleanName = name.trim() || "Untitled recording";
    await onSave(next, cleanName);
    if (!mountedRef.current) return;
    setName(cleanName);
    setSaved(JSON.stringify({ edits: next, name: cleanName }));
    setNotice("Transcript generated and saved");
  }
  function deleteSection() {
    try {
      const clips = cutTranscriptRanges(edits.clips, [
        { ...sectionRange, clipId: selectedClip.id },
      ]);
      const removed = total - timelineDuration(clips);
      if (removed <= 0.000001) return;
      change({ ...edits, clips });
      setSelectingSection(false);
      setSectionSelection(null);
      setError("");
      setNotice(
        `${removed.toFixed(2)} seconds deleted. Use Undo to restore the section.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not delete the selected section.",
      );
    }
  }

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
            <div
              className="ed-inspector-tabs"
              role="tablist"
              aria-label="Editor tools"
            >
              <button
                id="ed-video-tab"
                role="tab"
                aria-selected={inspectorTab === "video"}
                aria-controls="ed-video-settings"
                tabIndex={inspectorTab === "video" ? 0 : -1}
                onClick={() => setInspectorTab("video")}
                onKeyDown={(event) => {
                  if (["ArrowRight", "ArrowLeft", "End"].includes(event.key)) {
                    event.preventDefault();
                    setInspectorTab("transcript");
                    document.getElementById("ed-transcript-tab")?.focus();
                  }
                }}
              >
                Video settings
              </button>
              <button
                id="ed-transcript-tab"
                role="tab"
                aria-selected={inspectorTab === "transcript"}
                aria-controls="ed-transcript-panel"
                tabIndex={inspectorTab === "transcript" ? 0 : -1}
                onClick={() => setInspectorTab("transcript")}
                onKeyDown={(event) => {
                  if (["ArrowRight", "ArrowLeft", "Home"].includes(event.key)) {
                    event.preventDefault();
                    setInspectorTab("video");
                    document.getElementById("ed-video-tab")?.focus();
                  }
                }}
              >
                Transcript
                {processingTranscript && (
                  <LoaderCircle size={13} className="ed-spin" />
                )}
              </button>
            </div>
            <div
              id="ed-video-settings"
              role="tabpanel"
              aria-labelledby="ed-video-tab"
              hidden={inspectorTab !== "video"}
            >
              <fieldset disabled={busy} className="ed-video-settings">
                <section className="ed-setting">
                  <h3>
                    <Film size={16} /> Canvas
                  </h3>
                  <div className="ed-fixed-canvas">
                    <span>
                      {dimensions.width} × {dimensions.height}
                    </span>
                    <span>Locked</span>
                  </div>
                  <p className="ed-hint">
                    Canvas size is fixed when the video is recorded or imported.
                    Select a section in the timeline to remove footage.
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
                    {edits.muted ? (
                      <VolumeX size={16} />
                    ) : (
                      <Volume2 size={16} />
                    )}
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
            </div>
            <div
              id="ed-transcript-panel"
              role="tabpanel"
              aria-labelledby="ed-transcript-tab"
              hidden={inspectorTab !== "transcript"}
            >
              <TranscriptPanel
                blob={blob}
                edits={edits}
                duration={duration}
                disabled={saving || exporting}
                sourceTime={sourceTime}
                activeClipId={selectedClip.id}
                onChange={change}
                onSeek={(clipId, time) => {
                  pause();
                  seekTo(
                    edits.clips.findIndex((clip) => clip.id === clipId),
                    time,
                  );
                }}
                onBusyChange={transcriptBusyChanged}
                autoGenerate={autoTranscribe && ready}
                onAutoGenerated={saveAutomaticTranscript}
              />
            </div>
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
                className="ed-button ed-split ed-section-toggle"
                aria-pressed={selectingSection}
                disabled={busy}
                onClick={() => {
                  pause();
                  setSelectingSection((value) => !value);
                }}
              >
                <Scissors size={15} /> Select section
              </button>
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
                  {selectingSection && selectedId === clip.id && (
                    <span
                      className="ed-clip-cut-overlay"
                      aria-hidden="true"
                      style={{
                        left: `${(100 * (sectionRange.start - clip.start)) / (clip.end - clip.start)}%`,
                        width: `${(100 * (sectionRange.end - sectionRange.start)) / (clip.end - clip.start)}%`,
                      }}
                    />
                  )}
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
          {selectingSection ? (
            <ClipSectionSelector
              clip={selectedClip}
              clipNumber={selectedIndex + 1}
              range={sectionRange}
              sourceTime={sourceTime}
              thumbnail={project.thumbnail}
              disabled={busy}
              onChange={(range) =>
                setSectionSelection({ ...range, clipId: selectedClip.id })
              }
              onSeek={(time) => {
                pause();
                seekTo(selectedIndex, time);
              }}
              onDelete={deleteSection}
              onClose={() => setSelectingSection(false)}
            />
          ) : (
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
                  max={Math.max(0, selectedClip.end - clipMinLength)}
                  step="0.1"
                  value={Number(selectedClip.start.toFixed(2))}
                  onChange={(event) =>
                    trim("start", Number(event.target.value))
                  }
                />
                <span>s</span>
                <input
                  type="range"
                  aria-label="Trim clip start"
                  min="0"
                  max={Math.max(0, selectedClip.end - clipMinLength)}
                  step="0.01"
                  value={selectedClip.start}
                  onChange={(event) =>
                    trim("start", Number(event.target.value))
                  }
                />
              </div>
              <div className="ed-trim-field">
                <label htmlFor="ed-trim-end">End</label>
                <input
                  id="ed-trim-end"
                  aria-label="Clip end in seconds"
                  type="number"
                  min={selectedClip.start + clipMinLength}
                  max={duration}
                  step="0.1"
                  value={Number(selectedClip.end.toFixed(2))}
                  onChange={(event) => trim("end", Number(event.target.value))}
                />
                <span>s</span>
                <input
                  type="range"
                  aria-label="Trim clip end"
                  min={selectedClip.start + clipMinLength}
                  max={Math.max(duration, selectedClip.start + clipMinLength)}
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
          )}
          <div className="ed-timeline-note">
            Times refer to the original recording. Your source video is always
            preserved.
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
