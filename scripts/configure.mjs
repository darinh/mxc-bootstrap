// configure.mjs — render resolved registration snippets and optionally register with a harness.
//
// Usage:
//   node configure.mjs --install <installDir> --repo <repoDir> [--register <harness>]
//
// Harnesses: copilot | claude | codex | cursor
//
// Always: writes resolved snippets (with the real install path) to <installDir>/registration/.
// With --register: merges the server into that harness's config (backs up existing files first).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install") out.install = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--register") out.register = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const installDir = path.resolve(args.install || path.join(os.homedir(), ".mxc"));
const repoDir = path.resolve(args.repo || process.cwd());
// MCP clients accept forward slashes on every OS; avoids JSON backslash escaping headaches.
const serverPath = path.join(installDir, "mcp", "server.mjs").split(path.sep).join("/");

const ENV = { MXC_ALLOW_NETWORK: "0", MXC_READ_SCOPE: "drive" };

function backup(file) {
  if (fs.existsSync(file)) {
    const bak = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, bak);
    return bak;
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function entry({ includeType = false } = {}) {
  const e = { command: "node", args: [serverPath], env: { ...ENV } };
  if (includeType) return { type: "local", ...e };
  return e;
}

// ---- render resolved snippets ----------------------------------------------
function renderSnippets() {
  const regDir = path.join(installDir, "registration");
  fs.mkdirSync(regDir, { recursive: true });
  const examplesDir = path.join(repoDir, "examples");
  if (!fs.existsSync(examplesDir)) return regDir;
  for (const name of fs.readdirSync(examplesDir)) {
    const src = fs.readFileSync(path.join(examplesDir, name), "utf8");
    const resolved = src.split("<INSTALL_DIR>").join(installDir.split(path.sep).join("/"));
    fs.writeFileSync(path.join(regDir, name), resolved);
  }
  return regDir;
}

// ---- JSON mcpServers merge (copilot, cursor, claude fallback) ---------------
function mergeJson(file, { includeType = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = backup(file);
  const cfg = readJson(file);
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  cfg.mcpServers["mxc-sandbox"] = entry({ includeType });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { file, bak };
}

// ---- TOML append (codex) ---------------------------------------------------
function mergeToml(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = backup(file);
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (content.includes("[mcp_servers.mxc-sandbox]")) {
    return { file, bak, skipped: "already present — left unchanged" };
  }
  const block =
    `\n[mcp_servers.mxc-sandbox]\n` +
    `command = "node"\n` +
    `args = ["${serverPath}"]\n` +
    `env = { MXC_ALLOW_NETWORK = "0", MXC_READ_SCOPE = "drive" }\n`;
  fs.writeFileSync(file, content + block);
  return { file, bak };
}

// ---- claude: prefer the CLI, else fall back to ~/.claude.json --------------
function registerClaude() {
  try {
    execFileSync(
      "claude",
      [
        "mcp", "add", "mxc-sandbox",
        "-e", "MXC_ALLOW_NETWORK=0",
        "-e", "MXC_READ_SCOPE=drive",
        "--", "node", serverPath,
      ],
      { stdio: "ignore" }
    );
    return { via: "claude mcp add" };
  } catch {
    const file = path.join(os.homedir(), ".claude.json");
    return { via: "~/.claude.json", ...mergeJson(file) };
  }
}

function register(harness) {
  switch (harness) {
    case "copilot":
      return mergeJson(path.join(os.homedir(), ".copilot", "mcp-config.json"), { includeType: true });
    case "cursor":
      return mergeJson(path.join(os.homedir(), ".cursor", "mcp.json"));
    case "codex":
      return mergeToml(path.join(os.homedir(), ".codex", "config.toml"));
    case "claude":
      return registerClaude();
    default:
      throw new Error(`unknown harness '${harness}' (use copilot|claude|codex|cursor)`);
  }
}

// ---- run -------------------------------------------------------------------
const regDir = renderSnippets();
console.log(`Resolved registration snippets written to: ${regDir}`);
console.log(`MCP server path: ${serverPath}`);

if (args.register) {
  const res = register(args.register);
  console.log(`Registered with '${args.register}':`, JSON.stringify(res));
  console.log("Restart the agent/CLI to pick up the new MCP server.");
} else {
  console.log("\nNo --register given. To wire it up, either:");
  console.log(`  • copy the matching file from ${regDir} into your agent's MCP config, or`);
  console.log(`  • re-run setup with --register <copilot|claude|codex|cursor>, or`);
  console.log(`  • Claude Code: claude mcp add mxc-sandbox -- node ${serverPath}`);
}
