#!/usr/bin/env python3
"""
Pre-commit sanity check on the release rule.

Home Assistant reads `version:` in claude-code-ui/config.yaml straight off
master to decide whether an update is available, so bumping it *is* the release
— it tells every installed user there is a new version, and if CI has not
published a matching image tag their update fails.

So the thing worth warning about is not a missing bump (ordinary commits should
not have one) but a bump that is out of step: a version change with no matching
CHANGELOG heading, or a CHANGELOG release heading with no version change.

Replaces an earlier hook that reminded you to bump on *every* commit, and looked
for the repo at a path that no longer exists.
"""
import json
import os
import re
import subprocess
import sys


def staged(repo, *args):
    r = subprocess.run(['git', *args], capture_output=True, text=True, cwd=repo)
    return r.stdout if r.returncode == 0 else ''


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return

    cmd = data.get('tool_input', {}).get('command', '')
    if not re.search(r'\bgit\b.*\bcommit\b', cmd):
        return

    repo = os.environ.get('CLAUDE_PROJECT_DIR') or os.getcwd()
    files = staged(repo, 'diff', '--cached', '--name-only').split()
    if not files:
        return

    diff = staged(repo, 'diff', '--cached', '--unified=0', '--', 'claude-code-ui/config.yaml')
    bumped = re.search(r'^\+version:\s*"([^"]+)"', diff, re.M)

    changelog = staged(repo, 'diff', '--cached', '--unified=0', '--', 'claude-code-ui/CHANGELOG.md')
    # A release heading is `## 1.2.3`; `## Unreleased` is where ordinary work goes.
    released = re.findall(r'^\+## (\d+\.\d+\.\d+)\s*$', changelog, re.M)

    warnings = []
    if bumped and not released:
        warnings.append(
            f'config.yaml is being bumped to {bumped.group(1)} but no matching '
            f'"## {bumped.group(1)}" heading is staged in CHANGELOG.md. A bump is a release: '
            'rename the "## Unreleased" heading to the new version in the same commit.')
    elif released and not bumped:
        warnings.append(
            f'CHANGELOG.md declares release {released[0]} but config.yaml is not being bumped. '
            'Home Assistant reads config.yaml, so the release would never reach anyone.')
    elif bumped and released and bumped.group(1) != released[0]:
        warnings.append(
            f'config.yaml says {bumped.group(1)} but CHANGELOG.md says {released[0]}. '
            'The version and the published image tag must stay in lockstep.')

    if warnings:
        print(json.dumps({'systemMessage': 'Release check: ' + ' '.join(warnings)}))


if __name__ == '__main__':
    main()
