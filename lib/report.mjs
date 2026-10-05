// Turns results files into tables: per Mac, the median of each client's clean runs in each scenario, and their range.
//
//   node bench.mjs report [results.json…] [--main m2-pro-16gb] [--allow-env-drift] [--export DIR]
//       (default: every file in results/)
//
// Writes the tables into docs/benchmarks.md between <!-- results --> and <!-- /results -->, the charts into
// docs/assets/bench.svg and bench-ru.svg, and the README's table between <!-- benchmarks --> and <!-- /benchmarks -->.
// `--export DIR` copies the charts into the k10s checkout DIR (docs/assets), whose READMEs show them.
// Only runs that count make the numbers: a cell's own (not warm-ups), finished, on the screen they were meant to
// measure, and clean (nothing else busy on the Mac); each table's "Runs" row says how many there were of each kind.

import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { charts } from "./charts.mjs";
import { HARNESS } from "./estimators.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { bimodal, median, range, splitByLabel } from "./stats.mjs";
import { ROOT, exists } from "./util.mjs";

const ORDER = ["k10s", "aptakube", "headlamp", "freelens", "lens", "k9s"];

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

/** A run of a cell's own: neither a warm-up nor a record that a client couldn't run. */
const own = (r) => !r.warmup && r.counted !== false && !r.skipped && !r.unusable;
/** A run whose numbers count: its own, finished, on the right screen, and clean. */
export const good = (r) => own(r) && !r.error && !r.invalid && !r.noisy?.length;

/**
 * Whether a client showed only part of the list until asked for more (Headlamp's "Load more"): it then loads a
 * small share of what the others do. Told by its driver; else from the downloaded bytes.
 */
export function partial(cell, others) {
  const shown = cell.shown;
  if (shown && typeof shown === "object" && "partial" in shown) return shown.partial;
  if (!shown || typeof shown !== "object" || !shown.total) return false;
  // Against the most frugal of the others: some download uncompressed JSON, which says nothing about how much.
  const mine = median(cell.runs.map((r) => r.startup?.downMB));
  const theirs = Math.min(...others.map((c) => median(c.runs.map((r) => r.startup?.downMB)) ?? Infinity));
  return mine != null && Number.isFinite(theirs) && mine < theirs * 0.5;
}

/**
 * Every metric a table may show: where it is in a result, how to print it, and the least spread that counts as one
 * (repeated runs within 10 % of the median or this much agree; schedule.mjs and `compare` use the same). Less is
 * better for all of them.
 */
export const METRICS = {
  readyMs: { title: "Start to the full table", path: "readyMs", unit: "s", scale: 1 / 1000, digits: 1, floor: 200 },
  lagMs: { title: "…after the data was in, until the window showed it", path: "lagMs", unit: "s", scale: 1 / 1000, digits: 1, floor: 200 },
  settleMs: { title: "Start until it stops working on it", path: "settleMs", unit: "s", scale: 1 / 1000, digits: 1, floor: 500 },
  windowMs: { title: "Start to a window", path: "windowMs", unit: "s", scale: 1 / 1000, digits: 1, floor: 200 },
  downMB: { title: "Downloaded to open it", path: "startup.downMB", unit: "MB", digits: 1, floor: 0.5 },
  requests: { title: "API requests to open it", path: "startup.requests.total", unit: "", digits: 0, floor: 2 },
  memMB: { title: "Memory, idle", path: "idle.memMB", unit: "MB", digits: 0, floor: 15 },
  peakMB: { title: "Memory, highest while loading", path: "peakMB", unit: "MB", digits: 0, floor: 15 },
  cpuPct: { title: "CPU, idle", path: "idle.cpuPct", unit: "%", digits: 1, floor: 1 },
  requestsPerMin: { title: "API requests a minute, idle", path: "idle.requestsPerMin", unit: "", digits: 0, floor: 2 },
  churnCpuPct: { title: "CPU while 100 pods a second change", path: "churn.cpuPct", unit: "%", digits: 0, floor: 2 },
  churnMemMB: { title: "Memory while 100 pods a second change", path: "churn.memMB", unit: "MB", digits: 0, floor: 20 },
  logCpuPct: { title: "CPU while following the log", path: "logs.cpuPct", unit: "%", digits: 0, floor: 2 },
  logMemMB: { title: "Memory after a minute of the log", path: "logs.memEndMB", unit: "MB", digits: 0, floor: 20 },
  logSlopeMB: { title: "Memory growth while following it, a minute", path: "logs.slopeMBPerMin", unit: "MB", digits: 1, floor: 1 },
  logBehindSec: { title: "How far behind the pod it shows the log, usually", path: "logs.behind.medianSec", unit: "s", digits: 0, floor: 1 },
  logBehindMaxSec: { title: "…and at most", path: "logs.behind.maxSec", unit: "s", digits: 0, floor: 1 },
};

