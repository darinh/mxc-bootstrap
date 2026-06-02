#!/usr/bin/env node
// mxc-bootstrap — manage the MXC sandbox runtime deployed in ~/.mxc and onboard repos.
//
// Deployed to <install>/cli.mjs and invoked via <install>/bin/mxc-bootstrap (or .cmd on Windows),
// so once <install>/bin is on PATH you can run it from any repo.
//
// Two-phase model:
//   • machine setup (scripts/setup.{ps1,sh}) deploys the runtime + profiles + this CLI.
//   • `mxc-bootstrap init` (run inside a repo) onboards that repo: pick an identity (profile)
//     + agent, write the ~/.mxc/repos.json binding, and ensure the agent's broker is registered.

import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  listProfiles,
  loadRepoBinding,
  setRepoBinding,
  repoRegistryPath,
  resolveIdentity,
  assertConfigOutsideRoot,
} from "./mcp/policy.mjs";

const MXC_HOME = path.dirname(fileURLToPath(import.meta.url)); // the install dir (~/.mxc)
const serverPath = path.join(MXC_HOME, "mcp", "server.mjs");
const profilesDir = process.env.MXC_PROFILES_DIR || path.join(MXC_HOME, "profiles");
const configureScript = path.join(MXC_HOME, "configure.mjs");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const dim = (s) => c("2", s);

const HARNESSES = [
  { key: "copilot", label: "GitHub Copilot CLI" },
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "OpenAI Codex CLI" },
  { key: "cursor", label: "Cursor / Windsurf / VS Code" },
];

function run(file, args) {
  return spawnSync(process.execPath, [file, ...args], { stdio: "inherit" }).status ?? 0;
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--agent-id") out.agentId = argv[++i];
    else if (a === "--register") out.register = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--yes" || a === "-y") out.yes = true;
    else out._.push(a);
  }
  return out;
}

// Resolve the repo root for the cwd: prefer the git toplevel, else cwd.
function detectRepoRoot(start) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (top) return path.resolve(top);
  } catch {
    /* not a git repo */
  }
  return path.resolve(start);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve((ans || "").trim());
    });
  });
}

function availableProfiles() {
  const profs = listProfiles(profilesDir);
  return profs.length ? profs : [{ name: "default", description: "(builtin) write repo, no network" }];
}

async function pickProfile(preset) {
  const profs = availableProfiles();
  if (preset) {
    if (!profs.some((p) => p.name === preset)) {
      console.error(yellow(`Warning: profile '${preset}' not found in ${profilesDir}.`));
    }
    return preset;
  }
  console.log("\n" + bold(cyan("Choose an identity (profile) for this repo:")));
  profs.forEach((p, i) =>
    console.log(`  ${bold(cyan(String(i + 1)))}) ${bold(p.name)} ${dim("— " + (p.description || ""))}`)
  );
  const ans = await ask(`Enter choice ${dim("[1]")}: `);
  const n = Number(ans || "1");
  const chosen = profs[n - 1] || profs[0];
  return chosen.name;
}

async function pickAgents(preset) {
  if (preset) {
    const parts = preset.split(/[\s,]+/).map((x) => x.toLowerCase()).filter(Boolean);
    if (parts.includes("all")) return HARNESSES.map((h) => h.key);
    if (parts.includes("none") || parts.includes("0")) return [];
    return parts;
  }
  console.log("\n" + bold(cyan("Register this repo's broker with which agent(s)?")));
  HARNESSES.forEach((h, i) => console.log(`  ${bold(cyan(String(i + 1)))}) ${h.label}`));
  console.log(`  ${bold(cyan(String(HARNESSES.length + 1)))}) All of the above`);
  console.log(`  ${bold(cyan("0"))}) Skip (binding only)`);
  const ans = await ask(`Enter choice(s), e.g. ${cyan('"1 3"')} ${dim("[0]")}: `);
  const tokens = ans.split(/[\s,]+/).filter(Boolean);
  if (!tokens.length || tokens.includes("0")) return [];
  const keys = new Set();
  for (const t of tokens) {
    const n = Number(t);
    if (n === HARNESSES.length + 1) HARNESSES.forEach((h) => keys.add(h.key));
    else if (n >= 1 && n <= HARNESSES.length) keys.add(HARNESSES[n - 1].key);
  }
  return [...keys];
}

// ---- commands ---------------------------------------------------------------

async function cmdInit(flags) {
  const start = flags.repo ? path.resolve(flags.repo) : process.cwd();
  const repoRoot = detectRepoRoot(start);

  try {
    assertConfigOutsideRoot(repoRoot, MXC_HOME);
  } catch (err) {
    console.error(c("31", err.message));
    process.exit(1);
  }

  console.log(`${bold(cyan("mxc-bootstrap init"))}`);
  console.log(`repo: ${cyan(repoRoot)}`);

  const profile = await pickProfile(flags.profile);
  const agentId = flags.agentId || path.basename(repoRoot);

  const file = setRepoBinding(repoRoot, { profile, agentId }, MXC_HOME);
  console.log(
    `\n${green("\u2713")} bound repo to identity ${bold(profile)} ${dim("(agentId=" + agentId + ")")}`
  );
  console.log(dim(`  registry: ${file}`));

  const agents = await pickAgents(flags.register);
  if (agents.length) {
    // ONE global broker per agent resolves identity from repos.json (no env pin needed).
    const args = ["--install", MXC_HOME, "--repo", MXC_HOME, "--register", agents.join(",")];
    run(configureScript, args);
  } else {
    console.log(
      "\n" + dim("No agent registered. The binding is saved; register later with: ") +
        cyan("mxc-bootstrap register")
    );
  }
  console.log("\n" + green(bold("Done.")) + dim(" Restart your agent to pick up changes."));
}

