// The clients under test: which build of each one, where it comes from, and getting it onto this machine.
//
// clients.lock.json pins the exact downloads (URL and SHA-256) so that every machine measures the same builds; a
// k10s release goes there too, once there is one. `loadLock({ update: true })` replaces the other clients' pins with
// the latest versions Homebrew and GitHub know about, and keeps k10s's.

import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ROOT, WORK, dir, exists, log, run, runVisible } from "./util.mjs";

const LOCK = join(ROOT, "clients.lock.json");
const CASKS = ["freelens", "headlamp", "lens", "aptakube"];

async function json(url) {
  const res = await fetch(url, { headers: { "user-agent": "k10s-bench" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

/** The newest version of every client, from Homebrew's API (casks) and GitHub (k9s). */
async function latest() {
  const lock = {};
  for (const token of CASKS) {
    const cask = await json(`https://formulae.brew.sh/api/cask/${token}.json`);
    // The cask's main url is the Apple silicon one when the cask has per-architecture downloads.
    const app = cask.artifacts.find((a) => a.app)?.app[0];
    lock[token] = { version: cask.version, url: cask.url, sha256: cask.sha256, app };
  }
  const release = await json("https://api.github.com/repos/derailed/k9s/releases/latest");
  const asset = release.assets.find((a) => a.name === "k9s_Darwin_arm64.tar.gz");
  const sums = await (await fetch(release.assets.find((a) => a.name === "checksums.sha256").browser_download_url)).text();
  const sha256 = sums.split("\n").find((l) => l.endsWith(` ${asset.name}`))?.split(/\s+/)[0];
  lock.k9s = { version: release.tag_name.replace(/^v/, ""), url: asset.browser_download_url, sha256 };
  return lock;
}

export async function loadLock({ update = false } = {}) {
  const pinned = exists(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {};
  if (!update && exists(LOCK)) return pinned;
  const lock = { ...(pinned.k10s ? { k10s: pinned.k10s } : {}), ...(await latest()) };
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  log(`pinned client versions in ${LOCK}`);
  return lock;
}

async function download(url, file, sha256) {
  if (exists(file)) return;
  const res = await fetch(url, { headers: { "user-agent": "k10s-bench" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const hash = createHash("sha256");
  const part = `${file}.part`;
  const body = Readable.fromWeb(res.body);
  body.on("data", (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(part));
  const got = hash.digest("hex");
  if (sha256 && got !== sha256) {
    rmSync(part);
    throw new Error(`${url}: SHA-256 ${got}, expected ${sha256}`);
  }
  renameSync(part, file);
}

/** Copies the app bundle out of a disk image. */
async function extractDmg(dmg, appName, dest) {
  const mount = dir(WORK, "mnt", String(process.pid));
  await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg]);
  try {
    await run("ditto", [join(mount, appName), join(dest, appName)]);
  } finally {
    await run("hdiutil", ["detach", mount, "-force"]).catch(() => {});
  }
}

/** Why there is no k10s to measure, and how to give it one. */
export const NO_K10S = "no k10s to measure: pin a release in clients.lock.json, or pass --k10s <a k10s checkout>, or set K10S_APP=<a k10s.app>";

/**
 * Where each client's executable is, after downloading it if needed. k10s comes from a k10s checkout (`checkout`, see
 * ensureK10s) or an app named by `K10S_APP` when given, else from its pinned release like every other client.
 */
export async function ensureApps(names, lock, { build = false, checkout = null } = {}) {
  const apps = {};
  const downloads = dir(WORK, "downloads");
  for (const name of names) {
    if (name === "k10s" && (checkout || process.env.K10S_APP)) {
      apps.k10s = await ensureK10s({ build, checkout });
      continue;
    }
    const pin = lock[name];
    if (!pin) throw new Error(name === "k10s" ? NO_K10S : `no pinned build for ${name} in ${LOCK}`);
    const dest = join(WORK, "apps", `${name}-${pin.version}`);
    const archive = join(downloads, pin.url.split("/").pop());
    if (name === "k9s") {
      if (!exists(join(dest, "k9s"))) {
        log(`downloading k9s ${pin.version}`);
        await download(pin.url, archive, pin.sha256);
        dir(dest);
        await run("tar", ["-xzf", archive, "-C", dest, "k9s"]);
      }
      apps.k9s = { version: pin.version, bin: join(dest, "k9s"), bundle: join(dest, "k9s") };
      continue;
    }
    if (!exists(join(dest, pin.app))) {
      log(`downloading ${name} ${pin.version}`);
      await download(pin.url, archive, pin.sha256);
      dir(dest);
      await extractDmg(archive, pin.app, dest);
    }
    const bundle = join(dest, pin.app);
    const exe = readFileSync(join(bundle, "Contents/Info.plist"), "utf8").match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)</)?.[1];
    apps[name] = { version: pin.version, bundle, bin: join(bundle, "Contents/MacOS", exe ?? pin.app.replace(/\.app$/, "")) };
  }
  return apps;
}

/** Whether there is a k10s to measure (doctor): a checkout or an app given, or a pinned release. */
export const k10sAvailable = (lock, checkout) => !!(checkout || process.env.K10S_APP || lock.k10s);

/** What k10s is built from: the files of the app, so that a change elsewhere in the checkout builds nothing again. */
const APP_SOURCES = ["ui", "crates", "Cargo.toml", "Cargo.lock"];

/**
 * The app's last commit in a checkout, with ", modified" if its files have changes that aren't committed; and a stamp
 * that also tells those changes apart (a hash of them), so that a build is redone only when what it is built from
 * changed.
 */
async function appCommit(root) {
  const git = (args) => run("git", args, { cwd: root }).then((o) => o.trimEnd(), () => "");
  const commit = await git(["log", "-1", "--format=%h", "--", ...APP_SOURCES]);
  if (!commit) return { label: null, stamp: null };
  const diff = await git(["diff", "HEAD", "--", ...APP_SOURCES]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "--", ...APP_SOURCES])).split("\n").filter(Boolean);
  if (!diff && !untracked.length) return { label: commit, stamp: commit };
  const hash = createHash("sha1").update(diff);
  for (const f of untracked) hash.update(f).update(readFileSync(join(root, f)));
  return { label: `${commit}, modified`, stamp: `${commit}+${hash.digest("hex").slice(0, 12)}` };
}

/**
 * k10s from a k10s checkout (`checkout`): its release bundle in target/, built again when it isn't from the
 * checkout's app files (a stamp in the bundle's folder says what it was built from) or with `build`. Else the app
 * `K10S_APP` names: a released .app, to measure exactly what users download.
 */
async function ensureK10s({ build = false, checkout = null } = {}) {
  let bundle = process.env.K10S_APP;
  let commit = null;
  if (checkout) {
    const root = resolve(checkout);
    if (!exists(join(root, "crates/k10s-app"))) throw new Error(`${root} is not a k10s checkout: there is no crates/k10s-app in it`);
    bundle = join(root, "target/release/bundle/macos/k10s.app");
    const stampFile = join(root, "target/release/bundle/macos/.bench-commit");
    const source = await appCommit(root);
    commit = source.label;
    const builtFrom = exists(stampFile) ? readFileSync(stampFile, "utf8").trim() : null;
    if (build || !exists(bundle) || builtFrom !== source.stamp) {
      log(`building k10s from ${commit} in ${root} (npm --prefix ui run tauri build -- --bundles app)`);
      // The npm of the Node running the benchmark: an older default Node can't build the app.
      await runVisible(join(dirname(process.execPath), "npm"), ["--prefix", "ui", "run", "tauri", "build", "--", "--bundles", "app"], { cwd: root, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
      writeFileSync(stampFile, `${source.stamp}\n`);
    }
  }
  const plist = readFileSync(join(bundle, "Contents/Info.plist"), "utf8");
  const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)</)?.[1];
  return { version: commit ? `${version} (${commit})` : version, bundle, bin: join(bundle, "Contents/MacOS/k10s") };
}

/** Sizes of each client as installed: what `du` says about the app bundle (or the binary). */
export async function installedSize(app) {
  const kb = Number((await run("du", ["-sk", app.bundle])).split("\t")[0]);
  return (kb * 1024) / 1e6;
}

export function downloadedArchives() {
  return exists(join(WORK, "downloads")) ? readdirSync(join(WORK, "downloads")) : [];
}
