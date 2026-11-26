import WidgetKit
import SwiftUI
import AppIntents
import AppKit

/// TrackNothing on the Mac desktop and in Control Center. Since 1.0.50 the buttons act in place: connect, disconnect,
/// move to a location, switch smart and global routing. The extension cannot run the tunnel (that needs the app's
/// sign-in), so a button hands the request to the menu bar app (WidgetCommand) and shows the press until the app
/// has done it and redrawn the widgets. A click anywhere else opens the app; disconnecting needs the button.
@main
struct TrackNothingWidgets:WidgetBundle {
    var body:some Widget {
        StatusWidget()
        PlaceWidget()
        #if compiler(>=6.2)
        if #available(macOS 26.0,*) {
            ConnectControl()
            RoutingControl()
            PlaceControl()
        }
        #endif
    }
}

// MARK: Actions

/// A widget button: records the press in the snapshot (so the widget redraws with it at once), passes the request
/// to the app and starts the app, without its window, when it is not running.
struct WidgetActionIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("widget_strip",table:"Native")
    static var isDiscoverable=false
    @Parameter(title:"Action") var action:String
    @Parameter(title:"Value") var value:String
    init() {}
    init(_ action:String,_ value:String="") {self.action=action;self.value=value}
    func perform() async throws -> some IntentResult {
        WidgetActions.run(action,value)
        return .result()
    }
}
enum WidgetActions {
    static func run(_ action:String,_ value:String) {
        if var snapshot=WidgetSnapshot.load() {
            snapshot.pending=value.isEmpty ? action:action+":"+value
            if action == "routing" {snapshot.routing=value}
            snapshot.save()
        }
        WidgetCommand(action:action,value:value).send()
        wakeApp()
    }
    /// The app around this extension (TrackNothing.app/Contents/PlugIns/…appex); started in the background when it is
    /// not running, and it then does the waiting command.
    private static func wakeApp() {
        let app=Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard let id=Bundle(url:app)?.bundleIdentifier,NSRunningApplication.runningApplications(withBundleIdentifier:id).isEmpty else {return}
        let configuration=NSWorkspace.OpenConfiguration()
        configuration.activates=false
        NSWorkspace.shared.openApplication(at:app,configuration:configuration) {_,_ in}
    }
}

/// A location for the one-place widget and the Control Center location button, from the list the app shares.
struct PlaceEntity:AppEntity {
    static var typeDisplayRepresentation=TypeDisplayRepresentation(name:LocalizedStringResource("location",table:"Native"))
    static var defaultQuery=PlaceQuery()
    static let automaticId="automatic"
    let id:String
    let name:String
    var displayRepresentation:DisplayRepresentation {DisplayRepresentation(title:"\(name)")}
    static func all()->[PlaceEntity] {
        let snapshot=WidgetSnapshot.load()
        let automatic=PlaceEntity(id:automaticId,name:snapshot?.label("automatic").nonEmpty ?? "Automatic")
        return [automatic]+(snapshot?.all ?? []).map {PlaceEntity(id:$0.id,name:$0.name)}
    }
}
struct PlaceQuery:EntityStringQuery {
    func entities(for identifiers:[String]) async throws -> [PlaceEntity] {
        let all=PlaceEntity.all()
        return identifiers.compactMap {id in all.first {$0.id == id}}
    }
    func entities(matching string:String) async throws -> [PlaceEntity] {
        PlaceEntity.all().filter {$0.name.range(of:string,options:[.caseInsensitive,.diacriticInsensitive]) != nil}
    }
    func suggestedEntities() async throws -> [PlaceEntity] {PlaceEntity.all()}
}
extension String {
    var nonEmpty:String? {isEmpty ? nil:self}
}

// MARK: Timeline

