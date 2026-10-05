// Lens and Freelens (its open source fork): Electron apps driven over the DevTools protocol, the way a person
// clicks: the cluster in the catalog, then Pods or Namespaces in the cluster's sidebar.
//
// Both sync ~/.kube from the real home folder whatever HOME says, so the profile pins the folder to sync before
// the first start, and every start checks that the catalog holds the benchmark's contexts and nothing else.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Page } from "../cdp.mjs";
import { newestIn } from "../logs.mjs";
import { targetWindow } from "../probe.mjs";
import { askToContinue, exists, now, sleep } from "../util.mjs";
import { launchBundle, profileDir, profileEnv, quitPid } from "./common.mjs";

/** The cluster frame's execution context, for evaluating code inside it. */
async function clusterFrame(page) {
  const contexts = [];
  page.ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.method === "Runtime.executionContextCreated") contexts.push(d.params.context);
  });
  await page.send("Runtime.enable");
  return async (expression) => {
    const tree = await page.send("Page.getFrameTree");
    const frames = (tree.frameTree.childFrames ?? []).map((f) => f.frame);
    // The visible cluster: its frame's origin starts with the cluster id.
    for (const frame of frames) {
      const ctx = contexts.findLast((c) => c.auxData?.frameId === frame.id && c.auxData?.isDefault);
      if (!ctx) continue;
      const r = await page.send("Runtime.evaluate", { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true }).catch(() => null);
      if (r && !r.exceptionDetails && r.result.value) return r.result.value;
    }
    return null;
  };
}

