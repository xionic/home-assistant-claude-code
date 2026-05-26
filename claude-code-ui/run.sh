#!/usr/bin/with-contenv bashio

# Enable strict error handling
set -e
set -o pipefail

# ---------------------------------------------------------------------------
# Environment initialisation
# ---------------------------------------------------------------------------
# Use /data exclusively — guaranteed writable by the HA Supervisor.
# Credentials in /data/.config/claude survive add-on restarts.
#
# claudecodeui discovers Claude sessions from ~/.claude. We set HOME to
# /data/home (a subdirectory of /data) and symlink ~/.claude to the real
# credential store at /data/.config/claude so both Claude Code CLI and
# claudecodeui agree on where credentials live.
# ---------------------------------------------------------------------------
init_environment() {
    local data_home="/data/home"
    local config_dir="/data/.config"
    local cache_dir="/data/.cache"
    local state_dir="/data/.local/state"
    local claude_config_dir="/data/.config/claude"

    bashio::log.info "Initialising Claude Code environment in /data..."

    if ! mkdir -p "$data_home" "$config_dir/claude" "$cache_dir" "$state_dir" "/data/.local"; then
        bashio::log.error "Failed to create directories in /data"
        exit 1
    fi

    chmod 755 "$data_home" "$config_dir" "$cache_dir" "$state_dir" "$claude_config_dir"

    # Core path variables
    export HOME="$data_home"
    export XDG_CONFIG_HOME="$config_dir"
    export XDG_CACHE_HOME="$cache_dir"
    export XDG_STATE_HOME="$state_dir"
    export XDG_DATA_HOME="/data/.local/share"

    # Claude Code credential paths
    export ANTHROPIC_CONFIG_DIR="$claude_config_dir"
    export ANTHROPIC_HOME="/data"

    # claudecodeui reads ~/.claude; create a symlink so it finds the same store
    if [ ! -L "$data_home/.claude" ]; then
        ln -sf "$claude_config_dir" "$data_home/.claude"
        bashio::log.info "Symlinked ~/.claude -> $claude_config_dir"
    fi

    migrate_legacy_auth_files "$claude_config_dir"

    bashio::log.info "Environment initialised:"
    bashio::log.info "  Home:           $HOME"
    bashio::log.info "  XDG config:     $XDG_CONFIG_HOME"
    bashio::log.info "  Claude config:  $ANTHROPIC_CONFIG_DIR"
    bashio::log.info "  Cache:          $XDG_CACHE_HOME"
}

