import { useId } from "react";
import { Trash2, X } from "lucide-react";
import type { Clip, TimeRange } from "../../types";
import "./section-selector.css";

interface Props {
  clip: Clip;
  clipNumber: number;
  range: TimeRange;
  sourceTime: number;
  thumbnail: string;
  disabled: boolean;
  onChange: (range: TimeRange) => void;
  onSeek: (time: number) => void;
  onDelete: () => void;
  onClose: () => void;
}

export default function ClipSectionSelector({
  clip,
  clipNumber,
  range,
  sourceTime,
  thumbnail,
  disabled,
  onChange,
  onSeek,
  onDelete,
  onClose,
}: Props) {
  const id = useId();
  const duration = clip.end - clip.start;
  const selectedDuration = range.end - range.start;
  const playheadInside = sourceTime >= clip.start && sourceTime <= clip.end;
  const left = (100 * (range.start - clip.start)) / duration;
  const width = (100 * selectedDuration) / duration;
  function setEdge(edge: "start" | "end", value: number) {
    if (!Number.isFinite(value)) return;
    const next =
      edge === "start"
        ? { ...range, start: Math.max(clip.start, Math.min(range.end, value)) }
        : { ...range, end: Math.min(clip.end, Math.max(range.start, value)) };
    onChange(next);
  }

  return (
    <fieldset
      className="ed-section-selector"
      disabled={disabled}
      aria-label={`Delete a section of clip ${clipNumber}`}
    >
      <div className="ed-section-heading">
        <strong>
          Clip {clipNumber}{" "}
          <span>Drag the handles to select footage to delete</span>
        </strong>
        <button
          className="ed-icon"
          type="button"
          onClick={onClose}
          aria-label="Close section selection"
        >
          <X size={16} />
        </button>
      </div>
      <div
        className="ed-section-range"
        style={{
          backgroundImage: thumbnail
            ? `linear-gradient(#14151e77, #14151e77), url("${thumbnail}")`
            : undefined,
        }}
      >
        <span
          className="ed-section-fill"
          style={{ left: `${left}%`, width: `${width}%` }}
          aria-hidden="true"
        />
        <input
          type="range"
          aria-label="Selection start handle"
          min={clip.start}
          max={clip.end}
          step="0.01"
          value={range.start}
          onChange={(event) => setEdge("start", event.target.valueAsNumber)}
        />
        <input
          type="range"
          aria-label="Selection end handle"
          min={clip.start}
          max={clip.end}
          step="0.01"
          value={range.end}
          onChange={(event) => setEdge("end", event.target.valueAsNumber)}
        />
      </div>
      <div className="ed-section-fields">
        {(["start", "end"] as const).map((edge) => (
          <div className="ed-section-field" key={edge}>
            <label htmlFor={`${id}-${edge}`}>
              {edge === "start" ? "From" : "To"}
            </label>
            <input
              id={`${id}-${edge}`}
              type="number"
              aria-label={`Section ${edge} in seconds`}
              min={edge === "start" ? clip.start : range.start}
              max={edge === "end" ? clip.end : range.end}
              step="0.01"
              value={Number(range[edge].toFixed(3))}
              onChange={(event) => {
                if (event.target.value !== "")
                  setEdge(edge, event.target.valueAsNumber);
              }}
            />
            <span>s</span>
            <button
              type="button"
              className="ed-text-button"
              aria-label={`Set section ${edge} at playhead`}
              disabled={!playheadInside || disabled}
              onClick={() => setEdge(edge, sourceTime)}
            >
              Use playhead
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ed-button ed-section-preview"
          onClick={() => onSeek(range.start)}
        >
          Go to selection
        </button>
        <button
          type="button"
          className="ed-button ed-section-delete"
          disabled={disabled || selectedDuration < 0.01 - 0.000001}
          onClick={onDelete}
        >
          <Trash2 size={14} />
          Delete selected section <span>({selectedDuration.toFixed(2)}s)</span>
        </button>
      </div>
    </fieldset>
  );
}
