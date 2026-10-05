// The clusters every client is measured against: KWOK clusters (a real API server, etcd and controllers, with
// simulated nodes and pods) in the benchmark's own Docker VM (vm.mjs). Nothing here reads or writes ~/.kube/config.
//
// A cluster is filled the way a busy one looks: Deployments in many namespaces, 20 pods each on average, about
// 100 pods per node, a sidecar in a third of the workloads. The controllers create the ReplicaSets and pods,
// the scheduler binds them and KWOK runs them, so the objects carry the fields and managedFields real ones do.
//
// Clients connect through a byte-counting proxy (proxy.mjs) as user `bench`, whose requests alone go to the
// audit log: that is how traffic and API requests are counted per client.

import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Kube } from "./kube.mjs";
import { WORK, dir, exists, log, run, waitFor } from "./util.mjs";
import { SHARED, docker, dockerEnv, sameVmAsBefore } from "./vm.mjs";

const KWOK_DIR = SHARED;
const AUDIT_POLICY = join(WORK, "audit-policy.yaml");

/**
 * Every cluster the scenarios use. `port` is the local port of its proxy: stable, so that clients which cache
 * discovery per server address find their cache again on the next run.
 */
export const CLUSTERS = {
  "bench-1k": { pods: 1_000, port: 17401, memory: "600MiB" },
  "bench-10k-1": { pods: 10_000, port: 17402, memory: "1GiB" },
  "bench-10k-2": { pods: 10_000, port: 17403, memory: "1GiB" },
  "bench-10k-3": { pods: 10_000, port: 17404, memory: "1GiB" },
  "bench-10k-4": { pods: 10_000, port: 17405, memory: "1GiB" },
  "bench-10k-5": { pods: 10_000, port: 17406, memory: "1GiB" },
  "bench-50k": { pods: 50_000, port: 17407, memory: "4GiB" },
  // Namespaces only. Its controller manager and scheduler are off: they would add a ServiceAccount and a
  // ConfigMap to every namespace, which no client looks at here and which would triple the setup time.
  "bench-100k-ns": { pods: 0, namespaces: 100_000, port: 17408, memory: "1500MiB", disable: ["kube-controller-manager", "kube-scheduler"] },
};

// Once the pods run, these have nothing left to do; stopped, they leave the Docker VM room for five clusters.
const SETUP_ONLY = ["kube-controller-manager", "kube-scheduler"];

async function env() {
  // kwokctl runs with its own HOME so that it can never touch ~/.kube, and with the benchmark's VM as its docker.
  return { ...(await dockerEnv()), HOME: dir(WORK, "kwok-home"), KWOK_WORKDIR: KWOK_DIR, KUBECONFIG: "" };
}

let vmChecked = false;
/**
 * Clusters made in another Docker VM can't start in this one: their etcd data lives inside their containers. Their
 * folders and the benchmark's credentials for them are deleted, and the clusters are made again.
 */
export async function ensureSameVm() {
  if (vmChecked) return;
  vmChecked = true;
  if (await sameVmAsBefore()) return;
  const clusters = exists(join(KWOK_DIR, "clusters")) ? readdirSync(join(KWOK_DIR, "clusters")) : [];
  if (!clusters.length && !exists(join(WORK, "k3s"))) return;
  log(`the clusters were made in another Docker VM (${clusters.join(", ") || "the logs cluster"}): making them again in this one`);
  rmSync(join(KWOK_DIR, "clusters"), { recursive: true, force: true });
  const home = join(WORK, "kwok-home");
  for (const f of exists(home) ? readdirSync(home) : []) if (f.endsWith(".kubeconfig")) rmSync(join(home, f), { force: true });
  rmSync(join(WORK, "k3s"), { recursive: true, force: true });
  rmSync(join(WORK, "run-certs"), { recursive: true, force: true });
}

const clusterDir = (name) => join(KWOK_DIR, "clusters", name);
const pki = (name, file) => join(clusterDir(name), "pki", file);

async function kwokctl(args) {
  return run("kwokctl", args, { env: await env() });
}

