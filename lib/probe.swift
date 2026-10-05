// Samples an app from the outside, the same way for every client: its processes, their memory and CPU time,
// and whether it shows a window yet. Needs no permissions: nothing here reads window contents.
//
//   probe <pid> [interval-ms]
//   probe --screen
//   probe --system <harness pid> [interval-ms]
//
// `--screen` prints the main screen (the one with the menu bar) once, in points:
//   {"frame": [w, h], "visible": [x, yTop, w, h], "scale": 2, "screens": 1}
// where `visible` leaves out the menu bar and the Dock, and yTop is measured from the top, as window positions are.
//
// `--system` watches the whole Mac for as long as the harness runs, to tell a quiet run from a disturbed one: one
// line per tick with the CPU ticks of all cores, the CPU time of the benchmark's Docker VM, of WindowServer (null
// if macOS won't say) and of the harness itself (its processes, finished children included), memory pressure,
// pageouts and swapouts, thermal state, low power mode, power source, and once a second the process that owns the
// frontmost window and whether the display sleeps or the screen is locked:
//   {"t", "busy", "total", "cpus", "vm", "ws", "harness", "pressure", "pageouts", "swapouts", "thermal",
//    "lowPower", "ac", "front", "asleep", "locked"}
//
// Otherwise it prints one JSON line per tick:
//   {"t": unix ms, "procs": [[pid, name, phys_footprint bytes, cpu ns, wakeups], …], "windows": [[w, h], …]}
// and exits when <pid> does.
//
// An app's processes are <pid>, its descendants (Electron helpers, Headlamp's server) and the processes it is
// responsible for (the WebKit processes that render a WKWebView are started by launchd, not by the app).
// phys_footprint is the "Memory" column of Activity Monitor.

import AppKit
import CoreGraphics
import Darwin
import Foundation
import IOKit.ps

typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
let responsibleSym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
let responsible: ResponsibleFn? = responsibleSym.map { unsafeBitCast($0, to: ResponsibleFn.self) }

var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)

func allPids() -> [pid_t] {
  let count = proc_listallpids(nil, 0)
  var buf = [pid_t](repeating: 0, count: Int(count) + 128)
  let got = buf.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
  return buf.prefix(Int(max(got, 0))).filter { $0 > 0 }
}

func parent(_ pid: pid_t) -> pid_t? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size ? pid_t(info.pbi_ppid) : nil
}

func name(_ pid: pid_t) -> String {
  var buf = [CChar](repeating: 0, count: 1024)
  proc_name(pid, &buf, UInt32(buf.count))
  return String(cString: buf)
}

func usage(_ pid: pid_t) -> rusage_info_v4? {
  var info = rusage_info_v4()
  let rc = withUnsafeMutablePointer(to: &info) {
    $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
  }
  return rc == 0 ? info : nil
}

func family(of root: pid_t) -> [pid_t] {
  let pids = allPids()
  var parents = [pid_t: pid_t]()
  var owners = [pid_t: pid_t]()
  for p in pids {
    parents[p] = parent(p)
    if let r = responsible?(p), r != p { owners[p] = r }
  }
  var members: Set<pid_t> = [root]
  var grew = true
  while grew {
    grew = false
    for p in pids where !members.contains(p) {
      if let pp = parents[p], members.contains(pp) { members.insert(p); grew = true }
      else if let o = owners[p], members.contains(o) { members.insert(p); grew = true }
    }
  }
  return members.sorted()
}

func windows(of pids: Set<pid_t>) -> [[Int]] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  var out = [[Int]]()
  for w in list {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int, pids.contains(pid_t(owner)) else { continue }
    guard (w[kCGWindowLayer as String] as? Int) == 0, ((w[kCGWindowAlpha as String] as? Double) ?? 0) > 0 else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Double], let width = b["Width"], let height = b["Height"] else { continue }
    if width >= 300 && height >= 200 { out.append([Int(width), Int(height)]) }
  }
  return out
}

