// TCP proxies in front of the API servers. TLS passes through untouched; the proxies only count the bytes
// each way, which is what a client costs on a slow or metered link (a VPN to a remote data center), and when they
// came: in 10 ms steps, the clock "the data is in" and "the log flows" are read from (estimators.mjs).

import { connect, createServer } from "node:net";

const BUCKET_MS = 10;

/** Bytes downloaded per 10 ms, as [t, bytes] pairs in time order, shared by every proxy of the benchmark. */
class Arrivals {
  constructor() {
    this.events = [];
  }

  add(bytes) {
    const t = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const last = this.events.at(-1);
    if (last && last[0] === t) last[1] += bytes;
    else this.events.push([t, bytes]);
  }

  /** The events from `t` on. */
  since(t) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    return this.events.slice(lo);
  }

  /** Forgets everything before `t` (a run keeps only its own). */
  dropBefore(t) {
    const keep = this.since(t);
    this.events = keep;
  }
}

export class CountingProxy {
  constructor(port, target, arrivals) {
    this.port = port;
    this.target = target;
    this.arrivals = arrivals;
    this.down = 0;
    this.up = 0;
    this.connections = 0;
    this.sockets = new Set();
  }

  start() {
    this.server = createServer((client) => {
      this.connections++;
      const upstream = connect(this.target.port, this.target.host);
      this.sockets.add(client).add(upstream);
      client.on("data", (d) => (this.up += d.length));
      upstream.on("data", (d) => {
        this.down += d.length;
        this.arrivals?.add(d.length);
      });
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on("error", close).on("close", close);
      upstream.on("error", close).on("close", close);
    });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
  }

  /** Cuts every open connection: a client quitting must not leave watches behind for the next one. */
  dropConnections() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  stop() {
    this.dropConnections();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** Proxies by port; started once and shared by all scenarios. */
export class Proxies {
  constructor() {
    this.byPort = new Map();
    this.arrivals = new Arrivals();
  }

  async ensure(port, target) {
    const existing = this.byPort.get(port);
    if (existing && existing.target.port === target.port) return existing;
    if (existing) await existing.stop();
    const proxy = new CountingProxy(port, target, this.arrivals);
    await proxy.start();
    this.byPort.set(port, proxy);
    return proxy;
  }

  /** Downloads since `t`, as [t, bytes] per 10 ms, over all proxies. */
  arrivalsSince(t) {
    return this.arrivals.since(t);
  }

  /** Starts a run's record of arrivals: what came before it is dropped. */
  startRecording(t) {
    this.arrivals.dropBefore(t);
  }

  /** Bytes through each proxy so far, by port. */
  perPort() {
    return new Map([...this.byPort].map(([port, p]) => [port, { down: p.down, up: p.up }]));
  }

  /** Bytes through all proxies so far. */
  totals() {
    let down = 0;
    let up = 0;
    for (const p of this.byPort.values()) {
      down += p.down;
      up += p.up;
    }
    return { down, up };
  }

  dropConnections() {
    for (const p of this.byPort.values()) p.dropConnections();
  }

  async stopAll() {
    await Promise.all([...this.byPort.values()].map((p) => p.stop()));
    this.byPort.clear();
  }
}
