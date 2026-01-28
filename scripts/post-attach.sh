#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="${DEVCONTAINER_WORKSPACE_FOLDER:-/workspaces/litellm-connector-copilot}"
cd "$WORKSPACE_DIR"

echo "Starting watcher for src/ and package.json (rebuilds on change)..."
npx chokidar-cli 'src/**' package.json -c "npm run compile && echo '*** Refresh the extension in VS Code to pick up changes. ***'"