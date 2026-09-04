// Solunivo Reminders bridge: EventKit reminders as plain JSON.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module — each of which symlinks this file into its target.
// The JSON shape is the contract in packages/reminders/src/protocol.ts;
// keep the three in step.
//
// Concurrency: EKEventStore and its items are not Sendable, so every
// touch happens inside the `RemindersBridge` actor and only plain DTOs
// leave it. Fetch completions run on EventKit's own queue; they convert
// to DTOs right there and resume with those.
import EventKit
import Foundation

struct ReminderListDTO: Sendable {
  let allowsModifications: Bool
  let colorHex: String?
  let id: String
  let title: String

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "allowsModifications": allowsModifications, "id": id, "title": title,
    ]
    if let colorHex { out["colorHex"] = colorHex }
    return out
  }
}

struct ReminderRecurrenceDTO: Sendable {
  let count: Int?
  let freq: String
  let interval: Int
  let unsupported: Bool
  let untilDate: String?

  func toDictionary() -> [String: Any] {
    if unsupported { return ["unsupported": true] }
    var out: [String: Any] = ["freq": freq, "interval": interval]
    if let count { out["count"] = count }
    if let untilDate { out["untilDate"] = untilDate }
    return out
  }
}

struct ReminderDTO: Sendable {
  let alarms: [Int]
  let completed: Bool
  let completedAt: Int?
  let dueDate: String?
  let dueTime: String?
  let id: String
  let listId: String
  let notes: String?
  let priority: Int
  let recurrence: ReminderRecurrenceDTO?
  let title: String
  let updatedAt: Int
  let url: String?

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "alarms": alarms, "completed": completed, "id": id, "listId": listId,
      "priority": priority, "title": title, "updatedAt": updatedAt,
    ]
    if let completedAt { out["completedAt"] = completedAt }
    if let dueDate { out["dueDate"] = dueDate }
    if let dueTime { out["dueTime"] = dueTime }
    if let notes { out["notes"] = notes }
    if let recurrence { out["recurrence"] = recurrence.toDictionary() }
    if let url { out["url"] = url }
    return out
  }
}

/// Sendable JSON tree: `[String: Any]` cannot cross into the actor under
/// Swift 6 strict concurrency, so write payloads travel as this and are
/// unwrapped back to Foundation values inside.
enum JSONNode: Sendable {
  case array([JSONNode])
  case bool(Bool)
  case null
  case number(Double)
  case object([String: JSONNode])
  case string(String)

  init(any value: Any) {
    switch value {
    case let node as JSONNode: self = node
    case is NSNull: self = .null
    case let text as String: self = .string(text)
    case let flag as Bool: self = .bool(flag)
    case let int as Int: self = .number(Double(int))
    case let double as Double: self = .number(double)
    case let number as NSNumber: self = .number(number.doubleValue)
    case let items as [Any]: self = .array(items.map { JSONNode(any: $0) })
    case let fields as [String: Any]: self = .object(fields.mapValues { JSONNode(any: $0) })
    default: self = .null
    }
  }

  static func object(_ fields: [String: Any]) -> [String: JSONNode] {
    fields.mapValues { JSONNode(any: $0) }
  }

  /// Back to the Foundation shape `apply` reads (NSNull for null; whole
  /// numbers as Int so `as? Int` casts behave).
  var any: Any {
    switch self {
    case .array(let items): return items.map { $0.any }
    case .bool(let flag): return flag
    case .null: return NSNull()
    case .number(let value):
      return value.rounded() == value && abs(value) < 1e15 ? Int(value) : value
    case .object(let fields): return fields.mapValues { $0.any }
    case .string(let text): return text
    }
  }
}

enum RemindersBridgeError: Error, Sendable {
  case accessDenied(String)
  case badRequest(String)
  case notFound(String)
  case saveFailed(String)

