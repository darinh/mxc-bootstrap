# mxc-bootstrap

Bootstrap a dev box so that **AI coding agents** can run commands inside a **policy-restricted
[MXC](https://github.com/microsoft/mxc) sandbox** instead of directly on the host.

It ships a small, **harness-agnostic MCP server** that exposes a `run_in_sandbox` tool. Because it
speaks the [Model Context Protocol](https://modelcontextprotocol.io), the **same server works with
any MCP client** — GitHub Copilot CLI, Claude Code, OpenAI Codex CLI, Cursor, Windsurf, VS Code, etc.

> ⚠️ MXC is an early preview and is **not yet a hardened security boundary**. Treat this as
> defense-in-depth, not a jail.

## Two-phase experience

1. **Machine setup (once per box).** Download the repo and run one command. It deploys a runtime to
   `~/.mxc`, puts a `mxc-bootstrap` command on your PATH, and runs a health check. It does **not**
   touch any of your repos.
2. **Repo onboarding (per repo).** `cd` into a project and run `mxc-bootstrap init`. You pick an
   **identity** for that repo, and it records the binding + registers the broker with your agent.

```text
# phase 1 — machine setup
./scripts/setup.ps1            # Windows
./scripts/setup.sh             # Linux / macOS

# open a NEW terminal (setup adds mxc-bootstrap to your PATH), then:

# phase 2 — onboard a repo
cd ~/work/api
mxc-bootstrap init
```

Prerequisites: **Node.js >= 18**. On Linux you also need `bwrap` (bubblewrap) or `lxc`; on macOS
`/usr/bin/sandbox-exec` (built in). On Windows, full isolation needs Windows 11 24H2+.

## Identities (profiles)

An **identity** is a named policy template stored in `~/.mxc/profiles/*.json`. The trusted broker —
not the agent — decides which identity applies and enforces it. Starters:

| Profile | Writes | Reads | Network | Use for |
|---------|--------|-------|---------|---------|
| `default` | the repo (+ scoped temp) | whole drive | off | normal coding agents |
| `readonly` | nothing (scoped temp only) | whole drive | off | review / analysis agents |
| `worktree-only` | only `<repo>/.worktrees` | whole drive | off | agents that build in git worktrees without touching the main tree |
| `network` | the repo | whole drive | outbound | agents that need to fetch (npm, pip, git clone) |

List them any time:

```text
mxc-bootstrap profiles
```

Add your own by dropping a JSON file in `~/.mxc/profiles/`. Shape:

```json
{
  "name": "my-id",
  "description": "what this identity can do",
  "write": "repo",            // "repo" = write the repo, "none" = write nothing
  "extraWritePaths": [".out"], // extra writable subdirs (resolved INSIDE the repo)
  "readScope": "drive",        // "drive" = read the readable drive roots, "repo" = repo only
  "extraReadPaths": [],
  "network": { "allow": false, "hosts": ["*"] }  // ["*"] = any host; or a concrete allowlist
}
```

### How identity is assigned (and why the agent can't forge it)

The agent is untrusted and **cannot assert its own identity**. The broker resolves it per call, in
this order:

1. **`MXC_PROFILE`** in the broker's launch env — a *pinned* identity set by the harness registration
   (the agent can't alter its own launch env, like a service account / `runas`).
2. **The repo registry** `~/.mxc/repos.json` — the binding written by `mxc-bootstrap init`, keyed by
   the canonical repo path.
3. **`default`**.

The active **repo root** itself comes only from trusted sources (MCP roots advertised by the client,
`MXC_REPO_ROOT`, or the server's launch dir) — never from anything the model supplies. Profiles and
`repos.json` live in `~/.mxc`, **outside any agent's write scope**, so a sandboxed command can't
rewrite its own identity.

## Multiple agents & repos on one box

A **single** install in `~/.mxc` serves many agents in different repos at once.

- Each harness spawns its own stdio broker per session, so concurrent agents are isolated.
- The writable root is chosen per call from the most trustworthy source (MCP roots / `MXC_REPO_ROOT`
  / launch dir), and the scoped temp dir is **hashed per repo** so agents never clobber each other.
- Give two agents **different identities on the same repo** by registering a dedicated broker for
  each with a pinned `MXC_PROFILE` (e.g. a `readonly` reviewer alongside a `default` coder):

  ```text
  mxc-bootstrap register copilot          # plain broker (uses repos.json binding)
  # or a pinned identity broker, registered under its own MCP server key:
  node ~/.mxc/configure.mjs --install ~/.mxc --repo ~/.mxc \
    --name mxc-readonly --profile readonly --agent-id reviewer --register claude
  ```

`mxc-bootstrap status` shows the install dir, available profiles, every onboarded repo, and the
identity that resolves for your current directory.

## `mxc-bootstrap` commands

| Command | What it does |
|---------|--------------|
| `init` | Onboard the current repo: pick identity + agent, write the binding, register the broker. Flags: `--profile <name> --agent-id <id> --register <copilot\|all\|…>`. |
| `status` | Show install dir, profiles, onboarded repos, and this repo's resolved identity. |
| `profiles` | List available identities and what they permit. |
| `register [harness…]` | Register a global broker with agents (no repo binding). No args = menu. |
| `selftest` | Repo-agnostic health check (alias `doctor`). |
| `enable-backend` | (Windows) Enable the BaseContainer backend via ViVeTool. `-Disable` reverts. |
| `path` | Print the MCP server path (for manual config). |
| `server` | Run the MCP server on stdio (agents do this for you). |

Everything is also available headless (flags) for automation; running with no flags in a terminal
gives you menus so you never have to memorize options.

## Registering with different agents

`init` / `register` write the config for you and back up any existing file first. The resolved
manual snippets (with the real install path filled in) are also written to `~/.mxc/registration/`.

| Agent | Config location | Format | Snippet |
|-------|-----------------|--------|---------|
| **GitHub Copilot CLI** | `~/.copilot/mcp-config.json` | JSON `mcpServers` | `examples/copilot-cli.mcp-config.json` |
| **Claude Code** | `claude mcp add` or project `.mcp.json` | JSON `mcpServers` | `examples/claude-code.mcp.json` |
| **OpenAI Codex CLI** | `~/.codex/config.toml` | TOML `[mcp_servers.*]` | `examples/codex.config.toml` |
| **Cursor / Windsurf / VS Code** | `.cursor/mcp.json` (or app settings) | JSON `mcpServers` | `examples/cursor.mcp.json` |

### Make the agent prefer the sandbox

The tool is opt-in. Add to your `AGENTS.md` / `CLAUDE.md` / system prompt:

> Run generated code and shell/git commands through the `run_in_sandbox` tool, not directly.

## Tools exposed

| Tool | Args | Purpose |
|------|------|---------|
| `run_in_sandbox` | `command` (req), `cwd?`, `allowOutbound?`, `allowedHosts?`, `dryRun?` | Run a command under the active identity's policy |
| `platform_support` | — | Report whether MXC is available and which backends |

Each `run_in_sandbox` result echoes the resolved `identity` (`profile`, `agentId`, `source`),
`repoRoot`, `rootSource`, and the concrete `policy`, so you can confirm exactly what was enforced.

## Configuration (env, set in the MCP `env` block)

Day-to-day you pick behavior via **profiles**, not env vars. These remain for pinning and overrides:

| Env var | Meaning |
|---------|---------|
| `MXC_PROFILE` | Pin the identity for this broker (highest precedence). The agent can't change it. |
| `MXC_AGENT_ID` | Label surfaced in results for a pinned broker. |
| `MXC_REPO_ROOT` | Pin the trusted writable repo root. If unset, taken from MCP roots or the server's launch dir — never the agent. |
| `MXC_PROFILES_DIR` | Override the profiles directory (default `~/.mxc/profiles`). |
| `MXC_FORCE_NO_NETWORK` | `1` is a machine-level kill switch: forces network off even for a `network` profile. |
| `MXC_SCHEMA_VERSION` | Policy schema / Windows backend selector. `0.6.0-alpha` (default) = BaseContainer; `0.4.0-alpha` = AppContainer. |
| `MXC_TIMEOUT_MS` | Max sandbox runtime before the broker kills the command. Default `600000` (10 min); `0` = no limit. |
| `MXC_MAX_OUTPUT` | Max captured bytes per stream before output is truncated. Default `5000000`. |

## Security caveats

This is **defense-in-depth**, not a jail. Known, intentional limitations:

- **`write: "repo"` includes `.git/`.** A sandboxed command can modify `.git/hooks`, `.git/config`,
  or lifecycle scripts (npm `postinstall`, etc.), which can execute **outside** MXC the next time a
  human or unsandboxed tool runs git/build. Run follow-up commands through the sandbox too, or use a
  `worktree-only` / `readonly` identity. Pick the least-privileged profile that still works.
- **Identity integrity depends on `~/.mxc` staying out of write scope.** `mxc-bootstrap init` refuses
  to onboard a repo that contains (or is contained by) `~/.mxc`, and the broker re-checks this per
  call, so an agent can't rewrite `repos.json` / profiles to escalate.
- **Extra write paths are realpath-checked.** A repo can't escape via a `.worktrees` symlink/junction
  that points outside the repo — the resolved target must stay inside the repo root.
- **`readScope: "drive"` is broad read access.** Combined with a `network` identity it's an
  exfiltration surface. Prefer `readScope: "repo"` and keep network off unless a task needs it.
- **Windows reads** cover the repo drive + system drive, not arbitrary other drives.

## Host requirements & backends

`run_in_sandbox` needs an OS-level containment backend. The MCP server itself always loads; the
machine-setup **health check probes whether this host can execute the sandbox**, and on Windows it
tries each candidate backend and **persists the first that works** to `~/.mxc/config.json` (so the
server uses it automatically — no env var needed).

| OS | Backend | Requirement |
|----|---------|-------------|
| Windows | BaseContainer (`0.6.0-alpha`) | The BaseContainer feature enabled (Windows 11 24H2+). Run `mxc-bootstrap enable-backend` to turn it on via ViVeTool (admin + reboot) |
| Windows | AppContainer (`0.4.0-alpha`) | A Windows build that ships `bfscfg.exe` (BFS support) |
| Linux | bubblewrap | `bwrap` installed (or `lxc`) |
| macOS | seatbelt | `/usr/bin/sandbox-exec` (built in); runs with the experimental flag |

If **no** backend works, the health check says so plainly and explains why — your install is still
complete. On Windows, machine setup offers to enable the BaseContainer backend for you (or run
`mxc-bootstrap enable-backend` later); this installs [ViVeTool](https://github.com/thebookisclosed/ViVe)
via winget, flips the BaseContainer feature flags, and prompts for a reboot (reversible with
`mxc-bootstrap enable-backend -Disable`). After rebooting, run `mxc-bootstrap selftest` to confirm and
persist the choice. You can also force a specific schema with `MXC_SCHEMA_VERSION`.

## License

MIT
