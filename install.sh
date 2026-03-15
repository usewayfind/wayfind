#!/usr/bin/env bash
# Wayfind — Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/leizerowicz/meridian/main/install.sh | bash
#   WAYFIND_VERSION=v1.1.0 bash install.sh   # Install specific version
#   bash install.sh --force                    # Force reinstall even if same version

set -euo pipefail

REPO="leizerowicz/meridian"
VERSION="${WAYFIND_VERSION:-main}"
TMP_DIR="$(mktemp -d)"
FORCE=false
KIT_DEST="$HOME/.claude/team-context"
VERSION_FILE="$KIT_DEST/.wayfind-version"

# Parse arguments
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
    esac
done

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── Version detection ─────────────────────────────────────────────────────────

INSTALLED_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    INSTALLED_VERSION="$(cat "$VERSION_FILE")"
fi

echo ""
echo "Wayfind — Installing${VERSION:+ (${VERSION})}..."
if [ -n "$INSTALLED_VERSION" ]; then
    echo "  Existing installation detected: v${INSTALLED_VERSION}"
fi
echo ""

# Download
if [ "$VERSION" = "main" ]; then
    DOWNLOAD_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
    ARCHIVE_NAME="meridian-main"
else
    DOWNLOAD_URL="https://github.com/$REPO/archive/refs/tags/${VERSION}.tar.gz"
    ARCHIVE_NAME="meridian-${VERSION#v}"
fi

ARCHIVE="$TMP_DIR/kit.tar.gz"
if ! curl -fsSL "$DOWNLOAD_URL" -o "$ARCHIVE"; then
    echo ""
    echo "Error: download failed."
    if [ "$VERSION" != "main" ]; then
        echo "Check that version '$VERSION' exists: https://github.com/$REPO/releases"
    fi
    exit 1
fi
tar -xz -C "$TMP_DIR" -f "$ARCHIVE"
KIT_DIR="$TMP_DIR/$ARCHIVE_NAME"

# Verify the kit downloaded correctly
if [ ! -f "$KIT_DIR/setup.sh" ]; then
    echo "Error: download failed or unexpected archive structure"
    exit 1
fi

# Read the new version from the downloaded package.json
NEW_VERSION=""
if [ -f "$KIT_DIR/package.json" ]; then
    NEW_VERSION="$(grep '"version"' "$KIT_DIR/package.json" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
fi

# ── Same-version check ────────────────────────────────────────────────────────

if [ -n "$INSTALLED_VERSION" ] && [ -n "$NEW_VERSION" ] && [ "$INSTALLED_VERSION" = "$NEW_VERSION" ]; then
    if [ "$FORCE" = false ]; then
        echo "Already installed (v${INSTALLED_VERSION}). Use --force to reinstall."
        exit 0
    fi
    echo "Forcing reinstall of v${INSTALLED_VERSION}..."
fi

if [ -n "$INSTALLED_VERSION" ] && [ -n "$NEW_VERSION" ] && [ "$INSTALLED_VERSION" != "$NEW_VERSION" ]; then
    echo "Upgrading from v${INSTALLED_VERSION} to v${NEW_VERSION}..."
fi

# ── Backup existing kit ──────────────────────────────────────────────────────

BACKUP_DIR=""
if [ -d "$KIT_DEST" ]; then
    BACKUP_DIR="$(mktemp -d)"
    # Backup lives in temp dir (not inside KIT_DEST which gets rm -rf'd later)
    # Back up all kit files
    cp -a "$KIT_DEST"/. "$BACKUP_DIR/" 2>/dev/null || true
    echo "Backed up current kit to $BACKUP_DIR"
fi

# ── Run setup ─────────────────────────────────────────────────────────────────

SETUP_ARGS=(--tool claude-code)
if [ -n "$INSTALLED_VERSION" ]; then
    SETUP_ARGS=(--tool claude-code --update)
fi

if ! WAYFIND_NEW_VERSION="$NEW_VERSION" WAYFIND_OLD_VERSION="$INSTALLED_VERSION" \
    bash "$KIT_DIR/setup.sh" "${SETUP_ARGS[@]}"; then
    echo ""
    echo "Error: setup failed."
    # Rollback: restore from backup if available
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        echo "Restoring from backup..."
        rm -rf "$KIT_DEST"
        cp -a "$BACKUP_DIR" "$KIT_DEST"
        rm -rf "$BACKUP_DIR"
        echo "Restored previous installation from backup."
    fi
    exit 1
fi

# ── Install kit files ─────────────────────────────────────────────────────────

rm -rf "$KIT_DEST"
cp -r "$KIT_DIR" "$KIT_DEST"

# Write version file (atomic: write to temp then move)
if [ -n "$NEW_VERSION" ]; then
    TMP_VER="$(mktemp)"
    echo "$NEW_VERSION" > "$TMP_VER"
    mv "$TMP_VER" "$VERSION_FILE"
fi

# Clean up backup on success
[ -n "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR"

echo ""
echo "Installation complete."
[ -n "$NEW_VERSION" ] && echo "Version: v${NEW_VERSION}"
[ "$VERSION" != "main" ] && [ -z "$NEW_VERSION" ] && echo "Version: $VERSION"
echo "Kit installed to: $KIT_DEST"
echo ""
echo "Next: run /init-memory in any Claude Code session to initialize a repo."
echo "To set up backup: tell Claude 'Set up backup using <your-private-repo-url>'"
echo ""
