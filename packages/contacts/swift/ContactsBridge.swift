// Solunivo Contacts bridge: the device address book as plain JSON.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module — each of which symlinks this file into its target.
// The JSON shape is the contract in packages/contacts/src/protocol.ts;
// keep the three in step.
//
// Read-only and minimal on purpose: names and email addresses are all
// the invitee typeahead needs. CNContactStore is not Sendable, so every
// touch happens inside the `ContactsBridge` actor and only DTOs leave.
import Contacts
import Foundation

struct DeviceContactDTO: Sendable {
  let contactId: String
  let displayName: String?
  let email: String

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["contactId": contactId, "email": email]
    if let displayName { out["displayName"] = displayName }
    return out
  }
}

enum ContactsBridgeError: Error, Sendable {
  case accessDenied(String)
  case badRequest(String)
  case fetchFailed(String)

  /// Prefixed so the TS client can map access failures to a typed error.
  var message: String {
    switch self {
    case .accessDenied(let status): return "accessDenied: \(status)"
    case .badRequest(let text): return "badRequest: \(text)"
    case .fetchFailed(let text): return "fetchFailed: \(text)"
    }
  }
}

// MARK: - The actor

actor ContactsBridge {
  static let shared = ContactsBridge()

  private let store = CNContactStore()
  private var changeObserver: NSObjectProtocol?

  /// Calls `handler` whenever the address book changes (any app). A hint
  /// to refetch the snapshot; it reaches a live observer only.
  func observeChanges(_ handler: @escaping @Sendable () -> Void) {
    if changeObserver != nil { return }
    changeObserver = NotificationCenter.default.addObserver(
      forName: .CNContactStoreDidChange, object: nil, queue: nil
    ) { _ in handler() }
  }

  // MARK: Access

  func status() -> String {
    let status = CNContactStore.authorizationStatus(for: .contacts)
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    default:
      // iOS 18 added partial access; a subset is still an address book.
      #if os(iOS)
        if #available(iOS 18, *), status == .limited { return "limited" }
      #endif
      return "unavailable"
    }
  }

  func requestAccess() async -> Bool {
    let granted = await withCheckedContinuation { continuation in
      store.requestAccess(for: .contacts) { ok, _ in continuation.resume(returning: ok) }
    }
    return granted
  }

  private func requireAccess() throws {
    let current = status()
    guard current == "authorized" || current == "limited" else {
      throw ContactsBridgeError.accessDenied(current)
    }
  }

  // MARK: Snapshot

  /// Every contact with at least one email address, one DTO per address.
  /// Display name is the formatted full name, falling back to the
  /// organization (a company card has no person name).
  func snapshot() throws -> [DeviceContactDTO] {
    try requireAccess()
    let keys: [CNKeyDescriptor] = [
      CNContactEmailAddressesKey as CNKeyDescriptor,
      CNContactOrganizationNameKey as CNKeyDescriptor,
      CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    ]
    let request = CNContactFetchRequest(keysToFetch: keys)
    request.unifyResults = true
    var out: [DeviceContactDTO] = []
    do {
      try store.enumerateContacts(with: request) { contact, _ in
        let fullName = CNContactFormatter.string(from: contact, style: .fullName)?
          .trimmingCharacters(in: .whitespaces)
        let organization = contact.organizationName.trimmingCharacters(in: .whitespaces)
        let name = (fullName?.isEmpty == false) ? fullName : (organization.isEmpty ? nil : organization)
        for entry in contact.emailAddresses {
          let email = (entry.value as String).trimmingCharacters(in: .whitespacesAndNewlines)
          if email.isEmpty { continue }
          out.append(
            DeviceContactDTO(contactId: contact.identifier, displayName: name, email: email))
        }
      }
    } catch {
      throw ContactsBridgeError.fetchFailed(error.localizedDescription)
    }
    return out
  }
}

// MARK: - Method dispatch shared by both hosts

enum ContactsDispatch {
  /// `method` is the protocol name ("contacts.snapshot"); `params` the
  /// decoded JSON object (unused today). Returns the JSON result object.
  static func invoke(method: String, params: [String: Any]) async throws -> [String: Any] {
    let bridge = ContactsBridge.shared
    switch method {
    case "contacts.status":
      return ["authorization": await bridge.status()]
    case "contacts.requestAccess":
      return ["granted": await bridge.requestAccess()]
    case "contacts.snapshot":
      return ["contacts": try await bridge.snapshot().map { $0.toDictionary() }]
    default:
      throw ContactsBridgeError.badRequest("unknown contacts method: \(method)")
    }
  }
}