export function format(value, metric, { unit = true } = {}) {
  if (value == null) return "–";
  const v = value * (metric.scale ?? 1);
  const s = v.toLocaleString("en-US", { minimumFractionDigits: metric.digits, maximumFractionDigits: metric.digits });
  if (!unit) return s;
  return metric.unit === "%" ? `${s}%` : metric.unit ? `${s} ${metric.unit}` : s;
}

/** Labels every run records that can split a metric's values into groups: the app's state when it ran. */
const LABELS = [
  ["the requests it started with", (r) => r.state?.labels?.requestSig],
  ["how many times it listed everything", (r) => (r.state?.labels?.listPasses ? JSON.stringify(Object.values(r.state.labels.listPasses)) : undefined)],
  ["how busy it was when idle", (r) => r.state?.labels?.wakeBand],
];

/**
 * Whether a metric's good runs fall into groups, and why: split by a label the runs recorded, else in two by their
 * values (stats.mjs). Groups count when their medians differ by twice the spread that counts as one; null if none do.
 */
export function splitOf(runs, metric) {
  const of = (r) => get(r, metric.path);
  const values = runs.map(of).filter((v) => v != null);
  if (values.length < 4) return null;
  const tolerance = 2 * Math.max(0.1 * Math.abs(median(values)), metric.floor ?? 0);
  for (const [by, label] of LABELS) {
    const groups = splitByLabel(runs, label, of, tolerance);
    if (groups) return { by, groups };
  }
  const two = bimodal(values, { tolerance });
  return two ? { by: null, groups: [{ n: two.low.length, median: median(two.low) }, { n: two.high.length, median: median(two.high) }] } : null;
}

/** What a cell's runs say: how many of each kind, and per metric the median of the good ones, their range, any split. */
export function cellOf(results) {
  const cell = { runs: [], noisy: [], invalid: [], errors: [], skipped: null };
  for (const r of results) {
    if (r.skipped) cell.skipped = r.skipped;
    else if (r.unusable) cell.errors.push(r.error);
    else if (!own(r)) continue;
    else if (r.error) cell.errors.push(r.error);
    else if (r.invalid) cell.invalid.push(r);
    else if (r.noisy?.length) cell.noisy.push(r);
    else cell.runs.push(r);
  }
  const values = (metric) => cell.runs.map((r) => get(r, metric.path)).filter((v) => v != null);
  cell.value = (metric) => median(values(metric));
  cell.range = (metric) => range(values(metric));
  cell.split = (metric) => splitOf(cell.runs, metric);
  cell.shown = cell.runs.find((r) => r.shown)?.shown ?? null;
  return cell;
}

export function load(files) {
  if (!files.length) {
    const dir = join(ROOT, "results");
    files = exists(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)) : [];
  }
  return files.map((f) => ({ file: f, ...JSON.parse(readFileSync(f, "utf8")) }));
}

/** Why a results file can't be reported: from another harness, or a quick smoke run. Null if it can. */
export function unreportable(doc) {
  if (doc.harness?.version !== HARNESS) return `made by ${doc.harness ? `harness ${doc.harness.version}` : "an older benchmark"}, not harness ${HARNESS}: report it with the benchmark that made it`;
  if (doc.harness.quick) return "a quick smoke run: its windows are too short for its numbers to mean anything";
  return null;
}

