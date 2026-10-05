// Two read-only looks at results files:
//
//   node bench.mjs check FILE            what a file holds, cell by cell, and what went wrong in it
//   node bench.mjs compare A.json B.json two runs of one Mac side by side: how far apart repeated runs land
//
// `check` fails (exit 1) on what makes numbers wrong or missing: failed runs and warm-ups, runs on the wrong screen,
// cells without a good run, a saved state that differed between runs. `compare` passes when repeated runs agree as
// docs/benchmarks.md promises: 90 % of the cells within 10 % of each other (or the metric's floor), none beyond twice
// that, and every miss in a cell whose runs fall into groups (‡), where a median depends on which group got more runs.

import { readFileSync } from "node:fs";
import { HARNESS } from "./estimators.mjs";
import { METRICS, cellOf, format } from "./report.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { cellStatus } from "./schedule.mjs";

const ORDER = ["k10s", "aptakube", "headlamp", "freelens", "lens", "k9s"];

function read(file) {
  if (!file) throw new Error("which results file?");
  return { file, ...JSON.parse(readFileSync(file, "utf8")) };
}

const clientsOf = (doc) => ORDER.filter((k) => doc.clients?.[k]);
const nameOf = (doc, k) => doc.clients[k]?.name ?? k;
const pad = (s, n) => String(s).padEnd(n);
const duration = (ms) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min` : `${Math.round(ms / 60_000)} min`);

/** The run limits a session ran with: `--runs N`, or a quick run's 2, or 5 to 9. */
function limitsOf(doc) {
  const session = doc.sessions?.at(-1);
  const args = session?.args ?? [];
  const i = args.indexOf("--runs");
  const fixed = i >= 0 ? Number(args[i + 1]) : null;
  const quick = !!doc.harness?.quick;
  return { min: fixed ?? (quick ? 2 : 5), max: fixed ?? (quick ? 2 : 9), floors: session?.floors ?? {}, rel: 0.1 };
}

export function check(file) {
  const doc = read(file);
  const problems = [];
  const warnings = [];
  const h = doc.harness;
  console.log(file);
  if (h?.version !== HARNESS) problems.push(`made by ${h ? `harness ${h.version}` : "an older benchmark"}, not harness ${HARNESS}`);
  console.log(`harness ${h?.version ?? "?"} (${h?.commit ?? "?"})${h?.quick ? ", a quick smoke run" : ""}`);
  const mc = doc.machine ?? {};
  const vm = mc.dockerVM ?? {};
  const display = mc.display?.frame ? `; display ${mc.display.frame.join("×")} at ${mc.display.scale}×` : "";
  console.log(`${mc.chip}, ${mc.memoryGB} GB, macOS ${mc.macOS} (${mc.build}); VM colima ${vm.colima} ${vm.vmType}/${vm.mountType}, ${vm.cpus} CPUs, ${vm.memoryGB} GB${display}`);
  console.log(`clients: ${clientsOf(doc).map((k) => `${nameOf(doc, k)} ${doc.clients[k].version}${doc.clients[k].licence ? ` (${doc.clients[k].licence})` : ""}`).join(", ")}`);
  for (const s of doc.sessions ?? []) {
    const runs = doc.results.filter((r) => r.session === s.id).length;
    const span = s.endedAt ? `, ${duration(s.endedAt - s.startedAt)}` : ", didn't finish";
    console.log(`session ${s.id}: seed ${s.seed}, ${runs} records${span}${s.capped ? `, short of time from ${s.capped.scenario} on` : ""}`);
  }

  const limits = limitsOf(doc);
  const reasons = new Map();
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    const clients = clientsOf(doc).filter((k) => doc.results.some((r) => r.client === k && r.scenario === key));
    if (!clients.length) continue;
    const rows = { "good runs": [], noisy: [], "wrong screen": [], failed: [], "warm-up": [], status: [], windows: [] };
    for (const k of clients) {
      const results = doc.results.filter((r) => r.client === k && r.scenario === key);
      const cell = cellOf(results);
      const where = `${key}/${nameOf(doc, k)}`;
      if (cell.skipped) {
        for (const row of Object.values(rows)) row.push(row === rows["good runs"] ? cell.skipped : "");
        continue;
      }
      const own = results.filter((r) => !r.warmup && r.counted !== false && !r.skipped && !r.unusable);
      const warmups = results.filter((r) => r.warmup);
      rows["good runs"].push(cell.runs.length);
      rows.noisy.push(cell.noisy.length || "–");
      rows["wrong screen"].push(cell.invalid.length || "–");
      rows.failed.push(cell.errors.length || "–");
      rows["warm-up"].push(!warmups.length ? "none" : warmups.some((r) => r.error) ? "failed" : "ok");
      const status = cellStatus(own, { ...limits, drive: scenario.drive });
      rows.status.push(status.failed ? "failed" : status.needsMore ? "unfinished" : status.reason.replace(/ runs.*$/, ""));
      const windowWarnings = own.filter((r) => r.windowWarning);
      rows.windows.push(windowWarnings.length ? `${windowWarnings.length}×` : "–");
      for (const r of cell.noisy) for (const reason of r.noisy) reasons.set(reason.replace(/[\d.]+%?/g, "#"), (reasons.get(reason.replace(/[\d.]+%?/g, "#")) ?? 0) + 1);

      if (!warmups.length) problems.push(`${where}: no warm-up start`);
      for (const r of warmups.filter((x) => x.error)) problems.push(`${where}: the warm-up failed: ${r.error}`);
      // A client that fails now and then (k9s with 50,000 pods) is a finding, as long as enough runs stand.
      if (cell.errors.length) (cell.runs.length >= limits.min ? warnings : problems).push(`${where}: ${cell.errors.length} failed: ${cell.errors[0]}`);
      if (cell.invalid.length) problems.push(`${where}: ${cell.invalid.length} on the wrong screen: ${cell.invalid[0].invalid}`);
      if (!cell.runs.length) problems.push(`${where}: no good run`);
      else if (status.needsMore && !h?.quick) warnings.push(`${where}: ${status.reason}`);
      // Every counted run of a session starts from the same saved state.
      const bySession = new Map();
      for (const r of own) if (r.state?.before) bySession.set(r.session, new Set([...(bySession.get(r.session) ?? []), r.state.before]));
      for (const [session, hashes] of bySession) if (hashes.size > 1) problems.push(`${where}: the saved state differed between the runs of session ${session} (${hashes.size} states)`);
      for (const w of new Set(windowWarnings.map((r) => r.windowWarning))) warnings.push(`${where}: ${w} (${windowWarnings.filter((r) => r.windowWarning === w).length} runs)`);
      const rowsShown = new Set(cell.runs.map((r) => r.shown?.rows).filter((v) => v != null));
      if (rowsShown.size > 1) warnings.push(`${where}: its table showed ${[...rowsShown].join(", ")} rows in different runs`);
      if (cell.noisy.length > own.length / 3) warnings.push(`${where}: ${cell.noisy.length} of ${own.length} runs noisy`);
    }
    console.log(`\n${pad(key, 22)}${clients.map((k) => pad(nameOf(doc, k), 14)).join("")}`);
    for (const [row, values] of Object.entries(rows)) console.log(`  ${pad(row, 20)}${values.map((v) => pad(v, 14)).join("")}`);
  }
  if (reasons.size) {
    console.log("\nwhy runs were noisy:");
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${reason}`);
  }
  if (warnings.length) console.log(`\nwarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
  console.log(problems.length ? `\n${problems.length} problem${problems.length > 1 ? "s" : ""}:\n${problems.map((p) => `  - ${p}`).join("\n")}` : "\nno problems");
  return problems.length === 0;
}

export function compare(fileA, fileB) {
  const a = read(fileA);
  const b = read(fileB);
  if (a.harness?.version !== b.harness?.version) throw new Error(`harness ${a.harness?.version} and ${b.harness?.version}: their numbers mean different things`);
  if (a.machine?.slug !== b.machine?.slug) console.log(`Note: ${a.machine?.slug} and ${b.machine?.slug} are different Macs: this compares the Macs, not how well runs repeat.\n`);
  const rows = [];
  for (const [key, scenario] of Object.entries(SCENARIOS)) {
    for (const k of ORDER) {
      const ra = a.results.filter((r) => r.client === k && r.scenario === key);
      const rb = b.results.filter((r) => r.client === k && r.scenario === key);
      if (!ra.length || !rb.length) continue;
      const ca = cellOf(ra);
      const cb = cellOf(rb);
      if (ca.skipped || cb.skipped) continue;
      for (const name of scenario.drive) {
        const metric = METRICS[name];
        const va = ca.value(metric);
        const vb = cb.value(metric);
        if (va == null || vb == null) {
          rows.push({ key, client: nameOf(a, k), name, va, vb, metric, verdict: "missing" });
          continue;
        }
        const allowed = Math.max(0.1 * Math.abs((va + vb) / 2), metric.floor ?? 0);
        const diff = Math.abs(vb - va);
        const split = !!(ca.split(metric) || cb.split(metric));
        const verdict = diff <= allowed ? "ok" : diff <= 2 * allowed ? "miss" : "far";
        rows.push({ key, client: nameOf(a, k), name, va, vb, metric, verdict, split, change: va ? (vb - va) / va : null });
      }
    }
  }
  console.log(`${pad("scenario", 17)}${pad("client", 10)}${pad("metric", 13)}${pad("A", 12)}${pad("B", 12)}${pad("Δ", 8)}`);
  for (const r of rows) {
    const change = r.change == null ? "" : `${r.change > 0 ? "+" : ""}${Math.round(r.change * 100)}%`;
    const mark = r.verdict === "ok" ? "" : `${r.verdict}${r.split ? " ‡" : ""}`;
    console.log(`${pad(r.key, 17)}${pad(r.client, 10)}${pad(r.name, 13)}${pad(format(r.va, r.metric), 12)}${pad(format(r.vb, r.metric), 12)}${pad(change, 8)}${mark}`);
  }
  const judged = rows.filter((r) => r.verdict !== "missing");
  const ok = judged.filter((r) => r.verdict === "ok").length;
  const far = judged.filter((r) => r.verdict === "far");
  const unexplained = judged.filter((r) => r.verdict !== "ok" && !r.split);
  const share = judged.length ? ok / judged.length : 0;
  const pass = judged.length > 0 && share >= 0.9 && !far.length && !unexplained.length;
  console.log(`\n${ok} of ${judged.length} cells agree within 10 % or the metric's floor (${Math.round(share * 100)} %); ${far.length} beyond twice that; ${unexplained.length} misses not in a ‡ cell; ${rows.length - judged.length} missing in one file.`);
  console.log(pass ? "PASS: the runs repeat as promised." : "FAIL: see the cells marked above.");
  return pass;
}