struct StatusEntry:TimelineEntry {
    let date:Date
    let snapshot:WidgetSnapshot?
    let globe:NSImage?
    var place:PlaceEntity?=nil
    static func now(_ place:PlaceEntity?=nil)->StatusEntry {
        let globe=WidgetSnapshot.folder.flatMap {NSImage(contentsOf:$0.appendingPathComponent(WidgetSnapshot.picture))}
        return StatusEntry(date:Date(),snapshot:WidgetSnapshot.load(),globe:globe,place:place)
    }
    static var sample:StatusEntry {
        var s=WidgetSnapshot(on:true,title:"Hidden",place:"Tokyo",since:Date().addingTimeInterval(-1260))
        s.code="JP";s.ms=38;s.routing="smart";s.rx=1_300_000;s.tx=84_000
        s.favorites=[WidgetPlace(id:"a",name:"Tokyo",code:"JP",ms:38),WidgetPlace(id:"b",name:"Singapore",code:"SG",ms:31),
                     WidgetPlace(id:"c",name:"Frankfurt",code:"DE",ms:186),WidgetPlace(id:"d",name:"Los Angeles",code:"US",ms:142)]
        s.placeId="a"
        s.labels=["disconnect":"Disconnect","connect":"Connect","smart":"Smart","global":"Global","favorites":"Favorites","ms":"ms","here":"Connect here","inUse":"In use","cancel":"Cancel","lines":"# lines"]
        return StatusEntry(date:Date(),snapshot:s,globe:nil)
    }
}
/// The app reloads the timelines whenever something changes, so one entry is enough.
struct StatusProvider:TimelineProvider {
    func placeholder(in context:Context)->StatusEntry {.sample}
    func getSnapshot(in context:Context,completion:@escaping (StatusEntry)->Void) {
        let entry=StatusEntry.now()
        completion(entry.snapshot == nil ? .sample:entry)
    }
    func getTimeline(in context:Context,completion:@escaping (Timeline<StatusEntry>)->Void) {
        completion(Timeline(entries:[.now()],policy:.never))
    }
}

// MARK: Widgets

/// Small: a switch. Medium: the switch with three favorites and routing. Large: everything on one card.
/// The kind is the 1.0.48 one, so widgets already on the desktop keep their place.
struct StatusWidget:Widget {
    var body:some WidgetConfiguration {
        StaticConfiguration(kind:"TrackNothingStatus",provider:StatusProvider()) {entry in
            StatusView(entry:entry).containerBackground(for:.widget) {WidgetPalette(entry.snapshot?.theme ?? "amber").ground}
        }
        .configurationDisplayName(Text(LocalizedStringResource("widget_strip",table:"Native")))
        .description(Text(LocalizedStringResource("widget_mac_description",table:"Native")))
        .supportedFamilies([.systemSmall,.systemMedium,.systemLarge])
    }
}
struct PlaceWidgetIntent:WidgetConfigurationIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("widget_mac_place_name",table:"Native")
    @Parameter(title:LocalizedStringResource("location",table:"Native")) var place:PlaceEntity?
    init() {}
}
struct PlaceProvider:AppIntentTimelineProvider {
    func placeholder(in context:Context)->StatusEntry {.sample}
    func snapshot(for configuration:PlaceWidgetIntent,in context:Context) async -> StatusEntry {
        let entry=StatusEntry.now(configuration.place)
        return entry.snapshot == nil ? .sample:entry
    }
    func timeline(for configuration:PlaceWidgetIntent,in context:Context) async -> Timeline<StatusEntry> {
        Timeline(entries:[.now(configuration.place)],policy:.never)
    }
}
/// Small, one location the person picks in Edit Widget: a click on its button connects there.
struct PlaceWidget:Widget {
    var body:some WidgetConfiguration {
        AppIntentConfiguration(kind:"TrackNothingPlace",intent:PlaceWidgetIntent.self,provider:PlaceProvider()) {entry in
            PlaceView(entry:entry).containerBackground(for:.widget) {WidgetPalette(entry.snapshot?.theme ?? "amber").ground}
        }
        .configurationDisplayName(Text(LocalizedStringResource("widget_mac_place_name",table:"Native")))
        .description(Text(LocalizedStringResource("widget_mac_place_description",table:"Native")))
        .supportedFamilies([.systemSmall])
    }
}

