// Solunivo OCR bridge: the text in an image, in reading order, over Vision.
//
// ONE source for two native hosts — the macOS helper (SPM executable) and
// the iOS Expo module — each of which symlinks this file into its target.
// The JSON shape is the `TextRecognizer` seam in packages/ai; keep the two
// in step: `ocr.recognizeText` takes `imageBase64` (pasted bytes on the
// desktop) or `uri` (a shared file on iOS) and answers `{ text }`.
//
// Everything runs on-device, through the document recogniser (paragraphs in
// order); both hosts need OS 27.
import Foundation
import Vision

enum OcrBridgeError: Error, Sendable {
  case badRequest(String)
  case failed(String)

  var message: String {
    switch self {
    case .badRequest(let text): return "badRequest: \(text)"
    case .failed(let text): return "failed: \(text)"
    }
  }
}

enum OcrDispatch {
  /// `method` is the protocol name ("ocr.recognizeText"); `params` the
  /// decoded JSON object. Returns the JSON result object.
  static func invoke(method: String, params: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "ocr.recognizeText":
      let data = try imageData(params)
      return ["text": try await recognizeText(in: data)]
    default:
      throw OcrBridgeError.badRequest("unknown ocr method: \(method)")
    }
  }

  private static func imageData(_ params: [String: Any]) throws -> Data {
    if let base64 = params["imageBase64"] as? String {
      guard let data = Data(base64Encoded: base64) else {
        throw OcrBridgeError.badRequest("imageBase64 is not base64")
      }
      return data
    }
    if let uri = params["uri"] as? String {
      guard let url = URL(string: uri), url.isFileURL else {
        throw OcrBridgeError.badRequest("uri must be a file URL")
      }
      do {
        return try Data(contentsOf: url)
      } catch {
        throw OcrBridgeError.failed("could not read the image: \(error.localizedDescription)")
      }
    }
    throw OcrBridgeError.badRequest("imageBase64 or uri required")
  }

  /// Paragraphs top to bottom.
  static func recognizeText(in data: Data) async throws -> String {
    let request = RecognizeDocumentsRequest()
    let observations: [DocumentObservation]
    do {
      observations = try await request.perform(on: data)
    } catch {
      throw OcrBridgeError.failed(error.localizedDescription)
    }
    return observations
      .flatMap { $0.document.paragraphs.map { $0.transcript } }
      .joined(separator: "\n")
  }
}
