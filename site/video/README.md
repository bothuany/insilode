# Feature loops

The four silent loops on the home page, made with [HyperFrames](https://hyperframes.heygen.com) from the site's own pages. The
delivered files are in [public/media/loops](../public/media/loops): `<loop>.webm` (VP9), `<loop>.mp4` (H.264) and
`<loop>-poster.webp`, 1600x1000 at 30 fps, each at most 2.5 MB.

| Loop | What it shows |
| --- | --- |
| `reading` | The POST /orders flow with its reading pane: `l` steps into a call, `j` steps over, `l` again, then Enter opens the call across HTTP into Python. The canvas follows each step as a trace. |
| `review` | The agent's change set fanning out to the four endpoints it reaches, the canvas's review of its two changed cards, then Keep on one: the card goes plain. |
| `services` | The invoice tour, played by the canvas's tour player: a Java endpoint, the HTTP call into billing, the Python route, its query and the table it reads. |
| `agents` | The app's Agents page: the needs-you strip, Alt+Shift+N opens the agent that waits, then two sessions dragged onto pane edges split the workspace. |

Nothing in a loop is drawn for it. Every frame is a headless capture of the built site: canvas.html (the canvas, ui/, on the fake host)
driven the way a visitor drives it, and the Agents page on the Try page. The loops add only a camera that pushes in so the code reads,
the keys pressed (keycaps) or one short label per beat, and a dissolve back into the first frame so they loop without a cut.

The review loop is two captures. On the change set itself, Keep leaves the demo with nothing to show (its one prompt is its whole
change, so the canvas reports that there are no changes left), so the loop dissolves at the second change into the same step of the
same review on the endpoint's own flow, where Keep turns the card plain.

## Rebuild

Everything runs headless; nothing opens a window. It needs Chrome or Edge (`CHROME_PATH` to pick one), ffmpeg on the path, and the
site built (`npm run build`). Captures and renders are working material and stay out of the repo, in a work folder
(default `%TEMP%\insilode-loops`, or `$TMPDIR/insilode-loops`).

1. **Capture.** `node video/capture.mjs [site build dir] [work dir] [shots]` serves the build (default `dist`) the way GitHub Pages
   does and records each shot with Chrome's screencast at 1440x900, painted at 2x: `<work>/capture/<shot>.mp4` and `<shot>.json` (when
   each key or click happened, and the boxes the camera frames).
2. **Projects.** `node video/build.mjs [work dir] [loops]` writes one HyperFrames project per loop under `<work>/build/<loop>/`: the
   camera keys, the beats and the seam are in its `loops()`. Check one with `npx hyperframes check` and
   `npx hyperframes snapshot --at <seconds>` in its folder.
3. **Deliver.** `node video/deliver.mjs [work dir] [media dir] [loops]` renders each project and writes the WebM, the MP4 and the poster
   into `public/media/loops`, at the best quality that fits 2.5 MB.

Run all three from `site/`. After a change to the canvas or the demo data, capture again; the camera keys that are fixed rects in
`build.mjs` (the reading pane, the tour's frame, the Agents page's panes) may need a look then.
