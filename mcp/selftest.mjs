// Smoke test: verify the SDK loads, report platform support, and try a trivial sandboxed command.
// Run: node selftest.mjs

import { resolveRepoRoot, buildPolicy } from "./policy.mjs";
import { runSandboxed, platformSupport } from "./mxc.mjs";

function line() {
  console.log("-".repeat(60));
}

console.log("MXC sandbox self-test");
line();

const support = platformSupport();
console.log("platform:", process.platform);
console.log("MXC supported:", support.isSupported);
console.log("reason:", support.reason || "(none)");
console.log("backends:", (support.availableMethods || []).join(", ") || "(none)");
if (support.isolationTier) console.log("isolationTier:", support.isolationTier);
line();

const repoRoot = resolveRepoRoot(process.cwd());
const policy = buildPolicy({ repoRoot });
console.log("repoRoot:", repoRoot);
console.log("policy:", JSON.stringify(policy, null, 2));
line();

if (!support.isSupported) {
  console.log("MXC not available on this host — skipping execution test.");
  console.log("(The MCP server will still load; run_in_sandbox will report this.)");
  process.exit(0);
}

const cmd = process.platform === "win32"
  ? "cmd /c echo hello-from-sandbox"
  : "echo hello-from-sandbox";

console.log("Running dry-run...");
const dry = await runSandboxed({ command: cmd, cwd: repoRoot, policy, dryRun: true });
console.log("dry-run exitCode:", dry.exitCode, "backend:", dry.backend);
if (dry.stderr) console.log("dry-run stderr:", dry.stderr.trim());
line();

console.log("Running for real...");
const res = await runSandboxed({ command: cmd, cwd: repoRoot, policy });
console.log("exitCode:", res.exitCode, "backend:", res.backend);
console.log("stdout:", res.stdout.trim());
if (res.stderr) console.log("stderr:", res.stderr.trim());
line();
if (res.exitCode === 0) {
  console.log("SELF-TEST OK");
} else {
  console.log("SELF-TEST: server + policy OK, but the host could not execute the sandbox.");
  console.log("This is usually a host capability gap, not a config error. On Windows the");
  console.log("BaseContainer backend (schema 0.6.0-alpha) needs its velocity keys enabled, and");
  console.log("the AppContainer backend (schema 0.4.0-alpha) needs bfscfg.exe in the Windows build.");
  console.log("Try a different backend with MXC_SCHEMA_VERSION, or run on a provisioned host.");
}
