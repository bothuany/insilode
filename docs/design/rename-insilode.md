# Rename: Axle → Insilode

Decided 2026-10-22. Pronounced IN-sih-lohd. The logo mark stays. Axle was dropped because of a pending AXLE trademark in
code analysis and because the name is crowded. Status: done. Phase 2 renamed the product (7dfc7d9 and the commits of that PR, first released in v0.5.0); section 7 says where it differs from this plan, and section 6 lists the outward steps only the owner can take. The rest of this page is the phase 1 plan as written: about 330 tracked
files contain "axle" (excluding the `maxLength` noise); `docs/research` (83 hits) is dated research and stays as written.

Spelling, used everywhere below: product `Insilode`, command / package / folder `insilode`, env `INSILODE_*`, workspace
folder `.insilode/`, Windows shell accelerator `I&nsilode`.

## 1. Decisions the user must make before phase 2

| # | Question | Recommendation |
|---|---|---|
| D1 | Reverse-DNS id for `darwinBundleIdentifier` / `linuxDesktopName` (permanent: macOS preferences, Keychain, Gatekeeper, Linux desktop file) | Buy `insilode.com` first, then `com.insilode.Insilode`. Without the domain: `io.github.insilode.insilode` (needs the GitHub org). Do not ship before this is fixed. |
| D2 | Windows Inno `AppId` GUIDs: keep or new | **Keep** (they are random GUIDs, not branded). The new Setup then upgrades the old install in place (section 3). New GUIDs install beside the old one and leave two uninstall entries. |
| D3 | First release number | `0.5.0` (a rename is a minor bump; the legacy update files below are keyed to it). |
| D4 | Repo location | **Changed twice on 2026-10-22; final: the repository was renamed in place to `bothuany/insilode`** (same owner; the `insilode` organisation is only reserved). GitHub 301-redirects `bothuany/axle`, release downloads and update URLs included, so installed 0.4.x apps keep finding their update files. **No repository named `bothuany/axle` may ever be created again**: it would end the redirect. The site is https://insilode.dev (Pages custom domain). |
| D5 | CLA / TRADEMARKS wording | Retitle both; add to the CLA one sentence that the project was renamed from Axle and earlier signatures cover it. Legal text: the user confirms. |
| D6 | Keep an `axle` command-line shim | No. The `axle` CLI is dropped (it is a PATH entry from the installer; stale shells fail with "not found"). Say so in the release notes. |

## 2. Inventory and decision per item

Legend: **rename** = plain rename now; **alias** = new name plus a compatibility path for one release (0.5.x), removed in
0.6; **migrate** = move user data once.

### 2.1 Identity (`product.json`, in `editor/patches/flow-core.patch`)

| Key | Now | New | Decision |
|---|---|---|---|
| nameShort, nameLong | Axle | Insilode | rename |
| applicationName | axle | insilode | rename (the CLI and `bin/` script) |
| dataFolderName | .axle | .insilode | **migrate** (3.2) |
| win32MutexName | axle | insilode | rename; the Setup's `AppMutex` lists both `insilode,axle` for 0.5.x so an install over a still-running 0.4.x waits for it |
| win32x64AppId, win32arm64AppId, win32x64UserAppId, win32arm64UserAppId | GUIDs | same GUIDs | **keep** (D2) |
| win32DirName, win32NameVersion, win32RegValueName | Axle | Insilode | rename; legacy cleanup (3.1) |
| win32AppUserModelId | Axle.Axle | Insilode.Insilode | rename (taskbar pins of the old one are lost: noted in release notes) |
| win32ShellNameShort | A&xle | I&nsilode | rename |
| win32TunnelMutex, win32TunnelServiceMutex, tunnelApplicationName, serverApplicationName | axle-* | insilode-* | rename (unused features, kept consistent) |
| darwinBundleIdentifier, linuxDesktopName | io.github.bothuany.axle / .Axle | per D1 | rename (new identity: new app beside the old on macOS/Linux) |
| darwinProfileUUID, darwinProfilePayloadUUID | UUIDs | same | keep |
| linuxIconName | axle | insilode | rename (`/usr/share/pixmaps/insilode.png`) |
| urlProtocol | axle | insilode | rename (nothing in the repo opens `axle://`; checked in phase 2) |
| quality | axle | insilode | rename; old apps still ask for quality `axle` (3.3) |
| updateUrl | github.com/bothuany/axle/releases/latest/download | github.com/insilode/insilode/releases/latest/download | rename after the repo move |
| `localize('... {0}', product.nameShort)` strings in the patch (onboarding, Inno messages in 13 languages) | Axle | follow the product name | rename (text in the patch) |

