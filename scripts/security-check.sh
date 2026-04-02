#!/usr/bin/env bash
set -euo pipefail

echo "Running npm security audit (level: high)..."
npm audit --audit-level=high

echo ""
echo "Security check passed — no high or critical vulnerabilities found."
