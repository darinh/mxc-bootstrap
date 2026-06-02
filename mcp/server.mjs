// MCP server exposing a policy-restricted MXC sandbox. Harness-agnostic: works with any MCP
// client (Copilot CLI, Claude Code, Codex, Cursor, ...).
//
// Tools:
//   run_in_sandbox   - run a command with write access limited to the trusted repo root
//   platform_support - report MXC availability + backends on this host
//
// Security model: the BROKER decides the policy. The agent may request a command, an optional
// cwd (validated to be inside the trusted root), and (if permitted) outbound network — it can
// never hand us arbitrary writable paths.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { selectActiveRoot, assertInsideRoot, buildPolicy, pathFromRootUri } from "./policy.mjs";
import { runSandboxed, platformSupport } from "./mxc.mjs";

const NETWORK_ALLOWED = process.env.MXC_ALLOW_NETWORK === "1";
// Optional server-side host allowlist. When set, agent-requested hosts are intersected with
// this list (and an empty agent request defaults to it) — the agent can never broaden it.
const SERVER_ALLOWED_HOSTS = (process.env.MXC_ALLOWED_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const server = new Server(
  { name: "mxc-sandbox", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// The client may advertise its workspace directories ("roots"). We use them as the trusted
// repo root so ONE shared install scopes correctly for each agent/repo. Cached per process
// (each agent gets its own server process) and invalidated when the client says they changed.
let cachedRoots = null;
server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
  cachedRoots = null;
});

async function getTrustedRoots() {
  const caps = server.getClientCapabilities?.();
  if (!caps?.roots) return null;
  if (cachedRoots) return cachedRoots;
  try {
    const res = await server.listRoots();
    const roots = (res?.roots || []).map((r) => pathFromRootUri(r.uri)).filter(Boolean);
    cachedRoots = roots.length ? roots : null;
    return cachedRoots;
  } catch {
    return null;
  }
}

const TOOLS = [
  {
    name: "run_in_sandbox",
    description:
      "Run a shell command inside an MXC sandbox. The command can READ broadly but can only " +
      "WRITE inside the agent's repository root (plus a scoped temp dir). Use this instead of " +
      "running commands directly when executing generated code, builds, tests, or git operations.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute (e.g. \"npm test\")." },
        cwd: {
          type: "string",
          description:
            "Working directory. Must be inside the repo root. Defaults to the repo root.",
        },
        allowOutbound: {
          type: "boolean",
          description:
            "Request outbound network. Only honored if the server was started with MXC_ALLOW_NETWORK=1.",
        },
        allowedHosts: {
          type: "array",
          items: { type: "string" },
          description: "Optional host allowlist when outbound network is permitted.",
        },
        dryRun: {
          type: "boolean",
          description: "If true, validate and resolve the policy without executing.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "platform_support",
    description:
      "Report whether MXC is available on this host and which containment backends are usable.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function textResult(obj, isError = false) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }], isError };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === "platform_support") {
      return textResult({ networkAllowedByServer: NETWORK_ALLOWED, support: platformSupport() });
    }

    if (name === "run_in_sandbox") {
      const command = String(args.command || "").trim();
      if (!command) return textResult("Error: 'command' is required.", true);

      const trustedRoots = await getTrustedRoots();
      const repoRoot = selectActiveRoot({ trustedRoots, requestedCwd: args.cwd });
      const cwd = assertInsideRoot(repoRoot, args.cwd);

      const rootSource = process.env.MXC_REPO_ROOT
        ? "env"
        : trustedRoots
        ? "mcp-roots"
        : "launch-cwd";

      const wantsNetwork = Boolean(args.allowOutbound);
      const allowOutbound = NETWORK_ALLOWED && wantsNetwork;

      const requestedHosts = Array.isArray(args.allowedHosts) ? args.allowedHosts : [];
      let allowedHosts = requestedHosts;
      if (SERVER_ALLOWED_HOSTS.length) {
        // Broker caps the hosts: intersect, or fall back to the server list if agent gave none.
        allowedHosts = requestedHosts.length
          ? requestedHosts.filter((h) => SERVER_ALLOWED_HOSTS.includes(h))
          : SERVER_ALLOWED_HOSTS;
      }

      const policy = buildPolicy({
        repoRoot,
        allowOutbound,
        allowedHosts,
      });

      const dryRun = Boolean(args.dryRun);
      const result = await runSandboxed({ command, cwd, policy, dryRun });

      return textResult(
        {
          repoRoot,
          rootSource,
          trustedRoots: trustedRoots || undefined,
          cwd,
          backend: result.backend,
          networkRequested: wantsNetwork,
          networkGranted: allowOutbound,
          dryRun,
          policy,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        result.exitCode !== 0 && !dryRun
      );
    }

    return textResult(`Error: unknown tool '${name}'.`, true);
  } catch (err) {
    return textResult(`Error: ${err?.message || err}`, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stdio servers must not write to stdout; log to stderr only.
console.error("[mxc-sandbox] MCP server ready on stdio.");
