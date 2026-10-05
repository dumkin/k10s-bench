// Statistics for a benchmark that decides for itself how many runs are enough: medians and the order statistics
// that bound them, a trend that a garbage collector's sawtooth doesn't sway, and checks for runs that fall into two
// groups. Pure functions of plain arrays. A value a run couldn't measure (null, NaN) is left out, never taken for 0.

const finite = (values) => values.filter((x) => Number.isFinite(x));

/** The median; of an even number of values, the mean of the middle two. Null if there are none. */
export function median(values) {
  const v = finite(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Which sorted values bound the median, by how many there are: k for [x_k, x_(n+1−k)], 1-based. Five and six runs
 * keep their full range, which covers the true median 93.8% and 96.9% of the time; eight and nine drop the lowest
 * and the highest value (93.0% and 96.1%). Seven drop them too, at 87.5%: less sure than the rest, but it lets one
 * stray value among the first five cost two more runs instead of three.
 */
const INTERVAL_K = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 2 };
/**
 * Past nine runs, the binomial rule: the largest k whose interval still covers the median this often, i.e.
 * P(k ≤ B ≤ n − k) for B ~ Binomial(n, ½). 93% to the nearest percent, which is what eight runs' [x2, x7] covers.
 */
const COVERAGE = 0.925;

function binomialK(n) {
  // P(B = i) term by term, in logs: 2^−n underflows for long series.
  let logTerm = -n * Math.LN2;
  let below = Math.exp(logTerm); // P(B ≤ k − 1): what [x_k, x_(n+1−k)] misses at each end
  let k = 1;
  while (2 * (k + 1) <= n + 1) {
    logTerm += Math.log((n - k + 1) / k);
    const next = below + Math.exp(logTerm);
    if (1 - 2 * next < COVERAGE) break;
    below = next;
    k++;
  }
  return k;
}

/**
 * The interval of the median that decides when to stop adding runs, from the order statistics above: under five
 * values, their full range. { lo, hi, n }, with lo and hi null if there are no values.
 */
export function medianInterval(values) {
  const v = finite(values).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { lo: null, hi: null, n: 0 };
  const k = n < 5 ? 1 : (INTERVAL_K[n] ?? binomialK(n));
  return { lo: v[k - 1], hi: v[n - k], n };
}

/**
 * Whether the median is known well enough: its interval no wider than `rel` of it, or than `floor`. The floor is
 * for metrics that are small next to their noise: an idle CPU of 0.3% that wobbles by 0.2 points is known well enough.
 */
export function converged(values, { rel = 0.1, floor = 0 } = {}) {
  const { lo, hi, n } = medianInterval(values);
  return n > 0 && hi - lo <= Math.max(rel * Math.abs(median(values)), floor);
}

/**
 * The slope through points [[x, y]] by Theil–Sen: the median of the slopes between every two of them with different
 * x. Memory that grows under a garbage collector's sawtooth drops at every collection; a median of slopes isn't
 * pulled around by those drops the way a least-squares line is. Null with fewer than two different x.
 */
export function theilSen(points) {
  const p = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const slopes = [];
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      if (p[j][0] !== p[i][0]) slopes.push((p[j][1] - p[i][1]) / (p[j][0] - p[i][0]));
    }
  }
  return median(slopes);
}

/**
 * Each value replaced by the median of the `k` values centered on it (an even k takes one more after it than before);
 * near the ends, of those there are. Centered, so that a peak stays where it was instead of moving k/2 values later.
 */
export function rollingMedian(values, k) {
  const size = Math.max(1, Math.round(k));
  const before = (size - 1) >> 1;
  const after = size - 1 - before;
  return values.map((_, i) => median(values.slice(Math.max(0, i - before), i + after + 1)));
}

/**
 * Whether the values fall into two groups, as when a client is sometimes slow for a reason the runs don't record:
 * split at the widest gap between neighbours, with two values or more on each side, a gap wider than twice the spread
 * of either side and wider than `tolerance`. Null if not, else both sides (sorted) and the gap.
 */
export function bimodal(values, { tolerance = 0 } = {}) {
  const v = finite(values).sort((a, b) => a - b);
  let at = 0;
  let gap = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] > gap) {
      gap = v[i] - v[i - 1];
      at = i;
    }
  }
  if (at < 2 || v.length - at < 2) return null;
  const low = v.slice(0, at);
  const high = v.slice(at);
  const spread = Math.max(low.at(-1) - low[0], high.at(-1) - high[0]);
  if (gap <= 2 * spread || gap <= tolerance) return null;
  return { low, high, gap };
}

/**
 * Whether a metric depends on something recorded with each run (the power source, the display, the position in the
 * round): the runs grouped by `label` (a field name, or a function of the run), and if two groups or more have two
 * runs each and their medians differ by more than `tolerance`, those groups as [{ label, n, median }], lowest median
 * first; else null. One run says nothing about its group, so smaller groups are left out, and so are runs without
 * the label (undefined) or without a value.
 */
export function splitByLabel(runs, label, metricOf, tolerance = 0) {
  const labelOf = typeof label === "function" ? label : (run) => run[label];
  const groups = new Map();
  for (const run of runs) {
    const key = labelOf(run);
    const value = metricOf(run);
    if (key === undefined || !Number.isFinite(value)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  const big = [...groups]
    .filter(([, values]) => values.length >= 2)
    .map(([key, values]) => ({ label: key, n: values.length, median: median(values) }))
    .sort((a, b) => a.median - b.median);
  if (big.length < 2 || big.at(-1).median - big[0].median <= tolerance) return null;
  return big;
}

/** The lowest and the highest of the finite values, or null if there are none. */
export function range(values) {
  const v = finite(values);
  if (!v.length) return null;
  return { min: v.reduce((a, b) => Math.min(a, b)), max: v.reduce((a, b) => Math.max(a, b)) };
}
