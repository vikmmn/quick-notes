# Quick Notes

A quick-capture notes app (a Google Keep replacement) that saves every note as a Markdown file in
Google Drive › 03. Readables › Notes. Installable on phone, tablet and laptop; works offline.

- Opens on the notes grid. Folders (nested, real Drive folders inside Notes) and labels.
- Each note is a canvas: a text box at the top left like Keep; double-tap anywhere for another text box;
  write or draw with a pen (an S Pen draws without switching tools; the finger scrolls); move text and drawings
  with the Move tool; the canvas grows as you need it.
- Word-style formatting (bold, italic, underline, strikethrough, highlight, colour, size, headings, lists,
  checklists, quotes, alignment, links), saved as Markdown. Undo and redo for everything.
- Smart search on the device: word forms, small typos, "exact phrases", ranked, with highlighted snippets.
- Works offline: notes are saved on the device first and sent to Drive when there's internet and a sign-in.
- Warns instead of overwriting when a note changed on another device.
- Android "Share to Quick Notes" for links and text (once installed).
- Updates only when you tap **Update now**.

Anywhere other than https://vikmmn.github.io it opens in demo mode with a pretend Drive.

## Note files
`YYYY-MM-DD HHmm <title or first words>.md`, in Notes › Inbox, with front matter for `id`, `created`,
`updated`, `labels`, `pinned` and `source` (notes, keep or notion), then `# Title` and the note.
Checklists are `- [ ]` / `- [x]` lines; underline, highlight, colour and size are small inline HTML tags.

A plain note is just Markdown. A note laid out on the canvas has one section per text box after a hidden
marker with its position, and its drawings in one hidden block at the end. Obsidian and other Markdown apps
hide the markers and show the text in reading order:

```
<!-- qn:box {"id":"b1","x":190,"y":150,"w":170} -->
Text of that box
<!-- qn:ink
{"groups":[{"id":"g1","x":20,"y":120,"strokes":[{"c":"ink","s":3,"p":[[0,0,0.5],[10,10,0.5]]}]}]}
-->
```

## Files
| File | What it is |
|---|---|
| `index.html` | The page and its look |
| `app.js` | The screens: notes grid, folders, a note, menus, formatting bar |
| `canvas.js` | The note canvas: text boxes, ink, moving, undo/redo |
| `search.js` | Search on the device |
| `notes.js` | Note file format, the copy on this device, syncing with Drive (notes and folders) |
| `vendor.js` | Bundled libraries: TipTap (rich text + Markdown), perfect-freehand (ink), markdown-it (previews) |
| `drive.js` | Google sign-in and Google Drive (plus the pretend Drive for demo mode) |
| `config.js` | Settings: sign-in key, Readables folder, version number |
| `sw.js` | Makes it installable and holds updates until approved |
| `manifest.webmanifest`, `*.png` | App name, icons and the Android share target |
| `demo-data.js` | Pretend notes for demo mode only |

## Releasing an approved update
1. Change `VERSION` in both `config.js` and `sw.js` (e.g. 1.0.0 → 1.0.1).
2. Push the changed files.
3. In the app, tap **Check for update**, then **Update now**.
