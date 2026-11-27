# The website

https://insilode.dev/: the home page and the Try page, with the real canvas on a fictional demo project (`demo/`: orders and shipping in Java, billing in Python). A static site: no backend, and the only third-party request is GitHub's public API (the star count and the latest release). The site has one theme, dark, like every marketing visual ([docs/design/messaging.md](../docs/design/messaging.md)); the palette and its contrast ratios are at the top of `src/site.css`, shared by every page. The home page has its own sheet, `src/home.css`, built on one idea: the page is a request in flight. The editor window in the hero sits in the middle of the demo's real POST /orders flow, with pulses running along its wires; a trace down the left edge fills as you read, the way the canvas marks the path to the card you are on; and the centre of the page is the real canvas, pinned, walking that request step by step as you scroll. Section labels are drawn like the canvas's card kinds. Motion is progressive: CSS scroll timelines where the browser has them (written as longhands, because the minifier folds a shorthand and `animation-timeline` into one shorthand that browsers reject), and still under reduced motion. The first design and its reasoning are in [docs/site/direction](../docs/site/direction/README.md) (direction A, "Light table").

## The pages

- **Home** (`index.html`, `src/home.ts`, `src/home.css`): the slogan ("Every code editor shows your files. Insilode shows how your code runs.", the first sentence faded, "runs" lit with a trace drawn under it) and a one-line subhead that says it is built on VS Code (the wording and the type, Instrument Sans and JetBrains Mono, are in [docs/design/messaging.md](../docs/design/messaging.md)); then the hero loop, a silent capture of the real editor that links to the Try page (`src/loop.ts`), tilted back and laid flat as the page scrolls, with the POST /orders flow's entry point, HTTP call, message and tables wired to its sides on wide screens (inline SVG; the labels are the demo index's own); the launch film with its voice in a modal player, only when the visitor asks (`src/film.ts`; the build copies `docs/media/film/launch-film.mp4` and its poster into `media/film/`, so there is one committed copy; its captions are in the picture and the dialog has the transcript), and the agents it works with. Then "Built on VS Code" (what carries over, and a drifting band of what VS Code does); the live canvas, pinned on a wide screen while the scroll walks the POST /orders tour (`src/journey.ts`); one section each for the reading pane, the change review and the services a request crosses, each with a clip; the agents, with the app's own dock live on the page and its status island hanging at the top of the window while the section is on screen; the harness scan; boards, tours and diagrams; what the agent can do over MCP (its 19 tools); the languages; what a visitor can check (licence, releases, CI, this folder); the downloads, with the install commands to copy.
- **Try** (`try/index.html`, `src/try.ts`): the canvas large with three stories (two guided tours and the canvas's own review of an agent's change, with Keep and Undo), and the Agents dock with the status island, in either of the app's avatar styles (gyro or pixel). `#order`, `#changes` and `#invoice` in the address play that story at once.
- **Docs** (`docs/`, `src/docs.ts`): the repository's own Markdown as pages of the site: `README.md` (from its first section) and `docs/building.md`, `languages.md`, `agent-tools.md` and `boards.md`. `scripts/docs-pages.mjs` writes them before every build and dev start (generated, not committed); links between these documents stay on the site, links to any other file go to it on GitHub.
- **canvas.html**: the iframe page both use. It imports `ui/` after `src/host.ts` has set the globals the webview reads.

## What is Insilode's own, and what is not

