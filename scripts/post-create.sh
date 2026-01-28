#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="${DEVCONTAINER_WORKSPACE_FOLDER:-/workspaces/litellm-connector-copilot}"
cd "$WORKSPACE_DIR"

sudo apt-get update && sudo apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libcups2t64 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2t64 \
    libpango-1.0-0 \
    libcairo2 \
    libxshmfence1 \
    libx11-xcb1 \
    libgtk-3-0t64 \
    xvfb


npm install --include=dev
npm run compile

npm run vscode:pack