# Import from VS Code

Switching from VS Code (or VS Code Insiders, VSCodium, Cursor or Windsurf) takes one step: Insilode brings over your settings, keyboard shortcuts, snippets, colour and icon theme and extensions, and merges them into what Insilode already has. It is the built-in extension `flow-import` (`editor/extensions/flow-import`).

## How to start it

- **On the first start.** When Insilode has no user settings yet and finds VS Code, VS Code Insiders, VSCodium, Cursor or Windsurf for your user, it shows one notification: *Coming from VS Code? Bring your settings, keyboard shortcuts, snippets, theme and extensions into Insilode.* with **Import from VS Code**, **Not now** and **Never**. It is a notification in the corner, not a dialog: it never takes the focus. Only an explicit answer ends the offer: **Never**, or an import that ran to its end. **Not now**, closing the notification with the X, closing the list of editors (below) and an import you cancelled or that stopped on an error all leave it open, and it comes back at the next start. The command below always works. Someone who already has settings in Insilode, including everyone coming from Axle (whose settings are copied over on the first start), is not asked. When more than one editor is found the notification says *another editor* and **Import…** opens a list of them (name, folder, and the date of its `settings.json`, or "No settings.json (extensions only)"); the one you choose is what gets imported, never silently the first.
- **Any time.** The command **Insilode: Import from VS Code…** in the Command Palette.

When more than one editor is installed, the command first asks which one to import from (VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf, with the same list as the first-start offer). Then a list shows what that editor has, every item ticked, with counts:

| Item | What is imported |
|---|---|
| Settings | The keys of `settings.json`, except the theme keys, the ones listed under "Never imported" and the ones "Held back for review" |
| Keyboard shortcuts | The entries of `keybindings.json` |
| Snippets | Every `*.json` and `*.code-snippets` file in `User/snippets` (global and language snippets) |
| Colour and icon theme | `workbench.colorTheme`, `workbench.iconTheme`, `workbench.productIconTheme`, the `workbench.preferred*ColorTheme` keys, `workbench.colorCustomizations`, `editor.tokenColorCustomizations`, `editor.semanticTokenColorCustomizations` |
| Extensions | Installed again, by id, from Open VSX (Insilode's extension gallery) |

Items the editor has nothing for are left out of the list. Untick what you do not want and press Enter; a progress notification (with Cancel) shows what is happening, and a last notification says what was imported, with **Show Details** for the full report.

## Where it reads from

Nothing in the other editor is changed. Insilode reads:

| | User folder (settings, keybindings, snippets) | Extension list |
|---|---|---|
| Windows | `%APPDATA%\Code\User`, `%APPDATA%\Code - Insiders\User`, `%APPDATA%\VSCodium\User`, `%APPDATA%\Cursor\User`, `%APPDATA%\Windsurf\User` | `%USERPROFILE%\.vscode\extensions`, `.vscode-insiders\extensions`, `.vscode-oss\extensions`, `.cursor\extensions`, `.windsurf\extensions` |
| macOS | `~/Library/Application Support/Code/User` (and `Code - Insiders`, `VSCodium`, `Cursor`, `Windsurf`) | `~/.vscode/extensions` (and `~/.vscode-insiders`, `~/.vscode-oss`, `~/.cursor`, `~/.windsurf`) |
| Linux | `~/.config/Code/User` (or `$XDG_CONFIG_HOME/Code/User`; and `Code - Insiders`, `VSCodium`, `Cursor`, `Windsurf`) | `~/.vscode/extensions` (and `~/.vscode-insiders`, `~/.vscode-oss`, `~/.cursor`, `~/.windsurf`) |

The extension list is the editor's own `extensions.json` in that folder; an extension it uninstalled but has not deleted yet (listed in `.obsolete`) is not imported, and an older install without `extensions.json` is read from its folder names (`publisher.name-1.2.3`). Only the settings of the other editor's default profile are read.

## How it merges

Merge, don't clobber:

- **A setting you already have in Insilode keeps your value.** The import only adds keys you have not set. A language block such as `"[python]": { ... }` is merged setting by setting.
- **Keyboard shortcuts are appended.** One you already have is not added twice (`ctrl+k ctrl+t` and `ctrl+K  ctrl+T` are the same chord), and a shortcut for a key you already bind in the same `when` context is not added: your binding stays.
- **Snippets:** a file Insilode does not have is copied as it is; a file it has gains only the snippets whose names it lacks.
- **Comments and layout stay.** The files are edited in place (jsonc-parser), not rewritten, so your comments and order survive.
- **The theme is applied last**, after the extensions, and only if Insilode then has that theme. A theme whose extension is not on Open VSX would otherwise leave Insilode on a fallback theme, so the report names it and Insilode keeps its own (Insilode Dark). Theme names are matched as the editor matches them, exactly: a name written in another case (`one dark pro`) is written as the installed theme's id (`One Dark Pro`), and a colour theme with an id is known by that id, not by its label.
- **Extensions are installed from Open VSX**, one at a time, by their id. Insilode never copies the other editor's extension folders, so no Microsoft extension binaries are copied. An extension Open VSX does not have (most Microsoft ones, such as Remote - SSH, Live Share or Pylance) is listed in the final notification and the report instead of failing the import; the Extensions view may have an alternative. This is recognised by the error's code, so it works with any display language. Extensions already installed are skipped, and so are those installed in Insilode but disabled: they stay disabled, the report names them, and a theme they bring is applied only once you enable them. The first time an extension from a publisher is installed, the editor asks whether you trust that publisher (VS Code's own dialog, kept as it is). If you cancel it, that extension is skipped and listed in the report, and the import goes on with the next one.

### Never imported

These stay Insilode's whatever the other editor says:

- Insilode's own settings: `flow.*`, `flowHarness.*`, `flow-agent.*`, `insilode.*`, `axle.*`.
- Telemetry: `telemetry.*`.
- Microsoft account and sync services: `settingsSync.*`, `sync.*`, `workbench.cloudChanges.*` (and the experimental keys), `microsoft-authentication.*`, `remote.tunnels.access.*`.
- Experiments and services Insilode does not use: `workbench.enableExperiments`, `workbench.settings.enableNaturalLanguageSearch`, `extensions.gallery.*`.
- The update service: `update.*` (Insilode updates itself from its own releases).

### Held back for review

A copied settings file must not be able to change what runs on your machine or loosen its security without you knowing. These settings are not written by the import; they are listed instead (`src/merge.ts`, one rule table, `isHeldBack`):

| Held back | Rule |
|---|---|
| Security | every `security.*` key (`security.workspace.trust.*`, `security.allowedUNCHosts`, ...) |
| Executable paths | keys ending in `.path` or `.executablePath` (`git.path`, `php.validate.executablePath`, ...), and keys ending in `.command` or `.commandPath` |
| Terminal shells | `terminal.integrated.shell.windows`, `.osx`, `.linux`; every `terminal.integrated.profiles.*` map (a profile carries a path and arguments, so the whole map is held); `terminal.integrated.defaultProfile.*` only when its value is a path (a profile name such as `PowerShell` is imported) |
| Script or program values | a string value ending in `.exe`, `.sh`, `.cmd`, `.bat` or `.ps1` under a key that is not on the small allowlist (theme names, `editor.fontFamily`, `files.defaultLanguage`) |

Near misses are imported: `editor.fontFamily`, `files.exclude`, `files.associations` (the file names are keys, not a value that is run), `workbench.colorTheme`, `terminal.integrated.fontSize`. `search.path` is imported too: it is a folder to search, not a program, so it is the one name exempt from the `.path` rule. Settings inside a language block (`"[python]": { ... }`) follow the same rules, and a name ending in `Path` that is not `.path` (`python.formatting.blackPath`) is not matched by the table. A held back key you already have in Insilode is never touched and not offered: your value stays.

After the import, when something was held back, a notification says *Imported N settings; M held back for review* with two buttons. Nothing held back is imported without one of them:

- **Review** opens a list (checkboxes) showing each setting's key, its value and why it was held back. The ones you check are written through the same settings writer (comments and layout kept, the file backed up first); nothing else is. A key you set in Insilode while the list was open is not overwritten.
- **Import anyway** asks for a confirmation in a modal dialog that names the first few keys, then writes all of them.

Closing the notification imports nothing. The held back keys are listed in the report either way.

## Backup and report

Before it writes anything, the import copies every file it is about to change (`settings.json`, `keybindings.json`, each snippet file it adds to) into `import-backups/<date and time>/` in Insilode's User folder:

- Windows: `%APPDATA%\Insilode\User\import-backups\`
- macOS: `~/Library/Application Support/Insilode/User/import-backups/`
- Linux: `~/.config/Insilode/User/import-backups/`

Next to the copies, `import-report.txt` lists what was added, what was kept, what was skipped and why, and which extensions were not found. The same report is in the **Insilode Import** output channel (**Show Details**). To undo an import, copy the files from the backup back into the User folder. Files that did not exist before the import have no backup: delete them to undo.

Only a file that does not exist counts as empty. When one of Insilode's files is there but cannot be read (OneDrive or a virus scanner holds it, or there is no permission), the import stops before it writes anything and says which file and why: it never writes a file it could not back up. On the other editor's side, a file that cannot be read (a locked snippet file, say) is skipped and named in the report, and the rest is imported.

One import runs at a time: starting the command while one is running (for instance while the first-start notification's import waits in its list) says so and does nothing, so nothing is added twice.

## Limits

- Settings, keybindings and snippets are written to Insilode's default profile.
- In a window connected to a remote machine (SSH, WSL, a container), the import runs on your own computer (`flow-import` prefers the UI side, `extensionKind: ["ui", "workspace"]`; "workspace" only lets it run on the server in `npm run web`): it reads the VS Code installed there and writes your local Insilode settings, which every window uses. If `remote.extensionKind` moves `flow.flow-import` to the remote machine, the import refuses to run, since it would write the server's settings where the editor never reads them.
- A settings key from an extension Open VSX does not have is still imported (it does nothing until such an extension is installed). VS Code's Settings editor may mark it as unknown.
- Settings Sync, Copilot sign-in, workspace (`.vscode/settings.json`) settings and other editors' profiles are not imported. Workspace settings travel with the project anyway.
- In `npm run web` (a development mode), the source is read on the machine that runs the server and the settings are written to the browser's user data, as every setting in that mode is. That mode has no extension gallery (the web client only gets one when `product.json` has a `resourceUrlTemplate`), so extensions are not installed there: the report says so and lists them, and the rest of the import works.
- VS Code's old built-in theme names (`Default Dark Modern`, `Default Light Modern`, `Default Dark+`, `Default Light+`) are written under the names the themes have now (`Dark Modern`, ...), and `VS Code Dark` / `Experimental Dark` and `VS Code Light` / `Experimental Light` as `Dark 2026` and `Light 2026`, as VS Code itself reads them (`migrateThemeSettingsId`).

## For developers

- `src/sources.ts`: finding the editors, the first-start offer's answer rule (`offerAnswered`) and the source pick items (`sourcePickItems`), and reading what they have (no `vscode`; the platform and folders are passed in). `src/merge.ts`: the merge rules and the hold-back table (`HELD_BACK_RULES`, `isHeldBack`, `heldToImport`), text in and text out. `src/extension.ts`: the notification, the command, the backup, the extension installs.
- Tests: `cd editor/extensions/flow-import && npm test` runs both modules against fixture homes in `test/fixtures` laid out as Windows, macOS and Linux keep them (an `XDG_CONFIG_HOME` case, an install without `extensions.json`, duplicates and `.obsolete`), and `test/holdback.test.mjs` tables every hold-back class and near miss, `test/held-extension.test.mjs` runs Review, Import anyway and the offer, and `test/extension.test.mjs` runs the command itself against a stand-in for `vscode` (`test/vscode-fake.cjs`): a locked `settings.json` (EBUSY, EPERM), two imports at once, theme names in another case, disabled extensions and a translated "not found".
- The desktop path end to end, with real installs from Open VSX: `npm run docker:e2e -- --probe test/e2e-desktop/probes/import-from-vscode.mjs` (three extensions installed, Pylance reported as not on Open VSX, the publisher trust dialogs answered as a person would).
- `INSILODE_IMPORT_HOME=<folder>` makes the extension read that folder as the home folder (with `AppData/Roaming`, `Library/Application Support` or `.config` below it, by OS), so a probe imports a fixture, never your own VS Code. Set it on the process that runs the extension host, e.g. `INSILODE_IMPORT_HOME=... npm run web`.