| Part | Where it comes from |
| --- | --- |
| Canvas | `ui/src/webview.tsx`, unchanged, on a fake host (`src/host.ts`); only its overview map is hidden (`canvas.html`) |
| Flows, callers, impact, tables, the change set | flow-view's code index (the polyglot worker) run on `demo/`, and its own `changeSet.ts` / `turnImpact.ts` |
| Guided tours | written by hand in `demo/tours.json` by card label and line text; `scripts/site-data.mjs` resolves them against the index (it fails when a card or a line is gone), and the canvas's own tour player plays them |
| Agents dock and status island | the app's own pages (flow-agent's `dockPage.ts`, the island page inside `editor/patches/flow-desktop.patch`), ranked and mapped by flow-agent's `attention.ts` and `desktopModel.ts` |
| **The three agents** | **written for the page** (`src/agents.ts`): a fixed moment, not a live session; "Allow the test run" moves the waiting one on |
| Harness section | flow-harness's own scan of the demo project, drawn by the page (`src/clips.ts`) |
| Stills | headless captures of this site's own canvas and Try page (`scripts/capture-media.mjs`), committed in `public/media/` |
| Hero loop (`public/media/hero-loop.webm`, `.mp4`, `-poster.jpg`, and `hero-loop-narrow.*` for phones; the README's `docs/media/insilode-editor.webp` is its poster) | a headless stop-motion capture of the real workbench in web mode, run with **the app's own defaults**: the server gets this checkout's built extensions, Insilode Dark included, through `docs/film/capture/workbench/exts.mjs` and a server like its `server.mjs` (own extensions and server-data folders, so a clean profile). That gives Insilode Dark, the activity bar at the top of the side bar, Cascadia Code 12 px in the terminal and the rest of flow-theme's `configurationDefaults`; nothing is set by hand. Chrome runs headless at a real device scale factor (`--force-device-scale-factor=1.5`, a 1280x800 window), not an emulated one, so the terminal measures its cells as the app does. The project is a copy of `demo/base` with `demo/changed` left uncommitted. The loop: OrderController.java open, POST /orders picked in Insilode's Endpoints view, the canvas zooms in and pans across the service's calls, then the flow tab closes and the explorer is back, the same frame it started on, so the seam is a 6-frame crossfade between two equal frames. Claude Code runs in the terminal (started from the Agents dock, no prompt sent). The pointer is drawn on the page. The phone version is the window's middle (code, canvas and terminal) at 864x900. Only the web build's test status items (`Hello`, the keyboard layout) and the canvas's overview map are hidden. Capture it again after a visible change to the workbench |

## How it fits together

- **The name** of the product is in `src/brand.ts` only: the pages get it through `{{name}}` (and `{{repo}}`, `{{site}}`), filled by `vite.config.ts`; the scripts import it. The download buttons match release files by their platform suffix, not by name.
- **The live canvas** (`src/stage.ts`, under "Follow one request through three services") is an iframe made when the page is idle (on a phone, only when the visitor taps "Explore the flow", then full screen). The poster gives way once the canvas has drawn its cards. A plain wheel over it scrolls the page and Ctrl or a pinch zooms: the page marks the iframe `data-wheel="page"` and `src/canvas.ts` passes the wheel up. It is out of the tab order until the visitor plays the tour or opens it.
- **The scroll-driven tour** (`src/journey.ts`): from 1100 px wide the canvas is pinned (CSS `position: sticky`) while a track as tall as the tour's steps scrolls past it. Each stretch of the track is one step: the page starts the canvas's own tour player on the POST /orders tour when the track pins, and then sends it the key of the step (its keys 1 to 9 go to a step), so the canvas is never driven by anything but its own player. The list beside it is the tour's step titles from the demo data, past steps plain and the current one lit, and a click on one scrolls to it. A click or a key of the visitor's in the canvas, or the Play button, hands the tour to the visitor until they pick a step from the list (the page's own keys are untrusted events, so they never count). Narrower, the track is not pinned and the list is not shown.
- **The status island at the top** (`src/home.ts`, `src/agents.ts`): the dock and the island are the app's own pages (`pages/dock.html`, `pages/island.html`), loaded when the agents section comes near and told about the Try page's three agents. The island is fixed under the navigation and slides in while the section is on screen, the way the app's hangs from the top of the screen.
- **Downloads and stars** (`src/download.ts`, `src/github.ts`): the page ships with links to the releases page; once GitHub answers, the primary button points at the visitor's file (a Mac gets the Apple silicon image, a phone the list), and answers are kept in `localStorage` for 30 minutes. No answer: no count, and the links stay on the releases page.
- **Clip slots** (`src/clips.ts`): each problem section names a slot (`data-clip`). A slot is a still until it gets `video` (a silent loop under `public/media/`); loops play only on screen and never under reduced motion.
- `scripts/site-data.mjs` builds the data: it runs the worker on two copies of the project (before the agent's change and with it), builds the change set and the turn's impact with flow-view's own code, resolves the tours, scans the harness, and writes the dock and island pages into `public/pages/`. `public/data/`, `public/pages/` and `src/generated/` are generated and not committed.
- `site/` may import only `ui/`, `protocol/` and these vscode-free files of flow-agent: `attention.ts`, `desktopModel.ts`, `avatars.ts`, `dockPage.ts`; nothing it reaches may import `vscode` (`npm run arch`). The generated `src/generated/demo-check.ts` makes `npm run typecheck` fail when the data and `protocol/flow.ts` disagree.

## Being found

Each page sets a title of its own (60 characters at most), a description (155 at most), its canonical address, `index, follow`, Open Graph and Twitter tags with the social card `media/og.jpg` (1200x630, made by `node scripts/og-image.mjs` from the hero loop's poster and the slogan, committed) and a Content-Security-Policy. The docs pages take their titles from `DOCS[].seo` in `scripts/docs-pages.mjs`. The home page adds JSON-LD (`SoftwareApplication` with `softwareVersion` from the root package.json, `Organization` with `logo.png`, `WebSite`) and the `google-site-verification` tag, and says in its own HTML what the product is and which languages and frameworks it reads. `{{site}}` comes from `SITE_URL` (default `https://insilode.dev`). The build emits `sitemap.xml` with every page and `robots.txt` (everything allowed, the sitemap named). The framed pages (`canvas.html`, `pages/dock.html`, `pages/island.html`) carry `noindex`. The e2e test "the pages can be found" fails when a page in the sitemap lacks any of these, or when the sitemap or robots.txt is missing.

## The domain (insilode.dev)

The site is served from the root of https://insilode.dev through GitHub Pages with a custom domain. The build writes `CNAME` (the host of `SITE_URL`) into `dist/`, so a deploy never drops the domain, and every URL in the pages is relative, so the site also works under a sub-path. Owner's steps (nothing in the repository does them):
1. DNS at the registrar: the apex `insilode.dev` points at GitHub Pages (four `A` records, optionally the `AAAA` ones; see GitHub's "Managing a custom domain for your GitHub Pages site"). Verify the domain in GitHub (Settings, Pages) first, so nobody else can claim it.
2. Settings, Pages: custom domain `insilode.dev`, then Enforce HTTPS once the certificate is issued.
3. The old address `https://bothuany.github.io/axle/` is redirected to the domain by GitHub once the custom domain is set, and the repository `bothuany/axle` redirects to `bothuany/insilode` (never create a repository of the old name again: installed 0.4.x apps rely on that redirect).

To serve a fork or a preview from elsewhere set `SITE_URL` (the repository variable of the same name in the workflow, or the environment variable locally): `{{site}}` and the sitemap follow it, and `CNAME` is written only for hosts that are not `*.github.io`.

## Run it

```bash
(cd ui && npm ci)
(cd editor/extensions/flow-view && npm ci && node esbuild.mjs)
(cd editor/extensions/flow-harness && npm ci)
node scripts/site-data.mjs              # public/data and public/pages
cd site && npm ci
npm run typecheck && npm run build
npm run test:e2e                        # headless Chrome (CHROME_PATH if it is not found)
npm run preview                         # http://127.0.0.1:4173/insilode/
node scripts/capture-media.mjs          # with the preview running: the stills in public/media/
```

`npm run dev` serves it with hot reload (at `/`, not `/insilode/`). In Git Bash on Windows `/insilode/` in the preview script is rewritten to a path: run it from PowerShell or set `MSYS_NO_PATHCONV=1`.

## Capturing the theme again

`src/theme/vscode-theme.css` was captured from Insilode 0.3.1. To refresh it after a theme change, run `npm run web`, open the workbench and run this in the browser console, then keep the `--vscode-*` entries the file already has:

```js
const cs = getComputedStyle(document.querySelector('.monaco-workbench'))
copy(Object.fromEntries([...cs].filter(n => n.startsWith('--vscode-') && !n.startsWith('--vscode-icon-')).map(n => [n, cs.getPropertyValue(n).trim()])))
```

## Deploys

`.github/workflows/site.yml` builds, tests and deploys to GitHub Pages on every push to `main`. The repository owner enables it once: Settings, Pages, Source "GitHub Actions". `ci.yml` builds and tests it on pull requests too.
