// Aptakube: closed source, a WKWebView with no automation hooks. It runs in a profile of its own (HOME and
// CFFIXED_USER_HOME point at it) with a copy of the person's trial or licence file, and opens what a run needs from
// the settings it reads at start, written before every launch: the contexts and namespaces it had open
// (cache.json), its start view and start behaviour (preferences.json), its window (.window-state.json). It never
// restores the screen it was on. The two screens it can't start on, Namespaces and a pod's log, open from its own
// links; a link opens a second window, the size of the screen, while the first stays on the context picker.
//
// The person's own Aptakube settings are only read, for the trial or licence file. Their Aptakube must not be
// running: only one Aptakube runs at a time, and it would get the benchmark's links.

import { copyFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { targetWindow } from "../probe.mjs";
import { REAL_HOME, dir, run, waitFor } from "../util.mjs";
import { launchBundle, profileDir, profileEnv, quitPid, writeJson, writeKubeconfig, writeTauriWindow } from "./common.mjs";

const VERSION = "1.21.1";
const ID = "com.aptakube.Aptakube";
const PERSON = join(REAL_HOME, "Library/Application Support", ID);
const profile = () => profileDir("aptakube");
const data = () => join(profile(), "Library/Application Support", ID);

/** Aptakube 1.21.1's preferences as it writes them, with the start behaviour the run needs and Pods to start on. */
function preferences(startupBehaviour) {
  return {
    proxy: "System",
    terminal: { linux: { image: "" }, program: "Automatic" },
    merge_kubeconfigs: false,
    kubeconfigs: null,
    custom_columns: {},
    theme: "",
    initialView: "Pods",
    startupBehaviour,
    update: { snoozeDuration: 3 },
    logViewer: { fontSize: 12, fontFamily: "JetBrains Mono" },
  };
}

/** What a run opens: Pods of the scenario's contexts in every namespace, or a link from the context picker. */
function plan(view, contexts, pod) {
  const ctx = encodeURIComponent(contexts.join(","));
  if (view === "namespaces") return { startup: "ContextSelector", connected: [], link: `aptakube://new_window/explore/${ctx}/_/v1/Namespace` };
  // Only an encoded "?" survives its link handler: a plain one opens the pod without its log.
  if (view === "logs") return { startup: "ContextSelector", connected: [], link: `aptakube://new_window/explore/${ctx}/shop/v1/Pod/${ctx}/shop/${pod}%3Ftab%3DLogs` };
  return { startup: "PreviousContext", connected: contexts, link: null };
}

async function seed({ startup, connected }) {
  const d = data();
  writeJson(join(d, "preferences.json"), preferences(startup));
  // tauri-plugin-store keeps JSON text as values. With no namespaces chosen it would open its kubeconfig's
  // namespace, not all of them.
  const cache = { "app.connected_contexts": JSON.stringify(connected) };
  for (const c of connected) cache[`context.${c}.current-namespaces`] = "[]";
  writeJson(join(d, "cache.json"), cache);
  writeTauriWindow(join(d, ".window-state.json"), await targetWindow());
}

/** Aptakube processes other than the benchmark's copy. */
async function otherInstances(app) {
  const out = await run("ps", ["-axo", "pid=,args="]);
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && /\/Aptakube\.app\/Contents\/MacOS\/Aptakube( |$)/.test(m[2]) && !m[2].startsWith(app.bin))
    .map((m) => Number(m[1]));
}

function canaryKubeconfig(port) {
  return [
    "apiVersion: v1",
    "kind: Config",
    "current-context: bench-canary",
    "clusters:",
    "- name: bench-canary",
    "  cluster:",
    `    server: https://127.0.0.1:${port}`,
    "    insecure-skip-tls-verify: true",
    "users:",
    "- name: bench-canary",
    "  user:",
    "    token: canary",
    "contexts:",
    "- name: bench-canary",
    "  context:",
    "    cluster: bench-canary",
    "    user: bench-canary",
    "",
  ].join("\n");
}

/**
 * Starts Aptakube on a cluster that is only a local port and waits for it to connect there. It connects only when
 * it got past any trial, licence or update screen, and, for `view` "namespaces", when the link reached the
 * benchmark's copy; nothing a person would have to click shows up in the runs.
 */
async function canary(app, view) {
  let connected = false;
  const server = createServer((socket) => {
    connected = true;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeKubeconfig(profile(), canaryKubeconfig(server.address().port));
  const p = plan(view, ["bench-canary"]);
  await seed(p);
  const { pid } = await launchBundle(app, profileEnv(profile()), { urls: p.link ? [p.link] : [] });
  const ok = await waitFor(() => connected, { timeout: 45_000, every: 250 });
  await quitPid(pid);
  server.close();
  if (!ok) {
    const how = view === "namespaces" ? "its link didn't reach the benchmark's copy" : "a trial, licence or update screen is waiting for a person";
    throw new Error(`Aptakube didn't connect to a test cluster (${how}). Look with: open -n -a "${app.bundle}" --env HOME="${profile()}" --env CFFIXED_USER_HOME="${profile()}"`);
  }
}

export default {
  key: "aptakube",
  name: "Aptakube",
  multiCluster: true,
  views: ["pods", "namespaces", "logs"],
  // Its window can't be read from outside: it is ready when the data is in (see measure.mjs).
  readiness: "data",
  // Its Workloads overview lists these, its Pods screen never; the window its Namespaces link opens lists no pods
  // (checked in each run's audit log, verify.mjs).
  screenRules: { pods: { notListed: ["/apis/apps/v1/", "/apis/batch/v1/"] }, namespaces: { notListed: ["/api/v1/pods"] } },
  // Its settings, for the fingerprint of the state every run starts from (state.mjs). Not the trial or licence file.
  stateFiles: [/com\.aptakube\.Aptakube\/[^/]+\.json$/],

  /** Once per benchmark run: the profile with the person's trial or licence, and a check that nothing waits for a person. */
  async prepare(app) {
    if (app.version !== VERSION) throw new Error(`Aptakube ${app.version}: the benchmark's settings for it are for ${VERSION}`);
    if ((await otherInstances(app)).length) throw new Error("Aptakube is open: quit it, only one Aptakube can run at a time");
    const d = dir(data());
    const files = ["license.bin", "trial.bin"].filter((f) => existsSync(join(PERSON, f)));
    if (!files.length) throw new Error("Aptakube has no trial or licence on this Mac: open it once to start a trial or enter a licence");
    for (const f of files) copyFileSync(join(PERSON, f), join(d, f));
    this.licence = files.includes("license.bin") ? "licence" : "trial";
    await canary(app, "pods");
    await canary(app, "namespaces");
  },

  async launch(app, { contexts, view, pod }) {
    if ((await otherInstances(app)).length) throw new Error("another Aptakube is running (only one can run at a time): this run was skipped");
    const p = plan(view, contexts, pod);
    await seed(p);
    this.link = p.link;
    return launchBundle(app, profileEnv(profile()), { urls: p.link ? [p.link] : [] });
  },

  // Nothing to click: it opens on its settings or its link. A table is ready when the data is in; a log when it
  // flows (measure.mjs, from the proxies).
  async open() {
    return { hookAt: null, link: this.link };
  },
};
