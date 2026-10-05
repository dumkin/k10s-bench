// API requests per client, from the API servers' audit logs (only user `bench`, the clients, is logged).

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { apiServer, auditLog, runUser } from "./clusters.mjs";
import { Kube } from "./kube.mjs";
import { exists, waitFor } from "./util.mjs";

/** Reads only what was appended since the last call, so that long runs never re-read a big log. */
const offsets = new Map();
const events = new Map();

function read(cluster) {
  const file = auditLog(cluster);
  if (!exists(file)) return [];
  const list = events.get(cluster) ?? [];
  const size = statSync(file).size;
  let offset = offsets.get(cluster) ?? 0;
  if (size < offset) offset = 0;
  if (size > offset) {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n") + 1;
    for (const line of text.slice(0, end).split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.stage === "ResponseComplete" || e.stage === "ResponseStarted" || e.stage === "Panic") {
          // Microseconds in the stamp: keep them, a fast client sends its requests within milliseconds.
          const [, frac = "0"] = /\.(\d+)Z$/.exec(e.requestReceivedTimestamp) ?? [];
          const at = Date.parse(e.requestReceivedTimestamp.replace(/\.\d+Z$/, "Z")) + Number(`0.${frac}`) * 1000;
          list.push({ id: e.auditID, at, user: e.user?.username, verb: e.verb, uri: e.requestURI, code: e.responseStatus?.code });
        }
      } catch {
        // a line cut by a rotation: skip it
      }
    }
    offsets.set(cluster, offset + Buffer.byteLength(text.slice(0, end)));
  }
  // Keep an hour: enough for any run, bounded for long ones.
  const cutoff = Date.now() - 3_600_000;
  const kept = list.filter((e) => e.at >= cutoff);
  events.set(cluster, kept);
  return kept;
}

/**
 * Reads these clusters' audit logs from where they end now on: a run's requests all come after its launch, and a log
 * can grow bigger than one string may be (100,000 namespaces' access checks add some 100 MB a run).
 */
export function markAudit(clusters) {
  for (const c of clusters) {
    const file = auditLog(c);
    if (!exists(file)) continue;
    offsets.set(c, statSync(file).size);
    events.set(c, []);
  }
}

/** Every request a run's user sent to these clusters, in the order the servers received them: one per audit ID. */
export function requestsOf(clusters, user) {
  const seen = new Map();
  for (const c of clusters) for (const e of read(c)) if (e.user === user && !seen.has(e.id)) seen.set(e.id, { ...e, cluster: c });
  return [...seen.values()].sort((a, b) => a.at - b.at);
}

const markers = new Map();

/**
 * A request of the benchmark's own marker user, waited for in the cluster's audit log: once it is there, every
 * request the servers received before it is written too (the log is written in batches, through the VM's file
 * share). Resolves to the server's clock minus this Mac's, to place a run's windows in the server's time; null if
 * the marker never showed up.
 */
export async function auditBarrier(cluster) {
  let creds = markers.get(cluster);
  if (!creds) {
    creds = await runUser(cluster, "bench-marker");
    markers.set(cluster, creds);
  }
  const token = Math.random().toString(36).slice(2);
  const kube = new Kube({ ...apiServer(cluster), ...creds });
  const sentAt = Date.now();
  try {
    await kube.get(`/api/v1/namespaces/default?benchmark-marker=${token}`).catch(() => {});
  } finally {
    kube.close();
  }
  const hit = await waitFor(() => read(cluster).find((e) => e.user === "bench-marker" && e.uri.includes(token)), { timeout: 15_000, every: 100 });
  return hit ? Math.round(hit.at - sentAt) : null;
}

/** A request's path without its query; names of single objects stay (a pod's log is its own path). */
export const pathOf = (uri) => uri.split("?")[0];

/**
 * What a run asked each cluster for, to check it opened the screen it was meant to (verify.mjs) and to see what it
 * did twice: per cluster, lists and watches by path, and its "list passes" — first pages of a list (no `continue=`),
 * each one a full list started again.
 */
export function screenSummary(requests) {
  const byCluster = {};
  for (const e of requests) {
    const c = (byCluster[e.cluster] ??= { list: {}, watch: {}, other: 0, passes: {} });
    const path = pathOf(e.uri);
    if (e.verb === "list" || e.verb === "watch") {
      c[e.verb][path] = (c[e.verb][path] ?? 0) + 1;
      if (e.verb === "list" && !/[?&]continue=/.test(e.uri)) c.passes[path] = (c.passes[path] ?? 0) + 1;
    } else c.other++;
  }
  return byCluster;
}

/**
 * A short fingerprint of what a client asks for to open a screen: the sorted set of verbs and paths, with object
 * names and queries left out. Two different fingerprints for one client and scenario are two ways it started.
 */
export function requestSignature(requests) {
  const shapes = new Set(requests.map((e) => `${e.verb} ${pathOf(e.uri).replace(/\/namespaces\/[^/]+/, "/namespaces/*")}`));
  return createHash("sha1").update([...shapes].sort().join("\n")).digest("hex").slice(0, 10);
}

export function summarize(list) {
  const byVerb = {};
  for (const e of list) byVerb[e.verb] = (byVerb[e.verb] ?? 0) + 1;
  return { total: list.length, byVerb, failed: list.filter((e) => e.code >= 400).length };
}

/**
 * The requests a client sends to open a screen: from its first request until it pauses for 3 seconds, and at most
 * until 5 seconds after it was ready (a client that polls never pauses). All in the servers' own clock.
 */
export function startupRequests(list, readyAfterMs) {
  if (!list.length) return [];
  const cap = list[0].at + readyAfterMs + 5_000;
  const out = [];
  let last = list[0].at;
  for (const e of list) {
    if (e.at > cap || e.at - last > 3_000) break;
    out.push(e);
    last = e.at;
  }
  return out;
}
