import { useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";
import "./editor-shortcuts.css";

const shortcuts = [
  ["Play / pause", "Space"],
  ["Split at playhead", "S"],
  ["Mark section start / end", "I / O"],
  ["Delete selected section or clip", "Delete / Backspace"],
  ["Seek backward / forward 0.1s", "← / →"],
  ["Seek backward / forward 1s", "Shift + ← / →"],
  ["Go to beginning / end", "Home / End"],
  ["Undo", "Ctrl / ⌘ + Z"],
  ["Redo", "Ctrl / ⌘ + Shift + Z"],
  ["Save edits", "Ctrl / ⌘ + S"],
  ["Show shortcuts", "?"],
];

export default function EditorShortcutsDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="ed-shortcuts-dialog"
      aria-labelledby="ed-shortcuts-title"
      aria-describedby="ed-shortcuts-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="ed-shortcuts-title">
          <Keyboard size={21} /> Keyboard shortcuts
        </h2>
        <button onClick={onClose} aria-label="Close keyboard shortcuts">
          <X size={19} />
        </button>
      </header>
      <p id="ed-shortcuts-description">
        Work from the preview or timeline. Text fields and sliders keep their
        usual keys; transcript deletion applies to selected words.
      </p>
      <dl>
        {shortcuts.map(([action, keys]) => (
          <div key={action}>
            <dt>{action}</dt>
            <dd>
              <kbd>{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      <p>
        I and O select footage within the current clip. When the scrollable track
        itself is focused, arrow keys pan the view. Ctrl + Y also redoes an edit.
        Press Escape to close.
      </p>
    </dialog>
  );
}