`editor/patches/flow-desktop.patch` (63 hits) and `flow-update.patch`: the VS Code source names `axleDesktop/`,
`axleOverlay*`, `IAxle*`, `axleUpdate.ts`, `axleVersion`, `AXLE_UPDATE_URL`, `AXLE_OVERLAY_CHANNEL`, `axleTour`,
`window.axleAvatar`. **Rename** all (`insilodeDesktop/`, `IInsilode*`, `insilodeUpdate.ts`, `insilodeVersion`, ...).
Patches are regenerated from a checkout that has the others applied (docs/building.md, Regenerate); the arch tests that
read these paths (`test/arch/avatars`, `desktop-focus`) move with them. No two patches may touch the same file: the
migration code (3.2) goes into `flow-desktop.patch` as a new hunk in `src/main.ts` (no current patch touches that file or `userDataPath.ts`; checked), and the build's per-patch reverse check confirms it.

### 2.2 Installer, packages, update files

| Item | Now | New | Decision |
|---|---|---|---|
| Windows installer | `Axle-Setup-<v>-x64.exe` | `Insilode-Setup-<v>-x64.exe` | rename (`scripts/installer.mjs`, `release.yml`, site `ASSETS` regex already matches `-Setup-`) |
| macOS | `Axle-<v>-darwin-{arm64,x64}.{zip,dmg}`, `Axle.app` | `Insilode-...`, `Insilode.app` | rename |
| Linux | `axle_<v>_amd64.deb`, `axle-<v>-1.x86_64.rpm`, `Axle-<v>-linux-x64.tar.gz`, `/opt/axle` | `insilode_...` etc. | rename; the `.deb` gets `Replaces: axle`, `Conflicts: axle`, `Provides: axle`, the RPM `Obsoletes: axle`, so `apt`/`dnf` swap the package (scripts/package.mjs, packaging/linux/deb/*) |
| Update files | `update-<platform>-axle.json` | `update-<platform>-insilode.json` | rename, plus **alias**: release 0.5.x also publishes the four legacy `update-*-axle.json`, built by the same function with `QUALITY = 'axle'`, pointing at the new installers (3.3) |
| `SHA256SUMS.txt`, release title `Axle <v>` | | `Insilode <v>` | rename |
| winget | `bothuany.Axle` (never submitted) | `bothuany.Insilode` / `Insilode.Insilode` once the org exists | rename (rename the manifest dir too) |
| Homebrew | `axle.rb`, tap `bothuany/tap/axle` (tap repo not created) | `insilode.rb` | rename |
| APT | `axle.asc`, `apt install axle` (not set up) | `insilode.asc` | rename |
| Artifact names in CI (`axle-installer`, `axle-${{ runner.os }}`), `sonar` project key `axle`, `axle-analyzer` | | `insilode-*` | rename |
| `package.json` name, description, repository; lockfiles | axle | insilode | rename (lockfile `name` fields regenerated with `npm install --package-lock-only`) |

### 2.3 The `axle` MCP server and agent plumbing

| Item | Decision |
|---|---|
| Server name `axle` → `insilode`; tools `mcp__axle__*` → `mcp__insilode__*` | rename; prompts in `explain.ts`, `skeleton.ts`, `ask.ts`, `prompts.ts`, the `.claude` skills/agents and docs/agent-tools.md use the new prefix |
| `out/axle-mcp.js` → `out/insilode-mcp.js`, source `mcp/axle-mcp.ts` | rename; **alias**: a 5-line `out/axle-mcp.js` stub that requires the new bundle, so the user-scope Claude registration (`claude mcp add axle ... node .../out/axle-mcp.js`, with `AXLE_WORKSPACE` in its env) keeps working until the user reconnects |
| User-scope registration (`~/.claude.json`, written through `claude mcp add`) | **migrate** with the existing consent dialog (`src/mcp/register.ts`): on activation, if `claude mcp get axle` exists and `insilode` does not, offer "Move the Axle tools registration to Insilode" (remove `axle`, add `insilode`). Never silently, it edits the user's Claude config. |
| Per-session config `axle-mcp-<id>.json` (flow-agent) | rename (temp files, regenerated per session) |
| Env `AXLE_BRIDGE_DIR`, `AXLE_WORKSPACE`, `AXLE_SESSION` | rename to `INSILODE_*`; the MCP server reads the old name as a fallback in 0.5.x (stale registrations still carry `AXLE_WORKSPACE`) |
| HTTP headers `x-axle-token`, `x-axle-session` | rename; the bridge accepts both in 0.5.x |
| Bridge registry `~/.axle/bridge` | moves with the data folder (3.2); in 0.5.x the window also writes its entry to `~/.axle/bridge` so a stale server finds it |
| Users' permission rules `mcp__axle__*` in `.claude/settings*.json` | not edited by us. flow-harness lint (permissions, hooks studio) flags a rule for a server that is not registered, with the rename as the suggested fix. In 0.5.x `mcp__axle__*` and `mcp__insilode__*` both count as the product's tools in `mcpToolPrefix`/`mcpServerOf` (flow-harness/transcript.ts) so the activity views keep reading old transcripts. |
| Hooks: `flow-hook.js`, `codex-hook.js`, Codex profile `axle` (`axle.config.toml`) | hook scripts keep their names (they are `flow-*`, not branded). Codex profile `axle` → `insilode`, file `CODEX_HOME/insilode.config.toml`; the old file is deleted on first write (we own it: "Axle writes it"). |

### 2.4 Commands, settings, ids

- Command ids are `flow.*` / `flowHarness.*` (the arch test pins them) and the extension ids are `flow.flow-view`, `flow.flow-agent`,
  `flow.flow-harness`, `flow.flow-theme`. **Keep**: not branded, and extension global state is keyed by them, so nothing needs migrating.
- Display strings change: category `Axle:` → `Insilode:`, displayNames `Axle View/Agents/Harness/Theme`, code action kinds
  `refactor.rewrite.axle` → `.insilode`, the "Axle: Ask agent about this…" lines.
- Settings: only `axle.skeletonFirst.enabled` is branded. Rename to `insilode.skeletonFirst.enabled`; **migrate**: on
  activation copy a user/workspace/folder value of the old key to the new key when the new one is unset. Also
  `flow-agent` setting `overlay.display` has the enum value `axle` (default): rename to `insilode`, **alias** (read `axle` as `insilode`).
- Theme: id and label `Axle Dark` / `Axle Light` → `Insilode Dark` / `Insilode Light`; the user's `workbench.colorTheme`
  holds the id. **Migrate**: flow-theme rewrites `Axle Dark|Light` in the user setting once. Also the product's
  `configurationDefaults` (package.json of flow-theme) and `flow-dark.json` `name`.

### 2.4a Persisted and wire names found in code (not just text)

| Name | Where | Decision |
|---|---|---|
| `"axleTour": 1` | the format key of saved `.tour.json` files: validated in `flow-view/src/tour/validate.ts`, written by the tour code, in fixtures and `docs/design/guided-tours.md`, and in committed tours of users | **alias**: write `"insilodeTour": 1`; the validator accepts both keys (old files keep loading), an error message names the new one. Fixture `demo-shop-orders.tour.json` stays on the old key to prove it, a second fixture uses the new one. |
| `window.axleAvatar`, `window.axleRender`, `axleFocused`, `IAxle*`, `AXLE_OVERLAY_CHANNEL` | host/webview and main/renderer globals inside one build, nothing persisted | rename |
| `ui/src` (comments only: `board.css`, `board.tsx`, `spec.ts`, `webview.css`, `webview.tsx`) | text | rename; the wire types in `protocol/` carry no brand |
| `analyzer/` (`FlowGraph.cs:464` comment; `Schema.cs` hits are `MaxLength` / `HasMaxLength`) | the analyzer's output has no branded key or tool name; the rest is `maxLength` noise | comment only |

### 2.5 Workspace and home folders

| Folder | Content | Decision |
|---|---|---|
| `<repo>/.axle/worktrees/<slug>` and branches `axle/<slug>` | agent worktrees: real checkouts users may hold | new worktrees go to `.insilode/worktrees`, branch `insilode/<slug>`. The dock, `dirs.ts`, the harness ignore pattern and `worktrees.ts` recognise **both** (`git worktree list` is the truth, existing ones keep working until removed). `.git/info/exclude` gets `/.insilode/` added; the old line stays. |
| `<repo>/.axle/tours/*.tour.json` | saved tours, possibly committed | read both folders, write `.insilode/tours`. One notification offers "Move tours to .insilode" (a `git mv`-style rename, never automatic: it is the user's committed data). |
| `~/.axle` (product dataFolderName: `extensions/`, `argv.json`, `bridge/`) | user-installed extensions, runtime args | **migrate** (3.2) |
| `%APPDATA%\Axle` / `~/Library/Application Support/Axle` / `~/.config/Axle` (Electron user data: `User/settings.json`, keybindings, snippets, global state, workspace trust, `storage.json`) | the settings | **migrate** (3.2) |
| `%LOCALAPPDATA%\Programs\Axle` | install dir | stays for upgrades with kept GUID (3.1); fresh installs get `...\Programs\Insilode` |
| `%TEMP%\axle-axle-user-x64` (update cache) | | rename |

### 2.6 Repo content

| Area | What | Decision |
|---|---|---|
| `site/` | one constant: `site/src/brand.ts` (`NAME`, `REPO`); plus `vite.config.ts` and `README.md` base URL / `SITE_URL`, canonical, sitemap, OG, JSON-LD, `scripts/site-data.mjs`, `site/demo`, `site/test` | rename; `REPO` changes only after the repo move; base path `/axle/` → `/insilode/` (or `/` with a custom domain) |
| Launch film `docs/film/brand.json` | on branch `claude/fervent-nash-05b4b1` (the launch-film session), not on main | **not edited here.** The film session changes `productName`, `spokenName` (IN-sih-lohd, not "Insilode" as a word to a TTS), `repoUrl`. Phase 2 sends it a message with the three values; capture folder `axle-film-shots` is outside the repo and stays. |
| README, docs (`building.md` 40 hits, `agent-tools.md`, `packaging/README.md` 27, `languages.md`, `docs/site`, `docs/design/*`), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue templates | | rename (text). `docs/research` stays as written, with one line at the top of its index that Axle is the old name. |
| LICENSE | holder is the author, no product name | no change |
| CLA.md, TRADEMARKS.md | title and body | rename, wording per D5. TRADEMARKS also states the new name's status honestly: no registration, search pending. |
| `CLAUDE.md`, `.claude/skills` (`add-mcp-tool`, `probe`, `quality-gate`, `update-golden`, `brag`), `.claude/agents` (3), `.claude/hooks/guard-paths.mjs` | | rename (text, `mcp__insilode__`, `probe`'s regex `/Axle → (http...)/` which must match what `scripts/start.mjs` prints) |
| Semgrep rules | file `.semgrep/rules/axle.yml`/`.ts`, 15 rule ids `axle-*`, referenced by `// nosemgrep: axle-...` comments across code, CI and `npm run semgrep:test` | rename to `insilode-*`, mechanical, then `npm run semgrep:test` |
| Tests and fixtures | `test/e2e-desktop` (122), `test/update` (45), `test/arch`, extension tests, `editor/extensions/flow-view/test/expected` goldens, `site/test` | rename. Golden output: `UPDATE=1 npm test` in flow-view, then the golden-diff-reviewer agent confirms only the name changed. `AXLE_E2E_*` → `INSILODE_E2E_*`; `refuse unless INSILODE_E2E_ISOLATED=1` stays the same rule (CLAUDE.md updated). Sandbox/Docker names (`/work/axle`, `/opt/axle`) rename. |
| Binary assets | `editor/branding/icon.*` (mark stays; no name in them), `editor/branding/concepts/axle-source.png` (rename file), `docs/media/axle-{demo.mp4,poster.jpg,preview.webp,social.png}` | rename the files; the social image and the demo video may show the old name: **list them in the PR, regenerate with the film session** (do not drop silently). |
| `scripts/make-icons.py`, `install-shortcut.mjs` (Start menu `Axle.lnk`), `start.mjs`, `setup.mjs`, `package.mjs` (41), `installer.mjs` (30) | | rename |
| `.github/workflows` (cla.yml document URL, release.yml) | | rename; URLs after the repo move |

## 3. Moving existing users

Fact check on the installed base: v0.4.2/0.4.3 contain the update **check** (`71bfeac`): they fetch
`<updateUrl>/update-<platform>-axle.json` and show "Update available". The Windows silent install on restart (`f4a6579`)
is on main but in no release; `docs/building.md` says 0.4.3 and older update by running the Setup by hand. So **no
installed copy can move itself**: the move is one manual run of the new Setup (Windows) or a manual download (macOS/Linux). The plan makes that
run clean and makes "Update available" point to it.

### 3.1 Windows (the one platform with an installer)

- GUIDs kept (D2): `Insilode-Setup` over the existing per-user install is an upgrade: same `AppId`, `UsePreviousAppDir`
  keeps `%LOCALAPPDATA%\Programs\Axle`. **Unverified**: `editor/vscode` is not checked out here, and upstream's `code.iss` `[Setup]` must be read for `UsePreviousAppDir`/`DefaultDirName` (VS Code leaves the former at Inno's default, yes). If it turns out to be `no`, a kept GUID would reuse the uninstall key but install into `Programs\Insilode` and orphan the old tree; phase 2 checks this first, in Windows Sandbox, before D2 is final. Fresh installs use `...\Programs\Insilode`. (The folder name stays `Axle` for
  upgraded users; cosmetic. Moving it would need the app closed and loses the Inno upgrade; not worth it.)
- The installer script (`flow-core.patch`, `build/win32/code.iss` hunk) gets a **legacy cleanup** step, tested in Windows
  Sandbox only: delete `Axle.exe`, `bin\axle.cmd`, the Start menu / desktop `Axle.lnk`, the registry
  "Open with Axle" keys (`Software\Classes\*\shell\Axle`, `Directory\shell\Axle`, `Directory\Background\shell\Axle`), the `axle://` protocol
  key, and the old PATH entry is the same `bin` folder so it needs no change. `AppMutex` lists both mutexes (2.1).
- First launch runs the data migration (3.2). Uninstall works from Windows Settings, Apps (the entry's display name becomes Insilode).
- Alternative if D2 is "new GUIDs": the same cleanup, plus the installer reads `HKCU\...\Uninstall\{old}_is1` and runs the old
  `unins000.exe /VERYSILENT` after install. More code, same result; not recommended.

### 3.2 Data migration (all platforms), in `flow-desktop.patch`, `src/main.ts`, before the user-data path is resolved

On first start, if the new folder is missing and the old one exists: **copy** (not move: an old Axle may still be installed
beside, e.g. macOS/Linux) and write `.migrated-from-axle` in the new one. Never delete the old data.
- Electron user data `Axle` → `Insilode`: everything except caches (`Cache`, `Code Cache`, `GPUCache`, `Crashpad`, `DawnCache`,
  `Singleton*`, `*.lock`). That carries `User/settings.json`, keybindings, snippets, `globalStorage` (state.vscdb: workspace
  trust, extension state), `storage.json`. Workspace storage is keyed by folder path hash, so it still matches.
- `~/.axle` → `~/.insilode`: `extensions/` (user-installed), `argv.json`; the bridge folder is recreated.
- Failures are logged and ignored: a failed copy must never block startup. A unit test runs the function on a temp tree
  (no window); the real flow is checked in Windows Sandbox/Docker through `test/e2e-desktop`.

### 3.3 Update files

- Release 0.5.0 publishes `update-<platform>-insilode.json` (what 0.5+ asks for) and, **for the 0.5.x line**, the four legacy
  `update-<platform>-axle.json` (what 0.4.x asks for) with the same payload, so a 0.4.x app shows "Update available" and
  its link/asset leads to the new Setup. Phase 2 verifies exactly what a 0.4.3 build does with that file on Windows
  (download or release page) in the Windows Sandbox, and the release notes carry a "moving from Axle" paragraph either way.
- It works only because `releases/latest/download` on the old URL is redirected: the repo is renamed or transferred, not
  copied, and the old name is never reused (D4). Keep the legacy files until the user decides the 0.4.x tail is gone (suggest: 3 months).
- macOS/Linux: "Update available" opens the release page (existing behaviour). macOS: new bundle id means a second app
  (`Insilode.app`) beside `Axle.app`; preferences are not shared, the data migration (3.2) copies settings on first launch. The release notes say to delete `Axle.app`.
  Linux: apt/dnf swap the package through `Replaces/Obsoletes`; the AppImage-less tarball users reinstall.

## 4. Phase 2 commits (reviewable order)

1. **Docs and text**: README, docs, CLAUDE.md, `.claude`, CONTRIBUTING, CLA, TRADEMARKS, issue templates, SECURITY (scripted replace
   with a reviewed exclusion list; `docs/research` and `maxLength`-like matches excluded; word-boundary regex).
2. **Identity**: `product.json` hunk, installer legacy cleanup, `flow-desktop`/`flow-update` renames (regenerated patches),
   `scripts/*` and `release.yml`, packaging dirs, update-manifest dual output.
3. **Compat and migration code**: data-folder copy (+ unit test), settings key, theme id, MCP stub / dual env / dual headers / re-registration prompt,
   worktree and tour folders read both, harness prefix handling.
4. **Tests, fixtures, goldens, semgrep ids, e2e harness names**.
5. **Site** (brand constant, base URL) and `docs/media` list.

Rule for every commit: it builds and passes the checks that touch what it changed; the full list runs on the last one.

## 5. Checks before the PR

`npm run arch`, `npm run semgrep:test` and `npm run semgrep`, `cd ui && npm run typecheck && npm run build`,
`dotnet build analyzer` then `cd editor/extensions/flow-view && npm test` (and the same for flow-agent and flow-harness),
`UPDATE=1 npm test` in flow-view followed by the golden-diff review, `npm run test:e2e-unit`, `test/update` (patch isolation),
site `npm run build` and its tests, and the clean patch apply check (`scripts/setup.mjs` on a fresh `editor/vscode`, with
`git apply --reverse --check` per patch). Probes run in web mode headless (`npm run web`, probe skill): the canvas and dock show
the new name, `mcp__insilode__*` works against the bridge, a seeded `~/.axle` + user-data tree migrates. Screenshots go outside the repo, paths in the PR.
Desktop-only checks (installer upgrade over a 0.4.3 install, legacy cleanup, update file) go to Windows Sandbox / Docker,
never to the user's screen. Not merged, not released.

## 6. Only the user can do these (outward steps)

1. Trademark search for INSILODE (USPTO/EUIPO/TÜRKPATENT, class 9 and 42, code analysis) and a look at "insilo*" neighbours. Decide before the release.
2. Buy `insilode.com` and `insilode.dev` (and optionally `.app`); D1 depends on it. Re-check availability the day of purchase.
3. Create the GitHub organisation `insilode` (also reserve the npm scope `@insilode` and the `insilode` npm name).
4. ~~Rename or transfer the repository~~ done by the coordinating session: `bothuany/axle` is now `bothuany/insilode`. Never create a repository called `bothuany/axle` again.
5. Pages: `bothuany.github.io/axle/` does **not** redirect after a rename. The new address is `insilode.github.io/insilode/`, or the custom domain
   (DNS + `CNAME`); the old link in READMEs, posts and the film description is dead, update them. The apt/homebrew repos named in
   the packaging docs are not created yet, so create them under the new name.
6. Update outside places: GitHub repo description/topics/social preview, winget PR (if submitted), any posts, `google-site-verification`
   for the new domain, Sonar/CLA-bot (the CLA signatures file lives in the repo/branch the action uses: check it moved with the repo).
7. Approve D1–D6, and the release timing (the version-bump and tag are not done by phase 2).

## 7. What phase 2 did, and where it differs from the plan above

Approved 2026-10-22 with D1-D6 as recommended (D1: `com.insilode.Insilode`, in its own last commit).

- **Mechanical rename** of every `Axle`/`axle`/`AXLE_` (case-sensitive, so `maxLength` is untouched) in 316 tracked files and 13 file names,
  except `docs/research` and this document. Commits are by area: docs, patches/scripts/packaging, sources, tests, site, lockfiles.
- **Repository URLs are `bothuany/insilode`** (D4: the repository was renamed in place while this PR was open). They are read from few places, so another move stays small: `package.json` `repository` (scripts/package.mjs builds the deb/rpm homepage from it), `product.json` `updateUrl` and the Inno publisher URLs in `flow-core.patch`, `site/src/brand.ts` `REPO`, the workflows (release.yml uses `${GITHUB_REPOSITORY}`; `cla.yml` names the CLA document), the winget/brew files, and prose in the docs. `git grep -F bothuany/insilode` finds them all.
- **The site is https://insilode.dev**, served from the root; `SITE_URL` defaults to it and every build writes the `CNAME` file, so a deploy keeps the custom domain.
- **Done as planned:** data-folder copy (`src/insilodeMigrate.ts`, tested), installer upgrade in place with legacy cleanup, legacy `update-*-axle.json`
  files, settings migration (`legacySettings.ts`, tested), theme ids, `axleTour` still read, `out/axle-mcp.js` stub plus `AXLE_WORKSPACE`, the one-time
  confirmed move of the `axle` MCP registration, `.axle/worktrees` and `axle/<name>` still recognised, the old Codex profile removed.
- **Not done:** accepting both `x-axle-*` headers and mirroring `~/.axle/bridge`. The stub runs the new server, which talks to the new bridge, so a registration
  that still reaches `out/axle-mcp.js` works. One that does not (Windows without `node` on PATH: it runs `Axle.exe`, which Setup removes; macOS and Linux: the
  install path changes, and a still-installed `Axle.app` runs its own 0.4.x server against `~/.axle/bridge`) fails until the user moves it to `insilode`: the move dialog says so; a "move tours" prompt (tours are found by `*.tour.json` anywhere, there is no fixed folder to move); a lint
  that flags `mcp__axle__*` permission rules (the move dialog tells the user to rename them instead).
- **Not verified here (needs the Windows Sandbox / a real install, section 5):** that Setup upgrades `...\Programs\Axle` in place (D2's premise:
  upstream `code.iss` sets no `UsePreviousAppDir`, so Inno's default applies, but it is unrun), the legacy cleanup entries, what a 0.4.3 build does with
  the legacy update file, and the migration on a real Axle profile.
- `docs/media/insilode-*` were renamed; the demo video and the social image still show the old name until the film session re-captures them.
