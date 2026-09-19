// Solunivo Apple Calendar bridge: EventKit events as plain JSON.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module — each of which symlinks this file into its target.
// The JSON shape is the contract in packages/apple-calendar/src/protocol.ts;
// keep the three in step.
//
// Concurrency: EKEventStore and its items are not Sendable, so every
// touch happens inside the `AppleCalendarBridge` actor and only plain
// DTOs cross its boundary. Request params are parsed into Sendable write
// structs *before* entering the actor (the Reminders bridge uses its
// JSONNode for this; this file stays self-contained so the iOS module,
// a separate Swift module, needs nothing else).
//
// The store is separate from the Reminders bridge's: events are their own
// TCC entity (`requestFullAccessToEvents`), granted independently.
import CoreLocation
import EventKit
import Foundation

// MARK: - DTOs (Sendable, JSON via toDictionary)

struct CalendarDTO: Sendable {
  let allowsModifications: Bool
  let colorHex: String?
  let id: String
  let isDefault: Bool
  let sourceTitle: String
  let sourceType: String
  let title: String
  let type: String

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "allowsModifications": allowsModifications, "id": id, "isDefault": isDefault,
      "sourceTitle": sourceTitle, "sourceType": sourceType, "title": title, "type": type,
    ]
    if let colorHex { out["colorHex"] = colorHex }
    return out
  }
}

struct AttendeeDTO: Sendable {
  let email: String
  let isOrganizer: Bool
  let isSelf: Bool
  let name: String?
  let status: String

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "email": email, "isOrganizer": isOrganizer, "isSelf": isSelf, "status": status,
    ]
    if let name { out["name"] = name }
    return out
  }
}

struct DayOfWeekDTO: Sendable {
  /// 0 = every such weekday; otherwise the week number (-1 = last).
  let ordinal: Int
  /// "MO" … "SU".
  let weekday: String
}

struct RuleDTO: Sendable {
  let byDay: [DayOfWeekDTO]
  let byMonth: [Int]
  let byMonthDay: [Int]
  let bySetPos: [Int]
  let byWeekNo: [Int]
  let byYearDay: [Int]
  let count: Int?
  let freq: String
  let interval: Int
  let untilDate: String?
  let untilUtc: Double?

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["freq": freq, "interval": interval]
    if !byDay.isEmpty {
      out["byDay"] = byDay.map { day -> [String: Any] in
        day.ordinal == 0
          ? ["weekday": day.weekday] : ["ordinal": day.ordinal, "weekday": day.weekday]
      }
    }
    if !byMonth.isEmpty { out["byMonth"] = byMonth }
    if !byMonthDay.isEmpty { out["byMonthDay"] = byMonthDay }
    if !bySetPos.isEmpty { out["bySetPos"] = bySetPos }
    if !byWeekNo.isEmpty { out["byWeekNo"] = byWeekNo }
    if !byYearDay.isEmpty { out["byYearDay"] = byYearDay }
    if let count { out["count"] = count }
    if let untilDate { out["untilDate"] = untilDate }
    if let untilUtc { out["untilUtc"] = untilUtc }
    return out
  }
}

struct EventDTO: Sendable {
  let attendees: [AttendeeDTO]
  let calendarId: String
  let description: String?
  let endDate: String?
  let endUtc: Double
  let geo: (lat: Double, lng: Double, name: String?)?
  let hasRecurrence: Bool
  let id: String
  let isAllDay: Bool
  let isDetached: Bool
  let location: String?
  let occurrenceStartUtc: Double?
  let organizerEmail: String?
  let startDate: String?
  let startUtc: Double
  let status: String
  let timeZone: String?
  let title: String
  let updatedAt: Double
  let url: String?

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "calendarId": calendarId, "endUtc": endUtc, "hasRecurrence": hasRecurrence, "id": id,
      "isAllDay": isAllDay, "isDetached": isDetached, "startUtc": startUtc, "status": status,
      "title": title, "updatedAt": updatedAt,
    ]
    if !attendees.isEmpty { out["attendees"] = attendees.map { $0.toDictionary() } }
    if let description { out["description"] = description }
    if let endDate { out["endDate"] = endDate }
    if let geo {
      var g: [String: Any] = ["lat": geo.lat, "lng": geo.lng]
      if let name = geo.name { g["name"] = name }
      out["geo"] = g
    }
    if let location { out["location"] = location }
    if let occurrenceStartUtc { out["occurrenceStartUtc"] = occurrenceStartUtc }
    if let organizerEmail { out["organizerEmail"] = organizerEmail }
    if let startDate { out["startDate"] = startDate }
    if let timeZone { out["timeZone"] = timeZone }
    if let url { out["url"] = url }
    return out
  }
}

