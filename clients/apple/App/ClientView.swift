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

struct ClientView:View {
    @AppStorage(L10n.preferenceKey) private var language = "system"
    @EnvironmentObject private var model:ClientModel
    @State private var email=""
    @State private var password=""
    @State private var showPassword=false
    @State private var revoke:[String:Any]?
    /// The address a reset link is about to be sent to, while the confirmation is showing.
    @State private var resetEmail:String?
    @State private var search=""
    @State private var tab=0
    @State private var versionTaps=0
    @State private var firstTap=Date.distantPast
    @State private var choosingLanguage=false
    #if os(macOS)
    @State private var openAtLogin=SMAppService.mainApp.status == .enabled
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    private let mac=VeilbirdStyle.mac
    var body:some View {
        ZStack {
            VeilbirdStyle.ground.ignoresSafeArea()
            VStack(spacing:0) {
                if model.signedIn {
                    #if os(macOS)
                    if tab<3 {macNavigation}
                    #endif
                    // A new page eases in with a short fade and rise.
                    Group {
                        switch tab {
                        case 0:connectionView
                        case 1:nodesView
                        case 2:accountView
                        case 3:logsView
                        default:devicesView
                        }
                    }.id(tab).transition(.asymmetric(insertion:.opacity.combined(with:.offset(y:8)),removal:.identity))
                    .frame(maxWidth:560,maxHeight:.infinity).frame(maxWidth:.infinity)
                    #if os(iOS)
                    if tab<3 {tabBar}
                    #endif
                } else {loginView}
            }
        }
        .overlay(alignment:.bottom) {messageBanner}
        .foregroundStyle(VeilbirdStyle.text).tint(VeilbirdStyle.accent)
        .environment(\.locale, L10n.locale).preferredColorScheme(.dark)
        .animation(reduceMotion ? nil:.easeOut(duration:0.2),value:tab).animation(reduceMotion ? nil:.easeOut(duration:0.2),value:model.signedIn)
        .task {await model.restore()}
        .alert(L10n.text("revoke_this_device_s_access"),isPresented:Binding(get:{revoke != nil},set:{if !$0 {revoke=nil}})) {
            Button(L10n.text("cancel"),role:.cancel) {revoke=nil}
            Button(L10n.text("revoke_access"),role:.destructive) {if let device=revoke {model.work {_ = try await model.api().action("revoke",["enrollmentId":device["id"] as? String ?? ""]);if device["isCurrent"] as? Bool == true {model.manager?.connection.stopVPNTunnel()};try await model.loadAccount()}};revoke=nil}
        } message:{Text(L10n.text("this_device_will_lose_access_the_slot_is_released"))}
        // "Forgot password" and "change password" both email the Portal's reset link; the new password is set there.
        .alert(L10n.text("reset_by_email"),isPresented:Binding(get:{resetEmail != nil},set:{if !$0 {resetEmail=nil}})) {
            Button(L10n.text("cancel"),role:.cancel) {resetEmail=nil}
            Button(L10n.text("send_reset_link")) {
                if let address=resetEmail {
                    let signedIn=model.signedIn
                    model.work {
                        try await model.api().requestPasswordReset(email:address)
                        model.message=signedIn ? L10n.text("reset_link_sent_to",address):L10n.text("reset_link_sent")
                    }
                }
                resetEmail=nil
            }
        } message:{Text(resetEmail.map {L10n.text(model.signedIn ? "reset_change_detail":"reset_confirm_detail",$0)} ?? "")}
        #if os(iOS)
        .sheet(isPresented:$choosingLanguage) {languageSheet.presentationDetents([.height(360)]).presentationDragIndicator(.visible)}
        #endif
    }

