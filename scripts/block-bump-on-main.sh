#!/bin/bash
# PreToolUse hook: block `npm run bump-version` while on the main branch.
#
# Version bumps must happen on a dev/* branch (see
# .github/prompts/start-next-dev-version.prompt.md). Running the bump on main
# risks polluting the release branch with an unreviewed version change.
#
# Contract: receives the PreToolUse JSON payload on stdin; emits a
# hookSpecificOutput permissionDecision on stdout. Anything that is not a
# bump-version terminal command on main is allowed through untouched.

set -euo pipefail

PAYLOAD=$(cat)

# Only inspect terminal commands; allow everything else immediately.
COMMAND=$(printf '%s' "$PAYLOAD" | node -e '
  let data = "";
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data);
      // Tool input shape varies; check the common command-bearing fields.
      const input = payload.tool_input ?? payload.toolInput ?? {};
      process.stdout.write(String(input.command ?? ""));
    } catch {
      process.stdout.write("");
    }
  });
' 2>/dev/null || true)

if [[ "$COMMAND" != *"bump-version"* ]]; then
  exit 0
fi

BRANCH=$(git branch --show-current 2>/dev/null || echo "")

if [[ "$BRANCH" == "main" ]]; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Version bumps are not allowed on main. Create a dev branch first (run the start-next-dev-version prompt), then bump the version there."
  }
}
JSON
  exit 0
fi

exit 0
