#!/usr/bin/env node
// Benchmarks k10s against other Kubernetes clients on this Mac, against the same local clusters, with nobody at the
// Mac once it runs. README.md says how to run it; docs/benchmarks.md what is measured, and the results.
//
//   node bench.mjs doctor [--clients …] [--k10s DIR]   check what the benchmark needs
//   node bench.mjs run [options]                  set everything up and measure (results in results/)
//       --k10s DIR          the k10s to measure: built from this k10s checkout (default: the release pinned in
//                           clients.lock.json; K10S_APP=<k10s.app> measures that app)
//       --clients k10s,aptakube,headlamp,freelens,k9s   (and lens, which needs a Lens ID)
//       --scenarios pods-1k,contexts-100,pods-10k,fleet-5x10k,pods-50k,namespaces-100k,logs-300
//       --runs N            exactly N runs per client and scenario (default: 5 to 9, until the numbers settle)
//       --seed S            the order the clients take turns in (default: random, recorded)
//       --budget-hours H    at most 7 runs per client and scenario if the rest wouldn't fit in H hours (default 10)
//       --out FILE          the results file (default results/<date>-<mac>.json); runs add to it
//       --allow-env-drift   add to a file made with another macOS build, display or VM size
//       --keep-profiles     start from the clients' profiles of the last run (for debugging)
//       --keep-vm           leave the benchmark's VM running at the end
//       --build             build k10s again (with --k10s)
//   node bench.mjs check FILE                     what a results file holds, and what went wrong in it
//   node bench.mjs compare A.json B.json          two runs of the same Mac: how far apart their numbers are
//   node bench.mjs report [files…] [--main m2-pro-16gb] [--export DIR]   tables and charts (README: that
//                                                 machine); --export copies the charts into the k10s checkout DIR
//   node bench.mjs clean [--vm]                   delete the VM and everything in ~/.k10s-bench (--vm: only the VM)

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NO_K10S, ensureApps, installedSize, k10sAvailable, loadLock } from "./lib/apps.mjs";
import { CLUSTERS, admin, ensureCluster, kubeconfig, kwokVersion, stopCluster } from "./lib/clusters.mjs";
import { ESTIMATORS, HARNESS, NOISE, QUICK, TIMING } from "./lib/estimators.mjs";
import { Kube } from "./lib/kube.mjs";
import { ensureLogsCluster, logRate, stopLogsCluster } from "./lib/logs.mjs";
import { CLIENTS, DEFAULT_CLIENTS } from "./lib/clients/index.mjs";
import { profileDir, writeKubeconfig } from "./lib/clients/common.mjs";
import { measure } from "./lib/measure.mjs";
import { buildProbe } from "./lib/probe.mjs";
import { Proxies } from "./lib/proxy.mjs";
import { CONTEXT_PORTS, SCENARIOS, contextNames, unsupported } from "./lib/scenarios.mjs";
import { capAt, cellStatus, nextRound, projectSeconds, roundOrder } from "./lib/schedule.mjs";
import { clearSnapshots, snapshot } from "./lib/state.mjs";
import { SystemProbe, environment } from "./lib/system.mjs";
import { ROOT, REAL_HOME, WORK, exists, log, run, sleep, which } from "./lib/util.mjs";
import { deleteVm, ensureVm, otherVms, stopVm, vmInfo } from "./lib/vm.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);
const QUICK_RUN = !!process.env.K10S_BENCH_QUICK;

/** Scenarios in the order that restarts the fewest clusters: neighbours share theirs. */
const ORDER = ["pods-1k", "contexts-100", "pods-10k", "fleet-5x10k", "pods-50k", "namespaces-100k", "logs-300"];

/** How well each driving metric must be known, at least: 10 % of its median, or this much (schedule.mjs). */
const FLOORS = { readyMs: 200, memMB: 15, cpuPct: 1, churnCpuPct: 2, churnMemMB: 20, logCpuPct: 2, logMemMB: 20 };

/** The warm-up start of each client in each scenario: the same steps with short windows. */
const WARMUP = { afterReady: 3_000, fixedAge: 0, idleWindow: 8_000, churnWarmup: 4_000, churnWindow: 6_000, logWarmup: 4_000, logWindow: 10_000, logMemTail: 4_000 };

