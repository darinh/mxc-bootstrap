// Thin wrapper around @microsoft/mxc-sdk. Translates a SandboxPolicy + command into a
// sandboxed child process and collects its output, with broker-side timeout and output
// caps so a runaway command can't hang or OOM the MCP server.

import {
  createConfigFromPolicy,
  spawnSandboxFromConfig,
  getPlatformSupport,
} from "@microsoft/mxc-sdk";

const TIMEOUT_MS = Number(process.env.MXC_TIMEOUT_MS ?? 600000); // 10 min default; 0 = no limit
const MAX_OUTPUT_BYTES = Number(process.env.MXC_MAX_OUTPUT ?? 5_000_000); // ~5 MB per stream

export function platformSupport() {
  return getPlatformSupport();
}

// Bounded sink: appends until the cap, then drops and flags truncation.
function makeSink(cap) {
  let buf = "";
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const s = chunk.toString();
      if (bytes + s.length > cap) {
        buf += s.slice(0, Math.max(0, cap - bytes));
        truncated = true;
      } else {
        buf += s;
        bytes += s.length;
      }
    },
    get value() {
      return truncated ? buf + "\n…[output truncated]" : buf;
    },
  };
}

// The Windows Sandbox VM backend ("windows_sandbox") is a concrete, experimental backend that the
// SDK's `createConfigFromPolicy` does not build (it only knows the abstract "process" intent and a
// few Linux/macOS backends). The native binary, however, accepts a hand-built config forwarded by
// `spawnSandboxFromConfig`. Isolation for this backend is the VM boundary + guest firewall, so the
// filesystem/network policy sections are intentionally omitted (the runner ignores them).
function buildWindowsSandboxConfig({ policy, command, cwd }) {
  const config = {
    version: policy.version,
    containment: "windows_sandbox",
    lifecycle: { destroyOnExit: true },
    process: { commandLine: command, timeout: policy.timeoutMs ?? 0 },
  };
  if (cwd) config.process.cwd = cwd;
  return config;
}

/**
 * Run `command` inside an MXC sandbox described by `policy`.
 * Returns { exitCode, stdout, stderr, backend, timedOut }.
 */
export function runSandboxed({
  command,
  cwd,
  policy,
  containment = "process",
  experimental = false,
  dryRun = false,
}) {
  // `containment` is the SDK intent/backend. The abstract "process" intent resolves per-OS:
  //   Windows -> processcontainer (BaseContainer), Linux -> bubblewrap, macOS -> seatbelt.
  // A concrete backend (e.g. "windows_sandbox") overrides that resolution.
  let config;
  if (containment === "windows_sandbox") {
    config = buildWindowsSandboxConfig({ policy, command, cwd });
  } else {
    config = createConfigFromPolicy(policy, containment);
    config.process.commandLine = command;
    if (cwd) config.process.cwd = cwd;
  }

  // Some backends require the experimental spawn flag (macOS seatbelt; Windows Sandbox VM).
  const needExperimental = experimental || process.platform === "darwin";

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnSandboxFromConfig(
        config,
        { usePty: false, experimental: needExperimental, dryRun },
        cwd
      );
    } catch (err) {
      resolve({ exitCode: -1, stdout: "", stderr: String(err?.message || err), backend: config.containment, timedOut: false });
      return;
    }

    const out = makeSink(MAX_OUTPUT_BYTES);
    const errSink = makeSink(MAX_OUTPUT_BYTES);
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const timer = TIMEOUT_MS > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
          finish({ exitCode: -1, stdout: out.value, stderr: errSink.value, backend: config.containment, timedOut: true });
        }, TIMEOUT_MS)
      : null;

    child.stdout?.on("data", (d) => out.push(d));
    child.stderr?.on("data", (d) => errSink.push(d));
    child.on("error", (err) => {
      errSink.push(String(err?.message || err));
      finish({ exitCode: -1, stdout: out.value, stderr: errSink.value, backend: config.containment, timedOut });
    });
    child.on("close", (code) =>
      finish({ exitCode: code ?? -1, stdout: out.value, stderr: errSink.value, backend: config.containment, timedOut })
    );
  });
}