/** How two files of one Mac differ in what their numbers depend on; null if they don't. */
export function envDrift(a, b) {
  const drift = [
    a.build !== b.build && `macOS ${a.build} and ${b.build}`,
    (a.dockerVM?.cpus !== b.dockerVM?.cpus || a.dockerVM?.memoryGB !== b.dockerVM?.memoryGB || a.dockerVM?.vmType !== b.dockerVM?.vmType) && "different VMs",
    JSON.stringify(a.display?.visible) !== JSON.stringify(b.display?.visible) && "different displays",
  ].filter(Boolean);
  return drift.length ? drift.join(", ") : null;
}

/** machine slug → { machine, clients, sessions, results, notes, cells: client → scenario → cellOf } */
export function aggregate(docs, { allowDrift = false } = {}) {
  const machines = new Map();
  for (const doc of docs) {
    const why = unreportable(doc);
    if (why) throw new Error(`${doc.file}: ${why}`);
    const m = machines.get(doc.machine.slug) ?? { machine: doc.machine, files: [], clients: {}, sessions: [], results: [], notes: [] };
    const drift = m.files.length ? envDrift(m.machine, doc.machine) : null;
    if (drift && !allowDrift) throw new Error(`${doc.file} and ${m.files[0]}, both of the ${doc.machine.chip}: ${drift} (--allow-env-drift reports them together)`);
    m.files.push(doc.file);
    Object.assign(m.clients, doc.clients);
    m.sessions.push(...(doc.sessions ?? []));
    m.results.push(...doc.results);
    m.notes.push(...(doc.notes ?? []));
    machines.set(doc.machine.slug, m);
  }
  for (const m of machines.values()) {
    const grouped = {};
    for (const r of m.results) ((grouped[r.client] ??= {})[r.scenario] ??= []).push(r);
    m.cells = {};
    for (const [client, byScenario] of Object.entries(grouped)) {
      m.cells[client] = Object.fromEntries(Object.entries(byScenario).map(([scenario, results]) => [scenario, cellOf(results)]));
    }
  }
  return machines;
}

function clientsOf(m) {
  return ORDER.filter((k) => m.clients[k]);
}

/** A log shown long after it was written: read again every few seconds instead of followed as it comes. */
export const late = (c) => (c.value(METRICS.logBehindMaxSec) ?? 0) >= 5;

/** A table cell: the median, the range of the runs under it, and ‡ if they fall into groups. */
function tableCell(cell, metric) {
  const value = cell.value(metric);
  if (value == null) return "–";
  const r = cell.range(metric);
  const lo = format(r.min, metric, { unit: false });
  const hi = format(r.max, metric, { unit: false });
  // A dash between two negative numbers reads as a minus: "−40.3 to −16.6".
  const spread = cell.runs.length > 1 && lo !== hi ? ` <sub>${r.min < 0 ? `${lo} to ${hi}` : `${lo}–${hi}`}</sub>` : "";
  return `${format(value, metric)}${spread}${cell.split(metric) ? " ‡" : ""}`;
}

/** The "Runs" row: the good runs, and those that didn't count. */
function runsCell(cell) {
  const parts = [String(cell.runs.length)];
  if (cell.noisy.length) parts.push(`${cell.noisy.length} noisy`);
  if (cell.invalid.length) parts.push(`${cell.invalid.length} wrong screen`);
  if (cell.errors.length) parts.push(`${cell.errors.length} failed`);
  return parts.join(" · ");
}