/// The app's two palettes, the same values as VeilbirdStyle. On a dimmed desktop (vibrant or accented rendering)
/// macOS tints the widget, so everything is drawn in white tones that it can tint.
struct WidgetPalette {
    let moon:Bool
    var plain=false
    init(_ theme:String,_ mode:WidgetRenderingMode = .fullColor) {moon=theme == "moon";plain=mode != .fullColor}
    private func rgb(_ r:Double,_ g:Double,_ b:Double)->Color {Color(red:r/255,green:g/255,blue:b/255)}
    var ground:Color {moon ? rgb(10,8,9):rgb(8,7,6)}
    var raised:Color {plain ? Color.white.opacity(0.16):(moon ? rgb(46,40,42):rgb(46,43,38))}
    var soft:Color {plain ? Color.white.opacity(0.08):(moon ? rgb(244,238,232).opacity(0.06):rgb(237,231,223).opacity(0.06))}
    var text:Color {plain ? .white:(moon ? rgb(244,238,232):rgb(237,231,223))}
    var secondary:Color {plain ? Color.white.opacity(0.7):(moon ? rgb(172,160,162):rgb(163,155,145))}
    var faint:Color {plain ? Color.white.opacity(0.5):(moon ? rgb(152,138,142):rgb(149,139,124))}
    var accent:Color {plain ? .white:(moon ? rgb(235,184,195):rgb(224,164,88))}
    var onAccent:Color {plain ? .black:(moon ? rgb(38,20,26):rgb(28,19,7))}
}

// MARK: Pieces

/// Small helpers keep each view's expression short (the optimized build type-checks long ones slowly).
enum Format {
    static func rate(_ value:Int)->String {
        var bytes=Double(max(0,value));let units=["B","KB","MB","GB"];var i=0
        while bytes>=1024 && i<units.count-1 {bytes/=1024;i+=1}
        return (bytes<10 && i>0 ? String(format:"%.1f",bytes):String(format:"%.0f",bytes))+" "+units[i]+"/s"
    }
    static func ms(_ value:Int?,_ s:WidgetSnapshot)->String {
        guard let value else {return "—"}
        return "\(value) "+(s.label("ms").nonEmpty ?? "ms")
    }
}

