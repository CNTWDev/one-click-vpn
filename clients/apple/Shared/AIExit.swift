import Foundation
#if canImport(TunnelCore)
import TunnelCore
#endif

/// Keeps AI services on a steady exit. ChatGPT, Claude and Gemini refuse some countries (the server marks such
/// locations "ai": false) and flag accounts whose exit keeps changing, so automatic mode keeps people who used AI in
/// the last week off refused locations, and moves inside the same country while AI is in use (PacketTunnelProvider).
enum AIExit {
    private static let key="aiSeenAt"
    private static let week:TimeInterval=7*86400
    private static var noted=Date.distantPast
    /// AI services went through the tunnel in the last week.
    static var recent:Bool {Date().timeIntervalSince1970-Shared.defaults.double(forKey:key)<week}
    /// Called on the tunnel's tick: remembers (at most every 5 minutes) that AI is in use.
    static func note() {
        #if canImport(TunnelCore)
        guard Date().timeIntervalSince(noted)>300,CoreAIActive(60) else {return}
        noted=Date();Shared.defaults.set(Date().timeIntervalSince1970,forKey:key)
        #endif
    }
    /// The locations automatic mode may pick: without those AI services refuse, for people who use AI (unless none is left).
    static func usable(_ nodes:[[String:Any]]) -> [[String:Any]] {
        guard recent else {return nodes}
        let kept=nodes.filter {($0["ai"] as? Bool) != false}
        return kept.isEmpty ? nodes:kept
    }
}
