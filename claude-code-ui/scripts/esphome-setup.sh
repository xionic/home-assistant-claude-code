#!/bin/bash
# esphome-setup — make the ESPHome toolchain ready. Run in the background by
# run.sh on every start when `enable_esphome` is on, so the add-on/chat UI come
# up immediately. Idempotent and cheap when everything's already present.
#
# Two independent concerns:
#   1. System build dependencies (patch, build-essential, …). These are apt
#      packages that live in the container filesystem, so an add-on UPGRADE wipes
#      them — we reinstall when missing (i.e. after each upgrade). Mirrors what
#      the official ESPHome image bakes into its image; we install on demand so
#      non-ESPHome users don't carry ~250MB of build tools.
#   2. The ESPHome CLI itself, in a uv-provisioned Python 3.12 venv under /data
#      (persists across upgrades). ESPHome needs >=3.12 but the Debian base ships
#      3.11. PlatformIO compiler toolchains download lazily on the first compile
#      and cache under /data (see the esphome wrapper).
set -o pipefail

ESPHOME_DIR="/data/esphome"
VENV="$ESPHOME_DIR/venv"
MARKER="$ESPHOME_DIR/.installed"
LOG="$ESPHOME_DIR/setup.log"

# System packages ESPHome compilation needs, matching the official ESPHome image
# (esphome/docker-base). Unversioned so they resolve on our Debian base.
APT_DEPS=(patch build-essential ccache libusb-1.0-0 libcairo2 libmagic1 iputils-ping xz-utils)

mkdir -p "$ESPHOME_DIR"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG"; }

# ── 1. Build dependencies (wiped by upgrades; reinstall when missing) ─────────
# `patch` + a host compiler (`cc`) are the sentinels — if either is gone, the
# whole batch was wiped by an upgrade, so reinstall it.
if ! command -v patch >/dev/null 2>&1 || ! command -v cc >/dev/null 2>&1; then
    log "Installing ESPHome build dependencies (apt: ${APT_DEPS[*]})…"
    if apt-get update >>"$LOG" 2>&1 && \
       apt-get install -y --no-install-recommends "${APT_DEPS[@]}" >>"$LOG" 2>&1; then
        rm -rf /var/lib/apt/lists/*
        log "Build dependencies installed"
    else
        log "WARN: apt build-dependency install failed — compiles may fail. See $LOG"
    fi
fi

# ── 2. ESPHome CLI venv (persists in /data) ──────────────────────────────────
if [ -f "$MARKER" ] && [ -x "$VENV/bin/esphome" ]; then
    exit 0
fi

log "Installing ESPHome CLI (first-time setup; this can take a few minutes)…"

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