struct StatusLine:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var body:some View {
        HStack(spacing:6) {
            Circle().fill(s.on ? p.accent:(s.busy ? p.secondary:p.faint)).frame(width:6,height:6)
            Text(s.title).font(.system(size:11,weight:.medium)).foregroundStyle(p.secondary).lineLimit(1)
        }
    }
}
struct CodeBadge:View {
    let code:String
    let p:WidgetPalette
    var inverted=false
    var body:some View {
        Text(code).font(.system(size:10,weight:.semibold,design:.monospaced))
            .foregroundStyle(inverted ? p.onAccent:p.accent)
            .padding(.horizontal,5).frame(height:18)
            .background((inverted ? p.onAccent.opacity(0.14):p.accent.opacity(0.16)),in:RoundedRectangle(cornerRadius:6,style:.continuous))
    }
}
/// The main button: connect (filled), disconnect, or cancel while connecting; a press shows "…" until the app answers.
struct MainButton:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var compact=false
    private var active:Bool {s.on || s.busy}
    private var pressed:Bool {["connect","disconnect","toggle"].contains(s.pending ?? "")}
    var body:some View {
        Button(intent:WidgetActionIntent(active ? "disconnect":"connect")) {
            HStack(spacing:7) {
                Image(systemName:pressed ? "ellipsis":"power").font(.system(size:11,weight:.bold))
                Text(active ? (s.busy ? s.label("cancel"):s.label("disconnect")):s.label("connect"))
                    .font(.system(size:13,weight:.semibold)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .foregroundStyle(active ? p.text:p.onAccent)
            .padding(.horizontal,compact ? 14:10)
            .frame(maxWidth:compact ? nil:.infinity).frame(height:32)
            .background(active ? p.raised:p.accent,in:Capsule())
        }.buttonStyle(.plain)
    }
}
/// A favorite: a click moves there (connecting if off). The one in use is filled.
struct PlaceRow:View {
    let place:WidgetPlace
    let s:WidgetSnapshot
    let p:WidgetPalette
    private var current:Bool {(s.on || s.busy) && s.placeId == place.id}
    private var pressed:Bool {s.pending == "place:"+place.id}
    var body:some View {
        Button(intent:WidgetActionIntent("place",place.id)) {
            HStack(spacing:8) {
                CodeBadge(code:place.code,p:p,inverted:current)
                Text(place.name).font(.system(size:12.5,weight:.medium)).lineLimit(1).minimumScaleFactor(0.85)
                Spacer(minLength:4)
                trailing
            }
            .foregroundStyle(current ? p.onAccent:p.text)
            .padding(.horizontal,10).frame(height:30)
            .background(current ? p.accent:p.soft,in:RoundedRectangle(cornerRadius:10,style:.continuous))
        }.buttonStyle(.plain)
    }
    @ViewBuilder private var trailing:some View {
        if pressed {
            Image(systemName:"ellipsis").font(.system(size:11,weight:.bold))
        } else if current {
            Image(systemName:"checkmark").font(.system(size:11,weight:.bold))
        } else {
            Text(Format.ms(place.ms,s)).font(.system(size:11,design:.monospaced)).foregroundStyle(p.secondary).lineLimit(1)
        }
    }
}
/// Smart | Global; a click switches (a running VPN connects again with it).
struct RoutingSwitch:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var body:some View {
        HStack(spacing:2) {
            segment("smart")
            segment("global")
        }
        .padding(2).frame(height:26)
        .background(p.soft,in:Capsule())
    }
    private func segment(_ value:String)->some View {
        let on=(s.routing ?? "smart") == value
        return Button(intent:WidgetActionIntent("routing",value)) {
            Text(s.label(value)).font(.system(size:11.5,weight:.medium)).lineLimit(1).minimumScaleFactor(0.8)
                .foregroundStyle(on ? p.text:p.secondary)
                .frame(maxWidth:.infinity,maxHeight:.infinity)
                .background(on ? p.raised:Color.clear,in:Capsule())
        }.buttonStyle(.plain)
    }
}
/// The download rate of the last half minute, newest (lit) last; flat while disconnected.
struct Spark:View {
    let values:[Int]
    let p:WidgetPalette
    var body:some View {
        let list=values.isEmpty ? Array(repeating:0,count:30):Array(values.suffix(30))
        let top=max(1,list.max() ?? 1)
        return HStack(alignment:.bottom,spacing:2) {
            ForEach(Array(list.enumerated()),id:\.offset) {item in
                RoundedRectangle(cornerRadius:1)
                    .fill(item.offset == list.count-1 ? p.accent:p.accent.opacity(0.26))
                    .frame(height:max(2,34*CGFloat(item.element)/CGFloat(top)))
            }
        }.frame(height:34,alignment:.bottom)
    }
}
struct Rates:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var body:some View {
        HStack(spacing:10) {
            Text("↓ "+Format.rate(s.rx ?? 0))
            Text("↑ "+Format.rate(s.tx ?? 0))
        }.font(.system(size:11,design:.monospaced)).foregroundStyle(p.secondary).lineLimit(1)
    }
}
/// Under the place: the time hidden while connected, the step while connecting, otherwise the hint.
struct UnderLine:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var body:some View {
        if s.on,let since=s.since {
            Text(since,style:.timer).font(.system(size:13,weight:.medium,design:.monospaced)).monospacedDigit().foregroundStyle(p.text).lineLimit(1)
        } else if s.busy,let text=s.phaseText {
            Text(text).font(.system(size:11)).foregroundStyle(p.secondary).lineLimit(1)
        } else {
            Text(s.hint).font(.system(size:11)).foregroundStyle(p.secondary).lineLimit(1)
        }
    }
}
/// Three short bars for the connect steps (route, tunnel, confirm).
struct Steps:View {
    let phase:Int
    let p:WidgetPalette
    var body:some View {
        HStack(spacing:3) {
            ForEach(0..<3,id:\.self) {i in
                Capsule().fill(i<phase ? p.accent:(i == phase ? p.accent.opacity(0.45):p.raised)).frame(height:3)
            }
        }
    }
}
/// Nothing shared yet (the app has not run since install, or is signed out): a click opens the app.
struct EmptyCard:View {
    let p:WidgetPalette
    var body:some View {
        VStack(alignment:.leading,spacing:6) {
            Text("TrackNothing").font(.system(size:17,weight:.semibold)).foregroundStyle(p.text)
            Text(LocalizedStringResource("open_app",table:"Native")).font(.system(size:11)).foregroundStyle(p.secondary)
        }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.bottomLeading)
        .widgetURL(WidgetSnapshot.openURL)
    }
}

// MARK: Status widget

