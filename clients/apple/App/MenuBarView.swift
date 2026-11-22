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

#if os(macOS)
/// The menu bar panel: one-click connect, the current location and usage, the window and quit.
struct MenuBarView:View {
    @EnvironmentObject private var model:ClientModel
    @Environment(\.openWindow) private var openWindow
    @AppStorage(VeilbirdStyle.themeKey) private var appearance="amber"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The location list is open in place of the portrait, so a location is picked without opening the window.
    @State private var picking=false
    @AppStorage(MenuBarLabel.preferenceKey) private var menuBarSpeed=false
    @State private var openAtLogin=SMAppService.mainApp.status == .enabled
    @State private var checking=false
    var body:some View {
        let on=model.connected && model.since != nil
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:8) {
                PixelMark(size:16)
                Wordmark(size:14)
                Spacer()
            }.padding(.horizontal,4)
            if model.signedIn {
                // The connect page in small: the state with its seal, one slot for time and rates or a message, one action.
                VStack(alignment:.leading,spacing:8) {
                    SectionRow(key:"section_portrait",step:model.onboarded ? nil:3)
                    menuPortrait(on)
                    // The state (or the cause of a failure) and two lines held for its detail: one height in every state.
                    VStack(alignment:.leading,spacing:3) {
                        Text(model.stateTitle).font(.system(size:20,weight:.light))
                            .foregroundStyle(model.ringState == .failed ? VeilbirdStyle.fair:(on ? VeilbirdStyle.accent:VeilbirdStyle.text)).lineLimit(1)
                        Text(model.stateDetail).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(2,reservesSpace:true)
                            .frame(maxWidth:.infinity,alignment:.leading)
                    }.padding(.horizontal,4).animation(.easeInOut(duration:0.2),value:model.ringState)
                    HStack(spacing:8) {
                        Button {act(model.trouble?.primaryDo)} label:{
                            HStack(spacing:8) {
                                if on {BreathingDot(on:true)}
                                Text(model.actionLabel).font(.system(size:13,weight:.semibold)).lineLimit(1)
                            }.padding(.horizontal,14).frame(maxWidth:.infinity).frame(height:40).contentShape(Rectangle())
                            .foregroundStyle(on ? VeilbirdStyle.text:VeilbirdStyle.onAccent)
                            .background(on ? VeilbirdStyle.raised:VeilbirdStyle.accent,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                        }.buttonStyle(.plain)
                        .accessibilityLabel(model.ringState == .failed ? model.actionLabel:L10n.text(model.connected ? (model.since == nil ? "cancel":"disconnect_action"):"connect_action"))
                        if let trouble=model.trouble,let second=trouble.secondary {
                            Button {act(trouble.secondaryDo)} label:{
                                Text(second).font(.system(size:13,weight:.medium)).lineLimit(1).fixedSize().foregroundStyle(VeilbirdStyle.text)
                                    .padding(.horizontal,14).frame(height:40).contentShape(Rectangle())
                                    .background(VeilbirdStyle.raised,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                            }.buttonStyle(.plain)
                        }
                    }
                }.opacity(picking ? 0:1).allowsHitTesting(!picking).accessibilityHidden(picking)
                // The list takes the portrait's place at the same size: the panel keeps its height, nothing moves.
                .overlay(alignment:.top) {if picking {locationPicker.transition(.opacity)}}
                .padding(.top,16).padding(.bottom,14)
                // The same update banner as the window, with its download progress.
                if let update=model.update {UpdateBanner(update:update).padding(.bottom,10)}
                Button {setPicking(!picking)} label:{
                    HStack(spacing:12) {
                        if model.connected && !model.connectedNodeId.isEmpty {Badge(code:model.code(model.connectedNodeId,name:model.nodeName),size:30)}
                        else if model.selected.isEmpty {Badge(icon:"sparkles",tint:VeilbirdStyle.accent,size:30)}
                        else {Badge(code:model.code(model.selected,name:model.selectedName),size:30)}
                        VStack(alignment:.leading,spacing:2) {
                            Text(model.connected && !model.nodeName.isEmpty ? model.nodeName:(model.selected.isEmpty ? L10n.text("automatic"):model.selectedName)).font(.system(size:13,weight:.medium)).lineLimit(1)
                            Text(L10n.text(model.routing=="smart" ? "routing_smart":"routing_global")).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary)
                        }
                        Spacer(minLength:8)
                        // Points up at the list while it is open.
                        Image(systemName:"chevron.right").font(.system(size:10,weight:.semibold)).foregroundStyle(picking ? VeilbirdStyle.accent:VeilbirdStyle.secondary)
                            .rotationEffect(.degrees(picking ? -90:0))
                    }.padding(.horizontal,12).frame(height:52)
                }.buttonStyle(RowButton()).cardOutline(VeilbirdStyle.radius).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                .accessibilityAddTraits(picking ? .isSelected:[]).accessibilityHint(L10n.text("tap_to_change"))
                quickSettings.padding(.top,8)
                let figures=UsageFigures(model.account)
                HStack(alignment:.top,spacing:12) {
                    cell(figures.trafficTitle,figures.traffic,figures.trafficTint,figures.trafficTitleTint)
                    cell(figures.untilTitle,figures.until,figures.untilTint,figures.untilTitleTint)
                }.padding(.horizontal,6).padding(.vertical,12)
            } else {
                Text(L10n.text("sign_in_tagline")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).padding(.vertical,16).padding(.horizontal,4)
            }
            Rectangle().fill(VeilbirdStyle.hairline).frame(height:0.5).padding(.horizontal,4)
            VStack(spacing:0) {
                menuItem(L10n.text("open_app"),shortcut:"⌘O") {openMain()}.keyboardShortcut("o")
                if model.signedIn {menuItem(L10n.text("check_for_updates"),shortcut:updateValue) {checkUpdate()}}
                menuItem(L10n.text("quit_app"),shortcut:"⌘Q") {NSApp.terminate(nil)}.keyboardShortcut("q")
            }.padding(.top,6)
        }.padding(.horizontal,12).padding(.top,14).padding(.bottom,8).frame(width:320)
        .background(VeilbirdStyle.ground).foregroundStyle(VeilbirdStyle.text).preferredColorScheme(.dark)
        .environment(\.locale, L10n.locale).id(appearance).task {try? await model.loadAccount()}
        .task {if model.visitorIP == nil && !model.connected {model.visitorIP=try? await model.api().visitorAddress()}}
        .onExitCommand {if picking {setPicking(false)}}
        .onAppear {model.showing(true)}
        .onDisappear {picking=false;model.showing(false)}
    }
    private func setPicking(_ open:Bool) {
        withAnimation(reduceMotion ? nil:.easeInOut(duration:0.2)) {picking=open}
        guard open else {return}
        // The saved list shows at once; only a device with none loads it, and only nodes never measured are measured.
        if model.nodes.isEmpty {model.work {try await model.loadNodes()}}
        else if model.unmeasured {Task {await model.measure()}}
    }
    /// The locations, fastest first, as in the window: automatic, then each one with its delay. The selected one is a
    /// lifted row with an amber tile. Connected, a pick moves the VPN there at once; the list then closes.
    private var locationPicker:some View {
        VStack(alignment:.leading,spacing:8) {
            SectionLabel(key:"section_locations")
            ScrollView {
                VStack(spacing:0) {
                    pickerRow(id:"",name:L10n.text("automatic"),badge:Badge(icon:"sparkles",tint:VeilbirdStyle.accent,size:24,selected:model.selected.isEmpty),delay:nil,unreachable:false)
                    ForEach(model.nodes.indices,id:\.self) {i in nodePickerRow(model.nodes[i])}
                    if model.nodes.isEmpty {
                        Text(model.busy ? "…":L10n.text("no_locations_available_refresh_or_contact_your_administrator")).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary)
                            .frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,10).padding(.vertical,10)
                    }
                }
            }.scrollIndicators(.automatic)
        }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
    }
    // Small typed pieces: as one expression the optimized (release) build cannot type-check it in time.
    private func nodePickerRow(_ node:[String:Any])->some View {
        let id=node["id"] as? String ?? "",name=node["name"] as? String ?? ""
        let quality=Latency.recent(id)
        let unreachable=quality != nil && quality?.latency == nil
        let tint:Color=unreachable ? VeilbirdStyle.faint:VeilbirdStyle.text
        let badge=Badge(code:model.code(id,name:name),tint:tint,size:24,selected:model.selected==id)
        return pickerRow(id:id,name:name,badge:badge,delay:delayText(quality),unreachable:unreachable)
    }
    private func delayText(_ quality:Quality?)->String? {
        guard let quality else {return model.measuring ? "…":nil}
        return quality.latency.map {L10n.text("latency_ms",L10n.number($0))} ?? L10n.text("quality_unreachable")
    }
    private func pickerRow(id:String,name:String,badge:Badge,delay:String?,unreachable:Bool)->some View {
        let selected=model.selected==id
        return Button {pick(id,name:name)} label:{
            HStack(spacing:10) {
                badge
                Text(name).font(.system(size:13,weight:selected ? .semibold:.regular)).lineLimit(1)
                    .foregroundStyle(unreachable && !selected ? VeilbirdStyle.faint:VeilbirdStyle.text)
                Spacer(minLength:8)
                Text(delay ?? "").font(.system(size:11)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.75)
                    .foregroundStyle(unreachable ? VeilbirdStyle.danger:VeilbirdStyle.secondary).frame(width:72,alignment:.trailing)
            }.padding(.horizontal,10).frame(height:36).contentShape(Rectangle())
            .background(selected ? VeilbirdStyle.raised:Color.clear)
        }.buttonStyle(RowButton()).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        .accessibilityLabel(name+(delay.map {", "+$0} ?? "")).accessibilityAddTraits(selected ? .isSelected:[])
    }
    /// The window's choice in small: connected (or reconnecting) to another location, the VPN moves there.
    private func pick(_ id:String,name:String) {
        let reconnect=model.connected && id != model.connectedNodeId && !(id.isEmpty && model.selected.isEmpty)
        model.selected=id;model.selectedName=name
        setPicking(false)
        if reconnect {model.work {try await model.reconnect()}}
    }
    private func mbps(_ bytes:Int)->String {String(format:"%.1f",locale:L10n.locale,Double(bytes)*8/1_000_000)}
    private func cell(_ title:String,_ value:String,_ tint:Color,_ titleTint:Color)->some View {
        VStack(alignment:.leading,spacing:2) {
            Text(title).font(.system(size:11)).foregroundStyle(titleTint).lineLimit(1)
            Text(value).font(.system(size:13,weight:.medium)).foregroundStyle(tint).monospacedDigit().lineLimit(1)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
    private func menuItem(_ title:String,shortcut:String,action:@escaping ()->Void)->some View {
        Button(action:action) {
            HStack {Text(title).lineLimit(1).layoutPriority(1);Spacer(minLength:8);Text(shortcut).foregroundStyle(VeilbirdStyle.faint).lineLimit(1)}.font(.system(size:13)).padding(.horizontal,8).frame(height:26).contentShape(Rectangle())
        }.buttonStyle(RowButton()).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }
    private func toggle() {
        if !model.connected && model.permission == .systemExtension {SystemExtension.openSettings();return}
        model.work {
            try await model.toggle()
            // The extension guide lives in the main window.
            if model.extensionGuide {openMain()}
        }
    }
    /// The settings people change most, as four tiles, so the window need not open: smart routing (connected, the
    /// VPN moves to the new mode at once), kill switch (likewise), open at login and the speed in the menu bar.
    private var quickSettings:some View {
        Grid(horizontalSpacing:8,verticalSpacing:8) {
            GridRow {
                QuickTile(icon:"arrow.triangle.branch",title:L10n.text("quick_smart_routing"),on:model.routing == "smart") {
                    model.routing=model.routing == "smart" ? "global":"smart";applyNow()
                }
                QuickTile(icon:"lock.shield",title:L10n.text("kill_switch"),on:model.killSwitch) {model.killSwitch.toggle();applyNow()}
            }
            GridRow {
                QuickTile(icon:"power",title:L10n.text("quick_open_at_login"),on:openAtLogin) {
                    let value = !openAtLogin
                    do {if value {try SMAppService.mainApp.register()} else {try SMAppService.mainApp.unregister()};openAtLogin=value} catch {model.message=error.localizedDescription}
                }
                QuickTile(icon:"speedometer",title:L10n.text("quick_menu_bar_speed"),on:menuBarSpeed) {menuBarSpeed.toggle()}
            }
        }
    }
    /// A tunnel that is up takes a changed routing or kill switch at once, by connecting again.
    private func applyNow() {
        guard model.connected && model.since != nil else {return}
        model.work {try await model.reconnect()}
    }
    /// The window's update row in small: the same value, and the same action once an update is known.
    private var updateValue:String {
        if checking {return L10n.text("checking_for_updates")}
        guard let update=model.update else {return L10n.text("up_to_date")}
        if model.downloading {return L10n.text("update_downloading_value","\(UpdateBanner.percent(model.downloadProgress,update))%")}
        if update.direct && UpdateDownloader.downloaded(update) != nil {return L10n.text(ClientModel.installsInPlace ? "update_install_relaunch":"update_open_installer")}
        return L10n.text("update_banner_title",update.version)
    }
    private func checkUpdate() {
        if let update=model.update {model.startUpdate(update) {NSWorkspace.shared.open($0)};return}
        guard !checking else {return}
        checking=true
        Task {await model.checkForUpdate();checking=false}
    }
    /// The home portrait in small: the sphere is the switch, and its ring draws the state once hidden.
    private func menuPortrait(_ on:Bool)->some View {
        Button {toggle()} label:{
            TimelineView(.periodic(from:.now,by:1)) {context in
                let state=model.ringState
                PortraitView(hidden:model.connected || state == .reconnecting,invite:"",since:on ? model.since:nil,
                    sub:model.portraitSub(state,rates:L10n.text("connection_rates",mbps(model.rxRate),mbps(model.txRate))),state:state,lines:model.lines,centre:model.portraitCentre(state,now:context.date))
            }.frame(maxWidth:.infinity).frame(height:150).contentShape(Circle())
        }.buttonStyle(.plain).accessibilityLabel(L10n.text(model.connected ? "disconnect_action":"connect_action"))
    }
    /// What a failure's button does here; a page of the app (devices, account, locations) opens the window.
    private func act(_ what:String?) {
        switch what {
        case "automatic":model.selected="";model.selectedName="";toggle()
        case "settings":SystemExtension.openSettings()
        case "signin":try? SecureStorage.write("token",nil);model.failed=false;model.failureCode="";model.signedIn=false;openMain()
        case "devices","account","nodes","update":openMain()
        default:toggle()
        }
    }
    private func openMain() {DockPresence.show(true);openWindow(id:"main");NSApp.activate(ignoringOtherApps:true)}
}
/// One quick setting: a filled tile, its icon lit in the accent while the setting is on. No outline; the label may
/// take two lines, the tile's height never changes.
private struct QuickTile:View {
    let icon:String,title:String,on:Bool,action:()->Void
    var body:some View {
        Button(action:action) {
            HStack(spacing:10) {
                Image(systemName:icon).font(.system(size:12,weight:.semibold))
                    .foregroundStyle(on ? VeilbirdStyle.onAccent:VeilbirdStyle.secondary)
                    .frame(width:28,height:28).background(on ? VeilbirdStyle.accent:VeilbirdStyle.selected,in:Circle())
                Text(title).font(.system(size:12,weight:.medium)).lineLimit(2).minimumScaleFactor(0.85).multilineTextAlignment(.leading)
                Spacer(minLength:0)
            }.padding(.horizontal,10).frame(maxWidth:.infinity).frame(height:52).contentShape(Rectangle())
            .animation(.easeInOut(duration:0.15),value:on)
        }.buttonStyle(RowButton()).background(VeilbirdStyle.surface).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        .accessibilityLabel(title).accessibilityValue(L10n.text(on ? "on_state":"off_state"))
    }
}
/// The menu bar icon. With "Show speed in menu bar" on and the tunnel up, upload and download rates sit beside
/// it on two short lines. A menu bar label can only hold an image and a title, so the two lines are drawn into a
/// template image (it follows the light or dark menu bar); monospaced digits padded to four characters keep the
/// item's width fixed while the rates change. Disconnected, it is the icon alone.
struct MenuBarLabel:View {
    static let preferenceKey="menuBarSpeed"
    @ObservedObject var model:ClientModel
    @AppStorage(MenuBarLabel.preferenceKey) private var showSpeed=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openWindow) private var openWindow
    @State private var blink=false
    private let ticker=Timer.publish(every:0.6,on:.main,in:.common).autoconnect()
    var body:some View {
        // The ∅ mark as a template image, in three levels: off (half), busy (blinking: connecting, switching lines,
        // reconnecting, waiting for a network) and on (full).
        let state=model.ringState
        let busy=[RingState.connecting,.switching,.reconnecting,.waiting].contains(state)
        let on=state == .connected || (busy && (blink || reduceMotion))
        icon(on:on).onReceive(ticker) {_ in if busy {blink.toggle()} else if blink {blink=false}}
            // Always on screen, so it lends the window opener to a click on a reminder notification.
            .onAppear {let open=openWindow;DockPresence.openMain={open(id:"main")}}
    }
    @ViewBuilder private func icon(on:Bool)->some View {
        // Traffic or time running out: a small amber dot on the mark, and the reminder for VoiceOver.
        let reminder=AccountAccess(model.account).line
        let suffix=reminder.map {" · "+$0} ?? ""
        if showSpeed,on,model.since != nil,let image=Self.image(on:on,rx:model.rxRate,tx:model.txRate) {
            Image(nsImage:reminder == nil ? image:Self.dottedRates(image)).accessibilityLabel("TrackNothing "+L10n.text("connection_rates",Self.mbps(model.rxRate),Self.mbps(model.txRate))+suffix)
        } else if let image=Self.mark(on:on) {
            Image(nsImage:reminder == nil ? image:Self.dottedMark(on:on,image)).accessibilityLabel("TrackNothing"+suffix)
        } else {
            Image(systemName:on ? "slash.circle.fill":"slash.circle").accessibilityLabel("TrackNothing")
        }
    }
    /// "↑  820 Kb/s" / "↓ 12.4 Mb/s": bits per second like the rest of the app, the unit stepping up as needed.
    static func line(_ arrow:String,_ bytes:Int)->String {
        let bits=Double(max(bytes,0))*8
        let number:String,unit:String
        if bits<1e6 {number=String(Int((bits/1e3).rounded()));unit="rate_unit_kbps"}
        else if bits<99.95e6 {number=String(format:"%.1f",locale:L10n.locale,bits/1e6);unit="rate_unit_mbps"}
        else if bits<999.5e6 {number=String(Int((bits/1e6).rounded()));unit="rate_unit_mbps"}
        else {number=String(format:"%.1f",locale:L10n.locale,bits/1e9);unit="rate_unit_gbps"}
        return arrow+" "+String(repeating:" ",count:max(0,4-number.count))+number+" "+L10n.text(unit)
    }
    private static func mbps(_ bytes:Int)->String {String(format:"%.1f",locale:L10n.locale,Double(bytes)*8/1_000_000)}
    private static func glyph(on:Bool)->some View {EmptySetMark().fill(Color.black.opacity(on ? 1:0.5)).frame(width:15,height:15)}
    @MainActor private static var marks:[Bool:NSImage]=[:]
    @MainActor static func mark(on:Bool)->NSImage? {
        if let cached=marks[on] {return cached}
        let renderer=ImageRenderer(content:glyph(on:on).padding(.horizontal,1))
        renderer.scale=NSScreen.main?.backingScaleFactor ?? 2
        guard let image=renderer.nsImage else {return nil}
        image.isTemplate=true
        marks[on]=image
        return image
    }
    /// The image with an amber dot at the mark's top right, cut out of the mark by a thin clear ring. A template
    /// image can only be one colour, so this one is not: the mark is filled with the menu bar's text colour at draw
    /// time (light or dark menu bar), then the dot goes on top.
    @MainActor static func dotted(_ base:NSImage)->NSImage {
        let image=NSImage(size:base.size,flipped:false) {rect in
            base.draw(in:rect)
            NSColor.labelColor.set();rect.fill(using:.sourceAtop)
            guard let context=NSGraphicsContext.current?.cgContext else {return true}
            // The mark is 15 pt square, 1 pt from the left edge and centred vertically.
            let center=CGPoint(x:15,y:(rect.height+15)/2-3)
            context.setBlendMode(.clear);context.fillEllipse(in:MenuBarLabel.dotRect(center,radius:4))
            context.setBlendMode(.normal);context.setFillColor(red:224/255,green:164/255,blue:88/255,alpha:1)
            context.fillEllipse(in:MenuBarLabel.dotRect(center,radius:2.75))
            return true
        }
        image.isTemplate=false
        return image
    }
    @MainActor private static var dottedMarks:[Bool:NSImage]=[:]
    @MainActor static func dottedMark(on:Bool,_ base:NSImage)->NSImage {
        if let cached=dottedMarks[on] {return cached}
        let image=dotted(base);dottedMarks[on]=image
        return image
    }
    /// The rates image changes only when the rates do; so does its dotted copy.
    @MainActor private static var lastDotted:(base:NSImage,image:NSImage)?
    @MainActor static func dottedRates(_ base:NSImage)->NSImage {
        if let last=lastDotted,last.base === base {return last.image}
        let image=dotted(base);lastDotted=(base,image)
        return image
    }
    private static func dotRect(_ center:CGPoint,radius:CGFloat)->CGRect {
        CGRect(x:center.x-radius,y:center.y-radius,width:radius*2,height:radius*2)
    }
    /// The last rates image and its two lines: the label is redrawn whenever the model changes, the rates mostly not.
    @MainActor private static var lastRates:(key:String,image:NSImage)?
    @MainActor static func image(on:Bool,rx:Int,tx:Int)->NSImage? {
        let key=line("↑",tx)+"\n"+line("↓",rx)+(on ? "1":"0")
        if let last=lastRates,last.key == key {return last.image}
        guard let image=renderRates(on:on,rx:rx,tx:tx) else {return nil}
        lastRates=(key,image)
        return image
    }
    @MainActor private static func renderRates(on:Bool,rx:Int,tx:Int)->NSImage? {
        let content=HStack(spacing:4) {
            glyph(on:on)
            VStack(alignment:.trailing,spacing:-1) {
                Text(verbatim:line("↑",tx))
                Text(verbatim:line("↓",rx))
            }.font(.system(size:9,weight:.medium,design:.monospaced)).lineLimit(1).fixedSize()
        }.foregroundStyle(Color.black).padding(.horizontal,1)
        let renderer=ImageRenderer(content:content)
        renderer.scale=NSScreen.main?.backingScaleFactor ?? 2
        guard let image=renderer.nsImage else {return nil}
        image.isTemplate=true
        return image
    }
}
#endif
