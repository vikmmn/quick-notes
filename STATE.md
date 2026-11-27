# Serendipity: state

Kept up to date by the developer chat after each release. **This repo is public: no personal details, no quota or planning notes.**
The Manager chat reads this file to stay informed. Newest first; keep the last 10 releases.

**Latest release:** 3.43.0 (27 Nov 2026)

## Releases
| Version | Date | Issues / PR | Verified | Not tested |
|---|---|---|---|---|
| 3.43.0 | 27 Nov | feedback #143, #144, #152, #153, #154, #156, #157, #159, #162, #166 (part), #167, #169, #170, #171 (one navigator for both modes, map keeps its zoom after a jump + edge arrows; workspace rail fits between tabs and quick panel; back closes search; image menu placement; colour button lit; pictures redraw on arrival; no typing with drawing tools; one lock badge per locked group; zoom-aware fill smoothing; no long-press menu on the page; a drawn fill shape goes on top, not under pictures) | `node --check` on canvas.js, app.js, ink.js, config.js, sw.js | Everything on a device: no browser run in this session. #166's hold-still cancel is a guess at the cause (Android long-press menu). Navigator on a turned free canvas is approximate (frame drawn axis-aligned) |
| 3.42.0 | 25 Nov | PR #61: Curve tool (curves.js) | not recorded | not recorded |
| 3.41.4 | 24 Nov | PR #60: Grid/Texture rows, Layers list scrolling | not recorded | not recorded |
| 3.41.3 | 24 Nov | PR #59: feedback #128–#136 (toolbar/layout, slice eraser, circle-and-hold) | not recorded | not recorded |
| 3.41.2 | 24 Nov | PR #58: feedback #125 (reorder tools by hold-and-drag) | not recorded | not recorded |
| 3.41.1 | 24 Nov | PR #57: feedback #121–#124, #126–#127 | not recorded | not recorded |

("not recorded" = before this file existed. From the next release on, fill both columns.)

## Open now
- **Linear navigator (#115, #130, #154, #156, #157):** reworked in 3.43.0 (one map for both modes; zoom kept as an absolute scale, so it can't get stuck). Waiting for the Founder to confirm on the phone.
- **#160 ghost row** ("› › › … Free ×"): probably drawn only in the feedback screenshot (html-to-image keeps hidden navigator parts that have no box); waiting for the Founder to say whether it shows on the real screen.
- **Possible data/sync problems, unverified:** #68 (drawn shapes missing), #101 (note not appearing on another device), #105/#106 (slow cross-device sync), #158 (pictures wait for "Copying to Drive"), #161 (selection drops by itself, maybe a sync refresh). Needs a test before any change; don't touch notes.js / merge.js blindly.
- **#146 undo after a refined shape:** undo keeps items by reference and every path read (pen hold-to-shape, Nudge/Smooth, Curve Trace, moving) records properly; need to know which tool made the shape "faired".
- **#150 seams on a rubbed fill:** cause found: the eraser cuts a fill into up to 16 wedge pieces around its circle, and their shared edges show as hairlines. Fix needs a polygon union (merge the pieces back into one outline); not in the code yet.
- **#166 hold-still cancel:** shipped a guess (Android long-press menu took the pointer); confirm on device.
- **Feature requests from #137–#169 (for planning):** flip/rotate 90° (#138); nudge/smooth modes (#139, #140); history tree (#141); replace tool (#142); Paper options to the connector tool, artboards (#145); masking and arrange (#147, #148); one tap/lasso select mode with add/subtract (#149); lag diagnostics (#151); colour on the rail per tool, palette, recents, picker, fill smoothness (#162, #164, #165); "All" out of tap-cycling (#163); 2-/3-finger tap undo/redo (#168); movable ribbons (#137).
- **#172:** its picture is missing from the feedback repo.
- Feedback issues are never closed. Close one only after the Founder confirms the fix on their device.