struct StatusView:View {
    let entry:StatusEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var mode
    var body:some View {
        let p=WidgetPalette(entry.snapshot?.theme ?? "amber",mode)
        if let s=entry.snapshot,s.labels != nil {
            Group {
                switch family {
                case .systemMedium:MediumCard(s:s,p:p)
                case .systemLarge:LargeCard(s:s,p:p,globe:entry.globe)
                default:SmallCard(s:s,p:p)
                }
            }.widgetURL(WidgetSnapshot.openURL)
        } else {
            EmptyCard(p:p)
        }
    }
}
struct SmallCard:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var body:some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:6) {
                StatusLine(s:s,p:p)
                Spacer(minLength:4)
                if s.on {Text(Format.ms(s.ms,s)).font(.system(size:11,weight:.medium,design:.monospaced)).foregroundStyle(p.secondary).lineLimit(1)}
            }
            Spacer(minLength:4)
            Text(s.place).font(.system(size:22,weight:.semibold)).foregroundStyle(s.on ? p.accent:p.text)
                .lineLimit(1).minimumScaleFactor(0.7)
            UnderLine(s:s,p:p).padding(.top,2)
            MainButton(s:s,p:p).padding(.top,12)
        }
    }
}
struct MediumCard:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    var body:some View {
        HStack(spacing:14) {
            left.frame(width:134)
            right
        }
    }
    private var left:some View {
        VStack(alignment:.leading,spacing:0) {
            StatusLine(s:s,p:p)
            Spacer(minLength:4)
            Text(s.place).font(.system(size:22,weight:.semibold)).foregroundStyle(s.on ? p.accent:p.text)
                .lineLimit(1).minimumScaleFactor(0.7)
            UnderLine(s:s,p:p).padding(.top,2)
            if s.on {Rates(s:s,p:p).padding(.top,4)}
            if s.busy {Steps(phase:s.phase ?? 0,p:p).padding(.top,8)}
            MainButton(s:s,p:p).padding(.top,10)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
    private var right:some View {
        VStack(spacing:6) {
            ForEach((s.favorites ?? []).prefix(3),id:\.id) {place in PlaceRow(place:place,s:s,p:p)}
            Spacer(minLength:0)
            RoutingSwitch(s:s,p:p)
        }.frame(maxWidth:.infinity)
    }
}
struct LargeCard:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    let globe:NSImage?
    var body:some View {
        VStack(alignment:.leading,spacing:0) {
            header
            Spark(values:s.history ?? [],p:p).padding(.top,14)
            Text(s.label("favorites")).font(.system(size:10,weight:.medium,design:.monospaced)).foregroundStyle(p.faint)
                .textCase(.uppercase).lineLimit(1).padding(.top,14).padding(.bottom,7)
            favorites
            RoutingSwitch(s:s,p:p).padding(.top,10)
            Spacer(minLength:8)
            footer
        }
    }
    private var header:some View {
        ZStack(alignment:.topTrailing) {
            VStack(alignment:.leading,spacing:0) {
                StatusLine(s:s,p:p)
                Text(s.place).font(.system(size:28,weight:.semibold)).foregroundStyle(s.on ? p.accent:p.text)
                    .lineLimit(1).minimumScaleFactor(0.6).padding(.top,10)
                HStack(spacing:12) {
                    UnderLine(s:s,p:p)
                    if s.on {Text(Format.ms(s.ms,s)).font(.system(size:11,design:.monospaced)).foregroundStyle(p.secondary)}
                }.padding(.top,3)
                if s.on {Rates(s:s,p:p).padding(.top,5)} else if s.busy {Steps(phase:s.phase ?? 0,p:p).frame(width:120).padding(.top,8)}
            }.padding(.trailing,108).frame(maxWidth:.infinity,alignment:.leading)
            if let globe {
                Image(nsImage:globe).resizable().interpolation(.high).scaledToFit().frame(width:100,height:100).accessibilityHidden(true)
            }
        }
    }
    private var favorites:some View {
        let list=Array((s.favorites ?? []).prefix(4))
        return VStack(spacing:6) {
            ForEach(Array(stride(from:0,to:list.count,by:2)),id:\.self) {i in
                HStack(spacing:6) {
                    PlaceRow(place:list[i],s:s,p:p)
                    if i+1<list.count {PlaceRow(place:list[i+1],s:s,p:p)} else {Color.clear.frame(height:30)}
                }
            }
        }
    }
    private var footer:some View {
        HStack(alignment:.center,spacing:12) {
            VStack(alignment:.leading,spacing:5) {
                HStack {
                    Text(s.trafficTitle ?? "").font(.system(size:11)).foregroundStyle(p.secondary).lineLimit(1)
                    Spacer(minLength:6)
                    Text(s.traffic ?? "").font(.system(size:11,weight:.medium,design:.monospaced)).foregroundStyle(p.text).lineLimit(1)
                }
                if let share=s.trafficShare {
                    GeometryReader {box in
                        ZStack(alignment:.leading) {
                            Capsule().fill(p.raised)
                            Capsule().fill(p.accent).frame(width:max(4,box.size.width*share))
                        }
                    }.frame(height:4)
                }
                Text(s.until ?? "").font(.system(size:11)).foregroundStyle(p.faint).lineLimit(1).minimumScaleFactor(0.8)
            }.frame(maxWidth:.infinity)
            MainButton(s:s,p:p,compact:true).fixedSize()
        }
    }
}

