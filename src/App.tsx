import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Ellipsis,
  Film,
  Folder as FolderIcon,
  Grid2X2,
  HardDrive,
  LayoutGrid,
  List,
  LoaderCircle,
  Menu,
  Monitor,
  MonitorUp,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import type {
  EditState,
  Folder,
  Project,
  RecordingMode,
  RecordingResult,
} from "./types";
import Recorder from "./features/recorder/Recorder";
import Editor from "./features/editor/Editor";
import {
  deleteFolder,
  deleteProject,
  getProjectBlob,
  getStorageUsage,
  listFolders,
  listProjects,
  requestPersistentStorage,
  saveFolder,
  saveProject,
} from "./lib/storage";
import {
  createProject,
  downloadBlob,
  formatBytes,
  formatDuration,
  readVideoMetadata,
} from "./lib/media";

type Selection = "all" | "favorites" | "recent" | `folder:${string}`;
type DialogState =
  | { type: "folder"; folder?: Folder }
  | { type: "project"; project: Project }
  | { type: "delete-project"; project: Project }
  | { type: "delete-folder"; folder: Folder }
  | { type: "help" }
  | { type: "settings" }
  | null;
const folderColors = ["#a5a3ef", "#80bcb2", "#d8b47a", "#ce96ab", "#89acd7"];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <span />
        <i />
      </span>
      {!compact && (
        <span>
          frame<span className="brand-dot">.</span>
        </span>
      )}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function CaptureIllustration() {
  return (
    <div className="capture-art" aria-hidden="true">
      <div className="art-window">
        <div className="art-window-bar">
          <span />
          <span />
          <span />
          <div />
        </div>
        <div className="art-content">
          <div className="art-slide">
            <span className="art-eyebrow">A NEW PERSPECTIVE</span>
            <strong>
              Big ideas.
              <br />
              Small beginnings.
            </strong>
            <div className="art-slide-footer">
              <span>01 / 03</span>
              <ArrowUpRight size={12} />
            </div>
          </div>
          <div className="art-orbit">
            <div />
            <div />
            <div />
          </div>
        </div>
      </div>
      <div className="art-camera">
        <Video size={25} strokeWidth={1.3} />
        <span>YOU, IN THE FRAME</span>
      </div>
      <div className="art-record-bar">
        <span className="record-dot" />
        <span>00:00</span>
        <div className="art-wave">
          {Array.from({ length: 13 }, (_, i) => (
            <i
              key={i}
              style={{
                height: `${[7, 12, 19, 10, 22, 15, 8, 17, 24, 12, 18, 9, 5][i]}px`,
              }}
            />
          ))}
        </div>
        <span className="art-stop" />
      </div>
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState<Selection>("all");
  const [screen, setScreen] = useState<"library" | "recorder" | "editor">(
    "library",
  );
  const [recordMode, setRecordMode] = useState<RecordingMode>("screen-camera");
  const [editing, setEditing] = useState<{
    project: Project;
    blob: Blob;
    autoTranscribe?: boolean;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const [usage, setUsage] = useState({ usage: 0, quota: 0 });
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const notify = useCallback((text: string, error = false) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(
      () => setNotice(null),
      error ? 14000 : 5000,
    );
  }, []);

  const refresh = useCallback(async () => {
    const [nextProjects, nextFolders] = await Promise.all([
      listProjects(),
      listFolders(),
    ]);
    setProjects(nextProjects);
    setFolders(nextFolders);
    getStorageUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh()
      .catch((error: unknown) =>
        notify(
          error instanceof Error
            ? error.message
            : "Could not open local storage. Check your browser settings.",
          true,
        ),
      )
      .finally(() => setLoaded(true));
    return () => clearTimeout(noticeTimer.current);
  }, [refresh, notify]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const activeFolder = selection.startsWith("folder:")
    ? folders.find((folder) => folder.id === selection.slice(7))
    : undefined;
  const activeFolderId = activeFolder?.id ?? null;
  const visibleProjects = projects
    .filter((project) => {
      if (selection === "favorites" && !project.favorite) return false;
      if (
        selection === "recent" &&
        project.updatedAt < Date.now() - 7 * 86400000
      )
        return false;
      if (
        selection.startsWith("folder:") &&
        project.folderId !== activeFolderId
      )
        return false;
      return project.name
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase().trim());
    })
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "created"
          ? b.createdAt - a.createdAt
          : b.updatedAt - a.updatedAt,
    );
  const pageTitle =
    activeFolder?.name ??
    (selection === "favorites"
      ? "Favorites"
      : selection === "recent"
        ? "Recently edited"
        : "All projects");
  const totalBytes = projects.reduce((sum, project) => sum + project.size, 0);

  function navigate(next: Selection) {
    setSelection(next);
    setSearch("");
    setSidebar(false);
  }
  function record(mode: RecordingMode = "screen-camera") {
    setRecordMode(mode);
    setScreen("recorder");
    setSidebar(false);
  }

  async function openProject(project: Project) {
    setMenu(null);
    setBusy("Opening project…");
    try {
      const blob = await getProjectBlob(project.id);
      if (!blob)
        throw new Error(
          "The original video is missing from this browser. Import a backup to continue.",
        );
      setEditing({ project, blob });
      setScreen("editor");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not open project.",
        true,
      );
    } finally {
      setBusy("");
    }
  }

  async function finishRecording(result: RecordingResult) {
    const name = `Recording ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    const project = createProject(result, name, activeFolderId);
    await saveProject(project, result.blob);
    setEditing({ project, blob: result.blob, autoTranscribe: true });
    setScreen("editor");
    await refresh();
    notify("Recording saved. Generating your transcript.");
  }

  const saveEdits = useCallback(
    async (edits: EditState, name: string) => {
      if (!editing) return;
      const next = {
        ...editing.project,
        edits,
        name: name.trim() || "Untitled project",
        updatedAt: Date.now(),
      };
      await saveProject(next);
      setEditing((current) => (current ? { ...current, project: next } : null));
      await refresh();
    },
    [editing, refresh],
  );

  async function importFiles(files: File[]) {
    if (!files.length || busy) return;
    setDragging(false);
    let success = 0;
    let last: { project: Project; blob: Blob } | null = null;
    const errors: string[] = [];
    for (const [index, file] of files.entries()) {
      setBusy(`Importing video ${index + 1} of ${files.length}…`);
      try {
        const metadata = await readVideoMetadata(file);
        const project = createProject(
          { ...metadata, blob: file, mode: "import" },
          file.name.replace(/\.[^.]+$/, ""),
          activeFolderId,
        );
        await saveProject(project, file);
        last = { project, blob: file };
        success++;
      } catch (error) {
        errors.push(
          `${file.name}: ${error instanceof Error ? error.message : "Import failed."}`,
        );
      }
    }
    try {
      await refresh();
    } catch {
      errors.push(
        "Could not refresh the project library. Reload to try again.",
      );
    }
    setBusy("");
    if (errors.length)
      notify(
        `${success ? `${success} imported. ` : ""}${errors.join(" ")}`,
        true,
      );
    else {
      notify(`${success === 1 ? "Video" : `${success} videos`} imported.`);
      if (last && files.length === 1) {
        setEditing(last);
        setScreen("editor");
      }
    }
  }

  async function changeProject(project: Project, changes: Partial<Project>) {
    try {
      await saveProject({ ...project, ...changes, updatedAt: Date.now() });
      await refresh();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not save the change.",
        true,
      );
      throw error;
    }
  }

  async function downloadSource(project: Project) {
    setMenu(null);
    try {
      const blob = await getProjectBlob(project.id);
      if (!blob) throw new Error("Original video not found.");
      downloadBlob(
        blob,
        `${project.name}.${blob.type.includes("mp4") ? "mp4" : blob.type.includes("quicktime") ? "mov" : "webm"}`,
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Download failed.", true);
    }
  }

  async function submitFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) return;
    const existing = dialog?.type === "folder" ? dialog.folder : undefined;
    const folder = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      color: String(data.get("color") ?? folderColors[0]),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    try {
      await saveFolder(folder);
      await refresh();
      setDialog(null);
      notify(existing ? "Folder updated." : "Folder created.");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not save folder.",
        true,
      );
    }
  }

  function projectCard(project: Project) {
    const folder = folders.find((item) => item.id === project.folderId);
    const editedDuration = project.edits.clips.reduce(
      (total, clip) => total + clip.end - clip.start,
      0,
    );
    return (
      <article className="project-card" key={project.id}>
        <button
          className="project-preview"
          onClick={() => void openProject(project)}
          aria-label={`Edit ${project.name}`}
        >
          {project.thumbnail ? (
            <img src={project.thumbnail} alt="" loading="lazy" />
          ) : (
            <Film size={38} />
          )}
          <span className="project-play">
            <Film size={22} />
          </span>
          <span className="duration-badge">
            {formatDuration(editedDuration)}
          </span>
          <span className="project-mode">
            {project.mode === "camera" ? (
              <Video size={13} />
            ) : project.mode === "import" ? (
              <Upload size={13} />
            ) : (
              <Monitor size={13} />
            )}
          </span>
        </button>
        <div className="project-info">
          <button
            className="project-name"
            onClick={() => void openProject(project)}
          >
            {project.name}
          </button>
          <div className="project-meta">
            <span>
              {new Date(project.updatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
            <i />
            {folder ? (
              <span style={{ color: folder.color }}>{folder.name}</span>
            ) : (
              <span>{formatBytes(project.size)}</span>
            )}
          </div>
        </div>
        <div className="project-actions">
          {project.favorite && (
            <Star size={14} className="favorite-star" fill="currentColor" />
          )}
          <button
            className="icon-button"
            aria-label={`Options for ${project.name}`}
            aria-expanded={menu === project.id}
            onClick={(event) => {
              event.stopPropagation();
              setMenu(menu === project.id ? null : project.id);
            }}
          >
            <Ellipsis size={20} />
          </button>
          {menu === project.id && (
            <div className="project-menu" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setDialog({ type: "project", project });
                  setMenu(null);
                }}
              >
                <Settings2 size={16} />
                Rename or move
              </button>
              <button
                onClick={() => {
                  void changeProject(project, {
                    favorite: !project.favorite,
                  }).catch(() => {});
                  setMenu(null);
                }}
              >
                <Star size={16} />
                {project.favorite ? "Remove favorite" : "Add to favorites"}
              </button>
              <button onClick={() => void downloadSource(project)}>
                <ArrowDownToLine size={16} />
                Download original
              </button>
              <div className="menu-divider" />
              <button
                className="danger-text"
                onClick={() => {
                  setDialog({ type: "delete-project", project });
                  setMenu(null);
                }}
              >
                <Trash2 size={16} />
                Delete project
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <>
      {screen === "recorder" ? (
        <Recorder
          initialMode={recordMode}
          onComplete={finishRecording}
          onCancel={() => setScreen("library")}
        />
      ) : screen === "editor" && editing ? (
        <Editor
          key={editing.project.id}
          project={editing.project}
          blob={editing.blob}
          autoTranscribe={editing.autoTranscribe}
          onSave={saveEdits}
          onBack={() => {
            setScreen("library");
            setEditing(null);
            void refresh().catch(() =>
              notify("Could not refresh projects.", true),
            );
          }}
        />
      ) : (
        <div className="app-shell">
          {sidebar && (
            <button
              className="sidebar-scrim"
              aria-label="Close navigation"
              onClick={() => setSidebar(false)}
            />
          )}
          <aside className={`sidebar ${sidebar ? "is-open" : ""}`}>
            <button
              className="brand-link"
              aria-label="Frame home"
              onClick={() => navigate("all")}
            >
              <Brand />
            </button>
            <button
              className="workspace-switch"
              onClick={() => setDialog({ type: "settings" })}
            >
              <span className="workspace-avatar">M</span>
              <span>
                My workspace<small>Personal studio</small>
              </span>
              <ChevronDown size={15} />
            </button>
            <button
              className="button primary sidebar-record"
              onClick={() => record()}
            >
              <Plus size={18} />
              New recording
            </button>
            <span className="nav-section-label">WORKSPACE</span>
            <nav className="main-nav" aria-label="Main navigation">
              <button
                className={selection === "all" ? "selected" : ""}
                onClick={() => navigate("all")}
              >
                <LayoutGrid size={18} />
                All projects<span>{projects.length}</span>
              </button>
              <button
                className={selection === "recent" ? "selected" : ""}
                onClick={() => navigate("recent")}
              >
                <Clapperboard size={18} />
                Recently edited
              </button>
              <button
                className={selection === "favorites" ? "selected" : ""}
                onClick={() => navigate("favorites")}
              >
                <Star size={18} />
                Favorites
                {projects.some((p) => p.favorite) && (
                  <span>{projects.filter((p) => p.favorite).length}</span>
                )}
              </button>
            </nav>
            <div className="folder-nav-heading">
              <span className="nav-section-label">FOLDERS</span>
              <button
                className="icon-button"
                aria-label="Create folder"
                onClick={() => setDialog({ type: "folder" })}
              >
                <Plus size={16} />
              </button>
            </div>
            <nav className="folder-nav" aria-label="Project folders">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  className={activeFolder?.id === folder.id ? "selected" : ""}
                  onClick={() => navigate(`folder:${folder.id}`)}
                >
                  <FolderIcon size={17} style={{ color: folder.color }} />
                  <span>{folder.name}</span>
                  <small>
                    {projects.filter((p) => p.folderId === folder.id).length}
                  </small>
                </button>
              ))}
              {!folders.length && (
                <button
                  className="add-first-folder"
                  onClick={() => setDialog({ type: "folder" })}
                >
                  <Plus size={15} />
                  Create your first folder
                </button>
              )}
            </nav>
            <div className="sidebar-bottom">
              <div className="storage-widget">
                <div>
                  <HardDrive size={16} />
                  <span>On this device</span>
                  <ShieldCheck size={15} />
                </div>
                <div className="storage-track">
                  <span
                    style={{
                      width: `${usage.quota ? Math.min(100, Math.max(2, (usage.usage / usage.quota) * 100)) : 2}%`,
                    }}
                  />
                </div>
                <small>
                  {formatBytes(totalBytes)} of video
                  {usage.quota > 0 && (
                    <>
                      {" "}
                      · {formatBytes(
                        Math.max(0, usage.quota - usage.usage),
                      )}{" "}
                      available
                    </>
                  )}
                </small>
              </div>
              <button
                className="sidebar-help"
                onClick={() => setDialog({ type: "help" })}
              >
                <CircleHelp size={18} />
                Getting started
                <ArrowUpRight size={14} />
              </button>
              <div className="sidebar-footnote">
                <span className="online-dot" />
                Your ideas stay yours.
              </div>
            </div>
          </aside>

          <div
            className="workspace-main"
            onDragEnter={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                dragDepth.current++;
                setDragging(true);
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDragLeave={() => {
              dragDepth.current--;
              if (dragDepth.current <= 0) {
                dragDepth.current = 0;
                setDragging(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragDepth.current = 0;
              setDragging(false);
              void importFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <header className="topbar">
              <div className="breadcrumbs">
                <button
                  className="icon-button mobile-menu"
                  aria-label="Open navigation"
                  onClick={() => setSidebar(true)}
                >
                  <Menu size={21} />
                </button>
                <span>Workspace</span>
                <ChevronRight size={14} />
                <strong>{pageTitle}</strong>
              </div>
              <div className="topbar-end">
                <span className="device-label">
                  <span className="online-dot" />
                  Local workspace
                </span>
                <button
                  className="icon-button"
                  aria-label="Workspace settings"
                  onClick={() => setDialog({ type: "settings" })}
                >
                  <Settings2 size={18} />
                </button>
                <span className="profile-avatar" title="Personal workspace">
                  M
                </span>
              </div>
            </header>
            <main id="main" className="library-main">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR CREATIVE SPACE</div>
                  <h1>{pageTitle}</h1>
                  <p>
                    {activeFolder
                      ? `${projects.filter((p) => p.folderId === activeFolder.id).length} projects, one place to keep them.`
                      : selection === "favorites"
                        ? "Your best takes, always within reach."
                        : selection === "recent"
                          ? "Pick up where you left off in the last seven days."
                          : "A little inspiration. A new perspective. Your next great take."}
                  </p>
                </div>
                <div className="page-heading-actions">
                  {activeFolder && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        setDialog({ type: "folder", folder: activeFolder })
                      }
                    >
                      <Settings2 size={16} />
                      Edit folder
                    </button>
                  )}
                  <button
                    className="button secondary"
                    onClick={() => fileRef.current?.click()}
                    disabled={!!busy}
                  >
                    <Upload size={16} />
                    Import video
                  </button>
                </div>
              </div>

              {selection === "all" && !search && (
                <section
                  className="capture-launcher"
                  aria-label="Start a recording"
                >
                  <button
                    className="feature-capture"
                    onClick={() => record("screen-camera")}
                  >
                    <div className="feature-capture-copy">
                      <span className="feature-label">
                        <span className="record-dot" />
                        LET’S MAKE SOMETHING
                      </span>
                      <h2>
                        Your screen.
                        <br />
                        Your story.
                      </h2>
                      <p>
                        Bring your ideas to life with
                        <br className="desktop-break" /> screen and camera
                        recording.
                      </p>
                      <span className="capture-cta">
                        Start recording
                        <ArrowUpRight size={17} />
                      </span>
                    </div>
                    <CaptureIllustration />
                  </button>
                  <div className="capture-shortcuts">
                    <button
                      className="capture-shortcut"
                      onClick={() => record("camera")}
                    >
                      <div className="shortcut-icon">
                        <Video size={23} strokeWidth={1.6} />
                      </div>
                      <div>
                        <h3>Just you, on camera</h3>
                        <p>Put a face to your ideas.</p>
                        <span>
                          Record camera
                          <ArrowRight size={14} />
                        </span>
                      </div>
                      <ArrowUpRight size={18} className="shortcut-arrow" />
                    </button>
                    <button
                      className="capture-shortcut"
                      onClick={() => record("screen")}
                    >
                      <div className="shortcut-icon mint">
                        <MonitorUp size={23} strokeWidth={1.6} />
                      </div>
                      <div>
                        <h3>Show, don’t tell</h3>
                        <p>Walk them through your screen.</p>
                        <span>
                          Record screen
                          <ArrowRight size={14} />
                        </span>
                      </div>
                      <ArrowUpRight size={18} className="shortcut-arrow" />
                    </button>
                  </div>
                </section>
              )}

              {selection === "all" && !search && (
                <section
                  className="folders-section"
                  aria-labelledby="folders-heading"
                >
                  <div className="section-heading">
                    <h2 id="folders-heading">
                      Folders <span>{folders.length}</span>
                    </h2>
                    <button
                      className="text-button"
                      onClick={() => setDialog({ type: "folder" })}
                    >
                      <Plus size={15} />
                      New folder
                    </button>
                  </div>
                  <div className="folder-grid">
                    {folders.map((folder) => (
                      <button
                        key={folder.id}
                        className="folder-card"
                        onClick={() => navigate(`folder:${folder.id}`)}
                      >
                        <span
                          className="folder-card-icon"
                          style={{ color: folder.color }}
                        >
                          <FolderIcon
                            size={26}
                            strokeWidth={1.5}
                            fill="currentColor"
                            fillOpacity={0.13}
                          />
                        </span>
                        <span>
                          <strong>{folder.name}</strong>
                          <small>
                            {
                              projects.filter(
                                (project) => project.folderId === folder.id,
                              ).length
                            }{" "}
                            projects
                          </small>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                    <button
                      className="new-folder-card"
                      onClick={() => setDialog({ type: "folder" })}
                    >
                      <Plus size={21} />
                      <span>
                        {folders.length
                          ? "Create folder"
                          : "A place for every project"}
                        <small>
                          {folders.length
                            ? "Keep good ideas together"
                            : "Create a folder to get organized"}
                        </small>
                      </span>
                    </button>
                  </div>
                </section>
              )}

              <section
                className="projects-section"
                aria-labelledby="projects-heading"
              >
                <div className="section-heading projects-heading">
                  <div className="project-tabs">
                    <h2 id="projects-heading">
                      {search
                        ? "Search results"
                        : selection === "all"
                          ? "Your projects"
                          : "Projects"}{" "}
                      <span>{visibleProjects.length}</span>
                    </h2>
                  </div>
                  <div className="project-tools">
                    <label className="search-box">
                      <Search size={16} />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search projects…"
                        aria-label="Search projects"
                      />
                      {search && (
                        <button
                          className="icon-button"
                          onClick={() => setSearch("")}
                          aria-label="Clear search"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </label>
                    <label className="sort-select">
                      <select
                        aria-label="Sort projects"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="updated">Last edited</option>
                        <option value="created">Date created</option>
                        <option value="name">Name A–Z</option>
                      </select>
                      <ChevronDown size={13} />
                    </label>
                    <div className="view-toggle" aria-label="Project view">
                      <button
                        className={layout === "grid" ? "active" : ""}
                        aria-label="Grid view"
                        aria-pressed={layout === "grid"}
                        onClick={() => setLayout("grid")}
                      >
                        <Grid2X2 size={16} />
                      </button>
                      <button
                        className={layout === "list" ? "active" : ""}
                        aria-label="List view"
                        aria-pressed={layout === "list"}
                        onClick={() => setLayout("list")}
                      >
                        <List size={18} />
                      </button>
                    </div>
                  </div>
                </div>
                {!loaded ? (
                  <div className="loading-grid" aria-label="Loading projects">
                    {[1, 2, 3].map((i) => (
                      <div key={i} />
                    ))}
                  </div>
                ) : visibleProjects.length ? (
                  <div className={`projects-${layout}`}>
                    {visibleProjects.map(projectCard)}
                  </div>
                ) : (
                  <div className="empty-projects">
                    <div className="empty-film" aria-hidden="true">
                      <div className="empty-film-back" />
                      <div className="empty-film-front">
                        <Film size={28} strokeWidth={1.3} />
                        <span />
                        <span />
                      </div>
                      <span className="empty-film-plus">
                        <Plus size={13} />
                      </span>
                    </div>
                    <h3>
                      {search
                        ? "No projects found"
                        : selection === "favorites"
                          ? "Keep your favorites close"
                          : selection === "recent"
                            ? "A fresh start awaits"
                            : "Your first take starts here"}
                    </h3>
                    <p>
                      {search
                        ? `Try another name or search in All projects.`
                        : selection === "favorites"
                          ? "Use a project’s menu to add it to your favorites."
                          : "Record something new or import a video. This is where it all comes together."}
                    </p>
                    <div>
                      {search ? (
                        <button
                          className="button secondary"
                          onClick={() => {
                            setSearch("");
                            navigate("all");
                          }}
                        >
                          Show all projects
                        </button>
                      ) : selection === "favorites" ? (
                        <button
                          className="button secondary"
                          onClick={() => navigate("all")}
                        >
                          Browse projects
                          <ArrowRight size={15} />
                        </button>
                      ) : (
                        <>
                          <button
                            className="button primary"
                            onClick={() => record()}
                          >
                            <Plus size={16} />
                            Create a recording
                          </button>
                          <button
                            className="text-button"
                            onClick={() => fileRef.current?.click()}
                          >
                            or import a video
                            <ArrowUpRight size={14} />
                          </button>
                        </>
                      )}
                    </div>
                    <span className="empty-drop-hint">
                      {!search &&
                        selection !== "favorites" &&
                        "You can also drop a video anywhere here"}
                    </span>
                  </div>
                )}
              </section>
              {activeFolder && (
                <div className="folder-delete-row">
                  <button
                    className="text-button"
                    onClick={() =>
                      setDialog({ type: "delete-folder", folder: activeFolder })
                    }
                  >
                    <Trash2 size={14} />
                    Delete this folder
                  </button>
                </div>
              )}
              <footer className="workspace-footer">
                <span>
                  <ShieldCheck size={14} />
                  Private by default. Saved on your device.
                </span>
                <span>
                  Ready when inspiration hits.
                  <Sparkles size={13} />
                </span>
              </footer>
            </main>
            {dragging && (
              <div className="drop-overlay">
                <div>
                  <Upload size={42} />
                  <h2>Drop it into your studio</h2>
                  <p>Your video will become an editable project.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <input
        className="sr-only"
        type="file"
        ref={fileRef}
        accept="video/*,.webm,.mp4,.mov,.m4v"
        multiple
        onChange={(e) => {
          void importFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
        aria-label="Import video files"
        tabIndex={-1}
      />
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={19} className="spin" />
          {busy}
        </div>
      )}
      {notice && (
        <div
          className={`toast ${notice.error ? "toast-error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <CircleHelp size={18} /> : <Check size={18} />}
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {dialog?.type === "folder" && (
        <Modal
          title={dialog.folder ? "Edit folder" : "A home for your projects"}
          onClose={() => setDialog(null)}
        >
          <form onSubmit={(e) => void submitFolder(e)}>
            <label className="field-label">
              Folder name
              <input
                name="name"
                placeholder="e.g. Tutorials, Client work, Big ideas"
                defaultValue={dialog.folder?.name}
                autoFocus
                required
                maxLength={60}
              />
            </label>
            <fieldset className="folder-colors">
              <legend>Folder color</legend>
              {folderColors.map((color, index) => (
                <label key={color} style={{ color }}>
                  <input
                    type="radio"
                    name="color"
                    value={color}
                    defaultChecked={
                      dialog.folder
                        ? dialog.folder.color === color
                        : index === 0
                    }
                    aria-label={
                      ["Lavender", "Mint", "Sand", "Rose", "Blue"][index]
                    }
                  />
                  <span>
                    <FolderIcon size={20} />
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit">
                {dialog.folder ? "Save changes" : "Create folder"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog?.type === "project" && (
        <Modal title="Project details" onClose={() => setDialog(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void changeProject(dialog.project, {
                name: String(data.get("name")).trim() || "Untitled project",
                folderId: String(data.get("folder")) || null,
              })
                .then(() => {
                  setDialog(null);
                  notify("Project updated.");
                })
                .catch(() => {});
            }}
          >
            <label className="field-label">
              Project name
              <input
                name="name"
                defaultValue={dialog.project.name}
                required
                maxLength={120}
                autoFocus
              />
            </label>
            <label className="field-label">
              Folder
              <select
                name="folder"
                defaultValue={dialog.project.folderId ?? ""}
              >
                <option value="">No folder</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit">
                Save changes
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog?.type === "delete-project" && (
        <Modal title="Delete this project?" onClose={() => setDialog(null)}>
          <p className="dialog-description">
            “{dialog.project.name}” and its original video will be permanently
            removed from this device. Download a copy first if you want to keep
            it.
          </p>
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              Keep project
            </button>
            <button
              className="button danger"
              onClick={() => {
                void deleteProject(dialog.project.id)
                  .then(refresh)
                  .then(() => {
                    setDialog(null);
                    notify("Project deleted.");
                  })
                  .catch((error: unknown) =>
                    notify(
                      error instanceof Error
                        ? error.message
                        : "Could not delete project.",
                      true,
                    ),
                  );
              }}
            >
              <Trash2 size={16} />
              Delete project
            </button>
          </div>
        </Modal>
      )}
      {dialog?.type === "delete-folder" && (
        <Modal title="Delete this folder?" onClose={() => setDialog(null)}>
          <p className="dialog-description">
            “{dialog.folder.name}” will be removed. Its projects will stay in
            All projects.
          </p>
          <div className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setDialog(null)}
            >
              Keep folder
            </button>
            <button
              className="button danger"
              onClick={() => {
                void deleteFolder(dialog.folder.id)
                  .then(refresh)
                  .then(() => {
                    setDialog(null);
                    navigate("all");
                    notify("Folder deleted. Your projects are still here.");
                  })
                  .catch((error: unknown) =>
                    notify(
                      error instanceof Error
                        ? error.message
                        : "Could not delete folder.",
                      true,
                    ),
                  );
              }}
            >
              Delete folder
            </button>
          </div>
        </Modal>
      )}
      {dialog?.type === "help" && (
        <Modal
          title="From idea to finished video"
          onClose={() => setDialog(null)}
        >
          <div className="help-steps">
            <div>
              <span>01</span>
              <div>
                <h3>Get in the frame</h3>
                <p>
                  Choose camera, screen, or both. Enable your preview, allow
                  access, then start recording. Pause whenever you need a
                  moment.
                </p>
              </div>
            </div>
            <div>
              <span>02</span>
              <div>
                <h3>Make the cut</h3>
                <p>
                  Select and delete sections in the timeline, or trim, split,
                  and rearrange clips. A transcript is generated after
                  recording; delete words to cut their footage, or remove filler
                  words and quiet pauses. Save your edits to pick up later.
                </p>
              </div>
            </div>
            <div>
              <span>03</span>
              <div>
                <h3>Make it yours to share</h3>
                <p>
                  Export your edited video and download the file. Export runs in
                  real time, so keep the tab open and visible until it finishes.
                </p>
              </div>
            </div>
          </div>
          <div className="help-note">
            <Monitor size={18} />
            <p>
              Use desktop Chrome or Edge for the full recording experience. To
              include screen audio, enable audio in the browser’s share picker
              when available. Screen sharing here records your selected screen
              into a video.
            </p>
          </div>
          <button
            className="button primary full-width"
            onClick={() => {
              setDialog(null);
              record();
            }}
          >
            Create your first recording
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {dialog?.type === "settings" && (
        <Modal title="Your personal workspace" onClose={() => setDialog(null)}>
          <div className="settings-storage">
            <HardDrive size={26} />
            <div>
              <strong>{formatBytes(totalBytes)}</strong>
              <span>stored across {projects.length} video projects</span>
            </div>
          </div>
          <p className="dialog-description">
            Projects and original videos are saved in this browser on this
            device. Download important recordings as a backup. Clearing site
            data also removes your projects.
          </p>
          <div className="settings-details">
            <div>
              <span>Storage</span>
              <strong>Local to this browser</strong>
            </div>
            <div>
              <span>Available space</span>
              <strong>
                {usage.quota
                  ? formatBytes(Math.max(0, usage.quota - usage.usage))
                  : "Managed by browser"}
              </strong>
            </div>
            <div>
              <span>Account</span>
              <strong>No account needed</strong>
            </div>
          </div>
          <button
            className="button secondary full-width"
            onClick={() => {
              void requestPersistentStorage()
                .then((granted) =>
                  notify(
                    granted
                      ? "Persistent storage enabled for this workspace."
                      : "Your browser manages storage automatically. Keep downloaded backups of important videos.",
                  ),
                )
                .catch(() =>
                  notify(
                    "This browser does not support persistent storage requests.",
                    true,
                  ),
                );
            }}
          >
            <ShieldCheck size={16} />
            Protect local storage
          </button>
          <p className="settings-footnote">
            Asks your browser to keep this workspace when freeing up space. Your
            browser decides whether to grant the request.
          </p>
        </Modal>
      )}
    </>
  );
}
