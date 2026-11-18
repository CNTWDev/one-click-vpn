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
                    SectionLabel(key:"section_status")
                    HStack(spacing:10) {
                        Text(L10n.text(on ? "sealed_status":(model.connected ? "connecting":(model.failed ? "connect_failed_title":"exposed_status")))).font(.system(size:24,weight:.light)).lineLimit(1)
                        Spacer(minLength:0)
                        SealStamp(shown:model.connected)
                    }.padding(.horizontal,4)
                    // One fixed-height slot for the time and rates or a short message, so the menu keeps its size.
                    ZStack(alignment:.leading) {
                    if let since=model.since {
                        HStack(alignment:.firstTextBaseline,spacing:12) {
                            TimelineView(.periodic(from:since,by:1)) {context in
                                Text(verbatim:Duration.seconds(Int(context.date.timeIntervalSince(since))).formatted(.time(pattern:.hourMinuteSecond))).font(.system(size:13,design:.monospaced)).monospacedDigit().foregroundStyle(VeilbirdStyle.text)
                            }
                            Text(L10n.text("connection_rates",mbps(model.rxRate),mbps(model.txRate))).font(.system(size:11,design:.monospaced)).monospacedDigit().foregroundStyle(VeilbirdStyle.secondary)
                        }.transition(.opacity)
                    } else {
                        Text(model.failed ? model.failure:L10n.text("exposed_detail")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(2)
                            .transition(.opacity)
                    }
                    }.frame(maxWidth:.infinity,alignment:.leading).frame(height:30).padding(.horizontal,4).animation(.easeInOut(duration:0.2),value:on)
                    Button {model.work {try await model.toggle()}} label:{
                        HStack {
                            Text(L10n.text(on ? "unseal_action":(model.connected ? "sealing_detail":(model.failed ? "retry_action":"seal_action")))).font(.system(size:13,weight:.medium)).lineLimit(1)
                            Spacer(minLength:8)
                            BreathingDot(on:model.connected)
                        }.padding(.horizontal,14).frame(height:40).contentShape(Rectangle())
                        .foregroundStyle(on ? VeilbirdStyle.accent:VeilbirdStyle.text)
                        .background(on ? VeilbirdStyle.accent.opacity(0.06):Color.clear)
                        .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(on ? VeilbirdStyle.accent.opacity(0.7):VeilbirdStyle.text.opacity(0.24),lineWidth:1))
                    }.buttonStyle(.plain)
                    .accessibilityLabel(L10n.text(model.connected ? (model.since == nil ? "cancel":"disconnect_action"):"connect_action"))
                }.padding(.top,16).padding(.bottom,14)
                // The same update banner as the window, with its download progress.
                if let update=model.update {UpdateBanner(update:update).padding(.bottom,10)}
                Button {openMain()} label:{
                    HStack(spacing:12) {
                        if model.connected && !model.connectedNodeId.isEmpty {Badge(code:model.code(model.connectedNodeId,name:model.nodeName),size:30)}
                        else if model.selected.isEmpty {Badge(icon:"sparkles",tint:VeilbirdStyle.accent,size:30)}
                        else {Badge(code:model.code(model.selected,name:model.selectedName),size:30)}
                        VStack(alignment:.leading,spacing:2) {
                            Text(model.connected && !model.nodeName.isEmpty ? model.nodeName:(model.selected.isEmpty ? L10n.text("automatic"):model.selectedName)).font(.system(size:13,weight:.medium)).lineLimit(1)
                            Text(L10n.text(model.routing=="smart" ? "routing_smart":"routing_global")).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary)
                        }
                        Spacer(minLength:8)
                        Image(systemName:"chevron.right").font(.system(size:10,weight:.semibold)).foregroundStyle(VeilbirdStyle.secondary)
                    }.padding(.horizontal,12).frame(height:52)
                }.buttonStyle(RowButton()).cardOutline(VeilbirdStyle.radius).clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
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
    private func openMain() {openWindow(id:"main");NSApp.activate(ignoringOtherApps:true)}
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
        let symbol=model.connected ? "slash.circle.fill":"slash.circle"
        if showSpeed,model.connected,model.since != nil,let image=Self.image(symbol:symbol,rx:model.rxRate,tx:model.txRate) {
            Image(nsImage:image).accessibilityLabel("TrackNothing "+L10n.text("connection_rates",Self.mbps(model.rxRate),Self.mbps(model.txRate)))
        } else {
            Image(systemName:symbol).accessibilityLabel("TrackNothing")
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
    @MainActor static func image(symbol:String,rx:Int,tx:Int)->NSImage? {
        let content=HStack(spacing:4) {
            Image(systemName:symbol).font(.system(size:14))
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
