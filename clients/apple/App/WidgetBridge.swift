#if os(macOS)
import SwiftUI
import WidgetKit
import AppKit

/// Keeps the desktop widgets and the Control Center controls current, and does what their buttons ask.
/// On every change it writes what they show (WidgetSnapshot) and a small globe into the shared app group container
/// and asks WidgetKit to redraw; while connected it also refreshes the rates about once a minute (WidgetKit limits
/// how often widgets redraw, so they are snapshots). A widget button writes a WidgetCommand and posts a Darwin
/// notification; the app does it here as its own buttons would, without opening its window.
@MainActor enum WidgetBridge {
    private static var lastKey=""
    private static var lastWrite=Date.distantPast
    private static var lastGlobe=""
    /// Called once a second by the model; does nothing while nothing changed.
    static func update(_ model:ClientModel) {
        let state=model.ringState
        let on=state == .connected
        let busy=[.connecting,.switching,.reconnecting].contains(state)
        let exit=model.globeExit
        let id=on && !model.connectedNodeId.isEmpty ? model.connectedNodeId:model.selected
        let place=on && !model.nodeName.isEmpty ? model.nodeName:(exit?.label ?? (model.selectedName.isEmpty ? L10n.text("automatic"):model.selectedName))
        let origin=model.globeOrigin
        let favorites=favoritePlaces(model)
        let figures=UsageFigures(model.account)
        let key=[String(describing:state),place,model.routing,L10n.language,VeilbirdStyle.theme,String(model.phase),
                 String(model.since?.timeIntervalSince1970 ?? 0),String(exit?.lat ?? 0),String(origin?.lat ?? 0),
                 favorites.map {$0.id+String($0.ms ?? -1)}.joined(separator:","),String(model.nodes.count),
                 figures.traffic,figures.until,String(model.signedIn)].joined(separator:"|")
        // Connected, the rates change all the time: redraw them about once a minute.
        let stale=on && Date().timeIntervalSince(lastWrite)>=60
        guard key != lastKey || stale,let folder=WidgetSnapshot.folder else {return}
        lastKey=key;lastWrite=Date()
        let quality=id.isEmpty ? nil:Latency.recent(id)
        let access=AccountAccess(model.account)
        var snapshot=WidgetSnapshot(on:on,busy:busy,title:model.stateTitle,place:place,since:on ? model.since:nil,
            detail:L10n.text(model.routing == "smart" ? "routing_smart":"routing_global"),
            action:L10n.text(on || busy ? "disconnect_status":"connect_action"),hint:hint(model,on:on || busy),theme:VeilbirdStyle.theme)
        snapshot.placeId=id
        snapshot.code=id.isEmpty ? nil:model.code(id,name:place)
        snapshot.ms=on ? quality?.latency:nil
        snapshot.rx=on ? model.rxRate:nil
        snapshot.tx=on ? model.txRate:nil
        snapshot.history=on ? Array(model.rxHistory.suffix(30)):nil
        snapshot.routing=model.routing
        snapshot.phase=busy ? model.phase:nil
        snapshot.phaseText=busy ? model.phaseText:nil
        snapshot.favorites=favorites
        snapshot.all=Array(model.nodes.compactMap(widgetPlace).prefix(80))
        if !model.account.isEmpty {
            snapshot.trafficTitle=figures.trafficTitle;snapshot.traffic=figures.traffic;snapshot.until=figures.untilTitle+" "+figures.until
            if let quota=access.quota,quota>0 {snapshot.trafficShare=max(0,min(1,Double(access.remaining)/Double(quota)))}
        }
        snapshot.labels=labels()
        snapshot.save()
        let globeKey="\(exit?.lat ?? 0),\(exit?.lon ?? 0),\(origin?.lat ?? 0),\(on)"
        if globeKey != lastGlobe,let data=picture(exit:on ? exit:nil,origin:origin) {
            lastGlobe=globeKey
            try? data.write(to:folder.appendingPathComponent(WidgetSnapshot.picture),options:.atomic)
        }
        WidgetCenter.shared.reloadAllTimelines()
        #if compiler(>=6.2)
        if #available(macOS 26.0,*) {ControlCenter.shared.reloadAllControls()}
        #endif
    }
    /// Disconnected on Automatic: where it would go (the fastest location); otherwise nothing.
    private static func hint(_ model:ClientModel,on:Bool)->String {
        guard !on,model.selected.isEmpty,let fastest=model.nodes.min(by:{score($0)<score($1)}),
              Latency.recent(fastest["id"] as? String ?? "")?.latency != nil,let name=fastest["name"] as? String else {return ""}
        return L10n.text("widget_fastest",name)
    }
    private static func score(_ node:[String:Any])->Int {Latency.recent(node["id"] as? String ?? "")?.score ?? Int.max}
    /// Favorites in the list's order; without any, the four fastest locations.
    private static func favoritePlaces(_ model:ClientModel)->[WidgetPlace] {
        let favorites=Advanced.favorites
        let chosen=favorites.isEmpty ? model.nodes.sorted {score($0)<score($1)}:model.nodes.filter {favorites.contains($0["id"] as? String ?? "")}
        return Array(chosen.compactMap(widgetPlace).prefix(4))
    }
    private static func widgetPlace(_ node:[String:Any])->WidgetPlace? {
        guard let id=node["id"] as? String,let name=node["name"] as? String,!id.isEmpty else {return nil}
        let code=(node["countryCode"] as? String).flatMap {$0.isEmpty ? nil:$0.uppercased()} ?? String(name.prefix(1)).uppercased()
        let lines=((node["test"] as? [[String:Any]]) ?? []).filter {Latency.lineOrder.contains($0["name"] as? String ?? "")}.count
        return WidgetPlace(id:id,name:name,code:code,ms:Latency.recent(id)?.latency,lines:lines>0 ? lines:nil)
    }
    /// The words the widgets use, in the app's language; "#" stands for the number in "lines".
    private static func labels()->[String:String] {
        ["disconnect":L10n.text("disconnect_status"),"connect":L10n.text("connect_action"),"cancel":L10n.text("cancel"),
         "here":L10n.text("widget_connect_here"),"inUse":L10n.text("widget_in_use"),"smart":L10n.text("routing_smart"),
         "global":L10n.text("routing_global"),"favorites":L10n.text("favorites"),"automatic":L10n.text("automatic"),
         "ms":L10n.text("latency_ms","").trimmingCharacters(in:.whitespaces),"lines":L10n.text("widget_lines","#")]
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

    // MARK: Buttons

    /// Listens for widget buttons, and does one pressed while the app was starting.
    static func listen() {
        stopStaleWidgets()
        guard let name=WidgetCommand.notification else {return}
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(),nil,{_,_,_,_,_ in
            Task {@MainActor in WidgetBridge.takeCommand()}
        },name as CFString,nil,.deliverImmediately)
        // Started by a widget button (the app was not running): the model needs a moment to load the VPN configuration.
        Task {@MainActor in try? await Task.sleep(nanoseconds:1_500_000_000);takeCommand()}
    }
    /// A widget process still running from a replaced copy of the app (an update, or the app replaced in Finder)
    /// answers WidgetKit with the old widgets and its drawings are refused, so the widgets stay blank. Stop it;
    /// WidgetKit starts the new one when it next needs it.
    private static func stopStaleWidgets() {
        let pgrep=Process()
        pgrep.executableURL=URL(fileURLWithPath:"/usr/bin/pgrep")
        pgrep.arguments=["-x","TrackNothingWidgets"]
        let pipe=Pipe();pgrep.standardOutput=pipe;pgrep.standardError=FileHandle.nullDevice
        guard (try? pgrep.run()) != nil else {return}
        pgrep.waitUntilExit()
        let output=String(data:pipe.fileHandleForReading.readDataToEndOfFile(),encoding:.utf8) ?? ""
        let own=Bundle.main.bundlePath+"/"
        var stopped=false
        for pid in output.split(whereSeparator:\.isNewline).compactMap({Int32($0)}) {
            var buffer=[CChar](repeating:0,count:4096)
            let path=proc_pidpath(pid,&buffer,UInt32(buffer.count))>0 ? String(cString:buffer):""
            if !path.hasPrefix(own) {kill(pid,SIGTERM);stopped=true;Journal.add("widgets: stopped a widget process from an old copy")}
        }
        guard stopped else {return}
        Task {@MainActor in
            try? await Task.sleep(nanoseconds:1_000_000_000)
            WidgetCenter.shared.reloadAllTimelines()
            #if compiler(>=6.2)
            if #available(macOS 26.0,*) {ControlCenter.shared.reloadAllControls()}
            #endif
        }
    }
    private static func takeCommand() {
        guard let command=WidgetCommand.take() else {return}
        guard let model=ClientModel.running,model.signedIn else {openWindow();return}
        Journal.add("connect: \(command.action) requested from a widget")
        let active=model.connected || [.connecting,.switching,.reconnecting].contains(model.ringState)
        switch command.action {
        case "connect":if !active {model.work {try await model.toggle()}}
        case "disconnect":if active {model.work {try await model.toggle()}}
        case "toggle":model.work {try await model.toggle()}
        case "place":
            let id=command.value
            let name=id.isEmpty ? "":(model.nodes.first {$0["id"] as? String == id}?["name"] as? String ?? "")
            let move=model.connected && id != model.connectedNodeId
            model.selected=id;model.selectedName=name
            if move {model.work {try await model.reconnect()}} else if !active {model.work {try await model.toggle()}}
        case "routing":
            guard ["smart","global"].contains(command.value),command.value != model.routing else {break}
            model.routing=command.value
            if model.connected && model.since != nil {model.work {try await model.reconnect()}}
        default:openWindow()
        }
        lastKey="" // redraw now, which also clears the press the widget is showing
        update(model)
    }
    private static func openWindow() {DockPresence.show(true);DockPresence.openMain?();NSApp.activate(ignoringOtherApps:true)}
    /// tracknothing://toggle (widgets of 1.0.48–1.0.49 and the "open" click): connect or disconnect as the main
    /// button does; anything else opens the window.
    static func open(_ url:URL) {
        guard url.scheme == "tracknothing" else {return}
        if url.host == "toggle",let model=ClientModel.running {
            Journal.add("connect: requested from a widget")
            model.work {try await model.toggle()}
            return
        }
        if url.host == "widget" {takeCommand();return}
        openWindow()
    }
}
#endif
