import Foundation
import Network

/// One node as measured from this device: median TCP connect time, jitter and failed attempts.
struct Quality {
    let latency:Int?
    let jitter:Int
    let loss:Int
    var load:Int?
    var users=0
    /// Lower is better. Jitter and loss hurt more than a few extra milliseconds. Load above half costs 4 ms per
    /// percent (a full node +200 ms) and each connected user 1 ms (at most 50), so close nodes win unless busy.
    var score:Int {guard let latency else {return Int.max};return latency+2*jitter+10*loss+max(0,(load ?? 0)-50)*4+min(users,50)}
    var grade:String {
        guard latency != nil else {return "quality_unreachable"}
        if score<150 && loss==0 {return "quality_good"}
        return score<300 && loss<=20 ? "quality_fair":"quality_poor"
    }
}

/// "Automatic" location: the best score from TCP connects to each node's probe port, measured from this device.
/// The tunnel provider's own connections bypass the tunnel; the app's go through it while connected.
enum Latency {
    private static let lock=NSLock()
    private static var recentResults=[String:Quality]()
    private static var measuredAt=[String:Date]()
    /// Last measurement per node id, so the home screen can show it without probing again.
    static func recent(_ id:String) -> Quality? {lock.lock();defer {lock.unlock()};return recentResults[id]}
    static func load(_ node:[String:Any]) -> Int? {(node["load"] as? Int).flatMap {(0...100).contains($0) ? $0:nil}}
    static func users(_ node:[String:Any]) -> Int {max(0,node["users"] as? Int ?? 0)}

    static func measure(_ node:[String:Any],attempts:Int=5) async -> Quality {
        let load=load(node),users=users(node)
        guard let probe=node["probe"] as? [String:Any],let host=probe["host"] as? String,!host.isEmpty,
              let number=probe["port"] as? Int,(1...65535).contains(number),let port=NWEndpoint.Port(rawValue:UInt16(number)) else {return Quality(latency:nil,jitter:0,loss:100,load:load,users:users)}
        var samples=[Int]()
        for attempt in 0..<attempts {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if attempt==2 && samples.isEmpty {return Quality(latency:nil,jitter:0,loss:100,load:load,users:users)}
            if let elapsed=await connect(host:host,port:port) {samples.append(elapsed)}
        }
        let loss=(attempts-samples.count)*100/attempts
        guard !samples.isEmpty else {return Quality(latency:nil,jitter:0,loss:loss,load:load,users:users)}
        let sorted=samples.sorted()
        let jitter=samples.count<2 ? 0:zip(samples,samples.dropFirst()).map {abs($0-$1)}.reduce(0,+)/(samples.count-1)
        return Quality(latency:sorted[sorted.count/2],jitter:jitter,loss:loss,load:load,users:users)
    }
    private static func connect(host:String,port:NWEndpoint.Port) async -> Int? {
        await withCheckedContinuation {continuation in
            let connection=NWConnection(host:NWEndpoint.Host(host),port:port,using:.tcp)
            let started=DispatchTime.now().uptimeNanoseconds,lock=NSLock()
            var finished=false
            func finish(_ value:Int?) {
                lock.lock();defer {lock.unlock()}
                guard !finished else {return};finished=true
                connection.cancel();continuation.resume(returning:value)
            }
            connection.stateUpdateHandler={state in
                switch state {
                case .ready:finish(Int((DispatchTime.now().uptimeNanoseconds-started)/1_000_000))
                case .failed,.waiting,.cancelled:finish(nil)
                default:break
                }
            }
            connection.start(queue:.global())
            DispatchQueue.global().asyncAfter(deadline:.now()+1.5) {finish(nil)}
        }
    }
    /// A result younger than age, with the node's current load.
    private static func known(_ node:[String:Any],age:TimeInterval) -> Quality? {
        guard age>0,let id=node["id"] as? String else {return nil}
        lock.lock();defer {lock.unlock()}
        guard let at=measuredAt[id],Date().timeIntervalSince(at)<age,var quality=recentResults[id] else {return nil}
        quality.load=load(node);quality.users=users(node);return quality
    }
    /// Best first; unmeasured nodes follow in the server's least-loaded order. A node measured less than reuse seconds
    /// ago keeps that result, so connecting right after the location list does not probe again.
    static func rank(_ nodes:[[String:Any]],attempts:Int=5,reuse:TimeInterval=0) async -> [(node:[String:Any],quality:Quality)] {
        let measured=await withTaskGroup(of:(Int,Quality).self) {group -> [Int:Quality] in
            for (index,node) in nodes.enumerated() {group.addTask {
                if let quality=known(node,age:reuse) {return (index,quality)}
                let quality=await measure(node,attempts:attempts)
                if let id=node["id"] as? String {lock.lock();measuredAt[id]=Date();lock.unlock()}
                return (index,quality)
            }}
            var results=[Int:Quality]()
            for await (index,quality) in group {results[index]=quality}
            return results
        }
        lock.lock()
        for (index,quality) in measured {if let id=nodes[index]["id"] as? String {recentResults[id]=quality}}
        lock.unlock()
        return nodes.indices.sorted {(measured[$0]?.score ?? Int.max,$0)<(measured[$1]?.score ?? Int.max,$1)}
            .map {(node:nodes[$0],quality:measured[$0] ?? Quality(latency:nil,jitter:0,loss:100,load:nil))}
    }
}
