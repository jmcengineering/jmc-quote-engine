#!/usr/bin/env bash
# Run the costing tests. Requires node; no install step, no dependencies.
set -euo pipefail
cd "$(dirname "$0")"
node costing.test.js
