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

    /// The person's routing rules as typed (one per line); the core reads them (clients/core/rules.go).
    static var rulesText:String {
        get {defaults.string(forKey:"advancedRules") ?? ""}
        set {defaults.set(newValue,forKey:"advancedRules")}
    }
    /// The lines the core will use; none while advanced is off.
    static var rules:[String] {
        guard enabled else {return []}
        return rulesText.split(separator:"\n",omittingEmptySubsequences:true).map {$0.trimmingCharacters(in:.whitespaces)}.filter {ruleState($0)==1}
    }
    private static let ruleTypes:Set<String>=["DOMAIN","DOMAIN-SUFFIX","DOMAIN-KEYWORD","IP-CIDR","IP-CIDR6"]
    /// 1 a rule, 0 blank or a comment, -1 a line the core cannot read; the same reading as rules.go.
    static func ruleState(_ line:String)->Int {
        let body=line.split(separator:"#",maxSplits:1,omittingEmptySubsequences:false).first.map(String.init) ?? ""
        let parts:[String]=body.split(separator:",").map {$0.trimmingCharacters(in:.whitespaces)}.filter {!$0.isEmpty}
        if parts.isEmpty {return 0}
        var value:String
        var ip:Bool
        if parts.count>=3 && ruleTypes.contains(parts[0].uppercased()) {value=parts[1];ip=parts[0].uppercased().hasPrefix("IP")}
        else if parts.count==2 {value=parts[0];ip=value.contains("/")}
        else {return -1}
        if value.contains(where:{$0.isWhitespace}) {return -1}
        if ip {return value.range(of:"^[0-9A-Fa-f:.]+/[0-9]{1,3}$",options:.regularExpression) != nil ? 1:-1}
        while value.hasPrefix("+") || value.hasPrefix(".") {value.removeFirst()}
        return value.isEmpty ? -1:1
    }
}
