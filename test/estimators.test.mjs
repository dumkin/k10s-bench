import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ESTIMATORS,
  HARNESS,
  QUICK,
  TIMING,
  cpuPercent,
  dataIn,
  logMetrics,
  logStreamingAt,
  logWindow,
  memoryIn,
  noiseVerdict,
  peak,
  sampleAt,
  settle,
  wakeupsPerSecond,
  windowsFor,
} from "../lib/estimators.mjs";

/** A launch on the wall clock, as in a real run. */
const T0 = 1_759_650_000_000;

/**
 * Probe samples every 100 ms from T0 to T0 + `to`, from what happens in each step, as functions of the ms since T0:
 * CPU in % of a core, bytes downloaded and wakeups a second, memory in bytes. The counters add up, as the probe's do.
 */
function samplesOf({ to, cpu = () => 0, down = () => 0, wake = () => 0, mem = () => 100e6 }) {
  const samples = [];
  let cpuNs = 0;
  let bytes = 0;
  let wakeups = 0;
  for (let ms = 0; ms <= to; ms += 100) {
    samples.push({ t: T0 + ms, mem: mem(ms), cpu: cpuNs, wake: wakeups, down: bytes });
    cpuNs += cpu(ms) * 1e6; // that % of a core for 100 ms, in ns
    bytes += down(ms) / 10;
    wakeups += wake(ms) / 10;
  }
  return samples;
}

/** Proxy events every 10 ms over [from, to), in ms since T0, at `perSecond` bytes a second. */
function streamOf(from, to, perSecond) {
  const events = [];
  for (let ms = from; ms < to; ms += 10) events.push([T0 + ms, perSecond / 100]);
  return events;
}

describe("what the results record", () => {
  test("the harness version, and the estimators in one line", () => {
    assert.equal(HARNESS, 2);
    assert.ok(!ESTIMATORS.includes("\n"));
    assert.ok(ESTIMATORS.startsWith("ready:hook|data("));
  });

  test("QUICK only shortens TIMING's windows", () => {
    for (const [key, ms] of Object.entries(QUICK)) assert.ok(ms < TIMING[key], key);
  });
});

describe("reading samples", () => {
  const samples = samplesOf({ to: 10_000, cpu: (ms) => (ms < 5_000 ? 50 : 10), wake: () => 40, mem: (ms) => 100e6 + ms * 1_000 });

  test("the last sample at or before a moment", () => {
    assert.equal(sampleAt(samples, T0 + 250).t, T0 + 200);
    assert.equal(sampleAt(samples, T0 + 300).t, T0 + 300);
    assert.equal(sampleAt(samples, T0 + 99_999).t, T0 + 10_000);
    assert.equal(sampleAt(samples, T0 - 1), null);
    assert.equal(sampleAt([], T0), null);
  });

  test("CPU and wakeups between two moments", () => {
    assert.equal(cpuPercent(samples, T0, T0 + 5_000), 50);
    assert.equal(cpuPercent(samples, T0 + 5_000, T0 + 10_000), 10);
    assert.equal(cpuPercent(samples, T0, T0 + 10_000), 30);
    assert.equal(wakeupsPerSecond(samples, T0 + 1_000, T0 + 9_000), 40);
    assert.equal(cpuPercent(samples, T0 + 3_000, T0 + 3_050), null);
    assert.equal(cpuPercent(samples, T0 - 5_000, T0 + 3_000), null);
  });

  test("memory: the median and the highest sample", () => {
    assert.deepEqual(memoryIn(samples, T0 + 1_000, T0 + 2_000), { median: 101.5e6, max: 102e6 });
    assert.equal(memoryIn(samples, T0 + 20_000, T0 + 30_000), null);
  });
});

describe("dataIn", () => {
  // A paginated list: pages of 400 KB in 200 ms, 1.5 s apart (longer than the quiet second), then heartbeats.
  const page = (from) => Array.from({ length: 20 }, (_, i) => [T0 + from + i * 10, 20_000]);
  const heartbeats = (from, to) => Array.from({ length: (to - from) / 100 }, (_, i) => [T0 + from + i * 100, 100]);
  const list = [...page(1_000), ...page(2_700), ...page(4_400), ...heartbeats(4_700, 9_000)];

  test("a pause between pages doesn't pass for the end before the minimum came", () => {
    // 35,000 objects: at least 1.05 MB, which only the third page brings.
    assert.equal(dataIn(list, T0, { expect: 35_000 }), T0 + 4_590);
  });

  test("with a minimum the first page meets, the pause after it ends it", () => {
    assert.equal(dataIn(list, T0, { expect: 10_000 }), T0 + 1_190);
  });

  test("a burst, then quiet", () => {
    assert.equal(dataIn([...page(500), ...heartbeats(800, 3_000)], T0, { expect: 10_000 }), T0 + 690);
  });

  test("only once the record shows that the quiet second passed", () => {
    const burst = page(500);
    assert.equal(dataIn(burst, T0, { expect: 10_000 }), null);
    assert.equal(dataIn(burst, T0, { expect: 10_000, until: T0 + 1_689 }), null);
    assert.equal(dataIn(burst, T0, { expect: 10_000, until: T0 + 1_690 }), T0 + 690);
  });

  test("never, if the minimum never came", () => {
    assert.equal(dataIn(list, T0, { expect: 50_000, until: T0 + 10_000 }), null);
  });

  test("counts only what came since t0", () => {
    assert.equal(dataIn(list, T0 + 2_000, { expect: 35_000, until: T0 + 10_000 }), null);
  });
});