/// A write field: absent leaves it alone, JSON null clears it.
enum Field<Value: Sendable>: Sendable {
  case unchanged
  case clear
  case set(Value)
}

struct GeoWrite: Sendable {
  let lat: Double
  let lng: Double
  let name: String?
}

struct EventWriteDTO: Sendable {
  var description: Field<String> = .unchanged
  var endDate: String?
  var endUtc: Double?
  var geo: Field<GeoWrite> = .unchanged
  var isAllDay: Bool?
  var location: Field<String> = .unchanged
  var recurrence: Field<[RuleDTO]> = .unchanged
  var startDate: String?
  var startUtc: Double?
  var timeZone: Field<String> = .unchanged
  var title: String?
  var url: Field<String> = .unchanged
}

enum AppleCalendarBridgeError: Error, Sendable {
  case accessDenied(String)
  case badRequest(String)
  case notFound(String)
  case saveFailed(String)
  case unsupported(String)

  /// Prefixed so the TS client can map access failures and missing items.
  var message: String {
    switch self {
    case .accessDenied(let status): return "accessDenied: \(status)"
    case .badRequest(let text): return "badRequest: \(text)"
    case .notFound(let text): return "notFound: \(text)"
    case .saveFailed(let text): return "saveFailed: \(text)"
    case .unsupported(let text): return "unsupported: \(text)"
    }
  }
}

// MARK: - Helpers

/// Wire dates are Gregorian whatever the device calendar is set to, in the
/// device zone (see the Reminders bridge for why).
private var gregorian: Calendar {
  var c = Calendar(identifier: .gregorian)
  c.timeZone = TimeZone.current
  return c
}

private func pad2(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }

private func dayString(_ date: Date) -> String {
  let c = gregorian.dateComponents([.year, .month, .day], from: date)
  return "\(c.year ?? 1970)-\(pad2(c.month ?? 1))-\(pad2(c.day ?? 1))"
}

/// Local midnight of a 'YYYY-MM-DD' wire day.
private func dayStart(_ text: String) -> Date? {
  let parts = text.split(separator: "-").compactMap { Int($0) }
  guard parts.count == 3 else { return nil }
  return gregorian.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
}

private func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }
private func date(ms value: Double) -> Date { Date(timeIntervalSince1970: value / 1000) }

/// A JSON number as a finite Double (Int, Double or NSNumber; never a Bool).
private func number(_ value: Any?) -> Double? {
  if value is Bool { return nil }
  if let n = value as? Int { return Double(n) }
  if let d = value as? Double, d.isFinite { return d }
  if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() {
    let d = n.doubleValue
    return d.isFinite ? d : nil
  }
  return nil
}

/// Epoch ms within ±1e15 (~31,000 years): anything else is a bad request,
/// never a trap in a Date or Int conversion.
private func epochMs(_ value: Any?) -> Double? {
  guard let d = number(value), abs(d) <= 1e15 else { return nil }
  return d
}

