// k9s, in a 200×50 pseudo-terminal: started with the flags a person would type (--context, -A, -c pods). The
// terminal emulator around it is not counted: only k9s itself.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, now, run, waitFor } from "../util.mjs";
import { profileDir, profileEnv, quitPid } from "./common.mjs";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

export default {
  key: "k9s",
  name: "k9s",
  multiCluster: false,
  views: ["pods", "namespaces", "logs"],
  // Ready when its title shows the expected count (read from its terminal).
  readiness: "hook",
  // It runs as the harness's child, in its terminal: its CPU is in the harness's too (system.mjs summary).
  inHarness: true,
  // Its settings, for the fingerprint of the state every run starts from (state.mjs).
  stateFiles: [/k9s\/[^/]+\.ya?ml$/],

  async launch(app, { contexts, view }) {
    const profile = profileDir("k9s");
    const fifo = join(profile, "keys.fifo");
    rmSync(fifo, { force: true });
    await run("mkfifo", [fifo]);
    this.fifo = fifo;
    const resource = view === "namespaces" ? "ns" : "pods";
    // For the log: the pod's namespace, where it is the first (and only) row.
    const scope = view === "logs" ? ["-n", "shop"] : ["-A"];
    const env = { ...process.env, ...profileEnv(profile), TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete env.K9S_CONFIG_DIR;
    const t0 = now();
    this.child = spawn("python3", [join(ROOT, "lib/terminal.py"), "200", "50", fifo, "--", app.bin, "--context", contexts[0], ...scope, "-c", resource, "--readonly"], {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.raw = "";
    let pid = null;
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      if (pid == null) {
        buffer += chunk.toString("latin1");
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        pid = Number(buffer.slice(0, nl));
        chunk = Buffer.from(buffer.slice(nl + 1), "latin1");
      }
      // Only the recent output matters (the title is redrawn on every refresh). Escapes are taken out when it is
      // read: one can be split between two chunks.
      this.raw = (this.raw + chunk.toString("utf8")).slice(-300_000);
    });
    const ready = await waitFor(() => pid, { timeout: 10_000, every: 5 });
    if (!ready) throw new Error("k9s did not start");
    return { t0, pid };
  },

  /** k9s prints the number of objects in its title, `pods(all)[10,000]`: ready once it is the expected one. */
  async open({ view, expect }, { timeout = 180_000 } = {}) {
    if (view === "logs") {
      // The pod is selected as the only row: `l` opens its log, which follows by default.
      if (!(await waitFor(() => /pods\(shop\)\[1\]/i.test(this.screen), { timeout, every: 50 }))) return { hookAt: null, shown: null };
      await this.type("l");
      const shown = await waitFor(() => /request completed/.test(this.screen.slice(-20_000)), { timeout: 30_000, every: 50 });
      return { hookAt: shown ? now() : null, shown: !!shown };
    }
    const title = view === "namespaces" ? "Namespaces" : "Pods";
    const re = new RegExp(`${title}(?:\\(all\\))?\\[([\\d,]+)\\]`, "gi");
    let seen = null;
    const shown = await waitFor(
      () => {
        const matches = [...this.screen.matchAll(re)];
        seen = matches.at(-1)?.[0] ?? seen;
        const last = matches.map((m) => Number(m[1].replace(/,/g, ""))).at(-1);
        return last >= expect ? last : null;
      },
      { timeout, every: 100 },
    );
    if (!shown) {
      // The same words every time (two failures alike stop a cell, schedule.mjs); what its title said goes with them.
      const error = new Error(`k9s did not show ${expect.toLocaleString("en-US")} within ${Math.round(timeout / 1000)} s`);
      error.detail = `its title last said ${seen ?? "nothing"}`;
      throw error;
    }
    return { hookAt: now(), shown };
  },

  /** What k9s has drawn lately, without terminal escapes. */
  get screen() {
    return (this.raw ?? "").replace(ANSI, "");
  },

  /** Typed into k9s, as on a keyboard. */
  async type(text) {
    await run("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", text, this.fifo]);
  },

  async quit(pid) {
    await quitPid(pid);
    this.child?.kill();
  },
};
