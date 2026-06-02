// Builds the sandbox policy. The broker (server.mjs) owns this logic so the agent
// cannot widen its own access: writable paths are derived from a TRUSTED root, never
// from anything the model supplies.
//
// Trust anchor: the repo root is taken from MXC_REPO_ROOT (pinned at registration) or,
// failing that, from the SERVER's launch directory (process.cwd(), which the harness sets
// when it spawns this stdio server) — NOT from the agent-supplied cwd. The agent's cwd is
// only ever validated to live inside that trusted root.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Default policy schema version. This selects the Windows containment backend:
//   "0.6.0-alpha" -> BaseContainer (needs the BaseContainer velocity keys enabled)
//   "0.4.0-alpha" -> AppContainer  (needs bfscfg.exe / BFS support in the Windows build)
// Override with MXC_SCHEMA_VERSION to match what the host actually supports.
export const SCHEMA_VERSION = process.env.MXC_SCHEMA_VERSION?.trim() || "0.6.0-alpha";

/** Drive/filesystem roots that should be readable. On Windows this is the repo's drive
 *  plus the system drive (so tooling under C:\Windows, C:\Program Files, the user profile,
 *  etc. keeps working even when the repo lives on another drive). */
export function readableRoots(fromDir = process.cwd()) {
  if (process.platform !== "win32") return ["/"];
  const roots = new Set();
  const repoDrive = path.parse(path.resolve(fromDir)).root;
  if (repoDrive) roots.add(repoDrive);
  const sys = process.env.SystemDrive ? `${process.env.SystemDrive}\\` : "C:\\";
  roots.add(sys);
  return [...roots];
}

/**
 * A per-repo scoped scratch dir so tools that need TEMP keep working without sharing a
 * single global writable path across unrelated agents/repos. Refuses a symlink/reparse
 * point at that location (confused-deputy guard).
 */
export function scopedTempDir(repoRoot, label = "mxc-scratch") {
  let real;
  try {
    real = fs.realpathSync(repoRoot);
  } catch {
    real = path.resolve(repoRoot);
  }
  const hash = crypto.createHash("sha1").update(real).digest("hex").slice(0, 12);
  const base = path.join(os.tmpdir(), label);
  const dir = path.join(base, hash);
  fs.mkdirSync(base, { recursive: true });
  if (fs.existsSync(dir)) {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`scoped temp path '${dir}' is not a real directory`);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolve the trusted repo root.
 *  1. MXC_REPO_ROOT env (pinned at registration) wins.
 *  2. else `git rev-parse --show-toplevel` from the server's trusted launch dir.
 *  3. else that launch dir itself.
 *
 * NOTE: `baseDir` is the SERVER's launch directory (process.cwd()), set by the harness —
 * it is intentionally NOT the agent-supplied cwd.
 */
export function resolveRepoRoot(baseDir = process.cwd()) {
  const pinned = process.env.MXC_REPO_ROOT;
  if (pinned && pinned.trim()) return path.resolve(pinned.trim());

  const start = path.resolve(baseDir);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return path.resolve(top);
  } catch {
    /* not a git repo / git missing — fall through */
  }
  return start;
}

/**
 * Validate that a requested cwd lives inside the trusted root.
 * Prevents the agent from pointing the sandbox at an unrelated directory.
 */
export function assertInsideRoot(repoRoot, requestedCwd) {
  if (!requestedCwd) return repoRoot;
  const resolved = path.resolve(repoRoot, requestedCwd);
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, resolved);
  const escapes = rel.startsWith("..") || path.isAbsolute(rel);
  if (escapes) {
    throw new Error(`cwd '${requestedCwd}' is outside the trusted repo root '${root}'`);
  }
  return resolved;
}

/**
 * The default "read anywhere, write repo only" policy.
 * - readwritePaths: repo root + scoped temp (+ any pre-approved extras)
 * - readonlyPaths : whole filesystem root (so reads are broad) unless scope=repo
 * - network       : default-deny unless explicitly allowed by the broker
 */
export function buildPolicy({
  repoRoot,
  readScope = process.env.MXC_READ_SCOPE || "drive",
  allowOutbound = false,
  allowedHosts = [],
  extraWritePaths = [],
  extraReadPaths = [],
  timeoutMs = 0,
}) {
  const temp = scopedTempDir(repoRoot);
  const readonlyPaths = [...extraReadPaths];
  if (readScope === "drive") {
    readonlyPaths.push(...readableRoots(repoRoot));
  } else {
    readonlyPaths.push(repoRoot);
  }

  return {
    version: SCHEMA_VERSION,
    filesystem: {
      readwritePaths: [repoRoot, temp, ...extraWritePaths],
      readonlyPaths,
    },
    network: allowOutbound
      ? { allowOutbound: true, allowedHosts }
      : { allowOutbound: false },
    timeoutMs,
  };
}
