// From a run's raw record to its numbers. The record is the probe's samples (every 100 ms, sorted by t: memory summed
// over the app's processes, CPU time and wakeups summed over every process it ever had, and the bytes downloaded
// through the proxies so far) and the proxies' byte events ([t, bytes] in 10 ms buckets, summed over the proxies).
// Pure functions of those arrays: every estimator can be tested on made-up runs, and a results file read again when
// one is fixed. HARNESS and ESTIMATORS go into the results, so that numbers measured differently aren't compared.

import { median, rollingMedian, theilSen } from "./stats.mjs";

/** The version of the harness that recorded a run; it goes up whenever what a run records changes meaning. */
export const HARNESS = 2;
/** Every estimator in one line, kept with the results: what their numbers mean. */
export const ESTIMATORS =
  "ready:hook|data(proxy 10ms, 30B/obj, <16KB in 1s); settle:2s<10%&<64KB held 3s; peak:max 3-sample rolling median [t0,idleFrom]; idle:max(ready+20s,t0+45s) 30s; logs:max(shown+10s,t0+45s) 60s, mem last 20s, growth Theil-Sen";

/**
 * How long things are watched and what counts as quiet, in ms, bytes and % of one core. The idle and log windows
 * begin at a fixed age of the app as well as some time after it is ready: an app that is ready early is still settling
 * then (caches, JIT, its first collections), and would otherwise be measured younger than the others.
 */
export const TIMING = {
  afterReady: 20_000,
  fixedAge: 45_000,
  idleWindow: 30_000,
  churnWarmup: 10_000,
  churnWindow: 30_000,
  logWarmup: 10_000,
  logWindow: 60_000,
  logMemTail: 20_000,
  // Quiet: under 10% of a core and 64 KB in every 2 s that starts within 3 s.
  settleCpu: 10,
  settleBytes: 65_536,
  settleWindow: 2_000,
  settleHold: 3_000,
  // The data is in: 30 bytes per expected object at least (compressed, a pod is some 500, a namespace some 50), then
  // under 16 KB in a second.
  dataPerObject: 30,
  dataQuietBytes: 16_384,
  dataQuietMs: 1_000,
  timeout: 240_000,
};
/** A smoke test of every scenario and client: the same steps with much shorter windows, laid over TIMING. */
export const QUICK = { afterReady: 3_000, fixedAge: 8_000, idleWindow: 5_000, churnWarmup: 3_000, churnWindow: 5_000, logWarmup: 3_000, logWindow: 8_000, logMemTail: 4_000 };

const sampleTime = (s) => s.t;
const eventTime = (e) => e[0];

