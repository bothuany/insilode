# Package-manager distribution

What `release.yml` builds on a `v*` tag is attached to the GitHub release (see `.github/workflows/release.yml`). The files
here hand those release files to package managers. **None of them is published yet.**

| | File | Where it goes | Status |
|---|---|---|---|
| Windows | `winget/manifests/b/bothuany/Insilode/<version>/` | a pull request to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) | written, not submitted |
| macOS | `homebrew/insilode.rb` | `Casks/insilode.rb` in a new repository `bothuany/homebrew-tap` | written, the tap repository does not exist |
| Linux | `apt/README.md` | a signed APT repository | described, not set up |
| Linux | `linux/deb/` | used by `scripts/package.mjs`: the `.deb`'s maintainer scripts | in use |

## Each release

1. Raise `version` in `package.json`, then tag and push it (`git tag v<version> && git push origin v<version>`). The
   workflow checks that the two match.
2. When the workflow is done, the release carries `SHA256SUMS.txt`.
3. **winget:** copy the folder to the new version. Set `PackageVersion`, `InstallerUrl`, `ReleaseNotesUrl` and
   `InstallerSha256` (the `.exe` line, in upper or lower case), then check the manifest with
   `winget validate --manifest <folder>`. Submit it with `wingetcreate submit <folder>`, or as a pull request to
   winget-pkgs under `manifests/b/bothuany/Insilode/<version>/`. For later versions, `wingetcreate update bothuany.Insilode
   --version <v> --urls <exe url> --submit` does all of this in one step. After the first merge, `winget install
   bothuany.Insilode` works and `winget upgrade` picks up each new version as soon as its manifest is merged.
4. **Homebrew:** in the tap, set `version` and the two `sha256` values (the `darwin-arm64.zip` and `darwin-x64.zip`
   lines), then run `brew audit --cask --online bothuany/tap/insilode` and `brew style`. `brew upgrade` picks it up after
   that. A release job could do this with a token for the tap repository; `brew bump-cask-pr` is the manual route.
5. **APT:** see `apt/README.md`.

## Updates

A running Insilode updates itself from the release files, without an update server. VS Code's update service is kept
(Update available on the gear, Help, Check for Updates, `update.mode`), but it reads a static file instead of
`/api/update/<platform>/<quality>/<commit>` (`editor/patches/flow-update.patch`):

1. `product.json` has `"quality": "insilode"` and `"updateUrl": "https://github.com/bothuany/insilode/releases/latest/download"`.
   GitHub redirects `releases/latest/download/<file>` to the newest release that is not a draft or prerelease.
2. The app asks for `<updateUrl>/update-<platform>-insilode.json`, where `<platform>` is `win32-x64-user`, `darwin`,
   `darwin-arm64` or `linux-x64`. Each file is `{ url, name, version, productVersion, sha256hash, timestamp }`;
   `version` is the commit of the release, `productVersion` its Insilode version.
3. The app compares `productVersion` with its own Insilode version (semver; a release is newer than its prereleases). Equal or
   older means no update, which replaces the server's 204. The built app's `version` in `product.json` is VS Code's, so
   `npm run installer` and `npm run package` stamp `insilodeVersion` (from `package.json`) into it; that is what is compared.
