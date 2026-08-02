#!/bin/bash
# shellcheck source=/dev/null
source /usr/lib/bashio/bashio.sh

set -e
set -o pipefail

# ---------------------------------------------------------------------------
# Environment initialisation
# ---------------------------------------------------------------------------
# All persistent state lives under /data — guaranteed writable by HA Supervisor.
# The Agent SDK subprocess (spawned by the server) reads the Claude config from
# ANTHROPIC_CONFIG_DIR. We set HOME to /data/home so ~ resolves predictably.
# ---------------------------------------------------------------------------
init_environment() {
    local data_home="/data/home"
    local config_dir="/data/.config"
    local cache_dir="/data/.cache"
    local state_dir="/data/.local/state"
    local claude_config_dir="/data/.config/claude"

    bashio::log.info "Initialising environment in /data..."

    mkdir -p "$data_home" "$config_dir/claude" "$cache_dir" "$state_dir" "/data/.local"
    chmod 755 "$data_home" "$config_dir" "$cache_dir" "$state_dir" "$claude_config_dir"

    export HOME="$data_home"
    export XDG_CONFIG_HOME="$config_dir"
    export XDG_CACHE_HOME="$cache_dir"
    export XDG_STATE_HOME="$state_dir"
    export XDG_DATA_HOME="/data/.local/share"

    # Claude Code CLI and Agent SDK both respect ANTHROPIC_CONFIG_DIR
    export ANTHROPIC_CONFIG_DIR="$claude_config_dir"
    export ANTHROPIC_HOME="/data"

    # Create ~/.claude symlink so tools that look in HOME find the config
    if [ ! -L "$data_home/.claude" ]; then
        ln -sf "$claude_config_dir" "$data_home/.claude"
    fi

    migrate_legacy_auth_files "$claude_config_dir"

    bashio::log.info "Environment ready — HOME=$HOME  ANTHROPIC_CONFIG_DIR=$ANTHROPIC_CONFIG_DIR"
}