/** A table for one scenario on one machine: metrics as rows, clients as columns, then the runs behind them. */
function scenarioTable(m, key, metrics) {
  const clients = clientsOf(m);
  const head = `| | ${clients.map((c) => `**${m.clients[c].name}**`).join(" | ")} |`;
  const lines = [head, `| --- | ${clients.map(() => "---").join(" | ")} |`];
  for (const name of metrics) {
    const metric = METRICS[name];
    const cells = clients.map((c) => {
      const cell = m.cells[c]?.[key];
      if (!cell) return "not run";
      if (cell.skipped) return cell.skipped;
      // "failed" only in rows the scenario has (churn rows exist only where pods change).
      if (!cell.runs.length) return cell.errors.length && clients.some((o) => m.cells[o]?.[key]?.runs.length && m.cells[o][key].value(metric) != null) ? "failed" : "–";
      return tableCell(cell, metric);
    });
    if (cells.every((c, i) => c === "–" || c === "not run" || m.cells[clients[i]]?.[key]?.skipped)) continue;
    lines.push(`| ${metric.title} | ${cells.join(" | ")} |`);
  }
  lines.push(`| Runs | ${clients.map((c) => (m.cells[c]?.[key] && !m.cells[c][key].skipped ? runsCell(m.cells[c][key]) : "")).join(" | ")} |`);
  return lines.join("\n");
}

const SCENARIO_METRICS = {
  default: ["readyMs", "lagMs", "settleMs", "windowMs", "downMB", "requests", "memMB", "peakMB", "cpuPct", "requestsPerMin", "churnCpuPct", "churnMemMB"],
  logs: ["logCpuPct", "logMemMB", "logSlopeMB", "logBehindSec", "logBehindMaxSec"],
};

/** A title in the middle of a sentence: "Memory, idle" → "memory, idle"; "CPU, idle" stays. */
const lower = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The note under a table for a cell whose runs fall into groups. */
function splitNote(name, metric, split) {
  const groups = split.groups.map((g) => `${format(g.median, metric)} in ${g.n} run${g.n === 1 ? "" : "s"}${g.label != null ? ` (${g.label})` : ""}`);
  return `‡ ${name}, ${lower(metric.title.replace(/^…/, ""))}: ${groups.join(", ")}${split.by ? `, by ${split.by}` : ""}.`;
}

/** What each Mac's numbers depend on, said once above its tables: the VM, the display and windows, the apps' state. */
function environmentNotes(m) {
  const notes = [];
  const mc = m.machine;
  const vm = mc.dockerVM ?? {};
  notes.push(`The clusters ran in the benchmark's own VM: colima ${vm.colima ?? "?"} (${vm.vmType}, ${vm.mountType}), ${vm.cpus} CPUs and ${vm.memoryGB} GB; KWOK ${mc.kwok}.`);
  const target = m.results.find((r) => r.window?.target)?.window.target;
  if (mc.display?.frame) notes.push(`Display ${mc.display.frame.join(" × ")} points at ${mc.display.scale}×, and every app's window ${target ? target.join(" × ") : "the same size"}.`);
  for (const c of clientsOf(m)) {
    const warnings = new Map();
    let runs = 0;
    for (const r of m.results) {
      if (r.client !== c || !own(r)) continue;
      runs++;
      if (!r.windowWarning) continue;
      const kind = r.windowWarning.startsWith("window ") ? "a window of another size" : r.windowWarning;
      warnings.set(kind, (warnings.get(kind) ?? 0) + 1);
    }
    for (const [warning, n] of warnings) notes.push(`${m.clients[c].name}: ${warning} in ${n} of ${runs} runs.`);
  }
  const busy = m.sessions.flatMap((s) => Object.values(s.scenarios ?? {}).map((x) => x.background?.otherPct)).filter((v) => v != null);
  if (busy.length) {
    const lo = Math.round(Math.min(...busy));
    const hi = Math.round(Math.max(...busy));
    notes.push(`With nothing measured, the rest of the Mac (other apps, macOS) kept ${lo === hi ? lo : `${lo}–${hi}`} % of a core busy; each scenario's runs were judged against its own level.`);
  }
  if (m.clients.aptakube) notes.push(`Aptakube ran in a profile of the benchmark's own, ${m.clients.aptakube.licence === "licence" ? "with a licence" : "on its trial"}.`);
  for (const s of m.sessions) if (s.capped) notes.push(`Session ${s.id} ran short of time from ${s.capped.scenario} on: at most 7 runs per client there.`);
  return notes;
}

