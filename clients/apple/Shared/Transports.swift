import Foundation
import CryptoKit
import Network

/// How the app reaches a node; the same ladder as the other apps, lightest first: WireGuard, Hysteria2 with
/// obfuscation, VLESS REALITY on TCP 443, REALITY over XHTTP. All are tested at once and the first that answers
/// in ladder order carries traffic. A transport that failed on a network while another worked goes to the end
/// of the ladder there for a week.
enum Transports {
    static let ladder=["wireguard","hysteria2","reality","xhttp"]
    static let group="TrackNothing"
    static let testURL="https://www.gstatic.com/generate_204"
    private static let memoryDays:TimeInterval=7

    /// A short one-way label for the network outside the tunnel: interface kind and gateways. Nothing that names the network is stored.
    static func networkKey(_ path:NWPath?) -> String {
        guard let path,path.status == .satisfied else {return "unknown"}
        let kind=path.usesInterfaceType(.wifi) ? "wifi":path.usesInterfaceType(.cellular) ? "cell":"lan"
        let gateways=path.gateways.map {"\($0)"}.sorted().joined(separator:",")
        let digest=SHA256.hash(data:Data("\(kind)|\(gateways)".utf8)).prefix(6).map {String(format:"%02x",$0)}.joined()
        return "\(kind):\(digest)"
    }
    private static var memory:UserDefaults {Shared.defaults}
    /// Transports that failed on this network within the last week, while another one worked.
    static func blocked(_ network:String) -> Set<String> {
        let cutoff=Date().timeIntervalSince1970-memoryDays*86400
        let entry=memory.dictionary(forKey:"transports.\(network)") as? [String:Double] ?? [:]
        return Set(entry.filter {$0.value>cutoff}.keys)
    }
    static func remember(_ network:String,failed:[String],working:[String]) {
        let now=Date().timeIntervalSince1970
        var entry=memory.dictionary(forKey:"transports.\(network)") as? [String:Double] ?? [:]
        for name in failed {entry[name]=now}
        for name in working {entry[name]=nil}
        // Forget networks not seen for a week, so the memory stays a handful of entries.
        for (key,value) in memory.dictionaryRepresentation() where key.hasPrefix("transports.") && key != "transports.\(network)" {
            if ((value as? [String:Double]) ?? [:]).values.allSatisfy({$0<=now-memoryDays*86400}) {memory.removeObject(forKey:key)}
        }
        memory.set(entry.isEmpty ? nil:entry,forKey:"transports.\(network)")
    }
    /// Ladder order, with transports this network blocked moved to the end.
    static func order(_ names:[String],blocked:Set<String>) -> [String] {
        let offered=Set(names)
        return ladder.filter {offered.contains($0)}.sorted {(blocked.contains($0) ? 1:0)<(blocked.contains($1) ? 1:0)}
    }
    /// A WireGuard key pair generated on this device; the private key never leaves it.
    static func keyPair() -> (privateKey:String,publicKey:String) {
        let key=Curve25519.KeyAgreement.PrivateKey()
        return (key.rawRepresentation.base64EncodedString(),key.publicKey.rawRepresentation.base64EncodedString())
    }
    /// WireGuard as a mihomo proxy: this device holds the private key, the lease gives the rest.
    static func wireguard(_ lease:[String:Any],privateKey:String) -> [String:Any]? {
        guard let wg=lease["wireguard"] as? [String:Any],let endpoint=wg["endpoint"] as? String,let colon=endpoint.lastIndex(of:":"),
              let port=Int(endpoint[endpoint.index(after:colon)...]),let address=wg["address"] as? String,let key=wg["serverPublicKey"] as? String else {return nil}
        let host=String(endpoint[..<colon]).trimmingCharacters(in:CharacterSet(charactersIn:"[]"))
        return ["name":"wireguard","type":"wireguard","server":host,"port":port,"ip":address.components(separatedBy:"/")[0],"private-key":privateKey,
                "public-key":key,"allowed-ips":["0.0.0.0/0"],"udp":true,"mtu":1280,"remote-dns-resolve":true,"dns":wg["dns"] as? [String] ?? []]
    }
    /// The whole mihomo configuration for one node (JSON is valid YAML). The provider owns the tun and passes its descriptor.
    /// What the core needs to build the configuration (clients/core/config.go): the same on every app.
    static func options(proxies:[[String:Any]],order:[String],fd:Int32,smart:Bool) throws -> String {
        let options:[String:Any]=["platform":"apple","fd":Int(fd),"smart":smart,"proxies":proxies,"order":order]
        return String(decoding:try JSONSerialization.data(withJSONObject:options),as:UTF8.self)
    }
    /// "name=delay,..." from the core; -1 means no answer.
    static func parseProbe(_ result:String) -> [String:Int] {
        var parsed=[String:Int]()
        for pair in result.split(separator:",") {let parts=pair.split(separator:"=");if parts.count==2 {parsed[String(parts[0])]=Int(parts[1]) ?? -1}}
        return parsed
    }
}

