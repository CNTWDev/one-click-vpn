import SwiftUI
import Combine
import VeilbirdCore
import NetworkExtension
import AppIntents
#if os(iOS)
import UIKit
#else
import AppKit
import ServiceManagement
#endif

/// Shortcuts and Siri: connect or disconnect with the saved location and routing.
struct ConnectIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("connect_action",table:"Native")
    static var openAppWhenRun=false
    func perform() async throws -> some IntentResult {
        guard let manager=try await TunnelControl.saved() else {throw AccessFailure.code("CONNECT_FROM_APP_FIRST")}
        Journal.add("connect: requested from Shortcuts")
        try manager.connection.startVPNTunnel(options:try TunnelControl.secrets())
        return .result()
    }
}
struct DisconnectIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("disconnect_action",table:"Native")
    static var openAppWhenRun=false
    func perform() async throws -> some IntentResult {
        try await TunnelControl.saved()?.connection.stopVPNTunnel()
        return .result()
    }
}
struct VeilbirdShortcuts:AppShortcutsProvider {
    static var appShortcuts:[AppShortcut] {
        AppShortcut(intent:ConnectIntent(),phrases:["Connect \(.applicationName)"])
        AppShortcut(intent:DisconnectIntent(),phrases:["Disconnect \(.applicationName)"])
    }
}
