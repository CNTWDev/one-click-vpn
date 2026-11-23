import Foundation

/// Advanced features, hidden until the person turns them on in Account: favorite locations (listed first on the
/// location page) and a per-location protocol lock. Both are kept on this device only; the app hands the locks to
/// the tunnel with each start.
enum Advanced {
    /// The protocols a location can be locked to; "reality" covers REALITY on 443 and on the spare port.
    static let protocols=["hysteria2","reality","xhttp","wireguard"]
    private static var defaults:UserDefaults {.standard}
    static var enabled:Bool {
        get {defaults.bool(forKey:"advanced")}
        set {defaults.set(newValue,forKey:"advanced")}
    }
    static var favorites:Set<String> {enabled ? Set(defaults.stringArray(forKey:"advancedFavorites") ?? []):[]}
    static func favorite(_ id:String,_ on:Bool) {
        var all=Set(defaults.stringArray(forKey:"advancedFavorites") ?? [])
        if on {all.insert(id)} else {all.remove(id)}
        defaults.set(all.sorted(),forKey:"advancedFavorites")
    }
    /// Location id -> protocol; empty while advanced is off.
    static var locks:[String:String] {enabled ? (defaults.dictionary(forKey:"advancedLocks") as? [String:String] ?? [:]):[:]}
    static func lock(_ id:String)->String {id.isEmpty ? "":(locks[id].flatMap {protocols.contains($0) ? $0:nil} ?? "")}
    static func setLock(_ id:String,_ protocolName:String) {
        var all=defaults.dictionary(forKey:"advancedLocks") as? [String:String] ?? [:]
        all[id]=protocolName.isEmpty ? nil:protocolName
        defaults.set(all,forKey:"advancedLocks")
    }
    /// The transports of a locked location: only those of its protocol, or all of them when none of those is offered.
    static func apply(_ transports:[String],locked:String)->[String] {
        guard !locked.isEmpty else {return transports}
        let kept=transports.filter {family($0)==locked}
        return kept.isEmpty ? transports:kept
    }
    static func family(_ transport:String)->String {transport=="reality-alt" ? "reality":transport}
}