describe("settle", () => {
  // Loading: 3 s at a full core, downloading 2 MB a second.
  const loading = (ms) => ms < 3_000;
  // k9s-like: from 4 s on, 200 ms at 40% of a core every 2 s and 1% in between, under 5% over any 2 s.
  const redraw = (ms) => (ms >= 4_000 && (ms - 4_000) % 2_000 < 200 ? 40 : 1);
  const redrawing = samplesOf({ to: 20_000, cpu: (ms) => (loading(ms) ? 100 : redraw(ms)), down: (ms) => (loading(ms) ? 2e6 : 0) });

  test("an app that redraws every 2 s is quiet once that averages out", () => {
    assert.equal(settle(redrawing, T0, T0 + 20_000), T0 + 3_000);
  });

  test("never, if the redraws cost more than that", () => {
    const heavy = (ms) => (ms % 2_000 < 800 ? 40 : 1);
    const samples = samplesOf({ to: 20_000, cpu: (ms) => (loading(ms) ? 100 : heavy(ms)), down: (ms) => (loading(ms) ? 2e6 : 0) });
    assert.equal(settle(samples, T0, T0 + 20_000), null);
  });

  test("a pause followed by more work within the hold doesn't count", () => {
    // One list, 2.5 s of quiet (longer than a window), another list, then quiet for good.
    const busy = (ms) => ms < 3_000 || (ms >= 5_500 && ms < 8_500);
    const samples = samplesOf({ to: 20_000, cpu: (ms) => (busy(ms) ? 100 : 1), down: (ms) => (busy(ms) ? 2e6 : 0) });
    assert.equal(settle(samples, T0, T0 + 20_000), T0 + 8_500);
    // Without the hold, the pause would pass for the end.
    assert.equal(settle(samples, T0, T0 + 20_000, { settleHold: 0 }), T0 + 3_000);
  });

  test("downloading is work too", () => {
    const samples = samplesOf({ to: 20_000, cpu: () => 1, down: (ms) => (ms < 6_000 ? 1e6 : 0) });
    assert.equal(settle(samples, T0, T0 + 20_000), T0 + 6_000);
  });

  test("only as far as the samples and `until` reach", () => {
    // Quiet from 3 s needs samples up to 3 + 3 (hold) + 2 (window) = 8 s.
    assert.equal(settle(redrawing, T0, T0 + 7_999), null);
    assert.equal(settle(redrawing, T0, T0 + 8_000), T0 + 3_000);
    assert.equal(settle(redrawing.filter((s) => s.t <= T0 + 7_900), T0, Infinity), null);
  });

  test("from the moment asked", () => {
    assert.equal(settle(redrawing, T0 + 5_050, T0 + 20_000), T0 + 5_100);
  });
});

describe("peak", () => {
  // Memory climbs from 100 to 200 MB over the first 5 s and stays there.
  const climb = (ms) => Math.min(200e6, 100e6 + ms * 20_000);
  const spiky = samplesOf({ to: 10_000, mem: (ms) => (ms === 2_500 ? 500e6 : climb(ms)) });

  test("ignores a single odd sample", () => {
    assert.deepEqual(peak(spiky, T0, T0 + 10_000), { bytes: 200e6, at: T0 + 5_000 });
  });

  test("but not a high that lasts", () => {
    const samples = samplesOf({ to: 10_000, mem: (ms) => (ms >= 2_400 && ms <= 2_600 ? 500e6 : climb(ms)) });
    assert.deepEqual(peak(samples, T0, T0 + 10_000), { bytes: 500e6, at: T0 + 2_400 });
  });

  test("judges the window's edges with the samples next to them", () => {
    assert.deepEqual(peak(spiky, T0 + 2_500, T0 + 2_500), { bytes: 152e6, at: T0 + 2_500 });
    assert.equal(peak(spiky, T0 + 20_000, T0 + 30_000), null);
  });
});

