#!/bin/bash
# shellcheck source=/dev/null
[[ -z "${BASHIO_VERSION:-}" ]] && source /usr/lib/bashio/bashio.sh
# Setup ha-mcp (Home Assistant MCP Server) for Claude Code
# Configures Claude Code to use ha-mcp for Home Assistant tool calls
#
# Adapted from heytcass/home-assistant-addons (MIT)
# https://github.com/heytcass/home-assistant-addons
# Original repository: https://github.com/homeassistant-ai/ha-mcp

set -e

configure_ha_mcp_server() {
    local enable_ha_mcp
    enable_ha_mcp=$(bashio::config 'enable_ha_mcp' 'true')

    if [ "$enable_ha_mcp" != "true" ]; then
        bashio::log.info "ha-mcp integration is disabled in configuration"
        return 0
    fi

    bashio::log.info "Setting up ha-mcp (Home Assistant MCP Server)..."

    if [ -z "${SUPERVISOR_TOKEN:-}" ]; then
        bashio::log.warning "SUPERVISOR_TOKEN not available — ha-mcp setup skipped"
        return 0
    fi

    if ! command -v uvx &> /dev/null; then
        bashio::log.warning "uvx not found — ha-mcp setup skipped"
        return 0
    fi

    bashio::log.info "Configuring Claude Code MCP server for Home Assistant..."

    # Remove existing ha-mcp configuration to ensure clean state
    claude mcp remove home-assistant 2>/dev/null || true

    # Add ha-mcp as MCP server using stdio transport via uvx
    #   HOMEASSISTANT_URL  — internal Supervisor API endpoint
    #   HOMEASSISTANT_TOKEN — Supervisor token for authentication
    if claude mcp add home-assistant \
        --env "HOMEASSISTANT_URL=http://supervisor/core" \
        --env "HOMEASSISTANT_TOKEN=${SUPERVISOR_TOKEN}" \
        -- uvx --index-strategy unsafe-best-match ha-mcp@3.5.1; then
        bashio::log.info "ha-mcp configured successfully!"
        bashio::log.info "Claude can now control Home Assistant via MCP tools"
    else
        bashio::log.warning "Failed to configure ha-mcp — continuing without MCP integration"
        bashio::log.warning "Manual command: claude mcp add home-assistant \\"
        bashio::log.warning "  --env HOMEASSISTANT_URL=http://supervisor/core \\"
        bashio::log.warning "  --env HOMEASSISTANT_TOKEN=\$SUPERVISOR_TOKEN \\"
        bashio::log.warning "  -- uvx --index-strategy unsafe-best-match ha-mcp@3.5.1"
    fi
}

# Run setup if executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    configure_ha_mcp_server
fi
