import NetworkExtension
import WireGuardKit

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private lazy var adapter=WireGuardAdapter(with:self) {_,_ in /* Never log tunnel configuration or keys. */}
    private var lifecycle:Task<Void,Never>?
    private var deadline:TimeInterval=0
    private let stateLock=NSLock()
    private var statusText="正在确认连接…"
    private var state:String {
        get {stateLock.lock();defer {stateLock.unlock()};return statusText}
        set {stateLock.lock();defer {stateLock.unlock()};statusText=newValue}
    }
    private var api:NativeAPI?
    private var nodeId=""
    private let privateKey=PrivateKey()
    private var startedAt:TimeInterval=0
    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        lifecycle=Task {
            do {
                guard let configuration=(protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration,let origin=configuration["origin"] as? String else {throw AccessFailure.code("SERVER_REQUIRED")}
                api=try NativeAPI(origin:origin);nodeId=configuration["nodeId"] as? String ?? ""
                let tunnel=try await acquire()
                try Task.checkCancellation()
                try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Void,Error>) in adapter.start(tunnelConfiguration:tunnel) {error in if let error {continuation.resume(throwing:error)} else {continuation.resume()}}}
                startedAt=ProcessInfo.processInfo.systemUptime;completionHandler(nil)
            } catch {completionHandler(error);return}
            var refresh=ProcessInfo.processInfo.systemUptime+90
            while !Task.isCancelled {
                do {try await Task.sleep(nanoseconds:5_000_000_000)} catch {return}
                if ProcessInfo.processInfo.systemUptime>=deadline {cancelTunnelWithError(AccessFailure.code("ACCESS_EXPIRED"));return}
                if ProcessInfo.processInfo.systemUptime>=refresh {
                    do {_ = try await acquire();refresh=ProcessInfo.processInfo.systemUptime+90}
                    catch AccessFailure.code(let code) where ["AUTH_REQUIRED","DEVICE_REVOKED","MEMBERSHIP_EXPIRED","ACCOUNT_UNAVAILABLE","MANAGED_ACCESS_REQUIRED"].contains(code) {cancelTunnelWithError(AccessFailure.code(code));return}
                    catch {refresh=ProcessInfo.processInfo.systemUptime+15}
                }
                let raw=await withCheckedContinuation {continuation in adapter.getRuntimeConfiguration {continuation.resume(returning:$0 ?? "")}}
                let latest=raw.components(separatedBy:"\n").compactMap {line -> Double? in
                    guard line.hasPrefix("last_handshake_time_sec=") else {return nil};return Double(line.dropFirst("last_handshake_time_sec=".count))
                }.max() ?? 0
                if latest>0 && Date().timeIntervalSince1970-latest<180 {state="已连接"}
                else {state="正在确认连接…";if ProcessInfo.processInfo.systemUptime-startedAt>45 {cancelTunnelWithError(AccessFailure.code("NODE_UNAVAILABLE"));return}}
            }
        }
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
        deadline=ProcessInfo.processInfo.systemUptime+remaining;nodeId=node
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
    override func handleAppMessage(_ messageData:Data,completionHandler:((Data?)->Void)?) {completionHandler?(Data(state.utf8))}
    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        lifecycle?.cancel();lifecycle=nil
        adapter.stop {_ in completionHandler()}
        if let api {Task {_ = try? await api.action("disconnect",[:])}}
    }
}
