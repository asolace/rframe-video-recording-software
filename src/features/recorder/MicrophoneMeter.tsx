import { useEffect, useState } from "react";
import type { CaptureSession } from "../../lib/capture";

interface Props {
  session: CaptureSession | null;
  enabled: boolean;
}

/** Read-only input feedback: no extra device permissions or speaker monitoring. */
export default function MicrophoneMeter({ session, enabled }: Props) {
  const [reading, setReading] = useState({ value: 0, clipping: false });
  const listening = !!session?.hasMicrophone && enabled;

  useEffect(() => {
    setReading({ value: 0, clipping: false });
    if (!session || !listening) return;
    let smoothed = 0;
    let clippingUntil = 0;
    const sample = () => {
      const { level, peak } = session.getMicrophoneLevel();
      // A logarithmic display makes ordinary speech visible without turning up
      // the recorded audio. Silence and signals below -60 dBFS stay at zero.
      const value =
        level > 0.001
          ? Math.max(
              0,
              Math.min(100, ((20 * Math.log10(level) + 60) / 60) * 100),
            )
          : 0;
      smoothed = value >= smoothed ? value : smoothed * 0.65 + value * 0.35;
      if (smoothed < 1) smoothed = 0;
      if (peak >= 0.98) clippingUntil = performance.now() + 650;
      const next = {
        value: Math.round(smoothed),
        clipping: performance.now() < clippingUntil,
      };
      setReading((previous) =>
        previous.value === next.value && previous.clipping === next.clipping
          ? previous
          : next,
      );
    };
    sample();
    const timer = window.setInterval(sample, 75);
    return () => window.clearInterval(timer);
  }, [session, listening]);

  const value = listening ? reading.value : 0;
  const clipping = listening && reading.clipping;
  const status = !enabled
    ? "Muted"
    : !session
      ? "Preview off"
      : !session.hasMicrophone
        ? "No microphone"
        : clipping
          ? "Too loud"
          : value > 0
            ? "Input detected"
            : "Listening";
  const hint =
    !session && enabled
      ? "Set up preview to see your microphone level."
      : clipping
        ? "Move a little farther from the microphone or lower its input volume."
        : "Responds to your microphone, including while recording is paused.";

  return (
    <div
      className={`rc-mic-level ${listening ? "is-listening" : ""} ${clipping ? "is-clipping" : ""}`}
      title={hint}
    >
      <span className="rc-mic-level-label">Mic level</span>
      <div
        className="rc-mic-level-track"
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={
          listening
            ? `${value}% microphone input${clipping ? ", too loud" : ""}`
            : status
        }
      >
        {Array.from({ length: 20 }, (_, index) => (
          <span
            key={index}
            aria-hidden="true"
            className={`${value > index * 5 ? "is-lit" : ""} ${index >= 18 ? "is-hot" : index >= 15 ? "is-warm" : ""}`}
          />
        ))}
      </div>
      <span className="rc-mic-level-status">{status}</span>
    </div>
  );
}
