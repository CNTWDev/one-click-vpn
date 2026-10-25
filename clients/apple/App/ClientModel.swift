import SwiftUI
import Combine
import VeilbirdCore
import NetworkExtension
import AppIntents
#if os(iOS)
import UIKit
#else
import AppKit
import ServiceManagement
#endif

@MainActor final class ClientModel:ObservableObject {
    @Published var signedIn=false
    @Published var busy=false
    @Published var message=""
    @Published var status="not_connected"
    @Published var nodeName=""
    @Published var connectedNodeId=""
    @Published var since:Date?
    @Published var rxRate=0
    @Published var txRate=0
    @Published var selected=UserDefaults.standard.string(forKey:"selectedNode") ?? "" {didSet {UserDefaults.standard.set(selected,forKey:"selectedNode")}}
    @Published var selectedName=UserDefaults.standard.string(forKey:"selectedNodeName") ?? "" {didSet {UserDefaults.standard.set(selectedName,forKey:"selectedNodeName")}}
    @Published var routing=UserDefaults.standard.string(forKey:"routing") ?? "smart" {didSet {UserDefaults.standard.set(routing,forKey:"routing")}}
    /// Applied by TunnelControl.start, so from the next connection.
    @Published var killSwitch=UserDefaults.standard.bool(forKey:"killSwitch") {didSet {UserDefaults.standard.set(killSwitch,forKey:"killSwitch")}}
    @Published var nodes:[[String:Any]]=[]
    @Published var measuring=false
    @Published var account:[String:Any]=[:]
    @Published var manager:NETunnelProviderManager?
    /// (version, mandatory, download URL) when the release catalog has a newer build.
    @Published var update:(version:String,mandatory:Bool,url:URL)?
    @Published var announcement=""
    /// Set when a connection attempt ended without connecting; the ring then offers a retry.
    @Published var failed=false
    @Published var failure=""
    private var attempt:Date?
    @Published var origin=UserDefaults.standard.string(forKey:"origin") ?? (Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "")
    private var ticker:AnyCancellable?
    // Status is polled here, not in the window: on the Mac the menu bar keeps working after the window is closed.
    init() {CrashReports.shared.start();ticker=Timer.publish(every:1,on:.main,in:.common).autoconnect().sink {[weak self] _ in Task {@MainActor in self?.refreshStatus()}}}
    var connected:Bool {[.connected,.connecting,.reasserting].contains(manager?.connection.status)}
    /// The two-letter country code shown in a location's tile; the name's first letter when the node has none.
    func code(_ id:String,name:String)->String {
        let node=nodes.first {$0["id"] as? String == id}
        if let code=node?["countryCode"] as? String,!code.isEmpty {return code.uppercased()}
        return String(name.prefix(1)).uppercased()
    }
    func api() throws -> NativeAPI {try NativeAPI(origin:origin)}
    func work(_ body:@escaping () async throws -> Void) {
        guard !busy else {return};busy=true;message=""
        Task {do {try await body()} catch {
            message=error.localizedDescription
            if case AccessFailure.code("AUTH_REQUIRED")=error {signedIn=false}
            if case AccessFailure.code("CLIENT_UPDATE_REQUIRED")=error {await checkForUpdate()}
        };busy=false}
    }
    func loadNodes() async throws {
        let listed=(try await api().request("nodes"))["nodes"] as? [[String:Any]] ?? []
        nodes=listed.sorted {(Latency.recent($0["id"] as? String ?? "")?.score ?? Int.max)<(Latency.recent($1["id"] as? String ?? "")?.score ?? Int.max)}
        // While connected the app's own probes would run through the tunnel: keep the last results.
        if !connected && nodes.contains(where:{Latency.recent($0["id"] as? String ?? "")==nil}) {await measure()}
    }
    func measure() async {
        guard !measuring,!connected else {return}
        measuring=true
        nodes=await Latency.rank(nodes).map {$0.node}
        measuring=false
    }
    func loadAccount() async throws {account=try await api().request("account")}
    func restore() async {
        do {
            signedIn=try SecureStorage.read("token") != nil
            #if !targetEnvironment(simulator)
            manager=try await TunnelControl.saved()
            #endif
            if signedIn {try await loadNodes();if let client=try? api() {await CrashReports.shared.send(client)}}
        } catch {message=error.localizedDescription}
        await checkForUpdate()
    }
    func checkForUpdate() async {
        let defaults=UserDefaults.standard
        let installation=defaults.string(forKey:"installation") ?? UUID().uuidString
        defaults.set(installation,forKey:"installation")
        guard let client=try? api(),let data=try? await client.latestRelease(installation:installation) else {return}
        announcement=String((data["announcement"] as? String ?? "").prefix(500))
        guard data["updateAvailable"] as? Bool == true,
              let latest=data["latest"] as? [String:Any],let version=latest["version"] as? String else {update=nil;return}
        // App Store builds open the store; direct builds use the permanent download link.
        let target=latest["distribution"] as? String == "direct" ? URL(string:client.origin+(data["downloadPath"] as? String ?? "")) : URL(string:latest["url"] as? String ?? "")
        guard let target,target.scheme=="https" else {update=nil;return}
        update=(version,data["mandatory"] as? Bool == true,target)
    }
    func toggle() async throws {
        #if targetEnvironment(simulator)
        throw AccessFailure.code("SIMULATOR_UNSUPPORTED")
        #else
        if connected {attempt=nil;manager?.connection.stopVPNTunnel();return}
        failed=false
        #if os(macOS)
        SystemExtension.shared.onApprovalNeeded={[weak self] in self?.message=L10n.text("allow_system_extension")}
        try await SystemExtension.shared.activate()
        message=""
        #endif
        attempt=Date()
        Journal.add("connect: requested from the app")
        manager=try await TunnelControl.start(origin:try api().origin,nodeId:selected,routing:routing)
        #endif
    }
    /// The Mac tunnel's own log lines (they live in root's container); read while the tunnel is running.
    @Published var tunnelLog=""
    func loadTunnelLog() {
        #if os(macOS)
        guard let session=manager?.connection as? NETunnelProviderSession else {return}
        try? session.sendProviderMessage(Data("journal".utf8)) {data in
            let text=data.map {String(decoding:$0,as:UTF8.self)} ?? ""
            Task {@MainActor in if !text.isEmpty {self.tunnelLog=text}}
        }
        #endif
    }
    func clearTunnelLog() {
        tunnelLog=""
        try? (manager?.connection as? NETunnelProviderSession)?.sendProviderMessage(Data("journal-clear".utf8)) {_ in}
    }
    func refreshStatus() {
        switch manager?.connection.status {
        case .connected:break
        case .connecting,.reasserting:status="connecting"
        case .disconnecting:status="disconnecting"
        default:
            status="not_connected";since=nil;rxRate=0;txRate=0
            // The tunnel went down on its own shortly after a requested start: show it as a failed attempt.
            if let attempt,Date().timeIntervalSince(attempt)>2 {
                self.attempt=nil;failed=true;failure=L10n.text("unable_to_connect_check_your_network_and_try_again")
            }
        }
        if manager?.connection.status == .connected {attempt=nil}
        guard manager?.connection.status == .connected,let session=manager?.connection as? NETunnelProviderSession else {return}
        try? session.sendProviderMessage(Data("status".utf8)) {data in
            guard let data,let state=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {return}
            Task {@MainActor in
                self.status=state["status"] as? String ?? "connection_confirming"
                self.nodeName=state["node"] as? String ?? self.nodeName;self.connectedNodeId=state["nodeId"] as? String ?? ""
                self.since=(state["since"] as? Double).map {Date(timeIntervalSince1970:$0)}
                self.rxRate=state["rx"] as? Int ?? 0;self.txRate=state["tx"] as? Int ?? 0
            }
        }
    }
}

