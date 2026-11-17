import Foundation
import Network
#if canImport(TunnelCore)
import TunnelCore
#endif

/// One node as measured from this device: latency (a request through its transports when the device has them, else the
/// median TCP connect time), jitter and failed attempts.
struct Quality {
    let latency:Int?
    let jitter:Int
    let loss:Int
    var load:Int?
    var users=0
    /// Each line's result on this network (transport name: ms, -1 = no answer); nil when not measured through the transports.
    var lines:[String:Int]?=nil
    /// Lower is better. Jitter and loss hurt more than a few extra milliseconds. Load above half costs 4 ms per
    /// percent (a full node +200 ms) and each connected user 1 ms (at most 50), so close nodes win unless busy.
    var score:Int {guard let latency else {return Int.max};return latency+2*jitter+10*loss+max(0,(load ?? 0)-50)*4+min(users,50)}
    var grade:String {
        guard latency != nil else {return "quality_unreachable"}
        if score<150 && loss==0 {return "quality_good"}
        return score<300 && loss<=20 ? "quality_fair":"quality_poor"
    }
}

/// "Automatic" location: the best score from TCP connects to each node's probe ports, measured from this device.
/// The tunnel provider's own connections bypass the tunnel; the app's go through it while connected.
enum Latency {
    private static let lock=NSLock()
    private static var recentResults=[String:Quality]()
    private static var measuredAt=[String:Date]()
    /// Last measurement per node id, so the home screen can show it without probing again.
    static func recent(_ id:String) -> Quality? {lock.lock();defer {lock.unlock()};return recentResults[id]}
    static func load(_ node:[String:Any]) -> Int? {(node["load"] as? Int).flatMap {(0...100).contains($0) ? $0:nil}}
    static func users(_ node:[String:Any]) -> Int {max(0,node["users"] as? Int ?? 0)}