  /// Prefixed so the TS client can map access failures to a typed error.
  var message: String {
    switch self {
    case .accessDenied(let status): return "accessDenied: \(status)"
    case .badRequest(let text): return "badRequest: \(text)"
    case .notFound(let text): return "notFound: \(text)"
    case .saveFailed(let text): return "saveFailed: \(text)"
    }
  }
}

// MARK: - Date helpers (device zone, as the protocol specifies)

private let dayFormatter: DateFormatter = {
  let f = DateFormatter()
  f.calendar = Calendar(identifier: .gregorian)
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = TimeZone.current
  f.dateFormat = "yyyy-MM-dd"
  return f
}()

private func pad2(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }

private func dueStrings(_ components: DateComponents?) -> (date: String?, time: String?) {
  guard var c = components, let y = c.year, let m = c.month, let d = c.day else {
    return (nil, nil)
  }
  // A timed reminder created in another zone carries that zone in its
  // components; the protocol speaks device-local wall clock, so convert.
  // All-day components have no zone semantics and stay as written.
  if c.hour != nil, let zone = c.timeZone, zone.identifier != TimeZone.current.identifier,
    let instant = Calendar.current.date(from: c)
  {
    c = Calendar.current.dateComponents(in: TimeZone.current, from: instant)
  }
  let year = c.year ?? y
  let month = c.month ?? m
  let day = c.day ?? d
  let date = "\(year)-\(pad2(month))-\(pad2(day))"
  guard let h = c.hour else { return (date, nil) }
  return (date, "\(pad2(h)):\(pad2(c.minute ?? 0))")
}

private func parseDay(_ text: String) -> (year: Int, month: Int, day: Int)? {
  let parts = text.split(separator: "-").compactMap { Int($0) }
  guard parts.count == 3 else { return nil }
  return (parts[0], parts[1], parts[2])
}

private func parseTime(_ text: String) -> (hour: Int, minute: Int)? {
  let parts = text.split(separator: ":").compactMap { Int($0) }
  guard parts.count == 2 else { return nil }
  return (parts[0], parts[1])
}

private func dueComponents(date: String, time: String?) -> DateComponents? {
  guard let day = parseDay(date) else { return nil }
  var c = DateComponents()
  c.calendar = Calendar.current
  c.timeZone = TimeZone.current
  c.year = day.year
  c.month = day.month
  c.day = day.day
  if let time, let t = parseTime(time) {
    c.hour = t.hour
    c.minute = t.minute
  }
  return c
}