/** A run that has no other figure to go by is expected to take this long, waits and quitting included. */
const RUN_MS = 150_000;

async function doctor({ clients = DEFAULT_CLIENTS, create = false } = {}) {
  const problems = [];
  const check = async (what, ok, fix, { warn = false } = {}) => {
    const good = await ok();
    console.log(`${good ? "✓" : warn ? "!" : "✗"} ${what}${good ? "" : `\n    ${fix}`}`);
    if (!good && !warn) problems.push(what);
  };
  await check("macOS on Apple silicon", async () => process.platform === "darwin" && process.arch === "arm64", "The benchmark runs on Macs with Apple silicon.");
  await check("Node.js 22 or newer", async () => Number(process.versions.node.split(".")[0]) >= 22, "Install Node.js 22+ (https://nodejs.org).");
  await check("Xcode command line tools (swiftc)", async () => !!(await which("swiftc")), "xcode-select --install");
  for (const tool of ["colima", "docker", "kwokctl", "kubectl"]) {
    await check(tool, async () => !!(await which(tool)), "brew install colima docker kwok kubernetes-cli");
  }
  await check("python3, sqlite3, openssl", async () => !!((await which("python3")) && (await which("sqlite3")) && (await which("openssl"))), "They come with macOS and the command line tools.");
  const others = await otherVms().catch(() => []);
  await check("no other virtual machine running", async () => !others.length, `Quit ${others.join(", ")}: each takes memory and CPU from the apps measured. The benchmark never stops them itself.`);
  const freeGB = Number((await run("df", ["-k", REAL_HOME])).split("\n")[1]?.split(/\s+/)[3] ?? 0) / 2 ** 20;
  await check("30 GB of free disk", async () => freeGB >= 30, `Only ${Math.round(freeGB)} GB free: the VM, the clusters and the apps need about 30.`);
  const power = await run("pmset", ["-g", "batt"]).catch(() => "");
  await check("on AC power", async () => /AC Power/.test(power), "Plug in the power: on battery, runs are marked noisy and measured again.", { warn: true });
  const busy = await busyApps();
  await check("no other app busy", async () => !busy.length, `Busy: ${busy.map(([name, pct]) => `${name} (${Math.round(pct)}% of a core)`).join(", ")}. Quit what you can: runs are judged against what else runs when they start, but it still takes CPU from the apps measured.`, { warn: true });
  if (clients.includes("k10s")) {
    await check("a k10s to measure", async () => k10sAvailable(await loadLock(), option("k10s")), `${NO_K10S[0].toUpperCase()}${NO_K10S.slice(1)}.`);
  }
  if (clients.includes("aptakube")) {
    const dir = join(REAL_HOME, "Library/Application Support/com.aptakube.Aptakube");
    await check("Aptakube has a trial or a licence", async () => exists(join(dir, "license.bin")) || exists(join(dir, "trial.bin")), "Open Aptakube once and start a trial or enter a licence; the benchmark copies that file into its own profile.");
  }
  if (create && !problems.length) {
    await ensureVm();
    const vm = await vmInfo();
    await check(`the benchmark's VM (colima ${vm.colima}, ${vm.cpus} CPUs, ${vm.memoryGB} GB)`, async () => vm.cpus === 4 && vm.memoryGB >= 7.5, "node bench.mjs clean --vm, then run again");
  }
  console.log(problems.length ? `\n${problems.length} to fix first.` : create ? "" : "\nReady: node bench.mjs run (it creates its own VM the first time)");
  return problems.length === 0;
}

/**
 * Brings a freshly started cluster's data into its API server's caches with the benchmark's own credentials (never
 * audited): its lists, twice; for the log cluster, a read of the pod's log.
 */
async function warmCluster(cluster) {
  if (cluster.pod && !cluster.pods) await logRate(cluster.pod);
  else {
    const kube = new Kube(admin(cluster.name), { sockets: 8 });
    try {
      for (let i = 0; i < 2; i++) {
        if (cluster.pods) await kube.listAll("/api/v1/pods");
        await kube.listAll("/api/v1/namespaces");
        await kube.listAll("/api/v1/nodes");
        await kube.listAll("/api/v1/events").catch(() => {});
      }
    } finally {
      kube.close();
    }
  }
}