func jsonString(_ s: String) -> String {
  let data = try! JSONSerialization.data(withJSONObject: [s])
  return String(data: data, encoding: .utf8)!.dropFirst().dropLast().description
}

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--screen" {
  guard let screen = NSScreen.screens.first else { exit(1) }
  let f = screen.frame
  let v = screen.visibleFrame
  let yTop = f.maxY - v.maxY
  print("{\"frame\":[\(Int(f.width)),\(Int(f.height))],\"visible\":[\(Int(v.minX)),\(Int(yTop)),\(Int(v.width)),\(Int(v.height))],\"scale\":\(screen.backingScaleFactor),\"screens\":\(NSScreen.screens.count)}")
  exit(0)
}

/** CPU ticks of all cores, busy and in total: the share of the whole Mac that was in use between two readings. */
func hostTicks() -> (busy: UInt64, total: UInt64, cpus: Int) {
  var count: natural_t = 0
  var info: processor_info_array_t?
  var infoCount: mach_msg_type_number_t = 0
  guard host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS, let info else { return (0, 0, 0) }
  var busy: UInt64 = 0
  var total: UInt64 = 0
  for i in 0..<Int(count) {
    let b = Int(CPU_STATE_MAX) * i
    let tick = { (state: Int32) in UInt64(UInt32(bitPattern: info[b + Int(state)])) }
    let used = tick(CPU_STATE_USER) + tick(CPU_STATE_SYSTEM) + tick(CPU_STATE_NICE)
    busy += used
    total += used + tick(CPU_STATE_IDLE)
  }
  vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: info)), vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride))
  return (busy, total, Int(count))
}

func vmCounters() -> (pageouts: UInt64, swapouts: UInt64) {
  var stats = vm_statistics64()
  var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
  let rc = withUnsafeMutablePointer(to: &stats) {
    $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count) }
  }
  return rc == KERN_SUCCESS ? (UInt64(stats.pageouts), UInt64(stats.swapouts)) : (0, 0)
}

/** 1 normal, 2 warning, 4 critical. */
func memoryPressure() -> Int32 {
  var level: Int32 = 0
  var size = MemoryLayout<Int32>.size
  return sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0 ? level : 0
}

func onAC() -> String {
  guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(), let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return "null" }
  return (type as String) == kIOPMACPowerKey ? "true" : "false"
}

/** The process that owns the frontmost ordinary window. */
func frontmostPid() -> Int {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return 0 }
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0, ((w[kCGWindowAlpha as String] as? Double) ?? 0) > 0 else { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Double], (b["Width"] ?? 0) >= 100, (b["Height"] ?? 0) >= 100 else { continue }
    return (w[kCGWindowOwnerPID as String] as? Int) ?? 0
  }
  return 0
}

func screenLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

/** CPU time in ns of a set of processes, plus the finished children of `withChildren` (its reaped commands). */
func cpuOf(_ pids: [pid_t], withChildren: pid_t? = nil) -> UInt64? {
  var total: UInt64 = 0
  var any = false
  for p in pids {
    guard let u = usage(p) else { continue }
    any = true
    var ticks = u.ri_user_time + u.ri_system_time
    if p == withChildren { ticks += u.ri_child_user_time + u.ri_child_system_time }
    total += ticks * UInt64(timebase.numer) / UInt64(timebase.denom)
  }
  return any ? total : nil
}

