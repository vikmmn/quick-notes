# Serendip

A quick-capture notes app (a Google Keep replacement) that saves every note as a Markdown file in the user's own
Google Drive › Serendip (made on first sign-in). Installable on phone, tablet and laptop; works offline.
It asks Google only for the files it makes (`drive.file`), never the rest of Drive.

- Opens on the notes grid. Folders (nested, real Drive folders inside Notes) and labels.
- Each note is an endless page: pinch to zoom, two fingers to move, twist to turn (snaps straight; the compass
  straightens it), two-finger tap to undo, three-finger tap to redo; Fit everything, Zoom into an area, zoom to a
  lasso selection, and a Navigator map. Mouse wheel moves, Ctrl + wheel zooms.
- Each note is a canvas: a text box at the top left like Keep; double-tap anywhere for another text box;
  write or draw with a pen (an S Pen draws without switching tools; the finger scrolls); move text and drawings
  with the Move tool; the canvas grows as you need it.
- Drawing: pen, pencil, marker, brush and highlighter with colour, size, opacity and smoothing; whole-stroke and slicing
  erasers; lasso to select, move, resize, rotate, duplicate, recolour and group; nudge and smooth with a reach;
  tap-to-fill closed shapes or draw filled shapes; layers (with previews) with opacity, blend modes, hide, lock and masking.
  The stroke being drawn is painted on a low-latency canvas and only the changed parts of the drawing are redrawn.
  Pen › Finger: a finger draws, moves the page, or (Auto) draws until a pen is used on the device.
- Word-style formatting (bold, italic, underline, strikethrough, highlight, colour, size, headings, lists,
  checklists, quotes, alignment, links), saved as Markdown. Undo and redo for everything.
- Smart search on the device: word forms, small typos, "exact phrases", ranked, with highlighted snippets.
- Works offline: notes are saved on the device first and sent to Drive when there's internet and a sign-in.
- Warns instead of overwriting when a note changed on another device.
- Images in notes (saved to Notes › Attachments), at the cursor, below, or side by side with text.
- Labels work across folders: tap one to see every note with it, narrow by folder, rename it everywhere.
- Android "Share to Serendip" for links and text (once installed).
- Keeps sending changes while the phone sleeps (Background Sync in the service worker, Android Chrome).
- A feedback button (drag it anywhere; hide it in Settings): takes a picture of the whole app to draw on, asks for a
  problem, idea or question, and saves a note in "Feedback" (or an existing "Bug reports" folder) with the picture and
  the details (version, device, what was on screen, the last taps and any errors). `bug.js`, with `screenshot.js`
  (html-to-image, MIT) for the picture.
- Updates only when you tap **Update now** (Settings › Check for update).
- A cloud icon shows at a glance whether every note is in Drive; a banner appears only when something needs you.
- Stays signed in with the optional sign-in helper (see below).

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
| `canvas.js` | The note canvas: text boxes, pointer input, moving, undo/redo |
| `ink.js` | The drawing engine: layers, brushes, erasers, lasso, nudge/smooth, fills, previews |
| `privacy.html` | The privacy page linked from Google's sign-in screen |
| `search.js` | Search on the device |
| `notes.js` | Note file format, the copy on this device, syncing with Drive (notes and folders) |
| `vendor.js` | Bundled libraries: TipTap (rich text + Markdown), perfect-freehand (ink), markdown-it (previews) |
| `drive.js` | Google sign-in and Google Drive (plus the pretend Drive for demo mode) |
| `config.js` | Settings: sign-in key, sign-in helper address, Readables folder, version number |
| `server/sign-in-helper.js` | The Cloudflare Worker that keeps you signed in and carries feedback to GitHub (deployed separately, holds no data) |
| `sw.js` | Makes it installable, holds updates until approved, and sends changes handed over while the phone sleeps |
| `manifest.webmanifest`, `*.png` | App name, icons and the Android share target |
| `demo-data.js` | Pretend notes for demo mode only |
| `import.html`, `import.js`, `zip.js` | One-time copy from Google Keep (Takeout): reads the export from Drive in pieces, writes Notes › Keep |
| `notion.html`, `notion.js` | One-time copy from a Notion "Markdown & CSV" export, writes Notes › Notion |

## Copying notes in from Keep or Notion
These are one-time copies, not syncs. Open them from the Folders menu › Settings › Copy notes in.

