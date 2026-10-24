import SwiftUI

/// The one palette of the app (dark, after the ∅ mark: lime on near-black green). Same values on every platform.
enum VeilbirdStyle {
    static let ground = Color(red:13/255,green:19/255,blue:16/255)
    static let surface = Color(red:21/255,green:28/255,blue:23/255)
    static let raised = Color(red:31/255,green:41/255,blue:34/255)
    static let selected = Color(red:58/255,green:69/255,blue:60/255)
    static let text = Color(red:236/255,green:241/255,blue:232/255)
    static let secondary = Color(red:147/255,green:160/255,blue:144/255)
    static let faint = Color(red:127/255,green:139/255,blue:124/255)
    static let accent = Color(red:183/255,green:220/255,blue:104/255)
    static let onAccent = Color(red:17/255,green:25/255,blue:18/255)
    static let danger = Color(red:240/255,green:144/255,blue:122/255)
    static let fair = Color(red:226/255,green:184/255,blue:92/255)
    static let hairline = Color(red:236/255,green:241/255,blue:232/255).opacity(0.10)
    #if os(macOS)
    static let mac = true
    #else
    static let mac = false
    #endif
    /// Body sizes: the Mac's controls are denser than the phone's.
    static let body:CGFloat = mac ? 13:17
    static let detail:CGFloat = mac ? 12:13
    static let radius:CGFloat = 12
}

/// The ∅ mark: a circle crossed by a slash.
struct EmptySetMark:Shape {
    func path(in rect:CGRect) -> Path {
        let r=min(rect.width,rect.height)/2*0.5, c=CGPoint(x:rect.midX,y:rect.midY), d=r*0.92
        var path=Path()
        path.addEllipse(in:CGRect(x:c.x-r,y:c.y-r,width:2*r,height:2*r))
        path.move(to:CGPoint(x:c.x-d,y:c.y+d));path.addLine(to:CGPoint(x:c.x+d,y:c.y-d))
        return path
    }
}

/// The app's logo tile: the mark in lime on a dark rounded square.
struct LogoTile:View {
    var size:CGFloat
    var body:some View {
        RoundedRectangle(cornerRadius:size/4).fill(Color(red:26/255,green:35/255,blue:28/255))
            .overlay(EmptySetMark().stroke(VeilbirdStyle.accent,style:StrokeStyle(lineWidth:size/15,lineCap:.round)).padding(size*0.04))
            .frame(width:size,height:size).accessibilityHidden(true)
    }
}

enum RingState {case idle,connecting,connected,failed}

/// The connect button: a ring around a disk with the ∅ mark. While connecting an arc turns around the ring;
/// a failure swaps the mark for a retry arrow. The turning arc stops under Reduce Motion.
struct ConnectRing:View {
    let state:RingState
    var size:CGFloat=216
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turning=false
    var body:some View {
        let inner=size*176/216
        ZStack {
            Circle().stroke(outerColor,lineWidth:state == .connecting ? 1.5:1)
            if state == .connecting {
                Circle().trim(from:0,to:0.18).stroke(VeilbirdStyle.accent,style:StrokeStyle(lineWidth:2,lineCap:.round))
                    .rotationEffect(.degrees(turning ? 270:-90))
                    .animation(reduceMotion ? nil:.linear(duration:1.6).repeatForever(autoreverses:false),value:turning)
            }
            Circle().fill(diskColor).frame(width:inner,height:inner)
            Circle().strokeBorder(borderColor,lineWidth:state == .connected ? 2:(state == .failed ? 1.5:1)).frame(width:inner,height:inner)
            if state == .failed {
                Image(systemName:"arrow.clockwise").font(.system(size:inner*0.26,weight:.light)).foregroundStyle(VeilbirdStyle.danger)
            } else {
                EmptySetMark().stroke(markColor,style:StrokeStyle(lineWidth:size/66,lineCap:.round)).frame(width:inner*0.72,height:inner*0.72)
            }
        }.frame(width:size,height:size).contentShape(Circle())
        .onAppear {turning = state == .connecting}.onChange(of:state) {value in turning = value == .connecting}
    }
    private var outerColor:Color {
        switch state {
        case .idle:return VeilbirdStyle.text.opacity(0.08)
        case .connecting:return VeilbirdStyle.accent.opacity(0.14)
        case .connected:return VeilbirdStyle.accent.opacity(0.22)
        case .failed:return VeilbirdStyle.danger.opacity(0.20)
        }
    }
    private var diskColor:Color {
        switch state {
        case .connected:return Color(red:23/255,green:34/255,blue:26/255)
        case .failed:return Color(red:27/255,green:23/255,blue:21/255)
        default:return VeilbirdStyle.surface
        }
    }
    private var borderColor:Color {
        switch state {
        case .idle:return VeilbirdStyle.text.opacity(0.10)
        case .connecting:return VeilbirdStyle.accent.opacity(0.18)
        case .connected:return VeilbirdStyle.accent
        case .failed:return VeilbirdStyle.danger.opacity(0.55)
        }
    }
    private var markColor:Color {state == .idle ? VeilbirdStyle.secondary:(state == .connecting ? VeilbirdStyle.accent.opacity(0.7):VeilbirdStyle.accent)}
}

