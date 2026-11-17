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
    /// Download / upload rates of the last 40 seconds for the connect page's chart, newest last.
    @Published var rxHistory:[Int]=[]
    @Published var txHistory:[Int]=[]
    /// The location automatic mode gave up on during this connection; the note is dismissed per switch.
    @Published var switchedFrom=""
    @Published var dismissedSwitch=""
    @Published var selected=UserDefaults.standard.string(forKey:"selectedNode") ?? "" {didSet {UserDefaults.standard.set(selected,forKey:"selectedNode")}}
    @Published var selectedName=UserDefaults.standard.string(forKey:"selectedNodeName") ?? "" {didSet {UserDefaults.standard.set(selectedName,forKey:"selectedNodeName")}}
    @Published var routing=UserDefaults.standard.string(forKey:"routing") ?? "smart" {didSet {UserDefaults.standard.set(routing,forKey:"routing")}}
    /// Applied by TunnelControl.start, so from the next connection.
    @Published var killSwitch=UserDefaults.standard.bool(forKey:"killSwitch") {didSet {UserDefaults.standard.set(killSwitch,forKey:"killSwitch")}}
    /// The location list in the order the page shows it. Saved on the device, so the page opens with it at once (also
    /// right after launch) and refreshes in the background; a failed refresh keeps it. Cleared on sign-out.
    @Published var nodes:[[String:Any]]=[]
    @Published var measuring=false
    /// Bumped as each measurement arrives, so the list redraws that row's figures in place.
    @Published var measuredTick=0
    /// When the saved list was loaded from the server.
    private var nodesLoadedAt=Date(timeIntervalSince1970:UserDefaults.standard.double(forKey:"nodesLoadedAt"))
    private var loadingNodes=false
    /// The list changes rarely and people refresh it by hand: it is loaded when the app starts, and again when the app
    /// comes back after this long (it can stay open for days). Opening the list page does not load it.
    static let resumeAfter:TimeInterval=6*3600
    private var foreground:AnyCancellable?
    @Published var account:[String:Any]=[:]
    @Published var manager:NETunnelProviderManager?
    /// A newer build from the release catalog, and the state of its download (Mac DMG; iPhone opens the store).
    @Published var update:ReleaseUpdate?
    @Published var downloading=false
    @Published var downloadProgress:UpdateDownloader.Progress?
    @Published var downloadError=""
    private var downloader:UpdateDownloader?
    private var updateTicker:AnyCancellable?
    @Published var announcement=""
    /// Set when a connection attempt ended without connecting; the ring then offers a retry.
    @Published var failed=false
    @Published var failure=""
    private var attempt:Date?
    /// The service address release builds carry (VEILBIRD_API_ORIGIN): users never type one. Development builds are
    /// empty and ask for it on the sign-in page.
    static let builtInOrigin=(Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "").trimmingCharacters(in:.whitespaces)
    @Published var origin=builtInOrigin.isEmpty ? UserDefaults.standard.string(forKey:"origin") ?? "":builtInOrigin
    private var ticker:AnyCancellable?
    // Status is polled here, not in the window: on the Mac the menu bar keeps working after the window is closed.
    init() {
        Latency.realTests=true // the app measures nodes through their transports (Latency.swift)
        restoreNodes()
        #if os(iOS)
        let active=UIApplication.willEnterForegroundNotification
        #else
        let active=NSApplication.didBecomeActiveNotification
        #endif
        foreground=NotificationCenter.default.publisher(for:active).sink {[weak self] _ in Task {@MainActor in
            guard let self,Date().timeIntervalSince(self.nodesLoadedAt)>Self.resumeAfter else {return}
            await self.refreshNodes()
        }}
        CrashReports.shared.start();ticker=Timer.publish(every:1,on:.main,in:.common).autoconnect().sink {[weak self] _ in Task {@MainActor in self?.refreshStatus()}}
        // The apps stay open for days (menu bar, background): check again once six hours have passed.
        updateTicker=Timer.publish(every:900,on:.main,in:.common).autoconnect().sink {[weak self] _ in Task {@MainActor in await self?.checkIfDue()}}
    }
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
    private func restoreNodes() {
        let defaults=UserDefaults.standard
        if let data=defaults.data(forKey:"measured") {Latency.restore(data)}
        guard let data=defaults.data(forKey:"nodes"),let list=(try? JSONSerialization.jsonObject(with:data)) as? [[String:Any]] else {return}
        nodes=list.sorted {(Latency.recent($0["id"] as? String ?? "")?.score ?? Int.max)<(Latency.recent($1["id"] as? String ?? "")?.score ?? Int.max)}
    }
    private func saveMeasured() {if let data=Latency.snapshot() {UserDefaults.standard.set(data,forKey:"measured")}}
    /// Signing out: the saved list and measurements belonged to that account.
    func forgetNodes() {
        nodes=[];Latency.forget();nodesLoadedAt=.distantPast
        for key in ["nodes","nodesLoadedAt","measured"] {UserDefaults.standard.removeObject(forKey:key)}
    }
    /// Loads the list and saves it. Rows that stay keep their place, new ones go to the end, removed ones leave; the
    /// first list is ordered by this device's measurements. Throws on failure, leaving the list as it was.
    func loadNodes() async throws {
        let listed=(try await api().request("nodes"))["nodes"] as? [[String:Any]] ?? []
        if let data=try? JSONSerialization.data(withJSONObject:listed) {UserDefaults.standard.set(data,forKey:"nodes")}
        nodesLoadedAt=Date();UserDefaults.standard.set(nodesLoadedAt.timeIntervalSince1970,forKey:"nodesLoadedAt")
        let byId=Dictionary(listed.compactMap {node in (node["id"] as? String).map {($0,node)}},uniquingKeysWith:{a,_ in a})
        let kept=nodes.compactMap {byId[$0["id"] as? String ?? ""]}
        let known=Set(kept.compactMap {$0["id"] as? String})
        let added=listed.filter {!known.contains($0["id"] as? String ?? "")}
        withAnimation(.easeInOut(duration:0.25)) {
            nodes=kept.isEmpty ? added.sorted {(Latency.recent($0["id"] as? String ?? "")?.score ?? Int.max)<(Latency.recent($1["id"] as? String ?? "")?.score ?? Int.max)}:kept+added
        }
        // While connected the app's own probes would run through the tunnel: keep the last results.
        if !connected && unmeasured {await measure()}
    }
    /// In the background (at launch, on return after six hours, with the refresh button): nothing changes if it fails.
    func refreshNodes() async {
        guard signedIn,!loadingNodes else {return}
        loadingNodes=true;defer {loadingNodes=false}
        do {try await loadNodes()} catch {
            if case AccessFailure.code("AUTH_REQUIRED")=error {signedIn=false}
        }
    }
    /// A node this device never measured. Measuring is by hand otherwise; results are kept across launches, and
    /// automatic mode measures again when it connects.
    var unmeasured:Bool {nodes.contains {Latency.recent($0["id"] as? String ?? "") == nil}}
    /// Measures nodes never measured (all of them when all is set, from the refresh button). Figures change row by row as results
    /// arrive and earlier figures stay until then; the order stays as it is while the page is open.
    func measure(all:Bool=false) async {
        guard !measuring,!connected,!nodes.isEmpty else {return}
        measuring=true
        let ranked=await Latency.rank(nodes,reuse:all ? 0:.infinity) {[weak self] _,_ in Task {@MainActor in self?.measuredTick+=1}}
        measuring=false;measuredTick+=1
        saveMeasured()
        if let api=try? api() {Task {await Latency.report(api,ranked)}}
    }
    /// The connected node's lines from the location list's last measurement (taken while disconnected, since the
    /// app's own requests go through the tunnel while connected); nil when the device has no line results.
    var connectedLines:[String:Int]? {Latency.recent(connectedNodeId)?.lines}
    /// The transport carrying traffic now, for the check's "in use" mark.
    func currentLine() async -> String {String(decoding:await providerMessage("status-line") ?? Data(),as:UTF8.self)}
    /// The speed test, run by the tunnel through the transport carrying traffic now: "start" (with the request), then
    /// "progress" until done; "stop" ends it. The reply is the core's status as JSON.
    func speed(_ command:String,_ request:[String:Any]?=nil) async -> [String:Any]? {
        var message="speed "+command
        if let request,let data=try? JSONSerialization.data(withJSONObject:request) {message+=" "+String(decoding:data,as:UTF8.self)}
        guard let data=await providerMessage(message) else {return nil}
        if command=="start" {return String(decoding:data,as:UTF8.self)=="ok" ? ["state":"ping"]:["state":"failed"]}
        return try? JSONSerialization.jsonObject(with:data) as? [String:Any]
    }
    private func providerMessage(_ message:String) async -> Data? {
        guard let session=manager?.connection as? NETunnelProviderSession else {return nil}
        return await withCheckedContinuation {(done:CheckedContinuation<Data?,Never>) in
            do {try session.sendProviderMessage(Data(message.utf8)) {done.resume(returning:$0)}} catch {done.resume(returning:nil)}
        }
    }
    func loadAccount() async throws {account=try await api().request("account")}
    /// The connection check's three legs in milliseconds (-1 = no answer), measured by the tunnel: "local", "node", "web".
    func connectionCheck() async -> [String:Int]? {
        if nodes.isEmpty {try? await loadNodes()}
        let node=nodes.first {$0["id"] as? String == connectedNodeId}
        // Every probe port, comma-separated; the tunnel counts the first that answers.
        let address=node.map {Latency.probes($0).map {(host,port) in (host.contains(":") ? "[\(host)]":host)+":\(port)"}.joined(separator:",")} ?? ""
        guard let session=manager?.connection as? NETunnelProviderSession else {return nil}
        let message="check "+address
        return await withCheckedContinuation {(done:CheckedContinuation<[String:Int]?,Never>) in
            do {
                try session.sendProviderMessage(Data(message.utf8)) {data in
                    done.resume(returning:data.flatMap {try? JSONSerialization.jsonObject(with:$0) as? [String:Int]})
                }
            } catch {done.resume(returning:nil)}
        }
    }
    /// The activity view's figures from the tunnel (open connections, rankings, hours, names looked up); nil when not connected.
    @Published var activity:[String:Any]?
    func loadActivity() async {
        guard since != nil,let session=manager?.connection as? NETunnelProviderSession else {activity=nil;return}
        let result=await withCheckedContinuation {(done:CheckedContinuation<[String:Any]?,Never>) in
            do {
                try session.sendProviderMessage(Data("activity".utf8)) {data in
                    done.resume(returning:data.flatMap {try? JSONSerialization.jsonObject(with:$0) as? [String:Any]})
                }
            } catch {done.resume(returning:nil)}
        }
        if let result {activity=result}
    }
    /// The region of the connected location, for the check's exit line.
    var connectedRegion:String? {nodes.first {$0["id"] as? String == connectedNodeId}?["region"] as? String}
    func restore() async {
        do {
            signedIn=try SecureStorage.read("token") != nil
            #if !targetEnvironment(simulator)
            manager=try await TunnelControl.saved()
            #endif
            if signedIn {await refreshNodes();if let client=try? api() {await CrashReports.shared.send(client)}}
        } catch {message=error.localizedDescription}
        // A few seconds after the first screen, so the check never holds up connecting.
        try? await Task.sleep(nanoseconds:3_000_000_000)
        await checkForUpdate()
    }
    /// At launch a few seconds after the first screen, then whenever six hours have passed; not while connecting.
    func checkIfDue() async {
        guard Date().timeIntervalSince1970-UserDefaults.standard.double(forKey:"updateCheckedAt")>6*3600,!downloading else {return}
        if connected && since == nil {return}
        await checkForUpdate()
    }
    func checkForUpdate() async {
        let defaults=UserDefaults.standard
        let installation=defaults.string(forKey:"installation") ?? UUID().uuidString
        defaults.set(installation,forKey:"installation")
        guard let client=try? api(),let data=try? await client.latestRelease(installation:installation) else {return}
        defaults.set(Date().timeIntervalSince1970,forKey:"updateCheckedAt")
        announcement=String((data["announcement"] as? String ?? "").prefix(500))
        guard data["updateAvailable"] as? Bool == true,
              let latest=data["latest"] as? [String:Any],let version=latest["version"] as? String else {update=nil;return}
        let direct=latest["distribution"] as? String == "direct"
        // App Store builds open the store; direct builds download in the app, or open the permanent link.
        let page=direct ? URL(string:client.origin+(data["downloadPath"] as? String ?? "")) : URL(string:latest["url"] as? String ?? "")
        guard let page,page.scheme=="https" else {update=nil;return}
        let downloads=data["downloads"] as? [String:Any]
        var sources=((downloads?["urls"] as? [String]) ?? (downloads == nil ? [latest["url"] as? String ?? ""]:[])).compactMap {URL(string:$0)}.filter {$0.scheme=="https"}
        if let path=downloads?["path"] as? String,path.hasPrefix("/") {sources+=client.origins().compactMap {URL(string:$0+path)}}
        let found=ReleaseUpdate(version:version,build:latest["build"] as? Int ?? 0,mandatory:data["mandatory"] as? Bool == true,page:page,
            direct:direct && (latest["sha256"] as? String)?.count==64 && !sources.isEmpty,sha256:latest["sha256"] as? String ?? "",
            size:(latest["sizeBytes"] as? NSNumber)?.int64Value ?? 0,notes:String((latest["notes"] as? String ?? "").prefix(400)),sources:sources)
        if found.build != update?.build {downloader?.cancel();downloadError=""}
        update=found
    }
    /// "Later" on the banner hides that build for three days; a newer build shows again at once.
    func dismissed(_ update:ReleaseUpdate)->Bool {
        !update.mandatory && UserDefaults.standard.integer(forKey:"updateDismissedBuild")==update.build && Date().timeIntervalSince1970-UserDefaults.standard.double(forKey:"updateDismissedAt")<3*86400
    }
    func dismiss(_ update:ReleaseUpdate) {
        UserDefaults.standard.set(update.build,forKey:"updateDismissedBuild");UserDefaults.standard.set(Date().timeIntervalSince1970,forKey:"updateDismissedAt");objectWillChange.send()
    }
    /// Mac: downloads the DMG with progress, then opens it. iPhone (and builds without a digest): opens the page.
    func startUpdate(_ update:ReleaseUpdate,open:(URL)->Void) {
        guard update.direct else {open(update.page);return}
        if let ready=UpdateDownloader.downloaded(update) {installUpdate(ready);return}
        guard !downloading else {return}
        downloading=true;downloadError="";downloadProgress=nil
        Journal.add("update: download \(update.version)+\(update.build) (\(update.size/1024) KB)")
        let job=UpdateDownloader(update:update) {[weak self] progress in self?.downloadProgress=progress}
        downloader=job
        Task {
            do {
                let file=try await job.run()
                Journal.add("update: done");downloading=false;downloader=nil
                if !connected {installUpdate(file)}
            } catch {
                downloading=false;downloader=nil
                let reason:String
                switch error as? UpdateDownloader.Failure {case .cancelled:reason="";case .digest:reason="digest";case .storage:reason="storage";default:reason="network"}
                if !reason.isEmpty {Journal.add("update: failed (\(reason))");downloadError=reason}
            }
        }
    }
    func cancelUpdate() {downloader?.cancel()}
    /// Opens the verified DMG: the user drags the new version over the old one.
    func installUpdate(_ file:URL) {
        #if os(macOS)
        NSWorkspace.shared.open(file)
        #endif
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
            status="not_connected";since=nil;rxRate=0;txRate=0;rxHistory=[];txHistory=[];switchedFrom="";activity=nil
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
                self.switchedFrom=state["switchedFrom"] as? String ?? ""
                if self.since != nil {
                    self.rxHistory=Array((self.rxHistory+[self.rxRate]).suffix(RateBars.count));self.txHistory=Array((self.txHistory+[self.txRate]).suffix(RateBars.count))
                }
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
