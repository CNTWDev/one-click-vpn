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
    static let file="widget.json"
    static let picture="widget-globe.png"
    /// Both the app and the extension carry the group in their Info.plist (VeilbirdAppGroup).
    static var folder:URL? {
        guard let group=Bundle.main.object(forInfoDictionaryKey:"VeilbirdAppGroup") as? String,!group.isEmpty else {return nil}
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:group)
    }
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
