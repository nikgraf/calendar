// Solunivo model helper: Foundation Models + SpeechAnalyzer over stdio.
//
// Protocol: newline-delimited JSON, one request per line in, one response
// per line out. {"id","method","params"} -> {"id","result"} | {"id","error"}.
// Methods: status | generateJson {schema,prompt} | prepareSpeech {locale} |
// transcribe {audioBase64,locale} (a recording, read whole: the bench) |
// speech.start {session,locale} / speech.audio {session,pcmBase64} /
// speech.read {session} / speech.cut {session,mark} /
// speech.finish {session} / speech.cancel {session} (one phrase as it is
// said, its words as speech.words events: SpeechBridge.swift, shared with
// the iOS Expo module) | reminders.* (see RemindersBridge.swift,
// shared with the iOS Expo module) | contacts.* (ContactsBridge.swift) |
// geo.* (GeoBridge.swift: MapKit place search, geocoding, map images) |
// calendar.* (AppleCalendarBridge.swift: EventKit calendars and events) |
// capture.watch {on} (CaptureWatch.swift: screen captures under way, as
// capture.started / capture.ended events) | barcode.readQr {imageBase64}
// (BarcodeReader.swift: the QR codes in a camera frame).
// Version 2.
import AVFoundation
import Foundation
import FoundationModels
import Speech

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

/// The protocol's own channel: a copy of stdout taken before anything else
/// runs, after which stdout itself points at stderr (which the app
/// ignores). Frameworks print to stdout — Vision's E5RT runtime does, on a
/// Mac without a Neural Engine — and a stray line there, or half a line
/// glued to a reply, would cost the app that reply.
let protocolOut: FileHandle = {
  let channel = dup(STDOUT_FILENO)
  dup2(STDERR_FILENO, STDOUT_FILENO)
  return FileHandle(fileDescriptor: channel, closeOnDealloc: false)
}()

func emit(_ payload: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  data.append(0x0A)
  // Requests run concurrently; the write is the only shared resource.
  emitLock.lock()
  try? protocolOut.write(contentsOf: data)
  emitLock.unlock()
}

func emitResult(_ id: Int, _ result: Any) {
  emit(["id": id, "result": result])
}

func emitError(_ id: Int, _ message: String) {
  emit(["id": id, "error": message])
}

/// Translates the JSON-schema subset our parsers emit (object / string /
/// number / boolean / string-enum / array) into a DynamicGenerationSchema.
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
    // A capped array stops a chatty answer before it overruns the
    // context; the iOS module honours maxItems too.
    var maximum: Int?
    if case .number(let value) = schema["maxItems"] { maximum = Int(value) }
    return DynamicGenerationSchema(
      arrayOf: try dynamicSchema(name: "\(name)Item", from: items),
      maximumElements: maximum)
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
  switch SystemLanguageModel.default.availability {
  case .available:
    emitResult(id, ["status": "ready"])
  case .unavailable(let reason):
    emitResult(
      id, ["detail": String(describing: reason), "status": "unavailable"])
  @unknown default:
    emitResult(id, ["status": "unavailable"])
  }
}

func handleGenerate(_ id: Int, _ params: [String: JSONValue]) async {
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
}

func handlePrepareSpeech(_ id: Int, _ params: [String: JSONValue]) async {
  let localeId = params["locale"]?.stringValue ?? Locale.current.identifier
  do {
    try await SpeechAssets.prepare(locale: localeId)
    emitResult(id, ["prepared": true])
  } catch let error as SpeechBridgeError {
    emitError(id, HelperError.unavailable(error.message).message)
  } catch {
    emitError(id, "prepare failed: \(error.localizedDescription)")
  }
}

/// The renderer's microphone: 16 kHz mono Int16 little-endian, as
/// desktopSpeech.ts sends it.
let speechAudioFormat = AVAudioFormat(
  commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: false)!

func sessionId(_ params: [String: JSONValue]) -> Int? {
  guard case .number(let value)? = params["session"] else { return nil }
  return Int(value)
}

