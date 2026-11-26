---
name: release
description: Cut an Insilode release - bump the version in package.json and its lockfile, commit "Release X.Y.Z" on main, then tag vX.Y.Z and push it so .github/workflows/release.yml builds and publishes every platform. Only the user starts this.
argument-hint: "[patch|minor|major|X.Y.Z|X.Y.Z-rc.N]"
disable-model-invocation: true
---

# Release Insilode

A pushed `v*` tag starts `.github/workflows/release.yml`: it builds Windows, macOS and Linux (60 to 90 minutes), checks the tag matches `package.json`, and publishes a GitHub release with generated notes and the update files every installed Insilode reads. A tag with a prerelease part (`v0.18.0-rc.1`) publishes as a prerelease: never "latest", no update files.

## Steps

1. **Start clean on main.** `git status` is clean, the branch is `main`, and `git pull --ff-only` is done. Otherwise stop and say why.
2. **main is green.** `gh run list --branch main --workflow ci --limit 1` shows success for the head commit. If it failed or is running, stop and report it.
3. **Local gate.** Run the `quality-gate` skill. Any failure stops the release.
4. **Pick the version.** From `$ARGUMENTS`, or ask: patch, minor or major from the current `package.json` version. Show the commits since the last tag (`git log --oneline $(git describe --tags --abbrev=0)..HEAD`) so the user can judge.
5. **Bump.** `npm version <version> --no-git-tag-version` (changes `package.json` and `package-lock.json` only, like every earlier release commit), then commit them alone with the message `Release <version>`.
6. **Ask before anything leaves this machine.** Show the commit and the tag `v<version>`, say that pushing starts a public release in about 90 minutes and cannot be quietly undone, and wait for a clear yes.
7. **Push.** `git push origin main`, then `git tag v<version>` and `git push origin v<version>`.
8. **Report.** The tag, the release run (`gh run list --workflow release --limit 1`), and that the release appears as a draft until every platform is uploaded.

## If something goes wrong

- The release run fails: nothing is published and the previous release stays latest. Fix on main, then delete and re-push the tag only if the user says so.
- To rehearse without publishing: Actions > release > Run workflow (a dry run that builds everything and uploads nothing).
