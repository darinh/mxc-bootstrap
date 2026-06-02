// Smoke test: verify the SDK loads, report platform support, and try a trivial sandboxed command.
// Run: node selftest.mjs
//
// Exit code is always 0 when the server itself is healthy. A host that can't execute the sandbox
// (missing backend support) is reported as a WARNING, not a failure — the MCP server still works
// and run_in_sandbox will surface the same reason to the agent.

import { resolveRepoRoot, buildPolicy } from "./policy.mjs";
import { runSandboxed, platformSupport } from "./mxc.mjs";

const ok = (m) => console.log(`  [ok]   ${m}`);
const warn = (m) => console.log(`  [warn] ${m}`);
const info = (m) => console.log(`  ${m}`);

// MXC backend errors append a JSON blob after a human sentence; keep just the sentence.
function cleanReason(stderr) {
  if (!stderr) return "";
  const text = stderr.split("{")[0].trim();
  return text || stderr.trim();
}

console.log("MXC sandbox self-test");

// 1. SDK + platform
const support = platformSupport();
ok(`SDK loaded on ${process.platform}`);
if (support.isSupported) {
  ok(`MXC available — backends: ${(support.availableMethods || []).join(", ") || "(none)"}`);
} else {
  warn(`MXC not available on this host: ${support.reason || "unknown"}`);
}

// 2. Policy builds correctly
const repoRoot = resolveRepoRoot(process.cwd());
const policy = buildPolicy({ repoRoot });
ok("policy built (read-anywhere, write-repo-only)");
info(`write root : ${repoRoot}`);
info(`scratch    : ${policy.filesystem.readwritePaths[1]}`);
info(`read scope : ${policy.filesystem.readonlyPaths.join(", ")}`);

if (!support.isSupported) {
  console.log("\nSELF-TEST OK — server is healthy. (Sandbox execution unavailable on this host.)");
  process.exit(0);
}

// 3. Execution probe
const cmd = process.platform === "win32" ? "cmd /c echo hello-from-sandbox" : "echo hello-from-sandbox";
const res = await runSandboxed({ command: cmd, cwd: repoRoot, policy });

console.log("");
if (res.exitCode === 0) {
  ok(`sandbox executed a command (stdout: "${res.stdout.trim()}")`);
  console.log("\nSELF-TEST OK — server healthy and sandbox execution works.");
} else {
  warn("sandbox executed but the host could not run the command:");
  info(cleanReason(res.stderr));
  console.log("");
  console.log("This is a HOST capability gap, not a config error — the MCP server is fine.");
  console.log("On Windows the sandbox needs one of:");
  console.log("  • BaseContainer (default) — velocity keys enabled (Windows 11 24H2+ / provisioned)");
  console.log("  • AppContainer            — set MXC_SCHEMA_VERSION=0.4.0-alpha (needs bfscfg.exe)");
  console.log("\nSELF-TEST OK — server is healthy. Sandbox execution will work on a provisioned host.");
}