/// Queued on the stdin reader, in the order the lines came (speech.start,
/// .finish and .cancel alike); answered from a task once its turn ran.
func handleSpeechStart(_ id: Int, _ params: [String: JSONValue]) {
  guard let session = sessionId(params) else {
    emitError(id, HelperError.badRequest("session required").message)
    return
  }
  let localeId = params["locale"]?.stringValue ?? Locale.current.identifier
  let task = SpeechSessions.shared.start(id: session, locale: localeId) { source, text in
    emit(["event": "speech.words", "session": session, "source": source, "text": text])
  }
  Task.detached {
    do {
      emitResult(id, ["sources": try await task.value])
    } catch let error as SpeechBridgeError {
      emitError(id, HelperError.unavailable(error.message).message)
    } catch {
      emitError(id, "speech start failed: \(error.localizedDescription)")
    }
  }
}

/// Runs on the stdin reader, not in a task of its own: the blocks reach
/// the recognisers in the order they were said.
func handleSpeechAudio(_ id: Int, _ params: [String: JSONValue]) {
  guard let session = sessionId(params),
    let base64 = params["pcmBase64"]?.stringValue,
    let data = Data(base64Encoded: base64)
  else {
    emitError(id, HelperError.badRequest("session and pcmBase64 required").message)
    return
  }
  let frames = AVAudioFrameCount(data.count / 2)
  guard frames > 0,
    let buffer = AVAudioPCMBuffer(pcmFormat: speechAudioFormat, frameCapacity: frames),
    let channel = buffer.int16ChannelData?[0]
  else {
    emitResult(id, [:])
    return
  }
  buffer.frameLength = frames
  data.withUnsafeBytes { bytes in
    _ = bytes.copyBytes(to: UnsafeMutableRawBufferPointer(start: channel, count: Int(frames) * 2))
  }
  SpeechSessions.shared.append(id: session, buffer)
  emitResult(id, [:])
}

/// The phrase so far, read while the microphone stays open; `mark` is
/// where its audio ended, for `speech.cut`.
func handleSpeechRead(_ id: Int, _ params: [String: JSONValue]) {
  guard let session = sessionId(params) else {
    emitError(id, HelperError.badRequest("session required").message)
    return
  }
  let task = SpeechSessions.shared.read(id: session)
  Task.detached {
    do {
      guard let read = try await task.value else {
        emitResult(id, SpeechReading(other: nil, segments: []).json)
        return
      }
      var json = read.reading.json
      json["mark"] = Int(read.mark)
      emitResult(id, json)
    } catch {
      emitError(id, "transcription failed: \(error.localizedDescription)")
    }
  }
}

/// The phrase read up to `mark` landed: its audio goes.
func handleSpeechCut(_ id: Int, _ params: [String: JSONValue]) {
  if let session = sessionId(params), case .number(let mark)? = params["mark"] {
    SpeechSessions.shared.cut(id: session, through: AVAudioFramePosition(mark))
  }
  emitResult(id, [:])
}

func handleSpeechFinish(_ id: Int, _ params: [String: JSONValue]) {
  guard let session = sessionId(params) else {
    emitError(id, HelperError.badRequest("session required").message)
    return
  }
  let task = SpeechSessions.shared.finish(id: session)
  Task.detached {
    do {
      let reading = try await task.value ?? SpeechReading(other: nil, segments: [])
      emitResult(id, reading.json)
    } catch {
      emitError(id, "transcription failed: \(error.localizedDescription)")
    }
  }
}

func handleSpeechCancel(_ id: Int, _ params: [String: JSONValue]) {
  guard let session = sessionId(params) else {
    emitResult(id, [:])
    return
  }
  let task = SpeechSessions.shared.cancel(id: session)
  Task.detached {
    _ = await task.result
    emitResult(id, [:])
  }
}

func handleTranscribe(_ id: Int, _ params: [String: JSONValue]) async {
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
          "alternatives": result.alternatives.map { String($0.characters) },
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
}

// Unsolicited lines: {"event": name} with no id. The supervisor routes
// them to subscribers instead of a pending request.
Task.detached {
  await RemindersBridge.shared.observeChanges {
    emit(["event": "reminders.changed"])
  }
  await ContactsBridge.shared.observeChanges {
    emit(["event": "contacts.changed"])
  }
  await AppleCalendarBridge.shared.observeChanges {
    emit(["event": "calendar.changed"])
  }
}

