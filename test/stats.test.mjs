import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bimodal, converged, median, medianInterval, range, rollingMedian, splitByLabel, theilSen } from "../lib/stats.mjs";

describe("median", () => {
  test("of an odd and an even number of values", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([7]), 7);
  });

  test("leaves out what a run couldn't measure, and has nothing to say without values", () => {
    assert.equal(median([null, 5, undefined, NaN, Infinity, 1]), 3);
    assert.equal(median([]), null);
    assert.equal(median([null, NaN]), null);
  });
});

describe("medianInterval", () => {
  // 10, 20, … n × 10, in reverse: the order statistics are easy to read off, and the input isn't sorted.
  const values = (n) => Array.from({ length: n }, (_, i) => (n - i) * 10);

  test("five to nine runs: [x1, x5], [x1, x6], [x2, x6], [x2, x7], [x2, x8]", () => {
    assert.deepEqual(medianInterval(values(5)), { lo: 10, hi: 50, n: 5 });
    assert.deepEqual(medianInterval(values(6)), { lo: 10, hi: 60, n: 6 });
    assert.deepEqual(medianInterval(values(7)), { lo: 20, hi: 60, n: 7 });
    assert.deepEqual(medianInterval(values(8)), { lo: 20, hi: 70, n: 8 });
    assert.deepEqual(medianInterval(values(9)), { lo: 20, hi: 80, n: 9 });
  });

  test("the full range under five", () => {
    assert.deepEqual(medianInterval(values(1)), { lo: 10, hi: 10, n: 1 });
    assert.deepEqual(medianInterval(values(2)), { lo: 10, hi: 20, n: 2 });
    assert.deepEqual(medianInterval(values(4)), { lo: 10, hi: 40, n: 4 });
  });

  test("the binomial rule past nine", () => {
    // Ten: [x2, x9] covers 97.9%, [x3, x8] only 89.1%. Eleven: [x3, x9], 93.5%. Sixteen: [x4, x13], since [x5, x12]
    // covers 92.3%, under 93%. Twenty: [x6, x15], 95.9%.
    assert.deepEqual(medianInterval(values(10)), { lo: 20, hi: 90, n: 10 });
    assert.deepEqual(medianInterval(values(11)), { lo: 30, hi: 90, n: 11 });
    assert.deepEqual(medianInterval(values(16)), { lo: 40, hi: 130, n: 16 });
    assert.deepEqual(medianInterval(values(20)), { lo: 60, hi: 150, n: 20 });
  });

  test("counts only measured values", () => {
    assert.deepEqual(medianInterval([50, null, 10, 40, NaN, 30, 20]), { lo: 10, hi: 50, n: 5 });
    assert.deepEqual(medianInterval([null]), { lo: null, hi: null, n: 0 });
  });
});

describe("converged", () => {
  test("an interval within 10% of the median", () => {
    assert.equal(converged([100, 104, 98, 101, 105]), true);
    assert.equal(converged([100, 104, 98, 101, 115]), false);
    assert.equal(converged([100, 104, 98, 101, 115], { rel: 0.2 }), true);
  });

  test("a floor for metrics that are small next to their noise", () => {
    // Idle CPU around 0.3%: 10% of it is 0.03 points, the runs spread over 0.3.
    const cpu = [0.2, 0.5, 0.3, 0.4, 0.25];
    assert.equal(converged(cpu), false);
    assert.equal(converged(cpu, { floor: 0.2 }), false);
    assert.equal(converged(cpu, { floor: 0.5 }), true);
  });

  test("seven runs may converge where five didn't: the stray value drops out", () => {
    assert.equal(converged([100, 101, 99, 100, 140]), false);
    assert.equal(converged([100, 101, 99, 100, 140, 102, 100]), true);
  });

  test("not without values", () => {
    assert.equal(converged([]), false);
  });
});

