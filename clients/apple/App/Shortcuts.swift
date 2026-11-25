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
        try await TunnelControl.resume(manager)
        return .result()
    }
}
struct DisconnectIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("disconnect_action",table:"Native")
    static var openAppWhenRun=false
    func perform() async throws -> some IntentResult {
        await TunnelControl.stop(try await TunnelControl.saved())
        return .result()
    }
}
/// A location from the saved list, offered by Spotlight and Shortcuts ("Connect TrackNothing to Tokyo"), plus Automatic.
struct LocationEntity:AppEntity {
    static var typeDisplayRepresentation=TypeDisplayRepresentation(name:LocalizedStringResource("location",table:"Native"))
    static var defaultQuery=LocationQuery()
    static let automaticId="automatic"
    let id:String
    let name:String
    let region:String
    var displayRepresentation:DisplayRepresentation {
        region.isEmpty ? DisplayRepresentation(title:"\(name)"):DisplayRepresentation(title:"\(name)",subtitle:"\(region)")
    }
    /// The list the app saved at its last refresh, Automatic first.
    static func saved()->[LocationEntity] {
        let automatic=LocationEntity(id:automaticId,name:L10n.text("automatic"),region:"")
        guard let data=UserDefaults.standard.data(forKey:"nodes"),
              let list=(try? JSONSerialization.jsonObject(with:data)) as? [[String:Any]] else {return [automatic]}
        return [automatic]+list.compactMap(entity)
    }
    private static func entity(_ node:[String:Any])->LocationEntity? {
        guard let id=node["id"] as? String,let name=node["name"] as? String,!id.isEmpty else {return nil}
        let region=(node["region"] as? String).flatMap {$0 == name ? nil:$0} ?? ""
        return LocationEntity(id:id,name:name,region:region)
    }
    /// Matches the name, the region or the country code, ignoring case and accents.
    func matches(_ text:String)->Bool {
        let wanted=text.trimmingCharacters(in:.whitespaces)
        guard !wanted.isEmpty else {return true}
        return [name,region].contains {$0.range(of:wanted,options:[.caseInsensitive,.diacriticInsensitive]) != nil}
    }
}
struct LocationQuery:EntityStringQuery {
    func entities(for identifiers:[String]) async throws -> [LocationEntity] {
        let all=LocationEntity.saved()
        return identifiers.compactMap {id in all.first {$0.id == id}}
    }
    func entities(matching string:String) async throws -> [LocationEntity] {LocationEntity.saved().filter {$0.matches(string)}}
    func suggestedEntities() async throws -> [LocationEntity] {LocationEntity.saved()}
}
/// Connects to a location, or moves a running VPN there, as choosing it in the app does.
struct ConnectToLocationIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("shortcut_connect_location",table:"Native")
    static var openAppWhenRun=false
    @Parameter(title:LocalizedStringResource("location",table:"Native")) var location:LocationEntity
    @MainActor func perform() async throws -> some IntentResult {
        let id=location.id == LocationEntity.automaticId ? "":location.id
        let name=id.isEmpty ? "":location.name
        Journal.add("connect: location requested from Shortcuts")
        if let model=ClientModel.live {
            let move=model.connected && id != model.connectedNodeId
            model.selected=id;model.selectedName=name
            if move {try await model.reconnect()} else if !model.connected {try await model.toggle()}
            return .result()
        }
        let defaults=UserDefaults.standard
        defaults.set(id,forKey:"selectedNode");defaults.set(name,forKey:"selectedNodeName")
        _=try await TunnelControl.start(origin:try Self.origin(),nodeId:id,routing:defaults.string(forKey:"routing") ?? "smart")
        return .result()
    }
    static func origin() throws -> String {
        let origin=ClientModel.builtInOrigin.isEmpty ? UserDefaults.standard.string(forKey:"origin") ?? "":ClientModel.builtInOrigin
        guard !origin.isEmpty else {throw AccessFailure.code("CONNECT_FROM_APP_FIRST")}
        return origin
    }
}
enum RoutingChoice:String,AppEnum {
    case smart,global
    static var typeDisplayRepresentation=TypeDisplayRepresentation(name:LocalizedStringResource("shortcut_routing_type",table:"Native"))
    static var caseDisplayRepresentations:[RoutingChoice:DisplayRepresentation]=[
        .smart:DisplayRepresentation(title:LocalizedStringResource("routing_smart",table:"Native")),
        .global:DisplayRepresentation(title:LocalizedStringResource("routing_global",table:"Native")),
    ]
}
/// Switches smart and global routing; a VPN that is up takes it at once by connecting again.
struct SetRoutingIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("shortcut_routing",table:"Native")
    static var openAppWhenRun=false
    @Parameter(title:LocalizedStringResource("shortcut_routing_type",table:"Native")) var routing:RoutingChoice
    @MainActor func perform() async throws -> some IntentResult {
        if let model=ClientModel.live {
            let changed=model.routing != routing.rawValue
            model.routing=routing.rawValue
            if changed && model.connected && model.since != nil {try await model.reconnect()}
            return .result()
        }
        let defaults=UserDefaults.standard
        let changed=defaults.string(forKey:"routing") != routing.rawValue
        defaults.set(routing.rawValue,forKey:"routing")
        if changed,let manager=try await TunnelControl.saved(),manager.connection.status == .connected {
            await TunnelControl.stop(manager)
            for _ in 0..<50 where manager.connection.status != .disconnected {try await Task.sleep(nanoseconds:200_000_000)}
            _=try await TunnelControl.start(origin:try ConnectToLocationIntent.origin(),nodeId:defaults.string(forKey:"selectedNode") ?? "",routing:routing.rawValue)
        }
        return .result()
    }
}
struct VeilbirdShortcuts:AppShortcutsProvider {
    static var appShortcuts:[AppShortcut] {
        AppShortcut(intent:ConnectIntent(),phrases:["Connect \(.applicationName)"])
        AppShortcut(intent:ConnectToLocationIntent(),phrases:["Connect \(.applicationName) to \(\.$location)","\(.applicationName) \(\.$location)"])
        AppShortcut(intent:SetRoutingIntent(),phrases:["Set \(.applicationName) routing to \(\.$routing)"])
        AppShortcut(intent:DisconnectIntent(),phrases:["Disconnect \(.applicationName)"])
    }
}