4. `release.yml` writes the files with `scripts/update-manifests.mjs` (through `scripts/release-files.mjs`, sha256 of each
   build job's own artifact, not of what is on the release) and uploads them with everything else to a draft release, which
   it makes public only when every file is on it. It fails, and publishes nothing, when a platform's asset is missing. A
   prerelease tag (`v0.6.0-rc.1`) is published as a prerelease, never latest, and without update files.

| Platform | The file points at | What the app does |
|---|---|---|
| Windows (per-user setup) | `Insilode-Setup-<v>-x64.exe` | downloads it, checks the sha256, runs it silently when you choose Restart to Update (VS Code's Inno Setup flow) |
| macOS (x64, arm64) | the release page | notification with a Download button that opens the page |
| Linux (x64) | the release page | the same |

- **Windows** only works for the per-user installer (`npm run installer`'s default), which is the one on the release: its
  target is `user`. A system-wide install (`--system`, not released) would look for `win32-x64` files that are not published.
  The app id, `insilode` mutex and install folder come from `product.json`, so they are Insilode's and not Code - OSS's; the installer's
  `/update` flow shares them with the app. The update cache is `%TEMP%\insilode-insilode-user-x64`, not VS Code's.
  The update is installed when you choose Restart to Update: the app quits and runs the installer silently over the install,
  which starts Insilode again. VS Code's background updates (the new build is staged in `{app}\_` while the app runs, and
  `inno_updater` swaps it in on restart) are switched off in the update patch, and the `update.enableWindowsBackgroundUpdates`
  setting is hidden. `inno_updater` 0.26 only knows the *versioned* layout (`win32VersionedUpdate`: `Insilode.exe` is a proxy at the
  install root and the app lives in a commit-named folder), and that layout needs Microsoft's custom Electron build with
  `electron_proxy.exe`; the Electron from electronjs.org that Insilode uses fails to start from it ("Invalid file descriptor to
  ICU data"). Installs of 0.4.3 and older still have the background mode, which fails at the swap: install the next release
  once by hand (run the Setup over it, or uninstall first), and updates are in place from then on.
- **macOS** cannot install in place yet: Squirrel.Mac only replaces an app that is signed with a Developer ID and notarized,
  and Insilode's ad hoc signature would make every download fail. So the app never calls Squirrel; it reads the file and offers the
  page. When signing is added (the section below), point the file at the zip and restore Squirrel's check in
  `updateService.darwin.ts` (see `flow-update.patch`: it replaces `electron.autoUpdater`).
- **Linux** is notification and link only, as in VS Code: there is no apt repository, and an `apt upgrade` cannot update the
  `.deb` until there is ([apt/README.md](apt/README.md)).
- The first release that carries these files is the first one an old app can learn of; 0.4.1 and older have no updater.
- The release stays a draft until every file, the update files included, is on it, so `latest/download` never points at a
  release without them; if a build fails, nothing is published and the previous release stays latest.

**Test it without a release.** `INSILODE_UPDATE_URL` replaces `updateUrl` (https, or http on this machine only):

```bash
node scripts/update-manifests.mjs --dir <folder with the four release files> --out /tmp/insilode-update --version 9.9.9 --commit test --repo bothuany/insilode
(cd /tmp/insilode-update && python -m http.server 8123 --bind 127.0.0.1)
INSILODE_UPDATE_URL=http://127.0.0.1:8123 npm start     # an installed build, not `npm start`: updates are off when running from source
```

A build from source is never updated (`update#ctor - not built`); install a build of an older version, set the variable and
choose Help, Check for Updates. `npm run test:update` runs the tests for the version check, the URLs and the files.

## Moving from Axle

The 0.5.x releases carry every update file twice: `update-<platform>-insilode.json` (what 0.5 asks for) and `update-<platform>-axle.json`
(what an installed 0.4.x asks for, at `github.com/bothuany/axle/releases/latest/download`, which GitHub redirects to `bothuany/insilode` since the repository was renamed).
Both are written by `scripts/update-manifests.mjs` (`LEGACY_QUALITY`); drop the second once the 0.4.x tail is gone. A 0.4.x app cannot install
the update itself: its "Update available" leads to the new release. Never create a repository called `bothuany/axle` again: it would end the redirect.
The winget manifest under `winget/manifests/b/bothuany/Insilode/0.1.0/` is the old template (its installer URL names a file the 0.1.0 release
never had); regenerate it with `wingetcreate` from the first Insilode release.

What Setup does to an Axle install (kept `AppId`), and what the app copies on its first start, is listed in
[docs/building.md](../docs/building.md#coming-from-axle); the code is in `editor/patches/flow-core.patch` (`build/win32/code.iss`) and
`flow-desktop.patch` (`src/insilodeMigrate.ts`).

## Not signed yet

- **Windows:** the installer has no Authenticode signature, so SmartScreen warns before it runs. winget accepts unsigned
  installers, but Defender's SmartScreen still shows its prompt.
- **macOS:** the app has an ad hoc signature, not a Developer ID one, and it is not notarized. Gatekeeper blocks the
  first launch until the user allows it. Third-party taps accept such casks; the official homebrew/cask repository requires signed, notarized apps. Signing needs an
  Apple Developer account, the certificate and an app-specific password in Actions secrets, then `codesign` with the
  hardened runtime and VS Code's entitlements (`build/azure-pipelines/darwin/*.plist`) and `xcrun notarytool submit
  --wait` + `stapler staple` in `scripts/package.mjs` in place of the ad hoc step.
- **Linux:** the `.deb` itself is not signed, which is normal. An APT repository signs its index instead (`apt/README.md`).

Until then, the site serves terminal installers that avoid both prompts: `site/public/install.sh` (macOS, `curl | sh`) and
`site/public/install.ps1` (Windows, `irm | iex`). Gatekeeper and SmartScreen check only files carrying the quarantine mark
a browser adds (`com.apple.quarantine`, the `Zone.Identifier` stream), and curl and Invoke-WebRequest add none. Both check the
download against `SHA256SUMS.txt` first (`test/update/install.test.mjs`).

## App identity

`product.json` (in `editor/patches/flow-core.patch`) gives Insilode its own names, so the packages install beside a
Code - OSS or VS Code one:

| | Key | Value | What uses it |
|---|---|---|---|
| macOS | `darwinBundleIdentifier` | `dev.insilode.Insilode` | the bundle id: preferences in `~/Library/Preferences/dev.insilode.Insilode.plist`, saved window state, the policy domain |
| macOS | `darwinProfileUUID`, `darwinProfilePayloadUUID` | Insilode's own | the identity of the policy `.mobileconfig` VS Code's build can generate |
| Linux | `linuxDesktopName` | `dev.insilode.insilode` | `/usr/share/applications/dev.insilode.insilode.desktop` (and `.UrlHandler.desktop`), the appdata file, the window class |
| Linux | `linuxIconName` | `insilode` | `/usr/share/pixmaps/insilode.png` |

Two folder names are still Code - OSS's: `sharedDataFolderName` (`~/.vscode-oss-shared`) and `serverDataFolderName`
(`~/.vscode-server-oss`, used by the remote server).