/**
 * kwokctl settings for a cluster: a soft memory limit for the Go components, so that five clusters of 10,000
 * pods fit into a Docker VM of 8 GB (the API server returns memory to the VM instead of keeping its peak).
 */
function writeConfig(name, spec) {
  const file = join(WORK, "kwok-home", `${name}.yaml`);
  const limit = (component, value) => `- name: ${component}\n  extraEnvs:\n  - name: GOMEMLIMIT\n    value: ${value}\n`;
  writeFileSync(
    file,
    "apiVersion: config.kwok.x-k8s.io/v1alpha1\nkind: KwokctlConfiguration\ncomponentsPatches:\n" +
      limit("kube-apiserver", spec.memory) +
      limit("kube-controller-manager", "400MiB") +
      limit("kube-scheduler", "300MiB"),
  );
  return file;
}

export async function existingClusters() {
  const out = await kwokctl(["get", "clusters"]).catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function running(name) {
  const out = await docker(["ps", "--filter", `name=^kwok-${name}-kube-apiserver$`, "--format", "{{.Names}}"]);
  return out.trim() !== "";
}

/** The API server's address on this machine, from the kubeconfig kwokctl wrote into the cluster's folder. */
export function apiServer(name) {
  const m = readFileSync(join(clusterDir(name), "kubeconfig.yaml"), "utf8").match(/server:\s*https:\/\/([\d.]+):(\d+)/);
  return { host: m[1], port: Number(m[2]) };
}

/** The benchmark's own credentials (cluster-admin, not audited). */
export function admin(name) {
  return { ...apiServer(name), ca: pki(name, "ca.crt"), crt: pki(name, "admin.crt"), key: pki(name, "admin.key") };
}

/**
 * Only the clients' requests are logged: not the controllers, not KWOK, not the benchmark's own requests.
 * Clients connect as users of group `bench`, one user per run (see `runUser`): the log says which run sent what.
 */
const AUDIT_POLICY_TEXT = `apiVersion: audit.k8s.io/v1
kind: Policy
omitStages: ["RequestReceived"]
rules:
  - level: Metadata
    userGroups: ["bench"]
  - level: None
`;

function writeAuditPolicy() {
  writeFileSync(AUDIT_POLICY, AUDIT_POLICY_TEXT);
}

/** Clusters created by an earlier version of the benchmark logged one user only: give them the current policy. */
async function updateAuditPolicy(name) {
  const file = join(clusterDir(name), "audit.yaml");
  if (!exists(file) || readFileSync(file, "utf8") === AUDIT_POLICY_TEXT) return;
  writeFileSync(file, AUDIT_POLICY_TEXT);
  log(`${name}: new audit policy, restarting its API server`);
  await docker(["restart", `kwok-${name}-kube-apiserver`]);
}

/** A client certificate for user `bench`, signed by the cluster's CA, bound to cluster-admin. */
async function benchUser(name, kube) {
  const key = pki(name, "bench.key");
  const crt = pki(name, "bench.crt");
  if (!exists(crt)) {
    const csr = pki(name, "bench.csr");
    await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-subj", "/O=bench/CN=bench", "-out", csr]);
    await run("openssl", ["x509", "-req", "-in", csr, "-CA", pki(name, "ca.crt"), "-CAkey", pki(name, "ca.key"), "-CAcreateserial", "-out", crt, "-days", "3650", "-sha256"]);
  }
  // Everyone in group `bench` (every run's user) is cluster-admin, as most people are in their own test clusters.
  const binding = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: { name: "bench-group" },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cluster-admin" },
    subjects: [{ apiGroup: "rbac.authorization.k8s.io", kind: "Group", name: "bench" }],
  };
  await kube.createAll([binding], () => "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
  return { key, crt, ca: pki(name, "ca.crt") };
}

/**
 * A client certificate for one run: user `user` in group `bench`, signed by the cluster's CA. The API server's
 * audit log then tells that run's requests from every other's, whatever the clocks say.
 */
export async function runUser(name, user) {
  const folder = dir(WORK, "run-certs", user);
  const key = join(folder, `${name}.key`);
  const crt = join(folder, `${name}.crt`);
  const csr = join(folder, `${name}.csr`);
  await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-subj", `/O=bench/CN=${user}`, "-out", csr]);
  await run("openssl", ["x509", "-req", "-in", csr, "-CA", pki(name, "ca.crt"), "-CAkey", pki(name, "ca.key"), "-CAcreateserial", "-out", crt, "-days", "30", "-sha256"]);
  return { key, crt, ca: pki(name, "ca.crt") };
}

const SERVICES = (
  "accounts ads analytics api-gateway audit auth billing cart catalog checkout comments config coupons delivery documents email events " +
  "experiments feed files fraud geo identity images inventory invoices ledger loyalty media messaging metrics notifications orders " +
  "partners payments pricing profiles promotions ratings recommendations refunds reports returns reviews search sessions shipping " +
  "subscriptions tax wallet"
).split(" ");
const ROLES = ["api", "worker", "consumer", "grpc", "web", "scheduler", "indexer", "cache", "admin", "migrator"];
// 200 pods per namespace, in workloads of different sizes.
const REPLICAS = [40, 30, 25, 20, 20, 20, 15, 12, 10, 8];
const PODS_PER_NODE = 100;

function node(zone, i) {
  const name = `worker-${zone}-${String(i + 1).padStart(4, "0")}`;
  return {
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name,
      annotations: { "node.alpha.kubernetes.io/ttl": "0", "kwok.x-k8s.io/node": "fake" },
      labels: {
        "kubernetes.io/arch": "amd64",
        "kubernetes.io/os": "linux",
        "kubernetes.io/hostname": name,
        "node.kubernetes.io/instance-type": "m6i.8xlarge",
        "topology.kubernetes.io/zone": zone,
        "node-role.kubernetes.io/worker": "",
        type: "kwok",
      },
    },
    status: {
      allocatable: { cpu: "32", memory: "128Gi", pods: "110", "ephemeral-storage": "200Gi" },
      capacity: { cpu: "32", memory: "128Gi", pods: "110", "ephemeral-storage": "200Gi" },
      nodeInfo: { architecture: "amd64", operatingSystem: "linux", kubeletVersion: "v1.36.1", containerRuntimeVersion: "containerd://2.1.4" },
      phase: "Running",
    },
  };
}

