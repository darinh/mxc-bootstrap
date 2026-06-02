// Health check: verify the SDK loads, report platform support, list available identity profiles,
// and probe whether this host can actually EXECUTE the sandbox. Repo-agnostic — the execution
// probe runs in a throwaway temp dir, so it never reports a real repo as writable.
//
// On Windows there are two selectable containment backends; this check tries each, and if one
// works it PERSISTS that choice to ~/.mxc/config.json so the MCP server uses it automatically.
//
// Exit code is always 0 when the server itself is healthy. A host with no working backend is a
// known capability limitation (not an install error) and is reported as such, with guidance.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPolicyFromProfile,
  builtinDefaultProfile,
  listProfiles,
  candidateSchemaVersions,
  saveInstallConfig,
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
const note = (m) => console.log(`  ${cyan("[info]")} ${m}`);
const info = (m) => console.log(dim(`  ${m}`));

// MXC backend errors append a JSON blob after a human sentence; keep just the sentence.
function cleanReason(stderr) {
  if (!stderr) return "";
  const text = stderr.split("{")[0].trim();
  return text || stderr.trim();
}

// Map a raw backend failure to a short, human cause (no internal IDs / stack noise).
function diagnose(reason) {
  if (/velocity keys/i.test(reason)) return "BaseContainer backend is not enabled on this Windows build";
  if (/bfscfg\.exe/i.test(reason)) return "AppContainer backend needs bfscfg.exe, which is absent from this Windows build";
  return reason;
}

// Profiles live at <install>/profiles after machine setup, or config/profiles in this repo.
const HERE = path.dirname(fileURLToPath(import.meta.url));
function findProfilesDir() {
  const candidates = [
    process.env.MXC_PROFILES_DIR,
    path.resolve(HERE, "..", "profiles"),
    path.resolve(HERE, "..", "config", "profiles"),
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(d)) || null;
}

console.log(bold(cyan("MXC sandbox health check")));

// 1. SDK + platform
const support = platformSupport();
ok(`SDK loaded on ${process.platform}`);
if (support.isSupported) {
  ok(`MXC available — backends: ${(support.availableMethods || []).join(", ") || "(none)"}`);
} else {
  note(`MXC backend not available on this host: ${support.reason || "unknown"}`);
}

// 2. Identity profiles
const profilesDir = findProfilesDir();
if (profilesDir) {
  const profiles = listProfiles(profilesDir);
  ok(`identity profiles: ${profiles.map((p) => p.name).join(", ") || "(none)"}`);
} else {
  note("no profiles dir found — broker will fall back to the builtin 'default' identity");
}

// 3. Policy builds correctly, using a disposable temp dir as a stand-in "repo".
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mxc-selftest-"));
const baseProfile = builtinDefaultProfile();
const policy = buildPolicyFromProfile({ repoRoot: probeRoot, profile: baseProfile });
ok("policy builds from the 'default' identity (read-anywhere, write-repo-only)");

function cleanup() {
  try {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function done(line) {
  cleanup();
  console.log("\n" + line);
  process.exit(0);
}

if (!support.isSupported) {
  done(green(bold("HEALTH CHECK OK")) + " — server is installed and healthy. (Sandbox execution backend unavailable on this host.)");
}

// 4. Execution probe — try each candidate backend; persist the first that works.
const cmd = process.platform === "win32" ? "cmd /c echo hello-from-sandbox" : "echo hello-from-sandbox";
const candidates = candidateSchemaVersions();
const attempts = [];
let working = null;

for (const version of candidates) {
  const res = await runSandboxed({ command: cmd, cwd: probeRoot, policy: { ...policy, version } });
  if (res.exitCode === 0) {
    working = { version, backend: res.backend };
    break;
  }
  attempts.push({ version, reason: diagnose(cleanReason(res.stderr)) });
}

console.log("");
if (working) {
  saveInstallConfig({ schemaVersion: working.version });
  ok(`sandbox execution works (backend: ${working.backend}, schema ${working.version})`);
  if (candidates.length > 1 && working.version !== candidates[0]) {
    info(`auto-selected and saved this backend to config.json so the server uses it.`);
  }
  done(green(bold("HEALTH CHECK OK")) + " — server healthy and sandbox execution works.");
}

// No backend could execute. This is a host capability limitation, not an install problem.
note("sandbox execution is not available on this host yet");
for (const a of attempts) {
  info(`• schema ${a.version}: ${a.reason}`);
}
console.log("");
console.log(dim("Your install is complete and the MCP server runs fine — it just can't execute the"));
console.log(dim("sandbox until the OS provides a containment backend. On Windows you need ONE of:"));
console.log(dim("  • BaseContainer — a Windows build with the BaseContainer feature enabled"));
console.log(dim("    (Windows 11 24H2+ / an Insider or provisioned host). Not user-toggleable on"));
console.log(dim("    a stock build."));
console.log(dim("  • AppContainer — a Windows build that ships bfscfg.exe (BFS support)."));
console.log(dim("No reinstall needed: once a backend is present, the server starts using it"));
console.log(dim("automatically (re-run this check to confirm and persist the choice)."));
done(yellow(bold("HEALTH CHECK: install OK, execution unavailable on this host")) + dim(" — see guidance above."));
