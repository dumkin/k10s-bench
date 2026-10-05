// Runs probe.swift against an app and keeps its samples: memory (sum of phys_footprint over the app's
// processes), CPU time (cumulative, over every process the app ever had), wakeups and windows.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT, WORK, dir, exists, run } from "./util.mjs";

const SOURCE = join(ROOT, "lib/probe.swift");
const BINARY = join(WORK, "bin/probe");

/** Compiles the probe when it is missing or older than its source. */
export async function buildProbe() {
  if (exists(BINARY) && statSync(BINARY).mtimeMs > statSync(SOURCE).mtimeMs) return BINARY;
  dir(WORK, "bin");
  await run("swiftc", ["-O", SOURCE, "-o", BINARY]);
  return BINARY;
}

let screen = null;
/** The main screen, in points: {frame: [w, h], visible: [x, yTop, w, h], scale, screens}. */
export async function screenGeometry() {
  screen ??= JSON.parse(await run(await buildProbe(), ["--screen"]));
  return screen;
}

/**
 * The window every desktop client gets: k10s's default size, 1440×900 points, as far as the screen's usable area
 * allows, centered in it. {width, height, x, y} in points; `scale` turns them into pixels.
 */
export async function targetWindow() {
  const g = await screenGeometry();
  const [vx, vy, vw, vh] = g.visible;
  const width = Math.min(1440, vw);
  const height = Math.min(900, vh);
  return { width, height, x: vx + Math.floor((vw - width) / 2), y: vy + Math.floor((vh - height) / 2), scale: g.scale, frame: g.frame };
}

export class Probe {
  constructor(pid, { interval = 100, extra } = {}) {
    this.pid = pid;
    this.samples = [];
    this.firstWindowAt = null;
    this.windowSize = null;
    this.extra = extra; // called on every sample: adds e.g. the proxies' byte counters
    this.pids = new Set(); // every process the app had: whose window is in front is checked against these
    this.windowLog = []; // [t, [[w, h], …]] whenever the probe looked (every second once a window showed)
    this.lastCpu = new Map();
    this.cpuTotal = 0;
    this.wakeTotal = 0;
    this.lastWake = new Map();
    this.child = spawn(BINARY, [String(pid), String(interval)], { stdio: ["ignore", "pipe", "inherit"] });
    this.done = new Promise((resolve) => this.child.on("exit", resolve));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
  }

  onLine(line) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    let mem = 0;
    // CPU time only grows: count each process's growth since the previous sample, and all of the time of a
    // process seen for the first time (it started since). A process that exits keeps what it had used.
    for (const [pid, , footprint, cpu, wakeups] of d.procs) {
      this.pids.add(pid);
      mem += footprint;
      const prev = this.lastCpu.get(pid);
      this.cpuTotal += prev == null ? cpu : Math.max(0, cpu - prev);
      this.lastCpu.set(pid, cpu);
      const prevWake = this.lastWake.get(pid);
      this.wakeTotal += prevWake == null ? wakeups : Math.max(0, wakeups - prevWake);
      this.lastWake.set(pid, wakeups);
    }
    if (d.windows) this.windowLog.push([d.t, d.windows]);
    if (d.windows?.length) {
      this.firstWindowAt ??= d.t;
      // The app's main window: the biggest it showed (some show a small splash window first).
      for (const w of d.windows) if (!this.windowSize || w[0] * w[1] > this.windowSize[0] * this.windowSize[1]) this.windowSize = w;
    }
    const sample = { t: d.t, mem, cpu: this.cpuTotal, wake: this.wakeTotal, procs: d.procs.length, ...(this.extra?.() ?? {}) };
    this.samples.push(sample);
    this.lastProcs = d.procs;
  }

  /** The last sample at or before `t`. */
  at(t) {
    let lo = 0;
    let hi = this.samples.length - 1;
    if (hi < 0 || this.samples[0].t > t) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.samples[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return this.samples[lo];
  }

  between(from, to) {
    return this.samples.filter((s) => s.t >= from && s.t <= to);
  }

  /** The windows the app showed at `t` (the last look at or before it). */
  windowsAt(t) {
    let found = null;
    for (const [at, windows] of this.windowLog) {
      if (at > t) break;
      found = windows;
    }
    return found;
  }

  /** Average CPU use between two moments, in % of one core. */
  cpuPercent(from, to) {
    const a = this.at(from);
    const b = this.at(to);
    if (!a || !b || b.t <= a.t) return null;
    return ((b.cpu - a.cpu) / 1e6 / (b.t - a.t)) * 100;
  }

  wakeupsPerSecond(from, to) {
    const a = this.at(from);
    const b = this.at(to);
    if (!a || !b || b.t <= a.t) return null;
    return ((b.wake - a.wake) / (b.t - a.t)) * 1000;
  }

  /** Memory in the window: the median and the highest sample, in bytes. */
  memory(from, to) {
    const v = this.between(from, to).map((s) => s.mem).sort((x, y) => x - y);
    if (!v.length) return null;
    return { median: v[v.length >> 1], max: v[v.length - 1] };
  }

  /** The highest memory reading so far. */
  peak() {
    return this.samples.reduce((m, s) => Math.max(m, s.mem), 0);
  }

  /** The processes of the last sample, for the raw results: what each one used. */
  breakdown() {
    return (this.lastProcs ?? []).map(([pid, name, footprint]) => ({ pid, name, mb: Math.round(footprint / 1e5) / 10 })).sort((a, b) => b.mb - a.mb);
  }

  stop() {
    this.child.kill();
    return this.done;
  }
}
