import SwiftUI
import NorthstarCore
import NetworkExtension

@main
struct NorthstarApp: App {
    var body: some Scene {
        WindowGroup { ClientView() }
    }
}

@MainActor final class ClientModel:ObservableObject {
    @Published var signedIn=false
    @Published var busy=false
    @Published var message=""
    @Published var status="未连接"
    @Published var selected=UserDefaults.standard.string(forKey:"selectedNode") ?? "" {didSet {UserDefaults.standard.set(selected,forKey:"selectedNode")}}
    @Published var nodes:[[String:Any]]=[]
    @Published var account:[String:Any]=[:]
    @Published var manager:NETunnelProviderManager?
    @Published var origin=UserDefaults.standard.string(forKey:"origin") ?? (Bundle.main.object(forInfoDictionaryKey:"NorthstarAPIOrigin") as? String ?? "")
    var connected:Bool { manager?.connection.status == .connected || manager?.connection.status == .connecting || manager?.connection.status == .reasserting }
    func api() throws -> NativeAPI {try NativeAPI(origin:origin)}
    func work(_ body:@escaping () async throws -> Void) {
        guard !busy else {return};busy=true;message=""
        Task {do {try await body()} catch {message=error.localizedDescription;if case AccessFailure.code("AUTH_REQUIRED")=error {signedIn=false}};busy=false}
    }
    func load() async throws {
        let api=try api();account=try await api.request("account");nodes=(try await api.request("nodes"))["nodes"] as? [[String:Any]] ?? []
    }
    func restore() async {
        do {
            signedIn=try SecureStorage.read("token") != nil
            #if !targetEnvironment(simulator)
            manager=try await NETunnelProviderManager.loadAllFromPreferences().first { $0.localizedDescription=="NORTHSTAR" }
            #endif
            if signedIn {try await load()}
        } catch {message=error.localizedDescription}
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
        proto.serverAddress="NORTHSTAR"
        proto.providerConfiguration=["origin":api.origin,"nodeId":selected]
        manager.protocolConfiguration=proto;manager.localizedDescription="NORTHSTAR";manager.isEnabled=true
        try await manager.saveToPreferences();try await manager.loadFromPreferences();self.manager=manager
        try manager.connection.startVPNTunnel()
        #endif
    }
    func refreshStatus() {
        switch manager?.connection.status {
        case .connected:status="隧道已启用"
        case .connecting,.reasserting:status="正在连接…"
        case .disconnecting:status="正在断开…"
        default:status="未连接"
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
                    HStack {Label("NORTHSTAR",systemImage:"sparkle").font(.headline).tracking(2);Spacer();Text("随心连接").font(.caption).foregroundStyle(NorthstarStyle.muted)}
                    if !model.signedIn {loginView}
                    else if tab==0 {connectionView}
                    else if tab==1 {nodesView}
                    else {accountView}
                    if model.busy {ProgressView("正在处理，请稍候…").tint(NorthstarStyle.accent)}
                    if !model.message.isEmpty {Label(model.message,systemImage:"exclamationmark.circle").foregroundStyle(.red).font(.callout).textSelection(.enabled).northstarCard()}
                    #if targetEnvironment(simulator)
                    Text("模拟器开发版 · 连接功能需在已签名的真机版本验证").font(.caption).foregroundStyle(NorthstarStyle.muted)
                    #endif
                }.padding(24).frame(maxWidth:640).frame(maxWidth:.infinity)
            }
            if model.signedIn {
                HStack(spacing:8) {
                    navigationItem("连接","power",0)
                    navigationItem("节点","globe.asia.australia",1)
                    navigationItem("我的","person.crop.circle",2)
                }.padding(12).frame(maxWidth:640).frame(maxWidth:.infinity).background(.white)
            }
        }.background(NorthstarStyle.canvas).foregroundStyle(NorthstarStyle.ink).tint(NorthstarStyle.accent)
        .preferredColorScheme(.light).frame(minWidth:300,minHeight:480).disabled(model.busy)
        .task {await model.restore()}.onReceive(timer) {_ in model.refreshStatus()}
        .alert("解除这台设备的授权？",isPresented:Binding(get:{revoke != nil},set:{if !$0 {revoke=nil}})) {
            Button("取消",role:.cancel) {revoke=nil}
            Button("解除授权",role:.destructive) {if let device=revoke {model.work {_ = try await model.api().action("revoke",["enrollmentId":device["id"] as? String ?? ""]);if device["isCurrent"] as? Bool == true {model.manager?.connection.stopVPNTunnel()};try await model.load()}};revoke=nil}
        } message:{Text("该设备将无法继续连接。节点同步后释放额度，离线节点最多等待约 5 分钟。")}
    }

    private func heading(_ title:String,_ subtitle:String)->some View {
        VStack(alignment:.leading,spacing:8) {Text(title).font(.largeTitle.bold());Text(subtitle).font(.callout).foregroundStyle(NorthstarStyle.muted)}
    }
    private func navigationItem(_ title:String,_ icon:String,_ index:Int)->some View {
        Button {tab=index} label:{VStack(spacing:6) {Image(systemName:icon).font(.title3);Text(title).font(.caption.bold())}.frame(maxWidth:.infinity).padding(.vertical,10)
            .foregroundStyle(tab==index ? NorthstarStyle.accent:NorthstarStyle.muted).background(tab==index ? NorthstarStyle.mint:Color.clear,in:RoundedRectangle(cornerRadius:16))}
            .buttonStyle(.plain).accessibilityAddTraits(tab==index ? .isSelected:[])
    }
    private var loginView:some View {
        VStack(alignment:.leading,spacing:24) {
            heading("世界很大，\n一点即达。","登录 NORTHSTAR，无需导入或配置。")
            Label("自动选择位置，也能自由指定",systemImage:"globe.asia.australia.fill").font(.headline).foregroundStyle(.white).padding(24).frame(maxWidth:.infinity,alignment:.leading)
                .background(LinearGradient(colors:[NorthstarStyle.ink,NorthstarStyle.accent],startPoint:.topLeading,endPoint:.bottomTrailing),in:RoundedRectangle(cornerRadius:26))
            VStack(alignment:.leading,spacing:12) {
                if (Bundle.main.object(forInfoDictionaryKey:"NorthstarAPIOrigin") as? String ?? "").isEmpty {Text("开发服务地址").font(.caption.bold());TextField("https://…",text:$model.origin).literalInput().northstarField()}
                Text("邮箱").font(.caption.bold());TextField("输入邮箱",text:$email).literalInput().northstarField()
                Text("密码").font(.caption.bold());SecureField("输入密码",text:$password).northstarField().onSubmit {login()}
                Button("登录并开始") {login()}.buttonStyle(NorthstarButton(primary:true)).disabled(email.trimmingCharacters(in:.whitespaces).isEmpty || password.isEmpty)
            }
            Text("首次连接时，请允许系统添加 VPN。授权设备可在「我的」中管理。").font(.footnote).foregroundStyle(NorthstarStyle.muted)
        }
    }
    private func login() {
        guard !email.trimmingCharacters(in:.whitespaces).isEmpty,!password.isEmpty else {return}
        model.work {try await model.api().login(email:email.trimmingCharacters(in:.whitespaces),password:password);UserDefaults.standard.set(model.origin,forKey:"origin");password="";model.signedIn=true;try await model.load()}
    }
    private var connectionView:some View {
        VStack(alignment:.leading,spacing:20) {
            heading("连接，自在一点。","选好位置，剩下的交给 NORTHSTAR。")
            VStack(spacing:22) {
                Text(model.status).font(.headline).padding(.horizontal,16).padding(.vertical,8).background(NorthstarStyle.mint,in:Capsule())
                Image(systemName:"power").font(.system(size:54,weight:.light)).foregroundStyle(NorthstarStyle.accent)
                    .frame(width:140,height:140).background(NorthstarStyle.mint,in:Circle()).overlay(Circle().stroke(NorthstarStyle.accent.opacity(0.13),lineWidth:10)).accessibilityHidden(true)
                Button(model.connected ? "断开连接":"一键连接") {model.work {try await model.connect()}}.buttonStyle(NorthstarButton(primary:true))
                Text("首次连接需要允许系统 VPN 权限").font(.footnote).foregroundStyle(NorthstarStyle.muted)
            }.frame(maxWidth:.infinity).northstarCard()
            Button {tab=1} label:{HStack(spacing:16) {
                Image(systemName:"globe.asia.australia").font(.title2).foregroundStyle(NorthstarStyle.accent)
                VStack(alignment:.leading,spacing:5) {Text("连接位置").font(.caption).foregroundStyle(NorthstarStyle.muted);Text(model.nodes.first {($0["id"] as? String)==model.selected}?["name"] as? String ?? (model.selected.isEmpty ? "自动选择 · 推荐":"节点不可用，请重新选择")).font(.headline)}
                Spacer();Image(systemName:"chevron.right").foregroundStyle(NorthstarStyle.muted)
            }.northstarCard()}.buttonStyle(.plain)
        }
    }
    private var filteredNodes:[[String:Any]] {model.nodes.filter {search.isEmpty || "\($0["name"] ?? "") \($0["region"] ?? "")".localizedCaseInsensitiveContains(search)}}
    private var nodesView:some View {
        VStack(alignment:.leading,spacing:16) {
            heading("你想从哪里连接？","选择位置后，返回首页一键连接。")
            HStack {Image(systemName:"magnifyingglass");TextField("搜索节点或地区",text:$search).textFieldStyle(.plain)}.northstarCard()
            if model.connected {Label("请先断开连接，再更换位置。",systemImage:"info.circle").font(.callout).foregroundStyle(NorthstarStyle.muted)}
            nodeRow("自动选择","为你选择可用节点",id:"")
            ForEach(filteredNodes.indices,id:\.self) {i in let node=filteredNodes[i];nodeRow(node["name"] as? String ?? "节点",node["region"] as? String ?? "可用位置",id:node["id"] as? String ?? "")}
            if filteredNodes.isEmpty {Text(model.nodes.isEmpty ? "暂无可用节点，请刷新或联系管理员。":"没有匹配的位置，试试其他关键词。").foregroundStyle(NorthstarStyle.muted).northstarCard()}
            Button {model.work {try await model.load()}} label:{Label("刷新节点",systemImage:"arrow.clockwise")}.buttonStyle(NorthstarButton())
        }
    }
    private func nodeRow(_ name:String,_ detail:String,id:String)->some View {
        Button {model.selected=id;tab=0} label:{HStack(spacing:16) {
            Image(systemName:id.isEmpty ? "sparkles":"globe").font(.title2).foregroundStyle(NorthstarStyle.accent).frame(width:44,height:44).background(NorthstarStyle.mint,in:Circle())
            VStack(alignment:.leading,spacing:5) {Text(name).font(.headline);Text(detail).font(.caption).foregroundStyle(NorthstarStyle.muted)}
            Spacer();Image(systemName:model.selected==id ? "checkmark.circle.fill":"chevron.right").foregroundStyle(NorthstarStyle.accent)
        }.northstarCard()}.buttonStyle(.plain).disabled(model.connected).accessibilityAddTraits(model.selected==id ? .isSelected:[])
    }
    private var accountView:some View {
        VStack(alignment:.leading,spacing:18) {
            heading("我的 NORTHSTAR","账号、用量和设备，都在这里。")
            VStack(alignment:.leading,spacing:12) {
                Label(model.account["name"] as? String ?? "我的账号",systemImage:"person.crop.circle.fill").font(.title2.bold())
                Text(model.account["email"] as? String ?? "").foregroundStyle(NorthstarStyle.muted)
                Divider();Text("有效期 · \((model.account["expiresAt"] as? String).map {String($0.prefix(10))} ?? "不限期")").font(.callout)
                let traffic=model.account["traffic"] as? [String:Any] ?? [:]
                Text("近 30 天流量").font(.caption).foregroundStyle(NorthstarStyle.muted)
                Text("↑ \(bytes(traffic["uploadBytes"]))    ↓ \(bytes(traffic["downloadBytes"]))").font(.headline).monospacedDigit()
            }.northstarCard()
            HStack {Text("授权设备").font(.title3.bold());Spacer();Text("\(model.account["used"] as? Int ?? 0) / \(model.account["limit"] as? Int ?? 0)").font(.headline).foregroundStyle(NorthstarStyle.accent)}
            Text("未满额度时，新设备首次连接会自动加入。").font(.footnote).foregroundStyle(NorthstarStyle.muted)
            let devices=(model.account["devices"] as? [[String:Any]] ?? []).filter {$0["status"] as? String != "revoked"}
            if devices.isEmpty {Text("还没有授权设备，首次连接后会出现在这里。").foregroundStyle(NorthstarStyle.muted).northstarCard()}
            ForEach(devices.indices,id:\.self) {i in let device=devices[i]
                VStack(alignment:.leading,spacing:14) {
                    Label((device["name"] as? String ?? "设备")+(device["isCurrent"] as? Bool == true ? " · 本机":""),systemImage:"desktopcomputer").font(.headline)
                    Text(device["platform"] as? String ?? "").font(.caption).foregroundStyle(NorthstarStyle.muted)
                    if device["status"] as? String == "revoking" {Text("解除中 · 等待旧连接到期后释放额度").font(.callout).foregroundStyle(NorthstarStyle.muted)}
                    else {Button("解除授权",role:.destructive) {revoke=device}.buttonStyle(.bordered).controlSize(.large)}
                }.northstarCard()
            }
            Button("刷新设备状态") {model.work {try await model.load()}}.buttonStyle(NorthstarButton())
            Button("退出登录",role:.destructive) {model.work {_ = try? await model.api().request("logout",[:]);try SecureStorage.write("token",nil);model.signedIn=false}}.buttonStyle(.bordered).controlSize(.large).disabled(model.connected)
            if model.connected {Text("退出登录前请先断开 VPN。").font(.caption).foregroundStyle(NorthstarStyle.muted)}
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
