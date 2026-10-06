import NetworkExtension
import WireGuardKit

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private lazy var adapter=WireGuardAdapter(with:self) {_,_ in /* Never log tunnel configuration or keys. */}
    private var lifecycle:Task<Void,Never>?
    // Wall-clock times: systemUptime stops while the device sleeps, the server's lease does not.
    private var deadline=Date.distantPast
    private let stateLock=NSLock()
    private var statusText="connection_confirming"
    private var state:String {
        get {stateLock.lock();defer {stateLock.unlock()};return statusText}
        set {stateLock.lock();defer {stateLock.unlock()};statusText=newValue}
    }
    private var api:NativeAPI?
    private var nodeId=""
    private let privateKey=PrivateKey()
    private var graceUntil=Date.distantPast
    private var wokeFlag=false
    private var woke:Bool {
        get {stateLock.lock();defer {stateLock.unlock()};return wokeFlag}
        set {stateLock.lock();defer {stateLock.unlock()};wokeFlag=newValue}
    }
    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        lifecycle=Task {
            do {
                guard let configuration=(protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration,let origin=configuration["origin"] as? String else {throw AccessFailure.code("SERVER_REQUIRED")}
                api=try NativeAPI(origin:origin);nodeId=configuration["nodeId"] as? String ?? ""
                let tunnel=try await acquire()
                try Task.checkCancellation()
                try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Void,Error>) in adapter.start(tunnelConfiguration:tunnel) {error in if let error {continuation.resume(throwing:error)} else {continuation.resume()}}}
                graceUntil=Date().addingTimeInterval(45);completionHandler(nil)
            } catch {
                if case AccessFailure.code(let code)=error {await report(code)} else {await report("CONNECT_FAILED")}
                completionHandler(error);return
            }
            var refresh=Date().addingTimeInterval(90)
            while !Task.isCancelled {
                do {try await Task.sleep(nanoseconds:5_000_000_000)} catch {return}
                if woke {woke=false;refresh=.distantPast;graceUntil=Date().addingTimeInterval(45)}
                // An expired lease (e.g. after sleep) gets one renewal attempt before the tunnel closes.
                if Date()>=refresh || Date()>=deadline {
                    do {_ = try await acquire();refresh=Date().addingTimeInterval(90);graceUntil=max(graceUntil,Date().addingTimeInterval(45))}
                    catch AccessFailure.code(let code) where ["AUTH_REQUIRED","DEVICE_REVOKED","MEMBERSHIP_EXPIRED","ACCOUNT_UNAVAILABLE","MANAGED_ACCESS_REQUIRED","CLIENT_UPDATE_REQUIRED"].contains(code) {await fail(code);return}
                    catch {
                        if Date()>=deadline {await fail("LEASE_RENEWAL_FAILED","ACCESS_EXPIRED");return}
                        refresh=Date().addingTimeInterval(15)
                    }
                }
                let raw=await withCheckedContinuation {continuation in adapter.getRuntimeConfiguration {continuation.resume(returning:$0 ?? "")}}
                let latest=raw.components(separatedBy:"\n").compactMap {line -> Double? in
                    guard line.hasPrefix("last_handshake_time_sec=") else {return nil};return Double(line.dropFirst("last_handshake_time_sec=".count))
                }.max() ?? 0
                if latest>0 && Date().timeIntervalSince1970-latest<180 {state="connection_connected"}
                else {state="connection_confirming";if Date()>graceUntil {await fail("HANDSHAKE_TIMEOUT","NODE_UNAVAILABLE");return}}
            }
        }
    }
    /// Failure codes only (no keys, addresses or traffic), so operators can see which builds and nodes fail.
    private func report(_ code:String) async {
        let formatter=ISO8601DateFormatter();var event:[String:Any]=["code":code,"at":formatter.string(from:Date())]
        if !nodeId.isEmpty {event["nodeId"]=nodeId}
        _ = try? await api?.request("diagnostics",["events":[event]])
    }
    private func fail(_ code:String,_ shown:String?=nil) async {
        await report(code);cancelTunnelWithError(AccessFailure.code(shown ?? code))
    }
    private func acquire() async throws -> TunnelConfiguration {
        guard let api else {throw AccessFailure.code("AUTH_REQUIRED")}
        var input:[String:Any]=["publicKey":privateKey.publicKey.base64Key]
        if !nodeId.isEmpty {input["nodeId"]=nodeId}
        let lease=try await api.action("connect",input)
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        guard let stamp=lease["expiresAt"] as? String,let expiry=formatter.date(from:stamp),let leaseId=lease["leaseId"] as? String,
              let node=lease["nodeId"] as? String,let wg=lease["wireguard"] as? [String:Any],let address=wg["address"] as? String,
              let range=IPAddressRange(from:address),let key=wg["serverPublicKey"] as? String,let publicKey=PublicKey(base64Key:key),
              let endpoint=wg["endpoint"] as? String,let remote=Endpoint(from:endpoint),let dns=wg["dns"] as? [String] else {throw AccessFailure.code("INVALID_RESPONSE")}
        let remaining=min(300,expiry.timeIntervalSinceNow)
        guard remaining>0 else {throw AccessFailure.code("ACCESS_EXPIRED")}
        deadline=Date().addingTimeInterval(remaining);nodeId=node
        var ready=false
        for _ in 0..<15 {
            if try await api.request("status/\(leaseId)")["ready"] as? Bool == true {ready=true;break}
            try await Task.sleep(nanoseconds:1_000_000_000)
        }
        guard ready else {throw AccessFailure.code("NODE_UNAVAILABLE")}
        var interface=InterfaceConfiguration(privateKey:privateKey);interface.addresses=[range];interface.mtu=1280;interface.dns=dns.compactMap {DNSServer(from:$0)}
        var peer=PeerConfiguration(publicKey:publicKey);peer.endpoint=remote;peer.allowedIPs=[IPAddressRange(from:"0.0.0.0/0")!,IPAddressRange(from:"::/0")!];peer.persistentKeepAlive=25
        return TunnelConfiguration(name:"NORTHSTAR",interface:interface,peers:[peer])
    }
    // Renew immediately after sleep instead of waiting out a stale refresh timer.
    override func wake() {woke=true}
    override func handleAppMessage(_ messageData:Data,completionHandler:((Data?)->Void)?) {completionHandler?(Data(state.utf8))}
    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        lifecycle?.cancel();lifecycle=nil
        adapter.stop {_ in completionHandler()}
        if let api {Task {_ = try? await api.action("disconnect",[:])}}
    }
}
