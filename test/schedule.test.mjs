import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { capAt, cellStatus, companionFor, fnv1a, nextRound, projectSeconds, roundOrder, runsLeft, seededRandom, shuffle } from "../lib/schedule.mjs";
import { converged } from "../lib/stats.mjs";

/** Run records of one cell by what came of them, with readyMs as the metric that drives the schedule. */
const good = (readyMs) => ({ client: "k10s", scenario: "pods-10k", warmup: false, counted: true, noisy: [], invalid: false, error: null, metrics: { readyMs } });
const noisy = (readyMs) => ({ ...good(readyMs), noisy: ["thermal serious in idle"] });
const failed = (error) => ({ ...good(null), error });
const goods = (...values) => values.map(good);
const status = (runs, options = {}) => cellStatus(runs, { drive: ["readyMs"], ...options });

describe("seededRandom", () => {
  test("FNV-1a of the seed", () => {
    assert.equal(fnv1a(""), 0x811c9dc5);
    assert.equal(fnv1a("a"), 0xe40c292c);
    assert.equal(fnv1a("foobar"), 0xbf9cf968);
  });

  test("the same text, the same floats, all in [0, 1)", () => {
    const a = seededRandom("2026-10-05/pods-10k/3");
    const b = seededRandom("2026-10-05/pods-10k/3");
    for (let i = 0; i < 1_000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
  });

  test("another text, other floats", () => {
    const a = seededRandom("2026-10-05/pods-10k/3");
    const b = seededRandom("2026-10-05/pods-10k/4");
    assert.notDeepEqual([a(), a(), a()], [b(), b(), b()]);
  });
});

describe("shuffle", () => {
  const clients = ["k10s", "aptakube", "headlamp", "freelens", "k9s"];

  test("a new array with the same clients, the same for the same seed", () => {
    const order = shuffle(clients, seededRandom("x"));
    assert.deepEqual([...order].sort(), [...clients].sort());
    assert.deepEqual(clients, ["k10s", "aptakube", "headlamp", "freelens", "k9s"]);
    assert.deepEqual(shuffle(clients, seededRandom("x")), order);
  });

  test("every order about equally often", () => {
    const rand = seededRandom("uniform");
    const counts = new Map();
    for (let i = 0; i < 6_000; i++) {
      const key = shuffle(["a", "b", "c"], rand).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert.equal(counts.size, 6);
    for (const [order, count] of counts) assert.ok(count > 850 && count < 1_150, `${order}: ${count}`);
  });
});

describe("roundOrder", () => {
  const clients = ["k10s", "aptakube", "headlamp", "freelens", "k9s"];
  const at = { seed: "2026-10-05", scenario: "pods-10k" };

  test("the same order for the same round, so that a resumed session repeats it", () => {
    const rounds = (n) => {
      const out = [];
      let previousLast;
      for (let round = 1; round <= n; round++) {
        out.push(roundOrder(clients, { ...at, round, previousLast }));
        previousLast = out.at(-1).at(-1);
      }
      return out;
    };
    assert.deepEqual(rounds(10), rounds(10));
    for (const order of rounds(10)) assert.deepEqual([...order].sort(), [...clients].sort());
  });

  test("the last client of a round doesn't start the next", () => {
    let previousLast;
    for (let round = 1; round <= 200; round++) {
      const order = roundOrder(clients, { ...at, round, previousLast });
      assert.notEqual(order[0], previousLast, `round ${round}`);
      previousLast = order.at(-1);
    }
  });

  test("of two clients, the previous last goes second; one client goes anyway", () => {
    for (let round = 1; round <= 20; round++) assert.deepEqual(roundOrder(["k10s", "k9s"], { ...at, round, previousLast: "k9s" }), ["k10s", "k9s"]);
    assert.deepEqual(roundOrder(["k9s"], { ...at, round: 1, previousLast: "k9s" }), ["k9s"]);
    assert.deepEqual(roundOrder([], { ...at, round: 1 }), []);
  });
});

describe("cellStatus", () => {
  test("needs runs until it has five", () => {
    const s = status(goods(100, 101, 99));
    assert.equal(s.n, 3);
    assert.equal(s.needsMore, true);
    assert.equal(s.reason, "3 of 5 runs");
    assert.deepEqual(s.converged, { readyMs: false });
  });

  test("stops at five once converged", () => {
    const s = status(goods(100, 104, 98, 101, 105));
    assert.deepEqual(s.converged, { readyMs: true });
    assert.equal(s.needsMore, false);
    assert.equal(s.reason, "converged at 5 runs");
  });

  test("not converged at five: still needs more at six, however close the sixth", () => {
    const five = goods(10, 10, 10, 11.05, 11.05);
    assert.equal(status(five).needsMore, true);
    assert.equal(status(five).reason, "not converged: readyMs");
    // Judged on its own, six runs would pass: the sixth value moves the median up, and 10% of it with it.
    const six = [...five, good(11.05)];
    assert.equal(converged(six.map((r) => r.metrics.readyMs)), true);
    assert.equal(status(six).needsMore, true);
    assert.deepEqual(status(six).converged, { readyMs: false });
    // At seven the lowest and the highest drop out of the interval.
    const seven = [...six, good(11.05)];
    assert.equal(status(seven).needsMore, false);
    assert.equal(status(seven).reason, "converged at 7 runs");
  });

  test("stops at nine, converged or not", () => {
    const s = status(goods(100, 200, 100, 200, 100, 200, 100, 200, 100));
    assert.equal(s.n, 9);
    assert.deepEqual(s.converged, { readyMs: false });
    assert.equal(s.needsMore, false);
    assert.equal(s.reason, "9 runs, the most");
  });

  test("a floor per metric", () => {
    const cpu = (cpuPct) => ({ ...good(null), metrics: { cpuPct } });
    const runs = [0.2, 0.5, 0.3, 0.4, 0.25].map(cpu);
    assert.equal(cellStatus(runs, { drive: ["cpuPct"] }).needsMore, true);
    assert.equal(cellStatus(runs, { drive: ["cpuPct"], floors: { cpuPct: 0.5 } }).needsMore, false);
  });

  test("the same error twice in a row before any good run: failed", () => {
    const s = status([failed("Freelens: the cluster view did not open"), failed("Freelens: the cluster view did not open")]);
    assert.equal(s.failed, true);
    assert.equal(s.errorsInARow, 2);
    assert.equal(s.needsMore, false);
    assert.equal(s.owed, 0);
    assert.equal(s.reason, "the same error twice: Freelens: the cluster view did not open");
    assert.equal(status([failed("x"), failed("y")]).failed, false);
    assert.equal(status([failed("x"), failed("y")]).errorsInARow, 1);
    assert.equal(status([failed("x"), failed("y")]).needsMore, true);
    assert.equal(status([failed("x"), good(100), failed("x")]).errorsInARow, 1);
    // After a good run, two errors don't end the cell.
    const after = status([good(100), failed("x"), failed("x")]);
    assert.equal(after.errorsInARow, 2);
    assert.equal(after.failed, false);
    assert.equal(after.needsMore, true);
  });

  test("warm-ups and uncounted runs aren't the cell's; invalid runs are, but not good ones", () => {
    const runs = [{ ...good(999), warmup: true, counted: false }, { ...good(500), counted: false }, { ...good(700), invalid: true }, ...goods(100, 104, 98, 101, 105)];
    const s = status(runs);
    assert.equal(s.n, 5);
    assert.equal(s.attempts, 6);
    assert.deepEqual(s.converged, { readyMs: true });
    assert.equal(s.needsMore, false);
    const uncountedError = status([{ ...failed("x"), counted: false }, failed("x")]);
    assert.equal(uncountedError.errorsInARow, 1);
    assert.equal(uncountedError.failed, false);
  });

  test("a noisy run is owed a repeat until a good run makes up for it", () => {
    const owing = status([...goods(100, 104, 98, 101, 105), noisy(300)]);
    assert.equal(owing.n, 5);
    assert.equal(owing.noisy, 1);
    assert.equal(owing.owed, 1);
    assert.equal(owing.needsMore, false);
    assert.equal(owing.reason, "converged at 5 runs; 1 noisy run to repeat");
    assert.equal(status([noisy(300), ...goods(100, 104, 98, 101, 105)]).owed, 0);
  });

  test("but no more repeats than keep the cell within four noisy runs", () => {
    const three = status([...goods(100, 101), noisy(1), noisy(2), noisy(3)]);
    assert.equal(three.noisy, 3);
    assert.equal(three.owed, 1);
    const four = status([...goods(100, 101), noisy(1), noisy(2), noisy(3), noisy(4)]);
    assert.equal(four.noisy, 4);
    assert.equal(four.owed, 0);
    assert.equal(four.needsMore, true);
    assert.equal(status([...goods(100, 101), noisy(1), noisy(2)], { maxNoisy: 1 }).owed, 0);
  });

  test("a client that keeps failing differently is given up after max + maxNoisy runs", () => {
    const errors = (n) => Array.from({ length: n }, (_, i) => failed(`error ${i}`));
    assert.equal(status(errors(12)).needsMore, true);
    const s = status(errors(13));
    assert.equal(s.failed, false);
    assert.equal(s.needsMore, false);
    assert.equal(s.reason, "gave up after 13 runs (0 good)");
    // A cell that reached its maximum along the way says so.
    const full = status([...goods(100, 200, 100, 200), noisy(1), noisy(2), noisy(3), noisy(4), ...goods(100, 200, 100, 200, 100)]);
    assert.equal(full.attempts, 13);
    assert.equal(full.reason, "9 runs, the most");
  });
});

describe("nextRound", () => {
  const cells = {
    aptakube: status(goods(100, 101, 99)),
    // Converged, using 8 / 10.2 of what is allowed; freelens 2 / 10.1.
    headlamp: status(goods(100, 108, 102, 101, 104)),
    freelens: status(goods(100, 101, 102, 101, 100)),
    k9s: status(goods(100, 200, 100, 200, 100, 200, 100, 200, 100)),
    lens: status([failed("x"), failed("x")]),
  };
  const at = { seed: "2026-10-05", scenario: "pods-10k", round: 6 };

  test("a client left alone gets the converged one with the widest interval for company", () => {
    assert.equal(companionFor(cells, "aptakube"), "headlamp");
    assert.deepEqual(nextRound(cells, at).sort(), ["aptakube", "headlamp"]);
  });

  test("no companion when two need runs", () => {
    assert.deepEqual(nextRound({ ...cells, k10s: status(goods(100)) }, at).sort(), ["aptakube", "k10s"]);
  });

  test("never a failed client, even with no metric to converge", () => {
    const bare = (runs) => cellStatus(runs);
    assert.equal(companionFor({ k10s: bare(goods(100)), lens: bare([failed("x"), failed("x")]) }, "k10s"), null);
    assert.equal(companionFor({ k10s: bare(goods(100)), k9s: bare(goods(1, 2, 3, 4, 5)) }, "k10s"), "k9s");
  });

  test("a noisy run owed counts as needing one", () => {
    const owing = { ...cells, headlamp: status([...goods(100, 108, 102, 101, 104), noisy(300)]) };
    assert.deepEqual(nextRound(owing, at).sort(), ["aptakube", "headlamp"]);
    assert.equal(companionFor(owing, "aptakube"), "freelens");
  });

  test("the same order every time, never starting with the previous round's last", () => {
    assert.deepEqual(nextRound(cells, { ...at, previousLast: "aptakube" }), ["headlamp", "aptakube"]);
    assert.deepEqual(nextRound(cells, at), nextRound({ ...cells }, at));
  });

  test("an empty round once every cell is done", () => {
    const { aptakube: _, ...done } = cells;
    assert.deepEqual(nextRound(done, at), []);
  });
});

describe("a time budget", () => {
  const cells = {
    aptakube: status(goods(100, 101, 99)),
    headlamp: status(goods(100, 104, 98, 101, 105)),
    freelens: status([...goods(100, 104, 98, 101, 105), noisy(300)]),
    lens: status([failed("x"), failed("x")]),
  };

  test("each cell that needs runs may go to its maximum; owed repeats come on top of done cells", () => {
    assert.deepEqual(Object.values(cells).map(runsLeft), [6, 0, 1, 0]);
    assert.equal(projectSeconds(cells, 120), 840);
    assert.equal(projectSeconds(cells, (client) => (client === "aptakube" ? 100 : 50)), 650);
  });

  test("capAt lowers every cell's maximum, but not under the minimum", () => {
    const capped = capAt(cells, 5);
    assert.equal(capped.aptakube.max, 5);
    assert.equal(capped.aptakube.needsMore, true);
    assert.equal(runsLeft(capped.aptakube), 2);
    assert.equal(capped.freelens.owed, 0);
    assert.equal(capped.freelens.needsMore, false);
    assert.equal(projectSeconds(capped, 120), 240);
  });

  test("a cell at the cap needs no more, converged or not", () => {
    const wide = status(goods(100, 120, 100, 120, 100, 120, 100));
    assert.equal(wide.needsMore, true);
    const capped = capAt({ wide }, 7).wide;
    assert.equal(capped.needsMore, false);
    assert.equal(capped.reason, "7 runs, the most");
    assert.equal(capAt(cells, 12).aptakube, cells.aptakube);
  });
});
