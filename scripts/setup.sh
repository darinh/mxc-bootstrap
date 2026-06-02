#!/usr/bin/env bash
# Deploy the MXC sandbox MCP server to an install dir and smoke-test it.
#
# Usage:
#   ./scripts/setup.sh [--install <dir>] [--register <copilot|claude|codex|cursor>]
set -euo pipefail

INSTALL_DIR="${HOME}/.mxc"
REGISTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL_DIR="$2"; shift 2 ;;
    --register) REGISTER="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP_DIR="${INSTALL_DIR}/mcp"

# Minimal coloring; disabled when stdout isn't a TTY or NO_COLOR is set.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_CYAN=$'\e[1;36m'; C_GREEN=$'\e[1;32m'; C_RESET=$'\e[0m'
else
  C_CYAN=""; C_GREEN=""; C_RESET=""
fi
hdr() { echo "${C_CYAN}== $* ==${C_RESET}"; }

hdr "mxc-bootstrap setup"
echo "repo:    ${REPO_ROOT}"
echo "install: ${INSTALL_DIR}"

# Require Node >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (>=18). Install it and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "Node.js >= 18 required; found $(node --version)" >&2
  exit 1
fi
echo "Node $(node --version) OK"

# 1. Deploy (skip node_modules; npm install regenerates it in the target)
mkdir -p "${MCP_DIR}" "${INSTALL_DIR}/config"
for item in "${REPO_ROOT}"/mcp/*; do
  [[ "$(basename "${item}")" == "node_modules" ]] && continue
  cp -R "${item}" "${MCP_DIR}/"
done
cp -R "${REPO_ROOT}/config/." "${INSTALL_DIR}/config/"
echo "Deployed server files to ${MCP_DIR}"

# 2. Install dependencies
( cd "${MCP_DIR}" && echo "Installing npm dependencies..." && npm install --no-fund --no-audit )

# 3. Smoke test
echo
hdr "self-test"
node "${MCP_DIR}/selftest.mjs"

# 4. Render snippets / optional registration
echo
hdr "registration"
CONFIGURE_ARGS=("${REPO_ROOT}/scripts/configure.mjs" --install "${INSTALL_DIR}" --repo "${REPO_ROOT}")
if [[ -n "${REGISTER}" ]]; then
  CONFIGURE_ARGS+=(--register "${REGISTER}")
fi
node "${CONFIGURE_ARGS[@]}"

echo
echo "${C_GREEN}Done.${C_RESET}"
