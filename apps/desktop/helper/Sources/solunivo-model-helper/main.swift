// Solunivo model helper: Foundation Models + SpeechAnalyzer over stdio.
//
// Protocol: newline-delimited JSON, one request per line in, one response
// per line out. {"id","method","params"} -> {"id","result"} | {"id","error"}.
// Methods: status | generateJson {schema,prompt} | prepareSpeech {locale} |
// transcribe {audioBase64,locale} | reminders.* (see RemindersBridge.swift,
// shared with the iOS Expo module). Version 2.
import Foundation

#if canImport(FoundationModels)
  import FoundationModels
#endif
#if canImport(Speech)
  import AVFoundation
  import Speech
#endif

struct Request: Decodable, Sendable {
  let id: Int
  let method: String
  let params: [String: JSONValue]?
}

/// Minimal JSON tree — the schema payloads are dynamic by nature.
enum JSONValue: Decodable, Sendable {
  case array([JSONValue])
  case bool(Bool)
  case null
  case number(Double)
  case object([String: JSONValue])
  case string(String)

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }
  var objectValue: [String: JSONValue]? {
    if case .object(let value) = self { return value }
    return nil
  }
  var arrayValue: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }

  /// Foundation-flavoured value (NSNull for null) for code that takes
  /// plain JSON dictionaries — the reminders bridge is shared with the
  /// Expo module, which hands it `[String: Any]`.
  var anyValue: Any {
    switch self {
    case .array(let items): return items.map { $0.anyValue }
    case .bool(let value): return value
    case .null: return NSNull()
    case .number(let value):
      return value.rounded() == value && abs(value) < 1e15 ? Int(value) : value
    case .object(let fields): return fields.mapValues { $0.anyValue }
    case .string(let value): return value
    }
  }
}

let emitLock = NSLock()

func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
    let line = String(data: data, encoding: .utf8)
  else { return }
  // Requests run concurrently; the write is the only shared resource.
  emitLock.lock()
  print(line)
  fflush(stdout)
  emitLock.unlock()
}

func emitResult(_ id: Int, _ result: Any) {
  emit(["id": id, "result": result])
}

func emitError(_ id: Int, _ message: String) {
  emit(["id": id, "error": message])
}

#if canImport(FoundationModels)
  /// Translates the JSON-schema subset our parsers emit (object / string /
  /// number / boolean / string-enum / array) into a DynamicGenerationSchema.
  @available(macOS 26, *)
  func dynamicSchema(name: String, from schema: [String: JSONValue]) throws
    -> DynamicGenerationSchema
  {
    let type = schema["type"]?.stringValue ?? "object"
    if let anyOf = schema["enum"]?.arrayValue {
      return DynamicGenerationSchema(
        name: name, anyOf: anyOf.compactMap { $0.stringValue })
    }
    switch type {
    case "string":
      return DynamicGenerationSchema(type: String.self)
    case "number", "integer":
      return DynamicGenerationSchema(type: Double.self)
    case "boolean":
      return DynamicGenerationSchema(type: Bool.self)
    case "array":
      let items = schema["items"]?.objectValue ?? ["type": .string("string")]
      return DynamicGenerationSchema(
        arrayOf: try dynamicSchema(name: "\(name)Item", from: items))
    case "object":
      let required = Set(
        (schema["required"]?.arrayValue ?? []).compactMap { $0.stringValue })
      let properties = schema["properties"]?.objectValue ?? [:]
      // Sorted for deterministic schemas across runs.
      let props = try properties.sorted { $0.key < $1.key }.map {
        key, value -> DynamicGenerationSchema.Property in
        let child = value.objectValue ?? [:]
        return DynamicGenerationSchema.Property(
          name: key,
          description: child["description"]?.stringValue,
          schema: try dynamicSchema(name: "\(name)_\(key)", from: child),
          isOptional: !required.contains(key)
        )
      }
      return DynamicGenerationSchema(name: name, properties: props)
    default:
      throw HelperError.badRequest("unsupported schema type: \(type)")
    }
  }
#endif

enum HelperError: Error {
  case badRequest(String)
  case unavailable(String)

  var message: String {
    switch self {
    case .badRequest(let text): return "badRequest: \(text)"
    case .unavailable(let text): return "unavailable: \(text)"
    }
  }
}

func handleStatus(_ id: Int) {
  #if canImport(FoundationModels)
    if #available(macOS 26, *) {
      switch SystemLanguageModel.default.availability {
      case .available:
        emitResult(id, ["status": "ready"])
      case .unavailable(let reason):
        emitResult(
          id, ["detail": String(describing: reason), "status": "unavailable"])
      @unknown default:
        emitResult(id, ["status": "unavailable"])
      }
      return
    }
  #endif
  emitResult(id, ["detail": "osTooOld", "status": "unavailable"])
}

func handleGenerate(_ id: Int, _ params: [String: JSONValue]) async {
  #if canImport(FoundationModels)
    if #available(macOS 26, *) {
      guard let prompt = params["prompt"]?.stringValue,
        let schemaJson = params["schema"]?.objectValue
      else {
        emitError(id, HelperError.badRequest("prompt and schema required").message)
        return
      }
      do {
        let root = try dynamicSchema(name: "Root", from: schemaJson)
        let schema = try GenerationSchema(root: root, dependencies: [])
        let session = LanguageModelSession()
        let response = try await session.respond(
          to: prompt, schema: schema,
          options: GenerationOptions(temperature: 0))
        emitResult(id, ["json": response.content.jsonString])
      } catch {
        emitError(id, "generation failed: \(error.localizedDescription)")
      }
      return
    }
  #endif
  emitError(id, HelperError.unavailable("macOS 26 required").message)
}

