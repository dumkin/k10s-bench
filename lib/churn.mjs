// Pods that keep changing, at a steady rate: each update bumps a container's restart count, a change every
// client shows in its table. KWOK leaves the status alone afterwards, so nothing else moves.
//
// The rate is kept by the clock, not by timer ticks: every few milliseconds it sends what is due by now, so timers
// that fire late (they do, by a few percent) don't lower it. The restart counts keep growing over the whole
// benchmark: a count that started again at 1 in a later run would set a pod to the value it already has, a patch
// that changes nothing and that no client gets told about.

import { performance } from "node:perf_hooks";
import { Kube } from "./kube.mjs";

/** Restart counts by pod, for the whole benchmark. */
const restarts = new Map();
/**
 * Where a pod's count starts in this process: seconds since a fixed day, so a benchmark started again later starts
 * above every count an earlier one set (each pod gets an update every 10 s, far slower than a second a second).
 */
const BASE = Math.floor(Date.now() / 1000) - 1_790_000_000;

export class Churn {
  /** `pods`: [{ namespace, name }], changed round-robin; `rate`: updates a second. */
  constructor(creds, pods, rate) {
    this.kube = new Kube(creds, { sockets: 32, userAgent: "k10s-bench-churn" });
    this.pods = pods;
    this.rate = rate;
    this.issued = 0;
    this.sent = [];
    this.failed = 0;
    this.skipped = 0;
    this.inFlight = 0;
  }

  start() {
    this.startedAt = Date.now();
    const start = performance.now();
    let i = 0;
    this.timer = setInterval(() => {
      const due = Math.floor((this.rate * (performance.now() - start)) / 1000) - this.issued;
      for (let n = 0; n < due; n++) {
        this.issued++;
        // Never let a slow API server pile up requests: skip the update rather than queue it.
        if (this.inFlight >= 64) {
          this.skipped++;
          continue;
        }
        const pod = this.pods[i++ % this.pods.length];
        const key = `${pod.namespace}/${pod.name}`;
        const count = (restarts.get(key) ?? BASE) + 1;
        restarts.set(key, count);
        this.inFlight++;
        const began = Date.now();
        this.kube
          .request(
            "PATCH",
            `/api/v1/namespaces/${pod.namespace}/pods/${pod.name}/status`,
            [{ op: "replace", path: "/status/containerStatuses/0/restartCount", value: count }],
            "application/json-patch+json",
          )
          .then(
            () => this.sent.push([began, Date.now() - began]),
            () => this.failed++,
          )
          .finally(() => this.inFlight--);
      }
    }, 5);
  }

  /** Updates that went through between two moments: how many a second, and how long they took (p50, p95 in ms). */
  window(from, to) {
    const done = this.sent.filter(([t]) => t >= from && t < to);
    const ms = done.map(([, d]) => d).sort((a, b) => a - b);
    const q = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null);
    return { sent: done.length, achievedRate: Math.round((done.length / ((to - from) / 1000)) * 10) / 10, latencyMs: { p50: q(0.5), p95: q(0.95) } };
  }

  stop() {
    clearInterval(this.timer);
    this.kube.close();
    return { issued: this.issued, sent: this.sent.length, failed: this.failed, skipped: this.skipped };
  }
}
