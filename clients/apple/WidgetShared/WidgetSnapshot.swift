import Foundation

/// What the Mac widgets show, written by the app into the shared app group container whenever the connection
/// changes (WidgetBridge.swift) and read by the widget extension. Texts arrive already in the app's language; the
/// globe arrives as a small picture beside it, drawn by the app.
struct WidgetSnapshot:Codable,Equatable {
    var on=false
    var busy=false
    var title=""
    var place=""
    var since:Date?
    var detail=""
    var action=""
    var hint=""
    var theme="amber"
    // Since 1.0.50 (widgets that act in place). Optional so a snapshot from an older build still decodes.
    /// The connected (or chosen) location's id, latency and country code.
    var placeId:String?
    var code:String?
    var ms:Int?
    /// Snapshot of the rates in bytes per second and the last ~30 seconds of download, newest last.
    var rx:Int?
    var tx:Int?
    var history:[Int]?
    /// "smart" or "global".
    var routing:String?
    /// While connecting: which of the three steps (route, tunnel, confirm) and its name.
    var phase:Int?
    var phaseText:String?
    /// Favorites, or the fastest locations when there are none; `all` is every location (the one-place widget).
    var favorites:[WidgetPlace]?
    var all:[WidgetPlace]?
    /// Traffic left (or used) with its title, the share left (0…1, nil without a quota) and the end of access.
    var trafficTitle:String?
    var traffic:String?
    var trafficShare:Double?
    var until:String?
    /// The words the buttons and labels use, in the app's language (see WidgetBridge.labels).
    var labels:[String:String]?
    /// Set by a widget button until the app has handled it, so the widget shows the press at once.
    var pending:String?
    func label(_ key:String)->String {labels?[key] ?? ""}

    static let file="widget.json"
    static let picture="widget-globe.png"
    /// Both the app and the extension carry the group in their Info.plist (VeilbirdAppGroup).
    static var group:String? {
        guard let group=Bundle.main.object(forInfoDictionaryKey:"VeilbirdAppGroup") as? String,!group.isEmpty else {return nil}
        return group
    }
    static var folder:URL? {group.flatMap {FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:$0)}}
    static func load()->WidgetSnapshot? {
        guard let url=folder?.appendingPathComponent(file),let data=try? Data(contentsOf:url) else {return nil}
        return try? JSONDecoder().decode(WidgetSnapshot.self,from:data)
    }
    func save() {
        guard let url=Self.folder?.appendingPathComponent(Self.file),let data=try? JSONEncoder().encode(self) else {return}
        try? data.write(to:url,options:.atomic)
    }
    /// The app's own address: toggle connects or disconnects, open shows the window.
    static let toggleURL=URL(string:"tracknothing://toggle")!
    static let openURL=URL(string:"tracknothing://open")!
}

/// A location as the widgets list it.
struct WidgetPlace:Codable,Equatable,Hashable {
    var id:String
    var name:String
    var code:String
    var ms:Int?
    var lines:Int?
}

/// A widget button's request to the app: written into the group container, then a Darwin notification wakes the app
/// (the menu bar app is normally running). The app does it as its own buttons would and redraws the widgets.
/// Actions: "connect", "disconnect", "toggle", "place" (value = location id, "" = Automatic), "routing" (smart/global).
struct WidgetCommand:Codable {
    var action:String
    var value:String=""
    var at=Date()
    static let file="widget-command.json"
    /// Sandboxed processes may post Darwin notifications whose names start with their app group.
    static var notification:String? {WidgetSnapshot.group.map {$0+".widget-command"}}
    func send() {
        guard let url=WidgetSnapshot.folder?.appendingPathComponent(Self.file),let data=try? JSONEncoder().encode(self) else {return}
        try? data.write(to:url,options:.atomic)
        if let name=Self.notification {
            CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),CFNotificationName(name as CFString),nil,nil,true)
        }
    }
    /// The command waiting for the app, removed as it is read; one older than a minute is dropped (the app was not there).
    static func take()->WidgetCommand? {
        guard let url=WidgetSnapshot.folder?.appendingPathComponent(file),let data=try? Data(contentsOf:url) else {return nil}
        try? FileManager.default.removeItem(at:url)
        guard let command=try? JSONDecoder().decode(WidgetCommand.self,from:data),Date().timeIntervalSince(command.at)<60 else {return nil}
        return command
    }
}