# ---------------------------------------------------------------------------
# One-time migration of credentials from legacy locations
# Adapted from heytcass/home-assistant-addons (MIT)
# ---------------------------------------------------------------------------
migrate_legacy_auth_files() {
    local target_dir="$1"
    local migrated=false

    bashio::log.info "Checking for existing authentication files to migrate..."

    local legacy_locations=(
        "/root/.config/anthropic"
        "/root/.anthropic"
        "/config/claude-config"
        "/tmp/claude-config"
    )

    for legacy_path in "${legacy_locations[@]}"; do
        if [ -d "$legacy_path" ] && [ "$(ls -A "$legacy_path" 2>/dev/null)" ]; then
            bashio::log.info "Migrating auth files from: $legacy_path"
            if cp -r "$legacy_path"/* "$target_dir/" 2>/dev/null; then
                find "$target_dir" -type f -exec chmod 600 {} \;
                if [[ "$legacy_path" == "/root/.config/anthropic" ]] || \
                   [[ "$legacy_path" == "/root/.anthropic" ]]; then
                    rm -rf "$legacy_path"
                    ln -sf "$target_dir" "$legacy_path"
                    bashio::log.info "Created compatibility symlink: $legacy_path -> $target_dir"
                fi
                migrated=true
                bashio::log.info "Migration completed from: $legacy_path"
            else
                bashio::log.warning "Failed to migrate from: $legacy_path"
            fi
        fi
    done

    [ "$migrated" = false ] && bashio::log.info "No existing authentication files found to migrate"
}

# ---------------------------------------------------------------------------
# Persistent packages
# Adapted from heytcass/home-assistant-addons (MIT)
# ---------------------------------------------------------------------------
install_persistent_packages() {
    bashio::log.info "Checking for persistent packages..."

    local persist_config="/data/persistent-packages.json"
    local apk_packages=""
    local pip_packages=""

    if bashio::config.has_value 'persistent_apk_packages'; then
        local config_apk
        config_apk=$(bashio::config 'persistent_apk_packages')
        if [ -n "$config_apk" ] && [ "$config_apk" != "null" ]; then
            apk_packages="$config_apk"
        fi
    fi

    if bashio::config.has_value 'persistent_pip_packages'; then
        local config_pip
        config_pip=$(bashio::config 'persistent_pip_packages')
        if [ -n "$config_pip" ] && [ "$config_pip" != "null" ]; then
            pip_packages="$config_pip"
        fi
    fi

    if [ -f "$persist_config" ]; then
        local local_apk local_pip
        local_apk=$(jq -r '.apk_packages | join(" ")' "$persist_config" 2>/dev/null || echo "")
        local_pip=$(jq -r '.pip_packages | join(" ")' "$persist_config" 2>/dev/null || echo "")
        [ -n "$local_apk" ] && apk_packages="$apk_packages $local_apk"
        [ -n "$local_pip" ] && pip_packages="$pip_packages $local_pip"
    fi

    apk_packages=$(echo "$apk_packages" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)
    pip_packages=$(echo "$pip_packages" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

    if [ -n "$apk_packages" ]; then
        bashio::log.info "Installing persistent APK packages: $apk_packages"
        # shellcheck disable=SC2086
        apk add --no-cache $apk_packages || bashio::log.warning "Some APK packages failed to install"
    fi

    if [ -n "$pip_packages" ]; then
        bashio::log.info "Installing persistent pip packages: $pip_packages"
        # shellcheck disable=SC2086
        pip3 install --break-system-packages --no-cache-dir $pip_packages \
            || bashio::log.warning "Some pip packages failed to install"
    fi

    [ -z "$apk_packages" ] && [ -z "$pip_packages" ] && \
        bashio::log.info "No persistent packages configured"
}

# ---------------------------------------------------------------------------
# HA Smart Context
# Adapted from heytcass/home-assistant-addons (MIT)
# ---------------------------------------------------------------------------
generate_ha_context() {
    local ha_smart_context
    ha_smart_context=$(bashio::config 'ha_smart_context' 'true')

    if [ "$ha_smart_context" = "true" ]; then
        bashio::log.info "Generating Home Assistant context for Claude sessions..."
        if [ -f /opt/scripts/ha-context.sh ]; then
            if /opt/scripts/ha-context.sh 2>&1 | while IFS= read -r line; do
                bashio::log.info "$line"
            done; then
                bashio::log.info "HA context generated successfully -> $HOME/CLAUDE.md"
            else
                bashio::log.warning "HA context generation had issues, continuing..."
            fi
        else
            bashio::log.warning "ha-context.sh not found, skipping"
        fi
    else
        bashio::log.info "HA Smart Context disabled"
    fi
}

# ---------------------------------------------------------------------------
# ha-mcp (Home Assistant MCP Server)
# Adapted from heytcass/home-assistant-addons (MIT)
# ---------------------------------------------------------------------------
setup_ha_mcp() {
    if [ -f "/opt/scripts/setup-ha-mcp.sh" ]; then
        bashio::log.info "Setting up Home Assistant MCP integration..."
        chmod +x /opt/scripts/setup-ha-mcp.sh
        # shellcheck disable=SC1091
        source /opt/scripts/setup-ha-mcp.sh
        configure_ha_mcp_server || bashio::log.warning "ha-mcp setup encountered issues but continuing..."
    else
        bashio::log.info "setup-ha-mcp.sh not found, skipping MCP integration"
    fi
}

# ---------------------------------------------------------------------------
# claudecodeui server
#
# claudecodeui (@cloudcli-ai/cloudcli) is a mobile-friendly web UI that
# wraps Claude Code CLI, spawning it as a subprocess.  We run it on port
# 7681 (matched to the HA ingress_port in config.yaml) with the working
# directory set to /config so the file explorer opens on the HA config tree.
#
# Environment variables passed to the server:
#   SERVER_PORT   — port to listen on (must match ingress_port)
#   HOME          — already set above; ~/ resolves to /data/home
#   ANTHROPIC_*   — already set above; picks up OAuth credentials
#
# Troubleshooting note:
#   If claudecodeui fails to discover credentials, check that the symlink
#   /data/home/.claude -> /data/.config/claude exists and is valid.
# ---------------------------------------------------------------------------
start_claudecodeui() {
    local port=7681
    bashio::log.info "Starting claudecodeui on port ${port}..."
    bashio::log.info "  Working dir: /config"
    bashio::log.info "  Claude config: ${ANTHROPIC_CONFIG_DIR}"
    bashio::log.info "  HOME: ${HOME}"

    export SERVER_PORT="${port}"

    # claudecodeui reads the working directory for the file explorer.
    # /config is the HA configuration directory — the natural project root.
    cd /config

    # The `cloudcli` binary is installed globally by npm.
    # If it is not on PATH, fall back to locating it via npm root.
    if command -v cloudcli >/dev/null 2>&1; then
        exec cloudcli
    else
        # Fallback: run the pre-built server directly
        local npm_root
        npm_root=$(npm root -g 2>/dev/null || echo "/usr/lib/node_modules")
        local server_js="${npm_root}/@cloudcli-ai/cloudcli/dist-server/index.js"
        if [ -f "$server_js" ]; then
            bashio::log.info "Running cloudcli server via node: $server_js"
            exec node "$server_js"
        else
            bashio::log.error "Cannot find cloudcli binary or dist-server/index.js"
            bashio::log.error "Verify that @cloudcli-ai/cloudcli was installed correctly"
            exit 1
        fi
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    bashio::log.info "Starting Claude Code UI add-on..."

    init_environment
    install_persistent_packages
    generate_ha_context
    setup_ha_mcp
    start_claudecodeui
}

main "$@"
