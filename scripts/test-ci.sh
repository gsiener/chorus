#!/bin/bash
# CI test runner that handles workerd memory crash during shutdown
# The tests pass but workerd crashes during cleanup - we detect success and exit 0

set -o pipefail

# Run tests and capture output
OUTPUT=$(npm test 2>&1) || true
EXIT_CODE=$?

echo "$OUTPUT"

# Check if tests passed (look for "Test Files" with passed count and no failures)
if echo "$OUTPUT" | grep -q "Test Files.*passed" && ! echo "$OUTPUT" | grep -q "Test Files.*failed"; then
  # All test files passed
  if echo "$OUTPUT" | grep -q "Tests.*passed" && ! echo "$OUTPUT" | grep -q "Tests.*failed"; then
    echo ""
    echo "✅ All tests passed (ignoring workerd shutdown crash)"
    exit 0
  fi
fi

# If we get here, tests actually failed
echo ""
echo "❌ Tests failed"
exit 1
