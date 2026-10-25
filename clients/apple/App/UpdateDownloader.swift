import Foundation
import CryptoKit

/// A newer build from the release catalog. `direct` builds (the Mac DMG) download in the app; App Store and
/// TestFlight builds open `page`. `sources` are tried in order: the CDN mirror, then the Controller on each API origin.
struct ReleaseUpdate:Equatable {
    let version:String
    let build:Int
    let mandatory:Bool
    let page:URL
    let direct:Bool
    let sha256:String
    let size:Int64
    let notes:String
    let sources:[URL]
}

/// Downloads an update with progress, resuming a broken transfer on the same source or the next one (each serves
/// the same immutable file), and keeps it only when its size and SHA-256 match the release catalog.
/// The apps' other clients do the same in the shared core (clients/core/download.go); the Mac app links no core.
final class UpdateDownloader:NSObject,URLSessionDownloadDelegate,@unchecked Sendable {
    struct Progress {var received:Int64;var size:Int64;var seconds:Int}
    enum Failure:Error {case network,digest,storage,cancelled}

    private var session:URLSession!
    private var continuation:CheckedContinuation<URL,Error>?
    private var resumeData:Data?
    private var resumeSource:URL?
    private var task:URLSessionDownloadTask?
    private var cancelled=false
    private let lock=NSLock()
    private var received:Int64=0,lastSample:Int64=0,smoothed=0.0,started=Date()
    private var sampler:Timer?
    private let onProgress:@MainActor (Progress)->Void
    let update:ReleaseUpdate

    init(update:ReleaseUpdate,onProgress:@escaping @MainActor (Progress)->Void) {
        self.update=update;self.onProgress=onProgress
        super.init()
        let configuration=URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest=20
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session=URLSession(configuration:configuration,delegate:self,delegateQueue:nil)
    }

    static func file(for update:ReleaseUpdate)->URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("TrackNothing-update",isDirectory:true).appendingPathComponent("TrackNothing-\(update.version)-\(update.build).dmg")
    }
    /// The verified installer of this build, when an earlier download already finished.
    static func downloaded(_ update:ReleaseUpdate)->URL? {
        let file=file(for:update)
        let size=(try? FileManager.default.attributesOfItem(atPath:file.path)[.size] as? NSNumber)?.int64Value
        return size==update.size ? file:nil
    }

    func cancel() {lock.lock();cancelled=true;lock.unlock();task?.cancel()}

    func run() async throws -> URL {
        let target=Self.file(for:update)
        try? FileManager.default.createDirectory(at:target.deletingLastPathComponent(),withIntermediateDirectories:true)
        if let ready=Self.downloaded(update) {return ready}
        await MainActor.run {startSampler()}
        defer {Task {@MainActor in self.sampler?.invalidate()}}
        var round=0
        while round<3 {
            var index=0
            while index<update.sources.count {
                if isCancelled {throw Failure.cancelled}
                let before=received
                do {
                    let file=try await attempt(update.sources[index])
                    try verify(file)
                    try? FileManager.default.removeItem(at:target)
                    do {try FileManager.default.moveItem(at:file,to:target)} catch {throw Failure.storage}
                    return target
                } catch Failure.digest {
                    // A wrong file: never resumed, and the server's own copy is the last source.
                    resumeData=nil;received=0
                    if index==update.sources.count-1 {throw Failure.digest}
                    index=update.sources.count-1;continue
                } catch Failure.storage {throw Failure.storage
                } catch {
                    if isCancelled {throw Failure.cancelled}
                    // Moving again: stay on this source and do not count the break.
                    if received>before {round=0;continue}
                }
                index+=1
            }
            round+=1
            try? await Task.sleep(nanoseconds:UInt64(round)*2_000_000_000)
        }
        throw Failure.network
    }
    private var isCancelled:Bool {lock.lock();defer {lock.unlock()};return cancelled}

    private func attempt(_ source:URL) async throws -> URL {
        try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<URL,Error>) in
            self.continuation=continuation
            var request=URLRequest(url:source);request.setValue("identity",forHTTPHeaderField:"Accept-Encoding")
            // Resume data only works on the source that produced it; another source starts from the beginning.
            let next:URLSessionDownloadTask
            if let data=resumeData,resumeSource==source {next=session.downloadTask(withResumeData:data)} else {received=0;next=session.downloadTask(with:request)}
            resumeData=nil;resumeSource=source
            task=next;next.resume()
        }
    }
    private func verify(_ file:URL) throws {
        guard let handle=try? FileHandle(forReadingFrom:file) else {throw Failure.storage}
        defer {try? handle.close()}
        var hash=SHA256(),count:Int64=0
        while let chunk=try? handle.read(upToCount:1<<20),!chunk.isEmpty {hash.update(data:chunk);count+=Int64(chunk.count)}
        let digest=hash.finalize().map {String(format:"%02x",$0)}.joined()
        guard count==update.size,digest==update.sha256.lowercased() else {try? FileManager.default.removeItem(at:file);throw Failure.digest}
    }

    @MainActor private func startSampler() {
        started=Date();lastSample=received
        sampler=Timer.scheduledTimer(withTimeInterval:0.5,repeats:true) {[weak self] _ in
            guard let self else {return}
            let now=self.received,instant=Double(max(0,now-self.lastSample))/0.5
            self.lastSample=now
            self.smoothed=self.smoothed==0 ? instant:0.25*instant+0.75*self.smoothed
            let seconds=self.smoothed>=1 && Date().timeIntervalSince(self.started)>=2 ? Int(Double(self.update.size-now)/self.smoothed)+1:-1
            self.onProgress(Progress(received:now,size:self.update.size,seconds:seconds))
        }
    }

    func urlSession(_ session:URLSession,downloadTask:URLSessionDownloadTask,didWriteData bytesWritten:Int64,totalBytesWritten:Int64,totalBytesExpectedToWrite:Int64) {
        received=min(totalBytesWritten,update.size)
    }
    func urlSession(_ session:URLSession,downloadTask:URLSessionDownloadTask,didResumeAtOffset fileOffset:Int64,expectedTotalBytes:Int64) {received=fileOffset}
    func urlSession(_ session:URLSession,downloadTask:URLSessionDownloadTask,didFinishDownloadingTo location:URL) {
        // The system deletes `location` when this returns: keep it beside the target.
        let status=(downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status==200||status==206 else {continuation?.resume(throwing:Failure.network);continuation=nil;return}
        let kept=Self.file(for:update).appendingPathExtension("part")
        try? FileManager.default.removeItem(at:kept)
        do {try FileManager.default.moveItem(at:location,to:kept);continuation?.resume(returning:kept)} catch {continuation?.resume(throwing:Failure.storage)}
        continuation=nil
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?) {
        guard let error else {return}
        resumeData=(error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        if resumeData==nil {received=0}
        continuation?.resume(throwing:error);continuation=nil
    }
}
