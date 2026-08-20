#!/usr/bin/env bash
#
# Deploy the working tree to the local app directory on a Home Assistant box and
# rebuild it.
#
# This is a development tool. It lives outside claude-code-ui/ deliberately: the
# CI workflow triggers on claude-code-ui/**, and changing a deploy script should
# not queue an image build.
#
# It encodes the traps that have each cost an afternoon at least once:
#
#   1. `image:` must not be present in the app directory's config.yaml. It ships
#      in the repo for store installs (which pull the prebuilt image), but with
#      it present the Supervisor reports the app as image-based and `rebuild`
#      fails with AppRebuildImageBasedError. Copying the repo puts the key back
#      every single time, so it is stripped after the transfer, not before.
#   2. The `ha` CLI needs a *login* shell. A bare `ssh host "ha ..."` does not
#      source the profile that exports SUPERVISOR_TOKEN, so it fails with
#      "unauthorized: missing or invalid API token" even when everything else is
#      right. Every `ha` call goes through `bash -lc`.
#   3. Transfer is tar-over-ssh rather than scp. The Advanced SSH app has no
#      SFTP subsystem (scp needs -O), and tar can exclude node_modules — which
#      is otherwise ~50 MB of test dependencies the image never uses.
#   4. tar merges, it does not mirror. Files deleted locally since the last
#      deploy stay on the box; --prune reports them so they can be removed.
#   5. A rebuild restarts the app, so any in-progress chat drops.
#
set -euo pipefail

HOST="${HA_SSH_HOST:-192.168.1.10}"
PORT="${HA_SSH_PORT:-222}"
USER="${HA_SSH_USER:-hassio}"
KEY="${HA_SSH_KEY:-$HOME/.ssh/ha_claude}"
SLUG="${HA_ADDON_SLUG:-local_claude-code-ui}"
APP_DIR="${HA_APP_DIR:-/addons/claude-code-ui}"

REBUILD=true
PRUNE=false
LOGS=false
LIVE=false

usage() {
    cat <<USAGE
Usage: tools/deploy-to-ha.sh [options]

Copies claude-code-ui/ to ${APP_DIR} on the Home Assistant host and rebuilds.

  --no-rebuild   Copy only; do not rebuild (the app keeps running the old image)
  --prune        Report files on the box that no longer exist locally
  --logs         Tail the app log after the rebuild
  --live         Run the live smoke suite afterwards
  -h, --help     This

Environment: HA_SSH_HOST HA_SSH_PORT HA_SSH_USER HA_SSH_KEY HA_ADDON_SLUG HA_APP_DIR
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-rebuild) REBUILD=false; shift ;;
        --prune)      PRUNE=true; shift ;;
        --logs)       LOGS=true; shift ;;
        --live)       LIVE=true; shift ;;
        -h|--help)    usage; exit 0 ;;
        *)            echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/claude-code-ui"
[ -d "$SRC" ] || { echo "Error: no claude-code-ui/ under $REPO" >&2; exit 1; }

sh_ha() { ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$KEY" -p "$PORT" "$USER@$HOST" "$@"; }

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "Checking $USER@$HOST:$PORT"
sh_ha "test -d '$APP_DIR'" || {
    echo "Error: $APP_DIR does not exist on the host." >&2
    echo "The app must already be installed as a local add-on before deploying to it." >&2
    exit 1
}

if [ "$PRUNE" = true ]; then
    step "Files on the box that no longer exist locally"
    # comm requires both inputs sorted the same way, and silently produces
    # nonsense when they are not — the box sorts in the C locale and a desktop
    # usually does not. So both lists are sorted here, under one locale.
    remote=$(sh_ha "cd '$APP_DIR' && find . -type f ! -path './node_modules/*'" | LC_ALL=C sort)
    local_files=$(cd "$SRC" && find . -type f ! -path './node_modules/*' ! -name package-lock.json | LC_ALL=C sort)
    stale=$(comm -23 <(printf '%s\n' "$remote") <(printf '%s\n' "$local_files") || true)
    if [ -n "$stale" ]; then
        echo "$stale"
        echo
        echo "Remove with:"
        echo "  ssh -p $PORT $USER@$HOST \"cd $APP_DIR && rm -f <paths>\""
    else
        echo "(none)"
    fi
fi

step "Copying claude-code-ui/ → $APP_DIR"
tar czf - --exclude=node_modules --exclude=package-lock.json -C "$SRC" . \
    | sh_ha "tar xzf - -C '$APP_DIR'"
echo "copied"

# Trap 1: the copy just restored `image:`, which would make the rebuild fail.
step "Stripping the image: key so the Supervisor builds from source"
sh_ha "sed -i '/^image:/d' '$APP_DIR/config.yaml'"
remaining=$(sh_ha "grep -c '^image:' '$APP_DIR/config.yaml' || true")
[ "$remaining" = "0" ] || { echo "Error: image: key is still present" >&2; exit 1; }
echo "stripped"

if [ "$REBUILD" = false ]; then
    step "Done (not rebuilt — the app is still running the previous build)"
    exit 0
fi

step "Rebuilding $SLUG (this restarts the app; any in-progress chat drops)"
sh_ha "bash -lc 'ha apps rebuild $SLUG'"

step "State"
sh_ha "bash -lc 'ha apps info $SLUG --raw-json'" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
print(f\"  version {d['version']}  state {d['state']}  ip {d['ip_address']}\")
"

if [ "$LOGS" = true ]; then
    step "App log"
    sh_ha "bash -lc 'ha apps logs $SLUG'" | tail -30
fi

if [ "$LIVE" = true ]; then
    step "Live smoke suite"
    (cd "$SRC" && npm run test:live)
fi
