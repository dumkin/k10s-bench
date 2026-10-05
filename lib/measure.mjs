// One run of one client in one scenario: put back the client's saved state, start it, open the view, wait until it
// is ready, then watch it idle and, in scenarios with churn, while pods keep changing, or follow its log. Every
// number comes from outside the app; the windows it is watched in are placed at a fixed age of the app
// (estimators.mjs), and what else happened on the Mac meanwhile is recorded with them (system.mjs).

import { auditBarrier, markAudit, requestSignature, requestsOf, screenSummary, startupRequests, summarize } from "./audit.mjs";
import { Churn } from "./churn.mjs";
import { admin, kubeconfig, runUser, somePods } from "./clusters.mjs";
import { TIMING, cpuPercent, dataIn, logMetrics, logStreamingAt, logWindow, memoryIn, noiseVerdict, peak, settle, wakeupsPerSecond, windowsFor } from "./estimators.mjs";
import { LOGS, logFileBytes, newestLine } from "./logs.mjs";
import { Probe, targetWindow } from "./probe.mjs";
import { changed, fingerprint, hasSnapshot, restore } from "./state.mjs";
import { log, now, sleep, waitFor } from "./util.mjs";
import { checkScreen, compactSummary } from "./verify.mjs";
import { killStray, profileDir, quitPid, writeKubeconfig } from "./clients/common.mjs";

export { TIMING };

const mb = (bytes) => (bytes == null ? null : Math.round((bytes / 1e6) * 10) / 10);
const pct = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** The whole run, every 250 ms: [ms since start, MB of memory, % CPU since the previous point, MB downloaded]. */
function timeline(probe, t0) {
  const out = [];
  let prev = null;
  const end = probe.samples.at(-1)?.t ?? t0;
  for (let t = t0; t <= end; t += 250) {
    const s = probe.at(t);
    if (!s) continue;
    const cpu = prev && s.t > prev.t ? ((s.cpu - prev.cpu) / 1e6 / (s.t - prev.t)) * 100 : 0;
    out.push([Math.round(t - t0), Math.round(s.mem / 1e6), Math.round(cpu), Math.round((s.down ?? 0) / 1e5) / 10]);
    prev = s;
  }
  return out;
}

/**
 * How far behind the pod an app shows its log, for the apps whose log the benchmark can read (over DevTools; a
 * terminal's screen comes as partial redraws): for 12 s, every 250 ms, the newest line on its screen against the
 * newest the pod wrote, by their numbers (`seq`; else by their times, in whole seconds). `updates`: how often what it
 * showed changed.
 */
async function behindPod(client, pod) {
  const pods = newestLine(pod);
  const lags = [];
  let updates = 0;
  let last;
  try {
    for (let i = 0; i < 48; i++) {
      const [shown, wrote] = await Promise.all([client.newestShown().catch(() => null), pods.read().catch(() => null)]);
      if (shown && wrote) {
        const lag = shown.seq != null && wrote.seq != null ? (wrote.seq - shown.seq) / LOGS.rate : shown.ts != null && wrote.ts != null ? (wrote.ts - shown.ts) / 1000 : null;
        if (lag != null) lags.push(Math.max(0, lag));
        const key = shown.seq ?? shown.ts;
        if (key !== last) updates++;
        last = key;
      }
      await sleep(250);
    }
  } finally {
    pods.close();
  }
  if (!lags.length) return null;
  const sorted = [...lags].sort((a, b) => a - b);
  const r1 = (v) => Math.round(v * 10) / 10;
  return { samples: lags.length, updates, medianSec: r1(sorted[sorted.length >> 1]), maxSec: r1(sorted.at(-1)) };
}

/** Waits for `check` to return a value while the app runs, until `deadline`; null if it never does. */
async function until(check, deadline, every = 100) {
  return waitFor(check, { timeout: Math.max(0, deadline - now()), every });
}

/**
 * A run. `seed`: the label of the client's saved state for the scenario (state.mjs), put back first; none for a
 * warm-up, which makes it. `timing`: TIMING, or shorter windows for a warm-up or a quick smoke run.
 */
