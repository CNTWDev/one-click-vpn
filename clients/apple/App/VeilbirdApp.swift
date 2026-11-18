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
    init() {
        #if os(macOS)
        MacUpdater.adoptSandboxDefaults()
        #endif
    }
    var body: some Scene {
        #if os(macOS)
        // A small fixed-size tool window; the menu bar icon carries the quick actions and keeps running when it is closed.
        // Signed in, it widens to hold the activity panel beside the app's column.
        Window("TrackNothing",id:"main") {ClientView().environmentObject(model).frame(width:model.signedIn ? 1040:380,height:620)}
            .windowResizability(.contentSize)
        MenuBarExtra {MenuBarView().environmentObject(model)} label:{MenuBarLabel(model:model)}.menuBarExtraStyle(.window)
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
    /// Saves the configuration (origin, location, routing, kill switch) and starts the tunnel.
    static func start(origin:String,nodeId:String,routing:String) async throws -> NETunnelProviderManager {
        let manager=try await saved() ?? NETunnelProviderManager()
        let proto=NETunnelProviderProtocol()
        proto.providerBundleIdentifier=(Bundle.main.bundleIdentifier ?? "")+".tunnel"
        proto.serverAddress="TrackNothing"
        proto.providerConfiguration=["origin":origin,"nodeId":nodeId,"routing":routing]
        // Kill switch: the system sends everything through the tunnel and nothing out while it is down (the
        // tunnel's own connections to nodes and the API are exempt). Local network devices stay reachable.
        proto.includeAllNetworks=UserDefaults.standard.bool(forKey:"killSwitch")
        proto.excludeLocalNetworks=true
        manager.protocolConfiguration=proto;manager.localizedDescription="TrackNothing";manager.isEnabled=true
        try await resume(manager)
        return manager
    }
    /// Starts the saved configuration and keeps it on: on iPhone On Demand lets iOS start the tunnel again after it
    /// killed it (memory, crash); on the Mac the app does that (ClientModel.watchDrop), since the tunnel there needs
    /// the sign-in the app hands it.
    static func resume(_ manager:NETunnelProviderManager) async throws {
        Shared.refused=nil
        #if os(iOS)
        let rule=NEOnDemandRuleConnect();rule.interfaceTypeMatch = .any
        manager.onDemandRules=[rule];manager.isOnDemandEnabled=true
        #endif
        UserDefaults.standard.set(true,forKey:"vpnWanted")
        try await manager.saveToPreferences();try await manager.loadFromPreferences()
        try manager.connection.startVPNTunnel(options:try secrets())
    }
    /// The user disconnects: no On Demand restart, no reconnect by the app.
    static func stop(_ manager:NETunnelProviderManager?) async {
        UserDefaults.standard.set(false,forKey:"vpnWanted")
        guard let manager else {return}
        if manager.isOnDemandEnabled {manager.isOnDemandEnabled=false;try? await manager.saveToPreferences()}
        manager.connection.stopVPNTunnel()
    }
    /// Whether the user left the VPN on (the Mac app connects again when the tunnel dropped or at launch).
    static var wanted:Bool {UserDefaults.standard.bool(forKey:"vpnWanted")}
    /// What the Mac tunnel (a root system extension without the user's keychain) needs to sign in; nil on iOS,
    /// where the tunnel reads the shared keychain itself.
    static func secrets() throws -> [String:NSObject]? {
        // "fromApp": a start the user asked for, unlike one by iOS On Demand (the tunnel then clears Shared.refused).
        #if os(macOS)
        guard let token=try SecureStorage.read("token") else {throw AccessFailure.code("AUTH_REQUIRED")}
        return ["token":token as NSData,"identity":try NativeAPI.identity().rawRepresentation as NSData,"fromApp":NSNumber(value:true)]
        #else
        return ["fromApp":NSNumber(value:true)]
        #endif
    }
}
