// What is measured. Every scenario is one screen a person opens: the pods of one cluster or of several, the
// namespaces of a cluster with very many of them, one cluster out of a kubeconfig with a hundred contexts.

import { CLUSTERS } from "./clusters.mjs";

/**
 * The numbers that decide how many runs a scenario needs: runs are added until each is known well enough (5 to 9,
 * see schedule.mjs). Bytes and requests are left out: they come in steps, or split by an app's state, which more
 * runs don't narrow.
 */
const TABLE = ["readyMs", "memMB", "cpuPct"];

export const SCENARIOS = {
  "pods-1k": {
    title: "Pods of one cluster, 1,000 pods",
    clusters: ["bench-1k"],
    view: "pods",
    expect: 1_000,
    drive: TABLE,
  },
  "pods-10k": {
    title: "Pods of one cluster, 10,000 pods",
    clusters: ["bench-10k-1"],
    view: "pods",
    expect: 10_000,
    drive: [...TABLE, "churnCpuPct", "churnMemMB"],
    // 1,000 of the pods change all the time: 100 updates a second, each pod every 10 seconds.
    churn: { pods: 1_000, rate: 100 },
  },
  "pods-50k": {
    title: "Pods of one cluster, 50,000 pods",
    clusters: ["bench-50k"],
    view: "pods",
    expect: 50_000,
    drive: TABLE,
  },
  "fleet-5x10k": {
    title: "Pods of five clusters in one table, 10,000 pods each",
    clusters: ["bench-10k-1", "bench-10k-2", "bench-10k-3", "bench-10k-4", "bench-10k-5"],
    view: "pods",
    expect: 50_000,
    multi: true,
    drive: TABLE,
  },
  "namespaces-100k": {
    title: "Namespaces of one cluster, 100,000 namespaces",
    clusters: ["bench-100k-ns"],
    view: "namespaces",
    expect: 100_000,
    drive: TABLE,
  },
  "logs-300": {
    title: "Following one pod's log, 300 lines a second",
    // A k3s cluster (lib/logs.mjs): KWOK's pods write no logs.
    k3s: true,
    clusters: ["bench-logs"],
    view: "logs",
    expect: 0,
    drive: ["logCpuPct", "logMemMB"],
  },
  "contexts-100": {
    title: "One cluster (1,000 pods) out of a kubeconfig with 100 contexts",
    // 100 contexts, each with an address of its own; behind them all is the same API server.
    clusters: ["bench-1k"],
    contexts: 100,
    open: 1,
    view: "pods",
    expect: 1_000,
    drive: TABLE,
  },
};

/** Ports of the extra contexts of `contexts-100`: one proxy each, all to bench-1k. */
export const CONTEXT_PORTS = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? CLUSTERS["bench-1k"].port : 17500 + i));

export function contextNames(scenario) {
  const n = scenario.open ?? scenario.clusters.length;
  return Array.from({ length: n }, (_, i) => `bench-z${i + 1}`);
}

/** Whether a client can show a scenario at all, and if not, why. */
export function unsupported(client, scenario) {
  if (scenario.multi && !client.multiCluster) return "one cluster at a time";
  if (!client.views.includes(scenario.view)) return `no ${scenario.view} view`;
  return null;
}
