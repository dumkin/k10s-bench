import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cpuTimeMs, interpolate } from "../lib/system.mjs";

describe("cpuTimeMs", () => {
  test("ps's CPU times, in ms", () => {
    assert.equal(cpuTimeMs("0:00.27"), 270);
    assert.equal(cpuTimeMs("173:30.19\n"), (173 * 60 + 30.19) * 1000);
    assert.equal(cpuTimeMs(" 1:02:03.45"), ((60 + 2) * 60 + 3.45) * 1000);
    assert.equal(cpuTimeMs("2-01:02:03.45"), (((2 * 24 + 1) * 60 + 2) * 60 + 3.45) * 1000);
  });

  test("anything else is null", () => {
    assert.equal(cpuTimeMs(""), null);
    assert.equal(cpuTimeMs("ps: no such process"), null);
  });
});

describe("interpolate", () => {
  const series = [
    [1_000, 0],
    [2_000, 500],
    [3_000, 600],
  ];

  test("between the readings around the moment", () => {
    assert.equal(interpolate(series, 1_500), 250);
    assert.equal(interpolate(series, 2_000), 500);
    assert.equal(interpolate(series, 2_500), 550);
    assert.equal(interpolate(series, 3_000), 600);
  });

  test("null outside them, or without any", () => {
    assert.equal(interpolate(series, 999), null);
    assert.equal(interpolate(series, 3_001), null);
    assert.equal(interpolate([], 1_000), null);
  });
});
