// A small Chrome DevTools Protocol client, to drive Electron apps (Lens, Freelens, Headlamp) the way a person
// would: click what is on screen, read what the window shows. Node's built-in WebSocket is enough.

import { sleep, waitFor } from "./util.mjs";

export async function targets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    return await res.json();
  } catch {
    return [];
  }
}

export class Page {
  static async attach(port, match, { timeout = 60_000 } = {}) {
    const target = await waitFor(async () => (await targets(port)).find(match), { timeout, every: 200 });
    if (!target) throw new Error(`no matching DevTools target on port ${port}`);
    const page = new Page(target);
    await page.open();
    return page;
  }

  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`DevTools connection failed: ${e.message ?? e}`));
      this.ws.onclose = () => {
        for (const { reject: fail } of this.pending.values()) fail(new Error("DevTools connection closed"));
        this.pending.clear();
      };
      this.ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        const call = data.id && this.pending.get(data.id);
        if (!call) return;
        this.pending.delete(data.id);
        if (data.error) call.reject(new Error(`${call.method}: ${data.error.message}`));
        else call.resolve(data.result);
      };
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression in the page and returns its value (promises are awaited). */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Waits until `expression` is truthy in the page; resolves to its value or null after `timeout`. */
  waitFor(expression, { timeout = 60_000, every = 100 } = {}) {
    return waitFor(() => this.eval(expression).catch(() => null), { timeout, every });
  }

  /** Clicks the element `selector` matches whose text contains `text` (or the first match), like a mouse would. */
  async click(selector, text) {
    const ok = await this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text == null ? "els[0]" : `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))`};
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, opts));
      return true;
    })()`);
    if (!ok) throw new Error(`nothing to click: ${selector}${text ? ` "${text}"` : ""}`);
    await sleep(50);
  }

  /**
   * Gives the window the benchmark's size and place ({width, height, x, y} in points: k10s's 1440×900 as far
   * as the screen allows), so that every app draws about as many rows. Electron has none of the browser's window
   * methods in DevTools, but it does what a page asks with resizeTo/moveTo. Resolves to the size it got.
   */
  async resizeWindow({ width, height, x, y }) {
    const size = () => this.eval(`JSON.stringify([window.outerWidth, window.outerHeight])`).then((s) => JSON.parse(s));
    for (let i = 0; i < 2; i++) {
      await this.eval(`window.resizeTo(${width}, ${height}); window.moveTo(${x}, ${y}); true`);
      await sleep(300);
      const [w, h] = await size();
      if (Math.abs(w - width) <= 2 && Math.abs(h - height) <= 2) return [w, h];
    }
    return size();
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
