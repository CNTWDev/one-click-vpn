import WidgetKit
import SwiftUI
import AppIntents
import AppKit

/// TrackNothing on the Mac desktop and in Control Center: the state, the exit city and the time hidden, with the
/// globe the app draws. The widget only shows; a click opens the app's address and the app connects or disconnects
/// (the tunnel needs the app's sign-in, which an extension does not have).
@main
struct TrackNothingWidgets:WidgetBundle {
    var body:some Widget {
        StatusWidget()
        #if compiler(>=6.2)
        if #available(macOS 26.0,*) {ConnectControl()}
        #endif
    }
}

struct StatusEntry:TimelineEntry {
    let date:Date
    let snapshot:WidgetSnapshot
    let globe:NSImage?
}

struct StatusProvider:TimelineProvider {
    static let sample=WidgetSnapshot(on:true,title:"TrackNothing",place:"Tokyo",since:Date().addingTimeInterval(-1260),detail:"",action:"",hint:"")
    func placeholder(in context:Context)->StatusEntry {StatusEntry(date:Date(),snapshot:Self.sample,globe:nil)}
    func getSnapshot(in context:Context,completion:@escaping (StatusEntry)->Void) {completion(entry() ?? placeholder(in:context))}
    /// The app reloads the timeline whenever the connection changes, so one entry is enough.
    func getTimeline(in context:Context,completion:@escaping (Timeline<StatusEntry>)->Void) {
        completion(Timeline(entries:[entry() ?? placeholder(in:context)],policy:.never))
    }
    private func entry()->StatusEntry? {
        guard let snapshot=WidgetSnapshot.load() else {return nil}
        let globe=WidgetSnapshot.folder.flatMap {NSImage(contentsOf:$0.appendingPathComponent(WidgetSnapshot.picture))}
        return StatusEntry(date:Date(),snapshot:snapshot,globe:globe)
    }
}

struct StatusWidget:Widget {
    var body:some WidgetConfiguration {
        StaticConfiguration(kind:"TrackNothingStatus",provider:StatusProvider()) {entry in
            StatusView(entry:entry).containerBackground(for:.widget) {WidgetPalette(entry.snapshot.theme).ground}
        }
        .configurationDisplayName(Text(LocalizedStringResource("widget_strip",table:"Native")))
        .description(Text(LocalizedStringResource("widget_mac_description",table:"Native")))
        .supportedFamilies([.systemSmall,.systemMedium])
    }
}

/// The app's two palettes, the same values as VeilbirdStyle.
struct WidgetPalette {
    let moon:Bool
    init(_ theme:String) {moon=theme == "moon"}
    private func rgb(_ r:Double,_ g:Double,_ b:Double)->Color {Color(red:r/255,green:g/255,blue:b/255)}
    var ground:Color {moon ? rgb(10,8,9):rgb(8,7,6)}
    var raised:Color {moon ? rgb(34,29,31):rgb(33,31,28)}
    var text:Color {moon ? rgb(244,238,232):rgb(237,231,223)}
    var secondary:Color {moon ? rgb(172,160,162):rgb(163,155,145)}
    var faint:Color {moon ? rgb(152,138,142):rgb(149,139,124)}
    var accent:Color {moon ? rgb(235,184,195):rgb(224,164,88)}
    var onAccent:Color {moon ? rgb(38,20,26):rgb(28,19,7)}
}

struct StatusView:View {
    let entry:StatusEntry
    @Environment(\.widgetFamily) private var family
    private var s:WidgetSnapshot {entry.snapshot}
    private var p:WidgetPalette {WidgetPalette(s.theme)}
    var body:some View {
        if family == .systemMedium {medium} else {small}
    }
    // Small: the globe in the upper right, the state and the city at the bottom. A click connects when off and
    // opens the app when on (a stray click never disconnects).
    private var small:some View {
        ZStack(alignment:.bottomLeading) {
            globe(118).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topTrailing).offset(x:22,y:-20)
            VStack(alignment:.leading,spacing:3) {
                status
                Text(s.place).font(.system(size:17,weight:.semibold)).foregroundStyle(s.on ? p.accent:p.text).lineLimit(1).minimumScaleFactor(0.7)
                line
            }
        }
        .widgetURL(s.on || s.busy ? WidgetSnapshot.openURL:WidgetSnapshot.toggleURL)
    }
    // Medium: the same on the left with a filled button; the globe on the right.
    private var medium:some View {
        HStack(spacing:12) {
            VStack(alignment:.leading,spacing:4) {
                status
                Spacer(minLength:4)
                Text(s.place).font(.system(size:20,weight:.semibold)).foregroundStyle(s.on ? p.accent:p.text).lineLimit(1).minimumScaleFactor(0.7)
                line
                if !s.detail.isEmpty {Text(s.detail).font(.system(size:11)).foregroundStyle(p.faint).lineLimit(1)}
                Spacer(minLength:6)
                Link(destination:WidgetSnapshot.toggleURL) {
                    Text(s.action).font(.system(size:12,weight:.semibold)).lineLimit(1)
                        .foregroundStyle(s.on ? p.text:p.onAccent).padding(.horizontal,14).frame(height:26)
                        .background(s.on ? p.raised:p.accent,in:Capsule())
                }
            }.frame(maxWidth:.infinity,alignment:.leading)
            globe(126)
        }
        .widgetURL(WidgetSnapshot.openURL)
    }
    private var status:some View {
        HStack(spacing:6) {
            Circle().fill(s.on ? p.accent:(s.busy ? p.secondary:p.faint)).frame(width:6,height:6)
            Text(s.title).font(.system(size:11,weight:.medium)).foregroundStyle(p.secondary).lineLimit(1)
        }
    }
    @ViewBuilder private var line:some View {
        if s.on,let since=s.since {
            Text(since,style:.timer).font(.system(size:12,design:.monospaced)).monospacedDigit().foregroundStyle(p.secondary).lineLimit(1)
        } else {
            Text(s.hint).font(.system(size:11)).foregroundStyle(p.secondary).lineLimit(1)
        }
    }
    @ViewBuilder private func globe(_ size:CGFloat)->some View {
        if let image=entry.globe {
            Image(nsImage:image).resizable().interpolation(.high).scaledToFit().frame(width:size,height:size).accessibilityHidden(true)
        }
    }
}

#if compiler(>=6.2)
/// Control Center (macOS 26): one button that shows whether TrackNothing is on and opens it to connect or disconnect.
@available(macOS 26.0,*)
struct ConnectControl:ControlWidget {
    var body:some ControlWidgetConfiguration {
        StaticControlConfiguration(kind:"TrackNothingConnect",provider:ConnectedValue()) {on in
            ControlWidgetButton(action:OpenToggleIntent()) {
                Label {
                    Text(LocalizedStringResource(on ? "sealed_status":"connect_action",table:"Native"))
                } icon: {
                    Image(systemName:on ? "lock.shield.fill":"shield")
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
struct OpenToggleIntent:AppIntent {
    static var title:LocalizedStringResource=LocalizedStringResource("connect_action",table:"Native")
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent:OpenURLIntent(WidgetSnapshot.toggleURL))
    }
}
#endif
