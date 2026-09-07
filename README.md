# Frame recording studio

A dark, personal video workspace built with React, TypeScript, and Vite. Record your camera or screen, edit your video, and organize projects in folders. No account or backend is required.

## Run locally

```powershell
npm install
npm run dev
```

Open the localhost URL printed by Vite. Use **desktop Chrome or Edge** for the full recording workflow. The development server is deliberately not started by the coding agent.

## What you can do

- **Record:** camera only, screen only, or screen with a camera overlay. Choose input devices, mute your microphone or camera, pause and resume, and stop to save directly into the editor. Use **Share screen** and **Stop sharing** during a recording to switch between your screen and camera without ending your take. Screen audio is included when the browser provides it.
- **Import:** choose or drop video files to create projects from existing footage.
- **Check your microphone:** after setting up preview, the live **Mic level** bar responds as you speak, including while recording or paused. It shows when your mic is muted and warns when the input is too loud. It measures the microphone independently of shared-screen audio.
- **Canvas:** new recordings use a fixed **1280 × 720, 16:9** canvas. Cameras and shared screens fit inside it. Canvas size cannot be adjusted in the editor; imported videos keep their original dimensions.
- **Edit:** trim clip boundaries, split at the playhead, delete or reorder clips, undo and redo, set volume or mute, and add a title.
- **Navigate the timeline:** zoom from **1× to 8×**, scroll horizontally, or choose **Fit** to see the whole edit. Focus the scrollable track to pan with arrow keys. The ruler, clips, and playhead stay aligned. Use the clip menu to select tiny fragments left by transcript cuts.
- **Keyboard editing:** use **Space** to play/pause, **S** to split, **I/O** to mark a section within the current clip, and **Delete/Backspace** to remove the selected section or clip. Arrow keys seek 0.1 seconds; Shift+Arrow seeks 1 second. Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z redoes, and Ctrl/⌘+S saves. Click the keyboard icon or press **?** for the full list. Text inputs and sliders keep their usual keys, and transcript deletion stays within selected words.
- **Delete a section:** select a clip, click **Select section**, then drag the two handles or enter **From/To** times. Click **Delete selected section** to remove that interval and join the remaining footage. Undo restores it. Times refer to the original recording.
- **Edit by transcript:** after a recording ends, Frame saves the video, opens **Transcript**, generates an English transcript on your device, and saves it automatically. For imported videos, click **Generate transcript**. Select words (Shift-click for a range), then press Delete/Backspace or the delete button to cut their video and audio from the timeline. The displayed transcript follows clip order and highlights the current word during playback.
- **Clean up speech:** remove recognized filler words such as “um” and “uh” in one action. Analyze silences with adjustable quietness and minimum duration, review the detected gaps, then apply the cuts. Undo restores these edits.
- **Export:** download an edited video with your clip order, deleted sections, transcript cuts, title, and audio applied. The browser selects a supported recording format, usually WebM. You can also download the untouched original.
- **Organize:** create, rename, and color folders; move and rename projects; favorite videos; search and sort; switch between grid and list views. Removing a folder keeps its projects.
- **Keep working:** projects, edits, and source videos persist in IndexedDB across reloads. Returning from the editor saves pending edits first.

## Storage and browser behavior

Recordings stay in this browser on this device. Media is not uploaded. Fonts are bundled locally. Browser data belongs to a specific origin: use the same localhost address and port each time to access the same workspace.

Download backups of important videos. Clearing browser site data removes local projects, and browser storage quotas still apply. Workspace settings includes an optional persistent-storage request; the browser decides whether to grant it. If recording saves fail, the recorder retains the result and offers retry or direct download.

Camera, microphone, and screen capture require **localhost or HTTPS** and permission from the browser. Screen capture opens the browser's own source picker. Audio-sharing options vary by browser, operating system, and the selected source; sharing a browser tab with its audio option enabled is the most predictable choice. Mobile browsers have more limited screen-capture support.

The screen-sharing feature captures your selected screen into a recording. This version does not host live calls, public sharing links, or cloud synchronization.

Screen sharing can be started and stopped during preview, recording, or a pause. Stopping sharing in Frame or in the browser returns to your camera; if no camera is active, the canvas is blank. The microphone and recording continue in their current states. Share again to select another tab, window, or screen. Cancelling the screen picker leaves the current recording intact. Only **Stop recording** finishes and saves the take.