/// A 36pt (32pt on the Mac) tile with a two-letter country code or an icon.
struct Badge:View {
    var code:String?=nil
    var icon:String?=nil
    var tint:Color=VeilbirdStyle.text
    var size:CGFloat=VeilbirdStyle.mac ? 30:36
    var body:some View {
        ZStack {
            RoundedRectangle(cornerRadius:size*0.27).fill(VeilbirdStyle.raised)
            if let icon {Image(systemName:icon).font(.system(size:size*0.44,weight:.medium)).foregroundStyle(tint)}
            else {Text(code ?? "").font(.system(size:size*0.34,weight:.semibold)).foregroundStyle(tint)}
        }.frame(width:size,height:size).accessibilityHidden(true)
    }
}

/// Three signal bars: how many are lit and in which color says how good a location is.
struct SignalBars:View {
    let level:Int
    let color:Color
    var body:some View {
        HStack(alignment:.bottom,spacing:2.5) {
            ForEach(0..<3,id:\.self) {i in
                RoundedRectangle(cornerRadius:1).fill(i<level ? color:Color(red:46/255,green:58/255,blue:48/255)).frame(width:3,height:5+3.5*CGFloat(i))
            }
        }.frame(width:14,height:12,alignment:.bottom).accessibilityHidden(true)
    }
}

/// Daily usage as thin bars; the last bar (today) is in full accent.
struct UsageBars:View {
    let values:[Int64]
    var body:some View {
        GeometryReader {geometry in
            let top=max(values.max() ?? 1,1)
            HStack(alignment:.bottom,spacing:3) {
                ForEach(values.indices,id:\.self) {i in
                    RoundedRectangle(cornerRadius:2).fill(i==values.count-1 ? VeilbirdStyle.accent:VeilbirdStyle.accent.opacity(0.32))
                        .frame(height:max(3,geometry.size.height*CGFloat(values[i])/CGFloat(top)))
                }
            }.frame(maxHeight:.infinity,alignment:.bottom)
        }.accessibilityHidden(true)
    }
}

/// A card of rows separated by hairlines; the line starts after the badge when rows have one.
struct CardGroup<Content:View>:View {
    @ViewBuilder var content:Content
    var body:some View {
        VStack(spacing:0) {content}.background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
            .clipShape(RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }
}
struct Hairline:View {
    var inset:CGFloat=16
    var body:some View {Rectangle().fill(VeilbirdStyle.hairline).frame(height:0.5).padding(.leading,inset)}
}

/// Pressed rows dim slightly; nothing else moves.
struct RowButton:ButtonStyle {
    func makeBody(configuration:Configuration)->some View {
        configuration.label.contentShape(Rectangle()).background(configuration.isPressed ? VeilbirdStyle.text.opacity(0.06):Color.clear)
    }
}
struct PrimaryButton:ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration:Configuration)->some View {
        configuration.label.font(.system(size:VeilbirdStyle.mac ? 14:17,weight:.semibold)).frame(maxWidth:.infinity).frame(height:VeilbirdStyle.mac ? 40:52)
            .foregroundStyle(VeilbirdStyle.onAccent).background(VeilbirdStyle.accent,in:RoundedRectangle(cornerRadius:VeilbirdStyle.mac ? 10:14))
            .opacity(enabled ? (configuration.isPressed ? 0.8:1):0.45)
    }
}

extension View {
    func veilbirdField()->some View {
        self.textFieldStyle(.plain).font(.system(size:VeilbirdStyle.mac ? 14:17)).foregroundStyle(VeilbirdStyle.text)
            .padding(.horizontal,16).frame(height:VeilbirdStyle.mac ? 38:50)
            .background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }
}