/// A JSON number as an Int within `range`, or nil (`Int(someDouble)` traps).
private func boundedInt(_ value: Any?, _ range: ClosedRange<Int>) -> Int? {
  guard let d = number(value), d.rounded() == d, let whole = Int(exactly: d),
    range.contains(whole)
  else { return nil }
  return whole
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

private func cgColor(hex: String) -> CGColor? {
  let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
  guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
  return CGColor(
    srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
    blue: CGFloat(value & 0xff) / 255, alpha: 1)
}

private func email(_ url: URL?) -> String? {
  guard let url, url.scheme?.lowercased() == "mailto" else { return nil }
  let address = url.absoluteString.dropFirst("mailto:".count)
  return address.removingPercentEncoding ?? String(address)
}

private let weekdays: [(String, EKWeekday)] = [
  ("SU", .sunday), ("MO", .monday), ("TU", .tuesday), ("WE", .wednesday),
  ("TH", .thursday), ("FR", .friday), ("SA", .saturday),
]

private func weekdayName(_ day: EKWeekday) -> String {
  weekdays.first { $0.1 == day }?.0 ?? "MO"
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

private func ints(_ numbers: [NSNumber]?) -> [Int] { (numbers ?? []).map { $0.intValue } }

private func ruleDTO(_ rule: EKRecurrenceRule, isAllDay: Bool) -> RuleDTO {
  let end = rule.recurrenceEnd
  let count = end.flatMap { $0.occurrenceCount > 0 ? $0.occurrenceCount : nil }
  let endDate = count == nil ? end?.endDate : nil
  return RuleDTO(
    byDay: (rule.daysOfTheWeek ?? []).map {
      DayOfWeekDTO(ordinal: $0.weekNumber, weekday: weekdayName($0.dayOfTheWeek))
    },
    byMonth: ints(rule.monthsOfTheYear), byMonthDay: ints(rule.daysOfTheMonth),
    bySetPos: ints(rule.setPositions), byWeekNo: ints(rule.weeksOfTheYear),
    byYearDay: ints(rule.daysOfTheYear), count: count, freq: frequencyName(rule.frequency),
    interval: rule.interval,
    untilDate: isAllDay ? endDate.map(dayString) : nil,
    untilUtc: isAllDay ? nil : endDate.map(ms))
}

private func ekRule(_ rule: RuleDTO) throws -> EKRecurrenceRule {
  let frequency: EKRecurrenceFrequency
  switch rule.freq {
  case "daily": frequency = .daily
  case "weekly": frequency = .weekly
  case "monthly": frequency = .monthly
  case "yearly": frequency = .yearly
  default: throw AppleCalendarBridgeError.badRequest("freq \(rule.freq)")
  }
  let days = try rule.byDay.map { day -> EKRecurrenceDayOfWeek in
    guard let weekday = weekdays.first(where: { $0.0 == day.weekday })?.1 else {
      throw AppleCalendarBridgeError.badRequest("weekday \(day.weekday)")
    }
    return EKRecurrenceDayOfWeek(weekday, weekNumber: day.ordinal)
  }
  let end: EKRecurrenceEnd?
  if let count = rule.count {
    end = EKRecurrenceEnd(occurrenceCount: count)
  } else if let untilDate = rule.untilDate, let day = dayStart(untilDate) {
    // Inclusive last day: anything starting that day still occurs.
    end = EKRecurrenceEnd(end: gregorian.date(byAdding: DateComponents(day: 1, second: -1), to: day) ?? day)
  } else if let untilUtc = rule.untilUtc {
    end = EKRecurrenceEnd(end: date(ms: untilUtc))
  } else {
    end = nil
  }
  func numbers(_ values: [Int]) -> [NSNumber]? { values.isEmpty ? nil : values.map { NSNumber(value: $0) } }
  return EKRecurrenceRule(
    recurrenceWith: frequency, interval: rule.interval,
    daysOfTheWeek: days.isEmpty ? nil : days, daysOfTheMonth: numbers(rule.byMonthDay),
    monthsOfTheYear: numbers(rule.byMonth), weeksOfTheYear: numbers(rule.byWeekNo),
    daysOfTheYear: numbers(rule.byYearDay), setPositions: numbers(rule.bySetPos), end: end)
}

private func participantStatus(_ status: EKParticipantStatus) -> String {
  switch status {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  default: return "needsAction"
  }
}

private func calendarTypeName(_ type: EKCalendarType) -> String {
  switch type {
  case .birthday: return "birthday"
  case .calDAV: return "calDAV"
  case .exchange: return "exchange"
  case .local: return "local"
  case .subscription: return "subscription"
  @unknown default: return "other"
  }
}

private func sourceTypeName(_ type: EKSourceType?) -> String {
  switch type {
  case .birthdays: return "birthdays"
  case .calDAV: return "calDAV"
  case .exchange: return "exchange"
  case .local: return "local"
  case .mobileMe: return "mobileMe"
  case .subscribed: return "subscribed"
  default: return "other"
  }
}

/// EventKit only matches events inside a four-year span per predicate.
private let chunkDays = 4 * 365

private func eventDTO(_ event: EKEvent) -> EventDTO? {
  guard let id = event.eventIdentifier, let start = event.startDate, let end = event.endDate,
    let calendar = event.calendar
  else { return nil }
  let isAllDay = event.isAllDay
  var startDay: String?
  var endDay: String?
  if isAllDay {
    // EventKit's all-day end is the last day's end (or, from some sources,
    // the next midnight); the protocol's end day is exclusive.
    let lastStart = gregorian.startOfDay(for: end)
    let exclusive =
      (lastStart == end && end > start)
      ? lastStart : (gregorian.date(byAdding: .day, value: 1, to: lastStart) ?? lastStart)
    startDay = dayString(start)
    endDay = dayString(exclusive)
  }
  let repeats = event.hasRecurrenceRules || event.isDetached
  let status: String
  switch event.status {
  case .canceled: status = "cancelled"
  case .tentative: status = "tentative"
  default: status = "confirmed"
  }
  let geo = event.structuredLocation?.geoLocation.map {
    (lat: $0.coordinate.latitude, lng: $0.coordinate.longitude, name: event.structuredLocation?.title)
  }
  let organizer = email(event.organizer?.url)?.lowercased()
  let attendees = (event.attendees ?? []).compactMap { participant -> AttendeeDTO? in
    guard let address = email(participant.url) else { return nil }
    return AttendeeDTO(
      email: address, isOrganizer: address.lowercased() == organizer,
      isSelf: participant.isCurrentUser, name: participant.name,
      status: participantStatus(participant.participantStatus))
  }
  let location = event.location.flatMap { $0.isEmpty ? nil : $0 }
  let notes = event.notes.flatMap { $0.isEmpty ? nil : $0 }
  return EventDTO(
    attendees: attendees, calendarId: calendar.calendarIdentifier, description: notes,
    endDate: endDay, endUtc: ms(end), geo: geo, hasRecurrence: event.hasRecurrenceRules, id: id,
    isAllDay: isAllDay, isDetached: event.isDetached, location: location,
    occurrenceStartUtc: repeats ? event.occurrenceDate.map(ms) : nil,
    organizerEmail: email(event.organizer?.url), startDate: startDay, startUtc: ms(start),
    status: status, timeZone: isAllDay ? nil : event.timeZone?.identifier,
    title: event.title ?? "", updatedAt: ms(event.lastModifiedDate ?? event.creationDate ?? Date()),
    url: event.url?.absoluteString)
}

// MARK: - The actor

actor AppleCalendarBridge {
  static let shared = AppleCalendarBridge()

  private let store = EKEventStore()
  private var changeObserver: NSObjectProtocol?

  /// Calls `handler` whenever EventKit's database changes. The backend
  /// holds no Apple event rows, so this is what repaints the UI after an
  /// edit in Calendar.app; it reaches a live observer only.
  func observeChanges(_ handler: @escaping @Sendable () -> Void) {
    if changeObserver != nil { return }
    changeObserver = NotificationCenter.default.addObserver(
      forName: .EKEventStoreChanged, object: store, queue: nil
    ) { _ in handler() }
  }

  // MARK: Access

  func status() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "fullAccess"
    default:
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
      granted = (try? await store.requestFullAccessToEvents()) ?? false
    } else {
      granted = await withCheckedContinuation { continuation in
        store.requestAccess(to: .event) { ok, _ in continuation.resume(returning: ok) }
      }
    }
    if granted {
      // A store created before the grant can keep answering with no calendars.
      store.reset()
    }
    return granted
  }

  private func requireAccess() throws {
    let current = status()
    guard current == "fullAccess" else { throw AppleCalendarBridgeError.accessDenied(current) }
  }

  // MARK: Calendars

  func listCalendars() throws -> [CalendarDTO] {
    try requireAccess()
    let defaultId = store.defaultCalendarForNewEvents?.calendarIdentifier
    return store.calendars(for: .event).map { calendar in
      CalendarDTO(
        allowsModifications: calendar.allowsContentModifications,
        colorHex: hexColor(calendar.cgColor), id: calendar.calendarIdentifier,
        isDefault: calendar.calendarIdentifier == defaultId,
        sourceTitle: calendar.source?.title ?? "", sourceType: sourceTypeName(calendar.source?.sourceType),
        title: calendar.title, type: calendarTypeName(calendar.type))
    }
  }

  func setColor(calendarId: String, colorHex: String) throws {
    try requireAccess()
    guard let calendar = store.calendar(withIdentifier: calendarId) else {
      throw AppleCalendarBridgeError.notFound("calendar \(calendarId)")
    }
    guard calendar.allowsContentModifications else {
      throw AppleCalendarBridgeError.unsupported("calendar \(calendarId) is read-only")
    }
    guard let color = cgColor(hex: colorHex) else {
      throw AppleCalendarBridgeError.badRequest("color \(colorHex)")
    }
    calendar.cgColor = color
    do {
      try store.saveCalendar(calendar, commit: true)
    } catch {
      throw AppleCalendarBridgeError.saveFailed(error.localizedDescription)
    }
  }

  // MARK: Events

  /// Every event and occurrence overlapping [start, end), all calendars.
  func events(startUtc: Double, endUtc: Double) throws -> [EventDTO] {
    try requireAccess()
    var seen = Set<String>()
    var out: [EventDTO] = []
    var chunkStart = date(ms: startUtc)
    let end = date(ms: endUtc)
    while chunkStart < end {
      let chunkEnd = min(
        gregorian.date(byAdding: .day, value: chunkDays, to: chunkStart) ?? end, end)
      let predicate = store.predicateForEvents(withStart: chunkStart, end: chunkEnd, calendars: nil)
      for event in store.events(matching: predicate) {
        guard let dto = eventDTO(event) else { continue }
        // An event spanning a chunk edge comes back from both chunks.
        let key = "\(dto.id)|\(dto.occurrenceStartUtc ?? dto.startUtc)"
        if seen.insert(key).inserted { out.append(dto) }
      }
      chunkStart = chunkEnd
    }
    return out
  }

  /// The event a ref names: a single event, or one occurrence of a series
  /// found by its slot (`occurrenceDate`). ±31 days: an occurrence moved
  /// on its own can sit weeks away from its slot.
  private func occurrence(id: String, originalStartUtc: Double?) throws -> EKEvent {
    guard let originalStartUtc else {
      guard let event = store.event(withIdentifier: id) else {
        throw AppleCalendarBridgeError.notFound("event \(id)")
      }
      return event
    }
    let slot = date(ms: originalStartUtc)
    let window: TimeInterval = 31 * 24 * 60 * 60
    let predicate = store.predicateForEvents(
      withStart: slot.addingTimeInterval(-window), end: slot.addingTimeInterval(window),
      calendars: nil)
    let match = store.events(matching: predicate).first { event in
      event.eventIdentifier == id
        && abs((event.occurrenceDate ?? event.startDate).timeIntervalSince(slot)) < 1
    }
    guard let match else {
      throw AppleCalendarBridgeError.notFound("occurrence \(id)@\(Int(originalStartUtc))")
    }
    return match
  }

  /// A series as a whole: its first occurrence, its rules, and how many
  /// occurrences in the first four years were changed on their own.
  func series(id: String) throws -> (first: EventDTO, rules: [RuleDTO], detachedCount: Int) {
    try requireAccess()
    guard let event = store.event(withIdentifier: id), let first = eventDTO(event) else {
      throw AppleCalendarBridgeError.notFound("event \(id)")
    }
    guard event.hasRecurrenceRules else { return (first, [], 0) }
    let rules = (event.recurrenceRules ?? []).map { ruleDTO($0, isAllDay: event.isAllDay) }
    let start = event.occurrenceDate ?? event.startDate ?? Date()
    let end = gregorian.date(byAdding: .day, value: chunkDays, to: start) ?? start
    let detached = store.events(
      matching: store.predicateForEvents(withStart: start, end: end, calendars: nil)
    ).filter { $0.eventIdentifier == id && $0.isDetached }.count
    return (first, rules, detached)
  }

  /// Applies a write: absent fields stay, cleared ones go (see protocol.ts).
  private func apply(_ write: EventWriteDTO, to event: EKEvent) throws {
    if let title = write.title { event.title = title }
    if let isAllDay = write.isAllDay { event.isAllDay = isAllDay }
    if event.isAllDay {
      if let startDate = write.startDate {
        guard let day = dayStart(startDate) else {
          throw AppleCalendarBridgeError.badRequest("startDate \(startDate)")
        }
        event.startDate = day
      }
      if let endDate = write.endDate {
        guard let exclusive = dayStart(endDate) else {
          throw AppleCalendarBridgeError.badRequest("endDate \(endDate)")
        }
        // EventKit's all-day end is inclusive: the last day's end.
        event.endDate = exclusive.addingTimeInterval(-1)
      }
    } else {
      if let startUtc = write.startUtc { event.startDate = date(ms: startUtc) }
      if let endUtc = write.endUtc { event.endDate = date(ms: endUtc) }
    }
    switch write.timeZone {
    case .unchanged: break
    case .clear: event.timeZone = nil
    case .set(let identifier):
      guard let zone = TimeZone(identifier: identifier) else {
        throw AppleCalendarBridgeError.badRequest("timeZone \(identifier)")
      }
      event.timeZone = zone
    }
    // Coordinates first: assigning a structured location can rewrite the
    // location text, which is then set explicitly below.
    let previousLocation = event.location
    switch write.geo {
    case .unchanged: break
    case .clear: event.structuredLocation = nil
    case .set(let geo):
      let place = EKStructuredLocation(title: geo.name ?? previousLocation ?? "")
      place.geoLocation = CLLocation(latitude: geo.lat, longitude: geo.lng)
      event.structuredLocation = place
    }
    switch write.location {
    case .unchanged:
      if case .set = write.geo { event.location = previousLocation }
    case .clear:
      event.structuredLocation = nil
      event.location = nil
    case .set(let text):
      // A new place name without new coordinates: the stored ones are stale.
      if case .unchanged = write.geo, text != previousLocation { event.structuredLocation = nil }
      event.location = text
    }
    switch write.description {
    case .unchanged: break
    case .clear: event.notes = nil
    case .set(let text): event.notes = text
    }
    switch write.url {
    case .unchanged: break
    case .clear: event.url = nil
    case .set(let text): event.url = URL(string: text)
    }
    switch write.recurrence {
    case .unchanged: break
    case .clear: event.recurrenceRules = nil
    case .set(let rules): event.recurrenceRules = try rules.map(ekRule)
    }
  }

  private func save(_ event: EKEvent, span: EKSpan) throws {
    do {
      try store.save(event, span: span, commit: true)
    } catch {
      throw AppleCalendarBridgeError.saveFailed(error.localizedDescription)
    }
  }

  func create(calendarId: String, write: EventWriteDTO) throws -> EventDTO {
    try requireAccess()
    guard let calendar = store.calendar(withIdentifier: calendarId) else {
      throw AppleCalendarBridgeError.notFound("calendar \(calendarId)")
    }
    let event = EKEvent(eventStore: store)
    event.calendar = calendar
    event.timeZone = TimeZone.current
    try apply(write, to: event)
    try save(event, span: .thisEvent)
    guard let dto = eventDTO(event) else {
      throw AppleCalendarBridgeError.saveFailed("saved event has no identifier")
    }
    return dto
  }

  func update(id: String, originalStartUtc: Double?, span: EKSpan, write: EventWriteDTO) throws -> EventDTO {
    try requireAccess()
    let event = try occurrence(id: id, originalStartUtc: originalStartUtc)
    try apply(write, to: event)
    try save(event, span: span)
    guard let dto = eventDTO(event) else {
      throw AppleCalendarBridgeError.saveFailed("saved event has no identifier")
    }
    return dto
  }

  func delete(id: String, originalStartUtc: Double?, span: EKSpan) throws {
    try requireAccess()
    let event = try occurrence(id: id, originalStartUtc: originalStartUtc)
    do {
      try store.remove(event, span: span, commit: true)
    } catch {
      throw AppleCalendarBridgeError.saveFailed(error.localizedDescription)
    }
  }

  /// Moves a single event, or a whole series (with its detached
  /// occurrences), to another calendar of this store.
  func move(id: String, calendarId: String) throws -> EventDTO {
    try requireAccess()
    guard let event = store.event(withIdentifier: id) else {
      throw AppleCalendarBridgeError.notFound("event \(id)")
    }
    guard let target = store.calendar(withIdentifier: calendarId) else {
      throw AppleCalendarBridgeError.notFound("calendar \(calendarId)")
    }
    guard target.allowsContentModifications else {
      throw AppleCalendarBridgeError.saveFailed("calendar \(calendarId) is read-only")
    }
    event.calendar = target
    try save(event, span: event.hasRecurrenceRules ? .futureEvents : .thisEvent)
    guard let dto = eventDTO(event) else {
      throw AppleCalendarBridgeError.saveFailed("moved event has no identifier")
    }
    return dto
  }
}

