import SwiftUI
import CoreText

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

/// The pixel language shared by every TrackNothing client: the ∅ mark on a 16×16 grid, rings of square dots
/// and the Doto dot-matrix face for figures. Same cells as scripts/brand-icons.py and the other clients.
enum Pixel {
    static let mark:[(Int,Int)]=("14,1 5,2 6,2 7,2 8,2 9,2 10,2 13,2 3,3 4,3 11,3 12,3 2,4 11,4 13,4 2,5 10,5 13,5 1,6 9,6 14,6 1,7 8,7 14,7 "
        +"1,8 7,8 14,8 1,9 6,9 14,9 2,10 5,10 13,10 2,11 4,11 13,11 3,12 4,12 11,12 12,12 2,13 5,13 6,13 7,13 8,13 9,13 10,13 1,14")
        .split(separator:" ").map {cell in let xy=cell.split(separator:",").map {Int($0)!};return (xy[0],xy[1])}
    /// Cells one cell wide on a circle of `radius` in an n×n grid, each with its clockwise position from the top (0…1).
    static func ring(_ n:Int,radius:Double)->[(x:Int,y:Int,turn:Double)] {
        let c=Double(n-1)/2
        var cells:[(x:Int,y:Int,turn:Double)]=[]
        for y in 0..<n {for x in 0..<n where abs(hypot(Double(x)-c,Double(y)-c)-radius)<=0.55 {
            let degrees=atan2(Double(y)-c,Double(x)-c)*180/Double.pi
            cells.append((x,y,(degrees+450).truncatingRemainder(dividingBy:360)/360))
        }}
        return cells
    }
    /// Doto Black (SIL OFL, bundled under App/Fonts), Latin only: wordmark, timers, totals and country codes.
    static func font(_ size:CGFloat)->Font {_ = registered;return .custom("Doto-Black",fixedSize:size)}
    private static let registered:Bool={
        guard let url=Bundle.main.url(forResource:"Doto-Black",withExtension:"ttf") else {return false}
        return CTFontManagerRegisterFontsForURL(url as CFURL,.process,nil)
    }()
    static func markPath(in rect:CGRect)->Path {
        let size=min(rect.width,rect.height), cell=size/16, square=cell*0.86
        let x0=rect.midX-size/2, y0=rect.midY-size/2
        var path=Path()
        for (x,y) in mark {path.addRect(CGRect(x:x0+CGFloat(x)*cell,y:y0+CGFloat(y)*cell,width:square,height:square))}
        return path
    }
}

/// The ∅ mark: an empty set drawn in square pixels.
struct EmptySetMark:Shape {
    func path(in rect:CGRect) -> Path {Pixel.markPath(in:rect)}
}

/// The mark alone, in lime: headers, the menu bar panel and sign-in.
struct PixelMark:View {
    var size:CGFloat
    var color:Color=VeilbirdStyle.accent
    var body:some View {EmptySetMark().fill(color).frame(width:size,height:size).accessibilityHidden(true)}
}

/// "TRACKNOTHING" in the dot-matrix face, shown once per screen next to the mark.
struct Wordmark:View {
    var size:CGFloat
    var body:some View {Text(verbatim:"TRACKNOTHING").font(Pixel.font(size)).tracking(size*0.04).foregroundStyle(VeilbirdStyle.text).accessibilityLabel(Text(verbatim:"TrackNothing"))}
}

enum RingState {case idle,connecting,connected,failed}

