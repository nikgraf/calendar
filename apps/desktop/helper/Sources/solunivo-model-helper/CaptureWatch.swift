// Whether a screen capture is under way, for the screen-privacy hint.
//
// macOS tells an app nothing when a screenshot or recording starts: the
// screenshot UI (screencaptureui) stays resident and never activates. What
// does change is the process table — ⌘⇧3, ⌘⇧4 (crosshair, window, drag),
// ⌘⇧5 and its recordings each run a fresh `screencapture` process for as
// long as the capture lasts (⌘⇧3: ~200 ms). So the watch diffs the pid
// list ten times a second and names only pids it has not seen, about
// 0.04 ms a pass, and only while the supervisor asks (privacy on, a window
// on screen). Helper-only: iOS has no equivalent and no privacy mode.
import Darwin
import Foundation

final class CaptureWatch: @unchecked Sendable {
  static let shared = CaptureWatch()

  private let queue = DispatchQueue(label: "solunivo.capture-watch")
  // Everything below is touched only on `queue`.
  private var timer: DispatchSourceTimer?
  private var known = Set<Int32>()
  private var capturing = Set<Int32>()
  private var pids = [Int32](repeating: 0, count: 4096)
  private var name = [CChar](repeating: 0, count: 256)
  private var onChange: (@Sendable (Bool) -> Void)?

  /// Starts or stops the watch. `onChange` hears true when the first
  /// capture process appears and false when the last one is gone — also
  /// when the watch stops mid-capture, so the supervisor never keeps a
  /// hint up for a capture nobody watches any more.
  func set(on: Bool, onChange: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      if on {
        self.onChange = onChange
        guard self.timer == nil else { return }
        // Everything is new on the first pass, so a capture already
        // running (a recording) is found too.
        self.known = []
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(50))
        timer.setEventHandler { self.poll() }
        self.timer = timer
        timer.resume()
      } else {
        self.timer?.cancel()
        self.timer = nil
        if !self.capturing.isEmpty {
          self.capturing = []
          self.onChange?(false)
        }
        self.known = []
      }
    }
  }

  private func poll() {
    var count = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size)))
    if count >= pids.count {
      // A full buffer may have cut the list short: grow for the next pass.
      pids = [Int32](repeating: 0, count: pids.count * 2)
      count = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size)))
    }
    guard count > 0 else { return }
    let wasCapturing = !capturing.isEmpty
    var current = Set<Int32>(minimumCapacity: count)
    for pid in pids.prefix(count) where pid > 0 {
      current.insert(pid)
      if !known.contains(pid), proc_name(pid, &name, UInt32(name.count)) > 0,
        String(decoding: name.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self)
          == "screencapture"
      {
        capturing.insert(pid)
      }
    }
    known = current
    capturing.formIntersection(current)
    if capturing.isEmpty == wasCapturing {
      onChange?(!capturing.isEmpty)
    }
  }
}

enum CaptureWatchDispatch {
  /// `capture.watch {on}` — events `capture.started` / `capture.ended`.
  static func invoke(params: [String: JSONValue]) throws -> [String: Any] {
    guard case .bool(let on) = params["on"] else {
      throw HelperError.badRequest("capture.watch needs on: boolean")
    }
    CaptureWatch.shared.set(on: on) { capturing in
      emit(["event": capturing ? "capture.started" : "capture.ended"])
    }
    return ["on": on]
  }
}