if args.count >= 3 && args[1] == "--system" {
  guard let harness = pid_t(args[2]) else { exit(2) }
  let interval = args.count >= 4 ? (Double(args[3]) ?? 250) / 1000 : 0.25
  var vmPids = [pid_t]()
  var wsPids = [pid_t]()
  var harnessPids = [pid_t]()
  var lastGroups = Date.distantPast
  var lastScreen = Date.distantPast
  var front = 0
  var asleep = false
  var locked = false
  while kill(harness, 0) == 0 {
    let tick = Date()
    if tick.timeIntervalSince(lastGroups) >= 2 {
      let pids = allPids()
      // proc_name keeps 16 characters: "com.apple.Virtua…" is the Virtualization framework's VM process.
      vmPids = pids.filter { let n = name($0); return n == "limactl" || n.hasPrefix("com.apple.Virtua") }
      wsPids = pids.filter { name($0) == "WindowServer" }
      harnessPids = family(of: harness)
      lastGroups = tick
    }
    if tick.timeIntervalSince(lastScreen) >= 1 {
      front = frontmostPid()
      asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
      locked = screenLocked()
      lastScreen = tick
    }
    let host = hostTicks()
    let vm = vmCounters()
    let ws = cpuOf(wsPids).map { String($0) } ?? "null"
    let line = "{\"t\":\(Int64(tick.timeIntervalSince1970 * 1000)),\"busy\":\(host.busy),\"total\":\(host.total),\"cpus\":\(host.cpus)"
      + ",\"vm\":\(cpuOf(vmPids) ?? 0),\"ws\":\(ws),\"harness\":\(cpuOf(harnessPids, withChildren: harness) ?? 0)"
      + ",\"pressure\":\(memoryPressure()),\"pageouts\":\(vm.pageouts),\"swapouts\":\(vm.swapouts)"
      + ",\"thermal\":\(ProcessInfo.processInfo.thermalState.rawValue),\"lowPower\":\(ProcessInfo.processInfo.isLowPowerModeEnabled)"
      + ",\"ac\":\(onAC()),\"front\":\(front),\"asleep\":\(asleep),\"locked\":\(locked)}"
    print(line)
    let spent = Date().timeIntervalSince(tick)
    if spent < interval { usleep(useconds_t((interval - spent) * 1_000_000)) }
  }
  exit(0)
}
guard args.count >= 2, let root = pid_t(args[1]) else {
  FileHandle.standardError.write("usage: probe <pid> [interval-ms]\n".data(using: .utf8)!)
  exit(2)
}
let interval = args.count >= 3 ? (Double(args[2]) ?? 100) / 1000 : 0.1
let started = Date()
var members = family(of: root)
var lastFamily = Date()
var sawWindow = false
var lastWindows = Date.distantPast

while kill(root, 0) == 0 {
  let tick = Date()
  // New processes appear mostly while an app starts: look for them often then, rarely later.
  let refresh = tick.timeIntervalSince(started) < 20 ? 0.25 : 2.0
  if tick.timeIntervalSince(lastFamily) >= refresh {
    members = family(of: root)
    lastFamily = tick
  }
  var procs = [String]()
  for p in members {
    guard let u = usage(p) else { continue }
    let cpu = (u.ri_user_time + u.ri_system_time) * UInt64(timebase.numer) / UInt64(timebase.denom)
    let wakeups = u.ri_interrupt_wkups + u.ri_pkg_idle_wkups
    procs.append("[\(p),\(jsonString(name(p))),\(u.ri_phys_footprint),\(cpu),\(wakeups)]")
  }
  // Windows matter until the first one shows up; after that a check a second is plenty.
  var wins = "null"
  if !sawWindow || tick.timeIntervalSince(lastWindows) >= 1 {
    let found = windows(of: Set(members))
    sawWindow = sawWindow || !found.isEmpty
    lastWindows = tick
    wins = "[" + found.map { "[\($0[0]),\($0[1])]" }.joined(separator: ",") + "]"
  }
  print("{\"t\":\(Int64(tick.timeIntervalSince1970 * 1000)),\"procs\":[\(procs.joined(separator: ","))],\"windows\":\(wins)}")
  let spent = Date().timeIntervalSince(tick)
  if spent < interval { usleep(useconds_t((interval - spent) * 1_000_000)) }
}