export function markdown(machines) {
  const out = [];
  for (const m of machines.values()) {
    const mc = m.machine;
    out.push(`### ${mc.chip}, ${mc.memoryGB} GB, macOS ${mc.macOS}`, "");
    out.push(`Clients: ${clientsOf(m).map((c) => `${m.clients[c].name} ${m.clients[c].version}`).join(", ")}.`, "");
    out.push(...environmentNotes(m).map((n) => `- ${n}`), "");
    if (m.notes.length) out.push("Where these runs differ from the method, what went wrong, and what was done about it:", "", ...m.notes.map((n) => `- ${n}`), "");
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      if (!clientsOf(m).some((c) => m.cells[c]?.[key])) continue;
      const metrics = SCENARIO_METRICS[scenario.view === "logs" ? "logs" : "default"];
      out.push(`#### ${scenario.title}`, "");
      out.push(scenarioTable(m, key, metrics), "");
      const notes = [];
      for (const c of clientsOf(m)) {
        const cell = m.cells[c]?.[key];
        if (!cell || cell.skipped) continue;
        const name = m.clients[c].name;
        // Errors from a client's own driver already start with its name ("Freelens: …").
        if (cell.errors.length && !cell.runs.length) notes.push(cell.errors[0].startsWith(`${name}: `) ? cell.errors[0] : `${name}: ${cell.errors[0]}`);
        else if (cell.errors.length) notes.push(`${name} failed ${cell.errors.length} of its ${cell.errors.length + cell.runs.length + cell.noisy.length + cell.invalid.length} runs, left out of its numbers: ${cell.errors[0].replace(new RegExp(`^${name}: `), "")}.`);
        if (cell.invalid.length) notes.push(`${name} showed another screen than the scenario's in ${cell.invalid.length} run${cell.invalid.length > 1 ? "s" : ""}, left out: ${cell.invalid[0].invalid}.`);
        const others = clientsOf(m).filter((o) => o !== c).map((o) => m.cells[o]?.[key]).filter((x) => x?.runs.length);
        if (cell.runs.length && partial(cell, others)) notes.push(`${name} loads the first 1,000 objects of each cluster and more when you ask: its numbers are for those.`);
        if (cell.runs.length && late(cell)) notes.push(`${name} doesn't follow the log as it comes: it reads it again every few seconds, and shows lines up to ${format(cell.value(METRICS.logBehindMaxSec), METRICS.logBehindMaxSec)} old. Its CPU is for that.`);
        for (const metric of metrics.map((k) => METRICS[k])) {
          const split = cell.runs.length ? cell.split(metric) : null;
          if (split) notes.push(splitNote(name, metric, split));
        }
      }
      // (Runs from before the benchmark read it have it for no client.)
      const read = clientsOf(m).filter((c) => m.cells[c]?.[key]?.runs.length);
      const lag = (c) => m.cells[c][key].value(METRICS.logBehindSec) != null;
      if (scenario.view === "logs" && read.some(lag) && !read.every(lag)) {
        notes.push("How far behind the log shows is read from the windows the benchmark can read (over DevTools); k10s's and Aptakube's can't be read, and k9s draws its terminal in partial redraws.");
      }
      if (notes.length) out.push(...notes.map((n) => `- ${n}`), "");
    }
  }
  return out.join("\n");
}

