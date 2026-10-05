// The log scenario needs a container that really writes a log, which KWOK's simulated pods don't do: a small
// k3s cluster in the benchmark's Docker VM (vm.mjs) runs one pod that writes 300 JSON lines a second, the way a busy
// service logs its requests. Clients follow that pod's log.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSameVm } from "./clusters.mjs";
import { Kube } from "./kube.mjs";
import { WORK, dir, exists, log, run, waitFor } from "./util.mjs";
import { docker } from "./vm.mjs";

export const LOGS = { name: "bench-logs", port: 17420, apiPort: 16443, namespace: "shop", deployment: "checkout-api", rate: 300 };
const IMAGE = "rancher/k3s:v1.33.4-k3s1";
const CONTAINER = "k10s-bench-logs";
const base = () => dir(WORK, "k3s");
const adminKube = () => {
  const certs = base();
  return new Kube({ host: "127.0.0.1", port: LOGS.apiPort, ca: join(certs, "ca.crt"), crt: join(certs, "admin.crt"), key: join(certs, "admin.key") });
};

// 300 lines a second in bursts every 100 ms, the way request logs come; when the bursts fall behind the clock
// (sleep takes a little longer than asked), the next ones catch up, so the rate holds on any machine.
const GENERATOR = String.raw`awk 'BEGIN {
  srand(); n = 0; start = systime()
  split("GET GET GET POST PUT DELETE", m, " ")
  split("/api/v1/orders /api/v1/cart /api/v1/payments /api/v1/users /api/v1/inventory /healthz", p, " ")
  while (1) {
    due = 300 * (systime() - start + 1) - n
    burst = due > 30 ? (due > 300 ? 300 : due) : 30
    if (due <= 0) burst = 0
    for (i = 0; i < burst; i++) {
      n++
      s = rand() < 0.02 ? 500 : (rand() < 0.05 ? 404 : 200)
      lvl = s >= 500 ? "error" : (s >= 400 ? "warn" : "info")
      printf "{\"ts\":\"%s\",\"level\":\"%s\",\"msg\":\"request completed\",\"method\":\"%s\",\"path\":\"%s/%d\",\"status\":%d,\"duration_ms\":%d,\"bytes\":%d,\"user\":\"user-%d\",\"trace_id\":\"%04x%04x%04x%04x\",\"seq\":%d}\n", strftime("%Y-%m-%dT%H:%M:%SZ"), lvl, m[int(rand()*6)+1], p[int(rand()*6)+1], int(rand()*100000), s, int(rand()*rand()*900)+3, int(rand()*20000), int(rand()*500), int(rand()*65536), int(rand()*65536), int(rand()*65536), int(rand()*65536), n
    }
    fflush()
    system("sleep 0.1")
  }
}'`;
const GENERATOR_VERSION = "2";

function manifest() {
  const { namespace, deployment } = LOGS;
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: deployment, namespace, labels: { app: deployment }, annotations: { "k10s-bench/generator": GENERATOR_VERSION } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: deployment } },
        template: {
          metadata: { labels: { app: deployment } },
          spec: {
            terminationGracePeriodSeconds: 1,
            containers: [{ name: "app", image: "busybox:1.37", command: ["sh", "-c", GENERATOR], resources: { requests: { cpu: "50m", memory: "16Mi" } } }],
          },
        },
      },
    },
  ];
}