/** payments, checkout…, then payments-2, checkout-2… */
function namespaceName(i) {
  return i < SERVICES.length ? SERVICES[i] : `${SERVICES[i % SERVICES.length]}-${Math.floor(i / SERVICES.length) + 1}`;
}

function namespace(i) {
  const name = namespaceName(i);
  return { apiVersion: "v1", kind: "Namespace", metadata: { name, labels: { team: SERVICES[i % SERVICES.length], env: "production" } } };
}

function deployment(ns, role, index, replicas, zone) {
  const name = `${ns.replace(/-\d+$/, "")}-${role}`;
  const labels = { "app.kubernetes.io/name": name, "app.kubernetes.io/component": role, "app.kubernetes.io/part-of": ns };
  const containers = [
    {
      name: "app",
      image: `registry.example.com/${ns}/${name}:1.${index}.${(index * 7) % 10}`,
      ports: [
        { name: "http", containerPort: 8080 },
        { name: "metrics", containerPort: 9090 },
      ],
      env: [
        { name: "ZONE", value: zone },
        { name: "LOG_LEVEL", value: "info" },
        { name: "DB_HOST", value: `${ns}-db.${ns}.svc.cluster.local` },
        { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
        { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
        { name: "GOMAXPROCS", valueFrom: { resourceFieldRef: { resource: "limits.cpu" } } },
      ],
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "512Mi" } },
      readinessProbe: { httpGet: { path: "/ready", port: "http" }, periodSeconds: 10 },
      livenessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 15, periodSeconds: 20 },
      volumeMounts: [{ name: "config", mountPath: "/etc/app", readOnly: true }],
    },
  ];
  if (index % 3 === 0) {
    containers.push({
      name: "envoy",
      image: "envoyproxy/envoy:v1.35.3",
      args: ["--config-path", "/etc/envoy/envoy.yaml"],
      ports: [{ name: "proxy", containerPort: 15001 }],
      resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    });
  }
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: ns, labels: { ...labels, team: ns.replace(/-\d+$/, "") } },
    spec: {
      replicas,
      revisionHistoryLimit: 3,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels: { ...labels, version: `1.${index}` }, annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" } },
        spec: { containers, volumes: [{ name: "config", configMap: { name: `${name}-config`, optional: true } }], terminationGracePeriodSeconds: 30 },
      },
    },
  };
}