/** The README's table: the numbers that matter most, per client, from one machine. */
const README_ROWS = [
  { scenario: "pods-10k", metric: "readyMs", en: "Start to a table of 10,000 pods", ru: "От запуска до таблицы из 10 000 подов" },
  { scenario: "pods-10k", metric: "memMB", en: "Memory with them on screen", ru: "Память с ними на экране" },
  { scenario: "pods-10k", metric: "cpuPct", en: "CPU while nothing changes", ru: "CPU, пока ничего не меняется" },
  { scenario: "pods-10k", metric: "churnCpuPct", en: "CPU while 100 of them change a second", ru: "CPU, пока 100 из них меняются в секунду" },
  { scenario: "pods-10k", metric: "downMB", en: "Downloaded to show them", ru: "Скачано, чтобы их показать" },
  { scenario: "pods-10k", metric: "requests", en: "API requests to show them", ru: "Запросов к API, чтобы их показать" },
  { scenario: "pods-50k", metric: "memMB", en: "Memory, 50,000 pods", ru: "Память, 50 000 подов" },
  { scenario: "fleet-5x10k", metric: "memMB", en: "Memory, five clusters of 10,000 pods in one table", ru: "Память, пять кластеров по 10 000 подов в одной таблице" },
  { scenario: "namespaces-100k", metric: "readyMs", en: "Start to a list of 100,000 namespaces", ru: "От запуска до списка из 100 000 неймспейсов" },
  { scenario: "namespaces-100k", metric: "requests", en: "API requests for that list", ru: "Запросов к API ради этого списка" },
  { scenario: "logs-300", metric: "logCpuPct", en: "CPU while following a log of 300 lines a second", ru: "CPU, пока идёт лог на 300 строк в секунду" },
];

export const SKIPPED = { en: { "one cluster at a time": "one cluster at a time" }, ru: { "one cluster at a time": "по одному кластеру" } };
export const FAILED = { en: { finish: "didn't finish in 4 min", failed: "failed" }, ru: { finish: "не за 4 мин", failed: "не вышло" } };

/**
 * Whether a client ran out of time: the harness's own limit ("did not finish loading within 240 s"), or a wait of
 * its driver, which ends at the same limit ("the cluster view did not open", "… did not list …").
 */
export const timedOut = (error) => /finish loading|did not (open|show|list)/.test(error);

/** A value printed by `format`, in Russian: a space between thousands (one that doesn't break), a decimal comma, Russian units. */
export const localize = (text, lang) =>
  lang === "ru" ? text.replace(/,/g, " ").replace(/\./g, ",").replace(/ s$/, " с").replace(/ MB$/, " МБ") : text;

/** The words that stand in for a number of another task than the others' (see insteadOf). */
const INSTEAD = {
  en: { partial: (n) => `first ${n} only`, late: (s) => `rereads every ${s} s` },
  ru: { partial: (n) => `только первые ${n}`, late: (s) => `перечитывает раз в ${s}\u00a0с` },
};

/**
 * What the README and the charts show instead of a cell's number when it measures a lighter task than the others':
 * the first part of a big list only (Headlamp loads 1,000 objects until asked for more), or a log read again every
 * few seconds instead of followed (Freelens, in the log's numbers). Null when the number compares. The tables in
 * docs/benchmarks.md keep every number, with the reason under them.
 */
export function insteadOf(cell, others, metric, lang) {
  if (!cell?.runs.length) return null;
  // Its page: what it loaded when the table was read varies with how far each cluster's first page had come.
  if (partial(cell, others)) return INSTEAD[lang].partial(localize("1,000", lang));
  if (metric.startsWith("log") && late(cell)) return INSTEAD[lang].late(Math.round(cell.value(METRICS.logBehindMaxSec)));
  return null;
}

function readmeCell(m, client, row, lang) {
  const cell = m.cells[client]?.[row.scenario];
  if (!cell) return "–";
  if (cell.skipped) return SKIPPED[lang][cell.skipped] ?? cell.skipped;
  // No good run: failed, or only runs that didn't count (noisy, another screen), which say nothing either way.
  if (!cell.runs.length) return !cell.errors.length ? "–" : cell.errors.some(timedOut) ? FAILED[lang].finish : FAILED[lang].failed;
  const others = clientsOf(m).filter((o) => o !== client).map((o) => m.cells[o]?.[row.scenario]).filter((x) => x?.runs.length);
  return insteadOf(cell, others, row.metric, lang) ?? localize(format(cell.value(METRICS[row.metric]), METRICS[row.metric]), lang);
}

