# Ada CLI

**Ada CLI** is a rebranded fork of [pi.dev](https://pi.dev) (the [earendil-works/pi](https://github.com/earendil-works/pi) coding agent). It keeps 100% of pi.dev's functionality while presenting itself as **ada** everywhere a user sees a name.

```
ada v0.84.2  |  config: ~/.ada/  |  binary: ada  |  env: ADA_CODING_AGENT_DIR
```

## What changed vs. upstream pi

| Area | Upstream (pi.dev) | Ada CLI |
|---|---|---|
| CLI binary | `pi` | `ada` |
| Banner / logo | `pi v0.84.2` | `ada v0.84.2` |
| Config directory | `~/.pi/` | `~/.ada/` |
| Env vars (agent dirs) | `PI_CODING_AGENT_DIR` | `ADA_CODING_AGENT_DIR` |
| Terminal title | `π - session` | `ada - session` |
| npm package | `@earendil-works/pi-coding-agent` | `@adrianbm96/ada-cli` |
| Update command | `pi update` | `ada update` |
| Provider attribution headers | `pi` / `Pi` | `ada` / `Ada` |
| User-Agent | `pi/0.84.2` | `ada/0.84.2` |

### What intentionally stays `pi`

- **Extension SDK API** (`pi.sendMessage`, `pi.registerProvider`, `pi.*`, `ctx.pi`). This is a stable public API — renaming it would break every existing pi extension/package. Ada remains 100% compatible with the pi extension ecosystem.
- **Service endpoints** (`https://pi.dev/api/*`, catalog, version check, share viewer). These are infrastructure operated by the pi.dev team that Ada relies on to keep working (version checks, model catalogs, session sharing). They are not user-facing branding.
- **`PI_*` environment variables** (`PI_OFFLINE`, `PI_PACKAGE_DIR`, `PI_SKIP_VERSION_CHECK`, ...). Kept for ecosystem compatibility; `ADA_SHARE_VIEWER_URL` is accepted as a new alias for the share viewer URL.

## Keeping Ada up to date with pi.dev

Ada uses a **deterministic patch-based sync** — the safest way to rebrand a fork that tracks upstream:

```
main = upstream/main  +  scripts/ada-rebrand.patch
```

Every sync resets `main` to exactly upstream `main`, then **re-applies the branding patch** and verifies the branding markers before committing/pushing. The rebranding cannot be lost in a merge: it is re-applied on every sync, and if it ever fails to apply, the sync stops loudly and nothing is pushed without branding.

### 1. Local sync script

```bash
./scripts/sync-ada.sh --push        # reset → re-brand → verify → commit → push
```

### 2. Automated sync (GitHub Actions)

".github/workflows/sync-upstream.yml" runs daily at 06:00 UTC and on manual dispatch (`Actions → Sync upstream → Run workflow`). It performs the same reset + re-brand + verify + push autonomously. If the patch ever fails to apply, the run **fails loudly and opens a PR** titled `chore: sync upstream` so the conflict is resolved visibly — never a silent branding loss.

> Note: enable GitHub's "Actions → General → Notifications" so you get emails on failed runs.

### 3. Editing the branding

After any manual branding edit, commit it and regenerate the patch (the sync script and workflow do this automatically on every sync):

```bash
git add -A
git diff --cached upstream/main -- . ':!scripts/ada-rebrand.patch' > scripts/ada-rebrand.patch
git commit -am "chore: update ada branding"
```

### 4. Optional: publish to npm

`ada update` (self-update) compares against pi.dev's latest version and installs `@adrianbm96/ada-cli@<version>` from npm. For self-update to work at runtime, publish the package after syncing:

```bash
cd packages/coding-agent
npm publish --access public
```

The workflow does this automatically if you add an `NPM_TOKEN` secret to the fork's GitHub repo settings (Settings → Secrets and variables → Actions). It publishes only when the synced version has not been published yet.

## Build & install locally

Requires Node ≥ 22.19 and bun (for the standalone binary).

```bash
npm install                       # install monorepo deps
npm run build                     # build all packages (JS)
cd packages/coding-agent
npm install -g .                  # installs the `ada` binary globally
ada --version                     # → ada 0.84.2
```

Or build the standalone binary (no Node needed at runtime):

```bash
cd packages/coding-agent
npm run build:binary              # produces dist/ada
sudo cp dist/ada /usr/local/bin/ada
```

## Layout

- `packages/coding-agent/` — the CLI (this is what becomes `ada`)
- `packages/ai`, `packages/agent`, `packages/tui`, ... — upstream libraries, unchanged

## Credits

Ada CLI is a fork of [pi.dev](https://pi.dev) by the earendil-works team. All upstream improvements flow into Ada automatically via the sync process above.