    /// The app sets this: it measures through the transports. The tunnel extension keeps to TCP connects, since a
    /// QUIC and TLS client per transport would not fit its memory limit on iOS.
    static var realTests=false
    /// The wait for a request through a transport; mihomo's default, which Clash apps show.
    static let realTimeoutMs=5000
    /// The transports a node can offer, in the order the apps show them as "线路 1…4": Hysteria2 (with port hopping),
    /// REALITY on 443, REALITY on the node's spare TCP port, XHTTP. Users only see the numbers; the transport names stay
    /// in the hidden log. WireGuard is not listed: it cannot be tested before a lease.
    static let lineOrder=["hysteria2","reality","reality-alt","xhttp"]
    /// The file the speed test downloads through the current connection (repeated for the test's few seconds).
    static let speedURL="https://speed.cloudflare.com/__down?bytes=100000000"
    /// A request to the test page through every transport the device has on this node (the server's "test" list,
    /// the lines a connect would use): the fastest answer in ms (-1 when none answers) and each transport's result;
    /// nil when not measured. This is how Clash apps measure: it sees a node reached only over UDP, and one whose
    /// port answers but whose transport is blocked after the handshake.
    static func real(_ id:String,_ transports:[Any]) async -> (ms:Int,lines:[String:Int])? {
        #if canImport(TunnelCore)
        guard realTests,let data=try? JSONSerialization.data(withJSONObject:["nodes":[id:transports],"url":Transports.testURL,"timeoutMs":realTimeoutMs]) else {return nil}
        let input=String(decoding:data,as:UTF8.self)
        let output=await Task.detached {CoreTest(input)}.value
        guard let result=(try? JSONSerialization.jsonObject(with:Data(output.utf8)) as? [String:Any])?[id] as? [String:Any] else {return nil}
        return (result["ms"] as? Int ?? -1,result["lines"] as? [String:Int] ?? [:])
        #else
        return nil
        #endif
    }
    /// Tells the server which lines answered on this network (the block alerts in Console read it). A node's failures
    /// count only when some line somewhere answered, so a device without internet reports nothing.
    static func report(_ api:NativeAPI,_ ranked:[(node:[String:Any],quality:Quality)]) async {
        let measured=ranked.compactMap {item -> (String,[String:Int])? in
            guard let id=item.node["id"] as? String,let lines=item.quality.lines,!lines.isEmpty else {return nil}
            return (id,lines)
        }
        guard measured.contains(where:{$0.1.values.contains {$0>=0}}) else {return}
        let network=Transports.networkKey(await currentPath())
        let at=ISO8601DateFormatter().string(from:Date())
        let events=measured.prefix(19).map {(id,lines) in
            ["code":"TRANSPORT_PROBE","at":at,"nodeId":id,"network":network,"detail":lines.sorted {$0.key<$1.key}.map {"\($0.key)="+($0.value>=0 ? "ok":"fail")}.joined(separator:",")]
        }
        _ = try? await api.request("diagnostics",["events":Array(events)])
    }
    private static func currentPath() async -> NWPath? {
        await withCheckedContinuation {(done:CheckedContinuation<NWPath?,Never>) in
            let monitor=NWPathMonitor(),lock=NSLock()
            var finished=false
            func finish(_ path:NWPath?) {lock.lock();defer {lock.unlock()};guard !finished else {return};finished=true;monitor.cancel();done.resume(returning:path)}
            monitor.pathUpdateHandler={finish($0)}
            monitor.start(queue:.global())
            DispatchQueue.global().asyncAfter(deadline:.now()+1) {finish(nil)}
        }
    }
    /// TCP connects give jitter and loss; the request through the transports, when the device has them, decides
    /// whether the node answers and its latency. Devices that never connected (no "test" list) keep the TCP result.
    static func measure(_ node:[String:Any],attempts:Int=5) async -> Quality {
        let transports=(node["test"] as? [Any]) ?? []
        guard !transports.isEmpty,let id=node["id"] as? String else {return await measureTcp(node,attempts:attempts)}
        async let pending=real(id,transports)
        let tcp=await measureTcp(node,attempts:attempts)
        guard let result=await pending else {return tcp}
        let (delay,lines)=result
        if !lines.isEmpty {
            Journal.add("lines: \(node["name"] as? String ?? "") "+lines.sorted {$0.key<$1.key}.map {$0.value>=0 ? "\($0.key) \($0.value) ms":"\($0.key) no answer"}.joined(separator:", "))
        }
        if delay<0 {return Quality(latency:nil,jitter:0,loss:100,load:tcp.load,users:tcp.users,lines:lines)}
        return tcp.latency != nil ? Quality(latency:delay,jitter:tcp.jitter,loss:tcp.loss,load:tcp.load,users:tcp.users,lines:lines)
            :Quality(latency:delay,jitter:0,loss:0,load:tcp.load,users:tcp.users,lines:lines)
    }
    private static func measureTcp(_ node:[String:Any],attempts:Int) async -> Quality {
        let load=load(node),users=users(node)
        let endpoints=probes(node)
        guard !endpoints.isEmpty else {return Quality(latency:nil,jitter:0,loss:100,load:load,users:users)}
        var samples=[Int]()
        for attempt in 0..<attempts {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if attempt==2 && samples.isEmpty {return Quality(latency:nil,jitter:0,loss:100,load:load,users:users)}
            if let elapsed=await race(endpoints) {samples.append(elapsed)}
        }
        let loss=(attempts-samples.count)*100/attempts
        guard !samples.isEmpty else {return Quality(latency:nil,jitter:0,loss:loss,load:load,users:users)}
        let sorted=samples.sorted()
        let jitter=samples.count<2 ? 0:zip(samples,samples.dropFirst()).map {abs($0-$1)}.reduce(0,+)/(samples.count-1)
        return Quality(latency:sorted[sorted.count/2],jitter:jitter,loss:loss,load:load,users:users)
    }
    /// Long enough for one lost SYN to be resent (1 s) and still answer across a long, lossy route; mihomo's own
    /// delay test (what Clash apps show) waits 5 s, so a shorter wait called slow but working nodes unreachable.
    static let timeout:TimeInterval=3
    /// Every TCP port the node answers on (REALITY, XHTTP); older servers only send "probe".
    static func probes(_ node:[String:Any]) -> [(host:String,port:Int)] {
        let list=(node["probes"] as? [[String:Any]]) ?? [node["probe"] as? [String:Any]].compactMap {$0}
        var seen=Set<String>()
        return list.compactMap {item -> (host:String,port:Int)? in
            guard let host=item["host"] as? String,!host.isEmpty,let port=item["port"] as? Int,(1...65535).contains(port),
                  seen.insert("\(host):\(port)").inserted else {return nil}
            return (host,port)
        }
    }
    /// Connects to every port at once and takes the first answer: a network that blocks one port (often 443)
    /// still reaches the node on the other, as the app's own fallback transports would when connecting.
    private static func race(_ endpoints:[(host:String,port:Int)]) async -> Int? {
        await withTaskGroup(of:Int?.self) {group -> Int? in
            for endpoint in endpoints {
                guard let port=NWEndpoint.Port(rawValue:UInt16(endpoint.port)) else {continue}
                group.addTask {await connect(host:endpoint.host,port:port)}
            }
            for await elapsed in group {if let elapsed {group.cancelAll();return elapsed}}
            return nil
        }
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
            DispatchQueue.global().asyncAfter(deadline:.now()+timeout) {finish(nil)}
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
