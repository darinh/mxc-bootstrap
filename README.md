# mxc-bootstrap

Bootstrap a dev box so that **AI coding agents** can run commands inside a **policy-restricted
[MXC](https://github.com/microsoft/mxc) sandbox** instead of directly on the host.

It ships a small, **harness-agnostic MCP server** that exposes a `run_in_sandbox` tool. Because it
speaks the [Model Context Protocol](https://modelcontextprotocol.io), the **same server works with
any MCP client** — GitHub Copilot CLI, Claude Code, OpenAI Codex CLI, Cursor, Windsurf, VS Code,
etc. Only the one-time *registration* differs per harness (snippets provided).

> ⚠️ MXC is an early preview and is **not yet a hardened security boundary**. Treat this as
> defense-in-depth, not a jail.

## What you get

- **Read-anywhere, write-repo-only** default policy: a sandboxed command can read broadly but can
  only write inside the agent's repository root (plus a scoped temp dir).
- **Trusted policy brokering**: the writable repo root is pinned at registration or derived via
  `git rev-parse` inside the server — never taken on faith from the model.
- **Cross-platform**: uses the `@microsoft/mxc-sdk` npm package, which bundles the correct native
  binary per OS (`wxc-exec.exe` on Windows, `lxc-exec` on Linux, `mxc-exec-mac` on macOS).

## Architecture

```
Any MCP agent ──run_in_sandbox(command)──► MCP server (this repo) ──► @microsoft/mxc-sdk
 (Copilot CLI,                                  │                          │
  Claude Code,                          builds the policy           wxc-exec / lxc-exec / mxc-exec-mac
  Codex, Cursor…)                       (write = repo only)         → OS sandbox enforces it
```

## Install

The repo is the **source**; `setup` deploys a runtime into `~/.mxc` and prints/installs the
registration snippet for your agent(s).

### Windows (PowerShell)

```powershell
./scripts/setup.ps1                      # deploy + smoke test, print snippets
./scripts/setup.ps1 -Register copilot    # also merge into ~/.copilot/mcp-config.json (backs up)
```

### Linux / macOS (bash)

```bash
./scripts/setup.sh                       # deploy + smoke test, print snippets
./scripts/setup.sh --register copilot    # also merge into ~/.copilot/mcp-config.json (backs up)
```

Prerequisites: **Node.js >= 18**. On Linux you also need `bwrap` (bubblewrap) or `lxc`; on macOS
`/usr/bin/sandbox-exec` (built in). On Windows, full isolation needs Windows 11 24H2+.

## Registering with different agents

After `setup`, the resolved snippets (with the real install path filled in) are written to
`~/.mxc/registration/`. Pick your harness:

| Agent | Config location | Format | Snippet |
|-------|-----------------|--------|---------|
| **GitHub Copilot CLI** | `~/.copilot/mcp-config.json` | JSON `mcpServers` | `examples/copilot-cli.mcp-config.json` |
| **Claude Code** | `claude mcp add` or project `.mcp.json` | JSON `mcpServers` | `examples/claude-code.mcp.json` |
| **OpenAI Codex CLI** | `~/.codex/config.toml` | TOML `[mcp_servers.*]` | `examples/codex.config.toml` |
| **Cursor / Windsurf / VS Code** | `.cursor/mcp.json` (or app settings) | JSON `mcpServers` | `examples/cursor.mcp.json` |

Most agents share the same JSON `mcpServers` shape (`command` / `args` / `env`); Codex uses TOML.

Quick adds:

```bash
# Claude Code
claude mcp add mxc-sandbox -- node ~/.mxc/mcp/server.mjs

# Copilot CLI: run /mcp inside the CLI and add a local server:
#   command: node    args: ~/.mxc/mcp/server.mjs
```

### Make the agent prefer the sandbox

The tool is opt-in. Add to your `AGENTS.md` / `CLAUDE.md` / system prompt:

> Run generated code and shell/git commands through the `run_in_sandbox` tool, not directly.

## Tools exposed

| Tool | Args | Purpose |
|------|------|---------|
| `run_in_sandbox` | `command` (req), `cwd?`, `allowOutbound?`, `allowedHosts?`, `dryRun?` | Run a command under the write-repo-only policy |
| `platform_support` | — | Report whether MXC is available and which backends |

## Configuration (env, set in the MCP `env` block)

| Env var | Meaning |
|---------|---------|
| `MXC_REPO_ROOT` | Pin the writable repo root (most trusted). If unset, derived via `git rev-parse` from the **server's launch directory** (set by the harness, not the agent). |
| `MXC_ALLOW_NETWORK` | `0` (default) forces network off regardless of tool args; `1` lets the tool *request* outbound. |
| `MXC_ALLOWED_HOSTS` | Comma-separated host allowlist enforced by the server. Agent-requested hosts are intersected with this; the agent can never broaden it. |
| `MXC_READ_SCOPE` | `drive` (default — read the readable drive roots, read-only) or `repo` (read only within repo). |
| `MXC_SCHEMA_VERSION` | Policy schema / Windows backend selector. `0.6.0-alpha` (default) = BaseContainer; `0.4.0-alpha` = AppContainer. Set to whichever your host supports. |
| `MXC_TIMEOUT_MS` | Max sandbox runtime before the broker kills the command. Default `600000` (10 min); `0` = no limit. |
| `MXC_MAX_OUTPUT` | Max captured bytes per stream before output is truncated. Default `5000000`. |

## Security caveats

This is **defense-in-depth**, not a jail. Known, intentional limitations:

- **Write-repo-only includes `.git/`.** A sandboxed command can modify `.git/hooks`, `.git/config`,
  or lifecycle scripts (npm `postinstall`, etc.). Those can execute **outside** MXC the next time a
  human or unsandboxed tool runs git/build commands. Run follow-up git/build commands through the
  sandbox too, and review hook/config changes if you didn't.
- **Trusted root.** The writable root comes from `MXC_REPO_ROOT` or the server's launch dir — not the
  agent. For adversarial agents, **pin `MXC_REPO_ROOT`** at registration for certainty.
- **Network = exfiltration surface.** With broad read access, enabling outbound (`MXC_ALLOW_NETWORK=1`)
  lets a compromised/prompt-injected agent exfiltrate. Keep it off, or constrain `MXC_ALLOWED_HOSTS`.
- **Windows reads** cover the repo drive + system drive, not arbitrary other drives.

## Host requirements & backends

`run_in_sandbox` needs an OS-level containment backend. The MCP server itself always loads; if the
host can't execute the sandbox, the tool reports why (and `platform_support` shows what's available).

| OS | Backend | Requirement |
|----|---------|-------------|
| Windows | BaseContainer (`0.6.0-alpha`) | BaseContainer velocity keys enabled (Windows 11 24H2+ / provisioned host) |
| Windows | AppContainer (`0.4.0-alpha`) | `bfscfg.exe` / BFS support present in the Windows build |
| Linux | bubblewrap | `bwrap` installed (or `lxc`) |
| macOS | seatbelt | `/usr/bin/sandbox-exec` (built in); runs with the experimental flag |

If the self-test reports the server is OK but execution fails (e.g. `E_NOTIMPL` / missing velocity
keys, or missing `bfscfg.exe`), switch backends with `MXC_SCHEMA_VERSION` or run on a host where one
backend is available.

## License

MIT
