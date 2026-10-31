#!/usr/bin/env bash
# Convenience launcher: run this from the project root on a Mac.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/native/build-ios-ipa.sh" "$@"