    // MARK: Pieces shared by the pages
    private func pageTitle(_ title:String)->some View {
        Text(title).font(.system(size:mac ? 20:34,weight:.bold)).accessibilityAddTraits(.isHeader)
            .frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,4)
    }
    private func subPageHeader(_ title:String,back:@escaping ()->Void)->some View {
        ZStack {
            Text(title).font(.system(size:mac ? 14:17,weight:.semibold)).accessibilityAddTraits(.isHeader)
            HStack {
                Button(action:back) {Image(systemName:"chevron.left").font(.system(size:mac ? 14:18,weight:.semibold)).frame(width:44,height:44).contentShape(Rectangle())}
                    .buttonStyle(.plain).accessibilityLabel(L10n.text("back_action"))
                Spacer()
            }
        }.frame(height:mac ? 40:52)
    }
    private func caption(_ text:String)->some View {
        Text(text).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).padding(.horizontal,4).frame(maxWidth:.infinity,alignment:.leading)
    }
    private func deviceLimit(_ account:[String:Any])->String {
        (account["limit"] as? Int).map {L10n.number($0)} ?? L10n.text("devices_unlimited")
    }
    private func settingRow(_ title:String,_ value:String,action:@escaping ()->Void)->some View {
        Button(action:action) {
            HStack(spacing:8) {
                Text(title).font(.system(size:VeilbirdStyle.body)).lineLimit(1)
                Spacer(minLength:8)
                Text(value).font(.system(size:VeilbirdStyle.body)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
                Image(systemName:"chevron.right").font(.system(size:mac ? 10:13,weight:.semibold)).foregroundStyle(VeilbirdStyle.faint)
            }.padding(.horizontal,16).frame(minHeight:mac ? 40:50)
        }.buttonStyle(RowButton()).accessibilityLabel(value.isEmpty ? title:title+": "+value)
    }
    @ViewBuilder private var messageBanner:some View {
        if !model.message.isEmpty {
            Text(model.message).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.text).textSelection(.enabled)
                .padding(.horizontal,16).padding(.vertical,12).frame(maxWidth:520,alignment:.leading)
                .background(VeilbirdStyle.raised,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                .overlay(RoundedRectangle(cornerRadius:VeilbirdStyle.radius).stroke(VeilbirdStyle.danger.opacity(0.4)))
                .padding(.horizontal,16).padding(.bottom,mac ? 16:96)
                .onTapGesture {model.message=""}
                .task(id:model.message) {try? await Task.sleep(nanoseconds:5_000_000_000);model.message=""}
        }
    }
    /// Update and announcement notes: one compact card each, only when there is something to say.
    @ViewBuilder private var notices:some View {
        if let update=model.update {
            HStack(spacing:12) {
                VStack(alignment:.leading,spacing:3) {
                    Text(L10n.text("update_available",update.version)).font(.system(size:VeilbirdStyle.body,weight:.medium))
                    Text(L10n.text(update.mandatory ? "update_required_detail":"update_available_detail")).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary)
                }
                Spacer(minLength:8)
                Link(L10n.text("update_now"),destination:update.url).font(.system(size:VeilbirdStyle.detail+1,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)
            }.padding(14).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        }
        if !model.announcement.isEmpty {
            Text(model.announcement).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).frame(maxWidth:.infinity,alignment:.leading)
                .padding(14).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        }
    }
    #if os(iOS)
    private var tabBar:some View {
        HStack(spacing:0) {
            tabItem(L10n.text("connect_tab"),"slash.circle",0)
            tabItem(L10n.text("locations"),"globe",1)
            tabItem(L10n.text("account"),"person",2)
        }.padding(.horizontal,12).padding(.top,7).padding(.bottom,2)
        .background(VeilbirdStyle.ground.opacity(0.94).ignoresSafeArea(edges:.bottom))
        .overlay(alignment:.top) {Rectangle().fill(VeilbirdStyle.hairline).frame(height:0.5)}
    }
    private func tabItem(_ title:String,_ icon:String,_ index:Int)->some View {
        let selected=tab==index
        return Button {tab=index} label:{
            VStack(spacing:3) {Image(systemName:icon).font(.system(size:21));Text(title).font(.system(size:10,weight:.medium))}
                .frame(maxWidth:.infinity,minHeight:44).foregroundStyle(selected ? VeilbirdStyle.accent:VeilbirdStyle.secondary).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
    }
    #else
    /// The Mac window switches pages with a segmented control at the top, under the title bar.
    private var macNavigation:some View {
        HStack(spacing:2) {
            ForEach([(0,"connect_tab"),(1,"locations"),(2,"account")],id:\.0) {item in
                let index=item.0,key=item.1,selected=tab==index
                Button {tab=index} label:{
                    Text(L10n.text(key)).font(.system(size:12,weight:.medium)).padding(.horizontal,14).frame(height:24)
                        .foregroundStyle(selected ? VeilbirdStyle.text:VeilbirdStyle.secondary)
                        .background(selected ? VeilbirdStyle.selected:Color.clear,in:RoundedRectangle(cornerRadius:5)).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
            }
        }.padding(2).background(Color(red:26/255,green:34/255,blue:28/255),in:RoundedRectangle(cornerRadius:7)).padding(.top,8).padding(.bottom,4)
    }
    #endif

    // MARK: Language: native names, no flags
    private var languages:[(code:String,name:String)] {
        [("system",L10n.text("language_system")),("zh-Hans","简体中文"),("en","English"),("ru","Русский")]
    }
    private var currentLanguage:(code:String,name:String) {languages.first {$0.code==language} ?? languages[0]}
    private var shortLanguageName:String {L10n.language == "zh-Hans" ? "简体中文":(L10n.language == "ru" ? "Русский":"English")}
    #if os(iOS)
    private var languageSheet:some View {
        VStack(alignment:.leading,spacing:14) {
            Text(L10n.text("language")).font(.system(size:17,weight:.semibold)).padding(.horizontal,4).padding(.top,24)
            CardGroup {
                ForEach(languages.indices,id:\.self) {i in
                    if i>0 {Hairline()}
                    Button {language=languages[i].code;choosingLanguage=false} label:{
                        HStack {Text(languages[i].name).font(.system(size:17));Spacer();if languages[i].code==language {Image(systemName:"checkmark").font(.system(size:15,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)}}
                            .padding(.horizontal,16).frame(minHeight:50)
                    }.buttonStyle(RowButton()).accessibilityAddTraits(languages[i].code==language ? .isSelected:[])
                }
            }
            Spacer()
        }.padding(.horizontal,16).frame(maxWidth:.infinity).background(VeilbirdStyle.surface.ignoresSafeArea()).foregroundStyle(VeilbirdStyle.text).preferredColorScheme(.dark)
    }
    #endif
    /// The list of languages: a popover on the Mac, a sheet on iPhone; picking one switches at once.
    @ViewBuilder private func languageChooser<Content:View>(_ trigger:Content)->some View {
        #if os(macOS)
        trigger.popover(isPresented:$choosingLanguage,arrowEdge:.bottom) {
            VStack(spacing:2) {
                ForEach(languages,id:\.code) {item in
                    Button {language=item.code;choosingLanguage=false} label:{
                        HStack(spacing:10) {Text(item.name);Spacer();if item.code==language {Image(systemName:"checkmark").foregroundStyle(VeilbirdStyle.accent)}}
                            .padding(.horizontal,12).padding(.vertical,7).frame(width:200,alignment:.leading).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }.padding(6)
        }
        #else
        trigger
        #endif
    }

    // MARK: Sign-in
    private var loginView:some View {
        ScrollView {
            VStack(spacing:0) {
                HStack {
                    Spacer()
                    // Before sign-in the only language entry: a small globe and the language's name, top right.
                    languageChooser(Button {choosingLanguage=true} label:{
                        HStack(spacing:6) {Image(systemName:"globe");Text(shortLanguageName)}.font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary)
                            .padding(.horizontal,10).frame(height:36).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(L10n.text("language")+": "+currentLanguage.name))
                }.frame(height:44)
                notices
                PixelMark(size:mac ? 72:96).padding(.top,mac ? 20:48)
                Wordmark(size:mac ? 24:30).padding(.top,mac ? 16:22).accessibilityAddTraits(.isHeader)
                Text(L10n.text("sign_in_tagline")).font(.system(size:mac ? 13:15)).foregroundStyle(VeilbirdStyle.secondary).multilineTextAlignment(.center).padding(.top,6)
                VStack(alignment:.leading,spacing:8) {
                    if (Bundle.main.object(forInfoDictionaryKey:"VeilbirdAPIOrigin") as? String ?? "").isEmpty {
                        caption(L10n.text("development_server_address"));TextField("https://…",text:$model.origin).literalInput().veilbirdField().padding(.bottom,6)
                    }
                    caption(L10n.text("email"));TextField("name@example.com",text:$email).literalInput().veilbirdField().padding(.bottom,6)
                    caption(L10n.text("password"))
                    ZStack(alignment:.trailing) {
                        Group {
                            if showPassword {TextField(L10n.text("enter_password"),text:$password).literalInput()}
                            else {SecureField(L10n.text("enter_password"),text:$password)}
                        }.veilbirdField().onSubmit {login()}
                        Button {showPassword.toggle()} label:{Image(systemName:showPassword ? "eye.slash":"eye").foregroundStyle(VeilbirdStyle.secondary).frame(width:44,height:44).contentShape(Rectangle())}
                            .buttonStyle(.plain).accessibilityLabel(L10n.text(showPassword ? "hide_password":"show_password")).padding(.trailing,4)
                    }
                    HStack {
                        Spacer()
                        Button(L10n.text("forgot_password")) {
                            let address=email.trimmingCharacters(in:.whitespaces)
                            if address.isEmpty {model.message=L10n.text("reset_enter_email_first")} else {resetEmail=address}
                        }.buttonStyle(.plain).font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary).padding(.horizontal,4).frame(minHeight:mac ? 28:36).contentShape(Rectangle()).disabled(model.busy)
                    }
                    Button {login()} label:{
                        if model.busy {ProgressView().controlSize(.small).tint(VeilbirdStyle.onAccent)} else {Text(L10n.text("sign_in_action"))}
                    }.buttonStyle(PrimaryButton()).disabled(model.busy || email.trimmingCharacters(in:.whitespaces).isEmpty || password.isEmpty).padding(.top,mac ? 6:10)
                }.padding(.top,mac ? 28:44)
            }.padding(.horizontal,mac ? 32:28).padding(.bottom,24).frame(maxWidth:460).frame(maxWidth:.infinity)
        }
    }
    private func login() {
        guard !email.trimmingCharacters(in:.whitespaces).isEmpty,!password.isEmpty else {return}
        model.work {try await model.api().login(email:email.trimmingCharacters(in:.whitespaces),password:password);UserDefaults.standard.set(model.origin,forKey:"origin");password="";tab=0;model.signedIn=true;try await model.loadNodes();await model.checkForUpdate()}
    }

    // MARK: Connect
    private func summary(_ quality:Quality)->String {quality.latency.map {L10n.text("latency_ms",L10n.number($0))+" · "+L10n.text(quality.grade)} ?? L10n.text(quality.grade)}
    private func ms(_ quality:Quality?)->String? {quality?.latency.map {L10n.text("latency_ms",L10n.number($0))}}
    private func mbps(_ bytes:Int)->String {String(format:"%.1f",locale:L10n.locale,Double(bytes)*8/1_000_000)}
    private var ringState:RingState {
        if model.connected {return model.since != nil ? .connected:.connecting}
        return model.failed ? .failed:.idle
    }
    private var connectionView:some View {
        let state=ringState
        let size:CGFloat=mac ? 186:240
        return VStack(spacing:0) {
            #if os(iOS)
            HStack(spacing:10) {PixelMark(size:22);Wordmark(size:19);Spacer()}.frame(height:44)
            #endif
            notices
            Spacer(minLength:16)
            Button {toggleConnection()} label:{ConnectRing(state:state,size:size)}.buttonStyle(.plain)
                .accessibilityLabel(L10n.text(state == .idle ? "connect_action":(state == .failed ? "retry_action":(state == .connecting ? "cancel":"disconnect_action"))))
            VStack(spacing:8) {
                HStack(spacing:10) {
                    if state == .connected {Rectangle().fill(VeilbirdStyle.accent).frame(width:8,height:8)}
                    Text(L10n.text(state == .connected ? "connected_status":(state == .connecting ? "connecting":(state == .failed ? "connect_failed_title":"not_connected"))))
                        .font(.system(size:mac ? 22:28,weight:.bold))
                }
                stateDetail(state).font(.system(size:mac ? 13:15)).foregroundStyle(VeilbirdStyle.secondary).multilineTextAlignment(.center).monospacedDigit().lineLimit(2)
                DataStream(running:state == .connecting || state == .connected,size:mac ? 14:15).padding(.top,mac ? 12:16)
            }.padding(.top,mac ? 24:28).animation(reduceMotion ? nil:.easeInOut(duration:0.2),value:state)
            Spacer(minLength:16)
            Button {tab=1} label:{currentLocationRow}.buttonStyle(RowButton())
                .background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius+4)).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius+4))
                .accessibilityHint(L10n.text("tap_to_change"))
            usageStrip.padding(.top,16)
        }.padding(.horizontal,mac ? 20:16).padding(.bottom,20).task {try? await model.loadAccount()}
    }
    @ViewBuilder private func stateDetail(_ state:RingState)->some View {
        switch state {
        case .connected:
            if model.status == "connection_confirming" {Text(L10n.text("connection_confirming"))}
            else if let since=model.since {
                VStack(spacing:8) {
                    TimelineView(.periodic(from:since,by:1)) {context in
                        Text(verbatim:Duration.seconds(Int(context.date.timeIntervalSince(since))).formatted(.time(pattern:.hourMinuteSecond)))
                            .font(Pixel.font(mac ? 26:34)).foregroundStyle(VeilbirdStyle.text)
                    }
                    Text(L10n.text("connection_rates",mbps(model.rxRate),mbps(model.txRate))).font(.system(size:mac ? 12:13,design:.monospaced))
                }
            }
        case .connecting:Text(L10n.text("finding_best_route"))
        case .failed:Text(model.failure)
        case .idle:Text(L10n.text(model.update?.mandatory == true ? "update_required_detail":"tap_ring_to_connect"))
        }
    }
    private func toggleConnection() {
        if !model.connected && model.update?.mandatory == true {model.message=L10n.text("update_required_detail");return}
        model.work {try await model.toggle()}
    }
    private var currentLocationRow:some View {
        let id=model.connected ? model.connectedNodeId:model.selected
        let quality=id.isEmpty ? nil:Latency.recent(id)
        let automatic=model.selected.isEmpty
        let title:String, detail:String, badge:Badge
        if model.connected && !id.isEmpty {
            title=model.nodeName.isEmpty ? L10n.text("location"):model.nodeName
            detail=automatic ? (ms(quality).map {L10n.text("connected_automatic_detail",$0)} ?? L10n.text("automatic")):(quality.map(summary) ?? L10n.text("tap_to_change"))
            badge=Badge(code:model.code(id,name:title))
        } else if automatic {
            title=L10n.text("automatic")
            // The location automatic mode would pick now, when this session measured one.
            let best=model.nodes.compactMap {node -> (String,Quality)? in
                guard let id=node["id"] as? String,let q=Latency.recent(id),q.latency != nil else {return nil}
                return (node["name"] as? String ?? "",q)
            }.min {$0.1.score<$1.1.score}
            detail=best.map {$0.0+" · "+(ms($0.1) ?? "")} ?? L10n.text("auto_detail")
            badge=Badge(icon:"sparkles",tint:VeilbirdStyle.accent)
        } else {
            title=model.selectedName.isEmpty ? L10n.text("location"):model.selectedName
            detail=quality.map(summary) ?? L10n.text("tap_to_change")
            badge=Badge(code:model.code(id,name:title))
        }
        return HStack(spacing:14) {
            badge
            VStack(alignment:.leading,spacing:3) {
                Text(title).font(.system(size:VeilbirdStyle.body,weight:.medium)).lineLimit(1)
                Text(detail).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
            }
            Spacer(minLength:8)
            Image(systemName:"chevron.right").font(.system(size:mac ? 11:13,weight:.semibold)).foregroundStyle(VeilbirdStyle.faint)
        }.padding(.horizontal,16).frame(height:mac ? 58:66)
    }
    private func bytes(_ value:Int64)->String {ByteCountFormatter.string(fromByteCount:value,countStyle:.binary)}
    /// What this account has left (or used) and how long it runs: two quiet figures under the location.
    private var usageStrip:some View {
        let figures=UsageFigures(model.account)
        return HStack(alignment:.top,spacing:16) {
            usageCell(figures.trafficTitle,figures.traffic,figures.trafficTint)
            usageCell(L10n.text("valid_until_label"),figures.until,figures.untilTint)
        }.padding(.horizontal,4)
    }
    private func usageCell(_ title:String,_ value:String,_ tint:Color)->some View {
        VStack(alignment:.leading,spacing:4) {
            Text(title).font(.system(size:mac ? 11:12)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
            Text(value).font(.system(size:mac ? 14:16,weight:.medium)).foregroundStyle(tint).lineLimit(1).monospacedDigit()
        }.frame(maxWidth:.infinity,alignment:.leading)
    }

    // MARK: Locations
    private var filteredNodes:[[String:Any]] {model.nodes.filter {search.isEmpty || "\($0["name"] ?? "") \($0["region"] ?? "")".localizedCaseInsensitiveContains(search)}}
    private func signal(_ quality:Quality)->(Int,Color) {
        switch quality.grade {
        case "quality_good":return (3,VeilbirdStyle.accent)
        case "quality_fair":return (2,VeilbirdStyle.fair)
        default:return (1,VeilbirdStyle.danger)
        }
    }
    private var nodesView:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:0) {
                HStack {
                    pageTitle(L10n.text("locations"))
                    if model.measuring {ProgressView().controlSize(.small).frame(width:44,height:44)}
                    else {
                        Button {Task {await model.measure()}} label:{Image(systemName:"arrow.clockwise").font(.system(size:mac ? 13:18,weight:.medium)).foregroundStyle(VeilbirdStyle.accent).frame(width:44,height:44).contentShape(Rectangle())}
                            .buttonStyle(.plain).disabled(model.connected).accessibilityLabel(L10n.text("retest_latency"))
                    }
                }
                HStack(spacing:2) {
                    ForEach([("smart","routing_smart"),("global","routing_global")],id:\.0) {item in
                        let value=item.0,key=item.1,selected=model.routing==value
                        Button {if model.connected {model.message=L10n.text("disconnect_before_changing_routing")} else {model.routing=value}} label:{
                            Text(L10n.text(key)).font(.system(size:mac ? 12:14,weight:selected ? .semibold:.regular)).frame(maxWidth:.infinity).frame(height:mac ? 26:34)
                                .foregroundStyle(selected ? VeilbirdStyle.text:VeilbirdStyle.secondary)
                                .background(selected ? VeilbirdStyle.selected:Color.clear,in:RoundedRectangle(cornerRadius:mac ? 5:8)).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
                    }
                }.padding(2).background(Color(red:26/255,green:34/255,blue:28/255),in:RoundedRectangle(cornerRadius:mac ? 7:10)).padding(.top,mac ? 8:12)
                caption(L10n.text(model.routing=="smart" ? "routing_smart_detail":"routing_global_detail")).padding(.top,8)
                if model.connected {caption(L10n.text("test_after_disconnecting")).padding(.top,4)}
                if model.nodes.count>6 {
                    HStack(spacing:8) {
                        Image(systemName:"magnifyingglass").foregroundStyle(VeilbirdStyle.secondary)
                        TextField(L10n.text("search_locations_or_regions"),text:$search).textFieldStyle(.plain).font(.system(size:VeilbirdStyle.body))
                    }.padding(.horizontal,12).frame(height:mac ? 30:40).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:10)).padding(.top,16)
                }
                Button {choose("",name:"")} label:{
                    HStack(spacing:14) {
                        Badge(icon:"sparkles",tint:VeilbirdStyle.accent)
                        VStack(alignment:.leading,spacing:2) {
                            Text(L10n.text("automatic")).font(.system(size:VeilbirdStyle.body,weight:.medium))
                            Text(L10n.text("select_an_available_location_for_you")).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
                        }
                        Spacer(minLength:8)
                        if model.selected.isEmpty {Image(systemName:"checkmark").font(.system(size:mac ? 12:15,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)}
                    }.padding(.horizontal,16).frame(minHeight:mac ? 52:64)
                }.buttonStyle(RowButton()).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                .overlay(RoundedRectangle(cornerRadius:VeilbirdStyle.radius).stroke(model.selected.isEmpty ? VeilbirdStyle.accent.opacity(0.45):Color.clear))
                .clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).padding(.top,16)
                .accessibilityAddTraits(model.selected.isEmpty ? .isSelected:[])
                caption(L10n.text("all_locations")).padding(.top,20).padding(.bottom,8)
                if filteredNodes.isEmpty {
                    caption(model.nodes.isEmpty ? L10n.text("no_locations_available_refresh_or_contact_your_administrator"):L10n.text("no_matching_locations_try_another_search"))
                } else {
                    CardGroup {
                        ForEach(filteredNodes.indices,id:\.self) {i in
                            if i>0 {Hairline(inset:mac ? 60:66)}
                            nodeRow(filteredNodes[i])
                        }
                    }
                }
            }.padding(.horizontal,16).padding(.top,mac ? 4:8).padding(.bottom,20)
        }.task {if model.nodes.isEmpty {model.work {try await model.loadNodes()}} else {await model.measure()}}
    }
    private func nodeRow(_ node:[String:Any])->some View {
        let id=node["id"] as? String ?? "",name=node["name"] as? String ?? ""
        let region=(node["region"] as? String).flatMap {$0.isEmpty || $0==name ? nil:$0}
        let quality=Latency.recent(id)
        let unreachable=quality != nil && quality?.latency == nil
        let selected=model.selected==id
        return Button {choose(id,name:name)} label:{
            HStack(spacing:14) {
                Badge(code:model.code(id,name:name),tint:unreachable ? VeilbirdStyle.faint:VeilbirdStyle.text)
                VStack(alignment:.leading,spacing:2) {
                    Text(name).font(.system(size:VeilbirdStyle.body)).lineLimit(1)
                    if let region {Text(region).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)}
                }.foregroundStyle(unreachable ? VeilbirdStyle.faint:VeilbirdStyle.text)
                Spacer(minLength:8)
                if let quality {
                    if let text=ms(quality) {
                        Text(text).font(.system(size:VeilbirdStyle.detail+1)).foregroundStyle(VeilbirdStyle.secondary).monospacedDigit()
                        let (level,color)=signal(quality);SignalBars(level:level,color:color)
                    } else {Text(L10n.text("quality_unreachable")).font(.system(size:VeilbirdStyle.detail+1)).foregroundStyle(VeilbirdStyle.faint)}
                } else if model.measuring {Text("…").foregroundStyle(VeilbirdStyle.secondary)}
                if selected {Image(systemName:"checkmark").font(.system(size:mac ? 12:15,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent).padding(.leading,4)}
            }.padding(.horizontal,16).frame(minHeight:mac ? 44:56)
        }.buttonStyle(RowButton()).accessibilityLabel(name+", "+(quality.map(summary) ?? "")).accessibilityAddTraits(selected ? .isSelected:[])
    }
    private func choose(_ id:String,name:String) {
        if model.connected {model.message=L10n.text("disconnect_before_changing_location");return}
        model.selected=id;model.selectedName=name;tab=0
    }

    // MARK: Account
    private var accountView:some View {
        let email=model.account["email"] as? String ?? ""
        let name=(model.account["name"] as? String).flatMap {$0.isEmpty ? nil:$0} ?? email
        return ScrollView {
            VStack(alignment:.leading,spacing:20) {
                #if os(iOS)
                pageTitle(L10n.text("account"))
                #endif
                HStack(spacing:14) {
                    Text(String(name.prefix(1)).uppercased()).font(.system(size:mac ? 16:19,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)
                        .frame(width:mac ? 40:48,height:mac ? 40:48).background(VeilbirdStyle.raised,in:Circle())
                    VStack(alignment:.leading,spacing:3) {
                        Text(email).font(.system(size:mac ? 14:17,weight:.semibold)).lineLimit(1)
                        Text(L10n.text("account_valid_until",L10n.date(model.account["expiresAt"] as? String))).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary)
                    }
                }.padding(.horizontal,4).opacity(model.account.isEmpty ? 0:1)
                usageCard
                CardGroup {
                    settingRow(L10n.text("authorized_devices"),"\(L10n.number(model.account["used"] as? Int ?? 0)) / \(deviceLimit(model.account))") {tab=4}
                    Hairline()
                    settingRow(L10n.text("change_password"),"") {if !email.isEmpty {resetEmail=email}}
                    Hairline()
                    languageChooser(settingRow(L10n.text("language"),currentLanguage.name) {choosingLanguage=true})
                    Hairline()
                    #if os(iOS)
                    settingRow(L10n.text("shortcuts"),L10n.text("shortcuts_detail")) {if let url=URL(string:"shortcuts://") {openURL(url)}}
                    #else
                    Toggle(isOn:Binding(get:{openAtLogin},set:{value in
                        do {if value {try SMAppService.mainApp.register()} else {try SMAppService.mainApp.unregister()};openAtLogin=value} catch {model.message=error.localizedDescription}
                    })) {Text(L10n.text("open_at_login")).font(.system(size:VeilbirdStyle.body))}
                        .toggleStyle(.switch).controlSize(.small).tint(VeilbirdStyle.accent).padding(.horizontal,16).frame(minHeight:40)
                    #endif
                    Hairline()
                    settingRow(L10n.text("check_for_updates"),model.update.map {L10n.text("update_available",$0.version)} ?? L10n.text("up_to_date")) {
                        if let update=model.update {openURL(update.url)} else {Task {await model.checkForUpdate();if model.update == nil {model.message=L10n.text("up_to_date")}}}
                    }
                }
                Button {
                    if model.connected {model.message=L10n.text("disconnect_the_vpn_before_signing_out");return}
                    model.work {_ = try? await model.api().request("logout",[:]);try SecureStorage.write("token",nil);model.signedIn=false;model.account=[:];tab=0}
                } label:{Text(L10n.text("sign_out")).font(.system(size:VeilbirdStyle.body)).foregroundStyle(VeilbirdStyle.danger).frame(maxWidth:.infinity).frame(height:mac ? 40:50)}
                    .buttonStyle(RowButton()).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                // The diagnostic log has no visible entry: seven taps on the version open it.
                Text(verbatim:"TRACKNOTHING "+(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")).font(Pixel.font(mac ? 12:13)).tracking(1.5).foregroundStyle(VeilbirdStyle.faint)
                    .frame(maxWidth:.infinity).padding(.vertical,4).contentShape(Rectangle()).onTapGesture {
                        if Date().timeIntervalSince(firstTap)>4 {versionTaps=0;firstTap=Date()}
                        versionTaps+=1
                        if versionTaps>=7 {versionTaps=0;tab=3}
                    }
            }.padding(.horizontal,16).padding(.top,mac ? 8:8).padding(.bottom,20)
        }.task {if model.account.isEmpty {model.work {try await model.loadAccount()}} else {try? await model.loadAccount()}}
    }
    /// 30-day total, a bar per day, and the download / upload split.
    @ViewBuilder private var usageCard:some View {
        if let traffic=model.account["traffic"] as? [String:Any] {
            let down=Int64(String(describing:traffic["downloadBytes"] ?? "0")) ?? 0, up=Int64(String(describing:traffic["uploadBytes"] ?? "0")) ?? 0
            let days=dailyUsage(traffic)
            VStack(alignment:.leading,spacing:mac ? 10:12) {
                HStack {
                    Text(L10n.text("traffic_30_days")).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary)
                    Spacer()
                    if !days.isEmpty {Text(L10n.text("daily")).font(.system(size:mac ? 11:12)).foregroundStyle(VeilbirdStyle.secondary)}
                }
                totalText(bytes(down+up))
                if !days.isEmpty {UsageBars(values:days).frame(height:mac ? 46:58)}
                HStack(spacing:20) {
                    Text(L10n.text("download_amount",bytes(down)));Text(L10n.text("upload_amount",bytes(up)))
                }.font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).monospacedDigit()
            }.padding(16).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        }
    }
    /// "143 GB": the number large, its unit small and muted.
    private func totalText(_ value:String)->some View {
        let parts=value.split(separator:" ",maxSplits:1).map(String.init)
        return (Text(parts.first ?? value).font(Pixel.font(mac ? 34:42))
            + Text(parts.count>1 ? " "+parts[1]:"").font(.system(size:mac ? 14:17,weight:.medium)).foregroundColor(VeilbirdStyle.secondary)).monospacedDigit()
    }
    private func dailyUsage(_ traffic:[String:Any])->[Int64] {
        guard let days=traffic["days"] as? [[String:Any]],!days.isEmpty else {return []}
        var perDay:[String:Int64]=[:]
        for day in days {perDay[day["day"] as? String ?? ""]=Int64(String(describing:day["bytes"] ?? "0")) ?? 0}
        let formatter=DateFormatter();formatter.calendar=Calendar(identifier:.gregorian);formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="yyyy-MM-dd"
        return (0..<30).reversed().map {offset in perDay[formatter.string(from:Date().addingTimeInterval(-Double(offset)*86400))] ?? 0}
    }
    private func platformName(_ value:String)->String? {
        switch value.lowercased() {
        case "android":return "Android"
        case "ios":return "iOS"
        case "ipados":return "iPadOS"
        case "macos":return "macOS"
        case "windows":return "Windows"
        case "":return nil
        default:return value
        }
    }
    private var devicesView:some View {
        let devices=(model.account["devices"] as? [[String:Any]] ?? []).filter {$0["status"] as? String != "revoked"}
        return ScrollView {
            VStack(alignment:.leading,spacing:10) {
                subPageHeader(L10n.text("authorized_devices")) {tab=2}
                HStack(alignment:.bottom) {
                    Text(L10n.text("devices_used",L10n.number(model.account["used"] as? Int ?? 0),deviceLimit(model.account))).font(.system(size:VeilbirdStyle.detail))
                    Spacer(minLength:12)
                    Text(L10n.text("devices_join_automatically")).font(.system(size:mac ? 11:12)).multilineTextAlignment(.trailing)
                }.foregroundStyle(VeilbirdStyle.secondary).padding(.horizontal,4)
                if devices.isEmpty {caption(L10n.text("no_authorized_devices_yet_they_appear_after_their_first"))}
                else {
                    CardGroup {
                        ForEach(devices.indices,id:\.self) {i in
                            if i>0 {Hairline(inset:mac ? 60:66)}
                            deviceRow(devices[i])
                        }
                    }
                }
                if let configs=model.account["configs"] as? Int,configs>0 {caption(L10n.text("devices_configs_note",L10n.number(configs))).padding(.top,2)}
                caption(L10n.text("revoke_release_hint")).padding(.top,2)
            }.padding(.horizontal,16).padding(.bottom,20)
        }.task {try? await model.loadAccount()}
    }
    private func deviceRow(_ device:[String:Any])->some View {
        let current=device["isCurrent"] as? Bool == true, revoking=device["status"] as? String == "revoking"
        let platform=device["platform"] as? String ?? ""
        let mobile=["android","ios","ipados"].contains(platform.lowercased())
        let seen=(device["lastSeenAt"] as? String).flatMap {ISO8601DateFormatter().date(from:$0.replacingOccurrences(of:#"\.\d+"#,with:"",options:.regularExpression))}
            .map {date -> String in let formatter=RelativeDateTimeFormatter();formatter.locale=L10n.locale;return formatter.localizedString(for:date,relativeTo:Date())}
        let detail=[platformName(platform),current ? L10n.text("this_device").trimmingCharacters(in:CharacterSet(charactersIn:" ·")):seen].compactMap {$0}.joined(separator:" · ")
        return HStack(spacing:14) {
            Badge(icon:mobile ? "iphone":"laptopcomputer",tint:current ? VeilbirdStyle.accent:VeilbirdStyle.secondary)
            VStack(alignment:.leading,spacing:2) {
                Text(device["name"] as? String ?? L10n.text("device")).font(.system(size:VeilbirdStyle.body,weight:.medium)).lineLimit(1)
                Text(detail).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
            }
            Spacer(minLength:8)
            if revoking {Text(L10n.text("revoking_short")).font(.system(size:VeilbirdStyle.detail+1)).foregroundStyle(VeilbirdStyle.faint)}
            else {
                Button {revoke=device} label:{Text(L10n.text("revoke_short")).font(.system(size:VeilbirdStyle.detail+1)).foregroundStyle(VeilbirdStyle.danger).padding(.horizontal,8).frame(minHeight:36).contentShape(Rectangle())}
                    .buttonStyle(.plain).accessibilityLabel(L10n.text("revoke_access")+": "+(device["name"] as? String ?? ""))
            }
        }.padding(.leading,16).padding(.trailing,8).frame(minHeight:mac ? 52:64)
    }
    private var logsView:some View {
        let log=Journal.read()
        return ScrollView {
            VStack(alignment:.leading,spacing:12) {
                subPageHeader(L10n.text("logs_title")) {tab=2}
                caption(L10n.text("logs_detail"))
                HStack(spacing:8) {
                    Button {
                        #if os(iOS)
                        UIPasteboard.general.string=log
                        #else
                        NSPasteboard.general.clearContents();NSPasteboard.general.setString(log,forType:.string)
                        #endif
                        model.message=L10n.text("copied")
                    } label:{logAction(L10n.text("copy_action"))}.buttonStyle(.plain).disabled(log.isEmpty)
                    ShareLink(item:log) {logAction(L10n.text("share_action"))}.buttonStyle(.plain).disabled(log.isEmpty)
                    Button {Journal.clear();tab=2;tab=3} label:{logAction(L10n.text("clear_action"),color:VeilbirdStyle.danger)}.buttonStyle(.plain)
                }
                // Newest first: the last attempt is what someone opening the log is looking for.
                Text(log.isEmpty ? L10n.text("logs_empty"):log.split(separator:"\n").reversed().joined(separator:"\n"))
                    .font(.system(size:11,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).padding(12)
                    .background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
            }.padding(.horizontal,16).padding(.bottom,20)
        }
    }
    private func logAction(_ title:String,color:Color=VeilbirdStyle.text)->some View {
        Text(title).font(.system(size:VeilbirdStyle.detail+1,weight:.medium)).foregroundStyle(color).frame(maxWidth:.infinity).frame(height:mac ? 32:44)
            .background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
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
