import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HARNESS } from "../lib/estimators.mjs";
import { METRICS, aggregate, between, cellOf, envDrift, good, markdown, readmeTable, splitOf, unreportable } from "../lib/report.mjs";

/** A finished, clean run of one cell, with an idle CPU and memory. */
const run = (cpuPct, extra = {}) => ({ client: "freelens", scenario: "pods-1k", warmup: false, counted: true, noisy: [], readyMs: 2_000, idle: { cpuPct, memMB: 300 }, ...extra });
const machine = { slug: "m1-max-32gb", chip: "Apple M1 Max", memoryGB: 32, macOS: "27.0", build: "27A1", kwok: "0.7.0", dockerVM: { colima: "0.9.1", vmType: "vz", mountType: "virtiofs", cpus: 4, memoryGB: 7.7 }, display: { frame: [1728, 1117], visible: [0, 0, 1728, 1085], scale: 2 } };
const doc = (results, extra = {}) => ({ file: "a.json", harness: { version: HARNESS, quick: false }, machine, clients: { freelens: { name: "Freelens", version: "1.0" } }, sessions: [], results, ...extra });

describe("cellOf", () => {
  test("counts each kind of run, and takes numbers from the good ones only", () => {
    const cell = cellOf([
      run(4, { warmup: true, counted: false }),
      run(4),
      run(5),
      run(6),
      run(50, { noisy: ["other CPU 31% in idle"] }),
      run(70, { invalid: "no list of /api/v1/pods on bench-z1" }),
      { client: "freelens", scenario: "pods-1k", round: 3, counted: true, error: "Freelens: the cluster view did not open" },
    ]);
    assert.equal(cell.runs.length, 3);
    assert.equal(cell.noisy.length, 1);
    assert.equal(cell.invalid.length, 1);
    assert.deepEqual(cell.errors, ["Freelens: the cluster view did not open"]);
    assert.equal(cell.value(METRICS.cpuPct), 5);
    assert.deepEqual(cell.range(METRICS.cpuPct), { min: 4, max: 6 });
  });

  test("a client that couldn't run, or wasn't for the scenario", () => {
    assert.deepEqual(cellOf([{ client: "aptakube", scenario: "pods-1k", error: "no trial", unusable: true, counted: false }]).errors, ["no trial"]);
    assert.equal(cellOf([{ client: "k9s", scenario: "fleet-5x10k", skipped: "one cluster at a time" }]).skipped, "one cluster at a time");
  });

  test("good: counted, finished, valid and clean", () => {
    assert.equal(good(run(1)), true);
    assert.equal(good(run(1, { warmup: true })), false);
    assert.equal(good(run(1, { counted: false })), false);
    assert.equal(good(run(1, { noisy: ["on battery in idle"] })), false);
    assert.equal(good(run(1, { invalid: "wrong screen" })), false);
    assert.equal(good(run(1, { error: "failed" })), false);
  });
});

describe("splitOf", () => {
  test("runs split by a label they recorded", () => {
    const busy = (cpu) => run(cpu, { state: { labels: { wakeBand: "busy" } } });
    const quiet = (cpu) => run(cpu, { state: { labels: { wakeBand: "quiet" } } });
    const split = splitOf([quiet(4.1), busy(19), quiet(3.9), busy(18.5), quiet(4.0), busy(19.4)], METRICS.cpuPct);
    assert.equal(split.by, "how busy it was when idle");
    assert.deepEqual(split.groups.map((g) => [g.label, g.n, g.median]), [["quiet", 3, 4], ["busy", 3, 19]]);
  });

  test("values in two groups without a label that tells them apart", () => {
    const split = splitOf([run(4), run(4.2), run(19), run(4.1), run(19.5), run(18.8)], METRICS.cpuPct);
    assert.equal(split.by, null);
    assert.deepEqual(split.groups.map((g) => g.n), [3, 3]);
  });

  test("no split within the spread that counts as one, or with too few runs", () => {
    assert.equal(splitOf([run(4), run(4.5), run(5), run(4.2), run(5.4)], METRICS.cpuPct), null);
    assert.equal(splitOf([run(4), run(19), run(4)], METRICS.cpuPct), null);
  });
});

