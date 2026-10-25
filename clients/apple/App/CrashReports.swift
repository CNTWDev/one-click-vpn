import Foundation
import MetricKit

/// Crash reports from MetricKit: the system delivers the app's (and its tunnel's) crash diagnostics after the next
/// launch. Only the kind, signal and reason are kept, never stacks with addresses or values; they are sent as
/// APP_CRASH diagnostics when signed in (Console → 客户端发布 counts them; 运行日志 has the text).
final class CrashReports:NSObject,MXMetricManagerSubscriber,@unchecked Sendable {
    static let shared=CrashReports()
    private let key="pendingCrashReports"
    func start() {MXMetricManager.shared.add(self)}
    func didReceive(_ payloads:[MXDiagnosticPayload]) {
        let version=Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let formatter=ISO8601DateFormatter()
        var pending=UserDefaults.standard.array(forKey:key) as? [[String:String]] ?? []
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                let parts=[crash.exceptionType.map {"exception \($0)"},crash.signal.map {"signal \($0)"},crash.terminationReason.map {Journal.scrub($0)}].compactMap {$0}
                pending.append(["at":formatter.string(from:payload.timeStampEnd),"detail":"\(version) \(crash.applicationVersion) "+parts.joined(separator:", ")])
            }
            for hang in payload.hangDiagnostics ?? [] {
                pending.append(["at":formatter.string(from:payload.timeStampEnd),"detail":"\(version) hang \(Int(hang.hangDuration.converted(to:.seconds).value)) s"])
            }
        }
        UserDefaults.standard.set(Array(pending.suffix(20)),forKey:key)
    }
    /// Sends what is pending; kept for the next try when the server cannot be reached.
    func send(_ api:NativeAPI) async {
        let pending=UserDefaults.standard.array(forKey:key) as? [[String:String]] ?? []
        guard !pending.isEmpty else {return}
        let events=pending.map {["code":"APP_CRASH","at":$0["at"] ?? "","detail":$0["detail"] ?? ""]}
        if (try? await api.request("diagnostics",["events":events])) != nil {UserDefaults.standard.removeObject(forKey:key)}
    }
}
