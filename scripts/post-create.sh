#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="${DEVCONTAINER_WORKSPACE_FOLDER:-/workspaces/litellm-connector-copilot}"
cd "$WORKSPACE_DIR"

# Fix ownership of Docker named volumes (created as root by default)
# postCreateCommand runs as node; sudo is available passwordless in this image
for dir in node_modules dist coverage test-results .vscode-test; do
	if [ -d "$WORKSPACE_DIR/$dir" ]; then
		sudo chown -R node:node "$WORKSPACE_DIR/$dir"
	fi
done

npm install --include=dev
npm run compile

npm run vscode:pack