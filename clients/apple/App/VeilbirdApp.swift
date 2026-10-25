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

@main
struct VeilbirdApp: App {
    @StateObject private var model=ClientModel()
    var body: some Scene {
        #if os(macOS)
        // A small fixed-size tool window; the menu bar icon carries the quick actions and keeps running when it is closed.
        Window("TrackNothing",id:"main") {ClientView().environmentObject(model).frame(width:380,height:620)}
            .windowResizability(.contentSize)
        MenuBarExtra {MenuBarView().environmentObject(model)} label:{
            Image(systemName:model.connected ? "slash.circle.fill":"slash.circle").accessibilityLabel("TrackNothing")
        }.menuBarExtraStyle(.window)
        #else
        WindowGroup {ClientView().environmentObject(model)}
        #endif
    }
}

/// Starts and stops the saved VPN configuration; shared by the app, the menu bar and Shortcuts.
enum TunnelControl {
    static func saved() async throws -> NETunnelProviderManager? {
        try await NETunnelProviderManager.loadAllFromPreferences().first {$0.localizedDescription == "TrackNothing"}
    }
    /// Saves the configuration (origin, location, routing) and starts the tunnel.
    static func start(origin:String,nodeId:String,routing:String) async throws -> NETunnelProviderManager {
        let manager=try await saved() ?? NETunnelProviderManager()
        let proto=NETunnelProviderProtocol()
        proto.providerBundleIdentifier=(Bundle.main.bundleIdentifier ?? "")+".tunnel"
        proto.serverAddress="TrackNothing"
        proto.providerConfiguration=["origin":origin,"nodeId":nodeId,"routing":routing]
        manager.protocolConfiguration=proto;manager.localizedDescription="TrackNothing";manager.isEnabled=true
        try await manager.saveToPreferences();try await manager.loadFromPreferences()
        try manager.connection.startVPNTunnel(options:try secrets())
        return manager
    }
    /// What the Mac tunnel (a root system extension without the user's keychain) needs to sign in; nil on iOS,
    /// where the tunnel reads the shared keychain itself.
    static func secrets() throws -> [String:NSObject]? {
        #if os(macOS)
        guard let token=try SecureStorage.read("token") else {throw AccessFailure.code("AUTH_REQUIRED")}
        return ["token":token as NSData,"identity":try NativeAPI.identity().rawRepresentation as NSData]
        #else
        return nil
        #endif
    }
}
