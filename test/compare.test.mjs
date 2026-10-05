import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, mock, test } from "node:test";
import { check, compare } from "../lib/compare.mjs";
import { HARNESS } from "../lib/estimators.mjs";

const dir = mkdtempSync(join(tmpdir(), "k10s-bench-test-"));
const machine = { slug: "m1-max-32gb", chip: "Apple M1 Max", memoryGB: 32, macOS: "27.0", build: "27A1", dockerVM: { cpus: 4, memoryGB: 7.7 } };

/** A results file of k10s in pods-1k: a warm-up, then runs with these ready times (ms), each with the same idle numbers. */
function file(name, readyTimes, extra = {}) {
  const runs = readyTimes.map((readyMs, i) => ({ client: "k10s", scenario: "pods-1k", session: "s1", round: i + 1, counted: true, warmup: false, noisy: [], readyMs, idle: { memMB: 200, cpuPct: 0.5 }, state: { before: "abc" } }));
  const doc = {
    harness: { version: HARNESS, quick: false },
    machine,
    sessions: [{ id: "s1", seed: "1", args: ["run"], startedAt: 0, endedAt: 1 }],
    clients: { k10s: { name: "k10s", version: "0.1.0" } },
    results: [{ client: "k10s", scenario: "pods-1k", session: "s1", round: 0, warmup: true, counted: false, readyMs: 1_000 }, ...runs],
    ...extra,
  };
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

/** Runs `fn` with console.log silenced, and returns what it returned. */
function quietly(fn) {
  const logged = mock.method(console, "log", () => {});
  try {
    return fn();
  } finally {
    logged.mock.restore();
  }
}

describe("check", () => {
  test("a file with good runs only passes", () => {
    assert.equal(quietly(() => check(file("good.json", [1_000, 1_020, 990, 1_010, 1_005]))), true);
  });

  test("a failed warm-up, a failed run, a run on the wrong screen fail it", () => {
    const path = file("bad.json", [1_000, 1_020, 990]);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.results[0].error = "k10s did not start";
    doc.results.push({ ...doc.results[1], round: 4, invalid: "bench-1k: didn't list /api/v1/pods" });
    writeFileSync(path, JSON.stringify(doc));
    assert.equal(quietly(() => check(path)), false);
  });

  test("runs of one session that started from different saved states fail it", () => {
    const path = file("state.json", [1_000, 1_020, 990, 1_010, 1_005]);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.results[3].state.before = "def";
    writeFileSync(path, JSON.stringify(doc));
    assert.equal(quietly(() => check(path)), false);
  });
});

describe("compare", () => {
  test("two runs that agree pass", () => {
    const a = file("a.json", [1_000, 1_020, 990, 1_010, 1_005]);
    const b = file("b.json", [1_050, 1_040, 1_060, 1_030, 1_045]);
    assert.equal(quietly(() => compare(a, b)), true);
  });

  test("a median 30 % off fails", () => {
    const a = file("c.json", [1_000, 1_020, 990, 1_010, 1_005]);
    const b = file("d.json", [1_300, 1_320, 1_290, 1_310, 1_305]);
    assert.equal(quietly(() => compare(a, b)), false);
  });

  test("files of different harnesses aren't compared", () => {
    const a = file("e.json", [1_000]);
    const b = file("f.json", [1_000], { harness: { version: HARNESS - 1 } });
    assert.throws(() => compare(a, b), /harness/);
  });
});
