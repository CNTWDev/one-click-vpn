#if os(macOS)
import AppKit
import SystemExtensions

/// The Mac tunnel is a system extension (the only form allowed outside the Mac App Store). Activating it returns at
/// once when it is installed and current; a newer app replaces the installed copy. The first time, macOS asks the
/// user to allow it in System Settings: activate() then throws SYSTEM_EXTENSION_APPROVAL at once (so the app is not
/// left busy and can say where to allow it), the request stays open, and onReady runs when the user allows it.
@MainActor final class SystemExtension:NSObject,OSSystemExtensionRequestDelegate {
    static let shared=SystemExtension()
    private var waiting:[CheckedContinuation<Void,Error>]=[]
    private var active=false
    /// macOS is waiting for the user to allow the extension in System Settings.
    private(set) var awaitingApproval=false
    /// The extension became ready after the user allowed it (the app then connects).
    var onReady:(()->Void)?
    func activate() async throws {
        if active {return}
        if awaitingApproval {throw AccessFailure.code("SYSTEM_EXTENSION_APPROVAL")}
        try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Void,Error>) in
            waiting.append(continuation)
            guard waiting.count==1 else {return}
            Journal.add("system extension: activating")
            let request=OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier:(Bundle.main.bundleIdentifier ?? "")+".tunnel",queue:.main)
            request.delegate=self
            OSSystemExtensionManager.shared.submitRequest(request)
        }
    }
    private func finish(_ error:Error?) {
        if error==nil {active=true}
        if awaitingApproval {awaitingApproval=false;if error==nil {onReady?()}}
        let pending=waiting;waiting=[]
        for continuation in pending {if let error {continuation.resume(throwing:error)} else {continuation.resume()}}
    }
    nonisolated func request(_ request:OSSystemExtensionRequest,actionForReplacingExtension existing:OSSystemExtensionProperties,withExtension ext:OSSystemExtensionProperties)->OSSystemExtensionRequest.ReplacementAction {.replace}
    nonisolated func requestNeedsUserApproval(_ request:OSSystemExtensionRequest) {
        Task {@MainActor in
            Journal.add("system extension: waiting for approval in System Settings")
            self.awaitingApproval=true
            let pending=self.waiting;self.waiting=[]
            for continuation in pending {continuation.resume(throwing:AccessFailure.code("SYSTEM_EXTENSION_APPROVAL"))}
        }
    }
    nonisolated func request(_ request:OSSystemExtensionRequest,didFinishWithResult result:OSSystemExtensionRequest.Result) {
        Task {@MainActor in Journal.add("system extension: ready");self.finish(nil)}
    }
    nonisolated func request(_ request:OSSystemExtensionRequest,didFailWithError error:Error) {
        let code=(error as? OSSystemExtensionError)?.code
        Task {@MainActor in
            Journal.add("system extension: failed (\((error as NSError).code))")
            // Extensions load only from an app in /Applications, not from the disk image or Downloads.
            self.finish(AccessFailure.code(code == .unsupportedParentBundleLocation ? "MOVE_TO_APPLICATIONS":"SYSTEM_EXTENSION_FAILED"))
        }
    }
    /// Where macOS lists extensions waiting to be allowed: General → Login Items & Extensions from macOS 15, Privacy &
    /// Security before.
    static func openSettings() {
        let page=ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion:15,minorVersion:0,patchVersion:0))
            ? "x-apple.systempreferences:com.apple.LoginItems-Settings.extension":"x-apple.systempreferences:com.apple.preference.security?General"
        if let url=URL(string:page) {NSWorkspace.shared.open(url)}
    }
}
#endif
