import SwiftUI
import Combine
import VeilbirdCore
import NetworkExtension

@main
struct VeilbirdApp: App {
    var body: some Scene {
        WindowGroup { ClientView() }
    }
}

@MainActor final class ClientModel:ObservableObject {
    @Published var signedIn=false
    @Published var busy=false
    @Published var message=""
    @Published var status="not_connected"
    @Published var selected=UserDefaults.standard.string(forKey:"selectedNode") ?? "" {didSet {UserDefaults.standard.set(selected,forKey:"selectedNode")}}
    @Published var nodes:[[String:Any]]=[]
    @Published var account:[String:Any]=[:]
    @Published var manager:NETunnelProviderManager?
    /// (version, mandatory, download URL) when the release catalog has a newer build.
    @Published var update:(version:String,mandatory:Bool,url:URL)?
    @Published var announcement=""
    @Published var origin=UserDefaults.standard.string(forKey:"origin") ?? (Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "")
    var connected:Bool { manager?.connection.status == .connected || manager?.connection.status == .connecting || manager?.connection.status == .reasserting }
    func api() throws -> NativeAPI {try NativeAPI(origin:origin)}
    func work(_ body:@escaping () async throws -> Void) {
        guard !busy else {return};busy=true;message=""
        Task {do {try await body()} catch {
            message=error.localizedDescription
            if case AccessFailure.code("AUTH_REQUIRED")=error {signedIn=false}
            if case AccessFailure.code("CLIENT_UPDATE_REQUIRED")=error {await checkForUpdate()}
        };busy=false}
    }
    func load() async throws {
        let api=try api();account=try await api.request("account");nodes=(try await api.request("nodes"))["nodes"] as? [[String:Any]] ?? []
    }
    func restore() async {
        do {
            signedIn=try SecureStorage.read("token") != nil
            #if !targetEnvironment(simulator)
            manager=try await NETunnelProviderManager.loadAllFromPreferences().first { $0.localizedDescription == "Veilbird" }
            #endif
            if signedIn {try await load()}
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
    func connect() async throws {
        #if targetEnvironment(simulator)
        throw AccessFailure.code("SIMULATOR_UNSUPPORTED")
        #else
        if connected {manager?.connection.stopVPNTunnel();return}
        let api=try api()
        let manager=self.manager ?? NETunnelProviderManager()
        let proto=NETunnelProviderProtocol()
        proto.providerBundleIdentifier=(Bundle.main.bundleIdentifier ?? "")+".tunnel"
        proto.serverAddress="Veilbird"
        proto.providerConfiguration=["origin":api.origin,"nodeId":selected]
        manager.protocolConfiguration=proto;manager.localizedDescription="Veilbird";manager.isEnabled=true
        try await manager.saveToPreferences();try await manager.loadFromPreferences();self.manager=manager
        try manager.connection.startVPNTunnel()
        #endif
    }
    func refreshStatus() {
        switch manager?.connection.status {
        case .connected:status="tunnel_enabled"
        case .connecting,.reasserting:status="connecting"
        case .disconnecting:status="disconnecting"
        default:status="not_connected"
        }
        if manager?.connection.status == .connected,let session=manager?.connection as? NETunnelProviderSession {
            try? session.sendProviderMessage(Data("status".utf8)) {data in
                guard let data,let text=String(data:data,encoding:.utf8) else {return}
                Task {@MainActor in self.status=text}
            }
        }
    }
}
struct ClientView:View {
    @AppStorage(L10n.preferenceKey) private var language = "system"
    @StateObject private var model=ClientModel()
    @State private var email=""
    @State private var password=""
    @State private var revoke:[String:Any]?
    @State private var search=""
    @State private var tab=0
    let timer=Timer.publish(every:2,on:.main,in:.common).autoconnect()
    var body:some View {
        VStack(spacing:0) {
            ScrollView {
                VStack(alignment:.leading,spacing:24) {
                    HStack {Label("Veilbird",systemImage:"bird").font(.headline).tracking(2);Spacer();Text(L10n.text("connect_freely")).font(.caption).foregroundStyle(VeilbirdStyle.muted)}
                    Picker(L10n.text("language"), selection: $language) {
                        Text(L10n.text("language_system")).tag("system")
                        Text("English").tag("en")
                        Text("简体中文").tag("zh-Hans")
                        Text("Русский").tag("ru")
                    }.pickerStyle(.menu).accessibilityIdentifier("language-picker")
                    if !model.announcement.isEmpty {Text(model.announcement).font(.callout).frame(maxWidth:.infinity,alignment:.leading).veilbirdCard()}
                    if let update=model.update {
                        VStack(alignment:.leading,spacing:10) {
                            Text(L10n.text("update_available",update.version)).font(.headline)
                            Text(L10n.text(update.mandatory ? "update_required_detail":"update_available_detail")).font(.callout).foregroundStyle(VeilbirdStyle.muted)
                            Link(L10n.text("update_open_download"),destination:update.url).buttonStyle(VeilbirdButton(primary:update.mandatory))
                        }.frame(maxWidth:.infinity,alignment:.leading).veilbirdCard()
                    }
                    if !model.signedIn {loginView}
                    else if tab==0 {connectionView}
                    else if tab==1 {nodesView}
                    else {accountView}
                    if model.busy {ProgressView(L10n.text("working_please_wait")).tint(VeilbirdStyle.accent)}
                    if !model.message.isEmpty {Label(model.message,systemImage:"exclamationmark.circle").foregroundStyle(.red).font(.callout).textSelection(.enabled).veilbirdCard()}
                    #if targetEnvironment(simulator)
                    Text(L10n.text("simulator_build_verify_vpn_connections_on_a_signed_physical")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
                    #endif
                }.padding(24).frame(maxWidth:640).frame(maxWidth:.infinity)
            }
            if model.signedIn {
                HStack(spacing:8) {
                    navigationItem(L10n.text("connect_tab"),"power",0)
                    navigationItem(L10n.text("locations"),"globe.asia.australia",1)
                    navigationItem(L10n.text("account"),"person.crop.circle",2)
                }.padding(12).frame(maxWidth:640).frame(maxWidth:.infinity).background(.white)
            }
        }.background(VeilbirdStyle.canvas).foregroundStyle(VeilbirdStyle.ink).tint(VeilbirdStyle.accent)
        .environment(\.locale, L10n.locale).preferredColorScheme(.light).frame(minWidth:300,minHeight:480).disabled(model.busy)
        .task {await model.restore()}.onReceive(timer) {_ in model.refreshStatus()}
        .alert(L10n.text("revoke_this_device_s_access"),isPresented:Binding(get:{revoke != nil},set:{if !$0 {revoke=nil}})) {
            Button(L10n.text("cancel"),role:.cancel) {revoke=nil}
            Button(L10n.text("revoke_access"),role:.destructive) {if let device=revoke {model.work {_ = try await model.api().action("revoke",["enrollmentId":device["id"] as? String ?? ""]);if device["isCurrent"] as? Bool == true {model.manager?.connection.stopVPNTunnel()};try await model.load()}};revoke=nil}
        } message:{Text(L10n.text("this_device_will_lose_access_the_slot_is_released"))}
    }

    private func heading(_ title:String,_ subtitle:String)->some View {
        VStack(alignment:.leading,spacing:8) {Text(title).font(.largeTitle.bold());Text(subtitle).font(.callout).foregroundStyle(VeilbirdStyle.muted)}
    }
    private func navigationItem(_ title:String,_ icon:String,_ index:Int)->some View {
        Button {tab=index} label:{VStack(spacing:6) {Image(systemName:icon).font(.title3);Text(title).font(.caption.bold())}.frame(maxWidth:.infinity).padding(.vertical,10)
            .foregroundStyle(tab==index ? VeilbirdStyle.accent:VeilbirdStyle.muted).background(tab==index ? VeilbirdStyle.mint:Color.clear,in:RoundedRectangle(cornerRadius:16))}
            .buttonStyle(.plain).accessibilityAddTraits(tab==index ? .isSelected:[])
    }
    private var loginView:some View {
        VStack(alignment:.leading,spacing:24) {
            heading(L10n.text("your_world_one_tap_away"),L10n.text("sign_in_to_veilbird_no_imports_or_configuration_needed"))
            Label(L10n.text("connect_automatically_or_pick_a_location"),systemImage:"globe.asia.australia.fill").font(.headline).foregroundStyle(.white).padding(24).frame(maxWidth:.infinity,alignment:.leading)
                .background(LinearGradient(colors:[VeilbirdStyle.ink,VeilbirdStyle.accent],startPoint:.topLeading,endPoint:.bottomTrailing),in:RoundedRectangle(cornerRadius:26))
            VStack(alignment:.leading,spacing:12) {
                if (Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "").isEmpty {Text(L10n.text("development_server_address")).font(.caption.bold());TextField("https://…",text:$model.origin).literalInput().veilbirdField()}
                Text(L10n.text("email")).font(.caption.bold());TextField(L10n.text("enter_email"),text:$email).literalInput().veilbirdField()
                Text(L10n.text("password")).font(.caption.bold());SecureField(L10n.text("enter_password"),text:$password).veilbirdField().onSubmit {login()}
                Button(L10n.text("sign_in_and_start")) {login()}.buttonStyle(VeilbirdButton(primary:true)).disabled(email.trimmingCharacters(in:.whitespaces).isEmpty || password.isEmpty)
            }
            Text(L10n.text("allow_the_system_to_add_a_vpn_on_first")).font(.footnote).foregroundStyle(VeilbirdStyle.muted)
        }
    }
    private func login() {
        guard !email.trimmingCharacters(in:.whitespaces).isEmpty,!password.isEmpty else {return}
        model.work {try await model.api().login(email:email.trimmingCharacters(in:.whitespaces),password:password);UserDefaults.standard.set(model.origin,forKey:"origin");password="";model.signedIn=true;try await model.load();await model.checkForUpdate()}
    }
    private var connectionView:some View {
        VStack(alignment:.leading,spacing:20) {
            heading(L10n.text("connect_with_ease"),L10n.text("choose_a_location_veilbird_takes_care_of_the_rest"))
            VStack(spacing:22) {
                Text(L10n.text(model.status)).font(.headline).padding(.horizontal,16).padding(.vertical,8).background(VeilbirdStyle.mint,in:Capsule())
                Image(systemName:"power").font(.system(size:54,weight:.light)).foregroundStyle(VeilbirdStyle.accent)
                    .frame(width:140,height:140).background(VeilbirdStyle.mint,in:Circle()).overlay(Circle().stroke(VeilbirdStyle.accent.opacity(0.13),lineWidth:10)).accessibilityHidden(true)
                Button(model.connected ? L10n.text("disconnect_action"):L10n.text("connect_action")) {model.work {try await model.connect()}}.buttonStyle(VeilbirdButton(primary:true))
                Text(L10n.text("allow_vpn_access_on_your_first_connection")).font(.footnote).foregroundStyle(VeilbirdStyle.muted)
            }.frame(maxWidth:.infinity).veilbirdCard()
            Button {tab=1} label:{HStack(spacing:16) {
                Image(systemName:"globe.asia.australia").font(.title2).foregroundStyle(VeilbirdStyle.accent)
                VStack(alignment:.leading,spacing:5) {Text(L10n.text("location")).font(.caption).foregroundStyle(VeilbirdStyle.muted);Text(model.nodes.first {($0["id"] as? String)==model.selected}?["name"] as? String ?? (model.selected.isEmpty ? L10n.text("automatic_recommended"):L10n.text("location_unavailable_select_another"))).font(.headline)}
                Spacer();Image(systemName:"chevron.right").foregroundStyle(VeilbirdStyle.muted)
            }.veilbirdCard()}.buttonStyle(.plain)
        }
    }
    private var filteredNodes:[[String:Any]] {model.nodes.filter {search.isEmpty || "\($0["name"] ?? "") \($0["region"] ?? "")".localizedCaseInsensitiveContains(search)}}
    private var nodesView:some View {
        VStack(alignment:.leading,spacing:16) {
            heading(L10n.text("where_would_you_like_to_connect"),L10n.text("choose_location_then_connect_hint"))
            HStack {Image(systemName:"magnifyingglass");TextField(L10n.text("search_locations_or_regions"),text:$search).textFieldStyle(.plain)}.veilbirdCard()
            if model.connected {Label(L10n.text("disconnect_before_changing_location"),systemImage:"info.circle").font(.callout).foregroundStyle(VeilbirdStyle.muted)}
            nodeRow(L10n.text("automatic"),L10n.text("select_an_available_location_for_you"),id:"")
            ForEach(filteredNodes.indices,id:\.self) {i in let node=filteredNodes[i];nodeRow(node["name"] as? String ?? L10n.text("locations"),node["region"] as? String ?? L10n.text("available_location"),id:node["id"] as? String ?? "")}
            if filteredNodes.isEmpty {Text(model.nodes.isEmpty ? L10n.text("no_locations_available_refresh_or_contact_your_administrator"):L10n.text("no_matching_locations_try_another_search")).foregroundStyle(VeilbirdStyle.muted).veilbirdCard()}
            Button {model.work {try await model.load()}} label:{Label(L10n.text("refresh_locations"),systemImage:"arrow.clockwise")}.buttonStyle(VeilbirdButton())
        }
    }
    private func nodeRow(_ name:String,_ detail:String,id:String)->some View {
        Button {model.selected=id;tab=0} label:{HStack(spacing:16) {
            Image(systemName:id.isEmpty ? "sparkles":"globe").font(.title2).foregroundStyle(VeilbirdStyle.accent).frame(width:44,height:44).background(VeilbirdStyle.mint,in:Circle())
            VStack(alignment:.leading,spacing:5) {Text(name).font(.headline);Text(detail).font(.caption).foregroundStyle(VeilbirdStyle.muted)}
            Spacer();Image(systemName:model.selected==id ? "checkmark.circle.fill":"chevron.right").foregroundStyle(VeilbirdStyle.accent)
        }.veilbirdCard()}.buttonStyle(.plain).disabled(model.connected).accessibilityAddTraits(model.selected==id ? .isSelected:[])
    }
    private var accountView:some View {
        VStack(alignment:.leading,spacing:18) {
            heading(L10n.text("my_veilbird"),L10n.text("your_account_usage_and_devices_in_one_place"))
            VStack(alignment:.leading,spacing:12) {
                Label(model.account["name"] as? String ?? L10n.text("my_account"),systemImage:"person.crop.circle.fill").font(.title2.bold())
                Text(model.account["email"] as? String ?? "").foregroundStyle(VeilbirdStyle.muted)
                Divider();Text(L10n.text("account_valid_until", L10n.date(model.account["expiresAt"] as? String))).font(.callout)
                let traffic=model.account["traffic"] as? [String:Any] ?? [:]
                Text(L10n.text("traffic_30_days")).font(.caption).foregroundStyle(VeilbirdStyle.muted)
                Text("↑ \(bytes(traffic["uploadBytes"]))    ↓ \(bytes(traffic["downloadBytes"]))").font(.headline).monospacedDigit()
            }.veilbirdCard()
            HStack {Text(L10n.text("authorized_devices")).font(.title3.bold());Spacer();Text("\(L10n.number(model.account["used"] as? Int ?? 0)) / \(L10n.number(model.account["limit"] as? Int ?? 0))").font(.headline).foregroundStyle(VeilbirdStyle.accent)}
            Text(L10n.text("new_devices_are_added_on_their_first_connection_when")).font(.footnote).foregroundStyle(VeilbirdStyle.muted)
            let devices=(model.account["devices"] as? [[String:Any]] ?? []).filter {$0["status"] as? String != "revoked"}
            if devices.isEmpty {Text(L10n.text("no_authorized_devices_yet_they_appear_after_their_first")).foregroundStyle(VeilbirdStyle.muted).veilbirdCard()}
            ForEach(devices.indices,id:\.self) {i in let device=devices[i]
                VStack(alignment:.leading,spacing:14) {
                    Label((device["name"] as? String ?? L10n.text("device"))+(device["isCurrent"] as? Bool == true ? L10n.text("this_device"):""),systemImage:"desktopcomputer").font(.headline)
                    Text(device["platform"] as? String ?? "").font(.caption).foregroundStyle(VeilbirdStyle.muted)
                    if device["status"] as? String == "revoking" {Text(L10n.text("revoking_slot_released_when_the_old_connection_expires")).font(.callout).foregroundStyle(VeilbirdStyle.muted)}
                    else {Button(L10n.text("revoke_access"),role:.destructive) {revoke=device}.buttonStyle(.bordered).controlSize(.large)}
                }.veilbirdCard()
            }
            Button(L10n.text("refresh_devices")) {model.work {try await model.load()}}.buttonStyle(VeilbirdButton())
            Button(L10n.text("sign_out"),role:.destructive) {model.work {_ = try? await model.api().request("logout",[:]);try SecureStorage.write("token",nil);model.signedIn=false}}.buttonStyle(.bordered).controlSize(.large).disabled(model.connected)
            if model.connected {Text(L10n.text("disconnect_before_signing_out_hint")).font(.caption).foregroundStyle(VeilbirdStyle.muted)}
        }
    }
    private func bytes(_ value:Any?)->String {ByteCountFormatter.string(fromByteCount:Int64(String(describing:value ?? "0")) ?? 0,countStyle:.binary)}
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
