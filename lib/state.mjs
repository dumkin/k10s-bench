// The same saved state at every launch. Each client's profile (its home folder: settings, caches, window) is
// snapshotted once per scenario, after a warm-up start and with the benchmark's settings applied again, and put back
// before every counted run, so that nothing one run changes (a dock left open, a page size, a sort) reaches the next,
// while the caches a warmed-up app relies on stay. Snapshots are APFS clones: instant, and no copy of the data.
//
// A fingerprint of the settings each driver declares proves it: it is recorded per run, before and after.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { WORK, dir, exists, run } from "./util.mjs";
import { profileDir } from "./clients/common.mjs";

const snapshots = (key) => dir(WORK, "state", key);

export async function snapshot(key, label) {
  const to = join(snapshots(key), label);
  rmSync(to, { recursive: true, force: true });
  await run("cp", ["-cR", profileDir(key), to]);
}

export const hasSnapshot = (key, label) => exists(join(WORK, "state", key, label));

/** Deletes every snapshot: each session makes its own. */
export function clearSnapshots() {
  rmSync(join(WORK, "state"), { recursive: true, force: true });
}

/** Puts a snapshot back as the client's profile (the app must not be running). */
export async function restore(key, label) {
  const profile = profileDir(key);
  rmSync(profile, { recursive: true, force: true });
  await run("cp", ["-cR", join(snapshots(key), label), profile]);
}

/** JSON with its keys sorted, so that the same settings always read the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function contentOf(file) {
  if (file.endsWith(".json")) {
    try {
      return canonical(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return readFileSync(file, "utf8");
    }
  }
  // WebKit's localStorage: its rows, not the database file, which SQLite rewrites as it likes.
  if (file.endsWith(".sqlite3")) return run("sqlite3", ["-readonly", file, "select key, hex(value) from ItemTable order by key"]).catch(() => "");
  return readFileSync(file).toString("base64");
}

/** The files under `root` whose path relative to it matches one of `patterns` (regular expressions). */
function matching(root, patterns) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        // Caches and logs change at every start and say nothing about settings.
        if (!/(^|\/)(Cache|Caches|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Logs|logs|Crashpad|blob_storage|Service Worker)$/.test(rel)) walk(path);
      } else if (patterns.some((p) => p.test(rel))) out.push(path);
    }
  };
  if (exists(root)) walk(root);
  return out.sort();
}

/**
 * A short hash of a client's declared settings (`client.stateFiles`: patterns of paths in its profile), and one per
 * file, so that a changed run says what changed. The run's kubeconfig (new certificates every run) is never part.
 */
export async function fingerprint(client) {
  if (!client.stateFiles?.length) return null;
  const root = profileDir(client.key);
  const parts = {};
  for (const file of matching(root, client.stateFiles)) {
    parts[relative(root, file)] = createHash("sha1").update(await contentOf(file)).digest("hex").slice(0, 10);
  }
  const hash = createHash("sha1").update(canonical(parts)).digest("hex").slice(0, 10);
  return { hash, parts };
}

/** Which settings files differ between two fingerprints. */
export function changed(before, after) {
  if (!before || !after) return [];
  const files = new Set([...Object.keys(before.parts), ...Object.keys(after.parts)]);
  return [...files].filter((f) => before.parts[f] !== after.parts[f]).sort();
}