/**
 * What keeps the Mac busy with the scenario's clusters warm and no client running (SystemProbe.background): once the
 * VM's CPU holds steady (two 5 s stretches within 5 points, at most 2 minutes), over the last 30 s at least. Runs are
 * judged against it: a steady background is part of the Mac, a change of it is noise.
 */
async function calm(sys, maxMs = 120_000) {
  const started = Date.now();
  let previous = null;
  for (;;) {
    await sleep(5_000);
    const vm = sys.cpu(Date.now() - 5_000, Date.now())?.vm ?? null;
    const steady = vm != null && previous != null && Math.abs(vm - previous) < 5;
    if ((steady && Date.now() - started >= 30_000) || Date.now() - started > maxMs) break;
    previous = vm;
  }
  const to = sys.known(Date.now());
  return sys.background(to - 30_000, to);
}

/**
 * Apps that keep the Mac busy (more than 10 % of a core, by ps's recent average), by app: runs are judged against what
 * else runs when a scenario starts, but a busy background still takes CPU from the apps measured.
 */
async function busyApps() {
  const byApp = new Map();
  for (const line of (await run("ps", ["-Ao", "pcpu=,comm="]).catch(() => "")).split("\n")) {
    const m = line.trim().match(/^([\d.]+)\s+(.+)$/);
    if (!m || Number(m[1]) < 1) continue;
    const name = m[2].match(/\/([^/]+)\.app\//)?.[1] ?? m[2].split("/").pop();
    if (["WindowServer", "kernel_task", "node", "probe"].includes(name)) continue;
    byApp.set(name, (byApp.get(name) ?? 0) + Number(m[1]));
  }
  return [...byApp].filter(([, pct]) => pct >= 10).sort((a, b) => b[1] - a[1]);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const localDate = () => new Date().toLocaleDateString("sv");

/** The numbers a counted run is judged by (scenarios.mjs `drive`, schedule.mjs cellStatus). */
function metricsOf(r) {
  return { readyMs: r.readyMs ?? null, memMB: r.idle?.memMB ?? null, cpuPct: r.idle?.cpuPct ?? null, churnCpuPct: r.churn?.cpuPct ?? null, churnMemMB: r.churn?.memMB ?? null, logCpuPct: r.logs?.cpuPct ?? null, logMemMB: r.logs?.memEndMB ?? null };
}

/** Why runs can't be added to a results file from this harness and Mac setup; null if they can. */
function incompatible(doc, machine) {
  if (doc.harness?.version !== HARNESS) return `it was made by ${doc.harness ? `harness ${doc.harness.version}` : "an older benchmark"}, this is harness ${HARNESS}`;
  if (!!doc.harness.quick !== QUICK_RUN) return QUICK_RUN ? "it holds full runs and this is a quick one" : "it holds quick runs";
  const was = doc.machine ?? {};
  const drift = [
    was.slug !== machine.slug && `Mac ${was.slug} → ${machine.slug}`,
    was.build !== machine.build && `macOS ${was.build} → ${machine.build}`,
    (was.dockerVM?.cpus !== machine.dockerVM.cpus || was.dockerVM?.vmType !== machine.dockerVM.vmType) && "the VM",
    JSON.stringify(was.display?.visible) !== JSON.stringify(machine.display?.visible) && "the display",
  ].filter(Boolean);
  if (!drift.length || flag("allow-env-drift")) return null;
  return `the setup changed: ${drift.join(", ")} (--allow-env-drift adds to it anyway)`;
}

async function runBench() {
  const clientKeys = option("clients", DEFAULT_CLIENTS.join(",")).split(",");
  const scenarioKeys = option("scenarios", ORDER.join(",")).split(",");
  for (const k of clientKeys) if (!CLIENTS[k]) throw new Error(`unknown client ${k}`);
  for (const k of scenarioKeys) if (!SCENARIOS[k]) throw new Error(`unknown scenario ${k}`);
  if (!(await doctor({ clients: clientKeys, create: true }))) process.exit(1);
  // Neither the Mac nor its display sleeps while the benchmark runs.
  spawn("caffeinate", ["-dims", "-w", String(process.pid)], { stdio: "ignore" }).unref();
  await buildProbe();
  const apps = await ensureApps(clientKeys, await loadLock(), { build: flag("build"), checkout: option("k10s") });
  const env = await environment();
  const machine = { ...env.machine, macOS: env.os.version, build: env.os.build, dockerVM: await vmInfo(), kwok: await kwokVersion(), display: env.display };
  const out = resolve(option("out", join(ROOT, "results", `${localDate()}-${machine.slug}.json`)));
  if (QUICK_RUN && out.startsWith(join(ROOT, "results"))) throw new Error("quick runs don't go into results/: pass --out with a file elsewhere");
  mkdirSync(dirname(out), { recursive: true });
  const timing = QUICK_RUN ? { ...TIMING, ...QUICK } : TIMING;
  const doc = exists(out) ? JSON.parse(readFileSync(out, "utf8")) : { harness: null, machine, sessions: [], clients: {}, results: [] };
  if (doc.harness || doc.results.length) {
    const why = incompatible(doc, machine);
    if (why) throw new Error(`can't add to ${out}: ${why}`);
  }
  const seed = option("seed", randomBytes(4).toString("hex"));
  const session = { id: `${localDate()}-${randomBytes(3).toString("hex")}`, seed, args, startedAt: Date.now(), environment: env, vm: machine.dockerVM, timing, noise: NOISE, floors: FLOORS };
  doc.harness = { version: HARNESS, estimators: ESTIMATORS, commit: env.harness.commit, quick: QUICK_RUN };
  doc.machine = machine;
  doc.sessions.push(session);
  for (const k of clientKeys) {
    doc.clients[k] = { name: CLIENTS[k].name, version: apps[k].version, installedMB: Math.round(await installedSize(apps[k])), sha256: sha256(apps[k].bin) };
  }
  const save = () => writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
  save();
  log(`results go to ${out} (session ${session.id}, order seed ${seed})`);

  // Every run of the benchmark starts its clients from nothing; Lens keeps its sign-in.
  if (!flag("keep-profiles")) for (const k of clientKeys) if (k !== "lens") rmSync(profileDir(k), { recursive: true, force: true });
  clearSnapshots();
  const unusable = {};
  for (const k of clientKeys) {
    try {
      await CLIENTS[k].prepare?.(apps[k]);
      if (CLIENTS[k].licence) doc.clients[k].licence = CLIENTS[k].licence;
    } catch (e) {
      unusable[k] = e.message;
      log(`${CLIENTS[k].name} is left out: ${e.message}`);
    }
  }
  save();

  const sys = await SystemProbe.start();
  const proxies = new Proxies();
  const fixedRuns = option("runs") ? Number(option("runs")) : null;
  // A quick run is a smoke test: it doesn't measure noisy runs again, nor wait long for a quiet Mac.
  const limits = { min: fixedRuns ?? (QUICK_RUN ? 2 : 5), max: fixedRuns ?? (QUICK_RUN ? 2 : 9), floors: FLOORS, rel: 0.1, ...(QUICK_RUN ? { maxNoisy: 0 } : {}) };
  const budgetMs = Number(option("budget-hours", 10)) * 3_600_000;
  const durations = [];
  const perRunMs = () => (durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : RUN_MS);
  let seq = 0;
  let capped = false;
  const record = (r) => {
    doc.results.push({ session: session.id, ...r });
    save();
  };
  try {
    for (const [si, key] of scenarioKeys.entries()) {
      const scenario = { key, ...SCENARIOS[key] };
      const supported = [];
      for (const k of clientKeys) {
        const why = unsupported(CLIENTS[k], scenario);
        if (why) {
          if (!doc.results.some((r) => r.client === k && r.scenario === key && r.skipped)) record({ client: k, scenario: key, skipped: why });
        } else if (unusable[k]) record({ client: k, scenario: key, error: unusable[k], unusable: true, counted: false });
        else supported.push(k);
      }
      // The cells of the scenario, from every run the file holds: a file can be added to until each cell is done.
      const runsOf = (k) => doc.results.filter((r) => r.client === k && r.scenario === key && !r.warmup && !r.skipped && !r.unusable);
      const cellsNow = () => Object.fromEntries(supported.map((k) => [k, cellStatus(runsOf(k), { ...limits, drive: scenario.drive })]));
      if (!nextRound(cellsNow(), { seed, scenario: key, round: 1 }).length) {
        log(`scenario ${key}: nothing left to measure`);
        continue;
      }
      log(`scenario ${key}: ${scenario.title}`);
      const setUp = async () => {
        // Only the scenario's clusters run: the VM has room for five of 10,000 pods, not for all of them.
        for (const name of Object.keys(CLUSTERS)) if (!scenario.clusters.includes(name)) await stopCluster(name);
        if (!scenario.k3s) await stopLogsCluster();
        const clusters = [];
        if (scenario.k3s) clusters.push(await ensureLogsCluster());
        else for (const name of scenario.clusters) clusters.push(await ensureCluster(name));
        for (const c of clusters) await warmCluster(c);
        const background = await calm(sys);
        scenario.pod = clusters[0].pod;
        if (scenario.k3s) scenario.logBytesPerSec = await logRate(scenario.pod);
        const targets = scenario.contexts ? Array(scenario.contexts).fill(clusters[0]) : clusters;
        const ports = scenario.contexts ? CONTEXT_PORTS(scenario.contexts) : clusters.map((c) => c.port);
        for (let i = 0; i < ports.length; i++) await proxies.ensure(ports[i], targets[i].server);
        const text = kubeconfig(targets, ports);
        const contexts = contextNames(scenario);
        // Before a launch the VM may be busy up to 15 points of a core above its calm level, and the rest of the Mac up
        // to 20 above its own; while a run is measured (after its start), the rest of the Mac 25 above it: its level
        // wanders by up to 15 points over a minute with nothing changing.
        const base = background?.otherPct ?? 0;
        const noise = {
          wait: { vmMaxPct: Math.max(25, (background?.vmPct ?? 0) + 15), otherMaxPct: base + 20, hostIdleMin: 0, ...(QUICK_RUN ? { timeoutMs: 15_000 } : {}) },
          thresholds: { otherIdlePct: base + NOISE.otherIdlePct, otherMax1sPct: base + NOISE.otherMax1sPct },
        };
        (session.scenarios ??= {})[key] = { background, logBytesPerSec: scenario.logBytesPerSec ?? null, noise };
        log(`  the Mac with nothing measured: ${base}% of a core busy besides the VM (${background?.vmPct ?? "?"}%) and WindowServer`);
        for (const k of supported) {
          writeKubeconfig(profileDir(k), text);
          await CLIENTS[k].setup?.(apps[k], scenario, contexts);
        }
        return { clustersAt: Date.now(), targets, ports, text, contexts, noise };
      };
      // A scenario that can't be set up (a cluster that doesn't start) is left for the next run of the benchmark; the
      // others still run.
      let ready;
      try {
        ready = await setUp();
      } catch (e) {
        if (/stopping/.test(e.message)) throw e;
        log(`  the scenario couldn't be set up: ${e.message}`);
        (session.failures ??= []).push({ scenario: key, at: Date.now(), error: e.message });
        for (const k of supported) record({ client: k, scenario: key, error: `the scenario couldn't be set up: ${e.message}`, unusable: true, counted: false });
        continue;
      }
      const { clustersAt, targets, ports, text, contexts, noise } = ready;

      const attempt = (k, round) => doc.results.filter((r) => r.session === session.id && r.client === k && r.scenario === key && r.round === round).length + 1;
      const once = async (k, { round, pos, prev, warmup = false, seed: state = null, timing: t }) => {
        const step = `${key}/${round}/${k}`;
        const order = { seq: ++seq, pos, prev: prev ?? null, sinceClusterStartS: Math.round((Date.now() - clustersAt) / 1000) };
        const started = Date.now();
        writeKubeconfig(profileDir(k), text);
        let r;
        try {
          r = await measure({ client: CLIENTS[k], app: apps[k], scenario, contexts, targets, ports, proxies, sys, step, round, attempt: attempt(k, round), warmup, seed: state, timing: t, noise });
        } catch (e) {
          log(`  ${CLIENTS[k].name} ${step}: ${e.message}`);
          if (/stopping/.test(e.message)) throw e;
          r = { client: k, scenario: key, step, round, warmup, error: e.message };
        }
        return { ...r, ...order, durationMs: Date.now() - started };
      };

      // Round 0: a warm-up start of every client, the same steps with short windows. The profile it leaves is the
      // state every counted run of the scenario starts from (state.mjs); each launch applies the benchmark's settings
      // on top of it again.
      const label = `${session.id}-${key}`;
      let previousLast = null;
      const warmTiming = { ...timing, ...WARMUP, ...(QUICK_RUN ? QUICK : {}) };
      for (const [pos, k] of roundOrder(supported, { seed, scenario: key, round: 0 }).entries()) {
        log(`  ${CLIENTS[k].name}: warm-up start`);
        record({ ...(await once(k, { round: 0, pos, prev: previousLast, warmup: true, timing: warmTiming })), counted: false });
        await snapshot(k, label);
        previousLast = k;
      }

      // Then rounds, each in a new order, until every client's numbers are known well enough (schedule.mjs).
      for (let round = 1; round <= limits.max + 8; round++) {
        let cells = cellsNow();
        if (!fixedRuns && !capped) {
          // Not enough time left for this scenario's runs and the least the others need: at most 7 runs a cell.
          const leftMs = budgetMs - (Date.now() - session.startedAt);
          const laterMs = (scenarioKeys.length - si - 1) * clientKeys.length * (limits.min + 1) * perRunMs();
          if (projectSeconds(cells, perRunMs() / 1000) * 1000 + laterMs > leftMs) {
            capped = true;
            session.capped = { at: Date.now(), scenario: key, round };
            log(`  short of time (--budget-hours ${budgetMs / 3_600_000}): at most 7 runs per client from here on`);
          }
        }
        if (capped) cells = capAt(cells, 7);
        const order = nextRound(cells, { seed, scenario: key, round, previousLast });
        if (!order.length) {
          for (const [k, c] of Object.entries(cells)) log(`  ${CLIENTS[k].name}: ${c.reason}`);
          break;
        }
        for (const [pos, k] of order.entries()) {
          const r = await once(k, { round, pos, prev: previousLast, seed: label, timing });
          record({ ...r, counted: true, metrics: metricsOf(r) });
          if (!r.error) durations.push(r.durationMs);
          if (r.noisy?.length) log(`  ${CLIENTS[k].name} ${r.step}: noisy (${r.noisy.join(", ")})`);
          previousLast = k;
        }
      }
    }
  } finally {
    await proxies.stopAll();
    sys.stop();
    session.endedAt = Date.now();
    save();
    if (!flag("keep-vm")) await stopVm().catch(() => {});
  }
  log(`done: ${out}`);
}

async function clean() {
  await deleteVm();
  rmSync(WORK, { recursive: true, force: true });
  log(`deleted the benchmark's VM and ${WORK}`);
}

switch (command) {
  case "doctor":
    process.exit((await doctor({ clients: option("clients", DEFAULT_CLIENTS.join(",")).split(",") })) ? 0 : 1);
    break;
  case "run":
    await runBench();
    break;
  case "check": {
    const { check } = await import("./lib/compare.mjs");
    process.exit(check(args[1]) ? 0 : 1);
    break;
  }
  case "compare": {
    const { compare } = await import("./lib/compare.mjs");
    process.exit(compare(args[1], args[2]) ? 0 : 1);
    break;
  }
  case "report": {
    const { report } = await import("./lib/report.mjs");
    await report(args.slice(1));
    break;
  }
  case "clean":
    if (flag("vm")) await deleteVm();
    else await clean();
    break;
  default: {
    const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).join("\n").replace(/^\/\/ ?/gm, ""));
  }
}
