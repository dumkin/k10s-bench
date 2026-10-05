// What every desktop client needs: a profile of its own, a launch the way the Dock does it, and a clean quit.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORK, dir, now, run, sleep, waitFor } from "../util.mjs";

/** Writes a settings file the way the apps do: JSON, its folder made if needed. */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * The window a Tauri app restores at start (tauri-plugin-window-state): the target window, in pixels, not
 * maximized. Apps write it only when they quit normally, which the benchmark's quit is not, so it holds.
 */
export function writeTauriWindow(file, target) {
  const px = (v) => Math.round(v * target.scale);
  const { x, y } = target;
  writeJson(file, { main: { width: px(target.width), height: px(target.height), x: px(x), y: px(y), prev_x: px(x), prev_y: px(y), maximized: false, visible: true, decorated: true, fullscreen: false } });
}

/**
 * A home folder for one client. Apps get it as HOME and as CFFIXED_USER_HOME (what Foundation and WebKit use),
 * so their settings, caches and logs stay in it and the real ones are never read or written.
 */
export function profileDir(client) {
  return dir(WORK, "profiles", client);
}

/** Puts the scenario's kubeconfig where the client looks for it: ~/.kube/config of its profile. */
export function writeKubeconfig(profile, text) {
  mkdirSync(join(profile, ".kube"), { recursive: true });
  const file = join(profile, ".kube", "config");
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** The environment a client starts with: its profile, the scenario's kubeconfig, a plain PATH, English. */
export function profileEnv(profile) {
  return {
    HOME: profile,
    CFFIXED_USER_HOME: profile,
    KUBECONFIG: join(profile, ".kube", "config"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  };
}

async function pidOf(exe) {
  const out = await run("ps", ["-axo", "pid=,args="]);
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && (m[2] === exe || m[2].startsWith(`${exe} `))) return Number(m[1]);
  }
  return null;
}

/** The processes whose command line matches `re`. */
export async function pidsMatching(re) {
  const out = await run("ps", ["-axo", "pid=,args="]);
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && re.test(m[2]))
    .map((m) => Number(m[1]));
}

/**
 * Starts an app bundle through LaunchServices (`open`), as a click in the Dock would: the app is then
 * responsible for its own WebKit processes, which is how the probe finds them. `urls` are handed to it at
 * launch, as a click on a link would (Aptakube opens some screens only that way). Resolves to the time of the
 * launch and the main process.
 */
export async function launchBundle(app, env, opts = {}) {
  const { args = [], urls = [] } = Array.isArray(opts) ? { args: opts } : opts;
  const t0 = now();
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  await run("open", ["-n", "-a", app.bundle, ...envArgs, ...urls, ...(args.length ? ["--args", ...args] : [])]);
  const pid = await waitFor(() => pidOf(app.bin), { timeout: 20_000, every: 20 });
  if (!pid) throw new Error(`${app.bin} did not start`);
  return { t0, pid };
}

/** Quits an app: politely first, then for sure. Helpers and WebKit processes go with it. */
export async function quitPid(pid, { grace = 5_000 } = {}) {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!alive()) return;
  process.kill(pid, "SIGTERM");
  if (await waitFor(() => !alive(), { timeout: grace, every: 50 })) return;
  process.kill(pid, "SIGKILL");
  await waitFor(() => !alive(), { timeout: 5_000, every: 50 });
}

/** Kills whatever is left of earlier runs of an app (a crash, an interrupted benchmark). */
export async function killStray(app) {
  for (;;) {
    const pid = await pidOf(app.bin);
    if (!pid) break;
    await quitPid(pid, { grace: 2_000 });
  }
  await sleep(300);
}

export const DEVTOOLS_PORT = { freelens: 9301, headlamp: 9302, lens: 9303 };
