// Solunivo geo bridge: place search, geocoding and map images over MapKit.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module — each of which symlinks this file into its target.
// The JSON shape is the contract in packages/geo/src/protocol.ts; keep the
// three in step.
//
// Everything is on-device and key-free, and nothing here prompts for
// location access (only CLLocationManager does, and it is never used).
// MapKit objects are main-actor bound and not Sendable, so they live in the
// @MainActor `GeoSession` and only DTOs leave it.
import CoreLocation
import Foundation
import MapKit

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

struct PlaceSuggestionDTO: Sendable {
  let title: String
  let subtitle: String?

  var key: String { "\(title)\u{1F}\(subtitle ?? "")" }

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["title": title]
    if let subtitle, !subtitle.isEmpty { out["subtitle"] = subtitle }
    return out
  }
}

struct GeoPlaceDTO: Sendable {
  let lat: Double
  let lng: Double
  let name: String?
  let address: String?

  func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["lat": lat, "lng": lng]
    if let name, !name.isEmpty { out["name"] = name }
    if let address, !address.isEmpty { out["address"] = address }
    return out
  }
}

enum GeoBridgeError: Error, Sendable {
  case badRequest(String)
  case failed(String)

  var message: String {
    switch self {
    case .badRequest(let text): return "badRequest: \(text)"
    case .failed(let text): return "failed: \(text)"
    }
  }
}

// MARK: - The session

@MainActor
final class GeoSession: NSObject, MKLocalSearchCompleterDelegate {
  static let shared = GeoSession()

  private let completer = MKLocalSearchCompleter()
  /// Resumed by the delegate; the rows are read from `completer.results`
  /// afterwards (MKLocalSearchCompletion is not Sendable, so it never rides
  /// the continuation). `false` means a newer query superseded this one.
  private var pending: CheckedContinuation<Bool, Error>?
  /// The last completer rows by title/subtitle, so `resolve` can look up the
  /// exact completion the user picked (MKLocalSearch.Request(completion:)).
  private var latest: [String: MKLocalSearchCompletion] = [:]

  override init() {
    super.init()
    completer.delegate = self
    completer.resultTypes = [.address, .pointOfInterest]
  }

  // MARK: Typeahead

  func search(query: String, limit: Int) async throws -> [PlaceSuggestionDTO] {
    let fragment = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !fragment.isEmpty else { return [] }
    // A newer keystroke supersedes an in-flight query: its caller gets [].
    pending?.resume(returning: false)
    pending = nil
    // Setting the same fragment again fires no delegate callback.
    if completer.queryFragment != fragment || completer.isSearching {
      let current = try await withCheckedThrowingContinuation { continuation in
        pending = continuation
        completer.queryFragment = fragment
      }
      guard current else { return [] }
    }
    let completions = completer.results
    let rows = completions.prefix(limit).map { completion in
      PlaceSuggestionDTO(
        title: completion.title,
        subtitle: completion.subtitle.isEmpty ? nil : completion.subtitle)
    }
    for (row, completion) in zip(rows, completions) {
      latest[row.key] = completion
    }
    return rows
  }

  nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
    MainActor.assumeIsolated {
      pending?.resume(returning: true)
      pending = nil
    }
  }

  nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
    let message = error.localizedDescription
    MainActor.assumeIsolated {
      pending?.resume(throwing: GeoBridgeError.failed(message))
      pending = nil
    }
  }

  // MARK: Geocoding

  /// The first MapKit match for the picked completion, else for the free
  /// text; nil when nothing matched (not an error).
  func resolve(query: String, suggestion: PlaceSuggestionDTO?) async throws -> GeoPlaceDTO? {
    let request: MKLocalSearch.Request
    if let suggestion, let completion = latest[suggestion.key] {
      request = MKLocalSearch.Request(completion: completion)
    } else {
      let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return nil }
      request = MKLocalSearch.Request()
      request.naturalLanguageQuery = text
    }
    request.resultTypes = [.address, .pointOfInterest]
    do {
      let response = try await MKLocalSearch(request: request).start()
      return response.mapItems.first.map(Self.place(from:))
    } catch let error as MKError where error.code == .placemarkNotFound {
      return nil
    } catch {
      throw GeoBridgeError.failed(error.localizedDescription)
    }
  }

  private static func place(from item: MKMapItem) -> GeoPlaceDTO {
    if #available(macOS 26.0, iOS 26.0, *) {
      let coordinate = item.location.coordinate
      return GeoPlaceDTO(
        lat: coordinate.latitude, lng: coordinate.longitude, name: item.name,
        address: item.address?.fullAddress)
    } else {
      let coordinate = item.placemark.coordinate
      return GeoPlaceDTO(
        lat: coordinate.latitude, lng: coordinate.longitude, name: item.name,
        address: item.placemark.title)
    }
  }

  // MARK: Map image

  /// A ~700 m map centered on the coordinate with a pin drawn at the
  /// center, as base64 PNG at width×scale by height×scale pixels.
  func snapshot(
    lat: Double, lng: Double, width: Double, height: Double, scale: Double, dark: Bool
  ) async throws -> String {
    let center = CLLocationCoordinate2D(latitude: lat, longitude: lng)
    guard CLLocationCoordinate2DIsValid(center) else {
      throw GeoBridgeError.badRequest("invalid coordinate")
    }
    let size = CGSize(width: width, height: height)
    let options = MKMapSnapshotter.Options()
    options.region = MKCoordinateRegion(
      center: center, latitudinalMeters: 700, longitudinalMeters: 700)
    options.size = size
    options.pointOfInterestFilter = .includingAll
    #if os(macOS)
      options.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    #else
      options.traitCollection = UITraitCollection(traitsFrom: [
        UITraitCollection(displayScale: scale),
        UITraitCollection(userInterfaceStyle: dark ? .dark : .light),
      ])
    #endif

    let snapshot: MKMapSnapshotter.Snapshot
    do {
      snapshot = try await MKMapSnapshotter(options: options).start()
    } catch {
      throw GeoBridgeError.failed(error.localizedDescription)
    }
    // The region is centered on the coordinate, so the pin sits at the
    // image center — no flipped-coordinate conversion needed per platform.
    let pin = CGPoint(x: width / 2, y: height / 2)
    guard let png = Self.render(snapshot.image, size: size, scale: scale, pin: pin) else {
      throw GeoBridgeError.failed("could not encode the map image")
    }
    return png.base64EncodedString()
  }

  private static let pinRadius: CGFloat = 7
  private static let pinStroke: CGFloat = 3

  #if os(macOS)
    private static func render(_ image: NSImage, size: CGSize, scale: Double, pin: CGPoint) -> Data? {
      guard
        let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale),
          pixelsHigh: Int(size.height * scale), bitsPerSample: 8, samplesPerPixel: 4,
          hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0,
          bitsPerPixel: 0)
      else { return nil }
      // The point size must be set before the context exists: the context
      // derives its points-to-pixels scale from it.
      rep.size = size
      guard let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = context
      image.draw(in: CGRect(origin: .zero, size: size))
      drawPin(at: pin, in: context.cgContext)
      NSGraphicsContext.restoreGraphicsState()
      return rep.representation(using: .png, properties: [:])
    }
  #else
    private static func render(_ image: UIImage, size: CGSize, scale: Double, pin: CGPoint) -> Data? {
      let format = UIGraphicsImageRendererFormat()
      format.scale = scale
      return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
        image.draw(in: CGRect(origin: .zero, size: size))
        drawPin(at: pin, in: context.cgContext)
      }
    }
  #endif

  private static func drawPin(at point: CGPoint, in context: CGContext) {
    let dot = CGRect(
      x: point.x - pinRadius, y: point.y - pinRadius, width: pinRadius * 2, height: pinRadius * 2)
    context.saveGState()
    context.setShadow(
      offset: CGSize(width: 0, height: 0), blur: 4,
      color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.35))
    context.setFillColor(CGColor(red: 0.898, green: 0.282, blue: 0.302, alpha: 1))
    context.fillEllipse(in: dot)
    context.restoreGState()
    context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.setLineWidth(pinStroke)
    context.strokeEllipse(in: dot.insetBy(dx: pinStroke / 2, dy: pinStroke / 2))
  }
}

// MARK: - Dispatch

enum GeoDispatch {
  /// `method` is the protocol name ("geo.search"); `params` the decoded
  /// JSON object. Returns the JSON result object.
  static func invoke(method: String, params: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "geo.search":
      let query = try string(params, "query")
      let limit = min(max(Int(number(params["limit"]) ?? 6), 1), 10)
      let rows = try await GeoSession.shared.search(query: query, limit: limit)
      return ["results": rows.map { $0.toDictionary() }]
    case "geo.resolve":
      let query = try string(params, "query")
      var suggestion: PlaceSuggestionDTO?
      if let raw = params["suggestion"] as? [String: Any], let title = raw["title"] as? String {
        suggestion = PlaceSuggestionDTO(title: title, subtitle: raw["subtitle"] as? String)
      }
      let place = try await GeoSession.shared.resolve(query: query, suggestion: suggestion)
      return ["place": place?.toDictionary() ?? NSNull()]
    case "geo.snapshot":
      guard let lat = number(params["lat"]), let lng = number(params["lng"]),
        let width = number(params["width"]), let height = number(params["height"]),
        width >= 1, height >= 1, width <= 1200, height <= 1200
      else { throw GeoBridgeError.badRequest("snapshot needs lat, lng, width and height") }
      let scale = min(max(number(params["scale"]) ?? 2, 1), 3)
      let dark = (params["appearance"] as? String) == "dark"
      let png = try await GeoSession.shared.snapshot(
        lat: lat, lng: lng, width: width, height: height, scale: scale, dark: dark)
      return ["pngBase64": png]
    default:
      throw GeoBridgeError.badRequest("unknown geo method: \(method)")
    }
  }

  private static func string(_ params: [String: Any], _ key: String) throws -> String {
    guard let value = params[key] as? String else {
      throw GeoBridgeError.badRequest("missing \(key)")
    }
    return value
  }

  /// JSON numbers arrive as Int, Double or NSNumber depending on the host.
  private static func number(_ value: Any?) -> Double? {
    switch value {
    case let value as Double: return value
    case let value as Int: return Double(value)
    case let value as NSNumber: return value.doubleValue
    default: return nil
    }
  }
}