/** Starts the k3s cluster (created on first use) with its log-writing pod; returns how clients reach it. */
export async function ensureLogsCluster() {
  await ensureSameVm();
  const state = (await docker(["ps", "-a", "--filter", `name=^${CONTAINER}$`, "--format", "{{.State}}"])).trim();
  if (!state) {
    log(`${LOGS.name}: creating a k3s cluster`);
    await docker([
      "run", "-d", "--name", CONTAINER, "--privileged", "-p", `127.0.0.1:${LOGS.apiPort}:6443`,
      IMAGE, "server", "--disable=traefik,metrics-server,servicelb", "--tls-san=127.0.0.1",
    ]);
  } else if (state !== "running") {
    log(`${LOGS.name}: starting`);
    await docker(["start", CONTAINER]);
  }
  const certs = base();
  const read = (path) => docker(["exec", CONTAINER, "cat", path]);
  const ready = await waitFor(() => read("/etc/rancher/k3s/k3s.yaml").then(() => true, () => false), { timeout: 120_000, every: 1_000 });
  if (!ready) throw new Error(`${LOGS.name}: k3s did not start`);
  // The benchmark's own admin credentials, and a client certificate for user `bench` like on the KWOK clusters.
  const admin = await read("/etc/rancher/k3s/k3s.yaml");
  const field = (k) => Buffer.from(admin.match(new RegExp(`${k}: (\\S+)`))[1], "base64");
  writeFileSync(join(certs, "ca.crt"), field("certificate-authority-data"));
  writeFileSync(join(certs, "admin.crt"), field("client-certificate-data"));
  writeFileSync(join(certs, "admin.key"), field("client-key-data"));
  if (!exists(join(certs, "bench.crt"))) {
    writeFileSync(join(certs, "client-ca.crt"), await read("/var/lib/rancher/k3s/server/tls/client-ca.crt"));
    writeFileSync(join(certs, "client-ca.key"), await read("/var/lib/rancher/k3s/server/tls/client-ca.key"));
    await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certs, "bench.key"), "-subj", "/O=bench/CN=bench", "-out", join(certs, "bench.csr")]);
    await run("openssl", ["x509", "-req", "-in", join(certs, "bench.csr"), "-CA", join(certs, "client-ca.crt"), "-CAkey", join(certs, "client-ca.key"), "-CAcreateserial", "-out", join(certs, "bench.crt"), "-days", "3650", "-sha256"]);
  }
  const server = { host: "127.0.0.1", port: LOGS.apiPort };
  const kube = new Kube({ ...server, ca: join(certs, "ca.crt"), crt: join(certs, "admin.crt"), key: join(certs, "admin.key") });
  try {
    await waitFor(() => kube.get("/readyz").then(() => true, () => false), { timeout: 120_000, every: 1_000 });
    await waitFor(() => kube.get("/api/v1/namespaces/default/serviceaccounts/default").then(() => true, () => false), { timeout: 120_000, every: 1_000 });
    const binding = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "bench" },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "cluster-admin" },
      subjects: [{ apiGroup: "rbac.authorization.k8s.io", kind: "User", name: "bench" }],
    };
    await kube.createAll([binding], () => "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings");
    const [ns, deploy] = manifest();
    await kube.createAll([ns], () => "/api/v1/namespaces");
    const path = `/apis/apps/v1/namespaces/${LOGS.namespace}/deployments`;
    const current = await kube.get(`${path}/${LOGS.deployment}`).catch(() => null);
    if (!current) await kube.request("POST", path, deploy);
    else if (current.metadata.annotations?.["k10s-bench/generator"] !== GENERATOR_VERSION) {
      await kube.request("PUT", `${path}/${LOGS.deployment}`, { ...deploy, metadata: { ...deploy.metadata, resourceVersion: current.metadata.resourceVersion } });
      // The old pod goes; wait for the new one below.
      await waitFor(async () => (await kube.get(`/api/v1/namespaces/${LOGS.namespace}/pods?labelSelector=app%3D${LOGS.deployment}`)).items.length === 1, { timeout: 120_000, every: 1_000 });
    }
    // The pod of the current template: the only one left, running and ready (a replaced one goes in a second).
    const pod = await waitFor(
      async () => {
        const pods = (await kube.get(`/api/v1/namespaces/${LOGS.namespace}/pods?labelSelector=app%3D${LOGS.deployment}`)).items;
        const running = pods.filter((p) => p.status.phase === "Running" && p.status.containerStatuses?.[0]?.ready && !p.metadata.deletionTimestamp);
        return pods.length === 1 && running.length === 1 ? running[0].metadata.name : null;
      },
      { timeout: 300_000, every: 2_000 },
    );
    if (!pod) throw new Error(`${LOGS.name}: the log-writing pod did not start`);
    // Just after k3s restarts, the pod still reads as ready while its kubelet can't serve logs yet (the API server's
    // proxy to it answers 502): wait until a read of its log works.
    const readable = await waitFor(() => kube.request("GET", `/api/v1/namespaces/${LOGS.namespace}/pods/${pod}/log?tailLines=1`).then(() => true, () => false), { timeout: 180_000, every: 2_000 });
    if (!readable) throw new Error(`${LOGS.name}: the pod's log can't be read`);
    return { name: LOGS.name, port: LOGS.port, server, pod, user: { ca: join(certs, "ca.crt"), crt: join(certs, "bench.crt"), key: join(certs, "bench.key") } };
  } finally {
    kube.close();
  }
}

/**
 * Reads the newest line the log-writing pod wrote, with the benchmark's own credentials: its `seq` and `ts` (whole
 * seconds), to tell how far behind it the clients show their log.
 */
export function newestLine(pod) {
  const kube = adminKube();
  return {
    async read() {
      const text = String(await kube.request("GET", `/api/v1/namespaces/${LOGS.namespace}/pods/${pod}/log?tailLines=1`));
      return lineOf(text);
    },
    close: () => kube.close(),
  };
}

/**
 * How many bytes a second the pod's log grows by, over its last 20 s, read with the benchmark's own credentials: the
 * reference for when a client's log is flowing (the apps whose screen can't be read) and how much of it arrives.
 */
export async function logRate(pod) {
  const kube = adminKube();
  try {
    const text = String(await kube.request("GET", `/api/v1/namespaces/${LOGS.namespace}/pods/${pod}/log?sinceSeconds=20`));
    return Buffer.byteLength(text) / 20;
  } finally {
    kube.close();
  }
}

/** The size of the pod's container log file on its node now: k3s rotates it at 10 MiB, and clients that fetch more
 * than a short tail get more or less of it depending on where in that cycle they open it. */
export async function logFileBytes() {
  const out = await docker(["exec", CONTAINER, "sh", "-c", `stat -c %s /var/log/pods/${LOGS.namespace}_${LOGS.deployment}-*/app/*.log 2>/dev/null | tail -1`]).catch(() => "");
  return Number(out.trim()) || null;
}

/** A generated line's `seq` and `ts` (either may be missing from a line cut short on screen). */
export function lineOf(text) {
  const seq = /"seq":(\d+)/.exec(text)?.[1];
  const ts = /"ts":"([^"]+)"/.exec(text)?.[1];
  return { seq: seq ? Number(seq) : null, ts: ts ? Date.parse(ts) : null };
}

/** The newest generated line in `text` (what a client shows), by its `seq`, else by its `ts`. */
export function newestIn(text) {
  let seq = null;
  let ts = null;
  for (const m of text.matchAll(/"seq":(\d+)/g)) seq = Math.max(seq ?? 0, Number(m[1]));
  for (const m of text.matchAll(/"ts":"([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (t) ts = Math.max(ts ?? 0, t);
  }
  return { seq, ts };
}

export async function stopLogsCluster() {
  const state = (await docker(["ps", "--filter", `name=^${CONTAINER}$`, "--format", "{{.State}}"]).catch(() => "")).trim();
  if (state === "running") await docker(["stop", CONTAINER]);
}

export async function deleteLogsCluster() {
  await docker(["rm", "-f", CONTAINER]).catch(() => {});
}

