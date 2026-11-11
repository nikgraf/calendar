import ExpoModulesCore
import Foundation
import UIKit
import os

/// What a measurement run needs of the process. Its memory: what it holds
/// and what it may still take, for a model that is loaded into the app's
/// own memory. iOS ends an app by its footprint, not by what the device
/// has, and does not publish the limit: `footprint + available` read on a
/// device is that limit. And a screen that stays on: a locked iPhone
/// suspends the app, and the time it was away would count as the model's.
public class SolunivoProcessMemoryModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SolunivoProcessMemory")

    // A read of two counters: synchronous, so a caller can take it right
    // before and right after a step.
    Function("read") { () -> [String: Double] in
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
      let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
          task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
        }
      }
      return [
        "available": Double(os_proc_available_memory()),
        "footprint": status == KERN_SUCCESS ? Double(info.phys_footprint) : 0,
        "physical": Double(ProcessInfo.processInfo.physicalMemory),
      ]
    }

    // The idle timer is the main thread's to set.
    Function("keepAwake") { (on: Bool) in
      DispatchQueue.main.async {
        UIApplication.shared.isIdleTimerDisabled = on
      }
    }
  }
}