/** How many items come before `t` (`inclusive`: at or before it). A binary search: a run has thousands of samples. */
function countBefore(list, t, timeOf, inclusive = false) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = timeOf(list[mid]);
    if (at < t || (inclusive && at === t)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The samples in [from, to]. */
const within = (samples, from, to) => samples.slice(countBefore(samples, from, sampleTime), countBefore(samples, to, sampleTime, true));

/** prefix[i]: the bytes of the first i events, so that the bytes of any stretch are one subtraction. */
function prefixSums(events) {
  const prefix = [0];
  for (const [, bytes] of events) prefix.push(prefix.at(-1) + bytes);
  return prefix;
}

/** MB with one decimal, as everywhere in the results (`+ 0` turns the −0 of a tiny negative into 0). */
const mb = (bytes) => (bytes == null ? null : Math.round((bytes / 1e6) * 10) / 10 + 0);
const oneDecimal = (v) => (v == null ? null : Math.round(v * 10) / 10 + 0);

/** The last sample at or before `t`, or null. */
export function sampleAt(samples, t) {
  return samples[countBefore(samples, t, sampleTime, true) - 1] ?? null;
}

/** Average CPU use between two moments, in % of one core, from the last sample at or before each. */
export function cpuPercent(samples, from, to) {
  const a = sampleAt(samples, from);
  const b = sampleAt(samples, to);
  if (!a || !b || b.t <= a.t) return null;
  return ((b.cpu - a.cpu) / 1e6 / (b.t - a.t)) * 100;
}

/** Wakeups a second between two moments, from the last sample at or before each. */
export function wakeupsPerSecond(samples, from, to) {
  const a = sampleAt(samples, from);
  const b = sampleAt(samples, to);
  if (!a || !b || b.t <= a.t) return null;
  return ((b.wake - a.wake) / (b.t - a.t)) * 1000;
}

/** Memory in [from, to]: the median and the highest sample, in bytes; null without samples. */
export function memoryIn(samples, from, to) {
  const mem = within(samples, from, to).map((s) => s.mem);
  if (!mem.length) return null;
  return { median: median(mem), max: mem.reduce((a, b) => Math.max(a, b)) };
}

/**
 * When the initial data was in, for the apps the benchmark can't read: the first event from which, once `perObject`
 * bytes per expected object came since `t0`, less than `quietBytes` arrive in the next `quietMs`. The minimum keeps a
 * pause between two pages of a paginated list from passing for the end. The record must also show that the quiet time
 * passed (a later event, or `until`, where the record ends), or a recording cut short would look done. Epoch ms, or null.
 */
export function dataIn(events, t0, { expect = 0, perObject = TIMING.dataPerObject, quietBytes = TIMING.dataQuietBytes, quietMs = TIMING.dataQuietMs, until } = {}) {
  const need = (expect ?? 0) * perObject;
  const prefix = prefixSums(events);
  const recordEnd = Math.max(until ?? -Infinity, events.at(-1)?.[0] ?? -Infinity);
  let got = 0;
  for (let i = countBefore(events, t0, eventTime); i < events.length; i++) {
    const t = events[i][0];
    got += events[i][1];
    // Two events in one bucket are one moment: it is judged with both.
    if (events[i + 1]?.[0] === t || got < need) continue;
    // Any later moment would need a longer record still.
    if (recordEnd < t + quietMs) return null;
    if (prefix[countBefore(events, t + quietMs, eventTime, true)] - prefix[i + 1] < quietBytes) return t;
  }
  return null;
}

/**
 * When the app went quiet: the first sample from which every window of `settleWindow` that starts within the next
 * `settleHold` brings less than `settleCpu` % of a core and `settleBytes` downloaded. Averaging over a window lets an
 * app that redraws every 2 s (k9s) count as quiet; holding it keeps a pause between two pieces of work (one list in,
 * the next not yet asked for) from counting. Null if it never was, as far as the samples up to `until` tell.
 */
export function settle(samples, from, until = Infinity, { settleCpu = TIMING.settleCpu, settleBytes = TIMING.settleBytes, settleWindow = TIMING.settleWindow, settleHold = TIMING.settleHold } = {}) {
  const end = Math.min(until ?? Infinity, samples.at(-1)?.t ?? -Infinity);
  const quiet = (s) => {
    const cpu = cpuPercent(samples, s.t, s.t + settleWindow);
    const last = sampleAt(samples, s.t + settleWindow);
    return cpu != null && cpu < settleCpu && (last.down ?? 0) - (s.down ?? 0) < settleBytes;
  };
  let i = countBefore(samples, from, sampleTime);
  while (i < samples.length) {
    const t = samples[i].t;
    if (t + settleHold + settleWindow > end) return null;
    let j = i;
    while (j < samples.length && samples[j].t <= t + settleHold && quiet(samples[j])) j++;
    if (j === samples.length || samples[j].t > t + settleHold) return t;
    // A loud window starts within the hold of every sample from t up to it: the next candidate comes after it.
    i = j + 1;
  }
  return null;
}

/**
 * The highest memory in [from, to], not fooled by one odd sample: the highest median of three samples in a row, each
 * sample with its two neighbours (those just outside the window too). { bytes, at } or null.
 */
export function peak(samples, from, to) {
  const first = countBefore(samples, from, sampleTime);
  const end = countBefore(samples, to, sampleTime, true);
  if (first >= end) return null;
  const offset = Math.max(0, first - 1);
  const smooth = rollingMedian(samples.slice(offset, end + 1).map((s) => s.mem), 3);
  let best = null;
  for (let i = first; i < end; i++) {
    const bytes = smooth[i - offset];
    if (bytes != null && (!best || bytes > best.bytes)) best = { bytes, at: samples[i].t };
  }
  return best;
}

/**
 * Where a run's idle window lies, and its churn window if pods change: idle from `afterReady` after the app was ready,
 * but not before it is `fixedAge` old; churn from the end of idle, when the pods begin to change, measured after
 * `churnWarmup`. An app that never got ready is measured at the fixed age (its run is an error anyway).
 * { idle: [from, to] }, and with `churn` also { churn: [from, to], churnStart }.
 */
export function windowsFor({ t0, ready, timing = TIMING, churn = false }) {
  const T = { ...TIMING, ...timing };
  const from = Math.max((ready ?? t0) + T.afterReady, t0 + T.fixedAge);
  const idle = [from, from + T.idleWindow];
  if (!churn) return { idle };
  const churnStart = idle[1];
  const churnFrom = churnStart + T.churnWarmup;
  return { idle, churn: [churnFrom, churnFrom + T.churnWindow], churnStart };
}

/** The log window, [from, to]: from `logWarmup` after the log showed, and not before the app is `fixedAge` old. */
export function logWindow({ t0, shown, timing = TIMING }) {
  const T = { ...TIMING, ...timing };
  const from = Math.max((shown ?? t0) + T.logWarmup, t0 + T.fixedAge);
  return [from, from + T.logWindow];
}

/**
 * When an app began to follow the log as it comes, from the bytes it downloads: the first event from which each of
 * `windows` windows of `windowMs` in a row brings at least `share` of what the log writes in that time. The backlog an
 * app loads first is one burst, which fills one window and not the next. Events after `until` (where the record ends)
 * are left out. Epoch ms, or null.
 */
export function logStreamingAt(events, t0, bytesPerSec, { share = 0.6, windowMs = 4_000, windows = 2, until = Infinity } = {}) {
  const seen = events.slice(0, countBefore(events, until ?? Infinity, eventTime, true));
  const prefix = prefixSums(seen);
  const bytesIn = (from, to) => prefix[countBefore(seen, to, eventTime)] - prefix[countBefore(seen, from, eventTime)];
  const need = (share * bytesPerSec * windowMs) / 1000;
  for (let i = countBefore(seen, t0, eventTime); i < seen.length; i++) {
    const t = seen[i][0];
    let full = 0;
    while (full < windows && bytesIn(t + full * windowMs, t + (full + 1) * windowMs) >= need) full++;
    if (full === windows) return t;
  }
  return null;
}

/**
 * The numbers of the log window. A log view's memory saws up and down with each collection, so its start and end are
 * the medians of the window's first and last `tailMs` (growth20sMB is the difference), and its trend is the Theil–Sen
 * slope of one-second medians, in MB a minute. Rounded as in the results (MB and % to 0.1); a number the samples
 * can't give is null.
 */
export function logMetrics(samples, from, to, { tailMs = TIMING.logMemTail } = {}) {
  const start = memoryIn(samples, from, from + tailMs);
  const end = memoryIn(samples, to - tailMs, to);
  const seconds = new Map();
  for (const s of within(samples, from, to)) {
    const second = Math.floor((s.t - from) / 1000);
    if (!seconds.has(second)) seconds.set(second, []);
    seconds.get(second).push(s.mem / 1e6);
  }
  const slope = theilSen([...seconds].map(([second, mem]) => [second, median(mem)]));
  const a = sampleAt(samples, from);
  const b = sampleAt(samples, to);
  const down = a && b && b.t > a.t && Number.isFinite(a.down) && Number.isFinite(b.down) ? ((b.down - a.down) / 1e3) * (60_000 / (b.t - a.t)) : null;
  const wakeups = wakeupsPerSecond(samples, from, to);
  return {
    cpuPct: oneDecimal(cpuPercent(samples, from, to)),
    memEndMB: mb(end?.median),
    memStartMB: mb(start?.median),
    slopeMBPerMin: slope == null ? null : oneDecimal(slope * 60),
    growth20sMB: start && end ? mb(end.median - start.median) : null,
    peakMB: mb(memoryIn(samples, from, to)?.max),
    wakeupsPerSec: wakeups == null ? null : Math.round(wakeups),
    downKBPerMin: down == null ? null : Math.round(down),
  };
}

/** What makes a run noisy, unless the harness says otherwise (see noiseVerdict). */
export const NOISE = { otherIdlePct: 25, otherMax1sPct: 200, frontmostMin: 0.95, churnMinShare: 0.99, requireFrontmost: true };

const NOISE_WINDOWS = ["startup", "idle", "churn", "logs"];
/** The thermal states in which macOS slows the CPU down; "fair" is only warm. */
const HOT = new Set(["serious", "critical"]);
const decimal = (v) => String(Math.round(v * 10) / 10);

/**
 * Why a run is noisy, as short reasons; none if it is clean. Noisy is anything that could have changed its numbers
 * without the app changing: other processes busy past the thresholds, a hot or power-saving Mac, a display asleep,
 * memory pressure or swapping, the app not in front for most of a window (macOS slows hidden windows down; terminal
 * clients pass `requireFrontmost: false`), churn short of its rate, a pre-launch wait for a quiet machine that gave up.
 * Other processes don't count while an app starts: macOS checks and registers any app that launches (its signature,
 * LaunchServices, the Dock), one to two cores' worth in the first second or two, which is part of starting it; the
 * wait for a quiet Mac before the launch is what keeps others out of that window.
 */
export function noiseVerdict(noise, thresholds = {}) {
  const limits = { ...NOISE, ...thresholds };
  const reasons = [];
  if (noise?.prelaunch?.timedOut) reasons.push("pre-launch wait timed out");
  for (const name of NOISE_WINDOWS) {
    const w = noise?.windows?.[name];
    if (!w) continue;
    if (HOT.has(w.thermal)) reasons.push(`thermal ${w.thermal} in ${name}`);
    if (w.lowPower) reasons.push(`low power mode in ${name}`);
    if (w.onAC === false) reasons.push(`on battery in ${name}`);
    if (w.displayAsleep) reasons.push(`display asleep in ${name}`);
    if (w.memPressure != null && w.memPressure !== "normal") reasons.push(`memory pressure ${w.memPressure} in ${name}`);
    if (w.swapouts > 0) reasons.push(`${w.swapouts} swapout${w.swapouts === 1 ? "" : "s"} in ${name}`);
    // Rounded down: 94.6% in front must not read as the 95% it fell short of.
    if (limits.requireFrontmost && Number.isFinite(w.frontmostFrac) && w.frontmostFrac < limits.frontmostMin) {
      reasons.push(`not frontmost in ${name} (${Math.floor(w.frontmostFrac * 100 + 1e-9)}%)`);
    }
    if (name === "startup") continue;
    if (w.otherPct > limits.otherIdlePct) reasons.push(`other CPU ${decimal(w.otherPct)}% in ${name}`);
    if (w.otherMax1sPct > limits.otherMax1sPct) reasons.push(`other CPU ${decimal(w.otherMax1sPct)}% for a second in ${name}`);
  }
  const churn = noise?.churn;
  if (churn?.failed === true) reasons.push("churn failed");
  else if (churn?.target > 0 && Number.isFinite(churn.achievedRate) && churn.achievedRate < limits.churnMinShare * churn.target) {
    reasons.push(`churn ${decimal(churn.achievedRate)}/s of ${decimal(churn.target)}/s`);
  }
  return reasons;
}
