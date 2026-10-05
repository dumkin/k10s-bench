// k10s: started like every other app, in a profile of its own. What it shows is set before it starts, in what it
// remembers between starts (state.json, see src-tauri/src/prefs.rs): the clusters, the resource and the namespaces,
// exactly what it would restore after a person picked them, and for the log the pod whose Logs tab was open (k10s
// reopens the object that was open when it quit). Its window is the one it restores too.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { targetWindow } from "../probe.mjs";
import { launchBundle, profileDir, profileEnv, writeTauriWindow } from "./common.mjs";

const ID = "io.dumkin.k10s";

/** Where k10s keeps what it remembers, in the profile (its HOME). */
const stateFile = (profile) => join(profile, "Library/Application Support", ID, "state.json");

/** Changes what k10s remembers; `undefined` removes a value, and the rest stays (the column widths, say). */
function writeState(profile, values) {
  const file = stateFile(profile);
  let state = {};
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // none yet
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...state, ...values }, null, 2)}\n`);
}

export default {
  key: "k10s",
  name: "k10s",
  multiCluster: true,
  views: ["pods", "namespaces", "logs"],
  // Its window can't be read from outside: it is ready when the data is in (see measure.mjs).
  readiness: "data",
  // What it remembers and its window, for the fingerprint of the state every run starts from (state.mjs).
  stateFiles: [/io\.dumkin\.k10s\/[^/]+\.json$/],

  async launch(app, { contexts, view, pod }) {
    const profile = profileDir("k10s");
    writeState(profile, {
      clusters: contexts,
      resource: view === "namespaces" ? "namespaces" : "pods",
      // For the log: the namespace of the pod that writes it, so that the table holds that one pod.
      namespaces: view === "logs" ? ["shop"] : [],
      // The log opens the way it reopens after a restart: the pod's Logs tab. Every other view opens nothing.
      openObject: view === "logs" ? { cluster: contexts[0], resource: "pods", namespace: "shop", name: pod, tab: "logs" } : undefined,
    });
    writeTauriWindow(join(profile, "Library/Application Support", ID, ".window-state.json"), await targetWindow());
    return launchBundle(app, profileEnv(profile));
  },

  // Nothing to click: it opens on the saved view. A table is ready when the data is in; a log when it flows
  // (measure.mjs, from the proxies).
  async open() {
    return { hookAt: null };
  },
};
