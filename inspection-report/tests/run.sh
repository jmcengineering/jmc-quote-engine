#!/usr/bin/env bash
# Run the metrology + audit tests. Requires node; no install step, no dependencies.
set -euo pipefail
cd "$(dirname "$0")"
node report.test.js