describe("windowsFor", () => {
  test("an app ready early is measured at the fixed age", () => {
    assert.deepEqual(windowsFor({ t0: T0, ready: T0 + 5_000 }), { idle: [T0 + 45_000, T0 + 75_000] });
  });

  test("an app ready late, some time after it was ready", () => {
    assert.deepEqual(windowsFor({ t0: T0, ready: T0 + 40_000 }), { idle: [T0 + 60_000, T0 + 90_000] });
  });

  test("churn starts where idle ends, and is measured after its warm-up", () => {
    assert.deepEqual(windowsFor({ t0: T0, ready: T0 + 5_000, churn: true }), {
      idle: [T0 + 45_000, T0 + 75_000],
      churn: [T0 + 85_000, T0 + 115_000],
      churnStart: T0 + 75_000,
    });
  });

  test("quick runs lay QUICK over TIMING", () => {
    assert.deepEqual(windowsFor({ t0: T0, ready: T0 + 1_000, timing: QUICK, churn: true }), {
      idle: [T0 + 8_000, T0 + 13_000],
      churn: [T0 + 16_000, T0 + 21_000],
      churnStart: T0 + 13_000,
    });
  });

  test("an app that never got ready is measured at the fixed age", () => {
    assert.deepEqual(windowsFor({ t0: T0, ready: null }), { idle: [T0 + 45_000, T0 + 75_000] });
  });
});

describe("logWindow", () => {
  test("from 10 s after the log showed, and not before the app is 45 s old", () => {
    assert.deepEqual(logWindow({ t0: T0, shown: T0 + 50_000 }), [T0 + 60_000, T0 + 120_000]);
    assert.deepEqual(logWindow({ t0: T0, shown: T0 + 10_000 }), [T0 + 45_000, T0 + 105_000]);
    assert.deepEqual(logWindow({ t0: T0, shown: T0 + 2_000, timing: QUICK }), [T0 + 8_000, T0 + 16_000]);
  });
});

describe("logStreamingAt", () => {
  // The log writes 75 KB a second: 60% of 4 s of it is 180 KB.
  const rate = 75_000;
  const backlog = Array.from({ length: 10 }, (_, i) => [T0 + 1_000 + i * 10, 25_000]);

  test("not at the backlog loaded at once, but where the app follows the log", () => {
    assert.equal(logStreamingAt([...backlog, ...streamOf(8_000, 30_000, rate)], T0, rate), T0 + 8_000);
    // One window alone would take the backlog for it.
    assert.equal(logStreamingAt(backlog, T0, rate, { windows: 1 }), T0 + 1_000);
  });

  test("from the start, for an app that follows it right away", () => {
    assert.equal(logStreamingAt(streamOf(500, 30_000, rate), T0, rate), T0 + 500);
  });

  test("never at too small a share of the rate", () => {
    assert.equal(logStreamingAt(streamOf(500, 30_000, 40_000), T0, rate), null);
    assert.equal(logStreamingAt(streamOf(500, 30_000, 40_000), T0, rate, { share: 0.5 }), T0 + 500);
  });

  test("nothing past the end of the record", () => {
    assert.equal(logStreamingAt(streamOf(8_000, 30_000, rate), T0, rate, { until: T0 + 10_000 }), null);
  });
});

describe("logMetrics", () => {
  // A minute of the log, from 60 to 120 s after the start.
  const from = T0 + 60_000;
  const to = T0 + 120_000;
  // A collector that frees 3.5 MB of garbage every 7 s.
  const garbage = (ms) => 0.5e6 * ((ms % 7_000) / 1_000);

  test("memory growing by 0.1 MB a second under a sawtooth", () => {
    const samples = samplesOf({ to: 130_000, cpu: () => 12, wake: () => 50, down: () => 10_000, mem: (ms) => 300e6 + 100 * ms + garbage(ms) });
    const m = logMetrics(samples, from, to);
    assert.equal(m.cpuPct, 12);
    assert.equal(m.wakeupsPerSec, 50);
    assert.equal(m.downKBPerMin, 600);
    assert.ok(Math.abs(m.slopeMBPerMin - 6) <= 0.3, `slope ${m.slopeMBPerMin}`);
    // The medians of the last and the first 20 s lie 40 s apart.
    assert.ok(Math.abs(m.growth20sMB - 4) <= 0.3, `growth ${m.growth20sMB}`);
    assert.ok(m.memEndMB > m.memStartMB);
    // The highest sample: just before the collection at 119 s.
    assert.equal(m.peakMB, 315.3);
  });

  test("memory shrinking", () => {
    const m = logMetrics(samplesOf({ to: 130_000, mem: (ms) => 400e6 - 50 * ms + garbage(ms) }), from, to);
    assert.ok(Math.abs(m.slopeMBPerMin + 3) <= 0.3, `slope ${m.slopeMBPerMin}`);
    assert.ok(m.growth20sMB < 0);
  });

  test("memory that stays put has no trend", () => {
    const m = logMetrics(samplesOf({ to: 130_000, mem: (ms) => 250e6 + garbage(ms) }), from, to);
    assert.ok(Math.abs(m.slopeMBPerMin) <= 0.2, `slope ${m.slopeMBPerMin}`);
  });

  test("start and end over the tails asked for", () => {
    const samples = samplesOf({ to: 130_000, mem: (ms) => 300e6 + 100 * ms });
    assert.deepEqual(
      [logMetrics(samples, from, to), logMetrics(samples, from, to, { tailMs: 4_000 })].map((m) => [m.memStartMB, m.memEndMB, m.growth20sMB, m.slopeMBPerMin]),
      [
        [307, 311, 4, 6],
        [306.2, 311.8, 5.6, 6],
      ],
    );
  });

  test("null for what the samples can't tell", () => {
    assert.deepEqual(logMetrics([], from, to), {
      cpuPct: null,
      memEndMB: null,
      memStartMB: null,
      slopeMBPerMin: null,
      growth20sMB: null,
      peakMB: null,
      wakeupsPerSec: null,
      downKBPerMin: null,
    });
  });
});

