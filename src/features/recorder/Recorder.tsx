import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  Circle,
  Download,
  Headphones,
  LoaderCircle,
  Mic,
  MicOff,
  Monitor,
  MonitorUp,
  ScreenShareOff,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Video,
  X,
} from "lucide-react";
import type { RecordingMode, RecordingResult } from "../../types";
import {
  captureError,
  createCapture,
  recordingMimeType,
  type CaptureSession,
} from "../../lib/capture";
import "./recorder.css";
import MicrophoneMeter from "./MicrophoneMeter";

interface Props {
  initialMode?: RecordingMode;
  onComplete: (result: RecordingResult) => Promise<void>;
  onCancel: () => void;
}
type Stage =
  | "setup"
  | "preparing"
  | "preview"
  | "recording"
  | "paused"
  | "saving"
  | "unsaved";
type Mode = Exclude<RecordingMode, "import">;
const MODES: {
  id: Mode;
  label: string;
  description: string;
  icon: typeof Camera;
}[] = [
  {
    id: "screen-camera",
    label: "Screen + camera",
    description: "Your screen, with a personal touch",
    icon: Video,
  },
  {
    id: "screen",
    label: "Screen only",
    description: "Walk through something worth sharing",
    icon: Monitor,
  },
  {
    id: "camera",
    label: "Camera only",
    description: "Just you and your next great idea",
    icon: Camera,
  },
];
const elapsedLabel = (value: number) => {
  const seconds = Math.floor(value);
  return `${
    Math.floor(seconds / 3600)
      ? `${Math.floor(seconds / 3600)
          .toString()
          .padStart(2, "0")}:`
      : ""
  }${Math.floor((seconds / 60) % 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

export default function Recorder({
  initialMode = "screen-camera",
  onComplete,
  onCancel,
}: Props) {
  const [mode, setMode] = useState<Mode>(
    initialMode === "import" ? "screen-camera" : initialMode,
  );
  const [stage, setStage] = useState<Stage>("setup");
  const [camera, setCamera] = useState(true);
  const [microphone, setMicrophone] = useState(true);
  const [cameraDevice, setCameraDevice] = useState("");
  const [microphoneDevice, setMicrophoneDevice] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [screenSharing, setScreenSharing] = useState(false);
  const [choosingScreen, setChoosingScreen] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<CaptureSession | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stageRef = useRef<Stage>("setup");
  const chunksRef = useRef<Blob[]>([]);
  const accumulatedRef = useRef(0);
  const startedRef = useRef(0);
  const mountedRef = useRef(true);
  const resultRef = useRef<RecordingResult | null>(null);
  const recordedScreenRef = useRef(false);
  const stopRef = useRef<() => void>(() => undefined);
  const saveRef = useRef(onComplete);
  saveRef.current = onComplete;
  const active = stage === "recording" || stage === "paused";
  const locked = stage !== "setup";
  const supported =
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined";

  function transition(next: Stage) {
    stageRef.current = next;
    setStage(next);
  }
  function release() {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    if (mountedRef.current) {
      setScreenSharing(false);
      setChoosingScreen(false);
    }
  }
  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const result = await navigator.mediaDevices.enumerateDevices();
      if (mountedRef.current) setDevices(result);
    } catch {
      /* Default devices still work when enumeration is restricted. */
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void refreshDevices();
    return () => {
      mountedRef.current = false;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.onstop = null;
        recorderRef.current.ondataavailable = null;
        recorderRef.current.stop();
      }
      release();
    };
  }, []);

  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.srcObject = previewStream;
      if (previewStream) void previewRef.current.play().catch(() => undefined);
    }
  }, [previewStream]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const milliseconds =
        accumulatedRef.current +
        (stageRef.current === "recording"
          ? performance.now() - startedRef.current
          : 0);
      setElapsed(milliseconds / 1000);
    }, 200);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active && stage !== "saving" && stage !== "unsaved") return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [active, stage]);

  async function prepare() {
    if (!supported || stageRef.current !== "setup") return;
    setError("");
    setNotice("");
    transition("preparing");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // Do not await other work before this call: the screen picker requires a click.
      const session = await createCapture({
        mode,
        camera,
        microphone,
        cameraDevice,
        microphoneDevice,
        signal: controller.signal,
        onScreenSharingChange(sharing) {
          if (!mountedRef.current || controller.signal.aborted) return;
          setScreenSharing(sharing);
          if (sharing && ["recording", "paused"].includes(stageRef.current)) {
            recordedScreenRef.current = true;
          }
          if (!sharing) {
            setNotice(
              stageRef.current === "recording"
                ? "Screen sharing stopped. Your recording is still running."
                : stageRef.current === "paused"
                  ? "Screen sharing stopped. Your recording is still paused."
                  : "Screen sharing stopped. Share again whenever you're ready.",
            );
          }
        },
      });
      if (!mountedRef.current || controller.signal.aborted) {
        session.dispose();
        return;
      }
      sessionRef.current = session;
      setPreviewStream(session.stream);
      setScreenSharing(session.screenSharing);
      transition("preview");
      void refreshDevices();
    } catch (failure) {
      if (!mountedRef.current || controller.signal.aborted) return;
      release();
      setPreviewStream(null);
      setError(captureError(failure));
      transition("setup");
    }
  }

  async function save(result: RecordingResult) {
    resultRef.current = result;
    transition("saving");
    try {
      await saveRef.current(result);
    } catch (failure) {
      if (!mountedRef.current) return;
      setError(
        `Your recording is ready, but it could not be saved. ${failure instanceof Error ? failure.message : "Your browser storage may be full."} Download a copy or retry saving before leaving.`,
      );
      transition("unsaved");
    }
  }

  async function toggleScreenSharing() {
    const session = sessionRef.current;
    if (
      !session ||
      choosingScreen ||
      !["preview", "recording", "paused"].includes(stageRef.current)
    )
      return;
    setError("");
    setNotice("");
    if (session.screenSharing) {
      session.stopScreenShare();
      return;
    }
    setChoosingScreen(true);
    try {
      // Keep the browser picker in the direct user-click call stack.
      await session.startScreenShare();
      if (mountedRef.current && sessionRef.current === session) {
        setNotice(
          session.screenSharing
            ? stageRef.current === "preview"
              ? "Your screen is ready in the preview."
              : stageRef.current === "paused"
                ? "Your screen is ready. Resume recording whenever you're ready."
                : "Your screen is now included in the recording."
            : "Screen sharing stopped. You can share again.",
        );
      }
    } catch (failure) {
      if (!mountedRef.current || sessionRef.current !== session) return;
      const unchanged =
        stageRef.current === "paused"
          ? "Your recording is still paused."
          : stageRef.current === "recording"
            ? "Your recording is still running."
            : "Your preview is still available.";
      if (
        failure instanceof DOMException &&
        ["NotAllowedError", "AbortError"].includes(failure.name)
      ) {
        setNotice(
          `Screen sharing wasn't started. ${unchanged} Choose Share screen to try again.`,
        );
      } else {
        setError(`${captureError(failure)} ${unchanged}`);
      }
    } finally {
      if (mountedRef.current && sessionRef.current === session)
        setChoosingScreen(false);
    }
  }

  function startRecording() {
    const session = sessionRef.current;
    if (!session || stageRef.current !== "preview") return;
    try {
      const mimeType = recordingMimeType();
      const recorder = new MediaRecorder(session.stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 6_000_000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];
      resultRef.current = null;
      recordedScreenRef.current = session.screenSharing;
      accumulatedRef.current = 0;
      setElapsed(0);
      setError("");
      let thumbnail = "";
      let duration = 0;
      let recordingFailure = "";
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = (event) => {
        recordingFailure = `Your browser interrupted recording. ${(event as Event & { error?: DOMException }).error?.message || "Any captured footage will be kept."}`;
        if (mountedRef.current) setNotice(recordingFailure);
      };
      const finalize = () => {
        duration =
          (accumulatedRef.current +
            (stageRef.current === "recording"
              ? performance.now() - startedRef.current
              : 0)) /
          1000;
        thumbnail = session.thumbnail();
        setElapsed(duration);
        transition("saving");
      };
      recorder.onstop = () => {
        // Also cover browsers that stop MediaRecorder when its input ends.
        if (stageRef.current === "recording" || stageRef.current === "paused")
          finalize();
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "video/webm",
        });
        const recordedMode: Mode = recordedScreenRef.current
          ? session.hasCamera
            ? "screen-camera"
            : "screen"
          : session.hasCamera
            ? "camera"
            : mode;
        chunksRef.current = [];
        release();
        if (!mountedRef.current) return;
        setPreviewStream(null);
        if (!blob.size) {
          setError(
            recordingFailure ||
              "No video was captured. Check your source, then try recording again.",
          );
          transition("setup");
          return;
        }
        void save({
          blob,
          duration,
          thumbnail,
          width: session.width,
          height: session.height,
          mode: recordedMode,
        });
      };
      stopRef.current = () => {
        if (
          recorder.state === "inactive" ||
          !["recording", "paused"].includes(stageRef.current)
        )
          return;
        finalize();
        recorder.stop();
      };
      recorder.start(1000);
      startedRef.current = performance.now();
      transition("recording");
    } catch (failure) {
      setError(captureError(failure));
      recorderRef.current = null;
      release();
      setPreviewStream(null);
      transition("setup");
    }
  }

  function togglePause() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      accumulatedRef.current += performance.now() - startedRef.current;
      setElapsed(accumulatedRef.current / 1000);
      transition("paused");
    } else if (recorder.state === "paused") {
      recorder.resume();
      startedRef.current = performance.now();
      transition("recording");
    }
  }
  function resetPreview() {
    release();
    setPreviewStream(null);
    transition("setup");
  }
  function leave() {
    if (active || stage === "unsaved") {
      setConfirmExit(true);
      return;
    }
    release();
    onCancel();
  }
  function discard() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      recorder.stop();
    }
    chunksRef.current = [];
    release();
    onCancel();
  }
  function download() {
    const result = resultRef.current;
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Frame recording ${new Date().toISOString().slice(0, 10)}.${result.blob.type.includes("mp4") ? "mp4" : "webm"}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function toggleCamera() {
    const next = !camera;
    setCamera(next);
    sessionRef.current?.setCamera(next);
  }
  function toggleMicrophone() {
    const next = !microphone;
    setMicrophone(next);
    sessionRef.current?.setMicrophone(next);
  }

  return (
    <div className="rc-shell">
      <header className="rc-header" inert={confirmExit}>
        <button
          className="rc-back"
          aria-label="Back to workspace"
          onClick={leave}
          disabled={stage === "saving"}
        >
          <ArrowLeft size={18} />
          <span>Back to workspace</span>
        </button>
        <span className="rc-header-title">
          <span className="rc-brand-mark">
            <Video size={17} />
          </span>
          Recording studio
        </span>
        <span className="rc-private">
          <ShieldCheck size={15} /> Private by default
        </span>
      </header>
      <main className="rc-main" inert={confirmExit}>
        <div className="rc-intro">
          <div>
            <span className="rc-eyebrow">MAKE SOMETHING WORTH SHARING</span>
            <h1>
              {active
                ? "You’re in the frame."
                : stage === "saving"
                  ? "Making it yours."
                  : "Ready when you are."}
            </h1>
            <p>
              {active
                ? "Take your time. Great things don’t happen in one take."
                : "Choose what to capture. We’ll take care of the canvas."}
            </p>
          </div>
          <span className="rc-quality">
            <span /> Browser recording
          </span>
        </div>
        {!supported && (
          <div className="rc-alert" role="alert">
            {!window.isSecureContext
              ? "Recording needs a secure connection. Open this app over HTTPS or localhost to enable your camera and screen."
              : "This browser does not support video recording. Open Frame in a current desktop Chrome, Edge, Firefox, or Safari browser."}
          </div>
        )}
        {error && (
          <div className="rc-alert" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="rc-notice" role="status">
            {notice}
          </div>
        )}
        <div className="rc-layout">
          <section className="rc-stage" aria-label="Recording preview">
            <div className="rc-preview">
              <video
                ref={previewRef}
                className={`rc-video ${previewStream ? "rc-visible" : ""} ${!screenSharing && sessionRef.current?.hasCamera ? "rc-mirrored" : ""}`}
                autoPlay
                muted
                playsInline
                aria-label="Live recording preview"
              />
              {!previewStream && (
                <div className="rc-empty">
                  <div className="rc-empty-art">
                    <div className="rc-art-outline" />
                    <div className="rc-art-screen">
                      <Monitor size={54} strokeWidth={1.2} />
                      <div className="rc-art-camera">
                        <Camera size={25} strokeWidth={1.6} />
                      </div>
                    </div>
                  </div>
                  <h2>
                    {stage === "saving"
                      ? "Saving your recording…"
                      : stage === "unsaved"
                        ? "Your recording is ready"
                        : stage === "preparing"
                          ? "Let’s get you connected"
                          : "Your next idea starts here"}
                  </h2>
                  <p>
                    {stage === "saving"
                      ? "Keep this window open while we add it to your workspace."
                      : stage === "unsaved"
                        ? "Download your video or retry saving to your workspace."
                        : stage === "preparing"
                          ? "Choose your source and allow access in the browser prompt."
                          : "Your camera and screen preview will appear here. A little preparation, a great recording."}
                  </p>
                  {(stage === "preparing" || stage === "saving") && (
                    <LoaderCircle className="rc-spin" size={22} />
                  )}
                  {stage === "setup" && (
                    <button
                      className="rc-preview-start"
                      onClick={prepare}
                      disabled={!supported}
                    >
                      <Play size={15} fill="currentColor" /> Set up preview{" "}
                      <ArrowRight size={16} />
                    </button>
                  )}
                  {stage === "unsaved" && (
                    <div className="rc-recovery">
                      <button
                        className="rc-primary"
                        onClick={() =>
                          resultRef.current && void save(resultRef.current)
                        }
                      >
                        <RefreshCw size={16} /> Retry save
                      </button>
                      <button className="rc-secondary" onClick={download}>
                        <Download size={16} /> Download video
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="rc-preview-label">
                <span
                  className={`rc-indicator ${stage === "recording" ? "rc-live" : ""}`}
                />
                {stage === "recording"
                  ? "RECORDING"
                  : stage === "paused"
                    ? "PAUSED"
                    : previewStream
                      ? "LIVE PREVIEW"
                      : "PREVIEW"}
              </div>
              {previewStream && (
                <span className="rc-resolution">
                  {sessionRef.current?.width} × {sessionRef.current?.height}
                </span>
              )}
              {stage === "paused" && (
                <div className="rc-pause-overlay">
                  <Pause size={26} />
                  <span>Recording paused</span>
                  <small>
                    Catch your breath. Resume whenever you’re ready.
                  </small>
                </div>
              )}
            </div>
            {previewStream && (stage === "preview" || active) && (
              <div className="rc-screen-controls">
                <div className="rc-screen-status">
                  <Monitor size={18} />
                  <div>
                    <strong>
                      Screen sharing{" "}
                      <span className={screenSharing ? "rc-share-on" : ""}>
                        {screenSharing ? "On" : "Off"}
                      </span>
                    </strong>
                    <small>
                      {typeof navigator.mediaDevices?.getDisplayMedia !==
                      "function"
                        ? "Available in a supported desktop browser."
                        : !screenSharing && !sessionRef.current?.hasCamera
                          ? "Without a screen, the canvas stays blank."
                          : "Start or stop sharing anytime during your take."}
                    </small>
                  </div>
                </div>
                <button
                  className={`rc-secondary rc-share-button ${screenSharing ? "rc-share-active" : ""}`}
                  onClick={() => void toggleScreenSharing()}
                  disabled={
                    choosingScreen ||
                    typeof navigator.mediaDevices?.getDisplayMedia !==
                      "function"
                  }
                  aria-label={
                    choosingScreen
                      ? "Choosing screen…"
                      : screenSharing
                        ? "Stop sharing"
                        : "Share screen"
                  }
                  aria-pressed={screenSharing}
                >
                  {choosingScreen ? (
                    <LoaderCircle size={16} className="rc-spin" />
                  ) : screenSharing ? (
                    <ScreenShareOff size={16} />
                  ) : (
                    <MonitorUp size={16} />
                  )}
                  <span>
                    {choosingScreen
                      ? "Choosing screen…"
                      : screenSharing
                        ? "Stop sharing"
                        : "Share screen"}
                  </span>
                </button>
              </div>
            )}
            <div className="rc-controls">
              <div className="rc-input-toggles">
                <button
                  className={`rc-toggle ${!microphone ? "rc-off" : ""}`}
                  aria-label={
                    microphone ? "Turn microphone off" : "Turn microphone on"
                  }
                  aria-pressed={microphone}
                  onClick={toggleMicrophone}
                  disabled={
                    stage === "preparing" ||
                    stage === "saving" ||
                    stage === "unsaved" ||
                    (!!previewStream && !sessionRef.current?.hasMicrophone)
                  }
                >
                  {microphone ? <Mic size={19} /> : <MicOff size={19} />}
                </button>
                <button
                  className={`rc-toggle ${!camera ? "rc-off" : ""}`}
                  aria-label={camera ? "Turn camera off" : "Turn camera on"}
                  aria-pressed={camera}
                  onClick={toggleCamera}
                  disabled={
                    mode === "screen" ||
                    stage === "preparing" ||
                    stage === "saving" ||
                    stage === "unsaved" ||
                    (!!previewStream && !sessionRef.current?.hasCamera)
                  }
                >
                  {camera && mode !== "screen" ? (
                    <Camera size={19} />
                  ) : (
                    <CameraOff size={19} />
                  )}
                </button>
                <span className="rc-controls-divider" />
                <span
                  className="rc-timer"
                  aria-label={`${elapsedLabel(elapsed)} recorded`}
                >
                  <span
                    className={
                      active ? "rc-timer-dot rc-timer-active" : "rc-timer-dot"
                    }
                  />
                  {elapsedLabel(elapsed)}
                </span>
              </div>
              <div className="rc-record-actions">
                {stage === "preview" && (
                  <button
                    className="rc-text-button rc-change-source"
                    onClick={resetPreview}
                  >
                    Change source
                  </button>
                )}
                {active ? (
                  <>
                    <button
                      className="rc-secondary rc-pause-button"
                      aria-label={stage === "paused" ? "Resume" : "Pause"}
                      onClick={togglePause}
                    >
                      {stage === "paused" ? (
                        <Play size={16} />
                      ) : (
                        <Pause size={16} />
                      )}
                      <span>{stage === "paused" ? "Resume" : "Pause"}</span>
                    </button>
                    <button
                      className="rc-stop"
                      onClick={() => stopRef.current()}
                    >
                      <Square size={13} fill="currentColor" /> Stop recording
                    </button>
                  </>
                ) : (
                  <button
                    className="rc-record"
                    onClick={stage === "preview" ? startRecording : prepare}
                    disabled={
                      !supported || !["setup", "preview"].includes(stage)
                    }
                  >
                    {stage === "preparing" || stage === "saving" ? (
                      <LoaderCircle className="rc-spin" size={17} />
                    ) : (
                      <Circle size={15} fill="currentColor" />
                    )}
                    <span>
                      {stage === "preview"
                        ? "Start recording"
                        : stage === "preparing"
                          ? "Connecting…"
                          : stage === "saving"
                            ? "Saving…"
                            : stage === "unsaved"
                              ? "Recording complete"
                              : "Prepare recording"}
                    </span>
                  </button>
                )}
              </div>
              <MicrophoneMeter
                session={
                  previewStream && (stage === "preview" || active)
                    ? sessionRef.current
                    : null
                }
                enabled={microphone}
              />
            </div>
            <p className="rc-preview-note">
              <Headphones size={14} /> Headphones keep your audio clear and
              echo-free.<span>Your preview is muted.</span>
            </p>
          </section>
          <aside className="rc-settings">
            <div className="rc-settings-heading">
              <h2>Recording setup</h2>
              <span>01</span>
            </div>
            <fieldset className="rc-mode-list" disabled={locked}>
              <legend>
                {locked ? "STARTING LAYOUT" : "WHAT ARE WE RECORDING?"}
              </legend>
              {MODES.map(({ id, label, description, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`rc-mode ${mode === id ? "rc-selected" : ""}`}
                  onClick={() => {
                    setMode(id);
                    setError("");
                  }}
                  aria-pressed={mode === id}
                >
                  <span className="rc-mode-icon">
                    <Icon size={19} />
                  </span>
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                  <span className="rc-radio">
                    {mode === id && <Check size={11} strokeWidth={3} />}
                  </span>
                </button>
              ))}
            </fieldset>
            <div className="rc-settings-line" />
            <div className="rc-device-heading">
              <span>YOUR DEVICES</span>
              <button
                aria-label="Refresh devices"
                onClick={() => void refreshDevices()}
                disabled={locked}
              >
                <RefreshCw size={13} />
              </button>
            </div>
            <label className="rc-device-label" htmlFor="rc-camera">
              <Camera size={14} /> Camera
            </label>
            <div className="rc-select-wrap">
              <select
                id="rc-camera"
                value={cameraDevice}
                onChange={(event) => setCameraDevice(event.target.value)}
                disabled={locked || mode === "screen"}
              >
                <option value="">System default camera</option>
                {devices
                  .filter(
                    (device) => device.kind === "videoinput" && device.deviceId,
                  )
                  .map((device, index) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <label className="rc-device-label" htmlFor="rc-microphone">
              <Mic size={14} /> Microphone
            </label>
            <div className="rc-select-wrap">
              <select
                id="rc-microphone"
                value={microphoneDevice}
                onChange={(event) => setMicrophoneDevice(event.target.value)}
                disabled={locked || !microphone}
              >
                <option value="">System default microphone</option>
                {devices
                  .filter(
                    (device) => device.kind === "audioinput" && device.deviceId,
                  )
                  .map((device, index) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <p className="rc-device-hint">
              {previewStream
                ? "Change source to select different devices. Inputs enabled during setup can be muted while recording."
                : "Device names appear after you allow access. Your browser will ask before sharing."}
            </p>
            <div className="rc-settings-line" />
            <div className="rc-tip">
              <span className="rc-tip-icon">
                <ShieldCheck size={18} />
              </span>
              <div>
                <strong>Your work stays yours.</strong>
                <p>
                  Recordings are saved in this browser. Download a copy to keep
                  them safe.
                </p>
              </div>
            </div>
            {(mode !== "camera" || screenSharing) && (
              <p className="rc-screen-note">
                To capture system sound, select a browser tab and enable “Share
                tab audio” in the screen picker. Available options depend on
                your browser.
              </p>
            )}
          </aside>
        </div>
      </main>
      {confirmExit && (
        <div
          className="rc-modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmExit(false);
          }}
        >
          <section
            className="rc-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rc-exit-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setConfirmExit(false);
              if (event.key === "Tab") {
                const buttons =
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button",
                  );
                const first = buttons[0],
                  last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <h2 id="rc-exit-title">Leave this recording?</h2>
            <p>
              {stage === "unsaved"
                ? "This recording hasn’t been saved to your workspace. Download it before leaving if you want to keep a copy."
                : "Your current recording will be discarded. Stop recording to save your video before leaving."}
            </p>
            <div>
              <button
                className="rc-secondary"
                autoFocus
                onClick={() => setConfirmExit(false)}
              >
                Keep working
              </button>
              <button className="rc-stop" onClick={discard}>
                Discard and leave
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
