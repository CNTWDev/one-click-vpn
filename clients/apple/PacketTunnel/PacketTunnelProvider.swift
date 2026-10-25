import NetworkExtension
import Network
import TunnelCore

/// The VPN: the system tun goes to the embedded mihomo core (TunnelCore, built from clients/core), which carries
/// traffic over the first transport of the node that answers (see Transports). The provider's own connections
/// (API, latency tests, the core's links to nodes) stay outside the tunnel.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    private var lifecycle:Task<Void,Never>?
    private let stateLock=NSLock()
    private var snapshot:[String:Any]=["status":"connection_confirming"]
    private func publish(_ change:(inout [String:Any])->Void) {stateLock.lock();change(&snapshot);stateLock.unlock()}
    private var api:NativeAPI?
    private var nodeId=""
    private var nodeName=""
    // Automatic mode only: the next-fastest nodes, tried when the current one cannot be reached.
    private var fallbacks:[String]=[]
    private let keys=Transports.keyPair()
    private var smart=true
    // Wall-clock times: systemUptime stops while the device sleeps, the server's lease does not.
    private var deadline=Date.distantPast
    private var renewAt=Date.distantPast
    private var leaseId=""
    private var leaseReady=false
    private var transports:[String]=[]
    private var carrying=""
    private var network=""
    private var lastProbe=Date.distantPast
    private var failures=0
    private var wokeFlag=false
    private var woke:Bool {
        get {stateLock.lock();defer {stateLock.unlock()};return wokeFlag}
        set {stateLock.lock();defer {stateLock.unlock()};wokeFlag=newValue}
    }
    private let monitor=NWPathMonitor()
    private var home:String {Shared.folder.appendingPathComponent("core").path}

    override func startTunnel(options:[String:NSObject]?,completionHandler:@escaping (Error?)->Void) {
        monitor.start(queue:.global())
        lifecycle=Task {
            do {
                guard let configuration=(protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration,let origin=configuration["origin"] as? String else {throw AccessFailure.code("SERVER_REQUIRED")}
                api=try NativeAPI(origin:origin);nodeId=configuration["nodeId"] as? String ?? "";smart=(configuration["routing"] as? String ?? "smart") != "global"
                try await Task.sleep(nanoseconds:200_000_000) // let the path monitor report the current network
                network=Transports.networkKey(monitor.currentPath)
                api?.attempt=String(UUID().uuidString.replacingOccurrences(of:"-",with:"").prefix(16)).lowercased()
                // The attempt id is also the request id of this attempt's lines in Console → 运行日志.
                Journal.add("connect: start \(api?.attempt ?? ""), network \(network), routing \(smart ? "smart":"global")")
                if nodeId.isEmpty {await chooseFastest()}
                try await setTunnelNetworkSettings(networkSettings())
                try await connectWithFallback()
                completionHandler(nil)
            } catch {
                if Task.isCancelled {Journal.add("connect: cancelled");CoreStop();completionHandler(error);return}
                var code="CONNECT_FAILED",detail=""
                if case AccessFailure.code(let known)=error {code=known}
                // Unexpected errors keep their (scrubbed) text, e.g. why the core refused its configuration.
                else {detail=Journal.scrub(error.localizedDescription)}
                Journal.add("connect: failed \(code)"+(detail.isEmpty ? "":" (\(detail))"));await report(code,detail)
                CoreStop();completionHandler(error);return
            }
            while !Task.isCancelled {
                do {try await Task.sleep(nanoseconds:2_000_000_000)} catch {return}
                await tick()
            }
        }
    }
    private func networkSettings() -> NEPacketTunnelNetworkSettings {
        let settings=NEPacketTunnelNetworkSettings(tunnelRemoteAddress:"127.0.0.1")
        // The core's tun address is the first of fake-ip-range/30; its DNS answers on the next address.
        let ipv4=NEIPv4Settings(addresses:["198.18.0.1"],subnetMasks:["255.255.255.252"]);ipv4.includedRoutes=[NEIPv4Route.default()]
        let ipv6=NEIPv6Settings(addresses:["fdfe:dcba:9876::1"],networkPrefixLengths:[126]);ipv6.includedRoutes=[NEIPv6Route.default()]
        let dns=NEDNSSettings(servers:["198.18.0.2"]);dns.matchDomains=[""]
        settings.ipv4Settings=ipv4;settings.ipv6Settings=ipv6;settings.dnsSettings=dns;settings.mtu=1500
        return settings
    }
    /// The utun descriptor the system created for this tunnel: the only utun control socket in this process.
    private func tunnelDescriptor() -> Int32? {
        var name=[CChar](repeating:0,count:Int(IFNAMSIZ))
        for fd:Int32 in 0...1024 {
            var length=socklen_t(name.count)
            // SYSPROTO_CONTROL (2), UTUN_OPT_IFNAME (2)
            if getsockopt(fd,2,2,&name,&length)==0 && String(cString:name).hasPrefix("utun") {return fd}
        }
        return nil
    }
    /// Measured before the tunnel exists (the extension's own traffic bypasses it anyway).
    /// If the list cannot be loaded the server picks the least-loaded node.
    private func chooseFastest() async {
        guard let api,let nodes=try? await api.request("nodes")["nodes"] as? [[String:Any]] else {return}
        let ranked=await Latency.rank(nodes,attempts:3)
        for item in ranked.prefix(3) {Journal.add("probe: \(item.node["name"] as? String ?? "?") \(item.quality.latency.map {"\($0) ms"} ?? "no answer"), jitter \(item.quality.jitter) ms, loss \(item.quality.loss)%")}
        let ids=ranked.compactMap {$0.node["id"] as? String}
        nodeId=ids.first ?? "";fallbacks=Array(ids.dropFirst().prefix(2))
    }
    /// In automatic mode a node that cannot be used is replaced by the next fastest one.
    private func connectWithFallback() async throws {
        while true {
            do {try await bringUp();return}
            catch AccessFailure.code(let code) where ["NODE_UNAVAILABLE","NODE_FULL","HANDSHAKE_TIMEOUT"].contains(code) && !fallbacks.isEmpty && !Task.isCancelled {await nextNode(code)}
        }
    }
    private func nextNode(_ code:String) async {
        Journal.add("switch: \(nodeName) failed (\(code)), trying the next location")
        await report(code);nodeId=fallbacks.removeFirst()
        publish {$0["status"]="connection_confirming";$0["since"]=nil}
    }
    private func bringUp() async throws {
        let started=Date()
        let lease=try await acquire(initial:true)
        guard let wireguard=Transports.wireguard(lease,privateKey:keys.privateKey) else {throw AccessFailure.code("INVALID_RESPONSE")}
        let offered=(lease["proxies"] as? [[String:Any]] ?? []).filter {Transports.ladder.contains($0["name"] as? String ?? "")}
        let proxies=[wireguard]+offered
        let blocked=Transports.blocked(network)
        transports=Transports.order(proxies.compactMap {$0["name"] as? String},blocked:blocked)
        Journal.add("node: \(nodeName), transports \(transports.joined(separator:" > "))"+(blocked.isEmpty ? "":" (blocked here before: \(blocked.sorted().joined(separator:", ")))"))
        guard let fd=tunnelDescriptor() else {throw AccessFailure.code("TUNNEL_ERROR")}
        CoreStop()
        let options=try Transports.options(proxies:proxies,order:transports,fd:fd,smart:smart)
        var failure:NSError?
        // Disconnect pressed while connecting cancels this task: stop before and after the core starts.
        try Task.checkCancellation()
        _ = CoreRun(home,options,&failure)
        if Task.isCancelled {CoreStop();throw CancellationError()}
        if failure != nil {throw AccessFailure.code("TUNNEL_ERROR")}
        if !(await probe(initial:true)) {
            // WireGuard waits for the node to add this device; give it the rest of the readiness window.
            while !leaseReady && Date().timeIntervalSince(started)<15 {try await Task.sleep(nanoseconds:1_000_000_000);leaseReady=await status()}
            guard leaseReady,await probe(initial:true) else {throw AccessFailure.code("HANDSHAKE_TIMEOUT")}
        }
        try Task.checkCancellation()
        publish {$0["status"]="connection_connected";$0["since"]=Date().timeIntervalSince1970;$0["node"]=self.nodeName;$0["nodeId"]=self.nodeId}
        Journal.add("connect: ready in \(Int(Date().timeIntervalSince(started)*1000)) ms via \(carrying)")
    }
    /// All transports at once; true when at least one answers. Failures are remembered only when another transport worked.
    private func probe(initial:Bool=false,report shouldReport:Bool?=nil) async -> Bool {
        let names=transports.joined(separator:",")
        let results=await Task.detached {Transports.parseProbe(CoreProbe(names,Transports.testURL,5000))}.value
        lastProbe=Date()
        let working=results.filter {$0.value>=0}.map {$0.key}
        // WireGuard cannot answer before the node has applied this device; that is not a block.
        let failed=results.filter {$0.value<0 && ($0.key != "wireguard" || leaseReady)}.map {$0.key}
        if initial || !failed.isEmpty {Journal.add("probe: "+transports.map {name in (results[name] ?? -1)>=0 ? "\(name) \(results[name]!) ms":"\(name) no answer"}.joined(separator:", "))}
        if !working.isEmpty {Transports.remember(network,failed:failed,working:working)}
        // Tells the server which of this node's ports answer from here (Console: 云防火墙); off the connect path.
        if shouldReport ?? initial,!working.isEmpty {
            let summary=(working.map {"\($0)=ok"}+failed.map {"\($0)=fail"}).joined(separator:",")
            Task {await report("TRANSPORT_PROBE",summary,network:network)}
        }
        updateCarrying()
        return !working.isEmpty
    }
    private func updateCarrying() {
        let now=CoreNow(Transports.group)
        if !now.isEmpty && now != carrying {if !carrying.isEmpty {Journal.add("transport: \(carrying) -> \(now)")};carrying=now}
    }
    private func status() async -> Bool {(try? await api?.request("status/\(leaseId)")["ready"] as? Bool) ?? false}
    /// Failure codes and scrubbed error texts (no keys, addresses or traffic), so operators can see which builds and nodes fail and why.
    private func report(_ code:String,_ detail:String="",network:String="") async {
        var event:[String:Any]=["code":code,"at":ISO8601DateFormatter().string(from:Date())]
        if !nodeId.isEmpty {event["nodeId"]=nodeId}
        if !detail.isEmpty {event["detail"]=detail}
        if !network.isEmpty {event["network"]=network}
        if let attempt=api?.attempt {event["attempt"]=attempt}
        _ = try? await api?.request("diagnostics",["events":[event]])
    }
    private func fail(_ code:String,_ shown:String?=nil) async {
        Journal.add("disconnect: \(code)")
        await report(code);cancelTunnelWithError(AccessFailure.code(shown ?? code))
    }
    /// A first connection with other transports waits briefly for WireGuard; without them up to 15 s. Renewals only check readiness.
    private func acquire(initial:Bool=false) async throws -> [String:Any] {
        guard let api else {throw AccessFailure.code("AUTH_REQUIRED")}
        var input:[String:Any]=["publicKey":keys.publicKey]
        if !nodeId.isEmpty {input["nodeId"]=nodeId}
        let lease=try await api.action("connect",input)
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        guard let stamp=lease["expiresAt"] as? String,let expiry=formatter.date(from:stamp) ?? ISO8601DateFormatter().date(from:stamp),
              let id=lease["leaseId"] as? String,let node=lease["nodeId"] as? String else {throw AccessFailure.code("INVALID_RESPONSE")}
        let remaining=min(300,expiry.timeIntervalSinceNow)
        guard remaining>0 else {throw AccessFailure.code("ACCESS_EXPIRED")}
        deadline=Date().addingTimeInterval(remaining);renewAt=Date().addingTimeInterval(90)
        nodeId=node;nodeName=lease["nodeName"] as? String ?? "";leaseId=id;leaseReady=lease["ready"] as? Bool == true
        if !initial {if !leaseReady {leaseReady=await status()};return lease}
        let spare = !((lease["proxies"] as? [Any]) ?? []).isEmpty
        var attempt=0
        while !leaseReady && attempt<(spare ? 3:15) {
            try await Task.sleep(nanoseconds:1_000_000_000);leaseReady=await status();attempt+=1
        }
        if !leaseReady && !spare {throw AccessFailure.code("NODE_UNAVAILABLE")}
        Journal.add(leaseReady ? "lease: WireGuard ready":"lease: WireGuard pending, starting on the other transports")
        return lease
    }
    private func tick() async {
        if woke {woke=false;renewAt=Date.distantPast;lastProbe=Date.distantPast}
        // After sleep the lease may already have lapsed: one renewal attempt before closing the tunnel.
        if Date()>=renewAt || Date()>=deadline {
            do {_ = try await acquire()}
            catch AccessFailure.code(let code) where ["AUTH_REQUIRED","DEVICE_REVOKED","DEVICE_LIMIT_REACHED","MEMBERSHIP_EXPIRED","QUOTA_EXHAUSTED","ACCOUNT_UNAVAILABLE","MANAGED_ACCESS_REQUIRED","CLIENT_UPDATE_REQUIRED"].contains(code) {await fail(code);return}
            catch {Journal.add("lease: renewal failed, retrying");renewAt=Date().addingTimeInterval(15)}
            if Date()>=deadline {await fail("LEASE_RENEWAL_FAILED","ACCESS_EXPIRED");return}
        } else if !leaseReady,await status() {
            // WireGuard became usable: test it now so traffic moves to the lightest transport right away.
            leaseReady=true;Journal.add("lease: WireGuard ready");_ = await probe(report:true)
        }
        let current=Transports.networkKey(monitor.currentPath)
        if current != network && current != "unknown" {Journal.add("network: changed to \(current)");network=current;lastProbe=Date.distantPast}
        if Date().timeIntervalSince(lastProbe)>30 {
            if await probe() {failures=0}
            else {
                failures+=1
                if failures>=2 {
                    Journal.add("probe: no transport answers")
                    guard !fallbacks.isEmpty else {await fail("HANDSHAKE_TIMEOUT","NODE_UNAVAILABLE");return}
                    await nextNode("HANDSHAKE_TIMEOUT")
                    do {try await connectWithFallback();failures=0}
                    catch AccessFailure.code(let code) {await fail(code);return}
                    catch {await fail("TUNNEL_ERROR","NODE_UNAVAILABLE");return}
                }
            }
            publish {$0["status"]=self.failures==0 ? "connection_connected":"connection_confirming"}
        } else {updateCarrying()}
        let rate=CoreRate().split(separator:" ").compactMap {Int($0)}
        if rate.count==2 {publish {$0["tx"]=rate[0];$0["rx"]=rate[1]}}
    }
    // Renew immediately after sleep instead of waiting out a stale refresh timer.
    override func wake() {woke=true}
    /// The app polls this for its status line: status key, node, connected-since and current speed.
    override func handleAppMessage(_ messageData:Data,completionHandler:((Data?)->Void)?) {
        stateLock.lock();let state=snapshot;stateLock.unlock()
        completionHandler?(try? JSONSerialization.data(withJSONObject:state))
    }
    override func stopTunnel(with reason:NEProviderStopReason,completionHandler:@escaping ()->Void) {
        lifecycle?.cancel();lifecycle=nil;monitor.cancel()
        Journal.add("disconnect: stopped (\(reason.rawValue))")
        CoreStop()
        if let api {Task {_ = try? await api.action("disconnect",[:]);completionHandler()}} else {completionHandler()}
    }
}
