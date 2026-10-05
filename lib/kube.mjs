// A minimal Kubernetes REST client for the benchmark's own requests: filling clusters fast and changing pods.
// It talks to the API server directly (not through the clients' proxies), so its traffic is never counted.

import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";

export class Kube {
  /** `creds`: { host, port, ca, crt, key } with file paths. */
  constructor(creds, { sockets = 16, userAgent = "k10s-bench" } = {}) {
    this.host = creds.host;
    this.port = creds.port;
    this.userAgent = userAgent;
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: sockets,
      ca: readFileSync(creds.ca),
      cert: readFileSync(creds.crt),
      key: readFileSync(creds.key),
    });
  }

  request(method, path, body, contentType = "application/json") {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
      const req = request(
        {
          host: this.host,
          port: this.port,
          method,
          path,
          agent: this.agent,
          headers: { accept: "application/json", "user-agent": this.userAgent, ...(data ? { "content-type": contentType, "content-length": Buffer.byteLength(data) } : {}) },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            if (res.statusCode >= 400) {
              const err = new Error(`${method} ${path}: ${res.statusCode} ${text.slice(0, 300)}`);
              err.status = res.statusCode;
              reject(err);
            } else resolve(/json/.test(res.headers["content-type"] ?? "") ? JSON.parse(text) : text);
          });
        },
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  get(path) {
    return this.request("GET", path);
  }

  /** Creates objects with `concurrency` requests in flight; an object that already exists counts as created. */
  async createAll(items, pathFor, { concurrency = 32 } = {}) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++];
        await this.request("POST", pathFor(item), item).catch((e) => {
          if (e.status !== 409) throw e;
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /** Every object of a list endpoint, page by page. */
  async listAll(path, limit = 5000) {
    const items = [];
    let cont = "";
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.get(`${path}${sep}limit=${limit}${cont ? `&continue=${encodeURIComponent(cont)}` : ""}`);
      items.push(...page.items);
      cont = page.metadata?.continue ?? "";
    } while (cont);
    return items;
  }

  close() {
    this.agent.destroy();
  }
}
