import Foundation

/// Advanced features, hidden until the person turns them on in Account: favorite locations (listed first on the
/// location page) and a per-location protocol lock. Both are kept on this device only; the app hands the locks to
/// the tunnel with each start.
enum Advanced {
    /// The protocols a location can be locked to; "reality" covers REALITY on 443 and on the spare port.
    static let protocols=["hysteria2","reality","xhttp","wireguard"]
    private static var defaults:UserDefaults {.standard}
    /// Always on since 1.0.35 (there is no switch any more): favorites, protocol lock and routing rules stay
    /// out of the way until someone uses them.
    static var enabled:Bool {
        get {true}
        set {}
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

    /// The registrable part of a host, as the core groups sites (activity.go site): chat.openai.com -> openai.com.
    static func site(_ host:String)->String {
        if host.contains(":") || host.range(of:"^[0-9.]+$",options:.regularExpression) != nil {return host}
        let labels=host.split(separator:".").map(String.init)
        var keep=2
        if labels.count>=3,labels[labels.count-1].count==2,["com","net","org","edu","gov","co","ac","or","ne","go"].contains(labels[labels.count-2]) {keep=3}
        return labels.count<=keep ? host:labels.suffix(keep).joined(separator:".")
    }
    /// The line a quick rule writes: the whole site ("openai.com, direct") or only this name ("DOMAIN,chat.openai.com,direct").
    static func quickRule(_ host:String,site wholeSite:Bool,policy:String)->String {
        if host.contains(":") || host.range(of:"^[0-9.]+$",options:.regularExpression) != nil {
            return host+(host.contains(":") ? "/128":"/32")+", "+policy
        }
        return wholeSite ? host+", "+policy:"DOMAIN,"+host+","+policy
    }
    /// Puts the person's quick rule for host first (the first matching rule wins), replacing an earlier one for the
    /// same name and reach, and returns the text before it for undo.
    @discardableResult static func setQuickRule(_ host:String,site wholeSite:Bool,policy:String)->String {
        let before=rulesText,name=host.lowercased()
        let kept=before.split(separator:"\n",omittingEmptySubsequences:false).map(String.init).filter {!sameTarget($0,name,site:wholeSite)}
        let text=([quickRule(name,site:wholeSite,policy:policy)]+kept).joined(separator:"\n")
        rulesText=text.hasSuffix("\n") ? String(text.dropLast()):text
        return before
    }
    private static func sameTarget(_ line:String,_ host:String,site wholeSite:Bool)->Bool {
        let body=line.split(separator:"#",maxSplits:1,omittingEmptySubsequences:false).first.map(String.init) ?? ""
        let parts:[String]=body.split(separator:",").map {$0.trimmingCharacters(in:.whitespaces)}.filter {!$0.isEmpty}
        func bare(_ value:String)->String {var v=value.lowercased();while v.hasPrefix("+") || v.hasPrefix(".") {v.removeFirst()};return v}
        if parts.count==2 {return bare(parts[0])==host && wholeSite || bare(parts[0])==host+"/32" || bare(parts[0])==host+"/128"}
        if parts.count>=3 {
            let kind=parts[0].uppercased()
            return bare(parts[1])==host && (kind=="DOMAIN-SUFFIX" ? wholeSite:kind=="DOMAIN" && !wholeSite)
        }
        return false
    }
}
