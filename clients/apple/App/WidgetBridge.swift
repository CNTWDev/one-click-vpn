#if os(macOS)
import SwiftUI
import WidgetKit
import AppKit

/// Keeps the desktop widgets and the Control Center button current: on every change of the connection it writes
/// what they show (WidgetSnapshot) and a small globe into the shared app group container and asks WidgetKit to
/// redraw. Called once a second by the model; does nothing while nothing changed.
@MainActor enum WidgetBridge {
    private static var lastKey=""
    static func update(_ model:ClientModel) {
        let state=model.ringState
        let on=state == .connected
        let busy=[.connecting,.switching,.reconnecting].contains(state)
        let exit=model.globeExit
        let place=on && !model.nodeName.isEmpty ? model.nodeName:(exit?.label ?? (model.selectedName.isEmpty ? L10n.text("automatic"):model.selectedName))
        let origin=model.globeOrigin
        let key=[String(describing:state),place,model.routing,L10n.language,VeilbirdStyle.theme,
                 String(model.since?.timeIntervalSince1970 ?? 0),String(exit?.lat ?? 0),String(origin?.lat ?? 0)].joined(separator:"|")
        guard key != lastKey,let folder=WidgetSnapshot.folder else {return}
        lastKey=key
        let snapshot=WidgetSnapshot(on:on,busy:busy,title:model.stateTitle,place:place,since:on ? model.since:nil,
            detail:L10n.text(model.routing == "smart" ? "routing_smart":"routing_global"),
            action:L10n.text(on || busy ? "disconnect_status":"connect_action"),hint:L10n.text("widget_tap"),theme:VeilbirdStyle.theme)
        snapshot.save()
        if let data=picture(exit:on ? exit:nil,origin:origin) {try? data.write(to:folder.appendingPathComponent(WidgetSnapshot.picture),options:.atomic)}
        WidgetCenter.shared.reloadAllTimelines()
    }
    /// The globe as on the usage page's trail: home and, connected, the arc to the exit. 140 pt at 2×.
    private static func picture(exit:Spot?,origin:Spot?)->Data? {
        let globe=TrailGlobe(exits:exit.map {[TrailExit(spot:Spot(lat:$0.lat,lon:$0.lon),weight:1)]} ?? [],home:origin,labels:false)
            .frame(width:140,height:140).environment(\.displayScale,2)
        let renderer=ImageRenderer(content:globe)
        renderer.scale=2
        guard let image=renderer.cgImage else {return nil}
        return NSBitmapImageRep(cgImage:image).representation(using:.png,properties:[:])
    }
    /// tracknothing://toggle from a widget: connect or disconnect as the main button does; anything else opens the window.
    static func open(_ url:URL) {
        guard url.scheme == "tracknothing" else {return}
        if url.host == "toggle",let model=ClientModel.running {
            Journal.add("connect: requested from a widget")
            model.work {try await model.toggle()}
            return
        }
        DockPresence.show(true);DockPresence.openMain?();NSApp.activate(ignoringOtherApps:true)
    }
}
#endif