function cmdStatus() {
  console.log(`${bold(cyan("mxc-bootstrap status"))}`);
  console.log(`install dir : ${cyan(MXC_HOME)}`);
  console.log(`profiles    : ${cyan(profilesDir)}`);
  const profs = availableProfiles();
  console.log(`             ${dim(profs.map((p) => p.name).join(", "))}`);

  const regFile = repoRegistryPath(MXC_HOME);
  let reg = {};
  try {
    reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
  } catch {
    /* none yet */
  }
  const keys = Object.keys(reg);
  console.log(`\n${bold("Onboarded repos")} ${dim("(" + regFile + ")")}`);
  if (!keys.length) {
    console.log(dim("  (none yet — run `mxc-bootstrap init` inside a repo)"));
  } else {
    for (const k of keys) {
      console.log(`  ${green("•")} ${k}`);
      console.log(`      ${dim("profile=" + reg[k].profile + "  agentId=" + (reg[k].agentId || "-"))}`);
    }
  }

  // Identity for the current directory.
  const here = detectRepoRoot(process.cwd());
  const id = resolveIdentity(here, MXC_HOME);
  console.log(`\n${bold("This directory")}`);
  console.log(`  repo     : ${cyan(here)}`);
  console.log(`  identity : ${bold(id.profileName)} ${dim("(source=" + id.source + ", agentId=" + id.agentId + ")")}`);
}

function cmdProfiles() {
  console.log(`${bold(cyan("Available identities (profiles)"))} ${dim(profilesDir)}\n`);
  for (const p of availableProfiles()) {
    console.log(`  ${bold(p.name)}`);
    console.log(`    ${dim(p.description || "")}`);
    const w = p.write === "repo" ? "repo" : p.extraWritePaths?.length ? p.extraWritePaths.join(", ") : "none";
    const net = p.network?.allow ? (p.network.hosts?.length ? p.network.hosts.join(", ") : "any") : "off";
    console.log(`    ${dim("write=" + w + "  read=" + (p.readScope || "drive") + "  network=" + net)}`);
  }
}

function help() {
  console.log(`${bold(cyan("mxc-bootstrap"))} — MXC sandbox manager (installed at ${MXC_HOME})

${bold("Usage:")} mxc-bootstrap <command> [options]

${bold("Commands:")}
  ${cyan("init")}                    Onboard the current repo: pick identity + agent, write binding.
                            ${dim("--profile <name>  --agent-id <id>  --register <copilot|all|...>")}
  ${cyan("status")}                  Show install dir, profiles, onboarded repos, and this repo's identity.
  ${cyan("profiles")}                List available identities (profiles) and what they permit.
  ${cyan("register")} [harness...]   Register a global broker with agents (no repo binding).
                            ${dim("No args -> interactive menu. e.g. mxc-bootstrap register copilot")}
  ${cyan("enable-backend")}          (Windows) Enable the BaseContainer backend the sandbox needs.
  ${cyan("selftest")}                Run the repo-agnostic health check (alias: ${dim("doctor")}).
  ${cyan("path")}                    Print the MCP server path (for manual config).
  ${cyan("server")}                  Run the MCP server on stdio (agents do this for you).
  ${cyan("help")}                    Show this help.

${dim("Harnesses: copilot | claude | codex | cursor | all")}`);
}

// ---- dispatch ---------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (cmd) {
  case "init":
    await cmdInit(flags);
    break;
  case "status":
    cmdStatus();
    break;
  case "profiles":
    cmdProfiles();
    break;
  case "register": {
    const args = ["--install", MXC_HOME, "--repo", MXC_HOME];
    if (rest.length) args.push("--register", rest.join(","));
    process.exit(run(configureScript, args));
    break;
  }
  case "selftest":
  case "doctor":
    process.exit(run(path.join(MXC_HOME, "mcp", "selftest.mjs"), []));
    break;
  case "enable-backend": {
    if (process.platform !== "win32") {
      console.log(
        "enable-backend is Windows-only. On Linux install bubblewrap (e.g. `apt install bubblewrap`); " +
          "on macOS the seatbelt backend is built in."
      );
      process.exit(0);
    }
    const script = path.join(MXC_HOME, "enable-backend.ps1");
    const status = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...rest],
      { stdio: "inherit" }
    ).status ?? 0;
    process.exit(status);
    break;
  }
  case "server":
    process.exit(run(serverPath, rest));
    break;
  case "path":
    console.log(serverPath.split(path.sep).join("/"));
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`mxc-bootstrap: unknown command '${cmd}'. Try 'mxc-bootstrap help'.`);
    process.exit(1);
}
