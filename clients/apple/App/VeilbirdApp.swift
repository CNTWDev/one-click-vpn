import SwiftUI
import Combine
import VeilbirdCore
import NetworkExtension
import AppIntents
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@main
struct VeilbirdApp: App {
    @StateObject private var model=ClientModel()
    var body: some Scene {
        #if os(macOS)
        // A small fixed-size tool window; the menu bar icon carries the quick actions and keeps running when it is closed.
        Window("TrackNothing",id:"main") {ClientView().environmentObject(model).frame(width:380,height:620)}
            .windowResizability(.contentSize)
        MenuBarExtra {MenuBarView().environmentObject(model)} label:{
            Image(systemName:model.connected ? "shield.lefthalf.filled":"shield").accessibilityLabel("TrackNothing")
        }
        #else
        WindowGroup {ClientView().environmentObject(model)}
        #endif
    }
}

/// Starts and stops the saved VPN configuration; shared by the app, the menu bar and Shortcuts.
enum TunnelControl {
    static func saved() async throws -> NETunnelProviderManager? {
        try await NETunnelProviderManager.loadAllFromPreferences().first {$0.localizedDescription == "TrackNothing"}
    }
    /// Saves the configuration (origin, location, routing) and starts the tunnel.
    static func start(origin:String,nodeId:String,routing:String) async throws -> NETunnelProviderManager {
        let manager=try await saved() ?? NETunnelProviderManager()
        let proto=NETunnelProviderProtocol()
        proto.providerBundleIdentifier=(Bundle.main.bundleIdentifier ?? "")+".tunnel"
        proto.serverAddress="TrackNothing"
        proto.providerConfiguration=["origin":origin,"nodeId":nodeId,"routing":routing]
        manager.protocolConfiguration=proto;manager.localizedDescription="TrackNothing";manager.isEnabled=true
        try await manager.saveToPreferences();try await manager.loadFromPreferences()
        try manager.connection.startVPNTunnel()
        return manager
    }
}

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
    @Published var nodes:[[String:Any]]=[]
    @Published var measuring=false
    @Published var account:[String:Any]=[:]
    @Published var manager:NETunnelProviderManager?
    /// (version, mandatory, download URL) when the release catalog has a newer build.
    @Published var update:(version:String,mandatory:Bool,url:URL)?
    @Published var announcement=""
    @Published var origin=UserDefaults.standard.string(forKey:"origin") ?? (Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "")
    private var ticker:AnyCancellable?
    // Status is polled here, not in the window: on the Mac the menu bar keeps working after the window is closed.
    init() {ticker=Timer.publish(every:1,on:.main,in:.common).autoconnect().sink {[weak self] _ in Task {@MainActor in self?.refreshStatus()}}}
    var connected:Bool {[.connected,.connecting,.reasserting].contains(manager?.connection.status)}
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
            if signedIn {try await loadNodes()}
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
        if connected {manager?.connection.stopVPNTunnel();return}
        Journal.add("connect: requested from the app")
        manager=try await TunnelControl.start(origin:try api().origin,nodeId:selected,routing:routing)
        #endif
    }
    func refreshStatus() {
        switch manager?.connection.status {
        case .connected:break
        case .connecting,.reasserting:status="connecting"
        case .disconnecting:status="disconnecting"
        default:status="not_connected";since=nil;rxRate=0;txRate=0
        }
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

struct ClientView:View {
    @AppStorage(L10n.preferenceKey) private var language = "system"
    @EnvironmentObject private var model:ClientModel
    @State private var email=""
    @State private var password=""
    @State private var revoke:[String:Any]?
    @State private var search=""
    @State private var tab=0
    @State private var versionTaps=0
    @State private var firstTap=Date.distantPast
    var body:some View {
        VStack(spacing:0) {
            HStack {
                Text("TrackNothing").font(.headline)
                Spacer()
                if !model.signedIn {languageMenu}
                if model.busy || model.measuring {ProgressView().controlSize(.small).tint(VeilbirdStyle.accent)}
            }.padding(.horizontal,20).padding(.top,14).padding(.bottom,6)
            ScrollView {
                VStack(alignment:.leading,spacing:12) {
                    if !model.announcement.isEmpty {Text(model.announcement).font(.callout).frame(maxWidth:.infinity,alignment:.leading).padding(12).background(VeilbirdStyle.mint,in:RoundedRectangle(cornerRadius:12))}
                    if let update=model.update {
                        VStack(alignment:.leading,spacing:6) {
                            Text(L10n.text("update_available",update.version)).font(.subheadline.bold())
                            Text(L10n.text(update.mandatory ? "update_required_detail":"update_available_detail")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
                            Link(L10n.text("update_open_download"),destination:update.url).buttonStyle(VeilbirdButton(primary:update.mandatory))
                        }.veilbirdCard()
                    }
                    if !model.signedIn {loginView}
                    else if tab==0 {connectionView}
                    else if tab==1 {nodesView}
                    else if tab==2 {accountView}
                    else {logsView}
                    if !model.message.isEmpty {Label(model.message,systemImage:"exclamationmark.circle").foregroundStyle(.red).font(.caption).textSelection(.enabled).veilbirdCard()}
                    #if targetEnvironment(simulator)
                    Text(L10n.text("simulator_build_verify_vpn_connections_on_a_signed_physical")).font(.caption2).foregroundStyle(VeilbirdStyle.muted)
                    #endif
                }.padding(.horizontal,20).padding(.bottom,16).frame(maxWidth:560).frame(maxWidth:.infinity)
            }
            if model.signedIn {
                HStack(spacing:6) {
                    navigationItem(L10n.text("connect_tab"),"power",0)
                    navigationItem(L10n.text("locations"),"globe.asia.australia",1)
                    navigationItem(L10n.text("account"),"person.crop.circle",2)
                }.padding(.horizontal,12).padding(.vertical,8).frame(maxWidth:560).frame(maxWidth:.infinity).background(.white)
            }
        }.background(VeilbirdStyle.canvas).foregroundStyle(VeilbirdStyle.ink).tint(VeilbirdStyle.accent)
        .environment(\.locale, L10n.locale).preferredColorScheme(.light).disabled(model.busy)
        .task {await model.restore()}
        .alert(L10n.text("revoke_this_device_s_access"),isPresented:Binding(get:{revoke != nil},set:{if !$0 {revoke=nil}})) {
            Button(L10n.text("cancel"),role:.cancel) {revoke=nil}
            Button(L10n.text("revoke_access"),role:.destructive) {if let device=revoke {model.work {_ = try await model.api().action("revoke",["enrollmentId":device["id"] as? String ?? ""]);if device["isCurrent"] as? Bool == true {model.manager?.connection.stopVPNTunnel()};try await model.loadAccount()}};revoke=nil}
        } message:{Text(L10n.text("this_device_will_lose_access_the_slot_is_released"))}
    }

    private var languageMenu:some View {
        Menu(L10n.text("language")) {
            Picker(L10n.text("language"),selection:$language) {
                Text(L10n.text("language_system")).tag("system")
                Text("English").tag("en")
                Text("简体中文").tag("zh-Hans")
                Text("Русский").tag("ru")
            }
        }.font(.callout).fixedSize()
    }
    private func navigationItem(_ title:String,_ icon:String,_ index:Int)->some View {
        let selected=tab==index || (tab==3 && index==2)
        return Button {tab=index} label:{VStack(spacing:3) {Image(systemName:icon).font(.body);Text(title).font(.caption2.bold())}.frame(maxWidth:.infinity).padding(.vertical,6)
            .foregroundStyle(selected ? VeilbirdStyle.accent:VeilbirdStyle.muted).background(selected ? VeilbirdStyle.mint:Color.clear,in:RoundedRectangle(cornerRadius:12))}
            .buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
    }
    private var loginView:some View {
        VStack(alignment:.leading,spacing:14) {
            Text(L10n.text("your_world_one_tap_away")).font(.title.bold()).padding(.top,8)
            Text(L10n.text("sign_in_to_veilbird_no_imports_or_configuration_needed")).font(.callout).foregroundStyle(VeilbirdStyle.muted)
            if (Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "").isEmpty {Text(L10n.text("development_server_address")).font(.caption.bold());TextField("https://…",text:$model.origin).literalInput().veilbirdField()}
            Text(L10n.text("email")).font(.caption.bold());TextField(L10n.text("enter_email"),text:$email).literalInput().veilbirdField()
            Text(L10n.text("password")).font(.caption.bold());SecureField(L10n.text("enter_password"),text:$password).veilbirdField().onSubmit {login()}
            Button(L10n.text("sign_in_and_start")) {login()}.buttonStyle(VeilbirdButton(primary:true)).disabled(email.trimmingCharacters(in:.whitespaces).isEmpty || password.isEmpty)
            Text(L10n.text("allow_the_system_to_add_a_vpn_on_first")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
        }
    }
    private func login() {
        guard !email.trimmingCharacters(in:.whitespaces).isEmpty,!password.isEmpty else {return}
        model.work {try await model.api().login(email:email.trimmingCharacters(in:.whitespaces),password:password);UserDefaults.standard.set(model.origin,forKey:"origin");password="";model.signedIn=true;try await model.loadNodes();await model.checkForUpdate()}
    }
    private func gradeColor(_ quality:Quality?)->Color {
        switch quality?.grade {
        case "quality_good":return Color(red:0,green:0.55,blue:0.38)
        case "quality_fair":return Color(red:0.77,green:0.52,blue:0)
        case "quality_poor":return Color(red:0.75,green:0.24,blue:0.18)
        default:return Color(red:0.75,green:0.77,blue:0.75)
        }
    }
    private func summary(_ quality:Quality)->String {quality.latency.map {L10n.text("latency_ms",L10n.number($0))+" · "+L10n.text(quality.grade)} ?? L10n.text(quality.grade)}
    private func mbps(_ bytes:Int)->String {String(format:"%.1f",locale:L10n.locale,Double(bytes)*8/1_000_000)}
    /// Everything needed to connect fits on one screen: state, current location, one button.
    private var connectionView:some View {
        let on=model.connected && model.since != nil
        let id=model.connected ? model.connectedNodeId:model.selected
        let quality=id.isEmpty ? nil:Latency.recent(id)
        let title=model.connected && !model.nodeName.isEmpty ? model.nodeName:model.selected.isEmpty ? L10n.text("automatic_recommended"):(model.selectedName.isEmpty ? L10n.text("location"):model.selectedName)
        let detail=quality.map(summary) ?? (!model.connected && model.selected.isEmpty ? L10n.text("auto_detail"):L10n.text("tap_to_change"))
        return VStack(spacing:12) {
            Image(systemName:"power").font(.system(size:34,weight:.medium)).foregroundStyle(on ? Color.white:VeilbirdStyle.accent)
                .frame(width:88,height:88).background(on ? VeilbirdStyle.accent:VeilbirdStyle.mint,in:Circle()).accessibilityHidden(true).padding(.top,12)
            Text(L10n.text(model.status)).font(.title3.bold())
            Group {
                if let since=model.since {
                    TimelineView(.periodic(from:since,by:1)) {context in
                        Text(L10n.text("connection_stats",Duration.seconds(Int(context.date.timeIntervalSince(since))).formatted(.time(pattern:.hourMinuteSecond)),mbps(model.rxRate),mbps(model.txRate)))
                    }
                } else {Text(" ")}
            }.font(.caption).foregroundStyle(VeilbirdStyle.muted).monospacedDigit().padding(.bottom,6)
            Button {tab=1} label:{row(title,detail,dot:quality==nil && !model.connected && model.selected.isEmpty ? VeilbirdStyle.accent:gradeColor(quality),trailing:"›",selected:false)}.buttonStyle(.plain)
            if model.update?.mandatory != true || model.connected {
                Button(model.connected ? L10n.text("disconnect_action"):L10n.text("connect_action")) {model.work {try await model.toggle()}}.buttonStyle(VeilbirdButton(primary:true))
            }
        }.frame(maxWidth:.infinity)
    }
    /// A list row: status dot, title with a muted detail line, and an optional value on the right.
    private func row(_ title:String,_ detail:String,dot:Color,trailing:String,trailingColor:Color=VeilbirdStyle.muted,selected:Bool)->some View {
        HStack(spacing:12) {
            Circle().fill(dot).frame(width:9,height:9)
            VStack(alignment:.leading,spacing:2) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                if !detail.isEmpty {Text(detail).font(.caption).foregroundStyle(VeilbirdStyle.muted).lineLimit(1)}
            }
            Spacer(minLength:8)
            Text(trailing).font(.subheadline.weight(.semibold)).foregroundStyle(trailingColor)
        }.padding(.horizontal,14).padding(.vertical,10).frame(minHeight:52).frame(maxWidth:.infinity,alignment:.leading)
        .background(selected ? VeilbirdStyle.mint:Color.white,in:RoundedRectangle(cornerRadius:12)).contentShape(Rectangle())
    }
    private var filteredNodes:[[String:Any]] {model.nodes.filter {search.isEmpty || "\($0["name"] ?? "") \($0["region"] ?? "")".localizedCaseInsensitiveContains(search)}}
    private var nodesView:some View {
        VStack(alignment:.leading,spacing:8) {
            HStack {
                Text(L10n.text("locations")).font(.title3.bold());Spacer()
                Button(L10n.text(model.measuring ? "measuring_latency":"retest_latency")) {Task {await model.measure()}}.font(.callout).disabled(model.connected || model.measuring)
            }
            Picker(L10n.text("routing_smart"),selection:Binding(get:{model.routing},set:{value in if model.connected {model.message=L10n.text("disconnect_before_changing_routing")} else {model.routing=value}})) {
                Text(L10n.text("routing_smart")).tag("smart");Text(L10n.text("routing_global")).tag("global")
            }.pickerStyle(.segmented).labelsHidden()
            Text(L10n.text(model.routing=="smart" ? "routing_smart_detail":"routing_global_detail")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
            if model.connected {Text(L10n.text("test_after_disconnecting")).font(.caption).foregroundStyle(VeilbirdStyle.muted)}
            Button {choose("",name:"")} label:{row(L10n.text("automatic_recommended"),L10n.text("auto_detail"),dot:VeilbirdStyle.accent,trailing:model.selected.isEmpty ? "✓":"",trailingColor:VeilbirdStyle.accent,selected:model.selected.isEmpty)}.buttonStyle(.plain).padding(.vertical,4)
            if model.nodes.count>6 {HStack {Image(systemName:"magnifyingglass").foregroundStyle(VeilbirdStyle.muted);TextField(L10n.text("search_locations_or_regions"),text:$search).textFieldStyle(.plain)}.padding(10).background(.white,in:RoundedRectangle(cornerRadius:10))}
            ForEach(filteredNodes.indices,id:\.self) {i in
                let node=filteredNodes[i],id=node["id"] as? String ?? "",name=node["name"] as? String ?? ""
                let quality=Latency.recent(id)
                let load=quality?.load ?? Latency.load(node)
                let detail=[(node["region"] as? String).flatMap {$0.isEmpty ? nil:$0},
                            quality.flatMap {$0.latency == nil ? nil:L10n.text("node_quality_detail",L10n.number($0.jitter),L10n.number($0.loss))},
                            load.map {L10n.text("node_load",L10n.number($0))}].compactMap {$0}.joined(separator:" · ")
                let trailing=quality.map {$0.latency.map {L10n.text("latency_ms",L10n.number($0))} ?? L10n.text("quality_unreachable")} ?? (model.measuring ? "…":"")
                Button {choose(id,name:name)} label:{row(name,detail,dot:gradeColor(quality),trailing:trailing,trailingColor:quality == nil ? VeilbirdStyle.muted:gradeColor(quality),selected:model.selected==id)}
                    .buttonStyle(.plain).accessibilityAddTraits(model.selected==id ? .isSelected:[])
            }
            if filteredNodes.isEmpty {Text(model.nodes.isEmpty ? L10n.text("no_locations_available_refresh_or_contact_your_administrator"):L10n.text("no_matching_locations_try_another_search")).font(.callout).foregroundStyle(VeilbirdStyle.muted)}
        }.task {if model.nodes.isEmpty {model.work {try await model.loadNodes()}} else {await model.measure()}}
    }
    private func choose(_ id:String,name:String) {
        if model.connected {model.message=L10n.text("disconnect_before_changing_location");return}
        model.selected=id;model.selectedName=name;tab=0
    }
    private var accountView:some View {
        VStack(alignment:.leading,spacing:10) {
            Text(L10n.text("my_veilbird")).font(.title3.bold())
            VStack(alignment:.leading,spacing:6) {
                Text(model.account["name"] as? String ?? L10n.text("my_account")).font(.headline)
                Text(model.account["email"] as? String ?? "").font(.caption).foregroundStyle(VeilbirdStyle.muted)
                Text(L10n.text("account_valid_until", L10n.date(model.account["expiresAt"] as? String))).font(.caption)
                let traffic=model.account["traffic"] as? [String:Any] ?? [:]
                Text(L10n.text("traffic_30_days")+"   ↑ \(bytes(traffic["uploadBytes"]))   ↓ \(bytes(traffic["downloadBytes"]))").font(.caption).monospacedDigit()
            }.veilbirdCard()
            HStack {Text(L10n.text("authorized_devices")).font(.subheadline.bold());Spacer();Text("\(L10n.number(model.account["used"] as? Int ?? 0)) / \(L10n.number(model.account["limit"] as? Int ?? 0))").font(.subheadline.bold()).foregroundStyle(VeilbirdStyle.accent)}
            Text(L10n.text("new_devices_are_added_on_their_first_connection_when")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
            let devices=(model.account["devices"] as? [[String:Any]] ?? []).filter {$0["status"] as? String != "revoked"}
            ForEach(devices.indices,id:\.self) {i in let device=devices[i]
                let revoking=device["status"] as? String == "revoking"
                Button {if !revoking {revoke=device}} label:{row((device["name"] as? String ?? L10n.text("device"))+(device["isCurrent"] as? Bool == true ? L10n.text("this_device"):""),
                    revoking ? L10n.text("revoking_slot_released_when_the_old_connection_expires"):device["platform"] as? String ?? "",dot:VeilbirdStyle.accent,
                    trailing:revoking ? "":L10n.text("revoke_access"),trailingColor:.red,selected:false)}.buttonStyle(.plain)
            }
            HStack(spacing:8) {
                languageMenu.frame(maxWidth:.infinity).padding(.vertical,10).background(VeilbirdStyle.mint,in:RoundedRectangle(cornerRadius:12))
                Button(L10n.text("sign_out"),role:.destructive) {model.work {_ = try? await model.api().request("logout",[:]);try SecureStorage.write("token",nil);model.signedIn=false}}
                    .frame(maxWidth:.infinity).padding(.vertical,10).background(Color(red:1,green:0.93,blue:0.92),in:RoundedRectangle(cornerRadius:12)).buttonStyle(.plain).foregroundStyle(.red).disabled(model.connected)
            }
            if model.connected {Text(L10n.text("disconnect_before_signing_out_hint")).font(.caption).foregroundStyle(VeilbirdStyle.muted)}
            // The diagnostic log has no visible entry: seven taps on the version open it.
            Text(L10n.text("version_label",Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")).font(.caption2).foregroundStyle(VeilbirdStyle.muted)
                .frame(maxWidth:.infinity).padding(.vertical,8).contentShape(Rectangle()).onTapGesture {
                    if Date().timeIntervalSince(firstTap)>4 {versionTaps=0;firstTap=Date()}
                    versionTaps+=1
                    if versionTaps>=7 {versionTaps=0;tab=3}
                }
        }.task {model.work {try await model.loadAccount()}}
    }
    private var logsView:some View {
        let log=Journal.read()
        return VStack(alignment:.leading,spacing:10) {
            HStack {Text(L10n.text("logs_title")).font(.title3.bold());Spacer();Button(L10n.text("back_action")) {tab=2}.font(.callout)}
            Text(L10n.text("logs_detail")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
            HStack(spacing:8) {
                Button(L10n.text("copy_action")) {
                    #if os(iOS)
                    UIPasteboard.general.string=log
                    #else
                    NSPasteboard.general.clearContents();NSPasteboard.general.setString(log,forType:.string)
                    #endif
                }.buttonStyle(VeilbirdButton()).disabled(log.isEmpty)
                ShareLink(item:log) {Text(L10n.text("share_action")).frame(maxWidth:.infinity)}.buttonStyle(VeilbirdButton()).disabled(log.isEmpty)
                Button(L10n.text("clear_action")) {Journal.clear();tab=2;tab=3}.buttonStyle(VeilbirdButton())
            }
            // Newest first: the last attempt is what someone opening the log is looking for.
            Text(log.isEmpty ? L10n.text("logs_empty"):log.split(separator:"\n").reversed().joined(separator:"\n"))
                .font(.system(size:11,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).padding(10).background(.white,in:RoundedRectangle(cornerRadius:12))
        }
    }
    private func bytes(_ value:Any?)->String {ByteCountFormatter.string(fromByteCount:Int64(String(describing:value ?? "0")) ?? 0,countStyle:.binary)}
}

#if os(macOS)
/// The menu bar icon's menu: status, connect or disconnect, routing, the window and quit.
struct MenuBarView:View {
    @EnvironmentObject private var model:ClientModel
    @Environment(\.openWindow) private var openWindow
    var body:some View {
        Text(L10n.text(model.status)+(model.connected && !model.nodeName.isEmpty ? " · "+model.nodeName:""))
        Divider()
        if model.signedIn {
            Button(model.connected ? L10n.text("disconnect_action"):L10n.text("connect_action")) {model.work {try await model.toggle()}}
            Picker(L10n.text("routing_smart"),selection:$model.routing) {
                Text(L10n.text("routing_smart")).tag("smart");Text(L10n.text("routing_global")).tag("global")
            }.pickerStyle(.inline).labelsHidden().disabled(model.connected)
            Divider()
        }
        Button(L10n.text("open_app")) {openWindow(id:"main");NSApp.activate(ignoringOtherApps:true)}
        Button(L10n.text("quit_app")) {NSApp.terminate(nil)}
    }
}
#endif

/// Shortcuts and Siri: connect or disconnect with the saved location and routing.
struct ConnectIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("connect_action",table:"Native")
    static var openAppWhenRun=false
    func perform() async throws -> some IntentResult {
        guard let manager=try await TunnelControl.saved() else {throw AccessFailure.code("CONNECT_FROM_APP_FIRST")}
        Journal.add("connect: requested from Shortcuts")
        try manager.connection.startVPNTunnel()
        return .result()
    }
}
struct DisconnectIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("disconnect_action",table:"Native")
    static var openAppWhenRun=false
    func perform() async throws -> some IntentResult {
        try await TunnelControl.saved()?.connection.stopVPNTunnel()
        return .result()
    }
}
struct VeilbirdShortcuts:AppShortcutsProvider {
    static var appShortcuts:[AppShortcut] {
        AppShortcut(intent:ConnectIntent(),phrases:["Connect \(.applicationName)"])
        AppShortcut(intent:DisconnectIntent(),phrases:["Disconnect \(.applicationName)"])
    }
}

private extension View {
    @ViewBuilder func literalInput() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        self.autocorrectionDisabled()
        #endif
    }
}
