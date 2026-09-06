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
- **Edit:** trim clip boundaries, split at the playhead, delete or reorder clips, undo and redo, set volume or mute, add a title, and choose original, landscape, portrait, or square framing.
- **Export:** download an edited video with your clip order, trims, framing, title, and audio applied. The browser selects a supported recording format, usually WebM. You can also download the untouched original.
- **Organize:** create, rename, and color folders; move and rename projects; favorite videos; search and sort; switch between grid and list views. Removing a folder keeps its projects.
- **Keep working:** projects, edits, and source videos persist in IndexedDB across reloads. Returning from the editor saves pending edits first.

## Storage and browser behavior

Recordings stay in this browser on this device. Media is not uploaded. Fonts are bundled locally. Browser data belongs to a specific origin: use the same localhost address and port each time to access the same workspace.

Download backups of important videos. Clearing browser site data removes local projects, and browser storage quotas still apply. Workspace settings includes an optional persistent-storage request; the browser decides whether to grant it. If recording saves fail, the recorder retains the result and offers retry or direct download.

Camera, microphone, and screen capture require **localhost or HTTPS** and permission from the browser. Screen capture opens the browser's own source picker. Audio-sharing options vary by browser, operating system, and the selected source; sharing a browser tab with its audio option enabled is the most predictable choice. Mobile browsers have more limited screen-capture support.

The screen-sharing feature captures your selected screen into a recording. This version does not host live calls, public sharing links, or cloud synchronization.

Screen sharing can be started and stopped during preview, recording, or a pause. Stopping sharing in Frame or in the browser returns to your camera; if no camera is active, the canvas is blank. The microphone and recording continue in their current states. Share again to select another tab, window, or screen. Cancelling the screen picker leaves the current recording intact. Only **Stop recording** finishes and saves the take.

Edited exports render in **real time**. Keep the tab visible until completion. The editor keeps the entire source frame and adds dark space for a different aspect ratio. Titles appear throughout the video. Exports are limited to a 1920px longest edge. Long recordings consume memory while recording/exporting; this version does not perform background encoding, automatic transcription, multitrack editing, or crash recovery during an active recording.

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

The library test covers import, persistence, folder/project management, search, favorites, and responsive layouts. Recorder tests use Chrome's synthetic camera input; simulated display inputs exercise composition without opening a physical screen picker. The export test generates and decodes real video to check edits, audio, and cancellation. Screenshots and fixture outputs are written to `test-results/`, which is ignored by Git. Real hardware selection and the native screen picker should also be checked manually in your browser.

## Code map

- `src/App.tsx`: project library, navigation, folders, import, and dialogs.
- `src/features/recorder/`: recording setup, preview, controls, and recovery.
- `src/lib/capture.ts`: media acquisition, audio mixing, camera composition, and cleanup.
- `src/features/editor/`: video preview, timeline, settings, and export UI.
- `src/lib/export-video.ts`: shared preview rendering and actual edited video encoding.
- `src/lib/timeline.ts`: pure clip and timeline operations.
- `src/lib/storage.ts`: transactional IndexedDB storage with separate metadata and video stores.
- `src/lib/media.ts`: video metadata, thumbnails, downloads, and formatting.

Browser API references: [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder), [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), and [canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream).
