# k10s benchmark

[k10s](../../../k10s) and other Kubernetes clients for the Mac, measured on the same Mac, against the same local clusters, with the same steps, and with nobody at the Mac: the benchmark starts and drives every client itself. This is where the chart in k10s's README comes from, every number behind it, and how to repeat it on your own Mac with one command.

<img alt="Bar charts for k10s, Aptakube, Headlamp, Freelens and k9s, one bar per Mac: time to a table of 10,000 pods, memory, CPU while pods change, data downloaded, memory with five clusters and with 50,000 pods, time to 100,000 namespaces, CPU while following a log" src="docs/assets/bench.svg">

The latest version of each client with its default settings, on [KWOK](https://kwok.sigs.k8s.io) clusters (a real API server with simulated nodes and pods); the median of 5 to 9 runs. Lower is better everywhere.

<!-- benchmarks -->
| | **k10s** | **Aptakube** | **Headlamp** | **Freelens** | **k9s**¹ |
| --- | --- | --- | --- | --- | --- |
| Start to a table of 10,000 pods | 0.7 s | 1.6 s | first 1,000 only | 4.9 s | 5.2 s |
| Memory with them on screen | 208 MB | 1,065 MB | first 1,000 only | 715 MB | 1,375 MB |
| CPU while nothing changes | 1.3% | 0.3% | first 1,000 only | 2.4% | 40.0% |
| CPU while 100 of them change a second | 9% | 69% | first 1,000 only | 28% | 42% |
| Downloaded to show them | 4.9 MB | 4.9 MB | first 1,000 only | 5.9 MB | 74.2 MB |
| API requests to show them | 12 | 9 | first 1,000 only | 107 | 15 |
| Memory, 50,000 pods | 338 MB | 1,643 MB | first 1,000 only | 1,198 MB | 6,711 MB |
| Memory, five clusters of 10,000 pods in one table | 363 MB | 1,573 MB | first 1,000 only | one cluster at a time | one cluster at a time |
| Start to a list of 100,000 namespaces | 1.1 s | 2.5 s | 3.1 s | 230.9 s | 5.8 s |
| API requests for that list | 9 | 105 | 15 | 100,050 | 15 |
| CPU while following a log of 300 lines a second | 9% | 47% | 27% | rereads every 10 s | 27% |

Measured on 2026-10-05 on an M1 Max with 32 GB of memory: k10s 0.1.0, Aptakube 1.21.1, Headlamp 0.45.0, Freelens 1.10.3 and k9s 0.51.0.
<!-- /benchmarks -->

¹ k9s runs in a terminal, and the terminal app that draws it isn't counted. Where a client does less than the others, its number isn't shown: Headlamp loads the first 1,000 objects of a list and the rest only when you ask, and Freelens reads a log again every 10 seconds instead of following it. Lens isn't measured: it works only after signing in to a Lens ID, and Freelens is its open source fork.

What is measured and how, what it doesn't tell you, and every number on every Mac: [docs/benchmarks.md](docs/benchmarks.md).

## What you need

- A Mac with Apple silicon, 16 GB of memory or more.
- Node.js 22+, the Xcode command line tools (`xcode-select --install`), Homebrew, and:

  ```bash
  brew install colima docker kwok kubernetes-cli
  ```

  The clusters run in a virtual machine of the benchmark's own (colima, 4 CPUs, 8 GB), which it creates and starts by itself. It has its own settings in `~/.k10s-bench`: your Docker context, `~/.docker` and `~/.ssh/config` stay as they are.
- No other virtual machine running while it measures: quit Docker Desktop, OrbStack and your own colima VMs first. The benchmark checks, and never stops them itself.
- An Aptakube trial or licence: open Aptakube once and start a trial (or enter a licence). The benchmark copies that file into an Aptakube profile of its own and changes nothing in yours; quit your Aptakube before it runs.
- The k10s to measure: its release pinned in [clients.lock.json](clients.lock.json) once there is one, or a k10s checkout (`--k10s ../k10s`), which the benchmark builds, or an app (`K10S_APP=/Applications/k10s.app`).
- About 30 GB of free disk, for the VM, the clients and the clusters, all in `~/.k10s-bench`.

`node bench.mjs doctor` checks all of this and says what is missing.

## Running it

```bash
node bench.mjs run --k10s ../k10s
```

It downloads the clients (the exact builds pinned in [clients.lock.json](clients.lock.json), checked against their SHA-256), builds k10s in the checkout `--k10s` names when its build in `target/` isn't from the checkout's app files, creates the VM and the clusters (an hour or so the first time), and then measures each client in each scenario: a warm-up start, then 5 to 9 counted runs, in turns, until its numbers settle. A full run takes about 7 hours; overnight is the time for it. Results go to `results/<date>-<chip>-<memory>.json` after every run, so an interrupted run keeps what it measured; run the same command again (with `--out` and that file, on another day) to add to it: it measures only what the file still lacks.

While it runs, leave the Mac alone: the apps come to the front and must stay there (macOS slows down windows that are hidden), and anything else running adds noise. The benchmark keeps the Mac and its display awake by itself. Runs disturbed anyway (something else busy, the Mac hot or on battery, the app not in front) are marked noisy and measured again.

Lens isn't measured unless you ask for it with `--clients lens`: it works only after signing in to a Lens ID, which the benchmark then asks you to do once, in a profile of its own. Freelens, its open source fork, is the same app underneath.

Options:

| | |
| --- | --- |
| `--k10s ../k10s` | the k10s to measure, built from this checkout (instead of its pinned release) |
| `--clients k10s,headlamp` | only these clients (`k10s`, `aptakube`, `headlamp`, `freelens`, `k9s`; `lens` on request) |
| `--scenarios pods-10k,logs-300` | only these scenarios (see `lib/scenarios.mjs`) |
| `--runs 3` | exactly this many counted runs per client and scenario, instead of 5 to 9 |
| `--seed 1a2b3c4d` | the order of the turns (by default random, and recorded in the results) |
| `--budget-hours 8` | if the rest wouldn't fit in this many hours (default 10), at most 7 runs per client and scenario from there on |
| `--out file.json` | another results file, or one to add to |
| `--allow-env-drift` | add to a file made with another macOS build, display or VM size |
| `--keep-profiles` | start the clients from their profiles of the last run, not fresh ones (for debugging) |
| `--keep-vm` | leave the VM running at the end (it stops by default) |
| `--build` | build k10s again (with `--k10s`) |

Any other build of k10s: `K10S_APP=/Applications/k10s.app node bench.mjs run` measures that app.

A quick smoke run checks that everything works, in about an hour: short windows, no long waits for a quiet Mac, and noisy runs aren't measured again. Its numbers mean nothing, so it can't go into `results/`:

```bash
K10S_BENCH_QUICK=1 node bench.mjs run --k10s ../k10s --runs 1 --out ~/k10s-bench-smoke/all.json < /dev/null
```

## Results

```bash
node bench.mjs check results/2026-10-05-m1-max-32gb.json
```

says what a results file holds, cell by cell (good runs, noisy ones, failed ones, runs on the wrong screen), and what went wrong in it; it exits with 1 if something did.

```bash
node bench.mjs compare a.json b.json
```

puts two runs of the same Mac side by side, and passes if they agree as [docs/benchmarks.md](docs/benchmarks.md#repeatability) promises.

```bash
node bench.mjs report --export ../k10s
```

reads every file in `results/`, writes the tables into [docs/benchmarks.md](docs/benchmarks.md), the chart of every Mac into `docs/assets/bench.svg` (and in Russian into `bench-ru.svg`), and the short table into this README, between its `benchmarks` markers. `--export` copies the two charts into a k10s checkout (its `docs/assets`), whose READMEs show them. Only clean runs count: not warm-ups, failed or noisy runs, or runs that showed another screen. Files from different Macs are kept apart: each machine gets its own tables in docs/benchmarks.md. The README's table and the chart's first color are one machine: the one with the most runs, or the one you name with `--main` (its name is in the results file's name, e.g. `--main m2-pro-16gb`). Files of one Mac made with another macOS build, display or VM aren't mixed unless you say so (`--allow-env-drift`), and files from an older version of the benchmark aren't read at all: their numbers mean other things.

To add a second Mac, run the benchmark there, copy its file into `results/` next to the first one, and run `report` again.

## Cleaning up

```bash
node bench.mjs clean
```

deletes the VM and `~/.k10s-bench` (the downloaded clients, their profiles, the clusters). `clean --vm` deletes only the VM. Nothing outside `~/.k10s-bench` is changed: the clients never see your `~/.kube/config`, and your own app settings, Aptakube's included, are left alone.

## How it works

| File | |
| --- | --- |
| `bench.mjs` | the command line: doctor, run, check, compare, report, clean; a run's rounds |
| `lib/vm.mjs` | the benchmark's own colima VM, and the only way the benchmark calls `docker` |
| `lib/clusters.mjs` | KWOK clusters in the VM, filled with Deployments; a client certificate for each run's user |
| `lib/logs.mjs` | a k3s cluster with one pod that writes 300 log lines a second, its rate, and its newest line (how far behind it an app shows the log) |
| `lib/proxy.mjs` | a TCP proxy in front of each API server that counts the bytes each way, in 10 ms steps |
| `lib/audit.mjs` | API requests per run, from the API servers' audit logs (only users of group `bench`, one per run, are logged) |
| `lib/probe.swift` | memory and CPU of all of an app's processes, and its windows, sampled ten times a second; the whole Mac (CPU, the VM, heat, memory pressure, power, the app in front) four times a second |
| `lib/measure.mjs` | one run: put back the saved state, start, open, wait until ready, idle, churn or log |
| `lib/estimators.mjs` | from a run's samples to its numbers: ready, the windows, peak, the log, noise |
| `lib/schedule.mjs`, `lib/stats.mjs` | the order of the turns, and when a client has had enough runs |
| `lib/state.mjs` | each client's saved state per scenario, and its fingerprint |
| `lib/system.mjs` | what else the Mac did while a run was measured, and the waits for a quiet Mac |
| `lib/verify.mjs` | whether a run showed the scenario's screen, from its requests |
| `lib/churn.mjs` | pods that keep changing, at a fixed rate |
| `lib/clients/` | how each client is started and driven: what it remembers, written before start (k10s, Aptakube), the DevTools protocol (Lens, Freelens, Headlamp), a pseudo-terminal (k9s) |
| `lib/report.mjs`, `lib/charts.mjs`, `lib/compare.mjs` | tables, charts, `check` and `compare` |
| `test/` | tests of the pure parts: `npm test` (`node --test`), and `npm run lint` |
