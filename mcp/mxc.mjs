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

/**
 * Run `command` inside an MXC sandbox described by `policy`.
 * Returns { exitCode, stdout, stderr, backend, timedOut }.
 */
export function runSandboxed({ command, cwd, policy, experimental = false, dryRun = false }) {
  // The abstract "process" intent resolves per-OS:
  //   Windows -> processcontainer, Linux -> bubblewrap, macOS -> seatbelt.
  const config = createConfigFromPolicy(policy, "process");
  config.process.commandLine = command;
  if (cwd) config.process.cwd = cwd;

  // macOS seatbelt is experimental and requires the experimental flag.
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
