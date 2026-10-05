// The Mac around the apps: what else used its CPU while a run was measured, whether it was hot, short of memory, on
// battery, asleep or locked, and whether the measured app was in front. A run disturbed by any of that is measured
// again (estimators.mjs noiseVerdict); the environment block records what the whole session ran on.

import { execFile, spawn } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { createInterface } from "node:readline";
import { buildProbe, screenGeometry } from "./probe.mjs";
import { ROOT, run, sleep } from "./util.mjs";

const THERMAL = ["nominal", "fair", "serious", "critical"];
const PRESSURE = { 1: "normal", 2: "warn", 4: "critical" };

/** CPU time as ps prints it ("173:30.19", "1:02:03.45", "2-01:02:03.45"), in ms; null if it isn't one. */
export function cpuTimeMs(text) {
  const m = String(text).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, days = 0, hours = 0, minutes, seconds] = m;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

/** The value at `t` of a series of [t, value] readings, between the two around it; null outside them. */
export function interpolate(series, t) {
  if (!series.length || t < series[0][0] || t > series.at(-1)[0]) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, v0] = series[lo];
  const [t1, v1] = series[hi];
  return t1 === t0 ? v0 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/** Watches the whole Mac for the session (probe --system), every 250 ms. */
export class SystemProbe {
  static async start(interval = 250) {
    const probe = new SystemProbe(await buildProbe(), interval);
    await probe.watchWindowServer();
    await new Promise((resolve) => {
      const check = setInterval(() => probe.samples.length >= 2 && (clearInterval(check), resolve()), 50);
    });
    return probe;
  }

  constructor(binary, interval) {
    this.samples = [];
    // WindowServer's CPU time, [t, ms], read with ps (setuid root) every second: the probe can't read a root process.
    this.ws = [];
    this.child = spawn(binary, ["--system", String(process.pid), String(interval)], { stdio: ["ignore", "pipe", "inherit"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.samples.push(JSON.parse(line));
      } catch {
        // a line cut short when the probe stops
      }
      // A night of runs at 4 a second: keep the last two hours.
      if (this.samples.length > 30_000) this.samples.splice(0, 1_000);
    });
  }

