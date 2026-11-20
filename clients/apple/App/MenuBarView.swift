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
    var body:some View {
        let on=model.connected && model.since != nil
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:8) {
                PixelMark(size:16)
                Wordmark(size:14)
                Spacer()
                Text(verbatim:"№ "+FileHeader.number(model.account["email"] as? String ?? "")).font(.system(size:11,design:.monospaced)).tracking(0.9).foregroundStyle(VeilbirdStyle.faint)
            }.padding(.horizontal,4)
            if model.signedIn {
                // The connect page in small: the state with its seal, one slot for time and rates or a message, one action.
                VStack(alignment:.leading,spacing:8) {
                    SectionLabel(key:"section_portrait")
                    menuPortrait(on)
                    HStack(alignment:.firstTextBaseline,spacing:10) {
                        Text(L10n.text(on ? "sealed_status":(model.connected ? "connecting":(model.failed ? "connect_failed_title":"exposed_status")))).font(.system(size:20,weight:.light,design:.serif))
                            .foregroundStyle(on ? VeilbirdStyle.accent:VeilbirdStyle.text).lineLimit(1).fixedSize()
                        Text(on ? L10n.text("seen_as",model.nodeName):(model.failed ? model.failure:L10n.text("exposed_detail"))).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(2)
                            .frame(maxWidth:.infinity,alignment:.leading)
                    }.frame(height:34).padding(.horizontal,4).animation(.easeInOut(duration:0.2),value:on)
                    // A missing system permission: say what and where, instead of a tap that seems to do nothing.
                    if let permission=model.permission {PermissionNote(permission:permission) {model.work {try await model.toggle()}}.padding(.bottom,8)}
                    Button {toggle()} label:{
                        HStack {
                            Text(L10n.text(on ? "unseal_action":(model.connected ? "sealing_detail":(model.failed ? "retry_action":"seal_action")))).font(.system(size:13,weight:.medium)).lineLimit(1)
                            Spacer(minLength:8)
                            BreathingDot(on:model.connected)
                        }.padding(.horizontal,14).frame(height:40).contentShape(Rectangle())
                        .foregroundStyle(on ? VeilbirdStyle.accent:VeilbirdStyle.text)
                        .background(on ? VeilbirdStyle.accent.opacity(0.06):VeilbirdStyle.accent.opacity(0.09))
                        .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(on ? VeilbirdStyle.accent.opacity(0.7):VeilbirdStyle.accent,lineWidth:1))
                    }.buttonStyle(.plain)
                    .accessibilityLabel(L10n.text(model.connected ? (model.since == nil ? "cancel":"disconnect_action"):"connect_action"))
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
                let figures=UsageFigures(model.account)
                HStack(alignment:.top,spacing:12) {
                    cell(figures.trafficTitle,figures.traffic,figures.trafficTint)
                    cell(L10n.text("valid_until_label"),figures.until,figures.untilTint)
                }.padding(.horizontal,6).padding(.vertical,12)
            } else {
                Text(L10n.text("sign_in_tagline")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).padding(.vertical,16).padding(.horizontal,4)
            }
            Rectangle().fill(VeilbirdStyle.hairline).frame(height:0.5).padding(.horizontal,4)
            VStack(spacing:0) {
                menuItem(L10n.text("open_app"),shortcut:"⌘O") {openMain()}.keyboardShortcut("o")
                menuItem(L10n.text("quit_app"),shortcut:"⌘Q") {NSApp.terminate(nil)}.keyboardShortcut("q")
            }.padding(.top,6)
        }.padding(.horizontal,12).padding(.top,14).padding(.bottom,8).frame(width:320)
        .background(VeilbirdStyle.ground).foregroundStyle(VeilbirdStyle.text).preferredColorScheme(.dark)
        .environment(\.locale, L10n.locale).id(appearance).task {try? await model.loadAccount()}
        .onExitCommand {if picking {setPicking(false)}}
        .onDisappear {picking=false}
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
    private func cell(_ title:String,_ value:String,_ tint:Color)->some View {
        VStack(alignment:.leading,spacing:2) {
            Text(title).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary)
            Text(value).font(.system(size:13,weight:.medium)).foregroundStyle(tint).monospacedDigit().lineLimit(1)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
    private func menuItem(_ title:String,shortcut:String,action:@escaping ()->Void)->some View {
        Button(action:action) {
            HStack {Text(title);Spacer();Text(shortcut).foregroundStyle(VeilbirdStyle.faint)}.font(.system(size:13)).padding(.horizontal,8).frame(height:26).contentShape(Rectangle())
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
    /// The home portrait in small: the sphere is the switch, and its ring holds the time and rates once hidden.
    private func menuPortrait(_ on:Bool)->some View {
        Button {toggle()} label:{
            PortraitView(hidden:model.connected,invite:L10n.text("tap_to_hide"),since:on ? model.since:nil,
                sub:ClientModel.notices.contains(model.status) ? L10n.text(model.status):L10n.text("connection_rates",mbps(model.rxRate),mbps(model.txRate)))
                .frame(maxWidth:.infinity).frame(height:150).contentShape(Circle())
        }.buttonStyle(.plain).accessibilityLabel(L10n.text(model.connected ? "disconnect_action":"connect_action"))
    }
    private func openMain() {DockPresence.show(true);openWindow(id:"main");NSApp.activate(ignoringOtherApps:true)}
}
/// The menu bar icon. With "Show speed in menu bar" on and the tunnel up, upload and download rates sit beside
/// it on two short lines. A menu bar label can only hold an image and a title, so the two lines are drawn into a
/// template image (it follows the light or dark menu bar); monospaced digits padded to four characters keep the
/// item's width fixed while the rates change. Disconnected, it is the icon alone.
struct MenuBarLabel:View {
    static let preferenceKey="menuBarSpeed"
    @ObservedObject var model:ClientModel
    @AppStorage(MenuBarLabel.preferenceKey) private var showSpeed=false
    var body:some View {
        // The ∅ mark as a template image: full strength while connected, half while not.
        let on=model.connected
        if showSpeed,on,model.since != nil,let image=Self.image(on:on,rx:model.rxRate,tx:model.txRate) {
            Image(nsImage:image).accessibilityLabel("TrackNothing "+L10n.text("connection_rates",Self.mbps(model.rxRate),Self.mbps(model.txRate)))
        } else if let image=Self.mark(on:on) {
            Image(nsImage:image).accessibilityLabel("TrackNothing")
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
    @MainActor static func image(on:Bool,rx:Int,tx:Int)->NSImage? {
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