// MARK: - Method dispatch shared by both hosts

enum AppleCalendarDispatch {
  private static func text(_ params: [String: Any], _ key: String) throws -> String {
    guard let value = params[key] as? String, !value.isEmpty else {
      throw AppleCalendarBridgeError.badRequest("\(key) required")
    }
    return value
  }

  private static func field<Value>(
    _ params: [String: Any], _ key: String, _ parse: (Any) -> Value?
  ) throws -> Field<Value> {
    guard params.keys.contains(key), let raw = params[key] else { return .unchanged }
    if raw is NSNull { return .clear }
    guard let value = parse(raw) else { throw AppleCalendarBridgeError.badRequest(key) }
    return .set(value)
  }

  private static func rule(_ raw: Any) -> RuleDTO? {
    guard let fields = raw as? [String: Any], let freq = fields["freq"] as? String,
      let interval = boundedInt(fields["interval"], 1...999)
    else { return nil }
    func list(_ key: String, _ range: ClosedRange<Int>) -> [Int]? {
      guard let raw = fields[key] else { return [] }
      guard let items = raw as? [Any] else { return nil }
      let values = items.compactMap { boundedInt($0, range) }
      return values.count == items.count ? values : nil
    }
    var byDay: [DayOfWeekDTO] = []
    if let days = fields["byDay"] as? [Any] {
      for item in days {
        guard let day = item as? [String: Any], let weekday = day["weekday"] as? String else {
          return nil
        }
        let ordinal = day["ordinal"].map { boundedInt($0, -53...53) } ?? 0
        guard let ordinal else { return nil }
        byDay.append(DayOfWeekDTO(ordinal: ordinal, weekday: weekday))
      }
    }
    guard let byMonth = list("byMonth", 1...12), let byMonthDay = list("byMonthDay", -31...31),
      let bySetPos = list("bySetPos", -366...366), let byWeekNo = list("byWeekNo", -53...53),
      let byYearDay = list("byYearDay", -366...366)
    else { return nil }
    let count = fields["count"].flatMap { boundedInt($0, 1...9999) }
    if fields["count"] != nil && count == nil { return nil }
    let untilUtc = fields["untilUtc"].flatMap(epochMs)
    if fields["untilUtc"] != nil && untilUtc == nil { return nil }
    return RuleDTO(
      byDay: byDay, byMonth: byMonth, byMonthDay: byMonthDay, bySetPos: bySetPos,
      byWeekNo: byWeekNo, byYearDay: byYearDay, count: count, freq: freq, interval: interval,
      untilDate: fields["untilDate"] as? String, untilUtc: untilUtc)
  }

