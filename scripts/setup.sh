#!/usr/bin/env bash
# Machine setup (phase 1): deploy the MXC sandbox runtime, put `mxc-bootstrap` on PATH, and run a
# repo-agnostic health check. Onboard individual repos afterwards with `mxc-bootstrap init`.
#
# Usage:
#   ./scripts/setup.sh [--install <dir>] [--register <copilot|claude|codex|cursor|all>] [--no-path]
set -euo pipefail

INSTALL_DIR="${HOME}/.mxc"
REGISTER=""
NO_PATH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL_DIR="$2"; shift 2 ;;
    --register) REGISTER="$2"; shift 2 ;;
    --no-path) NO_PATH=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP_DIR="${INSTALL_DIR}/mcp"
BIN_DIR="${INSTALL_DIR}/bin"

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

# 1. Deploy runtime: mcp server, cli, configure, profiles, examples.
mkdir -p "${MCP_DIR}" "${INSTALL_DIR}/profiles" "${INSTALL_DIR}/examples" "${BIN_DIR}"
for item in "${REPO_ROOT}"/mcp/*; do
  [[ "$(basename "${item}")" == "node_modules" ]] && continue
  cp -R "${item}" "${MCP_DIR}/"
done
cp "${REPO_ROOT}/scripts/cli.mjs" "${INSTALL_DIR}/cli.mjs"
cp "${REPO_ROOT}/scripts/configure.mjs" "${INSTALL_DIR}/configure.mjs"
cp "${REPO_ROOT}"/config/profiles/*.json "${INSTALL_DIR}/profiles/"
cp -R "${REPO_ROOT}/examples/." "${INSTALL_DIR}/examples/"
echo "${C_GREEN}Deployed runtime to ${INSTALL_DIR}${C_RESET}"

# 2. Install dependencies (pulls @microsoft/mxc-sdk with the bundled native binaries).
( cd "${MCP_DIR}" && echo "Installing npm dependencies..." && npm install --no-fund --no-audit )

# 3. Create the `mxc-bootstrap` launcher and add <install>/bin to PATH.
cat > "${BIN_DIR}/mxc-bootstrap" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${DIR}/../cli.mjs" "$@"
EOF
chmod +x "${BIN_DIR}/mxc-bootstrap"
echo "Launcher: ${BIN_DIR}/mxc-bootstrap"

PATH_CHANGED=0
if [[ "${NO_PATH}" -eq 0 ]]; then
  # Pick the user's shell profile and append an idempotent PATH export.
  PROFILE="${HOME}/.bashrc"
  [[ "${SHELL:-}" == */zsh ]] && PROFILE="${HOME}/.zshrc"
  LINE="export PATH=\"${BIN_DIR}:\$PATH\"  # mxc-bootstrap"
  if [[ -f "${PROFILE}" ]] && grep -qF "# mxc-bootstrap" "${PROFILE}"; then
    echo "${BIN_DIR} already configured in ${PROFILE}."
  else
    echo "${LINE}" >> "${PROFILE}"
    PATH_CHANGED=1
    echo "${C_GREEN}Added ${BIN_DIR} to PATH in ${PROFILE}.${C_RESET}"
  fi
fi

# 4. Repo-agnostic health check.
echo
hdr "health check"
set +e
node "${MCP_DIR}/selftest.mjs"
HEALTH_RC=$?
set -e
if [[ "${HEALTH_RC}" -ne 0 ]]; then
  echo
  echo "${C_CYAN}To enable sandbox execution on this host:${C_RESET}"
  case "$(uname -s)" in
    Linux)  echo "  • Install bubblewrap, e.g.  sudo apt install bubblewrap   (or your distro's package).";;
    Darwin) echo "  • macOS ships the seatbelt backend (/usr/bin/sandbox-exec); ensure it's present.";;
    *)      echo "  • Install an OS containment backend supported by MXC, then re-run: mxc-bootstrap selftest";;
  esac
  echo "  Then re-run: ${C_CYAN}mxc-bootstrap selftest${C_RESET}"
fi

# 5. Optional global registration now (otherwise onboard repos with `mxc-bootstrap init`).
if [[ -n "${REGISTER}" ]]; then
  echo
  hdr "registration"
  node "${INSTALL_DIR}/configure.mjs" --install "${INSTALL_DIR}" --repo "${INSTALL_DIR}" --register "${REGISTER}"
fi

echo
echo "${C_GREEN}Machine setup done.${C_RESET}"
if [[ "${PATH_CHANGED}" -eq 1 ]]; then
  echo "${C_CYAN}IMPORTANT:${C_RESET} PATH was updated. Open a NEW shell before using 'mxc-bootstrap'"
  echo "           (or in this shell: node \"${INSTALL_DIR}/cli.mjs\" <cmd>)."
fi
echo "Next: cd into a repo and run ${C_CYAN}mxc-bootstrap init${C_RESET}"
