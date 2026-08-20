#!/bin/bash

# ha-logs — read Home Assistant logs from the Supervisor's journald endpoints.
#
# Why this exists: HA 2025.11 removed /config/home-assistant.log on HAOS and
# Supervised installs and moved Core logging to the systemd journal. The Core
# REST endpoint `/api/error_log` was removed along with it and now returns 404
# (still listed in the developer docs, so it looks available and isn't). Logs
# are only reachable through the Supervisor now:
#
#   core/logs                        Home Assistant Core
#   host/logs                        host / systemd
#   supervisor/logs                  Supervisor itself
#   addons/self/logs                 this app's own log
#   host/logs/identifiers/<id>       any other unit (see --units)
#   host/logs/boots                  boot ids, for --boot
#
# All of them return plain text coloured with ANSI escapes, which is stripped
# here unless --raw is given. Auth is automatic via $SUPERVISOR_TOKEN.

SUPERVISOR_URL="${HA_SUPERVISOR_URL:-http://supervisor}"
SOURCE="core"
LINES=100
ERRORS_ONLY=false
FOLLOW=false
RAW=false
VERBOSE=false
BOOT=""

usage() {
    # Reachable as either `ha-logs` or `ha-tools logs`; answer as it was called.
    echo "Usage: ${HA_TOOLS_CMD:-ha-logs} [SOURCE] [OPTIONS]"
    cat << 'USAGE'

Read Home Assistant logs (systemd journal, via the Supervisor).

Sources:
  core                Home Assistant Core log (default)
  host                Host / systemd log
  supervisor          Supervisor log
  self                This app's own log
  <identifier>        Any journal identifier — list them with --units
                      (e.g. app_core_mosquitto, homeassistant, kernel)

Options:
  -n, --lines N       Number of lines to fetch (default 100)
  -e, --errors        Show only ERROR / WARNING lines
  -b, --boot N        Logs from boot N (0 = current boot)
  -f, --follow        Stream new lines as they arrive (Ctrl-C to stop)
  -v, --verbose       Verbose journal output (includes extra fields)
      --units         List available journal identifiers and exit
      --boots         List boot ids and exit
      --raw           Keep ANSI colour codes
  -h, --help          Show this help

Examples:
  ha-logs                             # last 100 lines of the Core log
  ha-logs --errors -n 500             # errors/warnings from the last 500 lines
  ha-logs self -n 200                 # this app's own log
  ha-logs supervisor --errors
  ha-logs app_core_mosquitto -n 50    # another app's log
  ha-logs core --boot 0 --errors      # errors since the current boot started
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--lines)   LINES="$2"; shift 2 ;;
        -e|--errors)  ERRORS_ONLY=true; shift ;;
        -b|--boot)    BOOT="$2"; shift 2 ;;
        -f|--follow)  FOLLOW=true; shift ;;
        -v|--verbose) VERBOSE=true; shift ;;
        --raw)        RAW=true; shift ;;
        --units)      SOURCE="__units__"; shift ;;
        --boots)      SOURCE="__boots__"; shift ;;
        -h|--help)    usage; exit 0 ;;
        -*)           echo "Unknown option: $1" >&2; echo "Run 'ha-logs --help' for usage" >&2; exit 1 ;;
        *)            SOURCE="$1"; shift ;;
    esac
done

if [ -z "$SUPERVISOR_TOKEN" ]; then
    echo "Error: SUPERVISOR_TOKEN not set. This script must run inside a Home Assistant app." >&2
    exit 1
fi

# Map the friendly source name to a Supervisor path. Anything unrecognised is
# treated as a journal identifier, so `ha-logs app_core_mosquitto` just works.
case "$SOURCE" in
    core)       path="core/logs" ;;
    host)       path="host/logs" ;;
    supervisor) path="supervisor/logs" ;;
    self)       path="addons/self/logs" ;;
    __units__)
        curl -s -m 10 -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
            "${SUPERVISOR_URL}/host/logs/identifiers" \
            | { jq -r '.data.identifiers[]' 2>/dev/null || cat; } | sort
        exit $?
        ;;
    __boots__)
        curl -s -m 10 -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
            "${SUPERVISOR_URL}/host/logs/boots" \
            | { jq -r '.data.boots | to_entries[] | "\(.key)\t\(.value)"' 2>/dev/null || cat; }
        exit $?
        ;;
    *)          path="host/logs/identifiers/${SOURCE}" ;;
esac

# `follow` streams, so no line limit and no timeout.
if [ "$FOLLOW" = true ]; then
    query="follow"
    timeout_args=()
else
    query="lines=${LINES}"
    timeout_args=(-m 30)
fi
[ -n "$BOOT" ] && query="${query}&boot=${BOOT}"
[ "$VERBOSE" = true ] && query="${query}&verbose"

strip_ansi() {
    if [ "$RAW" = true ]; then cat; else sed 's/\x1b\[[0-9;]*m//g'; fi
}

# Core and host logs are journal-formatted ("2026-08-12 19:34:02.107 WARNING …"),
# but an app's log is whatever that container printed to stdout — this app uses
# "[<ISO>] INFO …", others use bare text. So match the level as a word anywhere
# in the line rather than assuming any one layout.
filter() {
    if [ "$ERRORS_ONLY" = true ]; then
        grep -E '\b(ERROR|CRITICAL|FATAL|WARNING|WARN)\b|Traceback' || true
    else
        cat
    fi
}

if [ "$FOLLOW" = true ]; then
    curl -s --no-buffer \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        -H "Accept: text/plain" \
        "${SUPERVISOR_URL}/${path}?${query}" 2>/dev/null | strip_ansi | filter
    exit ${PIPESTATUS[0]}
fi

# Trust the HTTP status, not the body. An error body ("404: Not Found", a JSON
# error object) is short, non-empty text that reads as log content if printed —
# which is exactly how the removal of /api/error_log went unnoticed for months.
# Content sniffing can't tell them apart either, because an app's log has no
# guaranteed shape; the status code can.
body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT
code=$(curl -s "${timeout_args[@]}" -o "$body_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    -H "Accept: text/plain" \
    "${SUPERVISOR_URL}/${path}?${query}" 2>/dev/null)

if [ "$code" != "200" ]; then
    echo "Error: ${SUPERVISOR_URL}/${path} returned HTTP ${code:-000}." >&2
    [ -s "$body_file" ] && echo "Supervisor said: $(head -c 200 "$body_file" | tr '\n' ' ')" >&2
    echo "Run 'ha-logs --units' to list valid identifiers." >&2
    exit 1
fi

# Supervisor answers 200 with an empty body for an unknown identifier exactly as
# it does for a real unit that has logged nothing, so the status code can't
# separate them — check the identifier list to say which it was.
if [ ! -s "$body_file" ]; then
    if [ "$path" = "host/logs/identifiers/${SOURCE}" ] \
       && ! curl -s -m 10 -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
              "${SUPERVISOR_URL}/host/logs/identifiers" \
            | grep -q "\"${SOURCE}\""; then
        echo "Error: no journal identifier '${SOURCE}'. Run 'ha-logs --units' to list them." >&2
        exit 1
    fi
    echo "No log entries for '${SOURCE}'." >&2
    exit 0
fi

strip_ansi < "$body_file" | filter