/// The connect button: a ring of square dots around the ∅ mark, over a faint halftone glow. Dim when idle,
/// a comet of lit dots turning while connecting (held still under Reduce Motion), every dot lit once connected,
/// and a dark ring with the mark in red after a failure.
struct ConnectRing:View {
    let state:RingState
    var size:CGFloat=216
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let cells=Pixel.ring(41,radius:18)
    var body:some View {
        Group {
            if state == .connecting && !reduceMotion {
                TimelineView(.animation) {context in dots(head:context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy:1.6)/1.6)}
            } else {dots(head:nil)}
        }.frame(width:size,height:size).contentShape(Circle())
    }
    private func dots(head:Double?)->some View {
        Canvas {context,area in
            let side=min(area.width,area.height), left=(area.width-side)/2, top=(area.height-side)/2
            let glow:Double={switch state {case .idle:return 0.06;case .connecting:return 0.13;case .connected:return 0.22;case .failed:return 0}}()
            if glow>0 {
                let step:CGFloat=6, cx=area.width/2, cy=area.height/2, reach=side*0.62
                var y=cy.truncatingRemainder(dividingBy:step)
                while y<area.height {
                    var x=cx.truncatingRemainder(dividingBy:step)
                    while x<area.width {
                        let fade=1-hypot(x-cx,y-cy)/reach
                        if fade>0 {context.fill(Path(ellipseIn:CGRect(x:x-0.9,y:y-0.9,width:1.8,height:1.8)),with:.color(VeilbirdStyle.accent.opacity(glow*min(1,fade*1.6))))}
                        x+=step
                    }
                    y+=step
                }
            }
            let cell=side/41, square=cell*0.83
            for dot in Self.cells {
                let color:Color
                switch state {
                case .idle:color=Color(red:36/255,green:48/255,blue:38/255)
                case .failed:color=Color(red:43/255,green:36/255,blue:32/255)
                case .connected:color=VeilbirdStyle.accent
                case .connecting:
                    if let head {
                        // A comet: full at its head, fading over the next 38% of the turn.
                        let behind=(head-dot.turn+1).truncatingRemainder(dividingBy:1)
                        color=VeilbirdStyle.accent.opacity(behind<0.38 ? 1-0.88*behind/0.38:0.12)
                    } else {color=VeilbirdStyle.accent.opacity(0.5)}
                }
                context.fill(Path(CGRect(x:left+CGFloat(dot.x)*cell,y:top+CGFloat(dot.y)*cell,width:square,height:square)),with:.color(color))
            }
            let mark=side*80/246
            let markColor:Color={switch state {case .idle:return VeilbirdStyle.faint;case .failed:return VeilbirdStyle.danger;default:return VeilbirdStyle.accent}}()
            context.fill(Pixel.markPath(in:CGRect(x:area.width/2-mark/2,y:area.height/2-mark/2,width:mark,height:mark)),with:.color(markColor))
        }
    }
}

/// A line of hex digits that changes a few characters a second while a connection is coming up or carrying
/// traffic: the "data stream" under the ring. Dashes when idle and under Reduce Motion.
struct DataStream:View {
    let running:Bool
    var size:CGFloat=15
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body:some View {
        Group {
            if running && !reduceMotion {
                TimelineView(.periodic(from:.now,by:1)) {context in line(Self.digits(at:context.date))}
            } else {line("---- ---- ---- ----")}
        }.accessibilityHidden(true)
    }
    private func line(_ value:String)->some View {
        Text(verbatim:value).font(Pixel.font(size)).tracking(size*0.18)
            .foregroundStyle(running ? Color(red:126/255,green:156/255,blue:76/255):Color(red:46/255,green:59/255,blue:49/255))
    }
    /// Each digit changes on its own slow beat (3–9 s), so about three change every second.
    static func digits(at date:Date)->String {
        let seconds=Int(date.timeIntervalSince1970), hex=Array("0123456789ABCDEF")
        return String((0..<16).map {i->String in
            let beat=seconds/(3+i%7)
            var h=UInt64(truncatingIfNeeded:beat)&*0x9E3779B97F4A7C15 ^ UInt64(i)&*0xBF58476D1CE4E5B9
            h^=h>>31
            return String(hex[Int(h%16)])+(i%4==3 && i<15 ? " ":"")
        }.joined())
    }
}

/// A 36pt (32pt on the Mac) tile with a two-letter country code or an icon.
struct Badge:View {
    var code:String?=nil
    var icon:String?=nil
    var tint:Color=VeilbirdStyle.text
    var size:CGFloat=VeilbirdStyle.mac ? 30:36
    var body:some View {
        ZStack {
            RoundedRectangle(cornerRadius:size*0.22).fill(VeilbirdStyle.raised)
            if let icon {Image(systemName:icon).font(.system(size:size*0.44,weight:.medium)).foregroundStyle(tint)}
            else {Text(code ?? "").font(Pixel.font(size*0.42)).foregroundStyle(tint == VeilbirdStyle.text ? VeilbirdStyle.accent:tint)}
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
                Rectangle().fill(i<level ? color:Color(red:46/255,green:58/255,blue:48/255)).frame(width:3,height:5+3.5*CGFloat(i))
            }
        }.frame(width:14,height:12,alignment:.bottom).accessibilityHidden(true)
    }
}

/// Daily usage as columns of square blocks; the last week is in full accent.
struct UsageBars:View {
    let values:[Int64]
    var body:some View {
        Canvas {context,area in
            guard !values.isEmpty else {return}
            let gap:CGFloat=3, width=(area.width-gap*CGFloat(values.count-1))/CGFloat(values.count)
            let block:CGFloat=4, pitch:CGFloat=6, rows=max(1,Int((area.height+pitch-block)/pitch)), top=max(values.max() ?? 1,1)
            for (i,value) in values.enumerated() {
                let lit=value<=0 ? 1:max(1,Int((Double(rows)*Double(value)/Double(top)).rounded()))
                let color=i>=values.count-7 ? VeilbirdStyle.accent:Color(red:94/255,green:117/255,blue:80/255)
                let left=CGFloat(i)*(width+gap)
                for r in 0..<lit {context.fill(Path(CGRect(x:left,y:area.height-CGFloat(r)*pitch-block,width:width,height:block)),with:.color(color))}
            }
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
