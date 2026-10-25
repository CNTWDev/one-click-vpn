#if os(macOS)
import Foundation
import SystemExtensions

/// The Mac tunnel is a system extension (the only form allowed outside the Mac App Store). Activating it returns at
/// once when it is installed and current. The first time, macOS asks the user to allow it in System Settings →
/// Privacy & Security and activate() waits for that; a newer app replaces the installed copy.
@MainActor final class SystemExtension:NSObject,OSSystemExtensionRequestDelegate {
    static let shared=SystemExtension()
    private var waiting:[CheckedContinuation<Void,Error>]=[]
    private var active=false
    /// Called while macOS waits for the user's approval, so the app can say where to allow it.
    var onApprovalNeeded:(()->Void)?
    func activate() async throws {
        if active {return}
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
        let pending=waiting;waiting=[]
        for continuation in pending {if let error {continuation.resume(throwing:error)} else {continuation.resume()}}
    }
    nonisolated func request(_ request:OSSystemExtensionRequest,actionForReplacingExtension existing:OSSystemExtensionProperties,withExtension ext:OSSystemExtensionProperties)->OSSystemExtensionRequest.ReplacementAction {.replace}
    nonisolated func requestNeedsUserApproval(_ request:OSSystemExtensionRequest) {
        Task {@MainActor in Journal.add("system extension: waiting for approval in System Settings");self.onApprovalNeeded?()}
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
}
#endif
