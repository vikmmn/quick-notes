# Serendipity (quick-notes): rules for Claude Code sessions

Plain JavaScript PWA, no build step, no tests. Files are big: **never read a whole file.** `grep -n` for the
section marker or function, then read ~100 lines around it. (`app.js` ≈ 4,000 lines, `ink.js` ≈ 2,800;
`vendor.js` is bundled libraries, never open it.)

## Code map: where to look
| Problem is about… | File: search for this marker |
|---|---|
| Notes grid, folders, tabs, search box, menus, settings, What's new, updates | `app.js`: `// ---------- Home`, `Folders drawer`, `Tabs`, `Settings`, `Updates` |
| Toolbars, tool layouts, workspaces, wheel, pucks, quick corner | `app.js`: `Tool layouts`, `Workspaces`, `The quick corner`, `Wheel`, `Pucks` |
| Layers panel, formatting bar, fonts, images in notes | `app.js`: `Layers panel`, `Formatting bar`, `Fonts`, `Images:` |
| Zoom, pan, turn, linear mode, navigator, text boxes, touch gestures | `canvas.js`: `The view`, `Text boxes`, `Fingers`, `Linear mode`, `The navigator` |
| Drawing, brushes, lasso, fills, shapes, transforms, undo, curves | `ink.js`: `The engine`, `Selection (Lasso`, `Pointer input`; curves math in `curves.js` |
| Saving, Drive sync, outbox, "changed on another device" | `notes.js`: `Syncing with Google Drive`, `The outbox`, `Changed on another device`; merging in `merge.js` |
| Google sign-in, Drive API, demo mode | `drive.js` |
| Feedback button and report | `bug.js` (+ `screenshot.js`); relay is `server/sign-in-helper.js` |
| Offline, updates, background sync | `sw.js` |

## Rules
1. **One approved change at a time.** Do what the issue/brief says; no refactors, no new frameworks, no extra files.
2. **Release = bump `VERSION` in BOTH `config.js` and `sw.js`** (same string), add new files to the cache list in `sw.js`,
   and update the "What's new" slide in `app.js` only if the change is user-visible.
3. **Before every push:** `node --check` on each changed `.js` file. Fixing a reported bug? Re-read the issue and
   make sure the fix covers *what was reported*; reports often say "still" after a partial fix.
4. **Sync/merge/notes data format: extra care.** Never change how a note file is written or merged without the
   Founder's explicit OK. Data loss is the worst outcome.
5. **Say what was tested.** End every PR/commit body with: `Verified: <what you ran> · Not tested: <what you couldn't>`.
   Never write "fixed" for something you didn't check.
6. **Cite the feedback issue** as `#N` in the commit (the project already does).
7. **Keep README accurate** when behaviour changes (it already drifted on conflict handling, since 3.36 notes merge silently).
8. Feedback issues live in the private repo `vikmmn/quick-notes-feedback`. After the Founder confirms a fix on their
   device, close that issue with a one-line comment. Don't close issues on your own judgement.
9. Privacy: feedback pictures may show real notes. Never paste them anywhere outside GitHub.
10. **After every release, update `STATE.md`** (this repo is public, so no personal or quota details): add one row to Releases
   (version, date, issues, Verified, Not tested), keep only the last 10, and refresh "Open now". Commit it with the release.

## Cost rules (the Founder's Claude quota is limited)
- Don't re-read files you've already read this session. Batch: fix every issue in the brief in one pass.
- Prefer targeted `grep -n` + small ranges over reading files; don't dump long output.
- If the task needs a decision, ask one short question instead of exploring options.