describe("theilSen", () => {
  test("recovers the trend under a garbage collector's sawtooth", () => {
    // 0.25 MB a second, plus 3 MB of garbage that piles up over 12 s and is collected at once.
    const points = Array.from({ length: 120 }, (_, x) => [x, 100 + 0.25 * x + 3 * ((x % 12) / 12)]);
    const slope = theilSen(points);
    assert.ok(Math.abs(slope / 0.25 - 1) < 0.05, `slope ${slope}`);
  });

  test("is not pulled by a few outliers", () => {
    const points = Array.from({ length: 30 }, (_, x) => [x, 2 * x + 5]);
    points[3][1] = 500;
    points[17][1] = -400;
    points[25][1] = 900;
    assert.ok(Math.abs(theilSen(points) - 2) < 0.1);
  });

  test("skips pairs with the same x, and needs two different x", () => {
    assert.equal(theilSen([[1, 1], [1, 1], [3, 5]]), 2);
    assert.equal(theilSen([[1, 1], [1, 5]]), null);
    assert.equal(theilSen([[1, 1]]), null);
    assert.equal(theilSen([[0, 0], [1, null], [2, 4]]), 2);
  });
});

describe("rollingMedian", () => {
  test("centered on each value, of the values there are near the ends", () => {
    assert.deepEqual(rollingMedian([1, 100, 2, 3, 4], 3), [50.5, 2, 3, 3, 3.5]);
  });

  test("takes out a single odd value", () => {
    assert.deepEqual(rollingMedian([10, 10, 99, 10, 10], 3), [10, 10, 10, 10, 10]);
  });

  test("an even k takes one more after than before; k = 1 changes nothing", () => {
    assert.deepEqual(rollingMedian([1, 2, 3, 4, 5, 6], 4), [2, 2.5, 3.5, 4.5, 5, 5.5]);
    assert.deepEqual(rollingMedian([3, 1, 2], 1), [3, 1, 2]);
  });

  test("leaves out missing values", () => {
    assert.deepEqual(rollingMedian([1, null, 3], 3), [1, 2, 3]);
    assert.deepEqual(rollingMedian([null], 3), [null]);
  });
});

describe("bimodal", () => {
  test("two clear groups", () => {
    assert.deepEqual(bimodal([52, 10, 51, 12, 11, 50]), { low: [10, 11, 12], high: [50, 51, 52], gap: 38 });
  });

  test("one group", () => {
    assert.equal(bimodal([10, 11, 12, 13, 14, 15]), null);
    // The widest gap (15) is no wider than twice the spread of either side (20).
    assert.equal(bimodal([10, 20, 30, 45, 55, 65]), null);
  });

  test("not with a single value on one side", () => {
    assert.equal(bimodal([10, 11, 12, 50]), null);
    assert.equal(bimodal([10, 50, 51, 52]), null);
  });

  test("not when the gap is within the tolerance", () => {
    assert.deepEqual(bimodal([10, 10.1, 10.4, 10.5])?.low, [10, 10.1]);
    assert.equal(bimodal([10, 10.1, 10.4, 10.5], { tolerance: 0.5 }), null);
  });
});

describe("splitByLabel", () => {
  const runs = [
    { display: "built-in", ms: 100 },
    { display: "external", ms: 150 },
    { display: "built-in", ms: 104 },
    { display: "external", ms: 148 },
    { display: "built-in", ms: 98 },
    { display: "external", ms: 155 },
    { display: "sidecar", ms: 300 },
    { ms: 120 },
    { display: "built-in", ms: null },
  ];
  const ms = (run) => run.ms;

  test("groups whose medians differ, lowest first, without groups of one run", () => {
    assert.deepEqual(splitByLabel(runs, "display", ms, 20), [
      { label: "built-in", n: 3, median: 100 },
      { label: "external", n: 3, median: 150 },
    ]);
  });

  test("a label can be a function of the run", () => {
    assert.deepEqual(splitByLabel(runs, (run) => run.display ?? "unknown", ms, 20)?.map((g) => g.label), ["built-in", "external"]);
  });

  test("null when the medians are within the tolerance", () => {
    assert.equal(splitByLabel(runs, "display", ms, 60), null);
  });

  test("null with fewer than two groups of two runs", () => {
    assert.equal(splitByLabel(runs.slice(0, 3), "display", ms, 20), null);
    assert.equal(splitByLabel(runs, () => "same", ms, 20), null);
  });
});

describe("range", () => {
  test("of the finite values", () => {
    assert.deepEqual(range([3, null, 1, NaN, 2]), { min: 1, max: 3 });
    assert.equal(range([]), null);
    assert.equal(range([null, Infinity]), null);
  });
});