func handlePrepareSpeech(_ id: Int, _ params: [String: JSONValue]) async {
  #if canImport(Speech)
    if #available(macOS 26, *) {
      let localeId = params["locale"]?.stringValue ?? Locale.current.identifier
      do {
        guard
          let locale = await SpeechTranscriber.supportedLocale(
            equivalentTo: Locale(identifier: localeId))
        else {
          emitError(id, HelperError.unavailable("locale not supported: \(localeId)").message)
          return
        }
        let transcriber = SpeechTranscriber(
          locale: locale, preset: .timeIndexedTranscriptionWithAlternatives)
        let status = await AssetInventory.status(forModules: [transcriber])
        switch status {
        case .installed:
          emitResult(id, ["prepared": true])
        case .supported, .downloading:
          if let request = try? await AssetInventory.assetInstallationRequest(
            supporting: [transcriber])
          {
            try await request.downloadAndInstall()
          }
          emitResult(id, ["prepared": true])
        case .unsupported:
          emitError(id, HelperError.unavailable("assets unsupported for \(localeId)").message)
        @unknown default:
          emitError(id, HelperError.unavailable("unknown asset status").message)
        }
      } catch {
        emitError(id, "prepare failed: \(error.localizedDescription)")
      }
      return
    }
  #endif
  emitError(id, HelperError.unavailable("macOS 26 required").message)
}

func handleTranscribe(_ id: Int, _ params: [String: JSONValue]) async {
  #if canImport(Speech)
    if #available(macOS 26, *) {
      guard let audioBase64 = params["audioBase64"]?.stringValue,
        let audioData = Data(base64Encoded: audioBase64)
      else {
        emitError(id, HelperError.badRequest("audioBase64 required").message)
        return
      }
      let localeId = params["locale"]?.stringValue ?? Locale.current.identifier
      // Bytes → temp file → AVAudioFile, exactly the iOS impl's shape; the
      // file is deleted immediately after analysis.
      let fileURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
      do {
        try audioData.write(to: fileURL)
        defer { try? FileManager.default.removeItem(at: fileURL) }
        let audioFile = try AVAudioFile(forReading: fileURL)
        let transcriber = SpeechTranscriber(
          locale: Locale(identifier: localeId),
          preset: .timeIndexedTranscriptionWithAlternatives)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        // The task owns its accumulator and returns it — no shared capture.
        let collect = Task { () -> [[String: Sendable]] in
          var collected: [[String: Sendable]] = []
          for try await result in transcriber.results where result.isFinal {
            collected.append([
              "endSecond": CMTimeGetSeconds(CMTimeRangeGetEnd(result.range)),
              "startSecond": CMTimeGetSeconds(result.range.start),
              "text": String(result.text.characters),
            ])
          }
          return collected
        }
        let lastSampleTime = try await analyzer.analyzeSequence(from: audioFile)
        if let lastSampleTime {
          try await analyzer.finalizeAndFinish(through: lastSampleTime)
        } else {
          await analyzer.cancelAndFinishNow()
        }
        let segments = (try? await collect.value) ?? []
        emitResult(id, ["segments": segments])
      } catch {
        emitError(id, "transcription failed: \(error.localizedDescription)")
      }
      return
    }
  #endif
  emitError(id, HelperError.unavailable("macOS 26 required").message)
}

// Unsolicited lines: {"event": name} with no id. The supervisor routes
// them to subscribers instead of a pending request.
Task.detached {
  await RemindersBridge.shared.observeChanges {
    emit(["event": "reminders.changed"])
  }
}

// Concurrent request loop: a slow method (prepareSpeech downloading
// locale assets can take minutes) must not stall a status check or a
// generation queued behind it. Each request runs in its own detached
// task with its own session; responses correlate by id, and emit's lock
// keeps concurrent writes line-atomic. (Detached also matters for a
// second reason: top-level code is MainActor-isolated.)
while let line = readLine(strippingNewline: true) {
  guard !line.isEmpty else { continue }
  guard let data = line.data(using: .utf8),
    let request = try? JSONDecoder().decode(Request.self, from: data)
  else {
    emit(["error": "unparseable request", "id": -1])
    continue
  }
  let params = request.params ?? [:]
  Task.detached {
    switch request.method {
    case "status": handleStatus(request.id)
    case "generateJson": await handleGenerate(request.id, params)
    case "prepareSpeech": await handlePrepareSpeech(request.id, params)
    case "transcribe": await handleTranscribe(request.id, params)
    case let method where method.hasPrefix("reminders."):
      do {
        let result = try await RemindersDispatch.invoke(
          method: method, params: params.mapValues { $0.anyValue })
        emitResult(request.id, result)
      } catch let error as RemindersBridgeError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "reminders failed: \(error.localizedDescription)")
      }
    default: emitError(request.id, "unknown method: \(request.method)")
    }
  }
}