export async function measure({ client, app, scenario, contexts, targets, ports, proxies, sys, step, round, attempt = 1, warmup = false, seed = null, timing = TIMING, noise = {} }) {
  await killStray(app);
  proxies.dropConnections();
  const result = { client: client.key, scenario: scenario.key, step, round, attempt, warmup, version: app.version, clocks: "wall" };
  if (seed && hasSnapshot(client.key, seed)) await restore(client.key, seed);
  const before = await fingerprint(client);
  // A user of its own for this run, so that the API servers' audit logs say which requests were its (k3s, for
  // the log, keeps no audit log: there the benchmark's shared user will do).
  const user = scenario.k3s ? null : `bench-${client.key}-${scenario.key}-${round}-${attempt}-${Date.now().toString(36)}`;
  result.user = user;
  if (user) {
    const creds = new Map();
    for (const t of new Set(targets)) creds.set(t, await runUser(t.name, user));
    writeKubeconfig(profileDir(client.key), kubeconfig(targets.map((t) => ({ ...t, user: creds.get(t) })), ports));
  }
  if (scenario.k3s) result.logFileKB = Math.round(((await logFileBytes()) ?? 0) / 1e3) || null;
  const prelaunch = await sys.waitQuiet(noise.wait);
  result.prelaunch = prelaunch;
  const base = proxies.totals();
  const basePorts = proxies.perPort();
  const target = await targetWindow();
  if (user) markAudit(scenario.clusters);
  const { t0, pid } = await client.launch(app, { contexts, view: scenario.view, scenario, pod: scenario.pod });
  proxies.startRecording(t0);
  result.startedAt = t0;
  const probe = new Probe(pid, { extra: () => { const t = proxies.totals(); return { down: t.down - base.down, up: t.up - base.up }; } });
  const at = (t) => (t == null ? null : Math.round(t - t0));
  const appCpu = (a, b) => cpuPercent(probe.samples, a, b) ?? 0;
  const windows = {};
  try {
    let opened = { hookAt: null };
    try {
      opened = await client.open({ view: scenario.view, expect: scenario.expect, contexts, pod: scenario.pod, namespace: "shop", app }, { timeout: timing.timeout });
    } catch (e) {
      result.error = e.message;
      if (e.detail) result.errorDetail = e.detail;
      log(`  ${client.name}: ${e.message}${e.detail ? ` (${e.detail})` : ""}`);
      if (/stopping/.test(e.message)) throw e;
    }
    result.shown = opened.shown ?? null;
    if (opened.link) result.link = opened.link;
    const deadline = t0 + timing.timeout;
    const arrivals = () => proxies.arrivalsSince(t0);

    if (scenario.view === "logs") {
      // The log keeps coming, so the app never goes quiet: measured while it streams, from when it shows. An app
      // the benchmark can't read shows it when its traffic carries the pod's log at its rate.
      let shownAt = opened.hookAt;
      if (shownAt == null && !result.error) {
        shownAt = await until(() => logStreamingAt(arrivals(), t0, scenario.logBytesPerSec, { until: now() }), deadline, 250);
        if (shownAt != null) result.hookFrom = "traffic";
      }
      result.hookMs = at(shownAt);
      if (shownAt == null) {
        result.error ??= "the log did not start streaming";
        return result;
      }
      const [from, to] = logWindow({ t0, shown: shownAt, timing });
      windows.logs = [from, to];
      await sleep(Math.max(0, to - now()));
      const m = logMetrics(probe.samples, from, to, { tailMs: timing.logMemTail });
      const bytes = arrivals().filter(([t]) => t >= from && t < to).reduce((s, [, b]) => s + b, 0);
      const rate = bytes / ((to - from) / 1000);
      result.logs = { ...m, coverage: scenario.logBytesPerSec ? Math.round((rate / scenario.logBytesPerSec) * 100) / 100 : null, sourceKBPerMin: Math.round(((scenario.logBytesPerSec ?? 0) * 60) / 1e3) };
      if (!warmup) {
        const check = checkScreen({ client, scenario, coverage: result.logs.coverage });
        if (!check.ok) result.invalid = check.reasons.join("; ");
      }
      result.peakMB = mb(peak(probe.samples, t0, to)?.bytes);
      // After the measured minute (reading the screen costs the app a little): how far behind the pod it shows the log.
      if (client.newestShown && !warmup) result.logs.behind = await behindPod(client, scenario.pod);
      const lag = result.logs.behind ? `, ${result.logs.behind.medianSec} s behind` : "";
      log(`  ${client.name} ${step}: log ${result.logs.cpuPct}% CPU, ${result.logs.memEndMB} MB, slope ${result.logs.slopeMBPerMin} MB/min, ${Math.round((result.logs.coverage ?? 0) * 100)}% of the log${lag}`);
      return result;
    }

    // Ready: when the window shows every object, for the apps the benchmark can read; else when the data is in and
    // the window is up — the earliest the table can show, which favors the apps that can't be read (k10s, Aptakube).
    let readyAt = null;
    if (client.readiness === "hook") {
      readyAt = opened.hookAt;
      result.readyMethod = "hook";
    } else if (!result.error) {
      await until(() => probe.firstWindowAt, deadline, 50);
      const dataAt = await until(() => dataIn(arrivals(), t0, { expect: scenario.expect, until: now() }), deadline, 250);
      readyAt = dataAt != null && probe.firstWindowAt != null ? Math.max(dataAt, probe.firstWindowAt) : null;
      result.readyMethod = "data";
    }
    const dataAt = dataIn(arrivals(), t0, { expect: scenario.expect, until: now() });
    result.hookMs = at(opened.hookAt);
    result.dataMs = at(dataAt);
    result.readyMs = at(readyAt);
    if (result.readyMethod === "hook" && opened.hookAt != null && dataAt != null) result.lagMs = Math.round(opened.hookAt - dataAt);
    if (readyAt == null) {
      result.error ??= `did not finish loading within ${timing.timeout / 1000} s`;
      return result;
    }
    windows.startup = [t0, readyAt];

    // Idle: the view open, nothing changing, at a fixed age of the app.
    const w = windowsFor({ t0, ready: readyAt, timing, churn: !!scenario.churn });
    const [idleFrom, idleTo] = w.idle;
    windows.idle = w.idle;
    await sleep(Math.max(0, idleTo - now()));
    // For the apps whose window is read, when the data was in, from the record up to now: it may still have been
    // coming when the window showed the table. How much later the window showed it is what the data estimator gains.
    if (result.readyMethod === "hook" && result.dataMs == null) {
      const dataLate = dataIn(arrivals(), t0, { expect: scenario.expect, until: now() });
      result.dataMs = at(dataLate);
      if (dataLate != null) result.lagMs = Math.round(opened.hookAt - dataLate);
    }
    const m = memoryIn(probe.samples, idleFrom, idleTo);
    const i0 = probe.at(idleFrom);
    const i1 = probe.at(idleTo);
    result.idle = {
      memMB: mb(m?.median),
      memMaxMB: mb(m?.max),
      cpuPct: pct(cpuPercent(probe.samples, idleFrom, idleTo)),
      wakeupsPerSec: Math.round(wakeupsPerSecond(probe.samples, idleFrom, idleTo) ?? 0),
      downKBPerMin: i0 && i1 ? Math.round(((i1.down - i0.down) / 1e3) * (60_000 / (i1.t - i0.t))) : null,
      requestsPerMin: null,
    };
    const p = peak(probe.samples, t0, idleFrom);
    result.peakMB = mb(p?.bytes);
    result.peakAtMs = at(p?.at);
    const settledAt = settle(probe.samples, readyAt, idleFrom, timing);
    result.settleMs = at(settledAt);
    result.neverQuiet = settledAt == null;
    const r = probe.at(readyAt + 5_000 > idleFrom ? idleFrom : readyAt + 5_000);
    result.startup = { downMB: mb(r?.down ?? 0), upMB: mb(r?.up ?? 0), requests: null };

    // Churn starts when the idle window ends and is measured after its own warm-up.
    let churn = null;
    if (scenario.churn) {
      const cluster = scenario.clusters[0];
      churn = new Churn(admin(cluster), await somePods(cluster, scenario.churn.pods), scenario.churn.rate);
      churn.start();
    }

    // The run's requests, by its user, placed in the servers' clock by a marker each server logs after them.
    if (user) {
      const offset = await auditBarrier(scenario.clusters[0]);
      const mine = requestsOf(scenario.clusters, user);
      const shift = offset ?? (mine[0] ? mine[0].at - t0 : 0);
      const startup = offset != null ? mine.filter((e) => e.at < readyAt + 5_000 + offset) : startupRequests(mine, readyAt - t0);
      result.startup.requests = summarize(startup);
      result.requestsTotal = mine.length;
      result.clockOffsetMs = offset;
      const inIdle = mine.filter((e) => e.at >= idleFrom + shift && e.at < idleTo + shift);
      result.idle.requestsPerMin = Math.round((inIdle.length * 60_000) / (idleTo - idleFrom));
      const summary = screenSummary(mine);
      result.state = { labels: { requestSig: requestSignature(startup), listPasses: passesOf(summary, scenario), watchStarts: watchesOf(summary, scenario) } };
      result.screen = compactSummary(summary);
      if (!warmup) {
        const bytes = new Map([...proxies.perPort()].map(([port, v]) => [port, v.down - (basePorts.get(port)?.down ?? 0)]));
        const check = checkScreen({ client, scenario, summary, ports, bytes });
        if (check.contexts) result.contexts = check.contexts;
        if (!check.ok) {
          result.invalid = check.reasons.join("; ");
          log(`  ${client.name} ${step}: wrong screen: ${result.invalid}`);
        }
      }
    }
    log(`  ${client.name} ${step}: window ${at(probe.firstWindowAt)} ms, ready ${result.readyMs} ms (${result.readyMethod}), ${result.startup.downMB} MB, ${result.startup.requests?.total ?? "–"} requests, idle ${result.idle.memMB} MB / ${result.idle.cpuPct}% CPU`);

    if (churn) {
      const [from, to] = w.churn;
      windows.churn = w.churn;
      await sleep(Math.max(0, to - now()));
      const totals = churn.stop();
      const c = memoryIn(probe.samples, from, to);
      const c0 = probe.at(from);
      const c1 = probe.at(to);
      result.churn = {
        rate: scenario.churn.rate,
        ...totals,
        ...churn.window(from, to),
        cpuPct: pct(cpuPercent(probe.samples, from, to)),
        memMB: mb(c?.median),
        memMaxMB: mb(c?.max),
        downKBPerMin: c0 && c1 ? Math.round(((c1.down - c0.down) / 1e3) * (60_000 / (c1.t - c0.t))) : null,
      };
      log(`  ${client.name} ${step}: churn ${result.churn.cpuPct}% CPU, ${result.churn.memMB} MB, ${result.churn.achievedRate}/s`);
    }
    result.processes = probe.breakdown();
  } finally {
    result.windowMs = at(probe.firstWindowAt);
    result.windowSize = probe.windowSize;
    const readyAt = result.readyMs != null ? t0 + result.readyMs : now();
    const readyWindows = probe.windowsAt(readyAt);
    result.window = { first: probe.windowLog.find(([, w]) => w.length)?.[1] ?? null, atReady: readyWindows, target: [target.width, target.height] };
    // Judged a second after ready: the probe looks at the windows once a second, and Headlamp is given its size over
    // DevTools while it loads, which the look before ready may not have seen yet.
    const settled = probe.windowsAt(readyAt + 1_100) ?? readyWindows;
    const biggest = settled?.reduce((a, b) => (b[0] * b[1] > (a?.[0] ?? 0) * (a?.[1] ?? 0) ? b : a), null);
    if (biggest && (Math.abs(biggest[0] - target.width) > 2 || Math.abs(biggest[1] - target.height) > 2)) result.windowWarning = `window ${biggest.join("×")} instead of ${target.width}×${target.height}`;
    if (settled?.length > 1) result.windowWarning = `${settled.length} windows`;
    result.windows = Object.fromEntries(Object.entries(windows).map(([k, [a, b]]) => [k, [at(a), at(b)]]));
    result.timeline = timeline(probe, t0);
    await client.close?.();
    if (client.quit) await client.quit(pid);
    else await quitPid(pid);
    await probe.stop();
    // What else the Mac did in each measured window, and whether that makes the run noisy.
    const frontmost = client.key !== "k9s";
    result.noise = { prelaunch };
    for (const [name, [a, b]] of Object.entries(windows)) result.noise[name] = sys.summary(a, b, { appCpu, appPids: probe.pids, frontmost: frontmost && name !== "startup", inHarness: !!client.inHarness });
    const churnNoise = result.churn ? { achievedRate: result.churn.achievedRate, target: result.churn.rate, failed: result.churn.failed > 0 } : null;
    result.noisy = noiseVerdict({ prelaunch, windows: result.noise, churn: churnNoise }, { ...noise.thresholds, requireFrontmost: frontmost });
    const after = await fingerprint(client);
    result.state = { ...result.state, seed, before: before?.hash ?? null, after: after?.hash ?? null, changed: changed(before, after) };
    if (result.idle?.wakeupsPerSec != null) (result.state.labels ??= {}).wakeBand = result.idle.wakeupsPerSec < 50 ? "quiet" : result.idle.wakeupsPerSec < 200 ? "active" : "busy";
  }
  return result;
}

/** How many times a run started the scenario's list again, per cluster (1: once). */
function passesOf(summary, scenario) {
  const path = scenario.view === "namespaces" ? "/api/v1/namespaces" : "/api/v1/pods";
  return Object.fromEntries(Object.entries(summary).map(([cluster, c]) => [cluster, c.passes[path] ?? 0]));
}

/** How many watches of the scenario's resource a run started, per cluster: more than one, it lost one. */
function watchesOf(summary, scenario) {
  const path = scenario.view === "namespaces" ? "/api/v1/namespaces" : "/api/v1/pods";
  return Object.fromEntries(Object.entries(summary).map(([cluster, c]) => [cluster, c.watch[path] ?? 0]));
}
