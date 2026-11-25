import SwiftUI
import Combine
import VeilbirdCore
import NetworkExtension
import AppIntents
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
import ServiceManagement
#endif

@main
struct VeilbirdApp: App {
    @StateObject private var model=ClientModel()
    #if os(macOS)
    @NSApplicationDelegateAdaptor(DockPresence.self) private var dock
    #endif
    init() {
        #if os(macOS)
        MacUpdater.adoptSandboxDefaults()
        #endif
    }
    var body: some Scene {
        #if os(macOS)
        // A small fixed-size tool window; the menu bar icon carries the quick actions and keeps running when it is closed.
        // Signed in, it widens to hold the activity panel beside the app's column.
        // No system title bar: the app's own backdrop fills the whole window, traffic lights float over it (28 pt strip).
        Window("TrackNothing",id:"main") {ClientView().environmentObject(model).environmentObject(model.live).frame(width:model.signedIn ? 1040:380,height:648)}
            .windowStyle(.hiddenTitleBar).windowResizability(.contentSize)
        MenuBarExtra {MenuBarView().environmentObject(model).environmentObject(model.live)} label:{MenuBarLabel(model:model,live:model.live)}.menuBarExtraStyle(.window)
        #else
        WindowGroup {ClientView().environmentObject(model).environmentObject(model.live)}
        #endif
    }
}

#if os(macOS)
/// Closing the window (not quitting) takes TrackNothing out of the Dock and the ⌘-Tab switcher; the menu bar icon
/// stays and opens the window again, which brings the Dock icon back. Quit (menu bar panel or ⌘Q) exits.
final class DockPresence:NSObject,NSApplicationDelegate,UNUserNotificationCenterDelegate {
    private var observers:[NSObjectProtocol]=[]
    /// Opens the main window; set by the menu bar icon, which is always there and can reach SwiftUI's openWindow.
    static var openMain:(()->Void)?
    func applicationDidFinishLaunching(_ notification:Notification) {
        UNUserNotificationCenter.current().delegate=self
        let center=NotificationCenter.default
        observers.append(center.addObserver(forName:NSWindow.willCloseNotification,object:nil,queue:.main) {note in
            let closing=note.object as? NSWindow
            // After the close has gone through: hide from the Dock once no app window is left on screen.
            DispatchQueue.main.async {if !Self.hasAppWindow(except:closing) {Self.show(false)}}
        })
        observers.append(center.addObserver(forName:NSWindow.didBecomeKeyNotification,object:nil,queue:.main) {note in
            if let window=note.object as? NSWindow,Self.isAppWindow(window) {Self.show(true)}
        })
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {false}
    /// A reminder (traffic or time running out) shows even while the app is in front, and clicking it opens the window.
    func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification,withCompletionHandler done:@escaping (UNNotificationPresentationOptions)->Void) {
        done([.banner,.sound])
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse,withCompletionHandler done:@escaping ()->Void) {
        DispatchQueue.main.async {Self.show(true);Self.openMain?();NSApp.activate(ignoringOtherApps:true)}
        done()
    }
    /// The main window, not the menu bar panel, sheets or system panels.
    static func isAppWindow(_ window:NSWindow)->Bool {!(window is NSPanel) && window.canBecomeMain && window.styleMask.contains(.titled)}
    static func hasAppWindow(except closing:NSWindow?)->Bool {
        NSApp.windows.contains {$0 !== closing && $0.isVisible && isAppWindow($0)}
    }
    /// Dock icon on (regular app) or off (menu bar only).
    static func show(_ inDock:Bool) {
        let policy:NSApplication.ActivationPolicy=inDock ? .regular:.accessory
        guard NSApp.activationPolicy() != policy else {return}
        NSApp.setActivationPolicy(policy)
        if inDock {NSApp.activate(ignoringOtherApps:true)}
    }
}
#endif

/// Starts and stops the saved VPN configuration; shared by the app, the menu bar and Shortcuts.
enum TunnelControl {
    static func saved() async throws -> NETunnelProviderManager? {
        try await NETunnelProviderManager.loadAllFromPreferences().first {$0.localizedDescription == "TrackNothing"}
    }
    /// Saves the configuration (origin, location, routing, protocol locks, kill switch) and starts the tunnel.
    static func start(origin:String,nodeId:String,routing:String) async throws -> NETunnelProviderManager {
        let manager=try await saved() ?? NETunnelProviderManager()
        let proto=NETunnelProviderProtocol()
        proto.providerBundleIdentifier=(Bundle.main.bundleIdentifier ?? "")+".tunnel"
        proto.serverAddress="TrackNothing"
        proto.providerConfiguration=["origin":origin,"nodeId":nodeId,"routing":routing,"locks":Advanced.locks,"rules":Advanced.rules]
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
