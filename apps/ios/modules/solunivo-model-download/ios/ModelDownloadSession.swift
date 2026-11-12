import Foundation
import Network
import os

private let logger = Logger(subsystem: "com.solunivo.app", category: "ModelDownload")

/// One large file (the Assistant's model) fetched by iOS in a background
/// `URLSession`, so the transfer goes on while the app is suspended and
/// outlives the app being quit.
///
/// Two sessions, because what a transfer may use is a property of the
/// session it runs in: `wifi` neither takes an expensive network (mobile
/// data, a hotspot) nor a constrained one (Low Data Mode), and iOS holds
/// the transfer until such a network is there; `any` takes whatever is
/// there, after the person said so. Moving a transfer from one to the
/// other keeps what it fetched (resume data).
///
/// A task carries its job in `taskDescription` (the URL, where the file
/// goes, which network), which iOS keeps with a background task across
/// launches: a transfer that finishes while the app is not running is
/// still moved into place by the delegate of the next launch.
///
/// All state is confined to `queue`, a serial operation queue that is also
/// the sessions' delegate queue, hence `@unchecked Sendable`.
final class ModelDownloadSession: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  static let shared = ModelDownloadSession()

  enum Route: String, Codable {
    case any
    case wifi
  }

  struct Job: Codable {
    let destination: String
    let network: Route
    /// Started from resume data: a refusal then means its link went stale.
    let resumed: Bool
    let url: String
  }

  typealias Emit = @Sendable (String, [String: Any]) -> Void

  private let queue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "com.solunivo.model-download"
    return queue
  }()
  private var sessions: [Route: URLSession] = [:]
  private var completionHandlers: [String: () -> Void] = [:]
  /// Where a finished task's file could not go, by task, for its completion.
  private var failures: [Int: String] = [:]
  private var lastProgress = Date.distantPast
  private var emit: Emit?
  private var monitor: NWPathMonitor?
  private var latestPath: [String: Bool] = ["constrained": false, "expensive": false, "satisfied": false]

  private static let progressInterval: TimeInterval = 0.5

  // MARK: - Sessions

  static func identifier(_ network: Route) -> String {
    "\(Bundle.main.bundleIdentifier ?? "com.solunivo.app").model-download.\(network.rawValue)"
  }

  /// Called on `queue`.
  private func session(_ network: Route) -> URLSession {
    if let session = sessions[network] {
      return session
    }
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier(network))
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.allowsExpensiveNetworkAccess = network == .any
    configuration.allowsConstrainedNetworkAccess = network == .any
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    sessions[network] = session
    return session
  }

  private func run(_ work: @escaping @Sendable () -> Void) {
    queue.addOperation(work)
  }

  /// The JS side, when the module is created or goes away.
  func attach(_ emit: Emit?) {
    run {
      self.emit = emit
      if emit != nil {
        // Both sessions exist again, so a transfer of an earlier launch reports to this one.
        _ = self.session(.wifi)
        _ = self.session(.any)
        self.startMonitor()
      } else {
        self.monitor?.cancel()
        self.monitor = nil
      }
    }
  }

  // MARK: - Background events

  func handleEvents(for identifier: String, completion: @escaping () -> Void) -> Bool {
    guard let network = [Route.wifi, .any].first(where: { Self.identifier($0) == identifier }) else {
      return false
    }
    run {
      self.completionHandlers[identifier] = completion
      _ = self.session(network)
    }
    return true
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier,
      let completion = completionHandlers.removeValue(forKey: identifier)
    else {
      return
    }
    DispatchQueue.main.async(execute: completion)
  }

  // MARK: - Commands

  /// Starts the job unless a transfer is running already; from its resume data where there is some.
  func start(url: String, destination: String, network: Route, done: @escaping @Sendable ([String: Any]) -> Void) {
    allTasks { tasks in
      if let running = tasks.first {
        done(["started": false, "network": running.network.rawValue])
        return
      }
      self.begin(url: url, destination: destination, network: network, allowResume: true)
      done(["started": true, "network": network.rawValue])
    }
  }

  /// Moves a running transfer to the other session, keeping what it fetched.
  func use(network: Route, done: @escaping @Sendable (Bool) -> Void) {
    allTasks { tasks in
      guard let running = tasks.first, running.network != network, let job = running.job else {
        done(false)
        return
      }
      guard let download = running.task as? URLSessionDownloadTask else {
        done(false)
        return
      }
      download.cancel(byProducingResumeData: { data in
        self.run {
          if let data {
            self.writeResume(data, for: job.destination)
          }
          self.begin(url: job.url, destination: job.destination, network: network, allowResume: true)
          done(true)
        }
      })
    }
  }

  func cancel(destination: String, done: @escaping @Sendable () -> Void) {
    allTasks { tasks in
      for running in tasks {
        running.task.cancel()
      }
      try? FileManager.default.removeItem(at: Self.resumeURL(for: destination))
      done()
    }
  }

  /// The transfer under way, if any: what it fetched, what it expects, its network.
  func current(done: @escaping @Sendable ([String: Any]) -> Void) {
    allTasks { tasks in
      guard let running = tasks.first else {
        done(["state": "none"])
        return
      }
      done([
        "expected": running.task.countOfBytesExpectedToReceive,
        "network": running.network.rawValue,
        "received": running.task.countOfBytesReceived,
        "state": running.task.state == .suspended ? "suspended" : "running",
      ])
    }
  }

  /// The latest reading of the network. Called from JS, never on `queue`.
  func path() -> [String: Bool] {
    var reading: [String: Bool] = [:]
    let read = BlockOperation { reading = self.latestPath }
    queue.addOperations([read], waitUntilFinished: true)
    return reading
  }

  // MARK: - Internals (on `queue`)

  private struct Running {
    let job: Job?
    let network: Route
    let task: URLSessionTask
  }

  private func allTasks(_ then: @escaping @Sendable ([Running]) -> Void) {
    run {
      let group = DispatchGroup()
      var found: [Running] = []
      let lock = NSLock()
      for network in [Route.wifi, .any] {
        group.enter()
        self.session(network).getAllTasks { tasks in
          lock.lock()
          found += tasks
            .filter { $0.state == .running || $0.state == .suspended }
            .map { Running(job: Self.job(of: $0), network: network, task: $0) }
          lock.unlock()
          group.leave()
        }
      }
      group.notify(queue: .global()) {
        self.run { then(found) }
      }
    }
  }

  private func begin(url: String, destination: String, network: Route, allowResume: Bool) {
    guard let remote = URL(string: url) else {
      emit?("onFail", ["message": "not a URL: \(url)", "status": 0])
      return
    }
    let resumeURL = Self.resumeURL(for: destination)
    let session = session(network)
    let task: URLSessionDownloadTask
    var resumed = false
    if allowResume, let data = try? Data(contentsOf: resumeURL) {
      task = session.downloadTask(withResumeData: data)
      resumed = true
    } else {
      task = session.downloadTask(with: URLRequest(url: remote))
    }
    try? FileManager.default.removeItem(at: resumeURL)
    let job = Job(destination: destination, network: network, resumed: resumed, url: url)
    task.taskDescription = (try? JSONEncoder().encode(job)).flatMap { String(data: $0, encoding: .utf8) }
    task.resume()
    logger.info("started (\(network.rawValue, privacy: .public), resumed \(resumed))")
  }

  private static func job(of task: URLSessionTask) -> Job? {
    task.taskDescription.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(Job.self, from: $0) }
  }

  private static func fileURL(_ path: String) -> URL {
    if let url = URL(string: path), url.isFileURL {
      return url
    }
    return URL(fileURLWithPath: path)
  }

  private static func resumeURL(for destination: String) -> URL {
    fileURL(destination).appendingPathExtension("resume")
  }

  private func writeResume(_ data: Data, for destination: String) {
    try? data.write(to: Self.resumeURL(for: destination), options: .atomic)
  }

  // MARK: - URLSessionDownloadDelegate (on `queue`)

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    let now = Date()
    guard now.timeIntervalSince(lastProgress) >= Self.progressInterval else {
      return
    }
    lastProgress = now
    emit?("onProgress", ["expected": totalBytesExpectedToWrite, "received": totalBytesWritten])
  }

  /// The file must leave `location` before this returns: iOS deletes it then.
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status), let job = Self.job(of: downloadTask) else {
      failures[downloadTask.taskIdentifier] = "HTTP \(status)"
      return
    }
    let destination = Self.fileURL(job.destination)
    do {
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.moveItem(at: location, to: destination)
      try? FileManager.default.removeItem(at: Self.resumeURL(for: job.destination))
    } catch {
      failures[downloadTask.taskIdentifier] = "the file could not be kept: \(error.localizedDescription)"
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
    let job = Self.job(of: task)
    if let error = error as NSError? {
      if let data = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data, let job {
        writeResume(data, for: job.destination)
      }
      // A transfer cancelled to move it, or by the app, is no failure.
      if error.code == NSURLErrorCancelled {
        return
      }
      emit?("onFail", ["message": error.localizedDescription, "status": status])
      return
    }
    if let failure = failures.removeValue(forKey: task.taskIdentifier) {
      // GitHub's signed download link expires: a resumed transfer refused for it starts over.
      if let job, job.resumed, status == 403 || status == 410 {
        begin(url: job.url, destination: job.destination, network: job.network, allowResume: false)
        return
      }
      emit?("onFail", ["message": failure, "status": status])
      return
    }
    if let job {
      emit?("onFinish", ["path": job.destination])
    }
  }

  // MARK: - The network

  private func startMonitor() {
    guard monitor == nil else {
      return
    }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      let reading = [
        "constrained": path.isConstrained,
        "expensive": path.isExpensive,
        "satisfied": path.status == .satisfied,
      ]
      self?.run {
        self?.latestPath = reading
        self?.emit?("onPath", reading)
      }
    }
    monitor.start(queue: DispatchQueue(label: "com.solunivo.model-download.path"))
    self.monitor = monitor
  }
}
