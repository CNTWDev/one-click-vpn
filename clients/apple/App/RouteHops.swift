import Foundation

/// A stop on the route globe between this device and the exit; faint: the stretch to it was not measured.
struct RouteStop:Equatable {
    let spot:Spot
    let faint:Bool
}

/// One line of the path list (kinds as core.Route: local, city, unknown, gap, exit).
struct RouteRow:Equatable,Identifiable {
    let id:Int
    let kind:String
    let n:Int
    let ms:Int
    let name:String
    let network:String
    let border:Bool
}

/// The measured path of one connection: the globe's stops, the list, and the round trip to the node (0: no answer).
struct RoutePath:Equatable {
    let key:String
    let stops:[RouteStop]
    let exitFaint:Bool
    let rows:[RouteRow]
    let ms:Int
    let at:Date
}

/// The path from this Mac to its node, measured once a connection is up by the tunnel (outside the tunnel: the
/// provider's own sockets do not go through it): the core traces it, the server places the routers' addresses at
/// city level (route-hops, nothing stored), and the core turns both into stops and rows. Nothing is kept on disk.
enum RouteHops {
    private static func name(_ names:[String:Any]?)->String {
        let key=L10n.language.hasPrefix("zh") ? "zh":String(L10n.language.prefix(2))
        return (names?[key] as? String).flatMap {$0.isEmpty ? nil:$0} ?? (names?["en"] as? String) ?? ""
    }
    private static func double(_ value:Any?)->Double {(value as? NSNumber)?.doubleValue ?? 0}

    static func parse(_ key:String,_ route:[String:Any])->RoutePath {
        var stops:[RouteStop]=[]
        for p in route["points"] as? [[String:Any]] ?? [] {
            let spot=Spot(lat:double(p["lat"]),lon:double(p["lon"]),label:name(p["names"] as? [String:Any]))
            stops.append(RouteStop(spot:spot,faint:p["faint"] as? Bool ?? false))
        }
        var rows:[RouteRow]=[]
        for (i,r) in (route["rows"] as? [[String:Any]] ?? []).enumerated() {
            rows.append(RouteRow(id:i,kind:r["kind"] as? String ?? "",n:r["n"] as? Int ?? 0,ms:r["ms"] as? Int ?? 0,
                name:name(r["names"] as? [String:Any]),network:r["network"] as? String ?? "",border:r["border"] as? Bool ?? false))
        }
        return RoutePath(key:key,stops:stops,exitFaint:route["exitFaint"] as? Bool ?? false,rows:rows,ms:route["ms"] as? Int ?? 0,at:Date())
    }

    /// "Via Shanghai · 158 ms" for the line under the state; empty when nothing lies between you and the exit.
    static func via(_ path:RoutePath?)->String {
        guard let path,!path.stops.isEmpty else {return ""}
        var names:[String]=[]
        for stop in path.stops where !stop.spot.label.isEmpty && !names.contains(stop.spot.label) {names.append(stop.spot.label)}
        if names.isEmpty {return ""}
        let tail=path.ms>0 ? " · "+L10n.text("latency_ms",L10n.number(path.ms)):""
        return L10n.text("route_via",names.joined(separator:" · ")+tail)
    }

    /// The title and the second line of a row in the path list.
    static func describe(_ row:RouteRow,exit:String)->(String,String) {
        switch row.kind {
        case "local":return (L10n.text("route_local"),"")
        case "gap":
            if row.n == 0 {return (L10n.text("route_gap_end"),"")}
            return (row.n == 1 ? L10n.text("route_gap_one"):L10n.text("route_gap",L10n.number(row.n)),"")
        case "unknown":return (L10n.text("route_unknown"),row.network)
        case "exit":return (exit,L10n.text("route_exit"))
        default:
            let detail=[row.network,row.border ? L10n.text("route_border"):""].filter {!$0.isEmpty}.joined(separator:" · ")
            return (row.name,detail)
        }
    }
}
