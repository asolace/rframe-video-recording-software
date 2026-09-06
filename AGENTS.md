# Frame recording studio

This is a React + TypeScript + Vite application for local video recording, editing, and project organization.

- Do not start a dev server. The user runs `npm run dev` manually.
- Verify using `npm run build` and `npm test`.
- Keep recordings in IndexedDB; metadata and blobs are stored separately.
- Never request camera/microphone/screen permissions on page load.
- Preserve source recordings when editing. Exports must apply the saved edits.
- The user explicitly requested a dark interface throughout. See DESIGN.md.
- Browser APIs require HTTPS or localhost. Desktop Chrome or Edge is the primary target.
