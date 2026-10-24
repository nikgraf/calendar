// The QR codes in a camera frame, over Vision: the Mac's side of the
// settings code. Electron's Chromium ships without the shape-detection
// service, so the renderer's `BarcodeDetector` does not exist; the
// renderer sends a JPEG of the FaceTime camera's frame instead, a few
// times a second while the reader is open. Helper-only: the iPhone scans
// with expo-camera, which has its own reader.
//
// `barcode.readQr` takes `imageBase64` and answers `{ codes: [String] }`,
// every QR payload Vision found in the frame (usually none or one). The
// classic request runs from macOS 10.13, so nothing here needs a guard on
// the helper's macOS 14 floor.
import Foundation
import Vision

enum BarcodeDispatch {
  static func invoke(params: [String: Any]) throws -> [String: Any] {
    guard let base64 = params["imageBase64"] as? String else {
      throw HelperError.badRequest("imageBase64 required")
    }
    guard let data = Data(base64Encoded: base64) else {
      throw HelperError.badRequest("imageBase64 is not base64")
    }
    return ["codes": try readQr(in: data)]
  }

  static func readQr(in data: Data) throws -> [String] {
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    let handler = VNImageRequestHandler(data: data, options: [:])
    do {
      try handler.perform([request])
    } catch {
      throw HelperError.unavailable("barcode detection failed: \(error.localizedDescription)")
    }
    return (request.results ?? []).compactMap { $0.payloadStringValue }
  }
}
