// Headlamp: an Electron app with a Go backend (headlamp-server, counted with it). Driven over the DevTools
// protocol through its own routes, `#/c/<cluster>/pods`; several clusters are `#/c/<a>+<b>/pods`.

import { Page } from "../cdp.mjs";
import { newestIn } from "../logs.mjs";
import { targetWindow } from "../probe.mjs";
import { now, sleep } from "../util.mjs";
import { launchBundle, profileDir, profileEnv } from "./common.mjs";

const PORT = 9302;

export default {
  key: "headlamp",
  name: "Headlamp",
  multiCluster: true,
  views: ["pods", "namespaces", "logs"],
  devtoolsPort: PORT,
  // Ready when its window shows the table (read over DevTools).
  readiness: "hook",
  // Its settings files, for the fingerprint of the state every run starts from (state.mjs); its localStorage (a
  // LevelDB) is set over DevTools at every start instead.
  stateFiles: [/Headlamp\/[^/]+\.json$/],

  async launch(app) {
    const profile = profileDir("headlamp");
    return launchBundle(app, profileEnv(profile), [`--remote-debugging-port=${PORT}`, "--lang=en-US"]);
  },

  async open({ view, expect, contexts, pod, namespace }, { timeout = 180_000 } = {}) {
    const page = await Page.attach(PORT, (t) => t.type === "page" && t.url.includes("index.html"), { timeout: 60_000 });
    this.page = page;
    // What it kept from earlier runs goes back to the benchmark's settings: the English labels it reads, Headlamp's
    // own page size (one Mac had kept 100 rows a page), every namespace of each cluster. One reload applies them.
    const changed = await page
      .eval(`(() => {
        let changed = false;
        const set = (k, v) => { if (localStorage.getItem(k) !== v) { localStorage.setItem(k, v); changed = true; } };
        const drop = (k) => { if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); changed = true; } };
        set("i18nextLng", "en");
        drop("tables_rows_per_page");
        for (const ctx of ${JSON.stringify(contexts)}) drop("headlamp-selected-namespace_" + ctx);
        return changed;
      })()`)
      .catch(() => false);
    if (changed) {
      await page.eval("location.reload()");
      await page.waitFor(`document.readyState === "complete"`, { timeout: 30_000 });
    }
    // It sizes its window to the screen; the benchmark gives it the same window as the others.
    this.window = await page.resizeWindow(await targetWindow());
    const until = Date.now() + timeout;
    const left = () => Math.max(1, until - Date.now());
    // The home screen lists the clusters of the kubeconfig: they must be the benchmark's and nothing else.
    await page.eval(`location.hash = "#/"`);
    const names = await page.waitFor(
      `(() => { const t = document.body.innerText; return /bench-z\\d+/.test(t) ? [...new Set(t.match(/Kubeconfig: [^\\n]+/g) ?? [])] : null; })()`,
      { timeout: left() },
    );
    if (!names) throw new Error("Headlamp: the home screen did not list the benchmark's clusters");
    if (names.some((n) => !n.includes(".k10s-bench"))) throw new Error("Headlamp: it lists clusters from another kubeconfig; stopping");
    if (view === "logs") {
      // The pod's page, then Show Logs: Headlamp's log viewer opens and follows.
      await page.eval(`location.hash = ${JSON.stringify(`#/c/${contexts[0]}/pods/${namespace}/${pod}`)}`);
      const clicked = await page.waitFor(
        `(() => { const b = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Show Logs"); if (!b) return null; b.click(); return true; })()`,
        { timeout: left() },
      );
      if (!clicked) throw new Error("Headlamp: no Show Logs button on the pod's page");
      const streaming = await page.waitFor(`/request completed/.test(document.querySelector(".xterm-rows")?.textContent ?? "") || null`, { timeout: left() });
      return this.done({ hookAt: streaming ? now() : null, shown: !!streaming });
    }
    const resource = view === "namespaces" ? "namespaces" : "pods";
    await page.eval(`location.hash = ${JSON.stringify(`#/c/${contexts.join("+")}/${resource}`)}`);
    // Ready: rows in the table and no progress indicator left in the main area. A list loaded in part ("1,000 of
    // ~10,000", with Load more) is ready when that count holds for a second: several clusters' first pages come one
    // after another, and the count grows with each (200, 400… of a total that grows too). Ready is when it got there.
    const read = `(() => {
      const main = document.querySelector("main") ?? document.body;
      const rows = main.querySelectorAll("tbody tr").length;
      const busy = main.querySelector("[role=progressbar]");
      // "1,000 of ~10,000" with Load more: only part of the list is loaded. "1–100 of 1,000" is just pages.
      const more = main.innerText.match(/([\\d,]+) of ~([\\d,]+)/);
      return rows > 1 && !busy ? { rows, partial: !!more, loaded: more ? Number(more[1].replace(/,/g, "")) : null, total: more ? Number(more[2].replace(/,/g, "")) : null } : null;
    })()`;
    let shown = null;
    let hookAt = null;
    let last = null;
    let since = 0;
    while (Date.now() < until) {
      const v = await page.eval(read).catch(() => null);
      const key = v && JSON.stringify([v.loaded, v.total]);
      if (v && !v.partial) {
        [shown, hookAt] = [v, now()];
        break;
      }
      if (key !== last) [last, since] = [key, now()];
      else if (v && now() - since >= 1_000) {
        [shown, hookAt] = [v, since];
        break;
      }
      await sleep(100);
    }
    return this.done({ hookAt, shown, expect });
  },

  /** Disconnects from DevTools once the screen shows: an attached debugger costs the app CPU while measured. */
  done(result) {
    this.page?.close();
    this.page = null;
    return result;
  },

  /** The newest line of the log it shows: in the rows of its log terminal. */
  async newestShown() {
    this.reader ??= await Page.attach(PORT, (t) => t.type === "page" && t.url.includes("index.html"), { timeout: 10_000 });
    const text = await this.reader.eval(`document.querySelector(".xterm-rows")?.textContent ?? ""`);
    return text ? newestIn(text) : null;
  },

  async close() {
    this.page?.close();
    this.page = null;
    this.reader?.close();
    this.reader = null;
  },
};
