// The benchmark chart, for this repository's README and docs/benchmarks.md and for k10s's READMEs (report --export
// copies it there): every client on every Mac with results, small
// multiples of horizontal bars, one panel per metric, the clients always in the same order. Each Mac is a color,
// the first one being the Mac the README's table comes from. Every bar is a median, with a whisker from the lowest
// to the highest of its runs, and carries its value; the bars of the other Macs also their difference to the first
// (Δ), so nothing depends on color, and docs/benchmarks.md has every number as a table.
//
// One file per language (English for README.md and docs/benchmarks.md, Russian for README.ru.md), drawn on a
// white card: it reads the same on any page, dark ones included. (A dark edition can't be picked reliably: a
// <picture> follows the system's theme, not the page's, and every dark theme has a background of its own.) The
// Macs' colors are the first three slots of the data-viz reference palette, checked with its validator against
// white: every pair passes the color-blindness and normal-vision floors, and each is 3:1 against it but the third
// (2.8:1), which the value on every bar makes up for.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAILED, METRICS, SKIPPED, format, insteadOf, localize, timedOut } from "./report.mjs";
import { ROOT } from "./util.mjs";

/** Colors: the card, its edge (GitHub's light border), the Macs' bars, text. */
const C = {
  card: "#ffffff",
  edge: "#d1d9e0",
  series: ["#2a78d6", "#eb6834", "#1baf7a"],
  primary: "#1f2328",
  secondary: "#59636e",
  muted: "#818b98",
  grid: "#e1e0d9",
};
/** Space between the card's edge and what it holds. */
const PAD = 24;
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`;
const ORDER = ["k10s", "aptakube", "headlamp", "freelens", "lens", "k9s"];

/** The panels, in order: the four numbers of one cluster with 10,000 pods, then bigger fleets. */
const PANELS = [
  { scenario: "pods-10k", metric: "readyMs", en: ["Start to the full table", "10,000 pods · seconds"], ru: ["До полной таблицы", "10 000 подов · секунды"] },
  { scenario: "pods-10k", metric: "memMB", en: ["Memory with the table open", "10,000 pods · MB"], ru: ["Память с открытой таблицей", "10 000 подов · МБ"] },
  { scenario: "pods-10k", metric: "churnCpuPct", en: ["CPU while 100 pods a second change", "10,000 pods · % of one core"], ru: ["CPU, пока 100 подов в секунду меняются", "10 000 подов · % одного ядра"] },
  { scenario: "pods-10k", metric: "downMB", en: ["Downloaded to open the table", "10,000 pods · MB"], ru: ["Скачано, чтобы открыть таблицу", "10 000 подов · МБ"] },
  { scenario: "fleet-5x10k", metric: "memMB", en: ["Five clusters in one table", "5 × 10,000 pods · memory, MB"], ru: ["Пять кластеров в одной таблице", "5 × 10 000 подов · память, МБ"] },
  { scenario: "pods-50k", metric: "memMB", en: ["One cluster with 50,000 pods", "memory, MB"], ru: ["Один кластер, 50 000 подов", "память, МБ"] },
  { scenario: "namespaces-100k", metric: "readyMs", en: ["100,000 namespaces: start to the full list", "seconds"], ru: ["100 000 неймспейсов: до полного списка", "секунды"] },
  { scenario: "logs-300", metric: "logCpuPct", en: ["Following a log of 300 lines a second", "CPU, % of one core"], ru: ["Лог на 300 строк в секунду", "CPU, % одного ядра"] },
];

const TEXT = {
  en: {
    title: "k10s and other Kubernetes clients, on each Mac",
    mac: (mc) => `${mc.chip}, ${mc.memoryGB} GB, macOS ${mc.macOS}`,
    key: (first) => (first ? `lower is better everywhere; Δ: against the ${first.chip}` : "lower is better everywhere"),
    about: "Medians of 5 to 9 runs, whiskers from the lowest to the highest, on local KWOK clusters in the benchmark's own VM (4 CPUs, 8 GB). Method, notes and every number: the k10s-bench repository",
    split: "‡ Its runs fell into two groups (the k10s-bench repository says which): the bar is the median of all of them.",
    builds: (list) => `k10s is a different build on each Mac (${list}): its Δ is as much the build's as the Mac's.`,
    compare: "The Macs differ in more than the chip (display, macOS build; each one's notes in the k10s-bench repository say how): compare the clients within one Mac, not the Macs.",
    missing: "not measured",
  },
  ru: {
    title: "k10s и другие клиенты Kubernetes на каждом Mac",
    mac: (mc) => `${mc.chip}, ${mc.memoryGB} ГБ, macOS ${mc.macOS}`,
    key: (first) => (first ? `везде меньше — лучше; Δ — к ${first.chip}` : "везде меньше — лучше"),
    about: "Медианы 5–9 прогонов, усы — от наименьшего до наибольшего, на локальных кластерах KWOK в собственной VM бенчмарка (4 CPU, 8 ГБ). Методика, заметки и все числа — в репозитории k10s-bench",
    split: "‡ Его прогоны разделились на две группы (какие — в репозитории k10s-bench): бар — медиана всех.",
    builds: (list) => `k10s на каждом Mac — своя сборка (${list}): его Δ — разница сборок не меньше, чем Mac.`,
    compare: "Mac различаются не только чипом (экран, сборка macOS; чем именно — в заметках каждого в репозитории k10s-bench): сравнивайте клиентов в пределах одного Mac, а не Mac между собой.",
    missing: "не замерено",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Text widths, for laying out the legend and wrapping notes without a browser: generous, Cyrillic is wider. */
const textWidth = (s, size) => s.length * size * 0.6;

/** A bar with a 4px rounded end, square at the baseline. */
function bar(x, y, w, h, fill) {
  if (w <= 0) return "";
  const r = Math.min(4, w, h / 2);
  return `<path d="M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z" fill="${fill}"/>`;
}

/** The runs' range over a bar: a thin line from the lowest to the highest, with short ends, in the text's ink. */
function whisker(x0, y, h, b, max, plotW) {
  if (b.lo == null || !(b.hi > b.lo)) return "";
  const a = x0 + (b.lo / max) * plotW;
  const z = x0 + (b.hi / max) * plotW;
  const mid = y + h / 2;
  return `<path d="M${a},${mid}H${z}M${a},${y + 2}V${y + h - 2}M${z},${y + 2}V${y + h - 2}" stroke="${C.primary}" stroke-opacity="0.6" stroke-width="1" fill="none"/>`;
}

/** The difference of `b` to `a`, rounded to a percent: "−34%", "+6%", "±0%". */
function delta(a, b) {
  const p = Math.round(((b - a) / a) * 100);
  return `${p > 0 ? "+" : p < 0 ? "−" : "±"}${Math.abs(p)}%`;
}

const printed = (value, metric, lang) => localize(format(value, metric), lang);

function panel(macs, spec, lang, x0, y0, width) {
  const t = C;
  const words = TEXT[lang];
  const metric = METRICS[spec.metric];
  const clients = ORDER.filter((c) => macs.some((m) => m.clients[c]));
  const rows = clients.map((c) => {
    const bars = macs.map((m) => {
      const cell = m.cells[c]?.[spec.scenario];
      // A number of a lighter task than the others' (the first 1,000 of a list, a log read again every 10 s) gets
      // words instead of a bar: a bar would put it next to the others as if it compared.
      const others = clients.filter((o) => o !== c).map((o) => m.cells[o]?.[spec.scenario]).filter((x) => x?.runs.length);
      const instead = insteadOf(cell, others, spec.metric, lang);
      const value = cell?.runs.length && !instead ? cell.value(metric) : null;
      const why = instead ?? (!cell || (!cell.skipped && !cell.errors.length) ? words.missing : cell.skipped ? (SKIPPED[lang][cell.skipped] ?? cell.skipped) : cell.errors.some(timedOut) ? FAILED[lang].finish : FAILED[lang].failed);
      const scale = metric.scale ?? 1;
      const spread = value == null ? null : cell.range(metric);
      return { value: value == null ? null : value * scale, lo: spread && spread.min * scale, hi: spread && spread.max * scale, split: value != null && !!cell.split(metric), why: value == null ? why : null, skipped: !!cell?.skipped };
    });
    return { key: c, name: macs.find((m) => m.clients[c]).clients[c].name, bars };
  });
  const max = Math.max(...rows.flatMap((r) => r.bars.map((b) => b.hi ?? b.value ?? 0)), 0) || 1;
  const labelW = 86;
  const valueW = 112;
  const plotW = width - labelW - valueW;
  const barH = 10;
  const pitch = barH + 2;
  const rowH = macs.length * pitch + 10;
  const out = [];
  out.push(`<text x="${x0}" y="${y0 + 14}" font-size="14" font-weight="600" fill="${t.primary}">${esc(spec[lang][0])}</text>`);
  out.push(`<text x="${x0}" y="${y0 + 32}" font-size="12" fill="${t.secondary}">${esc(spec[lang][1])}</text>`);
  const top = y0 + 46;
  out.push(`<line x1="${x0 + labelW}" y1="${top - 4}" x2="${x0 + labelW}" y2="${top + rows.length * rowH - 6}" stroke="${t.grid}" stroke-width="1"/>`);
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const middle = y + (macs.length * pitch - 2) / 2 + 4;
    const k10s = r.key === "k10s";
    out.push(`<text x="${x0 + labelW - 8}" y="${middle}" font-size="12" text-anchor="end" fill="${k10s ? t.primary : t.secondary}"${k10s ? ' font-weight="600"' : ""}>${esc(r.name)}</text>`);
    // The same words for every Mac (Freelens and k9s show one cluster at a time; Headlamp loads the first 1,000): one line.
    if (r.bars.every((b) => b.value == null && b.why === r.bars[0].why)) {
      out.push(`<text x="${x0 + labelW + 6}" y="${middle}" font-size="12" fill="${t.muted}">${esc(r.bars[0].why)}</text>`);
      return;
    }
    const base = r.bars[0].value;
    r.bars.forEach((b, k) => {
      const yy = y + k * pitch;
      if (b.value == null) {
        out.push(`<text x="${x0 + labelW + 6}" y="${yy + 9}" font-size="11" fill="${t.muted}">${esc(b.why)}</text>`);
        return;
      }
      const w = Math.max(2, (b.value / max) * plotW);
      const label = `${printed(b.value / (metric.scale ?? 1), metric, lang)}${b.split ? " ‡" : ""}`;
      const range = b.hi > b.lo ? `${printed(b.lo / (metric.scale ?? 1), metric, lang)}–${printed(b.hi / (metric.scale ?? 1), metric, lang)}` : null;
      const diff = k > 0 && base != null ? delta(base, b.value) : null;
      const tip = `${r.name}, ${macs[k].machine.chip}: ${label}${range ? ` (${range})` : ""}${diff ? `, Δ ${diff}` : ""}`;
      out.push(`<g><title>${esc(tip)}</title>${bar(x0 + labelW, yy, w, barH, t.series[k % t.series.length])}${whisker(x0 + labelW, yy, barH, b, max, plotW)}</g>`);
      const end = Math.max(w, b.hi == null ? 0 : (b.hi / max) * plotW);
      out.push(`<text x="${x0 + labelW + end + 5}" y="${yy + 9}" font-size="11" fill="${t.secondary}">${esc(label)}${diff ? `<tspan dx="6" fill="${t.muted}">${diff}</tspan>` : ""}</text>`);
    });
  });
  return { svg: out.join(""), height: 46 + rows.length * rowH, split: rows.some((r) => r.bars.some((b) => b.split)) };
}

/** The k10s build each Mac measured (the commit in its version), when they differ: "Apple M2 Pro: 31abba7, …". */
function builds(macs) {
  const of = (m) => m.clients.k10s?.version.match(/\(([^)]+)\)/)?.[1] ?? null;
  const all = macs.map(of);
  if (all.some((b) => !b) || new Set(all).size < 2) return null;
  return macs.map((m, k) => `${m.machine.chip}: ${all[k]}`).join("; ");
}

/** Words into lines no wider than `width` at `size` px. */
function wrap(text, width, size) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** The chart of every Mac in one language, as SVG text (`charts` writes it; a dry run can render it anywhere). */
export function chart(macs, lang) {
  const t = C;
  const words = TEXT[lang];
  const width = 880;
  const gap = 40;
  const colW = (width - gap) / 2;
  const parts = [];
  // The legend: one swatch per Mac, then how to read the bars, flowing onto as many lines as it needs.
  const items = macs.map((m, k) => ({ text: words.mac(m.machine), color: t.series[k % t.series.length] }));
  items.push({ text: words.key(macs.length > 1 ? macs[0].machine : null), color: null });
  let x = 0;
  let y = 14;
  for (const item of items) {
    const w = (item.color ? 16 : 0) + textWidth(item.text, 12);
    if (x > 0 && x + w > width) {
      x = 0;
      y += 20;
    }
    if (item.color) parts.push(`<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${item.color}"/>`);
    parts.push(`<text x="${x + (item.color ? 16 : 0)}" y="${y}" font-size="12" fill="${item.color ? t.secondary : t.muted}">${esc(item.text)}</text>`);
    x += w + 24;
  }
  y += 22;
  let anySplit = false;
  for (let i = 0; i < PANELS.length; i += 2) {
    const a = panel(macs, PANELS[i], lang, 0, y, colW);
    const b = PANELS[i + 1] ? panel(macs, PANELS[i + 1], lang, colW + gap, y, colW) : { svg: "", height: 0, split: false };
    anySplit ||= a.split || b.split;
    parts.push(a.svg, b.svg);
    y += Math.max(a.height, b.height) + 28;
  }
  const differ = builds(macs);
  const notes = [
    words.about,
    ...(anySplit ? [words.split] : []),
    ...(differ ? [words.builds(differ)] : []),
    ...(macs.length > 1 ? [words.compare] : []),
  ].flatMap((n) => wrap(n, width, 11));
  notes.forEach((line, i) => parts.push(`<text x="0" y="${y + 4 + i * 16}" font-size="11" fill="${t.muted}">${esc(line)}</text>`));
  // The card: what was laid out above, with room around it.
  const W = width + 2 * PAD;
  const H = y + 12 + (notes.length - 1) * 16 + 2 * PAD;
  const card = `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.card}" stroke="${t.edge}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}' role="img" aria-label="${esc(words.title)}"><title>${esc(words.title)}</title>${card}<g transform="translate(${PAD} ${PAD})">${parts.join("")}</g></svg>\n`;
}

/**
 * Writes docs/assets/bench.svg (English) and bench-ru.svg from the results of every Mac, the first one being the Mac
 * the README's table comes from; returns the files.
 */
export function charts(macs) {
  if (!macs.length) return [];
  const files = [];
  for (const lang of Object.keys(TEXT)) {
    const file = join(ROOT, "docs/assets", `bench${lang === "en" ? "" : `-${lang}`}.svg`);
    writeFileSync(file, chart(macs, lang));
    files.push(file);
  }
  return files;
}
