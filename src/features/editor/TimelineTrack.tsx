import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Film, Minus, Plus, ScanLine } from "lucide-react";
import type { Clip, TimeRange } from "../../types";
import { timelineToSource } from "../../lib/timeline";
import "./timeline-track.css";

interface Props {
  clips: Clip[];
  thumbnail: string;
  selectedId: string;
  editedTime: number;
  total: number;
  disabled: boolean;
  selectingSection: boolean;
  sectionRange: TimeRange;
  onSeek: (index: number, sourceTime: number) => void;
}

const ZOOM_LEVELS = [1, 2, 4, 8] as const;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));
function timeLabel(time: number, precision = 1) {
  const factor = 10 ** precision;
  const safeTime = Math.round(Math.max(0, time) * factor) / factor;
  const hours = Math.floor(safeTime / 3600);
  const minutes = Math.floor(safeTime / 60) % 60;
  const seconds = (safeTime % 60)
    .toFixed(precision)
    .padStart(precision ? 3 + precision : 2, "0");
  return `${hours ? `${hours}:` : ""}${minutes.toString().padStart(2, "0")}:${seconds}`;
}

/** Ruler, clips and native seek range share the exact same horizontal coordinates. */
export default function TimelineTrack({
  clips,
  thumbnail,
  selectedId,
  editedTime,
  total,
  disabled,
  selectingSection,
  sectionRange,
  onSeek,
}: Props) {
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingZoomRef = useRef<{ fraction: number; offset: number } | null>(
    null,
  );
  const [zoom, setZoom] = useState<number>(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const safeTotal = Math.max(0, Number.isFinite(total) ? total : 0);
  const currentTime = clamp(
    Number.isFinite(editedTime) ? editedTime : 0,
    0,
    safeTotal,
  );
  const playheadFraction = safeTotal > 0 ? currentTime / safeTotal : 0;
  const contentWidth = viewportWidth * zoom;
  const clipLayout = useMemo(() => {
    let offset = 0;
    return clips.map((clip, index) => {
      const duration = Math.max(0, clip.end - clip.start);
      const left = safeTotal > 0 ? offset / safeTotal : 0;
      const width = safeTotal > 0 ? duration / safeTotal : 0;
      offset += duration;
      return { clip, index, duration, left, width };
    });
  }, [clips, safeTotal]);
  const divisions = 4 * zoom;
  const rulerPrecision = safeTotal / divisions < 1 ? 2 : 1;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const pending = pendingZoomRef.current;
    if (!element || !pending) return;
    element.scrollLeft = clamp(
      pending.fraction * element.clientWidth * zoom - pending.offset,
      0,
      element.clientWidth * (zoom - 1),
    );
    pendingZoomRef.current = null;
  }, [zoom]);

  // Playback and deliberate seeks reveal the playhead. Manual scrolling alone
  // never triggers this effect, so paused users can inspect another timeline area.
  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    const position =
      safeTotal > 0 ? (currentTime / safeTotal) * content.clientWidth : 0;
    const left = element.scrollLeft;
    const right = left + element.clientWidth;
    const margin = Math.min(28, element.clientWidth / 8);
    if (position < left + margin)
      element.scrollLeft = Math.max(0, position - margin);
    else if (position > right - margin)
      element.scrollLeft = position - element.clientWidth + margin;
  }, [currentTime, selectedId, safeTotal]);

  function changeZoom(next: number) {
    if (!ZOOM_LEVELS.some((level) => level === next) || disabled) return;
    const element = scrollRef.current;
    if (element) {
      if (next === 1) {
        element.scrollLeft = 0;
        pendingZoomRef.current = { fraction: 0, offset: 0 };
      } else {
        const currentWidth = element.clientWidth * zoom;
        const playhead = playheadFraction * currentWidth;
        const visible =
          playhead >= element.scrollLeft &&
          playhead <= element.scrollLeft + element.clientWidth;
        pendingZoomRef.current = visible
          ? {
              fraction: playheadFraction,
              offset: playhead - element.scrollLeft,
            }
          : {
              fraction:
                (element.scrollLeft + element.clientWidth / 2) / currentWidth,
              offset: element.clientWidth / 2,
            };
      }
    }
    setZoom(next);
  }
  function seek(time: number) {
    if (disabled || !clips.length) return;
    const position = timelineToSource(clips, clamp(time, 0, safeTotal));
    onSeek(position.index, position.time);
  }
  function selectClip(index: number) {
    const clip = clips[index];
    if (!clip || disabled) return;
    onSeek(index, clip.start);
  }

  return (
    <div className="tt-timeline">
      <div className="tt-toolbar">
        <div className="tt-clip-picker">
          <Film size={14} aria-hidden="true" />
          <label htmlFor={`${id}-clip`}>Video</label>
          <select
            id={`${id}-clip`}
            aria-label="Select timeline clip"
            value={selectedId}
            disabled={disabled || !clips.length}
            onChange={(event) =>
              selectClip(
                clips.findIndex((clip) => clip.id === event.target.value),
              )
            }
          >
            {clips.map((clip, index) => (
              <option key={clip.id} value={clip.id}>
                Clip {index + 1} · {(clip.end - clip.start).toFixed(2)}s
              </option>
            ))}
          </select>
        </div>
        <div
          className="tt-zoom-controls"
          role="group"
          aria-label="Timeline zoom controls"
        >
          <button
            type="button"
            className="tt-zoom-button"
            aria-label="Zoom out timeline"
            disabled={disabled || zoom === 1}
            onClick={() =>
              changeZoom(
                ZOOM_LEVELS[
                  Math.max(
                    0,
                    ZOOM_LEVELS.findIndex((level) => level === zoom) - 1,
                  )
                ],
              )
            }
          >
            <Minus size={14} />
          </button>
          <select
            aria-label="Timeline zoom"
            value={zoom}
            disabled={disabled}
            onChange={(event) => changeZoom(Number(event.target.value))}
          >
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}×
              </option>
            ))}
          </select>
          <button
            type="button"
            className="tt-zoom-button"
            aria-label="Zoom in timeline"
            disabled={disabled || zoom === 8}
            onClick={() =>
              changeZoom(
                ZOOM_LEVELS[
                  Math.min(
                    ZOOM_LEVELS.length - 1,
                    ZOOM_LEVELS.findIndex((level) => level === zoom) + 1,
                  )
                ],
              )
            }
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="tt-fit-button"
            aria-label="Fit timeline to view"
            disabled={disabled}
            onClick={() => changeZoom(1)}
          >
            <ScanLine size={13} />
            <span>Fit</span>
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="tt-scroll"
        tabIndex={0}
        role="region"
        aria-label="Scrollable video timeline"
        aria-describedby={`${id}-hint`}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            !["ArrowLeft", "ArrowRight"].includes(event.key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const amount =
            event.currentTarget.clientWidth * (event.shiftKey ? 0.8 : 0.2);
          event.currentTarget.scrollLeft +=
            event.key === "ArrowRight" ? amount : -amount;
        }}
      >
        <div
          ref={contentRef}
          className="tt-content"
          style={{ width: `${zoom * 100}%` }}
        >
          <div
            className="tt-ruler"
            aria-hidden="true"
            onPointerDown={(event) => {
              if (disabled || event.button !== 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              seek(((event.clientX - rect.left) / rect.width) * safeTotal);
            }}
          >
            {Array.from({ length: divisions + 1 }, (_, index) => (
              <span
                key={index}
                className={`tt-ruler-tick ${index === 0 ? "is-first" : index === divisions ? "is-last" : ""}`}
                style={{ left: `${(index / divisions) * 100}%` }}
              >
                <span>
                  {timeLabel((safeTotal * index) / divisions, rulerPrecision)}
                </span>
              </span>
            ))}
          </div>
          <div className="tt-clips">
            {clipLayout.map(({ clip, index, duration, left, width }) => (
              <button
                type="button"
                key={clip.id}
                className={`ed-clip tt-clip ${selectedId === clip.id ? "is-selected" : ""}`}
                style={{
                  left: `${left * 100}%`,
                  width: `${width * 100}%`,
                  backgroundImage: thumbnail
                    ? `linear-gradient(0deg, rgba(20,21,30,.9), rgba(20,21,30,.42)), url("${thumbnail}")`
                    : undefined,
                }}
                disabled={disabled}
                onClick={() => selectClip(index)}
                aria-label={`Select clip ${index + 1}, ${timeLabel(duration, duration < 0.1 ? 2 : 1)} long`}
                aria-pressed={selectedId === clip.id}
                title={`Clip ${index + 1}: ${duration.toFixed(2)} seconds`}
              >
                {selectingSection && selectedId === clip.id && duration > 0 && (
                  <span
                    className="ed-clip-cut-overlay tt-section-overlay"
                    aria-hidden="true"
                    style={{
                      left: `${clamp((sectionRange.start - clip.start) / duration, 0, 1) * 100}%`,
                      width: `${(Math.max(0, Math.min(sectionRange.end, clip.end) - Math.max(sectionRange.start, clip.start)) / duration) * 100}%`,
                    }}
                  />
                )}
                {width * contentWidth >= 54 && (
                  <span className="tt-clip-label" aria-hidden="true">
                    <span>Clip {index + 1}</span>
                    {width * contentWidth >= 125 && (
                      <span>{timeLabel(duration)}</span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="tt-scrubber">
            <span className="tt-scrubber-rail" aria-hidden="true" />
            <input
              className="tt-playhead-range"
              type="range"
              aria-label="Timeline playhead"
              aria-valuetext={`${timeLabel(currentTime, 2)} of ${timeLabel(safeTotal, 2)}`}
              min={0}
              max={Math.max(0.01, safeTotal)}
              step="0.01"
              value={currentTime}
              disabled={disabled || !clips.length}
              onChange={(event) => seek(Number(event.target.value))}
            />
          </div>
          <div
            className="tt-playhead"
            aria-hidden="true"
            style={{ left: `${playheadFraction * 100}%` }}
          >
            <span className="tt-playhead-cap" />
            <span className="tt-playhead-dot" />
          </div>
        </div>
      </div>
      <p className="tt-hint" id={`${id}-hint`}>
        {zoom > 1
          ? "Scroll horizontally to move through your video."
          : "Zoom in for finer edits."}{" "}
        <span>Use the clip menu to select very short clips.</span>
      </p>
    </div>
  );
}
