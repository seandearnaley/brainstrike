#!/bin/bash

# Script to test commit messages against commitlint rules
# Usage: ./scripts/test-commit.sh "type(scope): your commit message"

if [ -z "$1" ]; then
  echo "Usage: ./scripts/test-commit.sh \"type(scope): your commit message\""
  echo ""
  echo "Examples:"
  echo "  ./scripts/test-commit.sh \"feat(ui): add new button component\""
  echo "  ./scripts/test-commit.sh \"fix(api): resolve authentication bug\""
  echo "  ./scripts/test-commit.sh \"docs: update README with new instructions\""
  echo ""
  echo "Available types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test, release"
  echo "Available scopes: auth, api, ui, config, deps, core, test, types, security, dx"
  exit 1
fi

echo "$1" | npx commitlint

if [ $? -eq 0 ]; then
  echo -e "\n✅ Commit message is valid!"
  
  # Check which version bump this would trigger
  if [[ "$1" == feat* ]]; then
    echo "This commit would trigger a MINOR version bump (e.g., 1.0.0 -> 1.1.0)"
  elif [[ "$1" == fix* || "$1" == docs* || "$1" == style* || "$1" == refactor* || "$1" == perf* || "$1" == test* ]]; then
    echo "This commit would trigger a PATCH version bump (e.g., 1.0.0 -> 1.0.1)"
  fi
  
  if [[ "$1" == *"BREAKING CHANGE"* || "$1" == *"!"* ]]; then
    echo "This commit would trigger a MAJOR version bump (e.g., 1.0.0 -> 2.0.0)"
  fi
else
  echo -e "\n❌ Commit message is invalid!"
  echo "Check the error message above and try again."
  echo "See docs/RELEASE_PROCESS.md for details on commit message format."
fi 