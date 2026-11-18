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
    @State private var whatsNew=false
    @State private var search=""
    @State private var tab=0
    @State private var versionTaps=0
    @State private var firstTap=Date.distantPast
    @State private var choosingLanguage=false
    @State private var choosingAppearance=false
    /// Amber or Moon (VeilbirdStyle reads it); the whole window re-renders on change.
    @AppStorage(VeilbirdStyle.themeKey) private var appearance="amber"
    @State private var checking=false
    @State private var checkRunning=false
    @State private var checkResult:[String:Int]?
    /// The node whose per-line detail is open in the list ("" = none).
    @State private var openNode=""
    /// The transport carrying traffic now (for "in use") and the speed test's last status from the tunnel.
    @State private var currentLine=""
    @State private var speedStatus:[String:Any]=["state":"idle"]
    @State private var speedLine=""
    @State private var usageRange="30d"
    /// The public address the service saw before connecting, and the connect page's scan line (direction, run count).
    @State private var visitorIP:String?
    @State private var revealEmail=false
    #if os(macOS)
    @State private var openAtLogin=SMAppService.mainApp.status == .enabled
    @AppStorage(MenuBarLabel.preferenceKey) private var menuBarSpeed=false
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    private let mac=VeilbirdStyle.mac
    var body:some View {
        ZStack {
            SpaceView(lit:!model.connected)
            HStack(spacing:0) {
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
                        case 5:ActivityView()
                        default:devicesView
                        }
                    }.id(tab).transition(.asymmetric(insertion:.opacity.combined(with:.offset(y:8)),removal:.identity))
                    .frame(maxWidth:560,maxHeight:.infinity).frame(maxWidth:.infinity)
                    #if os(iOS)
                    if tab<3 || tab==5 {tabBar}
                    #endif
                } else {loginView}
            }
            // Mac signed in: the activity panel sits beside the app's column (the window widens to hold it).
            .frame(width:mac && model.signedIn ? 380:nil)
            #if os(macOS)
            if model.signedIn {
                Rectangle().fill(Color(red:30/255,green:28/255,blue:25/255)).frame(width:1)
                ActivityView()
            }
            #endif
            }
        }
        // A new appearance redraws every view with the other palette.
        .id(appearance)
        .overlay(alignment:.bottom) {messageBanner}
        .foregroundStyle(VeilbirdStyle.text).tint(VeilbirdStyle.accent)
        .environment(\.locale, L10n.locale).preferredColorScheme(.dark)
        .animation(reduceMotion ? nil:.easeOut(duration:0.2),value:tab).animation(reduceMotion ? nil:.easeOut(duration:0.2),value:model.signedIn)
        .task {await model.restore()}
        // This build's improvements, from clients/CHANGELOG.md (generated into the string resources).
        // A system permission the connection needs (the system's own prompt is easy to miss): what to do and where.
        .alert(L10n.text("permission_needed_title"),isPresented:$model.askPermission) {
            #if os(macOS)
            if model.permission == .systemExtension {Button(L10n.text("open_system_settings")) {SystemExtension.openSettings()}}
            #endif
            if model.permission == .vpnConfiguration {Button(L10n.text("retry_action")) {toggleConnection()}}
            Button(L10n.text("cancel"),role:.cancel) {}
        } message:{Text(L10n.text(model.permission == .systemExtension ? "allow_system_extension":"allow_vpn_configuration"))}
        .alert(L10n.text("whats_new_title",appVersion),isPresented:$whatsNew) {
            Button(L10n.text("got_it"),role:.cancel) {}
        } message:{Text(L10n.text("whats_new_notes").split(separator:"\n").map {"· "+$0}.joined(separator:"\n"))}
        .alert(L10n.text("revoke_this_device_s_access"),isPresented:Binding(get:{revoke != nil},set:{if !$0 {revoke=nil}})) {
            Button(L10n.text("cancel"),role:.cancel) {revoke=nil}
            Button(L10n.text("revoke_access"),role:.destructive) {if let device=revoke {model.work {_ = try await model.api().action("revoke",["enrollmentId":device["id"] as? String ?? ""]);if device["isCurrent"] as? Bool == true {await TunnelControl.stop(model.manager)};try await model.loadAccount()}};revoke=nil}
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
        .sheet(isPresented:$checking) {checkSheet.presentationDetents([.large]).presentationDragIndicator(.visible)}
        #else
        .sheet(isPresented:$checking) {checkSheet.frame(width:360)}
        #endif
    }

    // MARK: Pieces shared by the pages
    /// A main page opens like a sheet of the file: its § number, then the title in a light face.
    private func pageTitle(_ title:String,section:String?=nil)->some View {
        VStack(alignment:.leading,spacing:mac ? 2:4) {
            if let section {SectionLabel(key:section).padding(.horizontal,-4)}
            Text(title).font(.system(size:mac ? 20:30,weight:.light)).lineLimit(1).accessibilityAddTraits(.isHeader)
        }.frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,4)
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
        if let permission=model.permission,model.signedIn {PermissionNote(permission:permission,retry:toggleConnection)}
        if let update=model.update {UpdateBanner(update:update)}
        if !model.announcement.isEmpty {
            Text(model.announcement).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).frame(maxWidth:.infinity,alignment:.leading)
                .padding(14).cardOutline(VeilbirdStyle.radius)
        }
    }
    #if os(iOS)
    private var tabBar:some View {
        HStack(spacing:0) {
            tabItem(L10n.text("connect_tab"),"slash.circle",0)
            tabItem(L10n.text("locations"),"globe",1)
            tabItem(L10n.text("activity_title"),"waveform.path.ecg",5)
            tabItem(L10n.text("account"),"person",2)
        }.padding(.horizontal,12).padding(.top,7).padding(.bottom,2)
        .background(Color(red:8/255,green:8/255,blue:7/255).opacity(0.6).ignoresSafeArea(edges:.bottom))
        .overlay(alignment:.top) {Rectangle().fill(VeilbirdStyle.hairline).frame(height:0.5)}
    }
    private func tabItem(_ title:String,_ icon:String,_ index:Int)->some View {
        let selected=tab==index
        return Button {tab=index} label:{
            VStack(spacing:3) {
                // A small dot on the account tab while an update waits (the banner can be dismissed, the dot stays).
                Image(systemName:icon).font(.system(size:21)).overlay(alignment:.topTrailing) {
                    if index==2 && model.update != nil {Rectangle().fill(VeilbirdStyle.accent).frame(width:6,height:6).offset(x:5,y:-1)}
                }
                Text(title).font(.system(size:10,weight:.medium))
            }
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
                        .background(selected ? VeilbirdStyle.selected:Color.clear,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
            }
        }.padding(2).background(Color(red:30/255,green:28/255,blue:25/255),in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).padding(.top,8).padding(.bottom,4)
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
                HStack(spacing:0) {
                    Spacer()
                    // Before sign-in the look is two small swatches, so a new user sees the choice; afterwards it is the
                    // Appearance row on the account page.
                    ForEach([("amber","theme_amber",Color(red:224/255,green:164/255,blue:88/255)),("moon","theme_moon",Color(red:235/255,green:184/255,blue:195/255))],id:\.0) {item in
                        Button {appearance=item.0} label:{
                            Circle().fill(item.2).frame(width:12,height:12)
                                .overlay(Circle().strokeBorder(item.2,lineWidth:1).frame(width:20,height:20).opacity(appearance == item.0 ? 1:0))
                                .frame(width:30,height:36).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel(L10n.text("appearance")+": "+L10n.text(item.1))
                        .accessibilityAddTraits(appearance == item.0 ? .isSelected:[])
                    }
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
                    if ClientModel.builtInOrigin.isEmpty {
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
        model.work {try await model.api().login(email:email.trimmingCharacters(in:.whitespaces),password:password);UserDefaults.standard.set(model.origin,forKey:"origin");password="";tab=0;model.forgetNodes();model.signedIn=true;try await model.loadNodes();await model.checkForUpdate()}
    }

    // MARK: Connect
    private func summary(_ quality:Quality)->String {quality.latency.map {L10n.text("latency_ms",L10n.number($0))+" · "+L10n.text(quality.grade)} ?? L10n.text(quality.grade)}
    private func ms(_ quality:Quality?)->String? {quality?.latency.map {L10n.text("latency_ms",L10n.number($0))}}
    private func mbps(_ bytes:Int)->String {String(format:"%.1f",locale:L10n.locale,Double(bytes)*8/1_000_000)}
    private var ringState:RingState {
        if model.connected {return model.since != nil ? .connected:.connecting}
        return model.failed ? .failed:.idle
    }
    /// The connect page as a file: its state, four lines of what anyone can see about this device right now, one action,
    /// then the location and usage. Connecting seals the file (a line of light sweeps down and each line turns into dots,
    /// the lamp above goes out); disconnecting sweeps back up and opens it.
    /// The portrait is smaller on a Mac and on short phones, so the page still fits without scrolling.
    private var portraitHeight:CGFloat {
        #if os(macOS)
        return 220
        #else
        return min(300,UIScreen.main.bounds.height*0.36)
        #endif
    }
    private func stateTitle(_ state:RingState)->String {
        L10n.text(state == .connected ? "sealed_status":(state == .connecting ? "connecting":(state == .failed ? "connect_failed_title":"exposed_status")))
    }
    /// Under the portrait: the address in large type and the device line, both sealing into dots while hidden.
    private func portraitFile(_ sealed:Bool)->some View {
        VStack(alignment:.leading,spacing:mac ? 6:10) {
            SealedText(text:visitorIP ?? "···",sealed:sealed,delay:0.3,size:mac ? 30:38,design:.serif)
            SealedText(text:[deviceLine,zoneLine,L10n.locale.identifier.replacingOccurrences(of:"_",with:"-")].joined(separator:"   "),sealed:sealed,delay:0.9,size:11,color:VeilbirdStyle.secondary)
        }.frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,4).accessibilityElement(children:.combine)
    }
    /// The state in words and one line beside it; one height in every state so nothing below moves.
    private func stateLine(_ state:RingState)->some View {
        HStack(alignment:.firstTextBaseline,spacing:12) {
            Text(stateTitle(state)).font(.system(size:mac ? 22:26,weight:.light,design:.serif))
                .foregroundStyle(state == .connected ? VeilbirdStyle.accent:VeilbirdStyle.text).lineLimit(1).fixedSize().contentTransition(.opacity)
            stateDetail(state).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(2).id(state).transition(.opacity)
                .frame(maxWidth:.infinity,alignment:.leading)
        }.frame(height:mac ? 34:40).padding(.horizontal,4)
    }
    private var connectionView:some View {
        let state=ringState
        let sealed=model.connected
        return VStack(spacing:0) {
            #if os(iOS)
            FileHeader(number:fileNumber)
            #endif
            notices
            switchNote(state)
            Spacer(minLength:mac ? 8:12)
            SectionLabel(key:"section_portrait").padding(.bottom,mac ? 2:4)
            // The portrait is the switch: "tap to hide" breathes in it; hidden, its ring holds the time and the rates.
            Button {toggleConnection()} label:{
                PortraitView(hidden:sealed,invite:L10n.text("tap_to_hide"),since:state == .connected ? model.since:nil,
                    sub:ClientModel.notices.contains(model.status) ? L10n.text(model.status):L10n.text("connection_rates",mbps(model.rxRate),mbps(model.txRate)))
                    .frame(maxWidth:.infinity).frame(height:portraitHeight).contentShape(Circle())
            }.buttonStyle(.plain)
            .accessibilityLabel(L10n.text(sealed ? "disconnect_action":"connect_action"))
            portraitFile(sealed).padding(.top,mac ? 6:10)
            stateLine(state).padding(.top,mac ? 8:12)
            Spacer(minLength:mac ? 12:16)
            // One outlined action: quiet while exposed, amber with a breathing dot while sealed.
            Button {toggleConnection()} label:{
                HStack {
                    Text(L10n.text(state == .connected ? "unseal_action":(state == .connecting ? "sealing_detail":(state == .failed ? "retry_action":"seal_action"))))
                        .font(.system(size:mac ? 13:15,weight:.medium)).lineLimit(1).contentTransition(.opacity)
                    Spacer(minLength:8)
                    BreathingDot(on:model.connected)
                }.padding(.horizontal,18).frame(height:mac ? 44:54).contentShape(Rectangle())
                .foregroundStyle(state == .connected ? VeilbirdStyle.accent:VeilbirdStyle.text)
                .background(state == .connected ? VeilbirdStyle.accent.opacity(0.06):VeilbirdStyle.accent.opacity(0.09))
                .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(state == .connected ? VeilbirdStyle.accent.opacity(0.7):VeilbirdStyle.accent,lineWidth:1))
            }.buttonStyle(.plain)
            .accessibilityLabel(L10n.text(state == .idle ? "connect_action":(state == .failed ? "retry_action":(state == .connecting ? "cancel":"disconnect_action"))))
            // Connected, the location row opens the connection check; otherwise, or while the chosen location does not
            // answer, the location list (picking one there reconnects to it).
            Button {if state == .connected && model.status != "location_retrying" {checkResult=nil;checking=true} else {tab=1}} label:{currentLocationRow}.buttonStyle(RowButton())
                .cardOutline(VeilbirdStyle.radius).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                .accessibilityHint(L10n.text("tap_to_change")).padding(.top,10)
            usageStrip.padding(.top,16)
        }.padding(.horizontal,mac ? 20:16).padding(.bottom,20).task {try? await model.loadAccount()}
        .task {if visitorIP == nil && !model.connected {visitorIP=try? await model.api().visitorAddress()}}
        .animation(reduceMotion ? nil:.easeInOut(duration:0.22),value:state)
        // Notes that come and go above the file (update, location switch) slide the page instead of snapping it.
        .animation(reduceMotion ? nil:.easeInOut(duration:0.22),value:model.update)
        .animation(reduceMotion ? nil:.easeInOut(duration:0.22),value:model.switchedFrom+"|"+model.dismissedSwitch)
    }
    private var fileNumber:String {FileHeader.number(model.account["email"] as? String ?? "")}
    private var deviceLine:String {
        let v=ProcessInfo.processInfo.operatingSystemVersion
        #if os(iOS)
        return UIDevice.current.model+" · iOS \(v.majorVersion).\(v.minorVersion)"
        #else
        return "Mac · macOS \(v.majorVersion).\(v.minorVersion)"
        #endif
    }
    private var zoneLine:String {
        let minutes=TimeZone.current.secondsFromGMT()/60
        return String(format:"UTC%@%02d:%02d",minutes>=0 ? "+":"-",abs(minutes)/60,abs(minutes)%60)
    }
    @ViewBuilder private func stateDetail(_ state:RingState)->some View {
        switch state {
        case .connected:Text(L10n.text("seen_as",model.nodeName))
        case .connecting:Text(L10n.text("finding_best_route"))
        case .failed:Text(model.failure)
        case .idle:Text(L10n.text(model.update?.mandatory == true ? "update_required_detail":"exposed_detail"))
        }
    }
    /// One line when automatic mode switched location during this connection; closed per switch.
    @ViewBuilder private func switchNote(_ state:RingState)->some View {
        let from=model.switchedFrom
        if state == .connected && !from.isEmpty && from != model.dismissedSwitch && from != model.nodeName {
            HStack(spacing:12) {
                Rectangle().fill(VeilbirdStyle.accent).frame(width:6,height:6)
                Text(L10n.text("switched_location",from,model.nodeName)).font(.system(size:mac ? 12:13)).lineLimit(2).frame(maxWidth:.infinity,alignment:.leading)
                Button {model.dismissedSwitch=from} label:{Image(systemName:"xmark").font(.system(size:11,weight:.semibold)).foregroundStyle(VeilbirdStyle.secondary).frame(width:36,height:36).contentShape(Rectangle())}
                    .buttonStyle(.plain).accessibilityLabel(L10n.text("close"))
            }.padding(.leading,14).padding(.trailing,4).frame(minHeight:44).cardOutline(VeilbirdStyle.radius).padding(.top,4)
        }
    }
    /// The connection check: your network (a small page outside the tunnel), to the location (TCP outside the tunnel),
    /// opening a page (through the transport carrying traffic), then one sentence on which leg is slow.
    private var checkSheet:some View {
        let r=checkResult
        let local=r?["local"] ?? -2, node=r?["node"] ?? -2, web=r?["web"] ?? -2
        let localSlow=local<0 || local>300, nodeSlow=node<0 || node>300, webSlow=web<0 || web>1200
        let verdict:String={
            if checkRunning || r == nil {return L10n.text("check_running")}
            if local<0 && node<0 && web<0 {return L10n.text("check_failed")}
            if localSlow && (nodeSlow || webSlow) {return L10n.text("check_local_slow")}
            if nodeSlow {return L10n.text("check_node_slow",model.nodeName)}
            if webSlow {return L10n.text("check_web_slow")}
            if localSlow {return L10n.text("check_local_slow")}
            return L10n.text("check_ok")
        }()
        return ScrollView {VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.firstTextBaseline) {
                Text(L10n.text("check_title")).font(.system(size:mac ? 17:20,weight:.semibold)).accessibilityAddTraits(.isHeader)
                Spacer(minLength:12)
                Text(checkRunning || r == nil ? L10n.text("check_running"):model.nodeName).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
            }.padding(.bottom,10)
            checkLeg(L10n.text("check_local"),L10n.text("check_local_detail"),checkRunning ? -2:local,limit:300)
            checkLeg(L10n.text("check_node"),model.nodeName,checkRunning ? -2:node,limit:300)
            checkLeg(L10n.text("check_web"),L10n.text("check_web_detail"),checkRunning ? -2:web,limit:1200)
            Text(verdict).font(.system(size:mac ? 13:14)).frame(maxWidth:.infinity,alignment:.leading).padding(14)
                .background(VeilbirdStyle.raised,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).padding(.top,12)
            if let region=model.connectedRegion,!region.isEmpty {
                HStack {Text(L10n.text("check_exit")).foregroundStyle(VeilbirdStyle.secondary);Spacer();Text(region).lineLimit(1)}.font(.system(size:13)).frame(minHeight:40).padding(.horizontal,2)
            }
            checkLines
            speedCard.padding(.top,18)
            Spacer(minLength:18)
            Button {startSpeed()} label:{Text(L10n.text(speedRunning ? "speed_running":(speedFinished ? "speed_again":"speed_start"))).frame(maxWidth:.infinity)}
                .buttonStyle(PrimaryButton()).disabled(speedRunning || model.since == nil).opacity(speedRunning ? 0.45:1).padding(.bottom,10)
            if !checkRunning && r != nil && !localSlow && (nodeSlow || webSlow) {
                Button {checking=false;tab=1} label:{Text(L10n.text("change_location").replacingOccurrences(of:"›",with:"").trimmingCharacters(in:.whitespaces)).frame(maxWidth:.infinity)}
                    .buttonStyle(PrimaryButton()).padding(.bottom,10)
            }
            Button {runCheck()} label:{Text(L10n.text("check_again")).font(.system(size:VeilbirdStyle.body)).frame(maxWidth:.infinity).frame(height:mac ? 40:48)}
                .buttonStyle(RowButton()).background(VeilbirdStyle.raised,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).disabled(checkRunning)
        }.padding(20)}.scrollIndicators(.hidden).background(VeilbirdStyle.surface.ignoresSafeArea()).foregroundStyle(VeilbirdStyle.text)
        .environment(\.locale,L10n.locale).preferredColorScheme(.dark)
        .task {if checkResult == nil {runCheck()}}
        .onDisappear {if speedRunning {Task {_ = await model.speed("stop")}};speedStatus=["state":"idle"]}
    }
    private func runCheck() {
        guard !checkRunning else {return}
        checkRunning=true
        Task {
            async let line=model.currentLine()
            let result=await model.connectionCheck();checkResult=result ?? ["local":-1,"node":-1,"web":-1]
            currentLine=await line;checkRunning=false
        }
    }
    /// This node's lines (Line 1…4) with their delay, "in use" on the one carrying traffic, and a note when one is out.
    @ViewBuilder private var checkLines:some View {
        if let lines=model.connectedLines,let states=lineStates(lines) {
            Text(L10n.text("check_lines")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).padding(.top,14)
            LazyVGrid(columns:[GridItem(.flexible(),spacing:6),GridItem(.flexible())],spacing:6) {
                ForEach(Latency.lineOrder.indices,id:\.self) {i in
                    let name=Latency.lineOrder[i],ms=lines[name]
                    HStack(spacing:8) {
                        LineCells(states:[states[i]])
                        Text(lineName(i)).font(.system(size:13))
                        Text(L10n.text("line_in_use")).font(.system(size:11)).foregroundStyle(VeilbirdStyle.accent).opacity(name==currentLine ? 1:0)
                        Spacer(minLength:4)
                        Text(lineValue(ms)).font(.system(size:12,design:.monospaced)).monospacedDigit()
                            .foregroundStyle(ms == nil ? VeilbirdStyle.faint:((ms ?? 0)<0 ? VeilbirdStyle.danger:VeilbirdStyle.text))
                    }.padding(.horizontal,10).frame(height:34).cardOutline(8).accessibilityElement(children:.combine)
                }
            }.padding(.top,8)
            let down=Latency.lineOrder.enumerated().filter {(lines[$0.element] ?? 0)<0}
            if let used=Latency.lineOrder.firstIndex(of:currentLine),(lines[currentLine] ?? -1)>=0,!down.isEmpty {
                Text(L10n.text("check_lines_note",down.map {lineName($0.offset)}.joined(separator:listJoin),lineName(used)))
                    .font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary).padding(.top,8)
            }
        }
    }
    private var speedState:String {speedStatus["state"] as? String ?? "idle"}
    private var speedRunning:Bool {speedState=="ping" || speedState=="download"}
    private var speedFinished:Bool {speedState=="done" || speedState=="failed"}
    /// The speed of the current connection: Mbps in the pixel face, a 30-cell bar for the few seconds, latency,
    /// jitter and data used. Every slot keeps its size, so nothing moves while the figures change.
    private var speedCard:some View {
        let state=speedState
        let seconds=max(1,speedStatus["seconds"] as? Int ?? 6)
        let elapsedMs=speedStatus["elapsedMs"] as? Int ?? 0
        let measured=state=="download" || state=="done"
        let fraction:Double=state=="done" ? 1:(state=="download" ? min(1,Double(elapsedMs)/Double(seconds*1000)):0)
        let mbps=(speedStatus["mbps"] as? Double) ?? Double(speedStatus["mbps"] as? Int ?? 0)
        let latency=speedStatus["latency"] as? Int ?? -1,jitter=speedStatus["jitter"] as? Int ?? -1
        let bytes=Int64(speedStatus["bytes"] as? Int ?? 0)
        let over=Latency.lineOrder.firstIndex(of:speedLine).map {lineName($0)}
        let note:String={
            switch state {
            case "ping","download":return L10n.text("speed_downloading",over ?? model.nodeName)
            case "done":return over.map {L10n.text("speed_done",$0,model.nodeName)} ?? model.nodeName
            case "failed":return L10n.text("speed_failed")
            default:return L10n.text(model.since == nil ? "speed_need_connection":"speed_hint")
            }
        }()
        return VStack(alignment:.leading,spacing:12) {
            HStack {
                Text(L10n.text("speed_title")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)
                Spacer()
                Text(verbatim:measured ? String(format:"%.1f / %.1f s",Double(min(elapsedMs,seconds*1000))/1000,Double(seconds)):"—")
                    .font(.system(size:11,design:.monospaced)).monospacedDigit().foregroundStyle(VeilbirdStyle.secondary)
            }
            HStack(alignment:.lastTextBaseline,spacing:6) {
                Text(verbatim:measured ? String(format:"%.1f",mbps):"—").font(Pixel.font(44)).monospacedDigit()
                    .foregroundStyle(state=="done" ? VeilbirdStyle.accent:(state=="download" ? VeilbirdStyle.secondary:Color(red:68/255,green:63/255,blue:57/255)))
                Text(verbatim:"Mbps").font(.system(size:13,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary)
            }.frame(height:52,alignment:.bottomLeading)
            HStack(spacing:2) {
                ForEach(0..<30,id:\.self) {i in
                    Rectangle().fill(Double(i)<fraction*30 ? (state=="done" ? VeilbirdStyle.accent:VeilbirdStyle.secondary):Color(red:32/255,green:30/255,blue:27/255))
                }
            }.frame(height:6).accessibilityHidden(true)
            HStack(alignment:.top) {
                speedStat(L10n.text("speed_latency"),latency>=0 ? L10n.text("latency_ms",L10n.number(latency)):"—")
                speedStat(L10n.text("speed_jitter"),jitter>=0 ? L10n.text("latency_ms",L10n.number(jitter)):"—")
                speedStat(L10n.text("speed_used"),bytes>0 ? ByteCountFormatter.string(fromByteCount:bytes,countStyle:.file):"—")
            }
            Text(note).font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1).frame(height:20,alignment:.leading)
                .animation(reduceMotion ? nil:.easeInOut(duration:0.2),value:note)
        }.padding(16).cardOutline(14)
    }
    private func speedStat(_ title:String,_ value:String)->some View {
        VStack(alignment:.leading,spacing:2) {
            Text(title).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)
            Text(verbatim:value).font(.system(size:14,design:.monospaced)).monospacedDigit().lineLimit(1)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
    private func startSpeed() {
        guard !speedRunning else {return}
        speedStatus=["state":"ping"];speedLine=""
        Task {
            let request:[String:Any]=["group":Transports.group,"pingUrl":Transports.testURL,"url":Latency.speedURL,"seconds":6]
            speedStatus=await model.speed("start",request) ?? ["state":"failed"]
            while checking && speedRunning {
                try? await Task.sleep(nanoseconds:200_000_000)
                guard let status=await model.speed("progress") else {speedStatus=["state":"failed"];break}
                speedStatus=status
                if let line=status["line"] as? String,!line.isEmpty {speedLine=line}
            }
            if speedState=="done" {Journal.add("speed: \(speedLine) \(speedStatus["mbps"] ?? 0) Mbps, \(speedStatus["bytes"] ?? 0) bytes, latency \(speedStatus["latency"] ?? -1) ms, jitter \(speedStatus["jitter"] ?? -1) ms")}
            else if speedState=="failed" {Journal.add("speed: failed \(speedStatus["error"] ?? "") over \(speedLine)")}
        }
    }
    /// One leg: a square in the leg's color, its name over what it measures, and the time (or "No answer").
    private func checkLeg(_ title:String,_ detail:String,_ ms:Int,limit:Int)->some View {
        let color:Color=ms == -2 ? VeilbirdStyle.faint:(ms<0 ? VeilbirdStyle.danger:(ms>limit ? VeilbirdStyle.fair:VeilbirdStyle.accent))
        return HStack(spacing:14) {
            Rectangle().fill(color).frame(width:8,height:8)
            VStack(alignment:.leading,spacing:2) {
                Text(title).font(.system(size:VeilbirdStyle.body,weight:.medium))
                Text(detail).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
            }
            Spacer(minLength:12)
            if ms == -2 {Text(verbatim:"—").font(Pixel.font(22)).foregroundStyle(color)}
            else if ms<0 {Text(L10n.text("check_no_answer")).font(.system(size:14)).foregroundStyle(color)}
            else {Text(L10n.text("latency_ms",L10n.number(ms))).font(Pixel.font(22)).foregroundStyle(color)}
        }.frame(minHeight:mac ? 50:58)
    }
    private func toggleConnection() {
        if !model.connected && model.update?.mandatory == true {model.message=L10n.text("update_required_detail");return}
        // Still waiting for the user to allow the extension: show where, instead of a tap that seems to do nothing.
        if !model.connected && model.permission == .systemExtension {model.askPermission=true;return}
        model.work {try await model.toggle()}
    }
    private var currentLocationRow:some View {
        let id=model.connected ? model.connectedNodeId:model.selected
        let quality=id.isEmpty ? nil:Latency.recent(id)
        let automatic=model.selected.isEmpty
        let title:String, detail:String, badge:Badge
        if model.connected && !id.isEmpty {
            title=model.nodeName.isEmpty ? L10n.text("location"):model.nodeName
            let base=automatic ? (ms(quality).map {L10n.text("connected_automatic_detail",$0)} ?? L10n.text("automatic")):(quality.map(summary) ?? L10n.text("tap_to_change"))
            detail=model.since != nil ? base+" · "+L10n.text("tap_to_check"):base
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
                #if os(iOS)
                FileHeader(number:fileNumber).padding(.bottom,10)
                #endif
                HStack {
                    pageTitle(L10n.text("locations"),section:"section_locations")
                    if model.measuring {ProgressView().controlSize(.small).frame(width:44,height:44)}
                    else {
                        Button {Task {await model.refreshNodes()};Task {await model.measure(all:true)}} label:{Image(systemName:"arrow.clockwise").font(.system(size:mac ? 13:18,weight:.medium)).foregroundStyle(VeilbirdStyle.accent).frame(width:44,height:44).contentShape(Rectangle())}
                            .buttonStyle(.plain).disabled(model.connected).accessibilityLabel(L10n.text("retest_latency"))
                    }
                }
                HStack(spacing:2) {
                    ForEach([("smart","routing_smart"),("global","routing_global")],id:\.0) {item in
                        let value=item.0,key=item.1,selected=model.routing==value
                        Button {if model.connected {model.message=L10n.text("disconnect_before_changing_routing")} else {model.routing=value}} label:{
                            Text(L10n.text(key)).font(.system(size:mac ? 12:14,weight:selected ? .semibold:.regular)).frame(maxWidth:.infinity).frame(height:mac ? 26:34)
                                .foregroundStyle(selected ? VeilbirdStyle.text:VeilbirdStyle.secondary)
                                .background(selected ? VeilbirdStyle.selected:Color.clear,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
                    }
                }.padding(2).background(Color(red:30/255,green:28/255,blue:25/255),in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).padding(.top,mac ? 8:12)
                caption(L10n.text(model.routing=="smart" ? "routing_smart_detail":"routing_global_detail")).padding(.top,8)
                if model.connected {caption(L10n.text("test_after_disconnecting")).padding(.top,4)}
                if model.nodes.count>6 {
                    HStack(spacing:8) {
                        Image(systemName:"magnifyingglass").foregroundStyle(VeilbirdStyle.secondary)
                        TextField(L10n.text("search_locations_or_regions"),text:$search).textFieldStyle(.plain).font(.system(size:VeilbirdStyle.body))
                    }.padding(.horizontal,12).frame(height:mac ? 30:40).cardOutline(10).padding(.top,16)
                }
                Button {choose("",name:"")} label:{
                    HStack(spacing:14) {
                        Badge(icon:"sparkles",tint:VeilbirdStyle.accent,selected:model.selected.isEmpty)
                        VStack(alignment:.leading,spacing:2) {
                            Text(L10n.text("automatic")).font(.system(size:VeilbirdStyle.body,weight:model.selected.isEmpty ? .semibold:.medium))
                            Text(L10n.text("select_an_available_location_for_you")).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
                        }
                        Spacer(minLength:8)
                    }.padding(.horizontal,16).frame(minHeight:mac ? 52:64)
                    // Selected = a lifted row and a amber tile; nothing is added, so the layout never moves.
                    .background(model.selected.isEmpty ? VeilbirdStyle.raised:Color.clear)
                }.buttonStyle(RowButton()).cardOutline(VeilbirdStyle.radius)
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
        }.task {
            // The saved list shows at once; it is loaded at launch and by the refresh button, not here. Only a device
            // with no list yet loads it now, with progress and errors; only nodes never measured are measured.
            if model.nodes.isEmpty {model.work {try await model.loadNodes()}}
            else if model.unmeasured {await model.measure()}
        }
    }
    private func lineName(_ index:Int)->String {L10n.text("line_n",L10n.number(index+1))}
    private var listJoin:String {L10n.language.hasPrefix("zh") ? "、":", "}
    /// Each line's cell in the order Line 1…4; nil when this device has no line results for the node.
    private func lineStates(_ lines:[String:Int]?)->[LineState]? {
        guard let lines,!lines.isEmpty else {return nil}
        return Latency.lineOrder.map {name in
            guard let ms=lines[name] else {return .off}
            return ms<0 ? .down:(ms>300 ? .slow:.ok)
        }
    }
    /// One sentence when a line is out ("Line 2 has no answer, using Line 1"); nil when every offered line works.
    private func linesNote(_ lines:[String:Int]?)->String? {
        guard let lines,!lines.isEmpty else {return nil}
        let offered=Latency.lineOrder.enumerated().filter {lines[$0.element] != nil}
        let working=offered.filter {(lines[$0.element] ?? -1)>=0}
        let down=offered.filter {(lines[$0.element] ?? -1)<0}
        if working.isEmpty {return L10n.text("lines_none")}
        if down.isEmpty {return nil}
        if working.count==1 && offered.count>2 {return L10n.text("lines_only",lineName(working[0].offset))}
        let best=working.min {(lines[$0.element] ?? 0)<(lines[$1.element] ?? 0)}!
        return L10n.text("lines_one_down",down.map {lineName($0.offset)}.joined(separator:listJoin),lineName(best.offset))
    }
    private func lineValue(_ ms:Int?)->String {
        guard let ms else {return L10n.text("line_off")}
        return ms<0 ? L10n.text("line_down"):L10n.text("latency_ms",L10n.number(ms))
    }
    private func nodeRow(_ node:[String:Any])->some View {
        let id=node["id"] as? String ?? "",name=node["name"] as? String ?? ""
        let region=(node["region"] as? String).flatMap {$0.isEmpty || $0==name ? nil:$0}
        let quality=Latency.recent(id)
        let unreachable=quality != nil && quality?.latency == nil
        let selected=model.selected==id
        let states=lineStates(quality?.lines)
        let note=linesNote(quality?.lines)
        let offered=((node["test"] as? [[String:Any]]) ?? []).contains {Latency.lineOrder.contains($0["name"] as? String ?? "")}
        let open=openNode==id && states != nil
        // Split into small pieces: as one expression the optimized (release) build cannot type-check it in time.
        return VStack(spacing:0) {
            HStack(spacing:0) {
                nodeMain(id:id,name:name,region:region,quality:quality,unreachable:unreachable,selected:selected,note:note)
                nodeCells(id:id,name:name,quality:quality,states:states,offered:offered,open:open)
            }
            if open,let lines=quality?.lines,let states {nodeLines(lines:lines,states:states)}
        }.background(selected ? VeilbirdStyle.raised:(open ? Color(red:16/255,green:14/255,blue:13/255):Color.clear))
        .animation(reduceMotion ? nil:.easeInOut(duration:0.2),value:selected)
    }
    private func nodeMain(id:String,name:String,region:String?,quality:Quality?,unreachable:Bool,selected:Bool,note:String?)->some View {
        let tint:Color=unreachable ? VeilbirdStyle.faint:VeilbirdStyle.text
        let nameTint:Color=unreachable && !selected ? VeilbirdStyle.faint:VeilbirdStyle.text
        var spoken:String=name+", "+(quality.map(summary) ?? "")
        if let note {spoken+=", "+note}
        return Button {choose(id,name:name)} label:{
            HStack(spacing:14) {
                Badge(code:model.code(id,name:name),tint:tint,selected:selected)
                VStack(alignment:.leading,spacing:2) {
                    Text(name).font(.system(size:VeilbirdStyle.body,weight:selected ? .semibold:.regular)).lineLimit(1)
                    if let detail=note ?? region {Text(detail).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)}
                }.foregroundStyle(nameTint)
                Spacer(minLength:8)
                // Fixed columns on every row: the delay (fixed width, right-aligned) and the cell slot after it.
                nodeDelay(quality).font(.system(size:VeilbirdStyle.detail+1)).lineLimit(1).minimumScaleFactor(0.75)
                    .frame(width:mac ? 64:76,alignment:.trailing)
            }.padding(.leading,16).padding(.trailing,4).frame(minHeight:mac ? 44:56).contentShape(Rectangle())
        }.buttonStyle(RowButton()).accessibilityLabel(spoken).accessibilityAddTraits(selected ? .isSelected:[])
    }
    @ViewBuilder private func nodeDelay(_ quality:Quality?)->some View {
        if let quality {
            if let text=ms(quality) {Text(text).foregroundStyle(VeilbirdStyle.secondary).monospacedDigit()}
            else {Text(L10n.text("quality_unreachable")).foregroundStyle(VeilbirdStyle.danger)}
        } else {Text(model.measuring ? "…":"").foregroundStyle(VeilbirdStyle.secondary)}
    }
    /// The cell slot is always there: the four line cells (tap to open each line's result), signal bars for a
    /// device without line results, or empty. Earlier results stay drawn while a node is measured again.
    private func nodeCells(id:String,name:String,quality:Quality?,states:[LineState]?,offered:Bool,open:Bool)->some View {
        Group {
            if let states {
                let total=L10n.number(states.filter {$0 != .off}.count),working=L10n.number(states.filter {$0 == .ok || $0 == .slow}.count)
                Button {withAnimation(reduceMotion ? nil:.easeInOut(duration:0.26)) {openNode=open ? "":id}} label:{
                    LineCells(states:states).frame(width:44,height:44).contentShape(Rectangle())
                }.buttonStyle(.plain)
                .accessibilityLabel(L10n.text("lines_detail",name,total,working))
                .accessibilityAddTraits(open ? .isSelected:[])
            } else if model.measuring && quality == nil && offered {
                LineCells(states:Array(repeating:.wait,count:Latency.lineOrder.count))
            } else if let quality,quality.latency != nil {
                let (level,color)=signal(quality);SignalBars(level:level,color:color)
            } else {Color.clear}
        }.frame(width:44,height:44).padding(.trailing,8)
    }
    /// Quieter than the row: no outlines, small grey text, indented to the name.
    private func nodeLines(lines:[String:Int],states:[LineState])->some View {
        LazyVGrid(columns:[GridItem(.flexible(),spacing:20),GridItem(.flexible())],spacing:0) {
            ForEach(Latency.lineOrder.indices,id:\.self) {i in nodeLine(i,ms:lines[Latency.lineOrder[i]],state:states[i])}
        }.padding(.leading,mac ? 60:66).padding(.trailing,16).padding(.bottom,10)
        .transition(.opacity)
    }
    private func nodeLine(_ i:Int,ms:Int?,state:LineState)->some View {
        let color:Color=ms == nil ? VeilbirdStyle.faint:((ms ?? 0)<0 ? VeilbirdStyle.danger.opacity(0.75):VeilbirdStyle.secondary)
        return HStack(spacing:7) {
            LineCells(states:[state],size:4)
            Text(lineName(i)).foregroundStyle(VeilbirdStyle.faint)
            Spacer(minLength:4)
            Text(lineValue(ms)).font(.system(size:11,design:.monospaced)).monospacedDigit().foregroundStyle(color)
        }.font(.system(size:12)).frame(height:24).accessibilityElement(children:.combine)
    }
    /// Connected (or reconnecting), one tap moves the VPN to the new location.
    private func choose(_ id:String,name:String) {
        let reconnect=model.connected && id != model.connectedNodeId
        model.selected=id;model.selectedName=name;tab=0
        if reconnect {model.work {try await model.reconnect()}}
    }

    // MARK: Account
    private var accountView:some View {
        let email=model.account["email"] as? String ?? ""
        let name=(model.account["name"] as? String).flatMap {$0.isEmpty ? nil:$0} ?? email
        return ScrollView {
            VStack(alignment:.leading,spacing:20) {
                #if os(iOS)
                FileHeader(number:fileNumber).padding(.bottom,-6)
                pageTitle(L10n.text("account"),section:"section_account")
                #endif
                HStack(spacing:14) {
                    Text(String(name.prefix(1)).uppercased()).font(.system(size:mac ? 16:19,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)
                        .frame(width:mac ? 40:48,height:mac ? 40:48).background(VeilbirdStyle.raised,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                    VStack(alignment:.leading,spacing:3) {
                        // The address is sealed on screen; pressing and holding opens it for as long as the finger stays.
                        SealedText(text:email,sealed:!revealEmail,size:mac ? 13:15).frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
                            .onLongPressGesture(minimumDuration:0.15,maximumDistance:40,perform:{},onPressingChanged:{revealEmail=$0})
                            .accessibilityLabel(Text(verbatim:email))
                        Text(L10n.text("hold_to_reveal")).font(.system(size:10,design:.monospaced)).tracking(0.9).foregroundStyle(VeilbirdStyle.faint)
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
                    settingRow(L10n.text("appearance"),L10n.text(appearance == "moon" ? "theme_moon":"theme_amber")) {choosingAppearance=true}
                        .confirmationDialog(L10n.text("appearance"),isPresented:$choosingAppearance,titleVisibility:.visible) {
                            Button(L10n.text("theme_amber")) {appearance="amber"}
                            Button(L10n.text("theme_moon")) {appearance="moon"}
                            Button(L10n.text("cancel"),role:.cancel) {}
                        }
                    Hairline()
                    Toggle(isOn:$model.killSwitch) {
                        VStack(alignment:.leading,spacing:2) {
                            Text(L10n.text("kill_switch")).font(.system(size:VeilbirdStyle.body))
                            Text(L10n.text("kill_switch_apple_detail")).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).fixedSize(horizontal:false,vertical:true)
                        }
                    }.toggleStyle(.switch).controlSize(mac ? .small:.regular).tint(VeilbirdStyle.accent).padding(.horizontal,16).padding(.vertical,8).frame(minHeight:mac ? 40:50)
                    Hairline()
                    #if os(iOS)
                    settingRow(L10n.text("shortcuts"),L10n.text("shortcuts_detail")) {if let url=URL(string:"shortcuts://") {openURL(url)}}
                    #else
                    Toggle(isOn:Binding(get:{openAtLogin},set:{value in
                        do {if value {try SMAppService.mainApp.register()} else {try SMAppService.mainApp.unregister()};openAtLogin=value} catch {model.message=error.localizedDescription}
                    })) {Text(L10n.text("open_at_login")).font(.system(size:VeilbirdStyle.body))}
                        .toggleStyle(.switch).controlSize(.small).tint(VeilbirdStyle.accent).padding(.horizontal,16).frame(minHeight:40)
                    Hairline()
                    Toggle(isOn:$menuBarSpeed) {Text(L10n.text("menu_bar_speed")).font(.system(size:VeilbirdStyle.body))}
                        .toggleStyle(.switch).controlSize(.small).tint(VeilbirdStyle.accent).padding(.horizontal,16).frame(minHeight:40)
                    #endif
                    Hairline()
                    settingRow(L10n.text("check_for_updates"),updateValue) {
                        if let update=model.update {model.startUpdate(update) {openURL($0)}} else {Task {await model.checkForUpdate();if model.update == nil {model.message=L10n.text("up_to_date")}}}
                    }
                    Hairline()
                    settingRow(L10n.text("whats_new"),appVersion) {whatsNew=true}
                }
                Button {
                    if model.connected {model.message=L10n.text("disconnect_the_vpn_before_signing_out");return}
                    model.work {_ = try? await model.api().request("logout",[:]);try SecureStorage.write("token",nil);model.forgetNodes();model.signedIn=false;model.account=[:];tab=0}
                } label:{Text(L10n.text("sign_out")).font(.system(size:VeilbirdStyle.body)).foregroundStyle(VeilbirdStyle.danger).frame(maxWidth:.infinity).frame(height:mac ? 40:50)}
                    .buttonStyle(RowButton()).cardOutline(VeilbirdStyle.radius).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                // The diagnostic log has no visible entry: seven taps on the version open it.
                Text(verbatim:"TRACKNOTHING "+appVersion).font(Pixel.font(mac ? 12:13)).tracking(1.5).foregroundStyle(VeilbirdStyle.faint)
                    .frame(maxWidth:.infinity).padding(.vertical,4).contentShape(Rectangle()).onTapGesture {
                        if Date().timeIntervalSince(firstTap)>4 {versionTaps=0;firstTap=Date()}
                        versionTaps+=1
                        if versionTaps>=7 {versionTaps=0;tab=3}
                    }
            }.padding(.horizontal,16).padding(.top,mac ? 8:8).padding(.bottom,20)
        }.task {if model.account.isEmpty {model.work {try await model.loadAccount()}} else {try? await model.loadAccount()}}
    }
    /// Today / this month / 30 days: the range's total, a bar per day for the last 30 days with the range lit, and for 30 days
    /// the download / upload split. Days are the server's (UTC) days.
    @ViewBuilder private var usageCard:some View {
        if let traffic=model.account["traffic"] as? [String:Any] {
            let down=Int64(String(describing:traffic["downloadBytes"] ?? "0")) ?? 0, up=Int64(String(describing:traffic["uploadBytes"] ?? "0")) ?? 0
            let days=dailyUsage(traffic)
            let today=days.last ?? 0
            let dayOfMonth=Calendar(identifier:.gregorian).dateComponents(in:TimeZone(identifier:"UTC")!,from:Date()).day ?? 1
            let month=days.suffix(min(30,dayOfMonth)).reduce(0,+)
            VStack(alignment:.leading,spacing:mac ? 10:12) {
                HStack(spacing:2) {
                    ForEach([("today","usage_today"),("month","usage_this_month"),("30d","last_30_days")],id:\.0) {item in
                        Button {usageRange=item.0} label:{
                            Text(L10n.text(item.1)).font(.system(size:mac ? 12:13,weight:.medium)).lineLimit(1).padding(.horizontal,12).frame(height:mac ? 26:32)
                                .foregroundStyle(usageRange==item.0 ? VeilbirdStyle.text:VeilbirdStyle.secondary)
                                .background(usageRange==item.0 ? VeilbirdStyle.raised:Color.clear,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius)).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityAddTraits(usageRange==item.0 ? .isSelected:[])
                    }
                }.padding(2).background(VeilbirdStyle.ground,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                totalText(bytes(usageRange=="today" ? today:(usageRange=="month" ? month:down+up)))
                if !days.isEmpty {UsageBars(values:days,recent:usageRange=="today" ? 1:(usageRange=="month" ? min(30,dayOfMonth):30)).frame(height:mac ? 46:58)}
                if usageRange=="30d" {
                    HStack(spacing:20) {
                        Text(L10n.text("download_amount",bytes(down)));Text(L10n.text("upload_amount",bytes(up)))
                    }.font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).monospacedDigit()
                }
            }.padding(16).cardOutline(VeilbirdStyle.radius)
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
        for day in days {perDay[String((day["day"] as? String ?? "").prefix(10))]=Int64(String(describing:day["bytes"] ?? "0")) ?? 0}
        let formatter=DateFormatter();formatter.calendar=Calendar(identifier:.gregorian);formatter.locale=Locale(identifier:"en_US_POSIX");formatter.timeZone=TimeZone(identifier:"UTC");formatter.dateFormat="yyyy-MM-dd"
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
        // Both logs' lines start with an ISO 8601 time (20 characters): sorting on it merges them in order.
        let lines=(Journal.read()+"\n"+model.tunnelLog).split(separator:"\n").enumerated()
        let log=lines.sorted {($0.element.prefix(20),$0.offset)<($1.element.prefix(20),$1.offset)}.map {$0.element}.joined(separator:"\n")
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
                    Button {Journal.clear();model.clearTunnelLog();tab=2;tab=3} label:{logAction(L10n.text("clear_action"),color:VeilbirdStyle.danger)}.buttonStyle(.plain)
                }
                // Newest first: the last attempt is what someone opening the log is looking for.
                Text(log.isEmpty ? L10n.text("logs_empty"):log.split(separator:"\n").reversed().joined(separator:"\n"))
                    .font(.system(size:11,design:.monospaced)).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).padding(12)
                    .cardOutline(VeilbirdStyle.radius)
            }.padding(.horizontal,16).padding(.bottom,20)
        }.onAppear {model.loadTunnelLog()}
    }
    private func logAction(_ title:String,color:Color=VeilbirdStyle.text)->some View {
        Text(title).font(.system(size:VeilbirdStyle.detail+1,weight:.medium)).foregroundStyle(color).frame(maxWidth:.infinity).frame(height:mac ? 32:44)
            .cardOutline(VeilbirdStyle.radius)
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

extension ClientView {
    var appVersion:String {Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"}
    /// The account row's value: the same state as the banner.
    var updateValue:String {
        guard let update=model.update else {return L10n.text("up_to_date")}
        if model.downloading {return L10n.text("update_downloading_value","\(UpdateBanner.percent(model.downloadProgress,update))%")}
        if update.direct && UpdateDownloader.downloaded(update) != nil {return L10n.text("update_open_installer")}
        return L10n.text("update_banner_title",update.version)
    }
}

/// The update banner on the home screen: available, downloading (size, time left, a bar of square blocks), ready, failed.
struct UpdateBanner:View {
    @EnvironmentObject private var model:ClientModel
    @Environment(\.openURL) private var openURL
    @State private var notesShown=false
    let update:ReleaseUpdate

    static func percent(_ progress:UpdateDownloader.Progress?,_ update:ReleaseUpdate)->Int {
        Int(min(100,max(0,(progress?.received ?? 0)*100/max(1,progress?.size ?? update.size))))
    }
    private var meta:String {
        let progress=model.downloadProgress,format=ByteCountFormatter()
        let seconds=progress?.seconds ?? -1
        let left=seconds<0 ? "":(seconds<60 ? L10n.text("update_seconds","\(seconds)"):L10n.text("update_minutes","\((seconds+59)/60)"))
        return "\(format.string(fromByteCount:progress?.received ?? 0)) / \(format.string(fromByteCount:update.size))"+(left.isEmpty ? "":" · "+L10n.text("update_time_left",left))
    }
    var body:some View {
        if model.downloading {downloading}
        else if update.direct,let file=UpdateDownloader.downloaded(update) {
            row(L10n.text("update_ready_title",update.version),L10n.text("update_ready_detail_idle")) {button(L10n.text("update_open_installer"),filled:true) {model.installUpdate(file)}}
        } else if !model.downloadError.isEmpty {
            row(L10n.text("update_failed_title",update.version),L10n.text(model.downloadError=="digest" ? "update_failed_digest":model.downloadError=="storage" ? "update_failed_storage":"update_failed_network")) {
                button(L10n.text("update_retry")) {model.startUpdate(update) {openURL($0)}}
            }
        } else if !model.dismissed(update) {
            row(L10n.text(update.mandatory ? "update_required_title":"update_banner_title",update.version),
                update.mandatory ? L10n.text("update_required_detail"):(L10n.notes(update.notes).first ?? L10n.text("update_available_detail"))) {
                button(L10n.text("update_action")) {model.startUpdate(update) {openURL($0)}}
                if !update.mandatory {
                    Button {model.dismiss(update)} label:{Image(systemName:"xmark").font(.system(size:11,weight:.semibold)).foregroundStyle(VeilbirdStyle.faint).frame(width:32,height:32).contentShape(Rectangle())}
                        .buttonStyle(.plain).accessibilityLabel(L10n.text("update_later"))
                }
            }
            // The banner shows the first improvement; a tap lists them all, with the update button.
            .contentShape(Rectangle()).onTapGesture {if L10n.notes(update.notes).count>1 {notesShown=true}}
            .alert(L10n.text("whats_new_title",update.version),isPresented:$notesShown) {
                Button(L10n.text("update_later"),role:.cancel) {}
                Button(L10n.text("update_action")) {model.startUpdate(update) {openURL($0)}}
            } message:{Text(L10n.notes(update.notes).map {"· "+$0}.joined(separator:"\n"))}
        }
    }
    private var downloading:some View {
        let percent=Self.percent(model.downloadProgress,update)
        return VStack(alignment:.leading,spacing:10) {
            HStack(spacing:8) {
                VStack(alignment:.leading,spacing:3) {
                    Text(L10n.text(update.mandatory ? "update_required_title":"update_downloading_title",update.version)).font(.system(size:VeilbirdStyle.body,weight:.medium)).lineLimit(1)
                    Text(meta).font(.system(size:VeilbirdStyle.detail-1,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
                }
                Spacer(minLength:8)
                Text(verbatim:"\(percent)%").font(Pixel.font(VeilbirdStyle.mac ? 20:24)).foregroundStyle(VeilbirdStyle.accent)
                if !update.mandatory {Button(L10n.text("cancel")) {model.cancelUpdate()}.buttonStyle(.plain).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).padding(.horizontal,6)}
            }
            HStack(spacing:3) {ForEach(0..<30,id:\.self) {index in Rectangle().fill(index<percent*30/100 ? VeilbirdStyle.accent:VeilbirdStyle.raised).frame(height:6)}}
                .accessibilityHidden(true)
        }.padding(14).cardOutline(VeilbirdStyle.radius)
            .accessibilityElement(children:.combine).accessibilityLabel(L10n.text("update_downloading_title",update.version)+", \(percent)%")
    }
    private func row<Actions:View>(_ title:String,_ detail:String,@ViewBuilder actions:()->Actions)->some View {
        HStack(spacing:8) {
            VStack(alignment:.leading,spacing:3) {
                Text(title).font(.system(size:VeilbirdStyle.body,weight:.medium)).lineLimit(1)
                Text(detail).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(2)
            }
            Spacer(minLength:8)
            actions()
        }.padding(.leading,14).padding(.trailing,8).padding(.vertical,12).cardOutline(VeilbirdStyle.radius)
    }
    private func button(_ title:String,filled:Bool=false,action:@escaping ()->Void)->some View {
        Button(action:action) {
            Text(title).font(.system(size:VeilbirdStyle.detail+1,weight:.semibold)).foregroundStyle(filled ? VeilbirdStyle.onAccent:VeilbirdStyle.accent)
                .padding(.horizontal,12).frame(minHeight:VeilbirdStyle.mac ? 28:36).background(filled ? VeilbirdStyle.accent.opacity(0.06):Color.clear,in:RoundedRectangle(cornerRadius:2))
                .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(filled ? VeilbirdStyle.accent.opacity(0.7):Color.clear,lineWidth:1))
        }.buttonStyle(.plain)
    }
}

/// The connect page's note while a system permission is missing: what it is and the one step that fixes it. It stays
/// until the permission is granted (the system's own prompt is easy to miss or dismiss).
struct PermissionNote:View {
    let permission:ClientModel.Permission
    let retry:()->Void
    var body:some View {
        HStack(spacing:10) {
            Rectangle().fill(VeilbirdStyle.accent).frame(width:6,height:6).accessibilityHidden(true)
            VStack(alignment:.leading,spacing:3) {
                Text(L10n.text("permission_needed_title")).font(.system(size:VeilbirdStyle.body,weight:.medium)).lineLimit(1)
                Text(L10n.text(permission == .systemExtension ? "allow_system_extension_short":"allow_vpn_configuration_short"))
                    .font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(2).fixedSize(horizontal:false,vertical:true)
            }
            Spacer(minLength:8)
            Button {
                #if os(macOS)
                if permission == .systemExtension {SystemExtension.openSettings();return}
                #endif
                retry()
            } label:{
                Text(L10n.text(permission == .systemExtension ? "open_settings_short":"retry_action")).font(.system(size:VeilbirdStyle.detail+1,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)
                    .lineLimit(1).padding(.horizontal,12).frame(minHeight:VeilbirdStyle.mac ? 28:36)
                    .background(VeilbirdStyle.accent.opacity(0.06),in:RoundedRectangle(cornerRadius:2))
                    .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(VeilbirdStyle.accent.opacity(0.7),lineWidth:1))
            }.buttonStyle(.plain)
        }.padding(.leading,14).padding(.trailing,8).padding(.vertical,12).cardOutline(VeilbirdStyle.radius)
        .accessibilityElement(children:.contain)
    }
}
