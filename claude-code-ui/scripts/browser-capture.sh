#!/bin/sh
# Called as $BROWSER by `claude auth login` so we capture the URL
# instead of trying to open a real browser in the container.
printf 'BROWSER_URL:%s\n' "$1" >&2
