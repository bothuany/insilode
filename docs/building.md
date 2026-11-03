# Building and running Insilode

## Install

Insilode is installed from the files on the [Releases](https://github.com/bothuany/insilode/releases) page: an installer for Windows, an app for macOS and packages for Linux, with `SHA256SUMS.txt` beside them. Each one ships with everything it needs, so no Node, git or build tools are required. Your data lives in `~/.insilode` on every OS. Insilode installs beside, not over, a stock VS Code or Code - OSS: it has its own app id (bundle id on macOS, desktop entry on Linux), install folder, `insilode://` link scheme and data folder.

**C# flows need the .NET 10 SDK** ([download](https://dotnet.microsoft.com/download/dotnet/10.0)), whatever the OS. Insilode's C# analyzer is a .NET 10 program that loads your solution with MSBuild, so the runtime alone is not enough. Without the SDK everything else works; the first time a C# flow is asked for, Insilode shows one notice that says so. Other languages need nothing.

> **Not published yet:** `winget install bothuany.Insilode`, `brew install --cask bothuany/tap/insilode` and an APT repository are prepared in [`packaging/`](../packaging/README.md) but not submitted or hosted. Until they are, install from the release files below; updating means installing the newer release over the old one.
>
> **macOS and Linux packages are new:** 0.1.0 is the first release that ships them. They are built and packaged on GitHub's runners, but have not been run on a Mac or a Linux desktop yet; please [report problems](https://github.com/bothuany/insilode/issues).

### Windows

The quickest way is one command in PowerShell. It downloads the latest installer, checks it against `SHA256SUMS.txt` and runs it silently, without the SmartScreen prompt below (SmartScreen checks files a browser downloaded, and this download is not one of them):

```powershell
irm https://insilode.dev/install.ps1 | iex
```

Or download `Insilode-Setup-<version>-x64.exe` and run it. It installs for the current user (no admin rights) into `%LOCALAPPDATA%\Programs\Insilode`, adds a Start menu entry and, if you leave the options ticked, the `insilode` command on your PATH and "Open with Insilode" on folders in Explorer. Insilode updates itself (Restart to Update in the title bar), or you run a newer Setup over the old install; 0.4.3 and older cannot update themselves, so run the Setup once by hand over those. Uninstalling is Windows Settings, Apps.

- Install into a short path (the default, `%LOCALAPPDATA%\Programs\Insilode`, is fine). The longest file in Insilode is about 155 characters below the install folder, and Windows stops at 260 in total, so an install folder that is itself 100 characters deep fails with "MoveFile failed; code 3".
- The installer is not code-signed yet, so a Setup downloaded in a browser makes Windows SmartScreen show "Windows protected your PC" the first time: choose *More info*, then *Run anyway*. The command above skips this. Smart App Control, where it is turned on, blocks unsigned programs either way.
- Later: `winget install bothuany.Insilode` (not submitted yet).

### macOS

The quickest way is one command in Terminal. It downloads the latest app for your Mac's processor, checks it against `SHA256SUMS.txt` and puts it in Applications, and Insilode then opens without the Gatekeeper prompt below (Gatekeeper checks files a browser downloaded, and this download is not one of them). Run it again to update.

```bash
curl -fsSL https://insilode.dev/install.sh | sh
```

Or download `Insilode-<version>-darwin-arm64.dmg` (Apple silicon) or `Insilode-<version>-darwin-x64.dmg` (Intel), open it and drag Insilode to Applications. The `.zip` files hold the same app. For the `insilode` command, choose *Shell Command: Install 'insilode' command in PATH* from the Command Palette.

- **Insilode is not signed with an Apple Developer ID yet**, so macOS blocks the first launch of an app downloaded in a browser ("Insilode" Not Opened). The command above skips this. Otherwise open it once, then go to *System Settings > Privacy & Security* and choose *Open Anyway* (then confirm with your password). If macOS says Insilode "is damaged and can't be opened", clear the download quarantine instead: `xattr -dr com.apple.quarantine /Applications/Insilode.app`.
- Later: `brew install --cask bothuany/tap/insilode` (the tap does not exist yet). The cask also puts `insilode` on your PATH, and `brew upgrade` will keep it current.

### Linux

Download `insilode_<version>_amd64.deb` and install it on Debian 12, Ubuntu 22.04 or newer:

```bash
sudo apt install ./insilode_<version>_amd64.deb
```

It installs into `/usr/share/insilode`, adds `insilode` to `/usr/bin` and a desktop entry (`dev.insilode.insilode.desktop`, icon `insilode`), so it installs beside a VS Code or Code - OSS package. Unlike VS Code's package, it does not add any apt repository. For Fedora and other RPM distributions there is `insilode-<version>-1.x86_64.rpm` (`sudo dnf install ./insilode-*.rpm`), and `Insilode-<version>-linux-x64.tar.gz` unpacks anywhere (run `Insilode-linux-x64/insilode`). All are x64 only.

- Later: an APT repository so that `sudo apt install insilode` and `apt upgrade` work ([how it would be hosted](../packaging/apt/README.md); not set up yet).

### Coming from Axle

Insilode is Axle under a new name (0.5.0 is the first release called Insilode). It keeps working from what Axle left; nothing of Axle's is deleted.

- **Windows:** run `Insilode-Setup-<version>-x64.exe` over the old install. It keeps Axle's installer id, so it upgrades in place (the folder stays `%LOCALAPPDATA%\Programs\Axle`), removes `Axle.exe`, the `axle` command, the old shortcuts and "Open with Axle", and adds Insilode's. The `axle` command is gone: use `insilode`.
- **macOS and Linux:** the app is a new one (`Insilode.app`; on Debian the `insilode` package replaces `axle`). Delete `Axle.app` yourself.
- **Your data:** on its first start Insilode copies Axle's user data folder (`%APPDATA%\Axle`, `~/Library/Application Support/Axle` or `~/.config/Axle`: settings, keybindings, snippets, workspace trust) and `~/.axle` (extensions, `argv.json`) to `Insilode` and `~/.insilode`, once. The old folders stay as they were.
- **Settings:** `axle.skeletonFirst.enabled`, the overlay screen `axle`, the `axleFocused` auto-hide flag and the "Axle Dark/Light" themes are moved to their new names, in the scope they were set in.
- **Claude Code tools:** a user-level MCP server named `axle` may keep working after the update (its tools are still `mcp__axle__*`) but is not guaranteed to: it can point at a program the new install no longer has. Insilode asks once whether to move it to `insilode`, and shows the two commands it would run first. Permission rules you wrote for `mcp__axle__*` are yours: rename them to `mcp__insilode__*`.
- **Agent worktrees and tours:** worktrees under `.axle/worktrees` and branches `axle/<name>` keep working; new ones go to `.insilode/worktrees` and `insilode/<name>`. Tour files with `"axleTour": 1` still load; new ones say `"insilodeTour": 1`.
- **The repository** is now `bothuany/insilode`; `bothuany/axle` redirects to it (releases, downloads and the update files of installed 0.4.x apps included). No repository called `bothuany/axle` may be created again: that would end the redirect.
- **Versions up to 0.4.3** cannot install an update by themselves: run the new Setup once by hand. They do see "Update available" (the release carries the update files under Axle's old names too, `update-*-axle.json`).

### Updates

Insilode checks the latest release by itself: **Update available** on the gear and under Help, Check for Updates. Windows downloads, installs and offers **Restart to Update**; macOS and Linux open the release page. `update.mode` (`none`, `manual`, `start`, `default`) works as in VS Code. How the update files are made, what each platform does, and how to test an update against a local server (`INSILODE_UPDATE_URL`): [packaging/README.md](../packaging/README.md#updates).

### Build the packages yourself

**The Windows installer** (Windows, after `npm run setup`, plus the .NET 10 SDK and the Windows SDK, whose `signtool.exe` VS Code's build calls):

```bash
npm run installer                   # dist/Insilode-Setup-<version>-x64.exe, per user
npm run installer -- --system       # also dist/Insilode-Setup-<version>-x64-system.exe (all users, asks for admin rights)
npm run installer -- --fast         # reuse editor/VSCode-win32-x64 when VS Code, the core patch, product.json and the icon are unchanged since the last full build (dist/app-build.stamp says so): only Insilode's own parts and Inno Setup run again, minutes instead of half an hour
npm run installer -- --full         # the full build whatever the stamp says (the default)
```

It builds the extensions, the canvas and the analyzer, runs VS Code's production build (15 to 40 minutes, several GB of RAM, about 20 GB of disk) and its Inno Setup step, and prints where the installer is. Pushing a `v*` tag builds and attaches it to a GitHub release (`.github/workflows/release.yml`), together with the `update-*-insilode.json` files that tell installed copies about it.

**The macOS and Linux packages** (on that OS, after `npm run setup`, plus the .NET 10 SDK; on Linux also `fakeroot`, and `rpm` for the .rpm):

```bash
npm run package                     # macOS: dist/Insilode-<version>-darwin-<arch>.zip and .dmg; Linux: dist/insilode_<version>_amd64.deb, the .rpm and the .tar.gz
```

It does what the installer does up to VS Code's production build, then signs the app ad hoc and makes the zip and the disk image (macOS), or runs VS Code's deb and rpm packaging with Insilode's control file and maintainer scripts (Linux). The packages are built for the machine's own processor. A `v*` tag builds all of them on GitHub's runners and attaches them to the release.

## Requirements

| | macOS | Windows | Linux |
|---|---|---|---|
| Node 24.x (24.18 or newer; 25 will not do) and git | required | required | required |
| .NET 10 SDK, for C# flows | optional | optional | optional |
| Build tools for VS Code's native modules | Xcode Command Line Tools | Python 3 + Visual Studio Build Tools ("Desktop development with C++" plus its "MSVC Spectre-mitigated libs"; with Visual Studio 2026 also set `vs2022_install` to its folder and use npm 11.6+ / node-gyp 12+) | `build-essential`, `libx11-dev`, `libxkbfile-dev`, `libsecret-1-dev` |

`npm start` opens Insilode in its own window (Electron, like any VS Code fork). `npm run web` serves the same editor to a browser instead. On Windows, `npm run shortcut` adds a Desktop and Start menu shortcut; it points at the Node that ran it, so run it again after you switch Node versions (nvm, fnm).

## Getting started

```bash
git clone https://github.com/bothuany/insilode.git
cd insilode
npm run setup
npm start
```

`npm run setup` clones VS Code 1.141.0 into `editor/vscode`, applies `editor/patches`, links the Insilode extensions into it, and builds everything. The first run takes 10–20 minutes, mostly VS Code's `npm ci`. Running it again skips the clone, the patches, the links and (when nothing changed) `npm ci`; `--force-install` runs that anyway. If `editor/vscode` is at another VS Code version, or the patches do not apply to it, setup stops and says to delete it and run again. Steps that are optional (Electron's pre-launch, the server's Node, the app icon stamp, the C# analyzer) only warn when they fail, and the summary at the end lists them.

```bash
npm start -- path/to/project     # Insilode window, opening a folder
npm run web -- path/to/project   # same editor, served for a browser
```

A folder is resolved from the directory you ran the command in. `npm run web` prints the URL to open, and it carries a random `?tkn=` token (new on every start) that the server requires: open that URL, not `http://127.0.0.1:8765` alone. The port is 8765, or `FLOW_PORT` when set (`FLOW_PORT=9000 npm run web`). The server listens on 127.0.0.1 only. It reads the token from a private temporary file instead of its command line, and it starts with `--accept-server-license-terms`, so running it accepts the VS Code server terms for you.

**Web mode is for your own code only.** The core patch (`webviewEndpoint` in `webClientServer.ts`) serves webviews from the same origin as the workbench, so that they work offline. A browser then no longer isolates a webview from the editor: do not open untrusted folders or install untrusted extensions in `npm run web`. The Electron window (`npm start`) is not affected.

**Your data folder is `~/.insilode`.** Insilode's `product.json` sets `dataFolderName` to `.insilode`, so it does not share `~/.vscode-oss` with a stock Code - OSS build. Anything you already have in `~/.vscode-oss` (extensions you installed, state) is not migrated; copy what you want over by hand.

## Layout

```
editor/patches/     core patches to VS Code (branding, theme hooks, chat defaults, webview fixes)
editor/branding/    the app icon (.ico, .icns, .png), drawn by scripts/make-icons.py (needs Pillow)
editor/extensions/
  flow-view/        canvas host, endpoints list, Roslyn + polyglot providers, Claude Code /ide bridge
  flow-agent/       terminal agents and the Agents dock (plus ACP chat sessions, off by default)
  flow-harness/     harness map, hook studio, permission inbox, context budget
  flow-theme/       Insilode's colour theme and defaults
  flow-import/      Import from VS Code: settings, shortcuts, snippets, theme, extensions (docs/import-from-vscode.md)
ui/                 the canvas (React Flow + Monaco), built into one script the extension inlines
site/               the website (GitHub Pages): the real canvas on demo data from the real index, guided tours, downloads
analyzer/           C# analyzer (.NET 10, Roslyn MSBuildWorkspace) serving flows over HTTP
scripts/            setup, start, build-extensions, install-shortcut and installer (Windows .exe), the same on every OS (lib.mjs starts programs without a shell)
```

## Developing

- Extensions: edit under `editor/extensions`, then `npm run build:extensions` and reload the window (`Developer: Reload Window`).
- Canvas: `npm run build:canvas`, then reload the window.
- Core patches: change files in `editor/vscode`, then regenerate the patch from there. New files must be known to git first, and the icons that `setup` copies into `resources/` must stay out of the patch:
  `git add -N src product.json && git diff HEAD -- build src product.json > ../patches/flow-core.patch`. Run it in Git Bash (or any POSIX shell): Windows PowerShell 5.1 writes `>` output as UTF-16, which breaks the patch.
- The update service is `editor/patches/flow-update.patch`, kept apart from the core patch. No two patches may change the same file (the build checks each one with `git apply --reverse --check`, and `test/update` enforces it), so its `product.json` settings (`quality`, `updateUrl`) live in the core patch. Regenerate it the same way, from a checkout that has the other patches applied: commit that state inside `editor/vscode` first, edit, then `git diff HEAD > ../patches/flow-update.patch` (a file you added needs `git add -N` first).
- After a pull that changes `editor/patches/flow-core.patch`, `editor/vscode` still carries the old patch: `npm run setup` stops with "does not apply", and `npm run installer` / `npm run package` say the patches are missing. When only `product.json` changed in the patch (as when Insilode's macOS bundle id and Linux desktop and icon names replaced Code - OSS's), re-apply just that file, then run setup:
  `git -C editor/vscode checkout -- product.json && git -C editor/vscode apply --include=product.json ../patches/flow-core.patch`. After any other patch change, delete `editor/vscode` and run `npm run setup` for a clean checkout.
- Tests: `cd editor/extensions/flow-view && npm test` builds the index worker and checks what it finds in every project under `test/fixtures` against `test/expected` (after an intended change: `UPDATE=1 npm test`, then read the diff). `npm run typecheck` there checks the types.

## Probing and testing the app without taking over your screen

An agent (or you) that wants to see Insilode running must not open a window on a machine somebody is using. There are three ways, by what you need to see:

| You need | Use | Why |
|---|---|---|
| Most UI: the canvas, cards, tours, boards, the dock, endpoints, callers | **Web mode**: `npm run web` in the built-in browser pane (the [probe skill](../.claude/skills/probe/SKILL.md)) | Headless, seconds to start, no window. Everything an extension or the canvas draws is the same code as in the desktop app |
| What only the desktop app has: the status island (a second window), focus and window behaviour, the taskbar badge, native menus, a first-run dialog | **Docker**: `npm run docker:e2e` or `-- --probe <file>` | Real Electron on a virtual display (xvfb) inside a container: no window, pointer or port reaches your machine |
| Windows-only: the installer, the in-app update, uninstall | **Windows Sandbox**: `npm run sandbox:e2e` | A disposable Windows; Docker is Linux only |

Never your own desktop, and never GitHub Actions (nothing here runs there except the harness's own unit tests in `ci.yml`). `test/e2e-desktop/run.mjs` refuses to open a window unless `INSILODE_E2E_ISOLATED=1`, which only the Docker entrypoint and the sandbox script set, inside the machine they isolate: do not set it on a machine you use.

### Docker (any OS with Docker Desktop in Linux-containers mode)

```bash
npm run docker:e2e                                    # the scenarios below on the working tree
npm run docker:e2e -- --scenario island,canvas-tour   # only these
npm run docker:e2e -- --probe my-probe.mjs [args]     # one Playwright script; test/e2e-desktop/probes/hello.mjs is the smallest
```

A probe script imports `startInsilode`, `shot` and `runCommand` from `/work/insilode/test/e2e-desktop/lib/probe.mjs` (the path inside the container), starts Insilode on the demo project and drives it with Playwright's `page`. Screenshots, `results.json` and logs go to the output folder the command prints (a new folder in the temp directory; `--out <dir>` picks another), never into the repository. Read the screenshots from there; do not commit them.

How it stays fast. The image holds only the toolchain. The copy of Insilode, the VS Code checkout and its build live in the named volume `insilode-e2e-work`, and each run copies only the files that changed since the last one and rebuilds only what that needs: nothing for unchanged sources, the canvas and the extensions (a few seconds) for a change in `ui/`, `protocol/` or an extension, the whole setup for a change to the C# analyzer or a package lock, and a new VS Code checkout for a changed patch or `scripts/setup.mjs` (the 20 to 40 minute step). `--reset-volume` starts over; `--volume <name>` uses another volume.

Time (this machine, Docker Desktop, 16 cores, 16 GB for the VM): the first run builds the image and the VS Code checkout (about 5 minutes for the image and 20 to 40 for the checkout, one time; not timed to the minute); a probe on an unchanged tree takes about 30 seconds (the app starting is most of it); after a change in an extension about 35 seconds. Disk: the image 2.5 GB, the volume 9 GB (7.7 GB of it the VS Code checkout and its build). To reclaim it, `docker image rm` the `insilode-e2e:*` tags and `docker volume rm insilode-e2e-work`; Docker's shared build cache (`docker builder prune`) also holds our image's layers, but it belongs to everything you build, so prune it deliberately.

What the scenarios check:

| Scenario | What it checks |
|---|---|
| Branding | the window title says Insilode, nothing says Code - OSS, no Welcome or Get Started page or dialog opens |
| Canvas and tour | the flow canvas opens as an editor tab and a tour plays on it |
| Status island | it shows, minimizes, is dragged, hides while Insilode is focused and closes (a fake agent list comes from `test/e2e-desktop/driver`) |
| Installer (Windows Sandbox only) | silent install, the update through `INSILODE_UPDATE_URL` against a local static server (detect, download, ready, Update, relaunch on the new version), silent uninstall |

In the container Chromium needs `--disable-dev-shm-usage` (Docker's `/dev/shm` is small; without it a few percent of the module loads fail and the workbench never starts); the harness sets it.

### Windows Sandbox (Windows 10/11 Pro, Enterprise or Education)

```bash
npm run installer                   # once: dist/Insilode-Setup-<version>-x64.exe
npm run sandbox:e2e                 # newest installer in dist/, or: npm run sandbox:e2e -- --installer <exe>
```

Turn the feature on once: "Turn Windows features on or off", tick **Windows Sandbox**, OK, restart (or, as administrator, `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`); virtualization must be on in the BIOS. If it is missing, the command says so and stops. The launcher stages the installer, `node.exe` and the test code into a temp folder, writes a `.wsb` that maps that folder **read-only** and an output folder read-write (networking, clipboard, audio and GPU off), starts the sandbox minimized, and waits for `done.json`. Inside, a logon command runs `test/e2e-desktop/sandbox/run-in-sandbox.ps1` (it only needs Windows, so it also runs on any Windows machine that is not yours): install, the scenarios, update, uninstall, screenshots to the output folder, shutdown. The launcher prints the results and the screenshot paths. Your own Insilode install and profile are never touched. Only one sandbox can run at a time, and its window opens minimized.

`npm run test:e2e-unit` tests the harness itself (the `.wsb`, the Docker arguments, the command lines) with no window; it runs in `ci.yml`.

## The website

`site/` is the site at https://insilode.dev/: a home page whose hero is the real flow canvas on a fictional demo project, with a guided tour, one section per problem Insilode solves and the downloads; and a Try page with guided stories on the canvas and the Agents dock. The canvas, the dock page, the island page and the harness scan are Insilode's own, built from the demo project by the real code (what each part is, and what is written for the page, in [site/README.md](../site/README.md)). From the repository root:

```bash
(cd ui && npm ci)
(cd editor/extensions/flow-view && npm ci && node esbuild.mjs)
(cd editor/extensions/flow-harness && npm ci)
node scripts/site-data.mjs              # writes site/public/data and site/public/pages (not committed)
cd site && npm ci
npm run typecheck && npm run build      # the site is in site/dist
npm run test:e2e                        # plays the tours and the stories in headless Chrome
npm run preview                         # http://127.0.0.1:4173/insilode/ (the path GitHub Pages serves it under)
```

`npm run dev` in `site/` serves it with hot reload. In Git Bash on Windows, `/insilode/` in the preview script is rewritten to a Windows path: run `npm run preview` from PowerShell or set `MSYS_NO_PATHCONV=1`. `npm run arch` keeps `site/` to imports from `ui/`, `protocol/` and four vscode-free files of flow-agent. `.github/workflows/site.yml` deploys it on every push to `main` (and `ci.yml` builds and tests it on pull requests); Pages must be enabled once with the source "GitHub Actions".
