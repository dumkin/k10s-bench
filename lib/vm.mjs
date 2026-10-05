// The benchmark's own Docker VM: a colima profile kept entirely under ~/.k10s-bench and the same on every Mac (4 CPUs,
// 8 GB), so that how fast the API servers answer doesn't depend on the Mac's own Docker setup. Nothing of the
// person's is touched: colima runs with a home and a docker config of its own (COLIMA_HOME and DOCKER_CONFIG under
// WORK), doesn't switch the docker context and writes no SSH config, and the VM sees only the clusters' folder.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORK, dir, exists, log, run, runVisible } from "./util.mjs";

export const VM = { profile: "k10s-bench", cpus: 4, memoryGB: 8, diskGB: 60, arch: "aarch64", vmType: "vz", mountType: "virtiofs", portForwarder: "ssh" };
const COLIMA_HOME = join(WORK, "colima");
const DOCKER_CONFIG = join(WORK, "docker");
/** The only folder the VM sees: kwokctl bind-mounts the clusters' configs, certificates and audit logs from it. */
export const SHARED = join(WORK, "kwok");

/**
 * Ports that containers open on all interfaces inside the VM reach this Mac on 127.0.0.1 only: colima's own rule would
 * forward them to every interface, and the API servers to the whole network. Lima reads this override from the VM's
 * own COLIMA_HOME, so no other VM is affected.
 */
const OVERRIDE = [
  "portForwards:",
  "  - guestIP: 0.0.0.0",
  "    guestIPMustBeZero: true",
  "    guestPortRange: [1, 65535]",
  "    hostIP: 127.0.0.1",
  "    hostPortRange: [1, 65535]",
  "    proto: tcp",
  "",
].join("\n");

const colimaEnv = () => ({ ...process.env, COLIMA_HOME, DOCKER_CONFIG });
const colima = (args, opts = {}) => run("colima", args, { env: colimaEnv(), ...opts });

function startArgs() {
  return [
    "start", VM.profile,
    "--cpus", String(VM.cpus), "--memory", String(VM.memoryGB), "--disk", String(VM.diskGB),
    "--arch", VM.arch, "--vm-type", VM.vmType, "--mount-type", VM.mountType, "--mount", `${SHARED}:w`,
    "--port-forwarder", VM.portForwarder, "--runtime", "docker", "--activate=false", "--ssh-config=false",
  ];
}

/** The profile as `colima list` shows it ({name, status, cpus, memory…}), or null if it was never created. */
async function listed() {
  const out = await colima(["list", "--json"]).catch(() => "");
  for (const line of out.split("\n")) {
    try {
      const vm = JSON.parse(line);
      if (vm.name === VM.profile) return vm;
    } catch {
      // not a profile line
    }
  }
  return null;
}

export async function status() {
  return JSON.parse(await colima(["status", VM.profile, "--json"]));
}

let socket = null;

/**
 * Creates or starts the VM and checks it is the benchmark's: the driver, architecture and mount it was made with
 * can't be changed by a restart (that needs `clean --vm`); CPUs and memory can, and are.
 */
export async function ensureVm() {
  if (socket) return socket;
  dir(SHARED);
  dir(COLIMA_HOME, "_lima", "_config");
  writeFileSync(join(COLIMA_HOME, "_lima", "_config", "override.yaml"), OVERRIDE);
  let vm = await listed();
  if (vm?.status === "Running") {
    const s = await status();
    if (s.cpu !== VM.cpus || Math.round(s.memory / 2 ** 30) !== VM.memoryGB) {
      log(`the benchmark's Docker VM has ${s.cpu} CPUs and ${Math.round(s.memory / 2 ** 30)} GB: restarting it with ${VM.cpus} and ${VM.memoryGB}`);
      await colima(["stop", VM.profile]);
      vm = { status: "Stopped" };
    }
  }
  if (vm?.status !== "Running") {
    log(vm ? "starting the benchmark's Docker VM" : "creating the benchmark's Docker VM (colima profile k10s-bench; the first time downloads its image)");
    await runVisible("colima", startArgs(), { env: colimaEnv() });
  }
  const s = await status();
  const mismatch = [
    s.driver !== "macOS Virtualization.Framework" && `driver ${s.driver}`,
    s.arch !== VM.arch && `arch ${s.arch}`,
    s.mount_type !== VM.mountType && `mounts ${s.mount_type}`,
    s.runtime !== "docker" && `runtime ${s.runtime}`,
  ].filter(Boolean);
  if (mismatch.length) throw new Error(`the benchmark's Docker VM was made differently (${mismatch.join(", ")}): delete it with node bench.mjs clean --vm`);
  // The clusters' folder must be writable in the VM: the API servers write their audit logs into it.
  await colima(["ssh", "--profile", VM.profile, "--", "test", "-w", SHARED]).catch(() => {
    throw new Error(`the benchmark's Docker VM can't write ${SHARED}: delete it with node bench.mjs clean --vm`);
  });
  socket = s.docker_socket;
  return socket;
}

