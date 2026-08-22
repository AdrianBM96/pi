#!/usr/bin/env bash
# =============================================================================
# sync-ada.sh — Keep the Ada CLI fork in lockstep with upstream pi.dev
#
#   ./scripts/sync-ada.sh [--yes] [--push] [--build]
#
# Strategy (deterministic, conflict-free by construction):
#   main = upstream/main  +  scripts/ada-rebrand.patch
#
# Every sync:
#   1. Fetch upstream (earendil-works/pi)
#   2. Reset main to exactly upstream/main           (drops old merge leftovers)
#   3. Re-apply scripts/ada-rebrand.patch            (branding + ada-only files)
#   4. Verify the branding markers are present       (fail loudly if not)
#   5. Commit + push (--push)
#
# The rebranding is RE-APPLIED on every sync, so it can never be lost
# silently in a merge. If upstream changes a branding-adjacent line so the
# patch no longer applies, the script STOPS and reports exactly what failed —
# it never proceeds without the branding.
#
# The patch is also re-generated after manual branding edits:
#   git diff upstream/main..HEAD > scripts/ada-rebrand.patch
# =============================================================================
set -euo pipefail

ASSUME_YES=0
PUSH=0
BUILD=0
for arg in "$@"; do
	case "$arg" in
		--yes) ASSUME_YES=1 ;;
		--push) PUSH=1 ;;
		--build) BUILD=1 ;;
		-h | --help)
			echo "Usage: ./scripts/sync-ada.sh [--yes] [--push] [--build]"
			exit 0
			;;
	esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PATCH="scripts/ada-rebrand.patch"
BRANCH="$(git branch --show-current)"

if ! git remote get-url upstream >/dev/null 2>&1; then
	echo "==> adding upstream remote"
	git remote add upstream https://github.com/earendil-works/pi.git
fi

# --- Safety: don't destroy uncommitted work ---------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "!! You have uncommitted changes. Commit or stash them first."
	exit 1
fi

# The patch file itself does not exist upstream, so a hard reset would delete
# it from the working tree. Copy it somewhere safe before resetting.
PATCH_TMP="$(mktemp)"
cp "$PATCH" "$PATCH_TMP"

# After applying, the patch is regenerated from the fresh state and committed,
# so the repo's patch file is ALWAYS the full branding diff (self-contained).

echo "==> Fetching upstream/main"
git fetch upstream main

# --- Safety: show what a hard reset would discard ----------------------------
DIVERGED="$(git log --oneline origin/main..upstream/main 2>/dev/null | wc -l | tr -d ' ')"
if [ "$DIVERGED" -gt 0 ]; then
	echo "==> Upstream is ahead by $DIVERGED commit(s)."
fi
if [ "$ASSUME_YES" -eq 0 ]; then
	read -r -p "Reset $BRANCH to upstream/main and re-apply ada branding? [y/N] " answer
	case "$answer" in
		y | Y) ;;
		*) echo "Aborted." && exit 1 ;;
	esac
fi

echo "==> Resetting $BRANCH to upstream/main"
git reset --hard upstream/main

echo "==> Applying ada rebranding patch ($PATCH)"
if ! git apply --3way --whitespace=nowarn "$PATCH_TMP" 2>apply-error.log; then
	echo
	echo "!!! The ada rebranding patch does not apply cleanly on the new upstream."
	echo "!!! Upstream probably refactored a branding-adjacent file."
	echo "!!! Nothing was committed. Your repo is at upstream/main + no branding."
	cat apply-error.log
	rm -f apply-error.log "$PATCH_TMP"
	echo
	echo "Fix the patch against the new upstream (see ADA-CLI.md), then re-run:"
	echo "  1. git apply --3way scripts/ada-rebrand.patch   # resolve conflicts"
	echo "  2. git diff upstream/main > scripts/ada-rebrand.patch  # regenerate"
	echo "  3. ./scripts/sync-ada.sh --push"
	exit 1
fi
rm -f apply-error.log "$PATCH_TMP"

echo "==> Verifying branding markers"
BRANDING_OK=1
check() {
	if ! grep -q "$2" "$1"; then
		echo "    MISSING in $1: $2"
		BRANDING_OK=0
	fi
}
check packages/coding-agent/package.json '"name": "@adrianbm96/ada-cli"'
check packages/coding-agent/package.json '"name": "ada"'
check packages/coding-agent/package.json '"configDir": ".ada"'
check packages/coding-agent/package.json '"ada": "dist/cli.js"'
check packages/coding-agent/src/config.ts '@adrianbm96/ada-cli'
check packages/coding-agent/src/cli/args.ts 'Update ada, extensions, or model catalogs'
if [ "$BRANDING_OK" -eq 0 ]; then
	echo "!!! Branding verification failed — not committing a broken sync."
	exit 1
fi
echo "    OK — all branding markers present"

# Regenerate the patch from the fresh state so the committed patch file is
# always the complete branding diff. It excludes itself (the file does not
# exist upstream and is recreated here on every sync).
git add -A
git diff --cached upstream/main -- . ':!scripts/ada-rebrand.patch' > /tmp/ada-rebrand-regen.patch
mv /tmp/ada-rebrand-regen.patch "$PATCH"
git add -A

git commit --no-verify -m "chore: sync upstream pi.dev + apply ada rebranding" 2>/dev/null \
	&& echo "==> Committed: $(git log --oneline -1)" \
	|| echo "==> Nothing changed (already in sync)"

if [ "$BUILD" -eq 1 ]; then
	echo "==> Building (npm run build)"
	npm run build
fi

if [ "$PUSH" -eq 1 ]; then
	echo "==> Pushing $BRANCH to origin"
	git push --force-with-lease origin "$BRANCH"
fi

echo
echo "==> Ada CLI is in lockstep with pi.dev ✓"
if [ "$PUSH" -eq 0 ]; then
	echo "    Run with --push to publish to your fork."
fi
echo "    Optional: publish to npm so 'ada update' works at runtime:"
echo "      cd packages/coding-agent && npm publish --access public"