// MARK: One-place widget

struct PlaceView:View {
    let entry:StatusEntry
    @Environment(\.widgetRenderingMode) private var mode
    var body:some View {
        let p=WidgetPalette(entry.snapshot?.theme ?? "amber",mode)
        if let s=entry.snapshot,s.labels != nil {
            PlaceCard(s:s,p:p,place:chosen(s)).widgetURL(WidgetSnapshot.openURL)
        } else {
            EmptyCard(p:p)
        }
    }
    /// The location picked in Edit Widget; Automatic when none is picked.
    private func chosen(_ s:WidgetSnapshot)->WidgetPlace {
        let id=entry.place?.id ?? PlaceEntity.automaticId
        if id != PlaceEntity.automaticId,let place=(s.all ?? []).first(where:{$0.id == id}) {return place}
        if id != PlaceEntity.automaticId,let place=entry.place {return WidgetPlace(id:place.id,name:place.name,code:String(place.name.prefix(1)).uppercased())}
        return WidgetPlace(id:"",name:s.label("automatic"),code:"A")
    }
}
struct PlaceCard:View {
    let s:WidgetSnapshot
    let p:WidgetPalette
    let place:WidgetPlace
    private var current:Bool {s.on && (s.placeId ?? "") == place.id}
    private var pressed:Bool {s.pending == "place:"+place.id}
    var body:some View {
        VStack(alignment:.leading,spacing:0) {
            HStack {
                CodeBadge(code:place.code,p:p)
                Spacer(minLength:4)
                if place.ms != nil {Text(Format.ms(place.ms,s)).font(.system(size:11,weight:.medium,design:.monospaced)).foregroundStyle(p.secondary).lineLimit(1)}
            }
            Spacer(minLength:4)
            Text(place.name).font(.system(size:22,weight:.semibold)).foregroundStyle(current ? p.accent:p.text)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(lines).font(.system(size:11)).foregroundStyle(p.secondary).lineLimit(1).padding(.top,3)
            button.padding(.top,12)
        }
    }
    private var lines:String {
        guard let count=place.lines else {return ""}
        return s.label("lines").replacingOccurrences(of:"#",with:String(count))
    }
    private var button:some View {
        Button(intent:WidgetActionIntent("place",place.id)) {
            HStack(spacing:7) {
                Text(current ? s.label("inUse"):s.label("here")).font(.system(size:13,weight:.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                Image(systemName:pressed ? "ellipsis":(current ? "checkmark":"arrow.right")).font(.system(size:11,weight:.bold))
            }
            .foregroundStyle(current ? p.text:p.onAccent)
            .frame(maxWidth:.infinity).frame(height:32)
            .background(current ? p.raised:p.accent,in:Capsule())
        }.buttonStyle(.plain)
    }
}

// MARK: Control Center (macOS 26)

#if compiler(>=6.2)
/// Connect or disconnect in place.
@available(macOS 26.0,*)
struct ConnectControl:ControlWidget {
    var body:some ControlWidgetConfiguration {
        StaticControlConfiguration(kind:"TrackNothingConnect",provider:ConnectedValue()) {on in
            ControlWidgetToggle(isOn:on,action:ConnectToggleIntent()) {
                Label {
                    Text(LocalizedStringResource("widget_strip",table:"Native"))
                } icon: {
                    Image(systemName:"shield")
                }
            } valueLabel: {isOn in
                Label {
                    Text(isOn ? (WidgetSnapshot.load()?.place ?? ""):"")
                } icon: {
                    Image(systemName:isOn ? "lock.shield.fill":"shield")
                }
            }
        }
        .displayName(LocalizedStringResource("widget_strip",table:"Native"))
    }
}
@available(macOS 26.0,*)
struct ConnectedValue:ControlValueProvider {
    var previewValue:Bool {false}
    func currentValue() async throws -> Bool {WidgetSnapshot.load()?.on ?? false}
}
@available(macOS 26.0,*)
struct ConnectToggleIntent:SetValueIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("connect_action",table:"Native")
    static var isDiscoverable=false
    @Parameter(title:"On") var value:Bool
    func perform() async throws -> some IntentResult {
        WidgetActions.run(value ? "connect":"disconnect","")
        return .result()
    }
}
/// Smart routing on, or global.
@available(macOS 26.0,*)
struct RoutingControl:ControlWidget {
    var body:some ControlWidgetConfiguration {
        StaticControlConfiguration(kind:"TrackNothingRouting",provider:SmartValue()) {smart in
            ControlWidgetToggle(isOn:smart,action:RoutingToggleIntent()) {
                Label {
                    Text(LocalizedStringResource("routing_smart",table:"Native"))
                } icon: {
                    Image(systemName:"arrow.triangle.branch")
                }
            } valueLabel: {isOn in
                Label {
                    Text(LocalizedStringResource(isOn ? "routing_smart":"routing_global",table:"Native"))
                } icon: {
                    Image(systemName:isOn ? "arrow.triangle.branch":"globe")
                }
            }
        }
        .displayName(LocalizedStringResource("routing_smart",table:"Native"))
    }
}
@available(macOS 26.0,*)
struct SmartValue:ControlValueProvider {
    var previewValue:Bool {true}
    func currentValue() async throws -> Bool {(WidgetSnapshot.load()?.routing ?? "smart") == "smart"}
}
@available(macOS 26.0,*)
struct RoutingToggleIntent:SetValueIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("routing_smart",table:"Native")
    static var isDiscoverable=false
    @Parameter(title:"Smart") var value:Bool
    func perform() async throws -> some IntentResult {
        WidgetActions.run("routing",value ? "smart":"global")
        return .result()
    }
}
/// One location the person picks when adding it: a click connects (or moves) there.
@available(macOS 26.0,*)
struct PlaceControl:ControlWidget {
    var body:some ControlWidgetConfiguration {
        AppIntentControlConfiguration(kind:"TrackNothingPlaceControl",provider:PlaceControlProvider()) {value in
            ControlWidgetButton(action:WidgetActionIntent("place",value.id)) {
                Label {
                    Text(verbatim:value.name)
                } icon: {
                    Image(systemName:value.current ? "mappin.circle.fill":"mappin.circle")
                }
            }
        }
        .displayName(LocalizedStringResource("widget_mac_place_name",table:"Native"))
        .promptsForUserConfiguration()
    }
}
@available(macOS 26.0,*)
struct PlaceControlIntent:ControlConfigurationIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("widget_mac_place_name",table:"Native")
    @Parameter(title:LocalizedStringResource("location",table:"Native")) var place:PlaceEntity?
    init() {}
}
struct PlaceControlValue {
    let id:String
    let name:String
    let current:Bool
}
@available(macOS 26.0,*)
struct PlaceControlProvider:AppIntentControlValueProvider {
    func previewValue(configuration:PlaceControlIntent)->PlaceControlValue {value(configuration)}
    func currentValue(configuration:PlaceControlIntent) async throws -> PlaceControlValue {value(configuration)}
    private func value(_ configuration:PlaceControlIntent)->PlaceControlValue {
        let place=configuration.place
        let id=place.map {$0.id == PlaceEntity.automaticId ? "":$0.id} ?? ""
        let snapshot=WidgetSnapshot.load()
        let name=place?.name ?? (snapshot?.label("automatic").nonEmpty ?? "TrackNothing")
        return PlaceControlValue(id:id,name:name,current:snapshot?.on == true && snapshot?.placeId == id)
    }
}
#endif
