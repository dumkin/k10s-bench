// Which clients run next, and when a cell (one client in one scenario) has had enough runs. Clients take turns in
// rounds, in an order shuffled from a seed: a resumed session repeats it, and no client always comes right after the
// same other one, whose leftovers (files in the disk cache, a warm Mac) would always fall on it. A cell runs until the
// median of every metric that drives the schedule is pinned down, between a minimum and a maximum number of runs.
// Pure functions of the runs recorded so far: nothing here keeps state between calls.

import { converged, median, medianInterval } from "./stats.mjs";

/** FNV-1a, 32 bits, of the text's UTF-8 bytes. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

/** Floats in [0, 1) from a text seed: mulberry32, started from the text's FNV-1a hash. The same text, the same floats. */
export function seededRandom(seedText) {
  let state = fnv1a(String(seedText));
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** The list in a random order (Fisher–Yates), as a new array. */
export function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The order of one round: the same for the same seed, scenario and round, so that a resumed session repeats it. The
 * client that ran last in the previous round doesn't run first: back to back, its second run would find its own files
 * in the disk cache and the Mac warm from it. If 20 more shuffles all start with it too, the order is rotated by one,
 * which puts it last.
 */
export function roundOrder(clients, { seed, scenario, round, previousLast } = {}) {
  const base = `${seed}/${scenario}/${round}`;
  let order = shuffle(clients, seededRandom(base));
  for (let attempt = 1; attempt <= 20 && order.length > 1 && order[0] === previousLast; attempt++) {
    order = shuffle(clients, seededRandom(`${base}/${attempt}`));
  }
  if (order.length > 1 && order[0] === previousLast) order = [...order.slice(1), order[0]];
  return order;
}

/** A run of the cell's own: neither a warm-up nor one the harness marked as not counting. */
const ownRun = (run) => !run.warmup && run.counted !== false;
/** A run whose numbers stand: without an error, valid and clean. */
const goodRun = (run) => !run.error && !run.invalid && !run.noisy?.length;
/** A run that would have been good but for noise. */
const noisyRun = (run) => !run.error && !run.invalid && run.noisy?.length > 0;

/** A metric's interval now, and the share it takes of the width convergence allows (1 or less: converged). */
function interval(values, rel, floor) {
  const { lo, hi, n } = medianInterval(values);
  if (!n) return { lo: null, hi: null, median: null, ratio: null };
  const mid = median(values);
  const allowed = Math.max(rel * Math.abs(mid), floor);
  return { lo, hi, median: mid, ratio: allowed > 0 ? (hi - lo) / allowed : hi > lo ? Infinity : 0 };
}

function verdict({ n, min, max, open }) {
  if (n < min) return [true, `${n} of ${min} runs`];
  if (n >= max) return [false, `${n} runs, the most`];
  if (open.length) return [true, `not converged: ${open.join(", ")}`];
  return [false, `converged at ${n} runs`];
}

/**
 * needsMore, owed and the reason, from what a cell has: for cellStatus, and for capAt again with a lower max. `pending`:
 * the noisy runs no good run has made up for yet.
 */
function decide(cell, pending) {
  const { n, noisy, errorsInARow, min, max, maxNoisy, attempts, intervals } = cell;
  const limit = max + maxNoisy;
  const open = Object.keys(cell.converged).filter((metric) => !cell.converged[metric]);
  let [needsMore, reason] = verdict({ n, min, max, open });
  if (needsMore && attempts >= limit) [needsMore, reason] = [false, `gave up after ${attempts} runs (${n} good)`];
  const owed = attempts >= limit || n >= max ? 0 : Math.max(0, Math.min(pending, maxNoisy - noisy, limit - attempts));
  if (owed && !needsMore) reason += `; ${owed} noisy run${owed > 1 ? "s" : ""} to repeat`;
  return { n, noisy, owed, errorsInARow, failed: false, converged: cell.converged, needsMore, reason, min, max, maxNoisy, attempts, intervals };
}

/**
 * Where a cell stands, from its runs in the order they ran (records { client, scenario, warmup, counted, noisy,
 * invalid, error, metrics }; warm-ups and runs with `counted: false` are not the cell's, and are left out of all this):
 * - n: good runs (valid, clean, without an error); noisy: runs that were good but for noise;
 * - owed: noisy runs that no later good run has made up for, but only as many as keep the cell within `maxNoisy` noisy
 *   runs should every repeat be noisy too: a client that heats the Mac up itself must not be repeated forever;
 * - errorsInARow: how many of the last runs failed with the very same error; failed: two, and no good run, so the
 *   client can't do this scenario;
 * - converged: per driving metric (`drive`), whether stats.converged holds for it, with `floors[metric]`;
 * - needsMore and its reason;
 * - what that was decided against, for nextRound, projectSeconds and capAt: min, max, maxNoisy, attempts (all of the
 *   cell's runs) and each driving metric's interval now.
 * A cell needs runs until it has `min`, then until every driving metric converged, up to `max`. Convergence is judged
 * from five runs on, except at six, where the verdict of five stands: six runs' interval is still their full range,
 * which a sixth value can only widen; only a shifted median could flip it, and that is no reason to stop. A cell that
 * still needs runs after `max + maxNoisy` of them gives up: a client that fails with a new error every time, or a Mac
 * that stays noisy, must not hold the schedule up forever.
 */
export function cellStatus(runs, { min = 5, max = 9, drive = [], floors = {}, rel = 0.1, maxNoisy = 4 } = {}) {
  const own = runs.filter(ownRun);
  const good = own.filter(goodRun);
  const n = good.length;
  // Each good run makes up for one noisy run before it.
  let pending = 0;
  for (const run of own) {
    if (noisyRun(run)) pending++;
    else if (goodRun(run) && pending > 0) pending--;
  }
  const lastError = own.at(-1)?.error;
  let errorsInARow = 0;
  while (lastError && errorsInARow < own.length && own[own.length - 1 - errorsInARow].error === lastError) errorsInARow++;
  const judged = n === 6 ? good.slice(0, 5) : good;
  const convergedBy = {};
  const intervals = {};
  for (const metric of drive) {
    const floor = floors[metric] ?? 0;
    convergedBy[metric] = n >= 5 && converged(judged.map((run) => run.metrics?.[metric]), { rel, floor });
    intervals[metric] = interval(good.map((run) => run.metrics?.[metric]), rel, floor);
  }
  const cell = { n, noisy: own.filter(noisyRun).length, errorsInARow, converged: convergedBy, min, max, maxNoisy, attempts: own.length, intervals };
  if (errorsInARow >= 2 && n === 0) {
    return { ...decide(cell, 0), owed: 0, failed: true, needsMore: false, reason: `the same error twice: ${lastError}` };
  }
  return decide(cell, pending);
}

/** A cell gets a run this round if it needs more, or owes the repeat of a noisy one. */
const wantsRun = (status) => !status.failed && (status.needsMore || status.owed > 0);

/**
 * The companion for a client left alone in a round: of the converged clients that may still run (n < max), the one
 * whose interval takes the largest share of the width convergence allows (without floors, the widest relative
 * interval), as an extra run helps it most. Alone, a client would run back to back and meet a Mac none of the others
 * met (warm from it, its files in the disk cache); the companion's run counts like any other. Null if there is none.
 */
export function companionFor(cells, alone) {
  let best = null;
  for (const client of Object.keys(cells).sort()) {
    const s = cells[client];
    if (client === alone || s.failed || wantsRun(s) || s.n >= s.max || s.attempts >= s.max + s.maxNoisy) continue;
    if (!Object.values(s.converged).every(Boolean)) continue;
    const width = Math.max(0, ...Object.values(s.intervals ?? {}).map((i) => i.ratio ?? 0));
    if (!best || width > best.width) best = { client, width };
  }
  return best?.client ?? null;
}

/**
 * The clients that run in this round, each once, in roundOrder's order: those whose cells need runs or owe the repeat
 * of a noisy one, and a companion (companionFor) for one left alone. `cells`: { [client]: cellStatus }. The clients are
 * sorted before the shuffle, so that the order doesn't depend on how `cells` was put together.
 */
export function nextRound(cells, { seed, scenario, round, previousLast } = {}) {
  const clients = Object.keys(cells).sort().filter((client) => wantsRun(cells[client]));
  if (clients.length === 1) {
    const companion = companionFor(cells, clients[0]);
    if (companion) clients.push(companion);
  }
  return roundOrder(clients, { seed, scenario, round, previousLast });
}

/** The runs a cell may still take at most: up to its maximum if it needs more, else the noisy runs it owes. */
export function runsLeft(status) {
  if (status.failed) return 0;
  const most = status.needsMore ? Math.max(status.min, status.max) - status.n : status.owed;
  return Math.max(0, Math.min(most, status.max + status.maxNoisy - status.attempts));
}

/**
 * The seconds the cells may still take at most, each one that needs runs going up to its maximum (companions not
 * counted). `perRunSeconds`: one figure for every run, or a function of (client, status).
 */
export function projectSeconds(cells, perRunSeconds) {
  const secondsOf = typeof perRunSeconds === "function" ? perRunSeconds : () => perRunSeconds;
  let total = 0;
  for (const [client, status] of Object.entries(cells)) {
    const left = runsLeft(status);
    if (left > 0) total += left * secondsOf(client, status);
  }
  return total;
}

/**
 * The cells as if none could have more than `cap` runs, to fit a time budget: those that have as many need no more.
 * A cell under `min` still needs its runs, because the minimum is what makes a cell worth reporting at all.
 */
export function capAt(cells, cap) {
  const out = {};
  for (const [client, status] of Object.entries(cells)) {
    out[client] = status.failed || status.max <= cap ? status : decide({ ...status, max: cap }, status.owed);
  }
  return out;
}
