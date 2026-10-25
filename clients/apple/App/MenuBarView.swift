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
    var body:some View {
        let on=model.connected && model.since != nil
        let state:RingState=model.connected ? (on ? .connected:.connecting):(model.failed ? .failed:.idle)
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:8) {
                PixelMark(size:16)
                Wordmark(size:14)
                Spacer()
                if on {Rectangle().fill(VeilbirdStyle.accent).frame(width:6,height:6)}
                Text(L10n.text(on ? "connected_status":(model.connected ? "connecting":(model.failed ? "connect_failed_title":"not_connected")))).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)
            }.padding(.horizontal,4)
            if model.signedIn {
                VStack(spacing:12) {
                    Button {model.work {try await model.toggle()}} label:{ConnectRing(state:state,size:126)}.buttonStyle(.plain)
                        .accessibilityLabel(L10n.text(model.connected ? (model.since == nil ? "cancel":"disconnect_action"):"connect_action"))
                    if let since=model.since {
                        HStack(alignment:.firstTextBaseline,spacing:12) {
                            TimelineView(.periodic(from:since,by:1)) {context in
                                Text(verbatim:Duration.seconds(Int(context.date.timeIntervalSince(since))).formatted(.time(pattern:.hourMinuteSecond))).font(Pixel.font(22)).foregroundStyle(VeilbirdStyle.text)
                            }
                            Text(L10n.text("connection_rates",mbps(model.rxRate),mbps(model.txRate))).font(.system(size:11,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary)
                        }
                    } else {
                        Text(model.failed ? model.failure:L10n.text("tap_ring_to_connect")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).multilineTextAlignment(.center).lineLimit(2)
                    }
                }.frame(maxWidth:.infinity).padding(.top,20).padding(.bottom,16)
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
                }.buttonStyle(RowButton()).background(Color(red:26/255,green:34/255,blue:28/255),in:RoundedRectangle(cornerRadius:10)).clipShape(RoundedRectangle(cornerRadius:10))
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
        .background(Color(red:18/255,green:25/255,blue:21/255)).foregroundStyle(VeilbirdStyle.text).preferredColorScheme(.dark)
        .environment(\.locale, L10n.locale).task {try? await model.loadAccount()}
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
        }.buttonStyle(RowButton()).clipShape(RoundedRectangle(cornerRadius:6))
    }
    private func openMain() {openWindow(id:"main");NSApp.activate(ignoringOtherApps:true)}
}
#endif
