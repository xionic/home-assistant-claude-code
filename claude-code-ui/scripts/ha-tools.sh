#!/bin/bash

# ha-tools — one entry point for this app's Home Assistant helper commands.
#
#   ha-tools history|stats|lovelace …   WebSocket helpers      (ha-tools.cjs)
#   ha-tools logs …                     Supervisor journald    (ha-logs.sh)
#   ha-tools ws …                       the ha-ws-client binary (passthrough)
#
# Each subcommand is also installed under its own name — ha-history, ha-stats,
# ha-lovelace, ha-logs — as a symlink back to this script. The name it was
# invoked as picks the subcommand (busybox style), so both spellings are the
# same command and neither can drift from the other. `ws` is a passthrough to
# the third-party ha-ws-client binary, which stays a separate tool; it's here so
# that `ha-tools --help` maps everything in one place.

set -uo pipefail

SELF="$(basename "$0")"
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# The `ws` module lives in the server's dependencies rather than beside these
# scripts, so the Node subcommands need NODE_PATH pointed at it.
NODE_MODULES="${HA_TOOLS_NODE_PATH:-/opt/server/node_modules}"

usage() {
    cat << 'USAGE'
Usage: ha-tools <command> [args]

Home Assistant helpers for this app. Commands with a name on the right are also
available under that name — the two spellings are the same command.

Inspect:
  timeline <entity_id…> [...]   Several entities' state changes on one clock (ha-timeline)
  history <entity_id> [...]     State-change history over a date range      (ha-history)
  stats <entity_id> [...]       Long-term statistics over a date range      (ha-stats)
  logs [source] [...]           Core/host/Supervisor/app logs               (ha-logs)

Automations:
  automation list               Every automation: entity_id, id, alias, state
  automation show <id>          The config HA currently has loaded
  automation yaml <id>          Its block in automations.yaml, with line numbers
  trace-watch <id> [...]        Block until it actually fires, then report the trace

Change and verify:
  config-check                  Validate the config, incl. per-entity errors HA
                                only logs (exits 1 if anything is wrong)
  reload [domain]               Reload automations (default) or another domain;
                                --expect <entity_id> asserts it actually exists
  lovelace <list|get|save|...>  Dashboards — WebSocket only, REST 404s      (ha-lovelace)
  ws <...>                      Entity states, service calls, templates,
                                registry search                          (ha-ws-client)

Times print in Home Assistant's timezone with an explicit offset (the container
clock is UTC and is not what the user means by "local"); pass --utc for UTC.

Run any command with --help for its own options, e.g. `ha-tools logs --help`.

Examples:
  ha-tools timeline light.hall binary_sensor.stairs --days 3 --between 22:00-07:00
  ha-tools history sensor.temperature --days 7 --format tsv
  ha-tools automation show automation.hall_light_off
  ha-tools config-check && ha-tools reload automation
  ha-tools reload template --expect cover.nick_blind   # ...and prove it exists
  ha-tools trace-watch automation.hall_light_off --timeout 2h
  ha-tools logs --errors -n 500
USAGE
}

# Invoked under an alias? Turn the alias back into its subcommand.
case "$SELF" in
    ha-history)  set -- history  "$@" ;;
    ha-stats)    set -- stats    "$@" ;;
    ha-timeline) set -- timeline "$@" ;;
    ha-lovelace) set -- lovelace "$@" ;;
    ha-logs)     set -- logs     "$@" ;;
esac

if [ $# -eq 0 ]; then
    usage
    exit 0
fi
sub="$1"
shift

# Echo the command back the way it was typed in usage/error messages.
if [ "$SELF" = "ha-tools" ]; then
    export HA_TOOLS_CMD="ha-tools $sub"
else
    export HA_TOOLS_CMD="$SELF"
fi

case "$sub" in
    history|stats|timeline|lovelace|automation|config-check|reload|trace-watch)
        exec env NODE_PATH="$NODE_MODULES" node "$SCRIPT_DIR/ha-tools.cjs" "$sub" "$@"
        ;;
    logs)
        # Run through bash rather than exec'ing the file, so the subcommand
        # doesn't depend on ha-logs.sh carrying the executable bit.
        exec bash "$SCRIPT_DIR/ha-logs.sh" "$@"
        ;;
    ws)
        if ! command -v ha-ws-client > /dev/null 2>&1; then
            echo "ha-tools: ha-ws-client is not installed" >&2
            exit 127
        fi
        exec ha-ws-client "$@"
        ;;
    -h|--help|help)
        usage
        exit 0
        ;;
    *)
        echo "ha-tools: unknown command '$sub'" >&2
        echo "Run 'ha-tools --help' for the list." >&2
        exit 2
        ;;
esac