/// The two figures under the location: traffic left (or used in the last 30 days) and the end of the access
/// period, tinted when either is running out or has run out. Traffic quotas count all nodes together.
struct UsageFigures {
    let trafficTitle:String, traffic:String, trafficTint:Color, until:String, untilTint:Color
    init(_ account:[String:Any]) {
        let access=account["access"] as? [String:Any] ?? [:]
        let state=access["state"] as? String ?? "active"
        let format={(value:Int64) in ByteCountFormatter.string(fromByteCount:value,countStyle:.binary)}
        if let quota=(access["quotaBytes"] as? NSNumber)?.int64Value {
            let remaining=(access["remainingBytes"] as? NSNumber)?.int64Value ?? 0
            trafficTitle=L10n.text("traffic_left");traffic=format(remaining)
            trafficTint=state=="exhausted" ? VeilbirdStyle.danger:(state=="active" && remaining<=quota/10 ? VeilbirdStyle.fair:VeilbirdStyle.text)
        } else {
            let used=(account["traffic"] as? [String:Any]).map {(Int64(String(describing:$0["uploadBytes"] ?? "0")) ?? 0)+(Int64(String(describing:$0["downloadBytes"] ?? "0")) ?? 0)}
            trafficTitle=L10n.text("last_30_days");traffic=used.map(format) ?? "—";trafficTint=VeilbirdStyle.text
        }
        until=account.isEmpty ? "—":L10n.date(account["expiresAt"] as? String)
        let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        let end=(access["until"] as? String).flatMap {parser.date(from:$0) ?? ISO8601DateFormatter().date(from:$0)}
        untilTint=state=="expired" ? VeilbirdStyle.danger:(state=="active" && end.map {$0.timeIntervalSinceNow<=7*86_400} == true ? VeilbirdStyle.fair:VeilbirdStyle.text)
    }
}
