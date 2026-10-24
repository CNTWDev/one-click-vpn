import Foundation
import Network

/// "Automatic" location: the lowest TCP connect time to each node's probe port, measured from this device.
enum Latency {
    /// Best of two connects in milliseconds; nil when the node has no probe or does not answer.
    static func measure(_ node:[String:Any]) async -> Int? {
        guard let probe=node["probe"] as? [String:Any],let host=probe["host"] as? String,!host.isEmpty,
              let number=probe["port"] as? Int,(1...65535).contains(number),let port=NWEndpoint.Port(rawValue:UInt16(number)) else {return nil}
        var best:Int?
        // The first attempt may include DNS; the second is the plain round trip.
        for _ in 0..<2 {if let elapsed=await connect(host:host,port:port) {best=min(best ?? elapsed,elapsed)}}
        return best
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
    /// Fastest first; unmeasured nodes follow in the server's least-loaded order.
    static func rank(_ nodes:[[String:Any]]) async -> [(node:[String:Any],ms:Int?)] {
        let measured=await withTaskGroup(of:(Int,Int?).self) {group -> [Int:Int] in
            for (index,node) in nodes.enumerated() {group.addTask {(index,await measure(node))}}
            var results=[Int:Int]()
            for await (index,ms) in group {if let ms {results[index]=ms}}
            return results
        }
        return nodes.indices.sorted {(measured[$0] ?? Int.max,$0)<(measured[$1] ?? Int.max,$1)}.map {(node:nodes[$0],ms:measured[$0])}
    }
}
