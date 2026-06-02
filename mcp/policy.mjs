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
import { fileURLToPath } from "node:url";
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

/** Convert an MCP root URI (file://...) — or a plain path — to a filesystem path. */
export function pathFromRootUri(uri) {
  if (!uri) return null;
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : path.resolve(uri);
  } catch {
    return null;
  }
}

/** True if `target` is `root` or lives underneath it. */
export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Choose the active trusted repo root for a single tool call. This is what makes one shared
 * install safely serve MANY agents on MANY repos at once:
 *   1. MXC_REPO_ROOT (pinned) always wins.
 *   2. else the MCP roots the CLIENT advertised for this session — pick the one containing the
 *      requested cwd (or the first). These come from the harness, not the model, so they're trusted.
 *   3. else fall back to the server's launch dir via git (resolveRepoRoot).
 * Each agent's server process gets its own client roots, so they never cross-contaminate.
 */
export function selectActiveRoot({ trustedRoots, requestedCwd, baseDir = process.cwd() }) {
  const pinned = process.env.MXC_REPO_ROOT;
  if (pinned && pinned.trim()) return path.resolve(pinned.trim());

  const candidates =
    trustedRoots && trustedRoots.length
      ? trustedRoots.map((r) => path.resolve(r))
      : [resolveRepoRoot(baseDir)];

  if (requestedCwd && path.isAbsolute(requestedCwd)) {
    const match = candidates.find((c) => isInside(c, requestedCwd));
    if (match) return match;
  }
  return candidates[0];
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

// ----------------------------------------------------------------------------
// Profiles = identities. A profile is a named policy template. The trusted broker
// resolves which profile applies (from pinned env or the repo registry) and turns it
// into a concrete SandboxPolicy for the active repo. The agent never picks its own profile.
// ----------------------------------------------------------------------------

/** The built-in fallback profile, identical to default.json (used if the profiles dir is missing). */
export function builtinDefaultProfile() {
  return normalizeProfile(
    {
      name: "default",
      description: "Read anywhere; write only inside the repo. No network.",
      write: "repo",
      readScope: "drive",
      network: { allow: false, hosts: [] },
    },
    "default"
  );
}

function normalizeProfile(p, fallbackName) {
  return {
    name: p.name || fallbackName,
    description: p.description || "",
    write: p.write || "repo", // "repo" | "none"
    extraWritePaths: Array.isArray(p.extraWritePaths) ? p.extraWritePaths : [],
    readScope: p.readScope || "drive", // "drive" | "repo"
    extraReadPaths: Array.isArray(p.extraReadPaths) ? p.extraReadPaths : [],
    network: {
      allow: Boolean(p.network && p.network.allow),
      hosts: (p.network && Array.isArray(p.network.hosts) ? p.network.hosts : []),
    },
  };
}

const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Load and normalize a profile by name from a profiles directory. Throws if not found. */
export function loadProfile(name, profilesDir) {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(`invalid profile name '${name}'`);
  }
  const dir = path.resolve(profilesDir);
  const file = path.join(dir, `${name}.json`);
  // Defense in depth: the resolved file must stay directly inside the profiles dir.
  if (path.dirname(path.resolve(file)) !== dir) {
    throw new Error(`profile path escapes profiles dir: '${name}'`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return normalizeProfile(raw, name);
}

/** List available profiles (name + description) in a directory. */
export function listProfiles(profilesDir) {
  let names = [];
  try {
    names = fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((f) => {
      try {
        return loadProfile(f.replace(/\.json$/, ""), profilesDir);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function dedupe(arr) {
  return [...new Set(arr.map((p) => path.resolve(p)))];
}

/**
 * Create `dir` (recursively) and verify that, after resolving any symlinks/junctions/reparse
 * points, it still lives inside `root`. Guards against a repo containing e.g. `.worktrees`
 * pointing outside the repo (which would escape the sandbox's intended write scope).
 */
function ensureWritableInside(root, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const realDir = fs.realpathSync(dir);
  const rel = path.relative(realRoot, realDir);
  if (rel === "" || rel === ".") return realDir; // dir === root
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`write path '${dir}' resolves outside the repo root '${root}'`);
  }
  return realDir;
}

/**
 * Turn a resolved profile into a concrete SandboxPolicy for `repoRoot`.
 * Writable paths are derived from the profile + trusted repo root only.
 * `MXC_FORCE_NO_NETWORK=1` is a machine-level kill switch that can only restrict.
 */
export function buildPolicyFromProfile({ repoRoot, profile, requestOutbound, requestedHosts = [] }) {
  const root = fs.realpathSync(path.resolve(repoRoot));
  const temp = scopedTempDir(root);

  const writePaths = [];
  if (profile.write === "repo") writePaths.push(root);
  for (const rel of profile.extraWritePaths) {
    const abs = assertInsideRoot(root, rel); // lexical check: must be under repo
    writePaths.push(ensureWritableInside(root, abs)); // + realpath check after mkdir
  }
  writePaths.push(temp);

  const readonlyPaths = profile.extraReadPaths.map((r) => path.resolve(root, r));
  if (profile.readScope === "drive") readonlyPaths.push(...readableRoots(root));
  else readonlyPaths.push(root);

  const forceOff = process.env.MXC_FORCE_NO_NETWORK === "1";
  // A network-capable profile grants outbound unless the agent explicitly suppresses it.
  const allowOutbound = !forceOff && profile.network.allow && requestOutbound !== false;

  // Host semantics: ["*"] (or empty) = unrestricted; a concrete list caps the agent via
  // intersection (the agent can never broaden the profile's allowlist).
  const unrestricted = profile.network.hosts.length === 0 || profile.network.hosts.includes("*");
  let hosts = [];
  if (allowOutbound) {
    if (unrestricted) {
      hosts = requestedHosts; // agent may narrow; empty = any host
    } else {
      hosts = requestedHosts.length
        ? requestedHosts.filter((h) => profile.network.hosts.includes(h))
        : profile.network.hosts;
    }
  }

  return {
    version: SCHEMA_VERSION,
    filesystem: { readwritePaths: dedupe(writePaths), readonlyPaths: dedupe(readonlyPaths) },
    network: allowOutbound ? { allowOutbound: true, allowedHosts: hosts } : { allowOutbound: false },
    timeoutMs: 0,
  };
}

// ----------------------------------------------------------------------------
// Repo registry: central repoRoot -> { profile, agentId } map written by `mxc-bootstrap init`.
// Lives in the install dir (outside any agent's write scope) so an agent can't rebind itself.
// ----------------------------------------------------------------------------

export function repoRegistryPath(installDir) {
  return path.join(installDir, "repos.json");
}

/**
 * The trusted config dir (~/.mxc) must never be writable by a sandboxed agent, otherwise the
 * agent could rewrite repos.json/profiles and escalate its own identity. Reject onboarding (or
 * brokering for) a repo whose root contains — or is contained by — the install dir.
 */
export function assertConfigOutsideRoot(repoRoot, installDir) {
  const root = path.resolve(repoRoot);
  const inst = path.resolve(installDir);
  const a = path.relative(root, inst); // inst relative to root
  const instInsideRoot = a === "" || (!a.startsWith("..") && !path.isAbsolute(a));
  const b = path.relative(inst, root); // root relative to inst
  const rootInsideInst = b === "" || (!b.startsWith("..") && !path.isAbsolute(b));
  if (instInsideRoot || rootInsideInst) {
    throw new Error(
      `refusing: the mxc-bootstrap config dir '${inst}' overlaps the repo root '${root}'. ` +
        `Onboard a repo that does not contain ~/.mxc.`
    );
  }
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export function loadRepoBinding(repoRoot, installDir) {
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(repoRegistryPath(installDir), "utf8"));
  } catch {
    return null;
  }
  return reg[realpathSafe(repoRoot)] || reg[path.resolve(repoRoot)] || null;
}

export function setRepoBinding(repoRoot, binding, installDir) {
  const file = repoRegistryPath(installDir);
  let reg = {};
  try {
    reg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* new registry */
  }
  reg[realpathSafe(repoRoot)] = binding;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reg, null, 2) + "\n");
  return file;
}

/**
 * Resolve the active identity for a repo. Precedence:
 *   1. MXC_PROFILE env (explicit pinned identity).
 *   2. repo registry binding.
 *   3. MXC_DEFAULT_PROFILE env or "default".
 */
export function resolveIdentity(repoRoot, installDir) {
  if (process.env.MXC_PROFILE) {
    return { profileName: process.env.MXC_PROFILE, agentId: process.env.MXC_AGENT_ID || "pinned", source: "env" };
  }
  const binding = loadRepoBinding(repoRoot, installDir);
  if (binding && binding.profile) {
    return { profileName: binding.profile, agentId: binding.agentId || "repo", source: "registry" };
  }
  return { profileName: process.env.MXC_DEFAULT_PROFILE || "default", agentId: "default", source: "default" };
}