# ---------------------------------------------------------------------------
# One-time migration from legacy credential locations
# Adapted from heytcass/home-assistant-addons (MIT)
# ---------------------------------------------------------------------------
migrate_legacy_auth_files() {
    local target_dir="$1"

    local legacy_locations=(
        "/root/.config/anthropic"
        "/root/.anthropic"
        "/config/claude-config"
        "/tmp/claude-config"
    )

    for legacy_path in "${legacy_locations[@]}"; do
        if [ -d "$legacy_path" ] && [ "$(ls -A "$legacy_path" 2>/dev/null)" ]; then
            bashio::log.info "Migrating auth files from: $legacy_path"
            cp -r "$legacy_path"/* "$target_dir/" 2>/dev/null || true
            find "$target_dir" -type f -exec chmod 600 {} \;
            if [[ "$legacy_path" == "/root/.config/anthropic" || "$legacy_path" == "/root/.anthropic" ]]; then
                rm -rf "$legacy_path"
                ln -sf "$target_dir" "$legacy_path"
            fi
        fi
    done
}

# ---------------------------------------------------------------------------
# HA Smart Context — writes CLAUDE.md with HA system info for every session
# Adapted from heytcass/home-assistant-addons (MIT)
# ---------------------------------------------------------------------------
generate_ha_context() {
    local ha_smart_context
    ha_smart_context=$(bashio::config 'ha_smart_context' 'true')

    if [ "$ha_smart_context" != "true" ]; then
        bashio::log.info "HA Smart Context disabled"
        return 0
    fi

    bashio::log.info "Generating Home Assistant context..."
    if [ -f /opt/scripts/ha-context.sh ]; then
        if /opt/scripts/ha-context.sh 2>&1 | while IFS= read -r line; do
            bashio::log.info "  $line"
        done; then
            bashio::log.info "HA context written to $HOME/.claude/ha-context.md"
        else
            bashio::log.warning "HA context generation had issues — continuing"
        fi
    else
        bashio::log.warning "ha-context.sh not found, skipping"
    fi

    # Seed a user-editable CLAUDE.md once. It @-imports the regenerated HA context
    # but is never overwritten afterwards, so the user's own instructions persist
    # across restarts/updates (everything under /data is persistent).
    local claude_md="$HOME/.claude/CLAUDE.md"
    if [ ! -f "$claude_md" ]; then
        cat > "$claude_md" << 'CLAUDEMD'
@ha-context.md

<!-- Your own persistent instructions for Claude go below. This file is created
     once and never overwritten by the app, so your edits are safe. The line
     above imports the auto-generated Home Assistant context. -->
CLAUDEMD
        bashio::log.info "Seeded user-editable CLAUDE.md at $claude_md"
    fi
}

# (ha-mcp is configured directly in the Node server via mcpServers option)

# ---------------------------------------------------------------------------
# ESPHome capability (optional) — detect the installed ESPHome app, expose
# its config folder, and lazily install the esphome CLI into /data on first use.
# ---------------------------------------------------------------------------
setup_esphome() {
    export ENABLE_ESPHOME
    export ESPHOME_CONFIG_DIR=""
    ENABLE_ESPHOME=$(bashio::config 'enable_esphome' 'false')

    if [ "$ENABLE_ESPHOME" != "true" ]; then
        return 0
    fi

    # Locate the ESPHome device YAML. The ESPHome "Device Builder" app keeps
    # its configs in /config/esphome (the HA config dir we already map) — the
    # common case, and directly accessible with no /addon_configs involved. Some
    # setups instead use the shared /addon_configs/<slug> folder; fall back to
    # that (found via the app whose slug ends in _esphome), which relies on
    # allow_addon_configs / the guard exemption.
    # `|| true` so a failed supervisor call can't trip `set -e` and abort startup.
    local slug
    slug=$(curl -s -m 10 -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        http://supervisor/addons 2>/dev/null \
        | jq -r '[.data.addons[] | select(.slug|endswith("_esphome"))][0].slug // empty' 2>/dev/null || true)

    if [ -d /config/esphome ]; then
        ESPHOME_CONFIG_DIR="/config/esphome"
        bashio::log.info "ESPHome enabled — configs at ${ESPHOME_CONFIG_DIR}"
    elif [ -n "$slug" ] && [ -d "/addon_configs/${slug}" ]; then
        ESPHOME_CONFIG_DIR="/addon_configs/${slug}"
        bashio::log.info "ESPHome enabled — configs at ${ESPHOME_CONFIG_DIR} (app: ${slug})"
    else
        bashio::log.warning "ESPHome enabled but no config folder found (looked in /config/esphome and /addon_configs) — the esphome CLI still works on paths you give it"
    fi

    # Ensure the toolchain in the background so the UI is up immediately. Runs on
    # every start (idempotent, cheap when ready): it reinstalls the apt build deps
    # if an upgrade wiped them, and installs the ESPHome venv on first enable.
    bashio::log.info "Ensuring ESPHome toolchain in the background — see /data/esphome/setup.log"
    ( /opt/scripts/esphome-setup.sh >/dev/null 2>&1 & )
}

# ---------------------------------------------------------------------------
# Start the Node.js server
# ---------------------------------------------------------------------------
start_server() {
    local port=7681

    bashio::log.info "Starting Claude Code UI server on port ${port}..."

    # Export API key if set in app config (overrides any saved credentials)
    local api_key
    api_key=$(bashio::config 'anthropic_api_key' '')
    if [ -n "$api_key" ] && [ "$api_key" != "null" ]; then
        export ANTHROPIC_API_KEY="$api_key"
        bashio::log.info "Anthropic API key loaded from app config"
    fi

    export SERVER_PORT="${port}"
    export WORK_DIR="/config"
    export PLUGIN_DIR="/opt/plugins/homeassistant-config"
    export DEFAULT_PERMISSION_MODE=$(bashio::config 'default_permission_mode' 'ask')
    export DEBUG_MODE=$(bashio::config 'debug' 'false')
    export VERBOSE_LOGGING=$(bashio::config 'verbose_logging' 'false')

    if [ "$DEBUG_MODE" = "true" ]; then
        bashio::log.info "Debug mode enabled — /diag endpoint active"
    fi

    if [ "$ALLOW_ADDON_CONFIGS" = "true" ]; then
        bashio::log.info "Other app config access enabled — /addon_configs is available"
    else
        bashio::log.info "Other app config access disabled — /addon_configs is blocked"
    fi

    if [ "$VERBOSE_LOGGING" = "true" ]; then
        bashio::log.info "Verbose logging enabled — per-event query logs will appear here"
    fi

    if [ "$ENABLE_ESPHOME" = "true" ]; then
        bashio::log.info "ESPHome capability enabled — CONFIG_DIR=${ESPHOME_CONFIG_DIR:-<none>}"
    fi

    cd /config
    exec node /opt/server/index.js
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    bashio::log.info "Starting Claude Code UI app..."

    # Whether the assistant may access other apps' config folders
    # (/addon_configs). Read once and exported so both the context generator and
    # the server agree. The mount itself is always present (HA folder maps are
    # static); this flag gates access at the tool-call layer in the server.
    export ALLOW_ADDON_CONFIGS
    ALLOW_ADDON_CONFIGS=$(bashio::config 'allow_addon_configs' 'false')

    init_environment
    setup_esphome
    generate_ha_context
    start_server
}

main "$@"
