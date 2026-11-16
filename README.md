# Quick Notes

A quick-capture notes app (a Google Keep replacement) that saves every note as a Markdown file in
Google Drive › 03. Readables › Notes. Installable on phone, tablet and laptop; works offline.

- Opens straight to a blank note and saves as you type.
- Notes and checklists, labels, pinning, search across all notes.
- Works offline: notes are saved on the device first and sent to Drive when there's internet and a sign-in.
- Warns instead of overwriting when a note changed on another device.
- Android "Share to Quick Notes" for links and text (once installed).
- Updates only when you tap **Update now**.

Anywhere other than https://vikmmn.github.io it opens in demo mode with a pretend Drive.

## Note files
`YYYY-MM-DD HHmm <title or first words>.md`, in Notes › Inbox, with front matter for `id`, `created`,
`updated`, `labels`, `pinned` and `source` (notes, keep or notion), then `# Title` and the note.
Checklists are `- [ ]` / `- [x]` lines.

## Files
| File | What it is |
|---|---|
| `index.html` | The page and its look |
| `app.js` | The screens: the note, the list, sync status |
| `notes.js` | Note file format, the copy on this device, syncing with Drive |
| `drive.js` | Google sign-in and Google Drive (plus the pretend Drive for demo mode) |
| `config.js` | Settings: sign-in key, Readables folder, version number |
| `sw.js` | Makes it installable and holds updates until approved |
| `manifest.webmanifest`, `*.png` | App name, icons and the Android share target |
| `demo-data.js` | Pretend notes for demo mode only |

## Releasing an approved update
1. Change `VERSION` in both `config.js` and `sw.js` (e.g. 1.0.0 → 1.0.1).
2. Push the changed files.
3. In the app, tap **Check for update**, then **Update now**.