private func hexColor(_ cgColor: CGColor?) -> String? {
  guard let cgColor,
    let rgb = cgColor.converted(
      to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
    let parts = rgb.components, parts.count >= 3
  else { return nil }
  let r = Int((parts[0] * 255).rounded())
  let g = Int((parts[1] * 255).rounded())
  let b = Int((parts[2] * 255).rounded())
  return String(format: "#%02x%02x%02x", r, g, b)
}

private func frequencyName(_ f: EKRecurrenceFrequency) -> String {
  switch f {
  case .daily: return "daily"
  case .weekly: return "weekly"
  case .monthly: return "monthly"
  case .yearly: return "yearly"
  @unknown default: return "daily"
  }
}

private func frequency(named name: String) -> EKRecurrenceFrequency? {
  switch name {
  case "daily": return .daily
  case "weekly": return .weekly
  case "monthly": return .monthly
  case "yearly": return .yearly
  default: return nil
  }
}

private func reminderDTO(_ reminder: EKReminder) -> ReminderDTO {
  let due = dueStrings(reminder.dueDateComponents)
  let relativeAlarms = (reminder.alarms ?? [])
    .filter { $0.absoluteDate == nil }
    .map { Int(($0.relativeOffset / 60).rounded()) }
  var recurrence: ReminderRecurrenceDTO? = nil
  if let rules = reminder.recurrenceRules, let rule = rules.first {
    let exotic =
      rules.count > 1 || !(rule.daysOfTheWeek ?? []).isEmpty
      || !(rule.daysOfTheMonth ?? []).isEmpty || !(rule.monthsOfTheYear ?? []).isEmpty
      || !(rule.weeksOfTheYear ?? []).isEmpty || !(rule.daysOfTheYear ?? []).isEmpty
      || !(rule.setPositions ?? []).isEmpty
    if exotic {
      recurrence = ReminderRecurrenceDTO(
        count: nil, freq: "daily", interval: 1, unsupported: true, untilDate: nil)
    } else {
      var count: Int? = nil
      var until: String? = nil
      if let end = rule.recurrenceEnd {
        if end.occurrenceCount > 0 {
          count = end.occurrenceCount
        } else if let endDate = end.endDate {
          until = dayFormatter.string(from: endDate)
        }
      }
      recurrence = ReminderRecurrenceDTO(
        count: count, freq: frequencyName(rule.frequency), interval: rule.interval,
        unsupported: false, untilDate: until)
    }
  }
  return ReminderDTO(
    alarms: relativeAlarms,
    completed: reminder.isCompleted,
    completedAt: reminder.completionDate.map { Int($0.timeIntervalSince1970 * 1000) },
    dueDate: due.date,
    dueTime: due.time,
    id: reminder.calendarItemIdentifier,
    listId: reminder.calendar.calendarIdentifier,
    notes: reminder.notes,
    priority: reminder.priority,
    recurrence: recurrence,
    title: reminder.title ?? "",
    updatedAt: Int(
      (reminder.lastModifiedDate ?? reminder.creationDate ?? Date()).timeIntervalSince1970
        * 1000),
    url: reminder.url?.absoluteString)
}

// MARK: - The actor

actor RemindersBridge {
  static let shared = RemindersBridge()

  private let store = EKEventStore()

  // MARK: Access

  func status() -> String {
    let status = EKEventStore.authorizationStatus(for: .reminder)
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "fullAccess"
    default:
      // iOS 17 / macOS 14 split the old "authorized" into two.
      if #available(iOS 17, macOS 14, *) {
        if status == .fullAccess { return "fullAccess" }
        if status == .writeOnly { return "writeOnly" }
      }
      return "unavailable"
    }
  }

  func requestAccess() async -> Bool {
    let granted: Bool
    if #available(iOS 17, macOS 14, *) {
      granted = (try? await store.requestFullAccessToReminders()) ?? false
    } else {
      granted = await withCheckedContinuation { continuation in
        store.requestAccess(to: .reminder) { ok, _ in continuation.resume(returning: ok) }
      }
    }
    if granted {
      // The store was created before the grant (the pre-prompt status
      // call); a store instantiated without access can keep answering
      // with no calendars until reset.
      store.reset()
    }
    return granted
  }

  private func requireAccess() throws {
    let current = status()
    guard current == "fullAccess" else { throw RemindersBridgeError.accessDenied(current) }
  }

  // MARK: Lists

  func listLists() throws -> [ReminderListDTO] {
    try requireAccess()
    return store.calendars(for: .reminder).map { calendar in
      ReminderListDTO(
        allowsModifications: calendar.allowsContentModifications,
        colorHex: hexColor(calendar.cgColor),
        id: calendar.calendarIdentifier,
        title: calendar.title)
    }
  }

  // MARK: Reminders

  private func fetch(_ predicate: NSPredicate) async -> [ReminderDTO] {
    // The completion runs on EventKit's queue; convert there so only
    // Sendable DTOs cross back into the actor.
    await withCheckedContinuation { continuation in
      store.fetchReminders(matching: predicate) { reminders in
        continuation.resume(returning: (reminders ?? []).map(reminderDTO))
      }
    }
  }

  func list(startDate: String, endDate: String) async throws -> [ReminderDTO] {
    try requireAccess()
    guard let startParts = parseDay(startDate), let endParts = parseDay(endDate) else {
      throw RemindersBridgeError.badRequest("startDate/endDate must be YYYY-MM-DD")
    }
    let calendar = Calendar.current
    guard
      let start = calendar.date(
        from: DateComponents(year: startParts.year, month: startParts.month, day: startParts.day)),
      let endDay = calendar.date(
        from: DateComponents(year: endParts.year, month: endParts.month, day: endParts.day)),
      let end = calendar.date(byAdding: .day, value: 1, to: endDay)
    else {
      throw RemindersBridgeError.badRequest("unparseable window")
    }
    let incomplete = store.predicateForIncompleteReminders(
      withDueDateStarting: start, ending: end, calendars: nil)
    let completed = store.predicateForCompletedReminders(
      withCompletionDateStarting: start, ending: end, calendars: nil)
    let open = await fetch(incomplete)
    let done = await fetch(completed)
    var seen = Set<String>()
    var merged: [ReminderDTO] = []
    for dto in open + done where !seen.contains(dto.id) {
      seen.insert(dto.id)
      merged.append(dto)
    }
    return merged
  }

  private func find(_ id: String) throws -> EKReminder {
    guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
      throw RemindersBridgeError.notFound(id)
    }
    return reminder
  }

  /// Applies a ReminderWrite (see protocol.ts): a missing key leaves the
  /// field alone, JSON null clears it.
  private func apply(_ changes: [String: Any], to reminder: EKReminder) throws {
    if let title = changes["title"] as? String { reminder.title = title }
    if changes.keys.contains("notes") {
      reminder.notes = changes["notes"] as? String
    }
    if changes.keys.contains("url") {
      reminder.url = (changes["url"] as? String).flatMap { URL(string: $0) }
    }
    if let priority = changes["priority"] as? Int {
      reminder.priority = max(0, min(9, priority))
    } else if let priority = changes["priority"] as? Double {
      reminder.priority = max(0, min(9, Int(priority)))
    }
    if changes.keys.contains("dueDate") || changes.keys.contains("dueTime") {
      let existing = dueStrings(reminder.dueDateComponents)
      let date: String? =
        changes.keys.contains("dueDate") ? (changes["dueDate"] as? String) : existing.date
      let time: String? =
        changes.keys.contains("dueTime") ? (changes["dueTime"] as? String) : existing.time
      if let date {
        guard let components = dueComponents(date: date, time: time) else {
          throw RemindersBridgeError.badRequest("dueDate must be YYYY-MM-DD")
        }
        reminder.dueDateComponents = components
        // Reminders' own app keeps start == due for dated reminders.
        reminder.startDateComponents = components
      } else {
        reminder.dueDateComponents = nil
        reminder.startDateComponents = nil
      }
    }
    if changes.keys.contains("alarms") {
      let absolute = (reminder.alarms ?? []).filter { $0.absoluteDate != nil }
      let offsets = (changes["alarms"] as? [Any])?.compactMap { value -> Int? in
        if let n = value as? Int { return n }
        if let d = value as? Double { return Int(d) }
        return nil
      }
      reminder.alarms =
        absolute + (offsets ?? []).map { EKAlarm(relativeOffset: TimeInterval($0 * 60)) }
    }
    if changes.keys.contains("recurrence") {
      if let spec = changes["recurrence"] as? [String: Any] {
        if spec["unsupported"] as? Bool == true {
          // Never overwrite a rule we couldn't express.
        } else if let freqName = spec["freq"] as? String, let freq = frequency(named: freqName) {
          let interval = max(1, (spec["interval"] as? Int) ?? Int((spec["interval"] as? Double) ?? 1))
          var end: EKRecurrenceEnd? = nil
          if let count = (spec["count"] as? Int) ?? (spec["count"] as? Double).map({ Int($0) }),
            count > 0
          {
            end = EKRecurrenceEnd(occurrenceCount: count)
          } else if let until = spec["untilDate"] as? String, let untilDate = dayFormatter.date(from: until) {
            end = EKRecurrenceEnd(end: untilDate)
          }
          reminder.recurrenceRules = [
            EKRecurrenceRule(recurrenceWith: freq, interval: interval, end: end)
          ]
        } else {
          throw RemindersBridgeError.badRequest("recurrence.freq must be daily|weekly|monthly|yearly")
        }
      } else {
        reminder.recurrenceRules = nil
      }
    }
    if let listId = changes["listId"] as? String {
      guard let calendar = store.calendar(withIdentifier: listId) else {
        throw RemindersBridgeError.notFound("list \(listId)")
      }
      reminder.calendar = calendar
    }
  }

  private func save(_ reminder: EKReminder) throws -> ReminderDTO {
    do {
      try store.save(reminder, commit: true)
    } catch {
      throw RemindersBridgeError.saveFailed(error.localizedDescription)
    }
    return reminderDTO(reminder)
  }

  func create(listId: String, changes: [String: JSONNode]) throws -> ReminderDTO {
    try requireAccess()
    guard let calendar = store.calendar(withIdentifier: listId) else {
      throw RemindersBridgeError.notFound("list \(listId)")
    }
    let reminder = EKReminder(eventStore: store)
    reminder.calendar = calendar
    reminder.title = ""
    var withoutList = changes.mapValues { $0.any }
    withoutList.removeValue(forKey: "listId")
    try apply(withoutList, to: reminder)
    return try save(reminder)
  }

  func update(id: String, changes: [String: JSONNode]) throws -> ReminderDTO {
    try requireAccess()
    let reminder = try find(id)
    try apply(changes.mapValues { $0.any }, to: reminder)
    return try save(reminder)
  }

  func setCompleted(id: String, completed: Bool) throws -> ReminderDTO {
    try requireAccess()
    let reminder = try find(id)
    // EventKit stamps completionDate itself when isCompleted flips.
    reminder.isCompleted = completed
    return try save(reminder)
  }

  func delete(id: String) throws {
    try requireAccess()
    let reminder = try find(id)
    do {
      try store.remove(reminder, commit: true)
    } catch {
      throw RemindersBridgeError.saveFailed(error.localizedDescription)
    }
  }
}

