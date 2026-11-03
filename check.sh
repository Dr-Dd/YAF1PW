#!/usr/bin/env bash
# Project check: the single command that must pass before a change is done.
#
# Steps: test, typecheck and lint of the Node app in loader/.
# Add other steps (build, format check, ...) as needed.
#
# In pi, the agent runs this through the `check` tool and needs your approval
# to change this file (see .pi/extensions/check-guard.ts).

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec 2>&1

failed=()

step() {
	local name=$1
	shift
	echo "==> $name: $*"
	if "$@"; then
		echo "==> $name: ok"
	else
		echo "==> $name: FAILED"
		failed+=("$name")
	fi
	echo
}

step test npm --prefix loader test
step typecheck npm --prefix loader run typecheck
step lint npm --prefix loader run lint

if ((${#failed[@]})); then
	echo "check: FAILED (${failed[*]})"
	exit 1
fi
echo "check: passed"
