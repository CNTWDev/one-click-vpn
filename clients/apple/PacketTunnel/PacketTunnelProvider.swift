import NetworkExtension
import Network
import TunnelCore

/// The VPN: the system tun goes to the embedded mihomo core (TunnelCore, built from clients/core), which carries
/// traffic over the first transport of the node that answers (see Transports). The provider's own connections
/// (API, latency tests, the core's links to nodes) stay outside the tunnel.
///
/// Once connected it stays connected until the user disconnects or the account is refused: a lost network or a
/// node that stops answering puts it in "reconnecting" and it retries with backoff; without any network it waits
/// for the path monitor instead of probing. Automatic mode moves to the fastest location that answers; a location
/// the user chose is retried. On iPhone the app turns on On Demand while the user wants the VPN, so iOS starts the
/// tunnel again if it was killed; a refusal is remembered (Shared.refused) so those restarts stop at once.
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
    /// Location id -> protocol, from the app (advanced protocol lock).
    private var locks:[String:String]=[:]
    /// The person's routing rules, from the app (advanced).
    private var rules:[String]=[]
    // Wall-clock times: systemUptime stops while the device sleeps, the server's lease does not.
    private var deadline=Date.distantPast
    private var renewAt=Date.distantPast
    private var renewedAt=Date.distantPast
    /// Keep a working tunnel this long when the server cannot be reached to renew the lease (it is down or blocked);
    /// the node keeps the lease alive on its side for as long (Agent offline grace).
    private let offlineGrace:TimeInterval=12*3600
    private var leaseId=""
    private var leaseReady=false
    private var transports:[String]=[]
    private var carrying=""
    private var network=""
    private var nextProbe=Date.distantPast
    private var failures=0
    /// The user left the location to the app: when it stops answering, the tunnel moves to the fastest one.
    private var automatic=true
    private var online=true
    private var lastNetworkCheck=Date.distantPast
    private var changedFlag=false
    private var networkChanged:Bool {
        get {stateLock.lock();defer {stateLock.unlock()};return changedFlag}
        set {stateLock.lock();defer {stateLock.unlock()};changedFlag=newValue}
    }
    /// Probe interval while the connection works; the core's fallback group reacts to failed dials in between.
    private let healthy:TimeInterval=120
    /// After connecting, when every transport is tested (the connect probe stops at the first that works).
    private let fullProbe:TimeInterval=10
    /// The next full probe reports to the server (the connect probe did not test every transport).
    private var reportNext=false
    /// Connecting in automatic mode stops measuring locations this long after the first one answered.
    private let settle:TimeInterval=1.5
    /// Waits between retries while nothing answers; the last repeats for as long as the user leaves the VPN on.
    private let retries:[TimeInterval]=[5,15,30,60,300]
    private var wokeFlag=false
    private var woke:Bool {
        get {stateLock.lock();defer {stateLock.unlock()};return wokeFlag}
        set {stateLock.lock();defer {stateLock.unlock()};wokeFlag=newValue}
    }
    private let monitor=NWPathMonitor()
    /// The watchdog (core Health) looks at the user's traffic on every tick; a stall is handled at most this often.
    private var lastStall=Date.distantPast
    private let stallSpacing:TimeInterval=20
    /// Locations that failed the user's traffic here: automatic mode does not move back to them for a while.
    private var badNodes=[String:Date]()
    private let badFor:TimeInterval=15*60
    /// Automatic moves in the last 10 minutes; after 3 the tunnel stays where it is (no flapping between locations).
    private var moves=[Date]()
    /// This connection session, summed up for the staged-rollout health check (Console → 客户端发布) and sent once,
    /// as CONNECT_SESSION, when it ends: never an address, a node name or traffic.
    private var sessionUp:Date?
    private var sessionMs=0
    private var sessionLine=""
    private var sessionFallbacks=0
    private var sessionDrops=0
    private var sessionNet=""
    private var sessionSent=false
    private var home:String {Shared.folder.appendingPathComponent("core").path}

    override func startTunnel(options:[String:NSObject]?,completionHandler:@escaping (Error?)->Void) {
        monitor.pathUpdateHandler={[weak self] _ in self?.networkChanged=true}
        monitor.start(queue:.global())
        // Started by the app (or Shortcuts); otherwise by iOS On Demand, after it killed the tunnel or at a network change.
        let fromApp=options?["fromApp"] != nil
        lifecycle=Task {
            do {
                if fromApp {Shared.refused=nil}
                else if let refused=Shared.refused {throw AccessFailure.code(refused)} // the user must sign in or act in the app first
                guard let configuration=(protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration,let origin=configuration["origin"] as? String else {throw AccessFailure.code("SERVER_REQUIRED")}
                #if os(macOS)
                // Handed over by the app (see SecureStorage.handed); a start from System Settings has none.
                guard let token=options?["token"] as? Data,let identity=options?["identity"] as? Data else {throw AccessFailure.code("CONNECT_FROM_APP_FIRST")}
                SecureStorage.handed=["token":token,"identity":identity]
                #endif
                api=try NativeAPI(origin:origin);nodeId=configuration["nodeId"] as? String ?? "";automatic=nodeId.isEmpty;smart=(configuration["routing"] as? String ?? "smart") != "global"
                locks=configuration["locks"] as? [String:String] ?? [:];rules=configuration["rules"] as? [String] ?? []
                try await Task.sleep(nanoseconds:200_000_000) // let the path monitor report the current network
                network=Transports.networkKey(monitor.currentPath);online=Transports.online(monitor.currentPath);networkChanged=false
                sessionNet=String(network.split(separator:":").first ?? "unknown")
                let began=Date()
                api?.attempt=String(UUID().uuidString.replacingOccurrences(of:"-",with:"").prefix(16)).lowercased()
                // The attempt id is also the request id of this attempt's lines in Console → 运行日志.
                Journal.add("connect: start \(api?.attempt ?? ""), network \(network), routing \(smart ? "smart":"global")")
                let request=api?.attempt ?? "";publish {$0["request"]=request;$0["bypass"]=""}
                if nodeId.isEmpty {await chooseFastest()}
                try await setTunnelNetworkSettings(networkSettings())
                try await connectWithFallback()
                sessionConnected(began)
                completionHandler(nil)
            } catch {
                if Task.isCancelled {Journal.add("connect: cancelled");await endSession(failed:false);CoreStop();completionHandler(error);return}
                var code="CONNECT_FAILED",detail=""
                if case AccessFailure.code(let known)=error {code=known}
                // Unexpected errors keep their (scrubbed) text, e.g. why the core refused its configuration.
                else {detail=Journal.scrub(error.localizedDescription)}
                Journal.add("connect: failed \(code)"+(detail.isEmpty ? "":" (\(detail))"));await report(code,detail);await endSession(failed:true)
                if Shared.fatal.contains(code) {Shared.refused=code}
                // The app reads the code (fetchLastDisconnectError) to say why and to stop keeping the VPN on.
                CoreStop();completionHandler(NSError(domain:Shared.errorDomain,code:1,userInfo:["code":code]));return
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
        let ranked=await Latency.rank(AIExit.usable(nodes),attempts:3,reuse:60,settle:settle)
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
        let failed=nodeName
        await report(code);nodeId=fallbacks.removeFirst();sessionFallbacks+=1
        // The app shows one line about the switch ("Tokyo 03 did not answer, switched to Tokyo 05").
        publish {$0["status"]="connection_confirming";$0["since"]=nil;$0["switchedFrom"]=failed;$0["phase"]=0}
    }
    private func bringUp() async throws {
        let started=Date()
        // The app shows where connecting is: finding the route (0), opening the tunnel (1), confirming (2).
        publish {$0["phase"]=0}
        let lease=try await acquire(initial:true)
        guard let wireguard=Transports.wireguard(lease,privateKey:keys.privateKey) else {throw AccessFailure.code("INVALID_RESPONSE")}
        let offered=(lease["proxies"] as? [[String:Any]] ?? []).filter {Transports.ladder.contains($0["name"] as? String ?? "")}
        let proxies=[wireguard]+offered
        let blocked=Transports.blocked(network)
        // A location locked to one protocol (advanced) uses only that protocol's transports.
        let locked=locks[nodeId] ?? ""
        transports=Advanced.apply(Transports.order(proxies.compactMap {$0["name"] as? String},blocked:blocked),locked:locked)
        Journal.add("node: \(nodeName), transports \(transports.joined(separator:" > "))"+(blocked.isEmpty ? "":" (blocked here before: \(blocked.sorted().joined(separator:", ")))")+(locked.isEmpty ? "":" (locked to \(locked))"))
        let lines=transports.count
        publish {$0["phase"]=1;$0["lines"]=lines}
        guard let fd=tunnelDescriptor() else {throw AccessFailure.code("TUNNEL_ERROR")}
        CoreStop()
        let options=try Transports.options(proxies:proxies,order:transports,fd:fd,smart:smart,rules:rules)
        var failure:NSError?
        // Disconnect pressed while connecting cancels this task: stop before and after the core starts.
        try Task.checkCancellation()
        _ = CoreRun(home,options,&failure)
        if Task.isCancelled {CoreStop();throw CancellationError()}
        if failure != nil {throw AccessFailure.code("TUNNEL_ERROR")}
        publish {$0["phase"]=2}
        if !(await probe(initial:true)) {
            // WireGuard waits for the node to add this device; give it the rest of the readiness window.
            while !leaseReady && Date().timeIntervalSince(started)<15 {try await Task.sleep(nanoseconds:1_000_000_000);leaseReady=await status()}
            guard leaseReady,await probe(initial:true) else {throw AccessFailure.code("HANDSHAKE_TIMEOUT")}
        }
        try Task.checkCancellation()
        publish {$0["status"]="connection_connected";$0["since"]=Date().timeIntervalSince1970;$0["node"]=self.nodeName;$0["nodeId"]=self.nodeId}
        Journal.add("connect: ready in \(Int(Date().timeIntervalSince(started)*1000)) ms via \(carrying)")
        // The connect probe stopped at the first transport: test them all shortly, off the connect path, for the
        // transport memory and the report to the server.
        nextProbe=Date().addingTimeInterval(fullProbe);reportNext=true
    }
    /// All transports at once; true when at least one answers. Failures are remembered only when another transport worked.
    /// The connect probe (initial) returns as soon as traffic has a transport (CoreProbeFirst); the others are not waited for.
    private func probe(initial:Bool=false,report shouldReport:Bool=false) async -> Bool {
        let names=transports.joined(separator:",")
        let results=await Task.detached {Transports.parseProbe(initial ? CoreProbeFirst(names,Transports.group,Transports.testURL,5000):CoreProbe(names,Transports.testURL,5000))}.value
        let working=results.filter {$0.value>=0}.map {$0.key}
        // WireGuard cannot answer before the node has applied this device; that is not a block.
        let failed=results.filter {$0.value<0 && ($0.key != "wireguard" || leaseReady)}.map {$0.key}
        if initial || !failed.isEmpty {Journal.add("probe: "+transports.map {name in results[name].map {$0>=0 ? "\(name) \($0) ms":"\(name) no answer"} ?? "\(name) not waited for"}.joined(separator:", "))}
        if !working.isEmpty {Transports.remember(network,failed:failed,working:working)}
        // Tells the server which of this node's ports answer from here (Console: 云防火墙); off the connect path.
        if shouldReport || reportNext,!initial,!working.isEmpty {
            reportNext=false
            let summary=(working.map {"\($0)=ok"}+failed.map {"\($0)=fail"}).joined(separator:",")
            Task {await report("TRANSPORT_PROBE",summary,network:network)}
        }
        updateCarrying()
        return !working.isEmpty
    }
    private func sessionConnected(_ began:Date) {
        sessionUp=Date()
        sessionMs=Int(Date().timeIntervalSince(began)*1000)
        sessionLine=carrying
        if let first=transports.first,!carrying.isEmpty,carrying != first {sessionFallbacks+=1}
    }
    /// Sends the session once: ok when it connected at all, else failed (an error) or cancelled (the user stopped it).
    private func endSession(failed:Bool) async {
        guard !sessionSent else {return}
        sessionSent=true
        var outcome="cancelled"
        var seconds=0
        if let up=sessionUp {outcome="ok";seconds=Int(Date().timeIntervalSince(up))} else if failed {outcome="failed"}
        let ms=sessionUp == nil ? -1:sessionMs
        let line=sessionLine.isEmpty ? "-":sessionLine
        let net=sessionNet.isEmpty ? "unknown":sessionNet
        let parts:[String]=["outcome=\(outcome)","ms=\(ms)","line=\(line)","fallbacks=\(sessionFallbacks)","drops=\(sessionDrops)","seconds=\(seconds)","net=\(net)"]
        await report("CONNECT_SESSION",parts.joined(separator:" "))
    }
    private func updateCarrying() {
        let now=CoreNow(Transports.group)
        if !now.isEmpty && now != carrying {if !carrying.isEmpty {Journal.add("transport: \(carrying) -> \(now)")};carrying=now}
        // A line the network forced, said once on the connect page: Hysteria2 (UDP) failed here while another works,
        // or 443 failed and the spare port carries traffic. The transport memory holds what failed on this network.
        let blocked=carrying.isEmpty || carrying == "hysteria2" ? []:Transports.blocked(network)
        let bypass=blocked.contains("hysteria2") && transports.contains("hysteria2") ? "udp:\(carrying)":carrying == "reality-alt" && blocked.contains("reality") ? "port":""
        publish {$0["bypass"]=bypass}
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
    /// Closes the tunnel for good. The app reads the code (fetchLastDisconnectError) to show why and to stop
    /// reconnecting; a refusal also stops On Demand restarts until the user acts in the app.
    private func fail(_ code:String,_ shown:String?=nil) async {
        Journal.add("disconnect: \(code)")
        if Shared.fatal.contains(code) {Shared.refused=code}
        await report(code);await endSession(failed:true);cancelTunnelWithError(NSError(domain:Shared.errorDomain,code:1,userInfo:["code":shown ?? code]))
    }
    /// A first connection with other transports does not wait for WireGuard (they carry traffic until it is ready;
    /// tick switches then); without them it waits up to 15 s. Renewals only check readiness.
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
        deadline=Date().addingTimeInterval(remaining);renewAt=Date().addingTimeInterval(90);renewedAt=Date()
        nodeId=node;nodeName=lease["nodeName"] as? String ?? "";leaseId=id;leaseReady=lease["ready"] as? Bool == true
        if !initial {if !leaseReady {leaseReady=await status()};return lease}
        let spare = !((lease["proxies"] as? [Any]) ?? []).isEmpty
        var attempt=0
        while !leaseReady && attempt<(spare ? 0:15) {
            try await Task.sleep(nanoseconds:1_000_000_000);leaseReady=await status();attempt+=1
        }
        if !leaseReady && !spare {throw AccessFailure.code("NODE_UNAVAILABLE")}
        Journal.add(leaseReady ? "lease: WireGuard ready":"lease: WireGuard pending, starting on the other transports")
        return lease
    }
    private func tick() async {
        if woke {woke=false;renewAt=Date.distantPast;nextProbe=Date.distantPast}
        // The path monitor's report, with a 30 s check as a safety net.
        if networkChanged || Date().timeIntervalSince(lastNetworkCheck)>30 {lastNetworkCheck=Date();networkChanged=false;checkNetwork()}
        // A refusal (account, device, quota) closes the tunnel. When the server cannot be reached the tunnel stays
        // while it still carries traffic, up to offlineGrace after the last renewal; probes decide.
        if online && Date()>=renewAt {
            do {_ = try await acquire()}
            catch AccessFailure.code(let code) where Shared.fatal.contains(code) {await fail(code);return}
            catch {Journal.add("lease: renewal failed, retrying");renewAt=Date().addingTimeInterval(Date().timeIntervalSince(renewedAt)<300 ? 15:60)}
        } else if online && !leaseReady,await status() {
            // WireGuard became usable: test it now so the fallback group can count on it right away.
            leaseReady=true;Journal.add("lease: WireGuard ready");_ = await probe(report:true)
        }
        if Date().timeIntervalSince(renewedAt)>=offlineGrace {await fail("LEASE_RENEWAL_FAILED","ACCESS_EXPIRED");return}
        if !online {
            // Nothing to reach: no probes (they would only drain the battery) until the path monitor reports a network.
            publish {$0["status"]="waiting_for_network"}
        } else if Date()>=nextProbe {
            if await probe() {
                if failures>=2 {Journal.add("reconnect: \(nodeName) answers again via \(carrying)")}
                failures=0;nextProbe=Date().addingTimeInterval(healthy)
            } else {await missed()}
            let shown=message()
            // While reconnecting: which attempt this is and when the next one starts.
            let attempt=failures,next=failures>0 ? nextProbe.timeIntervalSince1970:nil
            publish {$0["status"]=shown;$0["attempt"]=attempt;$0["retryAt"]=next}
        } else {
            updateCarrying()
            if failures==0 {AIExit.note()}
            if failures==0,Date().timeIntervalSince(lastStall)>=stallSpacing,
               await Task.detached(operation:{CoreHealth(Transports.group)}).value.hasPrefix("stalled") {await stalled()}
        }
        let rate=CoreRate().split(separator:" ").compactMap {Int($0)}
        if rate.count==2 {publish {$0["tx"]=rate[0];$0["rx"]=rate[1]}}
    }
    /// Online state, transport memory key, and a clean start on a new network: old connections would hang.
    private func checkNetwork() {
        let path=monitor.currentPath
        let wasOnline=online;online=Transports.online(path)
        let current=Transports.networkKey(path)
        guard current != network || online != wasOnline else {return}
        Journal.add(online ? "network: changed to \(current)":"network: none")
        if current != "unknown" {network=current}
        guard online else {return}
        CoreReset()
        // Retry right away and restart the backoff; a renewal that failed meanwhile is due now too.
        nextProbe=Date.distantPast;failures=min(failures,1)
        if Date().timeIntervalSince(renewedAt)>90 {renewAt=Date.distantPast}
    }
    /// The user's traffic stopped coming back while the lines still answer probes (a stuck DNS connection, a line
    /// that passes a small test page but not real traffic): close what hangs, check the path the traffic takes, then
    /// keep the lines that fail it out of use and, when none carries traffic, treat it as a drop (automatic: move).
    private func stalled() async {
        lastStall=Date()
        let line=carrying
        Journal.add("watchdog: traffic stalled via \(line)")
        CoreReset()
        if await checkPath() {
            Journal.add("watchdog: recovered after closing stuck connections");await report("STALL","recovered=reset line=\(line)");return
        }
        // Nothing answers outside the tunnel either: the network is down (or a sign-in page), not the location.
        let local=await Task.detached {CoreProbe("DIRECT",Transports.localURL,3000)}.value
        if Int(local.split(separator:"=").last ?? "") ?? -1 < 0 {Journal.add("watchdog: the network itself does not answer, waiting");return}
        let names=transports.joined(separator:",")
        let results=await Task.detached {Transports.parseProbe(CoreCheckEach(names,Transports.checkURL,5000))}.value
        let failed=results.filter {$0.value<0}.map {$0.key},working=transports.filter {(results[$0] ?? -1)>=0}
        Journal.add("watchdog: "+transports.map {"\($0) \((results[$0] ?? -1)>=0 ? "ok":"fails")"}.joined(separator:", "))
        if !failed.isEmpty {CoreSuspend(Transports.group,failed.joined(separator:","),600)}
        if !working.isEmpty {
            CoreReset();updateCarrying()
            Journal.add("watchdog: moved to \(carrying)");await report("STALL","recovered=line line=\(line)");return
        }
        Journal.add("watchdog: no line carries traffic");await report("STALL","recovered=no line=\(line)")
        if sessionUp != nil {sessionDrops+=1}
        failures=2;nextProbe=Date().addingTimeInterval(retries[1])
        if automatic {await moveToFastest()}
        let shown=message(),attempt=failures,next=failures>0 ? nextProbe.timeIntervalSince1970:nil
        publish {$0["status"]=shown;$0["attempt"]=attempt;$0["retryAt"]=next}
    }
    /// The path the user's traffic takes: a fresh lookup through the tunnel's DNS and a 64 KB download through the group.
    private func checkPath() async -> Bool {
        let result=await Task.detached {CoreCheck(Transports.group,Transports.checkURL,5000,true)}.value
        let values=Transports.parseProbe(result)
        return (values["dns"] ?? -1)>=0 && (values["web"] ?? -1)>=0
    }
    /// A round where no transport answered while the device has a network.
    private func missed() async {
        failures+=1;nextProbe=Date().addingTimeInterval(retries[min(max(failures-1,0),retries.count-1)])
        guard failures>=2 else {return}
        if failures==2 {Journal.add("probe: no transport answers, reconnecting");await report("HANDSHAKE_TIMEOUT");if sessionUp != nil {sessionDrops+=1}}
        if automatic {await moveToFastest()}
    }
    /// Automatic mode: measures every location now and moves to the fastest one that answers, if it is another.
    private func moveToFastest() async {
        guard let api,let nodes=try? await api.request("nodes")["nodes"] as? [[String:Any]] else {Journal.add("switch: no location list, retrying");return}
        // The location that failed stays out for a while (its port may still answer the measurement below), and so do
        // others that failed here recently. Three moves in 10 minutes are the most: then stay and keep retrying.
        let now=Date()
        badNodes[nodeId]=now.addingTimeInterval(badFor);badNodes=badNodes.filter {$0.value>now}
        moves=moves.filter {now.timeIntervalSince($0)<600}
        guard moves.count<3 else {Journal.add("switch: moved 3 times in 10 minutes, staying");return}
        let candidates=AIExit.usable(nodes.filter {badNodes[$0["id"] as? String ?? ""]==nil})
        // While AI services are in use, a location in the same country first: AI accounts get flagged when the exit jumps.
        let current=nodes.first(where:{($0["id"] as? String)==nodeId});let country=current?["countryCode"] as? String ?? ""
        let same=CoreAIActive(1800) && !country.isEmpty ? candidates.filter {($0["countryCode"] as? String)==country}:[]
        if !same.isEmpty {Journal.add("switch: AI in use, trying \(country) first")}
        var best:[String:Any]?=nil
        for group in [same,candidates] where best==nil && !group.isEmpty {
            best=await Latency.rank(group,attempts:1,reuse:0,settle:settle).first(where:{$0.quality.latency != nil})?.node
        }
        guard let best,let id=best["id"] as? String else {Journal.add("switch: no other location answers, retrying");return}
        guard id != nodeId else {return}
        moves.append(now)
        Journal.add("switch: \(nodeName) failed (HANDSHAKE_TIMEOUT), moving to \(best["name"] as? String ?? "?")")
        let from=nodeName,previous=nodeId
        nodeId=id
        do {
            try await bringUp()
            publish {$0["switchedFrom"]=from}
            failures=0
            // The new location must carry real traffic, not only answer the connect probe.
            if !(await checkPath()) {
                Journal.add("switch: \(nodeName) connected but carries no traffic")
                badNodes[id]=Date().addingTimeInterval(badFor);failures=2;nextProbe=Date().addingTimeInterval(retries[0])
            }
        } catch AccessFailure.code(let code) where Shared.fatal.contains(code) {
            await fail(code)
        } catch AccessFailure.code("HANDSHAKE_TIMEOUT") {
            Journal.add("switch: failed HANDSHAKE_TIMEOUT, retrying")
        } catch {
            // The lease request did not reach the server: the tunnel still runs on the previous location.
            nodeId=previous;Journal.add("switch: failed, retrying")
        }
    }
    private func message() -> String {
        if !online {return "waiting_for_network"}
        switch failures {
        case 0:return "connection_connected"
        case 1:return "connection_confirming"
        default:return automatic ? "reconnecting_status":"location_retrying"
        }
    }
    // Renew immediately after sleep instead of waiting out a stale refresh timer.
    override func wake() {woke=true}
    /// The app polls this for its status line: status key, node, connected-since and current speed. On the Mac the
    /// tunnel's own log lives in root's container, so the app's log page asks for it ("journal") here.
    override func handleAppMessage(_ messageData:Data,completionHandler:((Data?)->Void)?) {
        switch String(decoding:messageData,as:UTF8.self) {
        case "journal":completionHandler?(Data(Journal.read().utf8));return
        case "journal-clear":Journal.clear();completionHandler?(nil);return
        // The activity view: kept by the core in memory while connected, cleared when it stops.
        case "activity":completionHandler?(Data(CoreActivity().utf8));return
        // The speed test ("Test speed"): run by the core here, through the transport carrying traffic now; the app polls.
        case let message where message.hasPrefix("speed start "):completionHandler?(Data(CoreSpeedStart(String(message.dropFirst(12))).utf8));return
        case "speed progress":completionHandler?(Data(CoreSpeedProgress().utf8));return
        case "speed stop":CoreSpeedStop();completionHandler?(nil);return
        case "status-line":completionHandler?(Data(CoreNow(Transports.group).utf8));return
        // The person's own rules changed in the app (the activity view's menu, the rules page): applied at once, no reconnect.
        case let message where message.hasPrefix("rules "):
            let json=String(message.dropFirst(6))
            var failure:NSError?
            let ok=CoreSetRules(json,&failure)
            if ok,let lines=try? JSONSerialization.jsonObject(with:Data(json.utf8)) as? [String] {rules=lines}
            if !ok {Journal.add("rules: not applied (\(failure?.localizedDescription ?? "?"))")}
            completionHandler?(Data((ok ? "ok":"failed").utf8));return
        case let message where message.hasPrefix("close "):CoreCloseConnection(String(message.dropFirst(6)));completionHandler?(nil);return
        case let message where message.hasPrefix("closehost "):
            let parts=message.split(separator:" ")
            if parts.count==3 {_ = CoreCloseHost(String(parts[1]),parts[2]=="1")}
            completionHandler?(nil);return
        case let message where message.hasPrefix("check "):
            // The connection check, timed from here so every leg leaves through the right path: the small page and the
            // node outside the tunnel (DIRECT), the test page through the transport carrying traffic now.
            let address=String(message.dropFirst(6))
            Task.detached {
                let delay={(result:String)->Int in Int(result.split(separator:"=").last ?? "") ?? -1}
                let local=delay(CoreProbe("DIRECT",Transports.localURL,3000))
                let node=address.isEmpty ? -1:CoreReach(address,3000)
                let current=CoreNow(Transports.group)
                let web=current.isEmpty ? -1:delay(CoreProbe(current,Transports.testURL,5000))
                completionHandler?(try? JSONSerialization.data(withJSONObject:["local":local,"node":node,"web":web]))
            }
            return
        default:break
        }
        stateLock.lock();let state=snapshot;stateLock.unlock()
        completionHandler?(try? JSONSerialization.data(withJSONObject:state))
    }
    override func stopTunnel(with reason:NEProviderStopReason,completionHandler:@escaping ()->Void) {
        lifecycle?.cancel();lifecycle=nil;monitor.cancel()
        Journal.add("disconnect: stopped (\(reason.rawValue))")
        CoreStop()
        if let api {Task {await endSession(failed:false);_ = try? await api.action("disconnect",[:]);completionHandler()}} else {completionHandler()}
    }
}
