// Checks that a run measured the screen it was meant to, from what the client asked the API servers for (the run's
// audit log) and how much came through each proxy: the apps the benchmark can't read (k10s, Aptakube) could open
// something else, and one did (Aptakube's Workloads overview instead of its Pods table, all 100 contexts instead of
// one). A run that fails is left out of the tables, with the reasons in the notes.

import { pathOf } from "./audit.mjs";

/** At least this much through a context's proxy means the client opened that cluster, not just asked who it is. */
const OPENED_BYTES = 100_000;

const has = (counts, path) => (counts?.[path] ?? 0) > 0;

/**
 * `summary`: screenSummary() of the run's requests, by cluster. `ports`: the scenario's proxy ports, the first
 * context's first; `bytes`: per-port bytes the run downloaded. Returns {ok, reasons, contexts?}.
 */
export function checkScreen({ client, scenario, summary, ports, bytes, coverage }) {
  const reasons = [];
  if (scenario.view === "logs") {
    // The k3s cluster keeps no audit log: the log's traffic is the evidence.
    if (coverage == null || coverage < 0.5) reasons.push(`its log brought ${coverage == null ? "nothing" : `${Math.round(coverage * 100)}% of what the pod wrote`}`);
    return { ok: !reasons.length, reasons };
  }
  const resource = scenario.view === "namespaces" ? "/api/v1/namespaces" : "/api/v1/pods";
  for (const cluster of scenario.clusters) {
    const c = summary[cluster];
    if (!c) {
      reasons.push(`${cluster}: no requests`);
      continue;
    }
    if (!has(c.list, resource) && !has(c.watch, resource)) {
      const perNamespace = Object.keys({ ...c.list, ...c.watch }).some((p) => /^\/api\/v1\/namespaces\/[^/]+\/pods$/.test(p));
      reasons.push(`${cluster}: didn't list ${resource}${perNamespace && resource.endsWith("pods") ? " (only one namespace's pods)" : ""}`);
    }
    for (const prefix of client.screenRules?.[scenario.view]?.notListed ?? []) {
      const hit = Object.keys({ ...c.list, ...c.watch }).filter((p) => p.startsWith(prefix));
      if (hit.length) reasons.push(`${cluster}: listed ${hit.slice(0, 3).join(", ")}${hit.length > 3 ? "…" : ""} (another screen)`);
    }
  }
  // Several contexts that all reach one cluster (contexts-100): only the first may be opened.
  let contexts;
  if (scenario.contexts && ports?.length > 1) {
    const got = ports.map((p) => bytes.get(p) ?? 0);
    contexts = { opened: got.filter((b) => b >= OPENED_BYTES).length, touched: got.filter((b) => b > 0).length };
    const want = scenario.open ?? 1;
    if (got[0] < OPENED_BYTES) reasons.push("the first context wasn't opened");
    if (contexts.opened > want) reasons.push(`${contexts.opened} of ${ports.length} contexts were opened, not ${want}`);
  }
  return { ok: !reasons.length, reasons, ...(contexts ? { contexts } : {}) };
}

/** The per-cluster summary kept with a run: what it listed and watched, and how many times it started each list. */
export function compactSummary(summary) {
  const out = {};
  for (const [cluster, c] of Object.entries(summary)) {
    const keep = (counts) => Object.fromEntries(Object.entries(counts).map(([p, n]) => [pathOf(p), n]));
    out[cluster] = { list: keep(c.list), watch: keep(c.watch), passes: c.passes, other: c.other };
  }
  return out;
}