// MARK: - Method dispatch shared by both hosts

enum RemindersDispatch {
  /// `method` is the protocol name ("reminders.list"); `params` the decoded
  /// JSON object. Returns the JSON result object.
  static func invoke(method: String, params: [String: Any]) async throws -> [String: Any] {
    let bridge = RemindersBridge.shared
    switch method {
    case "reminders.status":
      return ["authorization": await bridge.status()]
    case "reminders.requestAccess":
      return ["granted": await bridge.requestAccess()]
    case "reminders.listLists":
      return ["lists": try await bridge.listLists().map { $0.toDictionary() }]
    case "reminders.list":
      guard let start = params["startDate"] as? String, let end = params["endDate"] as? String
      else { throw RemindersBridgeError.badRequest("startDate and endDate required") }
      return ["reminders": try await bridge.list(startDate: start, endDate: end).map { $0.toDictionary() }]
    case "reminders.create":
      guard let listId = params["listId"] as? String else {
        throw RemindersBridgeError.badRequest("listId required")
      }
      let changes = JSONNode.object(params["reminder"] as? [String: Any] ?? [:])
      return ["reminder": try await bridge.create(listId: listId, changes: changes).toDictionary()]
    case "reminders.update":
      guard let id = params["id"] as? String else {
        throw RemindersBridgeError.badRequest("id required")
      }
      let changes = JSONNode.object(params["changes"] as? [String: Any] ?? [:])
      return ["reminder": try await bridge.update(id: id, changes: changes).toDictionary()]
    case "reminders.setCompleted":
      guard let id = params["id"] as? String, let completed = params["completed"] as? Bool else {
        throw RemindersBridgeError.badRequest("id and completed required")
      }
      return ["reminder": try await bridge.setCompleted(id: id, completed: completed).toDictionary()]
    case "reminders.delete":
      guard let id = params["id"] as? String else {
        throw RemindersBridgeError.badRequest("id required")
      }
      try await bridge.delete(id: id)
      return [:]
    default:
      throw RemindersBridgeError.badRequest("unknown reminders method: \(method)")
    }
  }
}