/** How many objects a list endpoint has (without listing them: the API server counts what is left). */
async function count(kube, path) {
  const page = await kube.get(`${path}${path.includes("?") ? "&" : "?"}limit=1`);
  return page.items.length + (page.metadata.remainingItemCount ?? 0);
}

async function fill(name, spec, zone, kube) {
  const namespaces = spec.namespaces ?? Math.ceil(spec.pods / 200);
  if ((await count(kube, "/api/v1/namespaces")) < namespaces) {
    log(`${name}: creating ${namespaces.toLocaleString("en-US")} namespaces`);
    await kube.createAll(Array.from({ length: namespaces }, (_, i) => namespace(i)), () => "/api/v1/namespaces", { concurrency: 64 });
  }
  if (!spec.pods) return;
  const nodes = Math.ceil(spec.pods / PODS_PER_NODE) + 2;
  if ((await count(kube, "/api/v1/nodes")) < nodes) {
    log(`${name}: creating ${nodes} nodes`);
    await kube.createAll(Array.from({ length: nodes }, (_, i) => node(zone, i)), () => "/api/v1/nodes");
  }
  if ((await count(kube, "/apis/apps/v1/deployments")) < (spec.pods / 200) * ROLES.length) {
    log(`${name}: creating deployments for ${spec.pods.toLocaleString("en-US")} pods`);
    const items = [];
    for (let i = 0; i < Math.ceil(spec.pods / 200); i++) ROLES.forEach((role, r) => items.push(deployment(namespaceName(i), role, r, REPLICAS[r], zone)));
    await kube.createAll(items, (d) => `/apis/apps/v1/namespaces/${d.metadata.namespace}/deployments`);
  }
  const started = Date.now();
  let last = 0;
  const done = await waitFor(
    async () => {
      const total = await count(kube, "/api/v1/pods").catch(() => 0);
      const notRunning = total ? await count(kube, "/api/v1/pods?fieldSelector=status.phase!%3DRunning").catch(() => 1) : 1;
      if (total !== last) log(`${name}: ${total.toLocaleString("en-US")} pods, ${notRunning.toLocaleString("en-US")} not running yet`);
      last = total;
      return total >= spec.pods && notRunning === 0;
    },
    { timeout: 30 * 60_000, every: 5_000 },
  );
  if (!done) throw new Error(`${name}: the pods did not all start within 30 minutes`);
  log(`${name}: all pods running (${Math.round((Date.now() - started) / 1000)} s)`);
}