  private static func write(_ raw: Any?) throws -> EventWriteDTO {
    let params = raw as? [String: Any] ?? [:]
    var write = EventWriteDTO()
    write.title = params["title"] as? String
    write.isAllDay = params["isAllDay"] as? Bool
    write.startDate = params["startDate"] as? String
    write.endDate = params["endDate"] as? String
    for (key, target) in [("startUtc", \EventWriteDTO.startUtc), ("endUtc", \EventWriteDTO.endUtc)] {
      guard let value = params[key], !(value is NSNull) else { continue }
      guard let parsed = epochMs(value) else { throw AppleCalendarBridgeError.badRequest(key) }
      write[keyPath: target] = parsed
    }
    write.description = try field(params, "description") { $0 as? String }
    write.location = try field(params, "location") { $0 as? String }
    write.url = try field(params, "url") { $0 as? String }
    write.timeZone = try field(params, "timeZone") { $0 as? String }
    write.geo = try field(params, "geo") { raw in
      guard let geo = raw as? [String: Any], let lat = number(geo["lat"]),
        let lng = number(geo["lng"]), abs(lat) <= 90, abs(lng) <= 180
      else { return nil }
      return GeoWrite(lat: lat, lng: lng, name: geo["name"] as? String)
    }
    write.recurrence = try field(params, "recurrence") { raw in
      guard let items = raw as? [Any] else { return nil }
      let rules = items.compactMap(rule)
      return rules.count == items.count ? rules : nil
    }
    return write
  }

