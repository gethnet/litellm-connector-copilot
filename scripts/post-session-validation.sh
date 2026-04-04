#!/bin/bash
# Post-session validation hook
# Runs format check, lint check, and test coverage after agent session ends.
# If any check fails, returns a blocking error with instructions to resolve.

set -euo pipefail

# Read stdin (hook input) if available, otherwise continue
if [ ! -t 0 ]; then
    INPUT=$(cat)
fi

# Function to run a command and capture output
run_check() {
    local cmd="$1"
    local name="$2"
    echo "Running $name..."
    if output=$(eval "$cmd" 2>&1); then
        echo "✅ $name passed"
        return 0
    else
        echo "❌ $name failed:"
        echo "$output"
        return 1
    fi
}

# Track failures
FAILED_CHECKS=()

# Run format check
if ! run_check "npm run format:check" "format check"; then
    FAILED_CHECKS+=("format")
fi

# Run lint check
if ! run_check "npm run lint:check" "lint check"; then
    FAILED_CHECKS+=("lint")
fi

# Run test coverage
if ! run_check "npm run test:coverage" "test coverage"; then
    FAILED_CHECKS+=("test coverage")
fi

# If any checks failed, return blocking error
if [ ${#FAILED_CHECKS[@]} -gt 0 ]; then
    FAILED_LIST=$(printf -- ", %s" "${FAILED_CHECKS[@]}")
    FAILED_LIST="${FAILED_LIST:2}"  # Remove leading ", "

    # Build failure list for system message
    FAILURE_DETAILS=""
    for check in "${FAILED_CHECKS[@]}"; do
        FAILURE_DETAILS="${FAILURE_DETAILS}- ${check}\n"
    done

    cat <<EOF
{
  "decision": "block",
  "reason": "Post-session validation failed: ${FAILED_LIST}",
  "systemMessage": "Agent session ended with validation failures. Please resolve the following issues before continuing:\n\n${FAILURE_DETAILS}\nRun the following commands to see details:\n- npm run format:check\n- npm run lint:check  \n- npm run test:coverage\n\nFix the issues and try again."
}
EOF
    exit 2  # Blocking error
fi

# All checks passed
cat <<EOF
{
  "decision": "continue",
  "systemMessage": "✅ All post-session validation checks passed: format, lint, test coverage."
}
EOF
exit 0