/** Creates the cluster if needed, starts it, fills it, and returns how clients reach it. */
export async function ensureCluster(name) {
  await ensureSameVm();
  const spec = CLUSTERS[name];
  const zone = `z${Object.keys(CLUSTERS).indexOf(name) + 1}`;
  if (!(await existingClusters()).includes(name)) {
    writeAuditPolicy();
    log(`${name}: creating the cluster`);
    await kwokctl([
      "create", "cluster", "--name", name, "--runtime", "docker", "--config", writeConfig(name, spec),
      // The admin kubeconfig goes next to the cluster, never to ~/.kube/config.
      "--kubeconfig", join(WORK, "kwok-home", `${name}.kubeconfig`),
      "--disable-qps-limits",
      ...(spec.disable ? ["--disable", spec.disable.join(",")] : []),
      "--kube-audit-policy", AUDIT_POLICY,
      // Writing the audit log must not slow down the requests being measured; and it must never be rotated:
      // it is a file mounted into the container, which can't be renamed, so a full log would lose every
      // request after it (a client that checks its access in each of 100,000 namespaces fills 100 MB).
      "--extra-args", "kube-apiserver=audit-log-mode=batch",
      "--extra-args", "kube-apiserver=audit-log-maxsize=0",
      "--extra-args", "kube-apiserver=service-cluster-ip-range=10.96.0.0/12",
      "--wait", "5m",
    ]);
    // The controller can read its configuration before kwokctl has finished writing it (the file reaches the
    // Docker VM over a network mount): it then runs no pods at all. Started again, it reads all of it.
    await docker(["restart", `kwok-${name}-kwok-controller`]);
  } else if (!(await running(name))) {
    log(`${name}: starting`);
    await kwokctl(["start", "cluster", "--name", name, "--wait", "5m"]);
  }
  await updateAuditPolicy(name);
  const kube = new Kube(admin(name), { sockets: 64 });
  try {
    await waitFor(() => kube.get("/readyz").then(() => true, () => false), { timeout: 180_000, every: 1_000 });
    if (spec.pods) {
      // The ReplicaSets can only create pods once the namespace's default ServiceAccount exists.
      await waitFor(() => kube.get("/api/v1/namespaces/default/serviceaccounts/default").then(() => true, () => false), { timeout: 180_000, every: 1_000 });
    }
    const user = await benchUser(name, kube);
    await fill(name, spec, zone, kube);
    if (!spec.disable) await docker(["stop", ...SETUP_ONLY.map((c) => `kwok-${name}-${c}`)]).catch(() => {});
    return { name, ...spec, user, server: apiServer(name) };
  } finally {
    kube.close();
  }
}

export async function stopCluster(name) {
  if ((await existingClusters()).includes(name) && (await running(name))) {
    log(`${name}: stopping`);
    await kwokctl(["stop", "cluster", "--name", name]);
  }
}

export async function deleteClusters() {
  for (const name of await existingClusters()) {
    log(`${name}: deleting`);
    await kwokctl(["delete", "cluster", "--name", name]);
  }
}

/** The audit log of a cluster's API server, as seen from this machine. */
export function auditLog(name) {
  return join(clusterDir(name), "logs", "audit.log");
}

/** Pods to keep changing in a cluster: the first `n` pods of the listing, spread over namespaces. */
export async function somePods(name, n) {
  const kube = new Kube(admin(name));
  try {
    const pods = await kube.listAll("/api/v1/pods");
    const step = Math.max(1, Math.floor(pods.length / n));
    return pods.filter((_, i) => i % step === 0).slice(0, n).map((p) => ({ namespace: p.metadata.namespace, name: p.metadata.name }));
  } finally {
    kube.close();
  }
}

/**
 * A kubeconfig with `contexts` contexts named bench-z1, bench-z2…: context i reaches cluster `targets[i]`
 * through the proxy on `ports[i]`, as user `bench`. Credentials are embedded, so the file works anywhere.
 */
export function kubeconfig(targets, ports) {
  const b64 = (file) => readFileSync(file).toString("base64");
  const lines = ["apiVersion: v1", "kind: Config", "preferences: {}", "current-context: bench-z1", "clusters:"];
  targets.forEach((c, i) => {
    lines.push(`- name: bench-z${i + 1}`, "  cluster:", `    server: https://127.0.0.1:${ports[i]}`, `    certificate-authority-data: ${b64(c.user.ca)}`);
  });
  lines.push("users:");
  targets.forEach((c, i) => lines.push(`- name: bench-z${i + 1}`, "  user:", `    client-certificate-data: ${b64(c.user.crt)}`, `    client-key-data: ${b64(c.user.key)}`));
  lines.push("contexts:");
  targets.forEach((_, i) => lines.push(`- name: bench-z${i + 1}`, "  context:", `    cluster: bench-z${i + 1}`, `    user: bench-z${i + 1}`));
  return `${lines.join("\n")}\n`;
}

export async function kwokVersion() {
  return (await run("kwokctl", ["--version"]).catch(() => "")).match(/v(\d+\.\d+\.\d+)/)?.[1] ?? null;
}