/** Under the README's table: where and on what it was measured. */
function readmeCaption(m, lang) {
  const last = Math.max(...m.results.filter((r) => r.startedAt && good(r)).map((r) => r.startedAt));
  const date = Number.isFinite(last) ? new Date(last).toISOString().slice(0, 10) : "";
  const versions = clientsOf(m).map((c) => `${m.clients[c].name} ${m.clients[c].version.replace(/ \(.*\)$/, "")}`);
  const list = (xs, and) => `${xs.slice(0, -1).join(", ")} ${and} ${xs.at(-1)}`;
  const chip = m.machine.chip.replace(/^Apple /, "");
  return lang === "ru"
    ? `Замерено ${date} на ${chip} с ${m.machine.memoryGB} ГБ памяти: ${list(versions, "и")}.`
    : `Measured on ${date} on an ${chip} with ${m.machine.memoryGB} GB of memory: ${list(versions, "and")}.`;
}

export function readmeTable(m, lang) {
  const clients = clientsOf(m);
  // ¹ k9s draws in a terminal, which isn't counted (the footnote under the table says so).
  const head = (c) => `**${m.clients[c].name}**${c === "k9s" ? "¹" : ""}`;
  const lines = [`| | ${clients.map(head).join(" | ")} |`, `| --- | ${clients.map(() => "---").join(" | ")} |`];
  for (const row of README_ROWS) lines.push(`| ${row[lang]} | ${clients.map((c) => readmeCell(m, c, row, lang)).join(" | ")} |`);
  return `${lines.join("\n")}\n\n${readmeCaption(m, lang)}`;
}

/**
 * `text` with what lies between the lines `<!-- name -->` and `<!-- /name -->` replaced by `content`. The markers count
 * only on lines of their own, the nearest closing one ending it: prose that names them (this README does) stays.
 */
export function between(text, name, content) {
  return text.replace(new RegExp(`^<!-- ${name} -->$[\\s\\S]*?^<!-- /${name} -->$`, "m"), () => `<!-- ${name} -->\n${content}\n<!-- /${name} -->`);
}

/** Whether `text` has the line `<!-- name -->`, for `between`. */
const hasMarker = (text, name) => new RegExp(`^<!-- ${name} -->$`, "m").test(text);

/** The machine the README shows, and the chart first: `--main <slug>` (e.g. m2-pro-16gb), else the one with the most runs. */
function mainMachine(machines, slug) {
  if (slug && machines.has(slug)) return machines.get(slug);
  return [...machines.values()].sort((a, b) => b.results.length - a.results.length)[0];
}

export async function report(args) {
  const valueOf = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null);
  const slug = valueOf("main");
  const exportTo = valueOf("export");
  const files = args.filter((a, j) => !a.startsWith("--") && !["--main", "--export"].includes(args[j - 1]));
  const docs = load(files);
  if (!docs.length) {
    console.log("No results yet: node bench.mjs run");
    return;
  }
  const machines = aggregate(docs, { allowDrift: args.includes("--allow-env-drift") });
  const md = markdown(machines);
  const target = join(ROOT, "docs/benchmarks.md");
  if (exists(target)) {
    const text = readFileSync(target, "utf8");
    const next = between(text, "results", `\n${md}`);
    writeFileSync(target, next);
    console.log(`updated ${target}`);
  } else console.log(md);
  const main = mainMachine(machines, slug);
  // The chart shows every Mac, the README's own first.
  const written = charts([main, ...[...machines.values()].filter((m) => m !== main)]);
  for (const file of written) console.log(`wrote ${file}`);
  if (exportTo) {
    if (!exists(join(exportTo, "docs/assets"))) throw new Error(`${exportTo} is not a k10s checkout: there is no docs/assets in it`);
    for (const file of written) {
      const to = join(exportTo, "docs/assets", file.split("/").pop());
      copyFileSync(file, to);
      console.log(`copied it to ${to}`);
    }
  }
  for (const [file, lang] of [["README.md", "en"], ["README.ru.md", "ru"]]) {
    const path = join(ROOT, file);
    if (!exists(path)) continue;
    const text = readFileSync(path, "utf8");
    if (!hasMarker(text, "benchmarks")) continue;
    writeFileSync(path, between(text, "benchmarks", readmeTable(main, lang)));
    console.log(`updated the table in ${file}`);
  }
}
