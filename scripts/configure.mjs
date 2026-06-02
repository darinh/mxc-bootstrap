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
import readline from "node:readline";

// Minimal ANSI coloring; disabled when not a TTY or when NO_COLOR is set.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const cyan = (s) => c("36", s);
const dim = (s) => c("2", s);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--install") out.install = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--register") out.register = argv[++i];
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--agent-id") out.agentId = argv[++i];
    else if (a === "--name") out.name = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const installDir = path.resolve(args.install || path.join(os.homedir(), ".mxc"));
const repoDir = path.resolve(args.repo || process.cwd());
// MCP clients accept forward slashes on every OS; avoids JSON backslash escaping headaches.
const serverPath = path.join(installDir, "mcp", "server.mjs").split(path.sep).join("/");

// The MCP server key. Pinned-identity brokers use a distinct key so several can coexist.
const SERVER_NAME = args.name || "mxc-sandbox";

// Identity is normally resolved by the broker from ~/.mxc/repos.json. A pinned registration can
// instead bake the identity into the launch env (the agent can't alter it — like a service account).
const ENV = {};
if (args.profile) ENV.MXC_PROFILE = args.profile;
if (args.agentId) ENV.MXC_AGENT_ID = args.agentId;

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
  const e = { command: "node", args: [serverPath] };
  if (Object.keys(ENV).length) e.env = { ...ENV };
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
  cfg.mcpServers[SERVER_NAME] = entry({ includeType });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return { file, bak };
}

// ---- TOML append (codex) ---------------------------------------------------
function mergeToml(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = backup(file);
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const header = `[mcp_servers.${SERVER_NAME}]`;
  if (content.includes(header)) {
    return { file, bak, skipped: "already present — left unchanged" };
  }
  const envInline = Object.entries(ENV)
    .map(([k, v]) => `${k} = "${v}"`)
    .join(", ");
  let block =
    `\n${header}\n` +
    `command = "node"\n` +
    `args = ["${serverPath}"]\n`;
  if (envInline) block += `env = { ${envInline} }\n`;
  fs.writeFileSync(file, content + block);
  return { file, bak };
}

// ---- claude: prefer the CLI, else fall back to ~/.claude.json --------------
function registerClaude() {
  try {
    const envArgs = Object.entries(ENV).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    execFileSync(
      "claude",
      ["mcp", "add", SERVER_NAME, ...envArgs, "--", "node", serverPath],
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

// ---- harness menu ----------------------------------------------------------
const HARNESSES = [
  { key: "copilot", label: "GitHub Copilot CLI" },
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "OpenAI Codex CLI" },
  { key: "cursor", label: "Cursor / Windsurf / VS Code" },
];

function parseRegisterArg(s) {
  if (!s) return [];
  const parts = s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (parts.includes("all")) return HARNESSES.map((h) => h.key);
  return parts;
}

function registerMany(keys) {
  for (const key of keys) {
    try {
      const res = register(key);
      console.log(`  ${green("\u2713")} registered ${bold(key)} ${dim(JSON.stringify(res))}`);
    } catch (err) {
      console.error(`  ${red("\u2717")} failed to register ${bold(key)}: ${red(err?.message || err)}`);
    }
  }
  console.log(dim("Restart the agent/CLI to pick up the new MCP server."));
}

function promptMenu() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("\n" + bold(cyan("Register the MXC sandbox with which agent(s)?")));
    HARNESSES.forEach((h, i) => console.log(`  ${bold(cyan(String(i + 1)))}) ${h.label}`));
    console.log(`  ${bold(cyan(String(HARNESSES.length + 1)))}) All of the above`);
    console.log(`  ${bold(cyan("0"))}) Skip (just show snippet locations)`);
    rl.question(`Enter choice(s), e.g. ${cyan('"1 3"')} ${dim("[0]")}: `, (ans) => {
      rl.close();
      const tokens = (ans || "").trim().split(/[\s,]+/).filter(Boolean);
      if (!tokens.length || tokens.includes("0")) return resolve([]);
      const keys = new Set();
      for (const t of tokens) {
        const n = Number(t);
        if (n === HARNESSES.length + 1) HARNESSES.forEach((h) => keys.add(h.key));
        else if (n >= 1 && n <= HARNESSES.length) keys.add(HARNESSES[n - 1].key);
      }
      resolve([...keys]);
    });
  });
}

// ---- run -------------------------------------------------------------------
const regDir = renderSnippets();
console.log(`Resolved registration snippets written to: ${cyan(regDir)}`);
console.log(`MCP server path: ${cyan(serverPath)}`);

let toRegister = parseRegisterArg(args.register);
// No --register flag and an interactive terminal -> show the menu.
if (!args.register && process.stdin.isTTY) {
  toRegister = await promptMenu();
}

if (toRegister.length) {
  registerMany(toRegister);
} else {
  console.log("\n" + bold("Nothing registered.") + " To wire it up later:");
  console.log(dim(`  • copy the matching file from ${regDir} into your agent's MCP config, or`));
  console.log(dim(`  • re-run setup and pick from the menu (or pass --register <copilot|claude|codex|cursor|all>), or`));
  console.log(dim(`  • Claude Code: claude mcp add mxc-sandbox -- node ${serverPath}`));
}