/** The environment every docker and kwokctl call runs with: the benchmark's VM and docker config, never the person's. */
export async function dockerEnv() {
  const env = { ...process.env, DOCKER_HOST: await ensureVm(), DOCKER_CONFIG };
  delete env.DOCKER_CONTEXT;
  return env;
}

/** The only way the benchmark runs docker. */
export async function docker(args, opts = {}) {
  return run("docker", args, { env: await dockerEnv(), ...opts });
}

/** What makes this VM this VM: docker's daemon id. Clusters made in another VM have no containers here. */
export async function vmIdentity() {
  return (await docker(["info", "--format", "{{.ID}}"])).trim();
}

/** The VM as the results record it. */
export async function vmInfo() {
  const s = await status();
  const [cpus, memTotal, server, kernel] = (await docker(["info", "--format", "{{.NCPU}}|{{.MemTotal}}|{{.ServerVersion}}|{{.KernelVersion}}"])).trim().split("|");
  const version = (cmd, args) => run(cmd, args, { env: colimaEnv() }).then((o) => o.match(/\d+\.\d+\.\d+/)?.[0] ?? null, () => null);
  return {
    provider: "colima",
    profile: VM.profile,
    colima: await version("colima", ["version"]),
    lima: await version("limactl", ["--version"]),
    vmType: VM.vmType,
    mountType: s.mount_type,
    portForwarder: VM.portForwarder,
    arch: s.arch,
    cpus: Number(cpus),
    memoryGB: Math.round((Number(memTotal) / 2 ** 30) * 10) / 10,
    diskGB: Math.round(s.disk / 2 ** 30),
    docker: server,
    kernel,
  };
}

/**
 * Other VMs running on this Mac (Docker Desktop, OrbStack, other colima or lima profiles, Podman): each takes memory
 * and CPU from the apps being measured. The benchmark never stops them; it asks the person to.
 */
export async function otherVms() {
  const ps = await run("ps", ["-axo", "args="]);
  const found = [];
  if (/Docker Desktop\.app|com\.docker\.backend|com\.docker\.virtualization/.test(ps)) found.push("Docker Desktop");
  if (/OrbStack/.test(ps)) found.push("OrbStack");
  if (/Rancher Desktop/.test(ps)) found.push("Rancher Desktop");
  if (/\b(vfkit|krunkit|qemu-system-\w+)\b/.test(ps)) found.push("another virtual machine (vfkit, krunkit or qemu)");
  // Lima instances other than ours: their host agents name their instance folders.
  for (const m of ps.matchAll(/limactl hostagent .*?--pidfile (\S+)/g)) if (!m[1].startsWith(COLIMA_HOME)) found.push(`a lima/colima VM (${m[1].split("/").at(-2)})`);
  const vms = ps.split("\n").filter((l) => /com\.apple\.Virtualization\.VirtualMachine/.test(l)).length;
  const ours = (await listed())?.status === "Running" ? 1 : 0;
  if (vms > ours && !found.length) found.push(`${vms - ours} other virtual machine${vms - ours > 1 ? "s" : ""}`);
  return found;
}

/** Remembers which VM the clusters were made in; says whether that's still the one running. */
export async function sameVmAsBefore() {
  const marker = join(WORK, "vm.json");
  const id = await vmIdentity();
  const before = exists(marker) ? JSON.parse(readFileSync(marker, "utf8")).id : null;
  writeFileSync(marker, `${JSON.stringify({ profile: VM.profile, id })}\n`);
  return before === id;
}

export async function stopVm() {
  if ((await listed())?.status === "Running") await colima(["stop", VM.profile]);
}

export async function deleteVm() {
  if (await listed()) await colima(["delete", VM.profile, "--force", "--data"]).catch(() => colima(["delete", VM.profile, "--force"]));
  socket = null;
}
