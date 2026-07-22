#!/bin/bash
# esphome-setup — install the ESPHome CLI into a persistent venv under /data.
#
# Run in the background by run.sh the first time `enable_esphome` is on, so the
# add-on (and chat UI) start immediately while ESPHome installs. Everything lives
# under /data so it survives restarts; a `.installed` marker records completion.
#
# ESPHome needs Python >=3.12 but the Debian base ships 3.11, so we use `uv` to
# fetch a standalone 3.12 and build the venv against it. The compiler toolchains
# (PlatformIO) are fetched lazily on the first compile and cached under
# /data/esphome/.platformio (see the esphome wrapper).
set -o pipefail

ESPHOME_DIR="/data/esphome"
VENV="$ESPHOME_DIR/venv"
MARKER="$ESPHOME_DIR/.installed"
LOG="$ESPHOME_DIR/setup.log"

mkdir -p "$ESPHOME_DIR"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }

# Already installed and runnable? Nothing to do.
if [ -f "$MARKER" ] && [ -x "$VENV/bin/esphome" ]; then
    exit 0
fi

log "Installing ESPHome (first-time setup; this can take a few minutes)…"

# Provision Python 3.12 + an isolated venv via uv (downloads a standalone CPython
# on first use, cached under /data via XDG_DATA_HOME).
if ! uv venv --python 3.12 "$VENV" >>"$LOG" 2>&1; then
    log "ERROR: could not create a Python 3.12 venv (uv). See $LOG"
    exit 1
fi

if uv pip install --python "$VENV/bin/python" esphome >>"$LOG" 2>&1; then
    VER="$("$VENV/bin/esphome" version 2>/dev/null | head -1)"
    touch "$MARKER"
    log "ESPHome installed: ${VER:-unknown}"
else
    log "ERROR: esphome install failed — see $LOG"
    exit 1
fi
