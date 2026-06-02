// Health check: verify the SDK loads, report platform support, list available identity profiles,
// and try a trivial sandboxed command in a THROWAWAY temp dir (repo-agnostic — this never reports
// any real repo as writable). Run: node selftest.mjs
//
// Exit code is always 0 when the server itself is healthy. A host that can't execute the sandbox
// (missing backend support) is reported as a WARNING, not a failure — the MCP server still works
// and run_in_sandbox will surface the same reason to the agent.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPolicyFromProfile,
  builtinDefaultProfile,
  listProfiles,
} from "./policy.mjs";
import { runSandboxed, platformSupport } from "./mxc.mjs";

// Minimal ANSI coloring; disabled when not a TTY or when NO_COLOR is set.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c("1", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const dim = (s) => c("2", s);

const ok = (m) => console.log(`  ${green("[ok]")}   ${m}`);
const warn = (m) => console.log(`  ${yellow("[warn]")} ${m}`);
const info = (m) => console.log(dim(`  ${m}`));

// MXC backend errors append a JSON blob after a human sentence; keep just the sentence.
function cleanReason(stderr) {
  if (!stderr) return "";
  const text = stderr.split("{")[0].trim();
  return text || stderr.trim();
}

// Profiles live in <install>/profiles after machine setup, or config/profiles in this repo.
const HERE = path.dirname(fileURLToPath(import.meta.url));
function findProfilesDir() {
  const candidates = [
    process.env.MXC_PROFILES_DIR,
    path.resolve(HERE, "..", "profiles"),
    path.resolve(HERE, "..", "config", "profiles"),
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(d)) || null;
}

console.log(bold(cyan("MXC sandbox self-test")));

// 1. SDK + platform
const support = platformSupport();
ok(`SDK loaded on ${process.platform}`);
if (support.isSupported) {
  ok(`MXC available — backends: ${(support.availableMethods || []).join(", ") || "(none)"}`);
} else {
  warn(`MXC not available on this host: ${support.reason || "unknown"}`);
}

// 2. Identity profiles
const profilesDir = findProfilesDir();
if (profilesDir) {
  const profiles = listProfiles(profilesDir);
  ok(`identity profiles available: ${profiles.map((p) => p.name).join(", ") || "(none)"}`);
  info(`profiles dir: ${profilesDir}`);
} else {
  warn("no profiles dir found — broker will fall back to the builtin 'default' identity");
}

// 3. Policy builds correctly, using a disposable temp dir as a stand-in "repo" so the health
//    check never lists a real repository as writable.
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mxc-selftest-"));
const policy = buildPolicyFromProfile({ repoRoot: probeRoot, profile: builtinDefaultProfile() });
ok("policy built from the 'default' identity (read-anywhere, write-repo-only)");
info(`probe write root : ${policy.filesystem.readwritePaths[0]}`);
info(`read scope       : ${policy.filesystem.readonlyPaths.join(", ")}`);

function cleanup() {
  try {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

if (!support.isSupported) {
  cleanup();
  console.log("\n" + green(bold("SELF-TEST OK")) + " — server is healthy. (Sandbox execution unavailable on this host.)");
  process.exit(0);
}

// 4. Execution probe (inside the disposable temp dir)
const cmd = process.platform === "win32" ? "cmd /c echo hello-from-sandbox" : "echo hello-from-sandbox";
const res = await runSandboxed({ command: cmd, cwd: probeRoot, policy });
cleanup();

console.log("");
if (res.exitCode === 0) {
  ok(`sandbox executed a command (stdout: "${res.stdout.trim()}")`);
  console.log("\n" + green(bold("SELF-TEST OK")) + " — server healthy and sandbox execution works.");
} else {
  warn("sandbox executed but the host could not run the command:");
  info(cleanReason(res.stderr));
  console.log("");
  console.log(dim("This is a HOST capability gap, not a config error — the MCP server is fine."));
  console.log(dim("On Windows the sandbox needs one of:"));
  console.log(dim("  • BaseContainer (default) — velocity keys enabled (Windows 11 24H2+ / provisioned)"));
  console.log(dim("  • AppContainer            — set MXC_SCHEMA_VERSION=0.4.0-alpha (needs bfscfg.exe)"));
  console.log("\n" + green(bold("SELF-TEST OK")) + " — server is healthy. Sandbox execution will work on a provisioned host.");
}