describe("what can be reported together", () => {
  test("only this harness's full runs", () => {
    assert.equal(unreportable(doc([])), null);
    assert.match(unreportable(doc([], { harness: undefined })), /older benchmark/);
    assert.match(unreportable(doc([], { harness: { version: HARNESS - 1 } })), new RegExp(`harness ${HARNESS - 1}`));
    assert.match(unreportable(doc([], { harness: { version: HARNESS, quick: true } })), /quick/);
    assert.throws(() => aggregate([doc([], { harness: { version: 1 } })]), /a\.json: made by harness 1/);
  });

  test("one Mac's files only with the same macOS build, VM and display", () => {
    assert.equal(envDrift(machine, { ...machine }), null);
    assert.match(envDrift(machine, { ...machine, build: "27A2" }), /macOS 27A1 and 27A2/);
    assert.match(envDrift(machine, { ...machine, dockerVM: { ...machine.dockerVM, cpus: 10 } }), /different VMs/);
    const other = { ...doc([]), file: "b.json", machine: { ...machine, display: { ...machine.display, visible: [0, 0, 1512, 945] } } };
    assert.throws(() => aggregate([doc([]), other]), /different displays/);
    assert.equal(aggregate([doc([]), other], { allowDrift: true }).size, 1);
  });
});

describe("markdown", () => {
  test("the median with the range under it, ‡ for a split, and the runs behind each cell", () => {
    const results = [run(4.1), run(19), run(3.9), run(18.5), run(4), run(19.4), run(30, { noisy: ["thermal serious in idle"] })];
    const text = markdown(aggregate([doc(results)]));
    assert.match(text, /\| CPU, idle \| 11\.3% <sub>3\.9–19\.4<\/sub> ‡ \|/);
    assert.match(text, /\| Runs \| 6 · 1 noisy \|/);
    assert.match(text, /‡ Freelens, CPU, idle: 4\.0% in 3 runs, 19\.0% in 3 runs\./);
  });
});

describe("readmeTable", () => {
  test("words instead of the numbers of a lighter task: the first 1,000 of a list, a log read again every 10 s", () => {
    const pods = (client, extra = {}) => ({ client, scenario: "pods-10k", warmup: false, counted: true, noisy: [], readyMs: 1_000, idle: { memMB: 300, cpuPct: 1 }, startup: { downMB: 5 }, ...extra });
    const log = (client, behind) => ({ client, scenario: "logs-300", warmup: false, counted: true, noisy: [], logs: { cpuPct: 4, behind: { medianSec: behind / 2, maxSec: behind } } });
    const results = [
      pods("k10s"),
      pods("headlamp", { shown: { rows: 15, partial: true, loaded: 1_000, total: 10_000 }, startup: { downMB: 0.6 } }),
      log("freelens", 10),
      log("headlamp", 1),
    ];
    const clients = { k10s: { name: "k10s", version: "0.1.0" }, headlamp: { name: "Headlamp", version: "0.45.0" }, freelens: { name: "Freelens", version: "1.10.3" } };
    const m = [...aggregate([doc(results, { clients })]).values()][0];
    const en = readmeTable(m, "en");
    assert.match(en, /\| Memory with them on screen \| 300 MB \| first 1,000 only \| – \|/);
    assert.match(en, /\| CPU while following a log of 300 lines a second \| – \| 4% \| rereads every 10 s \|/);
    assert.match(readmeTable(m, "ru"), /только первые 1 000/);
  });
});

describe("between", () => {
  test("replaces only between markers on lines of their own, up to the nearest closing one", () => {
    const text = ["# Title", "<!-- benchmarks -->", "old table", "<!-- /benchmarks -->", "", "Writes the table between `<!-- benchmarks -->` and `<!-- /benchmarks -->`.", ""].join("\n");
    const next = between(text, "benchmarks", "new table");
    assert.equal(next, text.replace("old table", "new table"));
  });

  test("leaves a text without the markers as it is", () => {
    assert.equal(between("no markers here", "results", "x"), "no markers here");
  });
});