Edited exports render in **real time**. Keep the tab visible until completion. Canvas framing is locked; previously saved framing remains supported for older projects. Titles appear throughout the video. Exports are limited to a 1920px longest edge. Long recordings consume memory while recording/exporting; this version does not perform background encoding, multitrack editing, or crash recovery during an active recording.

## Transcript and silence editing

Transcription starts automatically after a new recording is saved. Imported videos and reopened projects use the manual Generate button. The first run downloads an English Whisper model (about 45 MB) from Hugging Face, plus the speech runtime served with the app. The model is cached by the browser when storage is available. Audio and video stay on your device; transcription runs locally in a cancellable background worker. A saved transcript reopens without running the model again. Cancelling or a transcription failure keeps the saved recording safe and offers a manual retry.

Local transcript and silence analysis currently support source recordings up to **20 minutes and 512 MB**. For longer recordings, export a shorter section and import that file for analysis.

Automatic text and word timing can be imperfect. The model sometimes omits filler words, so automatic filler cleanup can only remove the ones present in the transcript. Review cuts in the preview and use Undo if needed. Silence detection measures audio energy rather than recognizing speech: adjust the threshold for quiet voices, and expect background sound or music to affect the results. Analysis uses the original audio regardless of the editor's playback volume or mute setting.

Transcript words use timestamps in seconds in the original source. Timed JSON import/export supports corrections without uploading the recording. Transcript deletion cuts only the selected occurrence when a source interval appears in more than one clip. The original recording is preserved through cuts, saves, and exports.

## Verify

```powershell
npm run build
npm test
```

Browser smoke tests use an installed Chrome through Playwright. They route the built files directly into an isolated browser context, without running a server:

```powershell
npm run build
npm run test:browser
```

The library test covers import, persistence, folder/project management, search, favorites, and responsive layouts. Recorder tests use Chrome's synthetic camera input; simulated display inputs exercise composition without opening a physical screen picker. Export and section tests generate and decode real video to check edits, locked framing, audio, and cancellation. Transcript editor tests use timed text fixtures and real audio to check word deletion, filler cleanup, silence cuts, undo, export, persistence, and automatic transcription lifecycle. Screenshots and fixture outputs are written to `test-results/`, which is ignored by Git. Real hardware selection and the native screen picker should also be checked manually in your browser.

The editor shortcut test checks keyboard actions, typing and transcript guards, saved edits, the shortcuts dialog, timeline zoom geometry, and mobile layout.

To additionally run the local speech model on real audio, with network access for the model and sample download:

```powershell
npm run test:transcription
```

The runtime regression checks both the local Vite path and production assets using real transcription. With your development server already running, run `npm run test:transcription:runtime`. It defaults to `http://localhost:5173`; set `FRAME_DEV_URL` for a different local origin. The test never starts a server.

## Code map

- `src/App.tsx`: project library, navigation, folders, import, and dialogs.
- `src/features/recorder/`: recording setup, preview, controls, and recovery.
- `src/lib/capture.ts`: media acquisition, audio mixing, camera composition, and cleanup.
- `src/features/editor/`: video preview, timeline, settings, and export UI.
- `src/lib/export-video.ts`: shared preview rendering and actual edited video encoding.
- `src/lib/timeline.ts`: pure clip and timeline operations.
- `src/features/editor/ClipSectionSelector.tsx`: selection handles and time boundaries for deleting footage.
- `src/features/editor/TimelineTrack.tsx`: synchronized, zoomable ruler, clip track, and playhead.
- `src/lib/crop.ts`: compatibility rendering for spatial crops saved by earlier versions.
- `src/lib/transcript-edit.ts`: timestamp validation and word-linked timeline cuts.
- `src/lib/transcription.ts` and `transcription.worker.ts`: local Whisper model lifecycle and word alignment.
- `src/lib/audio-analysis.ts`: local audio decoding and configurable silence detection.
- `src/lib/storage.ts`: transactional IndexedDB storage with separate metadata and video stores.
- `src/lib/media.ts`: video metadata, thumbnails, downloads, and formatting.

Browser API references: [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder), [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), and [canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream).

## Feature research

See the [Recordly comparison and roadmap](docs/recordly-review.md) for the source-based review, independently implemented editing improvements, and proposed next steps such as portable project backups, captions, waveform display, and export formats.