/** A trusted mouse click on an element of the cluster frame (react-select ignores synthetic events). */
async function clickInFrame(page, inFrame, selector, text) {
  const rect = await inFrame(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) return false;
  const off = await page.eval(`(() => { const f = [...document.querySelectorAll("iframe")].find((f) => f.offsetParent !== null) ?? document.querySelector("iframe"); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
  const x = rect.x + off.x;
  const y = rect.y + off.y;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  return true;
}

function lensLike({ key, name, dataDir, port }) {
  const store = (profile) => join(profile, "Library/Application Support", dataDir);
  const clusterId = (profile, context) => createHash("md5").update(`${join(profile, ".kube", "config")}:${context}`).digest("hex");

  /**
   * Settings written before a start: sync only the profile's ~/.kube, show all namespaces of each cluster, nothing
   * left open from another scenario, and the benchmark's window. A cluster's settings are shared by every scenario
   * whose first context has its name: the log scenario used to leave a dock open with the pod's log in it, which
   * every later run then reopened (a terminal, and a log stream of a pod that isn't there).
   */
  function seed(profile, contexts, target) {
    mkdirSync(join(store(profile), "lens-local-storage"), { recursive: true });
    const userStore = join(store(profile), "lens-user-store.json");
    const user = exists(userStore) ? JSON.parse(readFileSync(userStore, "utf8")) : {};
    user.preferences = { ...user.preferences, syncKubeconfigEntries: [{ filePath: join(profile, ".kube") }] };
    writeFileSync(userStore, JSON.stringify(user, null, 2));
    for (const context of contexts) {
      const file = join(store(profile), "lens-local-storage", `${clusterId(profile, context)}.json`);
      const local = exists(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      writeFileSync(file, JSON.stringify({ selected_namespaces: [], ...(local.sidebar ? { sidebar: local.sidebar } : {}) }, null, 2));
    }
    const { width, height, x, y, frame } = target;
    writeFileSync(
      join(store(profile), "window-state-for-first-application-window.json"),
      JSON.stringify({ width, height, x, y, isMaximized: false, isFullScreen: false, displayBounds: { x: 0, y: 0, width: frame[0], height: frame[1] } }),
    );
  }

  return {
    key,
    name,
    multiCluster: false,
    views: ["pods", "namespaces", "logs"],
    devtoolsPort: port,
    // Ready when its window shows the table (read over DevTools).
    readiness: "hook",
    // Its settings, for the fingerprint of the state every run starts from (state.mjs).
    stateFiles: [new RegExp(`${dataDir}/[^/]+\\.json$`), /lens-local-storage\/[^/]+\.json$/],

    /** Lens works only for a signed-in Lens ID: the person running the benchmark signs in once, in its profile. */
    async setup(app, _scenario, contexts) {
      const profile = profileDir(key);
      const marker = join(profile, ".signed-in");
      if (key !== "lens" || exists(marker)) return;
      seed(profile, contexts, await targetWindow());
      const { pid } = await launchBundle(app, profileEnv(profile), [`--remote-debugging-port=${port}`, "--lang=en-US"]);
      await askToContinue(
        `Lens needs a Lens ID. In the Lens window that just opened (a separate profile, not your usual Lens):\n` +
          `  1. Sign in, and close any welcome or onboarding screens.\n` +
          `  2. Check that the catalog lists only bench-z… clusters.\n` +
          `  3. Leave Lens open.`,
      );
      await quitPid(pid);
      writeFileSync(marker, new Date().toISOString());
    },

    async launch(app, { contexts }) {
      const profile = profileDir(key);
      seed(profile, contexts, await targetWindow());
      return launchBundle(app, profileEnv(profile), [`--remote-debugging-port=${port}`, "--lang=en-US"]);
    },

    /**
     * Opens the first context's cluster and the view, as a person would, as soon as each control appears.
     * Resolves when the table lists `expect` objects.
     */
    async open({ view, expect, contexts, pod }, { timeout = 180_000 } = {}) {
      const page = await Page.attach(port, (t) => t.type === "page" && t.url.includes("renderer"), { timeout: 60_000 });
      this.page = page;
      const until = Date.now() + timeout;
      const left = () => Math.max(1, until - Date.now());
      // The catalog must hold the benchmark's contexts only: anything else means the real ~/.kube leaked in.
      await page.waitFor(`location.pathname.length > 0 && document.readyState === "complete"`, { timeout: left() });
      await page.eval(`(() => { history.pushState({}, "", "/catalog/entity.k8slens.dev/KubernetesCluster"); dispatchEvent(new PopStateEvent("popstate")); })()`);
      const names = await page.waitFor(
        `(() => { const rows = [...document.querySelectorAll(".TableRow")]; return rows.length ? rows.map((r) => r.textContent) : null; })()`,
        { timeout: left() },
      );
      if (!names) throw new Error(`${name}: the catalog did not show any cluster`);
      const foreign = names.filter((t) => !/bench-z\d+/.test(t));
      if (foreign.length) throw new Error(`${name}: the catalog lists clusters that are not the benchmark's; stopping before anything connects`);
      // The row whose name is exactly the context (bench-z1, not bench-z10).
      const picked = await page.eval(`(() => {
        const row = [...document.querySelectorAll(".TableRow")].find((r) => [...r.querySelectorAll("*")].some((c) => c.children.length === 0 && c.textContent.trim() === ${JSON.stringify(contexts[0])}));
        if (!row) return false;
        row.click();
        return true;
      })()`);
      if (!picked) throw new Error(`${name}: ${contexts[0]} is not in the catalog`);
      const inFrame = await clusterFrame(page);
      const item = view === "namespaces" ? "namespaces" : "pods";
      // Pods sit under Workloads, which starts folded: unfold it first.
      const anchor = item === "pods" ? "sidebar-item-workloads" : "link-for-sidebar-item-namespaces";
      if (!(await waitForFrame(inFrame, `document.querySelector("[data-testid=${anchor}]") ? true : null`, left()))) throw new Error(`${name}: the cluster view did not open`);
      if (item === "pods") {
        await inFrame(`(() => { if (!document.querySelector("[data-testid=link-for-sidebar-item-pods]")) document.querySelector("[data-testid=expand-icon-for-sidebar-item-workloads]").click(); return true; })()`);
        if (!(await waitForFrame(inFrame, `document.querySelector("[data-testid=link-for-sidebar-item-pods]") ? true : null`, left()))) throw new Error(`${name}: no Pods in the sidebar`);
      }
      await inFrame(`(() => { document.querySelector("[data-testid=link-for-sidebar-item-${item}]").click(); return true; })()`);
      const title = item === "pods" ? "Pods" : "Namespaces";
      const shown = await waitForFrame(
        inFrame,
        `(() => { const m = document.body.innerText.match(/${title}\\n([\\d,]+) items/); const rows = document.querySelectorAll(".TableRow").length; return m && Number(m[1].replace(/,/g, "")) >= ${expect} && rows > 1 ? Number(m[1].replace(/,/g, "")) : null; })()`,
        left(),
      );
      if (view !== "logs") return this.done({ hookAt: shown ? now() : null, shown });
      // The pod's row, then Logs in its details: the log opens in the dock and follows.
      const opened = await waitForFrame(
        inFrame,
        `(() => { const row = [...document.querySelectorAll(".TableRow")].find((r) => r.textContent.includes(${JSON.stringify(pod)})); if (!row) return null; row.click(); return true; })()`,
        left(),
      );
      if (!opened) throw new Error(`${name}: the pod is not in the table`);
      const clicked = await waitForFrame(
        inFrame,
        `(() => { const item = [...document.querySelectorAll(".Drawer .MenuItem")].find((e) => e.querySelector("[data-icon-name=subject]")); if (!item) return null; item.click(); return true; })()`,
        left(),
      );
      if (!clicked) throw new Error(`${name}: no Logs action for the pod`);
      const streaming = await waitForFrame(inFrame, `/request completed/.test(document.querySelector(".Dock")?.innerText ?? "") || null`, left());
      return this.done({ hookAt: streaming ? now() : null, shown: !!streaming });
    },

    /** Disconnects from DevTools once the screen shows: an attached debugger costs the app CPU while measured. */
    done(result) {
      this.page?.close();
      this.page = null;
      return result;
    },

    /** The newest line of the log it shows: the last of the lines its log list holds (it follows the bottom). */
    async newestShown() {
      if (!this.reader) {
        const page = await Page.attach(port, (t) => t.type === "page" && t.url.includes("renderer"), { timeout: 10_000 });
        this.reader = { page, inFrame: await clusterFrame(page) };
      }
      const last = await this.reader.inFrame(`(() => {
        const el = document.querySelector(".LogList");
        const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
        const stack = key ? [el[key]] : [];
        const seen = new Set();
        while (stack.length) {
          const f = stack.pop();
          if (!f || seen.has(f)) continue;
          seen.add(f);
          const items = f.memoizedProps?.items;
          if (Array.isArray(items)) return items.length ? String(items[items.length - 1]) : null;
          stack.push(f.child, f.sibling);
        }
        return null;
      })()`);
      return last ? newestIn(last) : null;
    },

    async close() {
      this.page?.close();
      this.page = null;
      this.reader?.page.close();
      this.reader = null;
    },
  };
}

async function waitForFrame(inFrame, expression, timeout) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await inFrame(expression).catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  return null;
}

export const freelens = lensLike({ key: "freelens", name: "Freelens", dataDir: "Freelens", port: 9301 });
export const lens = lensLike({ key: "lens", name: "Lens", dataDir: "Lens", port: 9303 });
export { clickInFrame };