/// State shared by the app and its packet tunnel through the app group.
enum Shared {
    static let groupIdentifier=Bundle.main.object(forInfoDictionaryKey:"VeilbirdAppGroup") as? String ?? ""
    static var defaults:UserDefaults {UserDefaults(suiteName:groupIdentifier.isEmpty ? nil:groupIdentifier) ?? .standard}
    static var folder:URL {
        if !groupIdentifier.isEmpty,let shared=FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:groupIdentifier) {return shared}
        return FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0]
    }
}

/// Diagnostic log of the connection process, opened from a hidden entry (7 taps on the version). Only what the
/// apps write: steps, node names, transport names, timings, error codes and error texts scrubbed of addresses
/// (scrub); never keys, tokens, addresses or visited sites. Two files of 256 KB rotate and lines older than 7 days are dropped (at most 512 KB).
enum Journal {
    private static let limit=256*1024
    private static let retention:TimeInterval=7*86400
    private static let lock=NSLock()
    private static var current:URL {Shared.folder.appendingPathComponent("logs/veilbird.log")}
    private static var previous:URL {Shared.folder.appendingPathComponent("logs/veilbird.1.log")}
    /// An error text without anything that names a place: URLs, IP addresses, host names and long tokens
    /// become "…" (same rule as the server's scrubDetail). At most 200 characters.
    static func scrub(_ text:String) -> String {
        var value=text
        for pattern in ["(?i)[a-z][a-z0-9+.-]*://\\S+","\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b","(?i)\\[?\\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\\]?(:\\d+)?",
                        "(?i)\\b(?:[a-z0-9-]+\\.)+[a-z]{2,}(:\\d+)?\\b","[A-Za-z0-9+/=_-]{24,}","\\s+"] {
            value=value.replacingOccurrences(of:pattern,with:pattern=="\\s+" ? " ":"…",options:.regularExpression)
        }
        return String(value.trimmingCharacters(in:.whitespaces).prefix(200))
    }
    static func add(_ message:String) {
        lock.lock();defer {lock.unlock()}
        let manager=FileManager.default
        try? manager.createDirectory(at:current.deletingLastPathComponent(),withIntermediateDirectories:true)
        for file in [previous,current] {
            if let modified=(try? manager.attributesOfItem(atPath:file.path))?[.modificationDate] as? Date,Date().timeIntervalSince(modified)>retention {try? manager.removeItem(at:file)}
        }
        if let size=(try? manager.attributesOfItem(atPath:current.path))?[.size] as? Int,size>limit {
            try? manager.removeItem(at:previous);try? manager.moveItem(at:current,to:previous)
        }
        let stamp=ISO8601DateFormatter().string(from:Date())
        let line=Data("\(stamp) \(message.replacingOccurrences(of:"\n",with:" "))\n".utf8)
        if let handle=try? FileHandle(forWritingTo:current) {handle.seekToEndOfFile();handle.write(line);try? handle.close()}
        else {try? line.write(to:current)}
    }
    /// Oldest first, without lines past the retention window.
    static func read() -> String {
        lock.lock();defer {lock.unlock()}
        let parser=ISO8601DateFormatter(),cutoff=Date().addingTimeInterval(-retention)
        return [previous,current].compactMap {try? String(contentsOf:$0,encoding:.utf8)}.flatMap {$0.split(separator:"\n")}
            .filter {line in parser.date(from:String(line.split(separator:" ").first ?? "")).map {$0>cutoff} ?? false}
            .joined(separator:"\n")
    }
    static func clear() {lock.lock();defer {lock.unlock()};for file in [previous,current] {try? FileManager.default.removeItem(at:file)}}
}