  private static func span(_ params: [String: Any]) throws -> EKSpan {
    switch params["span"] as? String {
    case "thisEvent": return .thisEvent
    case "futureEvents": return .futureEvents
    default: throw AppleCalendarBridgeError.badRequest("span required")
    }
  }

  private static func originalStart(_ params: [String: Any]) throws -> Double? {
    guard let raw = params["originalStartUtc"], !(raw is NSNull) else { return nil }
    guard let value = epochMs(raw) else {
      throw AppleCalendarBridgeError.badRequest("originalStartUtc")
    }
    return value
  }

  /// `method` is the protocol name ("calendar.events"); `params` the
  /// decoded JSON object. Returns the JSON result object.
  static func invoke(method: String, params: [String: Any]) async throws -> [String: Any] {
    let bridge = AppleCalendarBridge.shared
    switch method {
    case "calendar.status":
      return ["authorization": await bridge.status()]
    case "calendar.requestAccess":
      return ["granted": await bridge.requestAccess()]
    case "calendar.listCalendars":
      return ["calendars": try await bridge.listCalendars().map { $0.toDictionary() }]
    case "calendar.events":
      guard let start = epochMs(params["startUtc"]), let end = epochMs(params["endUtc"]),
        start < end
      else { throw AppleCalendarBridgeError.badRequest("startUtc < endUtc required") }
      let events = try await bridge.events(startUtc: start, endUtc: end)
      return ["events": events.map { $0.toDictionary() }]
    case "calendar.series":
      let result = try await bridge.series(id: try text(params, "id"))
      return [
        "detachedCount": result.detachedCount, "first": result.first.toDictionary(),
        "rules": result.rules.map { $0.toDictionary() },
      ]
    case "calendar.create":
      let event = try await bridge.create(
        calendarId: try text(params, "calendarId"), write: try write(params["event"]))
      return ["event": event.toDictionary()]
    case "calendar.update":
      let event = try await bridge.update(
        id: try text(params, "id"), originalStartUtc: try originalStart(params),
        span: try span(params), write: try write(params["changes"]))
      return ["event": event.toDictionary()]
    case "calendar.delete":
      try await bridge.delete(
        id: try text(params, "id"), originalStartUtc: try originalStart(params),
        span: try span(params))
      return [:]
    case "calendar.move":
      let event = try await bridge.move(
        id: try text(params, "id"), calendarId: try text(params, "calendarId"))
      return ["event": event.toDictionary()]
    case "calendar.setColor":
      try await bridge.setColor(
        calendarId: try text(params, "calendarId"), colorHex: try text(params, "colorHex"))
      return [:]
    default:
      throw AppleCalendarBridgeError.badRequest("unknown calendar method: \(method)")
    }
  }
}