describe("noiseVerdict", () => {
  const calm = { otherPct: 2, otherMax1sPct: 30, thermal: "nominal", lowPower: false, onAC: true, displayAsleep: false, frontmostFrac: 1, memPressure: "normal", swapouts: 0 };
  const noise = ({ startup, idle, churn, logs, prelaunch = { timedOut: false }, rate = { achievedRate: 100, target: 100, failed: false } } = {}) => ({
    prelaunch,
    windows: { startup: { ...calm, otherPct: 20, ...startup }, idle: { ...calm, ...idle }, churn: { ...calm, ...churn }, ...(logs && { logs: { ...calm, ...logs } }) },
    churn: rate,
  });

  test("a clean run has no reasons", () => {
    assert.deepEqual(noiseVerdict(noise()), []);
  });

  test("a hot Mac, but not a warm one", () => {
    assert.deepEqual(noiseVerdict(noise({ idle: { thermal: "serious" } })), ["thermal serious in idle"]);
    assert.deepEqual(noiseVerdict(noise({ idle: { thermal: "fair" } })), []);
  });

  test("other processes busy, but not while the app starts", () => {
    assert.deepEqual(noiseVerdict(noise({ churn: { otherPct: 26 } })), ["other CPU 26% in churn"]);
    assert.deepEqual(noiseVerdict(noise({ startup: { otherPct: 300, otherMax1sPct: 350 } })), []);
    assert.deepEqual(noiseVerdict(noise({ logs: { otherMax1sPct: 230 } })), ["other CPU 230% for a second in logs"]);
    assert.deepEqual(noiseVerdict(noise({ logs: { otherMax1sPct: 180 } })), []);
    assert.deepEqual(noiseVerdict(noise({ churn: { otherPct: 26 } }), { otherIdlePct: 30 }), []);
  });

  test("not in front, rounded down, unless it is a terminal client", () => {
    assert.deepEqual(noiseVerdict(noise({ idle: { frontmostFrac: 0.82 } })), ["not frontmost in idle (82%)"]);
    assert.deepEqual(noiseVerdict(noise({ idle: { frontmostFrac: 0.946 } })), ["not frontmost in idle (94%)"]);
    assert.deepEqual(noiseVerdict(noise({ idle: { frontmostFrac: 0.82 } }), { requireFrontmost: false }), []);
  });

  test("power, display and memory, in the order of the windows", () => {
    const run = noise({ startup: { onAC: false }, idle: { lowPower: true, displayAsleep: true, memPressure: "warn", swapouts: 3 } });
    assert.deepEqual(noiseVerdict(run), ["on battery in startup", "low power mode in idle", "display asleep in idle", "memory pressure warn in idle", "3 swapouts in idle"]);
  });

  test("churn short of its rate", () => {
    assert.deepEqual(noiseVerdict(noise({ rate: { achievedRate: 96, target: 100, failed: false } })), ["churn 96/s of 100/s"]);
    assert.deepEqual(noiseVerdict(noise({ rate: { achievedRate: 99.2, target: 100, failed: false } })), []);
    assert.deepEqual(noiseVerdict(noise({ rate: { achievedRate: 0, target: 100, failed: true } })), ["churn failed"]);
  });

  test("a pre-launch wait that gave up", () => {
    assert.deepEqual(noiseVerdict(noise({ prelaunch: { timedOut: true } })), ["pre-launch wait timed out"]);
  });

  test("whatever is missing says nothing", () => {
    assert.deepEqual(noiseVerdict({ windows: { idle: {} } }), []);
    assert.deepEqual(noiseVerdict({}), []);
  });
});