Keep: open `import.html`, pick the Takeout export (found in Drive automatically,
or chosen from the device), look inside, then Import. Everything goes to Notes › Keep (archived notes to
Keep › Archive, Keep's Trash to Keep › Trash, images and recordings to Keep › Attachments). Running it again
skips what is already there.

Notion: open `notion.html`, pick the export zip (Settings › Export all workspace content › Markdown & CSV, with
sub-pages in folders). Pages go to Notes › Notion, sub-pages in folders named after their parent page, files to
Notion › Attachments, Tags become labels. Running it again skips what is already there.

## Syncing while the phone sleeps
When the app goes to the background it writes its unsent changes to an outbox in IndexedDB and registers a
Background Sync. The service worker sends them with the current Google sign-in even after the app is frozen,
and updates the note's copy on the device. The app takes back anything not yet started when it comes back, so a
change is never sent twice. Where Background Sync isn't available (iPhone), the app sends what it can before freezing.

## Feedback to the developer (through the sign-in helper)
The feedback button sends each report (words, the annotated picture and the details) through the sign-in helper to
a **private** GitHub repository, as an issue; the picture goes into its `shots/` folder. Reply on the issue and the
app shows the reply to the sender (a dot on the feedback button, a message, and Settings › Your feedback and
replies), where they can answer back. Each install has a random ID it keeps to itself; an issue holds only a
fingerprint of it, so only that install can read or answer its conversation. Closing an issue shows "Resolved".
Until this is set up, feedback is saved in the sender's own Drive › Feedback, as before.

1. **GitHub** › New repository › `quick-notes-feedback`, **Private**, with a README.
2. **GitHub** › Settings › Developer settings › Fine-grained tokens › Generate: only that repository;
   permissions **Issues: Read and write** and **Contents: Read and write**. Copy the token.
3. **Cloudflare** › the sign-in helper Worker › Edit code: paste the new `server/sign-in-helper.js` › Deploy.
   Settings › Variables and secrets: `FEEDBACK_REPO` (text) `vikmmn/quick-notes-feedback`, and
   `FEEDBACK_TOKEN` (secret) the token.

## Staying signed in (the sign-in helper)
Google gives a web app only one-hour sign-ins. `server/sign-in-helper.js` is a tiny Cloudflare Worker (free plan)
that turns one sign-in into a lasting one: it swaps Google's one-time code for a lasting permission, seals it with
your own key, and later turns the sealed copy into fresh one-hour sign-ins, silently. Nothing is stored on Cloudflare.
With `TOKEN_SERVER` empty in `config.js`, the app keeps using one-hour sign-ins.

One-time setup:
1. **Google Cloud Console** › Google Auth Platform › Clients › the Serendip web client:
   add the authorized redirect URI `https://vikmmn.github.io/quick-notes/`, and copy the client secret
   (Add secret if none is shown).
2. **Google Auth Platform › Audience**: set the publishing status to **In production**. In Testing, Google ends
   lasting sign-ins after 7 days. Google then shows an "unverified app" screen when you sign in: tap
   Advanced › Go to Serendip (fine for your own use).
3. **Cloudflare** (dash.cloudflare.com, free account) › Workers & Pages › Create › Worker, name it
   `quick-notes-signin`, Deploy, then Edit code: paste `server/sign-in-helper.js` and Deploy.
4. The Worker's **Settings › Variables and secrets**:
   `CLIENT_ID` (text, the ID in `config.js`), `CLIENT_SECRET` (secret), `SEAL_KEY` (secret, any long random text),
   `ALLOWED_ORIGIN` (text, `https://vikmmn.github.io`).
5. Put the Worker's address (`https://quick-notes-signin.<your-account>.workers.dev`) in `TOKEN_SERVER` in
   `config.js`, bump the version, push.
6. In the app: Update now, then Settings › Sign in with Google, once.

## Knowing everything is in Drive
The cloud at the top right: a tick when every note is in Drive, an arrow while changes are on their way, struck out
when offline (notes are safe on the phone). It turns amber, with a banner on the notes grid, only when something
needs you: a sign-in, a note changed on two devices, or changes that haven't reached Drive for 10 minutes while
online. Tap the cloud for details.

## Releasing an approved update
1. Change `VERSION` in both `config.js` and `sw.js` (e.g. 1.0.0 → 1.0.1).
2. Push the changed files.
3. In the app, tap **Check for update**, then **Update now**.