  at(t) {
    let lo = 0;
    let hi = this.samples.length - 1;
    if (hi < 0 || this.samples[0].t > t) return this.samples[0] ?? null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.samples[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return this.samples[lo];
  }

  async watchWindowServer() {
    const pid = (await run("pgrep", ["-x", "WindowServer"]).catch(() => "")).trim().split("\n")[0];
    if (!pid) return;
    const read = () =>
      execFile("ps", ["-o", "time=", "-p", pid], (error, out) => {
        const ms = error ? null : cpuTimeMs(out);
        if (ms == null) return;
        this.ws.push([Date.now(), ms]);
        if (this.ws.length > 8_000) this.ws.splice(0, 500);
      });
    read();
    this.wsTimer = setInterval(read, 1_000);
    this.wsTimer.unref();
  }

  /** CPU of the groups between two moments, in % of one core: the whole Mac, the VM, WindowServer, the harness. */
  cpu(from, to) {
    const a = this.at(from);
    const b = this.at(to);
    if (!a || !b || b.t <= a.t || b.total <= a.total) return null;
    const ms = b.t - a.t;
    const pct = (x, y) => (x == null || y == null ? null : ((y - x) / 1e6 / ms) * 100);
    const wsFrom = interpolate(this.ws, a.t);
    const wsTo = interpolate(this.ws, b.t);
    const ws = pct(a.ws, b.ws) ?? (wsFrom == null || wsTo == null ? null : ((wsTo - wsFrom) / ms) * 100);
    return { host: ((b.busy - a.busy) / (b.total - a.total)) * b.cpus * 100, vm: pct(a.vm, b.vm), ws, harness: pct(a.harness, b.harness) };
  }

  /** The newest moment WindowServer's CPU is known up to (ps reads it once a second), or `t` if it is never known. */
  known(t) {
    const last = this.ws.at(-1)?.[0];
    return last != null && last < t && t - last < 2_000 ? last : t;
  }

  /**
   * What keeps the Mac busy with nothing measured, between two moments: in 5 s steps, the "other" CPU (the Mac minus
   * the VM, WindowServer and the harness) and the VM's, in % of one core. `otherPct` is their median, the level runs
   * are judged against (estimators.mjs noiseVerdict): a steady background is part of the Mac, a change of it is noise.
   * Null without samples.
   */
  background(from, to) {
    const others = [];
    const vms = [];
    for (let t = from; t + 5_000 <= to; t += 5_000) {
      const c = this.cpu(t, t + 5_000);
      if (!c) continue;
      others.push(Math.max(0, c.host - (c.vm ?? 0) - (c.ws ?? 0) - (c.harness ?? 0)));
      vms.push(c.vm ?? 0);
    }
    if (!others.length) return null;
    const q = (xs, p) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    const r1 = (v) => Math.round(v * 10) / 10;
    return { otherPct: r1(q(others, 0.5)), otherMaxPct: r1(Math.max(...others)), vmPct: r1(q(vms, 0.5)), windows: others.length };
  }

  /**
   * What else happened on the Mac in a measured window. `appCpu(from, to)`: the app's own CPU there, in % of one
   * core; `appPids`: its processes, to tell whether its window was in front. "Other" is the Mac's CPU minus the
   * app, the VM, WindowServer and the harness: what nothing in the benchmark accounts for. `inHarness`: the app runs
   * as the harness's child (k9s, in its terminal), so its CPU is in the harness's already.
   */
  summary(from, to, { appCpu = () => 0, appPids = new Set(), frontmost = true, inHarness = false } = {}) {
    const whole = this.cpu(from, to);
    if (!whole) return null;
    const other = (c, app) => c.host - (inHarness ? 0 : app) - (c.vm ?? 0) - (c.ws ?? 0) - (c.harness ?? 0);
    let otherMax1sPct = 0;
    for (let t = from; t + 1_000 <= to; t += 1_000) {
      const c = this.cpu(t, t + 1_000);
      if (c) otherMax1sPct = Math.max(otherMax1sPct, other(c, appCpu(t, t + 1_000) ?? 0));
    }
    const inside = this.samples.filter((s) => s.t >= from && s.t <= to);
    const first = this.at(from);
    const last = this.at(to);
    const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    return {
      hostPct: r1(whole.host),
      vmPct: r1(whole.vm),
      wsPct: r1(whole.ws),
      harnessPct: r1(whole.harness),
      otherPct: r1(Math.max(0, other(whole, appCpu(from, to) ?? 0))),
      otherMax1sPct: r1(Math.max(0, otherMax1sPct)),
      thermal: THERMAL[Math.max(0, ...inside.map((s) => s.thermal))] ?? "nominal",
      lowPower: inside.some((s) => s.lowPower),
      onAC: inside.every((s) => s.ac !== false),
      displayAsleep: inside.some((s) => s.asleep || s.locked),
      frontmostFrac: frontmost && inside.length ? Math.round((inside.filter((s) => appPids.has(s.front)).length / inside.length) * 100) / 100 : null,
      memPressure: PRESSURE[Math.max(1, ...inside.map((s) => s.pressure))] ?? "normal",
      swapouts: last && first ? last.swapouts - first.swapouts : 0,
      pageouts: last && first ? last.pageouts - first.pageouts : 0,
    };
  }

  /**
   * Waits until the Mac is quiet before a launch: over the last `holdMs`, most of it idle, nothing outside the
   * benchmark busy, the VM calm, memory under no pressure. Gives up after `timeoutMs` (the run is then marked).
   */
  async waitQuiet({ timeoutMs = 120_000, holdMs = 3_000, hostIdleMin = 90, otherMaxPct = 20, vmMaxPct = 25 } = {}) {
    const started = Date.now();
    for (;;) {
      const t = this.known(Date.now());
      const c = this.cpu(t - holdMs, t);
      const s = this.at(t);
      if (c && s) {
        const idle = 100 - c.host / s.cpus;
        const other = c.host - (c.vm ?? 0) - (c.ws ?? 0) - (c.harness ?? 0);
        const quiet = idle >= hostIdleMin && other <= otherMaxPct && (c.vm ?? 0) <= vmMaxPct && s.pressure <= 1;
        if (quiet) return { waitedMs: Date.now() - started, timedOut: false, idlePct: Math.round(idle * 10) / 10, otherPct: Math.round(other * 10) / 10 };
        if (Date.now() - started > timeoutMs) return { waitedMs: Date.now() - started, timedOut: true, idlePct: Math.round(idle * 10) / 10, otherPct: Math.round(other * 10) / 10 };
      }
      await sleep(500);
    }
  }

  stop() {
    clearInterval(this.wsTimer);
    this.child.kill();
  }
}

const sysctl = async (k) => (await run("sysctl", ["-n", k]).catch(() => "")).trim();

/** What the session runs on, for the results: the Mac, macOS, the display, power, tools and the harness itself. */
export async function environment() {
  const chip = await sysctl("machdep.cpu.brand_string");
  const memoryGB = Math.round(totalmem() / 2 ** 30);
  const [version, build] = (await run("sw_vers", [])).match(/ProductVersion:\s*(\S+)[\s\S]*BuildVersion:\s*(\S+)/)?.slice(1) ?? [];
  const batt = await run("pmset", ["-g", "batt"]).catch(() => "");
  const pm = await run("pmset", ["-g"]).catch(() => "");
  const git = (args) => run("git", args, { cwd: ROOT }).then((o) => o.trim(), () => null);
  // The benchmark's own files: the results it adds to don't make it another harness.
  const benchDirty = (await git(["status", "--porcelain", "--", ".", ":!results"]))?.length ? ", modified" : "";
  return {
    machine: {
      model: await sysctl("hw.model"),
      chip,
      cores: cpus().length,
      performanceCores: Number(await sysctl("hw.perflevel0.physicalcpu")) || null,
      efficiencyCores: Number(await sysctl("hw.perflevel1.physicalcpu")) || null,
      memoryGB,
      slug: `${chip.replace(/^Apple /, "").toLowerCase().replace(/\s+/g, "-")}-${memoryGB}gb`,
    },
    os: { version, build, kernel: (await run("uname", ["-r"])).trim() },
    display: await screenGeometry(),
    power: { source: /AC Power/.test(batt) ? "AC" : /Battery Power/.test(batt) ? "battery" : null, lowPower: /lowpowermode\s+1/.test(pm) },
    tools: { node: process.versions.node, swift: (await run("swift", ["--version"]).catch(() => "")).match(/Swift version (\S+)/)?.[1] ?? null },
    harness: { commit: `${(await git(["log", "-1", "--format=%h", "--", ".", ":!results"])) ?? "?"}${benchDirty}` },
  };
}