// Concurrent request loop: a slow method (prepareSpeech downloading
// locale assets can take minutes) must not stall a status check or a
// generation queued behind it. Each request runs in its own detached
// task with its own session; responses correlate by id, and emit's lock
// keeps concurrent writes line-atomic. (Detached also matters for a
// second reason: top-level code is MainActor-isolated.)
//
// stdin is read on its own thread and the main thread runs the main run
// loop: EventKit delivers EKEventStoreChanged on the main queue, so a main
// thread blocked in readLine() would never fire the change observer above
// — the change push was silently dead until the real-EventKit e2e asserted
// it. It must be the run loop (which also drains the main queue), not
// dispatchMain(): MKLocalSearchCompleter debounces with run-loop timers
// and never calls back under a bare dispatch main queue. EOF on stdin
// means the supervisor is gone.
let stdinReader = Thread {
  while let line = readLine(strippingNewline: true) {
    handleLine(line)
  }
  exit(0)
}
stdinReader.start()
RunLoop.main.run()

func handleLine(_ line: String) {
  guard !line.isEmpty else { return }
  guard let data = line.data(using: .utf8),
    let request = try? JSONDecoder().decode(Request.self, from: data)
  else {
    emit(["error": "unparseable request", "id": -1])
    return
  }
  let params = request.params ?? [:]
  // Foundation caches the system time zone until it is reset
  // (NSTimeZone.h), and the bridges speak device-local wall clock: the
  // helper outlives a flight, so every request reads the zone afresh.
  NSTimeZone.resetSystemTimeZone()
  // Dictation's steps keep the order their lines came in: queued here,
  // on the reader, not in tasks of their own that may run in any order.
  switch request.method {
  case "speech.audio":
    handleSpeechAudio(request.id, params)
    return
  case "speech.start":
    handleSpeechStart(request.id, params)
    return
  case "speech.read":
    handleSpeechRead(request.id, params)
    return
  case "speech.cut":
    handleSpeechCut(request.id, params)
    return
  case "speech.finish":
    handleSpeechFinish(request.id, params)
    return
  case "speech.cancel":
    handleSpeechCancel(request.id, params)
    return
  default:
    break
  }
  Task.detached {
    switch request.method {
    case "status": handleStatus(request.id)
    case "generateJson": await handleGenerate(request.id, params)
    case "prepareSpeech": await handlePrepareSpeech(request.id, params)
    case "transcribe": await handleTranscribe(request.id, params)
    case "capture.watch":
      do {
        emitResult(request.id, try CaptureWatchDispatch.invoke(params: params))
      } catch let error as HelperError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "capture failed: \(error.localizedDescription)")
      }
    case "barcode.readQr":
      do {
        emitResult(
          request.id, try BarcodeDispatch.invoke(params: params.mapValues { $0.anyValue }))
      } catch let error as HelperError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "barcode failed: \(error.localizedDescription)")
      }
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
    case let method where method.hasPrefix("contacts."):
      do {
        let result = try await ContactsDispatch.invoke(
          method: method, params: params.mapValues { $0.anyValue })
        emitResult(request.id, result)
      } catch let error as ContactsBridgeError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "contacts failed: \(error.localizedDescription)")
      }
    case let method where method.hasPrefix("calendar."):
      do {
        let result = try await AppleCalendarDispatch.invoke(
          method: method, params: params.mapValues { $0.anyValue })
        emitResult(request.id, result)
      } catch let error as AppleCalendarBridgeError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "calendar failed: \(error.localizedDescription)")
      }
    case let method where method.hasPrefix("geo."):
      do {
        let result = try await GeoDispatch.invoke(
          method: method, params: params.mapValues { $0.anyValue })
        emitResult(request.id, result)
      } catch let error as GeoBridgeError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "geo failed: \(error.localizedDescription)")
      }
    case let method where method.hasPrefix("ocr."):
      do {
        let result = try await OcrDispatch.invoke(
          method: method, params: params.mapValues { $0.anyValue })
        emitResult(request.id, result)
      } catch let error as OcrBridgeError {
        emitError(request.id, error.message)
      } catch {
        emitError(request.id, "ocr failed: \(error.localizedDescription)")
      }
    default: emitError(request.id, "unknown method: \(request.method)")
    }
  }
}
