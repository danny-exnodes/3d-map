#!/bin/bash
# Commits everything except the local debug hook in src/main.ts, then puts the hook back.
# Usage: .claude/skills/developer/scripts/commit.sh $'subject line\n\nbody (Refs #N)'
# The trailer line below is a generic commit attribution; replace it with the
# lines your session asks for.
set -e
cd "$(git rev-parse --show-toplevel)"
sed -i '/DEBUG-REMOVE/d' src/main.ts
git add -A
git commit -q -F - <<MSG
$1

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
"$(dirname "$0")/debug-hook.sh" on
git log --oneline -1
