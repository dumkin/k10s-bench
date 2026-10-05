// Small helpers shared by the benchmark: paths, processes, waiting, statistics.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/** The benchmark's repository. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Everything the benchmark creates outside the repository: clusters, downloaded apps, app profiles.
 * It must be under the home folder: Docker VMs (colima, Docker Desktop) only share that with containers.
 */
export const WORK = process.env.K10S_BENCH_DIR ?? join(homedir(), ".k10s-bench");
export const REAL_HOME = homedir();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Wall-clock milliseconds: the clock the probe (probe.swift) stamps its samples with. Node's monotonic clock
 * (performance.now) drifts from it by up to milliseconds a minute, which over an hour of runs would shift every
 * time measured against the probe.
 */
export const now = () => Date.now();

export function dir(...parts) {
  const path = join(...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

export const exists = (path) => existsSync(path);

/** Runs a command and resolves to its stdout; rejects with its stderr. */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 512 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} ${args.join(" ")}: ${(stderr || err.message).toString().trim()}`;
        reject(err);
      } else resolve(stdout.toString());
    });
  });
}

/** Runs a command with its output shown (long steps: builds, downloads). */
export function runVisible(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`))));
  });
}

export async function which(cmd) {
  try {
    return (await run("/usr/bin/which", [cmd])).trim();
  } catch {
    return null;
  }
}

/** Polls `check` until it returns something truthy; resolves to that value, or to null after `timeout` ms. */
export async function waitFor(check, { timeout = 60_000, every = 100 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) return null;
    await sleep(every);
  }
}

export function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

const t0 = Date.now();
export function log(...args) {
  const s = ((Date.now() - t0) / 1000).toFixed(0).padStart(5);
  console.log(`${s}s`, ...args);
}

/**
 * Asks the person running the benchmark to do something by hand and waits for Enter. Without a terminal
 * (the benchmark started by a script), it waits for the file ~/.k10s-bench/continue to appear instead.
 */
export async function askToContinue(text) {
  console.log(`\n${text}`);
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter when done… ");
    rl.close();
    return;
  }
  const flag = join(WORK, "continue");
  console.log(`Waiting for ${flag}…`);
  await waitFor(() => existsSync(flag), { timeout: 24 * 3_600_000, every: 500 });
  rmSync(flag, { force: true });
}

export const MB = (bytes) => bytes / 1e6;
