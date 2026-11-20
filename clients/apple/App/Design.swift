import SwiftUI
import CoreText

/// The one palette of the app, shared with the Portal and the other clients: a warm near-black ground lit by one lamp,
/// hairline sheets, and amber only for the light of the connect moment (scan line, seal, live state). Same values on
/// every platform.
enum VeilbirdStyle {
    /// "amber" (the default) or "moon", a softer look where the light is pearl to rose; chosen in Account → Appearance.
    /// Views that should follow a change read `@AppStorage(VeilbirdStyle.themeKey)` and re-render (see ClientView).
    static let themeKey = "appearance"
    static var theme:String {UserDefaults.standard.string(forKey:themeKey) ?? "amber"}
    private static var moon:Bool {theme == "moon"}
    private static func rgb(_ r:Double,_ g:Double,_ b:Double)->Color {Color(red:r/255,green:g/255,blue:b/255)}
    static var ground:Color {moon ? rgb(10,8,9):rgb(8,7,6)}
    static var surface:Color {moon ? rgb(24,20,22):rgb(23,21,19)}
    static var raised:Color {moon ? rgb(34,29,31):rgb(33,31,28)}
    static var selected:Color {moon ? rgb(48,41,44):rgb(46,43,38)}
    static var text:Color {moon ? rgb(244,238,232):rgb(237,231,223)}
    static var secondary:Color {moon ? rgb(172,160,162):rgb(163,155,145)}
    static var faint:Color {moon ? rgb(152,138,142):rgb(149,139,124)}
    static var accent:Color {moon ? rgb(235,184,195):rgb(224,164,88)}
    /// Buttons are outlined, not filled: text on an "accent" control is the accent itself.
    static var onAccent:Color {accent}
    static let danger = Color(red:240/255,green:103/255,blue:90/255)
    static var fair:Color {moon ? rgb(226,150,120):rgb(232,134,106)}
    static var hairline:Color {text.opacity(0.063)}
    /// Sheet outline: blocks are a hairline on the ground, not a filled card.
    static var edge:Color {light.opacity(0.09)}
    /// Lamp light and sealed dots.
    static var light:Color {moon ? rgb(248,226,230):rgb(255,214,160)}
    /// Past figures in charts (the accent, dimmed).
    static var past:Color {moon ? rgb(112,86,94):rgb(111,90,63)}
    #if os(macOS)
    static let mac = true
    #else
    static let mac = false
    #endif
    /// Body sizes: the Mac's controls are denser than the phone's.
    static let body:CGFloat = mac ? 13:17
    static let detail:CGFloat = mac ? 12:13
    /// Nearly square, like the sheets of a file.
    static let radius:CGFloat = 3
}

/// The pixel language shared by every TrackNothing client: the ∅ mark, rings of square dots and the Doto dot-matrix
/// face for figures. The mark's geometry matches scripts/brand-icons.py and the other clients.
enum Pixel {
    /// How lit a point of the mark is (0…1): light falls from the upper left, as on the home page's portrait.
    private static func markLight(_ x:Double,_ y:Double)->Double {
        let dx:Double=x-42
        let dy:Double=y-34
        let f:Double=(dx*dx+dy*dy).squareRoot()/82
        if f<0.22 {return 1-f/0.22*0.15}
        if f<0.48 {return 0.85-(f-0.22)/0.26*0.5}
        if f<0.66 {return 0.35-(f-0.48)/0.18*0.27}
        return 0.08
    }
    /// Whether a point of the 100×100 box is inside the mark: the ring (cut either side of the bar) or the bar.
    private static func inMark(_ x:Double,_ y:Double)->Bool {
        let cx:Double=x-50
        let cy:Double=y-50
        let d:Double=(cx*cx+cy*cy).squareRoot()
        let across:Double=abs(cx+cy)/2.0.squareRoot()
        let along:Double=abs(cx-cy)/2.0.squareRoot()
        if d>=25 && d<=37 && across>11 {return true}
        return across<=5.6 && along<=46
    }
    /// The dot form's dots (x, y, radius) in the mark's 100×100 box; dot size carries the light.
    static let markDots:[(Double,Double,Double)]=buildMarkDots()
    private static func buildMarkDots()->[(Double,Double,Double)] {
        var out:[(Double,Double,Double)]=[]
        let pitch:Double=3.4
        for j in 0..<31 {
            let shift:Double=j%2==1 ? pitch/2:0
            let y:Double=pitch/2+Double(j)*pitch*0.866
            for i in 0..<31 {
                let x:Double=pitch/2+Double(i)*pitch+shift
                if !inMark(x,y) {continue}
                let r:Double=1.65*max(0.5,markLight(x,y)).squareRoot()
                out.append((x,y,r))
            }
        }
        return out
    }
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
    /// The ∅ mark: a heavy ring and bar with a gap where the bar crosses; the shape's 8…92 span of its 100 box fills
    /// the rect. From 40 pt up it is a halftone of dots, smaller it is solid.
    static func markPath(in rect:CGRect)->Path {
        let size:Double=Double(min(rect.width,rect.height))
        let k:Double=size/84
        let x0:Double=Double(rect.midX)-50*k
        let y0:Double=Double(rect.midY)-50*k
        func point(_ x:Double,_ y:Double)->CGPoint {CGPoint(x:x0+x*k,y:y0+y*k)}
        var path=Path()
        if size>=40 {
            for (x,y,r) in markDots {
                let corner=point(x-r,y-r)
                let side:Double=2*r*k
                path.addEllipse(in:CGRect(x:corner.x,y:corner.y,width:side,height:side))
            }
            return path
        }
        let centre=point(50,50)
        let ao:Double=asin(13.0/37.5)*180/Double.pi
        let ai:Double=asin(13.0/22.5)*180/Double.pi
        for turn in [0.0,180.0] {
            let start:Double=(turn+ao-45)*Double.pi/180
            path.move(to:point(50+37.5*cos(start),50+37.5*sin(start)))
            path.addArc(center:centre,radius:CGFloat(37.5*k),startAngle:.degrees(turn+ao-45),endAngle:.degrees(turn+135-ao),clockwise:false)
            path.addArc(center:centre,radius:CGFloat(22.5*k),startAngle:.degrees(turn+135-ai),endAngle:.degrees(turn+ai-45),clockwise:true)
            path.closeSubpath()
        }
        let h:Double=47/2.0.squareRoot()
        let w:Double=7/2.0.squareRoot()
        path.move(to:point(50-h-w,50+h-w))
        path.addLine(to:point(50+h-w,50-h-w))
        path.addLine(to:point(50+h+w,50-h+w))
        path.addLine(to:point(50-h+w,50+h+w))
        path.closeSubpath()
        return path
    }
}

/// The ∅ mark as a shape.
struct EmptySetMark:Shape {
    func path(in rect:CGRect) -> Path {Pixel.markPath(in:rect)}
}

/// The mark alone, in amber: headers, the menu bar panel and sign-in.
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

/// The connection as the person sees it, the same seven states on every client (Android LinkState, Windows Link):
/// each has one drawing of the portrait, one title, one detail and one action.
enum RingState {case idle,connecting,switching,connected,reconnecting,waiting,failed}

/// A 36pt (32pt on the Mac) tile with a two-letter country code or an icon.
struct Badge:View {
    var code:String?=nil
    var icon:String?=nil
    var tint:Color=VeilbirdStyle.text
    var size:CGFloat=VeilbirdStyle.mac ? 30:36
    /// The selected location's tile: an amber outline and code, so the row needs no extra mark.
    var selected=false
    var body:some View {
        ZStack {
            RoundedRectangle(cornerRadius:2).fill(selected ? VeilbirdStyle.accent.opacity(0.06):VeilbirdStyle.raised)
                .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(selected ? VeilbirdStyle.accent.opacity(0.7):Color.clear,lineWidth:1))
            if let icon {Image(systemName:icon).font(.system(size:size*0.44,weight:.medium)).foregroundStyle(selected ? VeilbirdStyle.onAccent:tint)}
            else {Text(code ?? "").font(Pixel.font(size*0.42)).foregroundStyle(selected ? VeilbirdStyle.onAccent:(tint == VeilbirdStyle.text ? VeilbirdStyle.accent:tint))}
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
                Rectangle().fill(i<level ? color:Color(red:52/255,green:49/255,blue:43/255)).frame(width:3,height:5+3.5*CGFloat(i))
            }
        }.frame(width:14,height:12,alignment:.bottom).accessibilityHidden(true)
    }
}

/// One cell per line of a node (Line 1…4): filled when it answers (amber when slow), outlined red when it does
/// not, outlined grey when the node has no such line, filled dark while measuring.
enum LineState {case ok,slow,down,off,wait}
struct LineCells:View {
    let states:[LineState]
    var size:CGFloat=6
    var body:some View {
        HStack(spacing:3) {
            ForEach(states.indices,id:\.self) {i in
                let state=states[i]
                ZStack {
                    switch state {
                    case .ok:Rectangle().fill(VeilbirdStyle.accent)
                    case .slow:Rectangle().fill(VeilbirdStyle.fair)
                    case .wait:Rectangle().fill(Color(red:45/255,green:42/255,blue:37/255))
                    case .down:Rectangle().strokeBorder(VeilbirdStyle.danger,lineWidth:1)
                    case .off:Rectangle().strokeBorder(Color(red:68/255,green:63/255,blue:57/255),lineWidth:1)
                    }
                }.frame(width:size,height:size)
            }
        }.accessibilityHidden(true)
    }
}

/// Daily usage as columns of square blocks; the last week is in full accent.
struct UsageBars:View {
    let values:[Int64]
    /// How many trailing columns are lit (the chosen range); the rest are dimmed.
    var recent=7
    var body:some View {
        Canvas {context,area in
            guard !values.isEmpty else {return}
            let gap:CGFloat=3, width=(area.width-gap*CGFloat(values.count-1))/CGFloat(values.count)
            let block:CGFloat=4, pitch:CGFloat=6, rows=max(1,Int((area.height+pitch-block)/pitch)), top=max(values.max() ?? 1,1)
            for (i,value) in values.enumerated() {
                let lit=value<=0 ? 1:max(1,Int((Double(rows)*Double(value)/Double(top)).rounded()))
                let color=i>=values.count-recent ? VeilbirdStyle.accent:VeilbirdStyle.past
                let left=CGFloat(i)*(width+gap)
                for r in 0..<lit {context.fill(Path(CGRect(x:left,y:area.height-CGFloat(r)*pitch-block,width:width,height:block)),with:.color(color))}
            }
        }.accessibilityHidden(true)
    }
}

/// The last 40 seconds of the connection: download as columns of square dots rising from a hairline, upload as dimmer
/// columns hanging below it. Both scale to the busiest second shown.
struct RateBars:View {
    static let count=40
    let down:[Int], up:[Int]
    var body:some View {
        Canvas {context,area in
            let block:CGFloat=4, pitch:CGFloat=6, step=area.width/CGFloat(RateBars.count), width=min(block,step-1)
            let axis=(area.height*0.64).rounded()
            let topRows=max(1,Int((axis-2+pitch-block)/pitch)), bottomRows=max(1,Int((area.height-axis-2+pitch-block)/pitch))
            context.fill(Path(CGRect(x:0,y:axis,width:area.width,height:1)),with:.color(Color(red:44/255,green:41/255,blue:36/255)))
            let top=max(1,(down+up).max() ?? 1), offset=RateBars.count-down.count
            for (i,value) in down.enumerated() {
                let left=CGFloat(offset+i)*step+(step-width)/2
                let lit=value<=0 ? 1:max(1,Int((Double(topRows)*Double(value)/Double(top)).rounded()))
                for r in 0..<lit {context.fill(Path(CGRect(x:left,y:axis-2-CGFloat(r)*pitch-block,width:width,height:block)),with:.color(VeilbirdStyle.accent))}
                let sent=i<up.count ? up[i]:0
                let litUp=sent<=0 ? 0:max(1,Int((Double(bottomRows)*Double(sent)/Double(top)).rounded()))
                for r in 0..<litUp {context.fill(Path(CGRect(x:left,y:axis+3+CGFloat(r)*pitch,width:width,height:block)),with:.color(VeilbirdStyle.past))}
            }
        }.accessibilityHidden(true)
    }
}

extension View {
    /// A card: a hairline outline on the ground (same as the Portal and Console), no fill.
    func cardOutline(_ radius:CGFloat)->some View {
        overlay(RoundedRectangle(cornerRadius:radius).strokeBorder(VeilbirdStyle.edge,lineWidth:1))
    }
}

/// A card of rows separated by hairlines; the line starts after the badge when rows have one.
struct CardGroup<Content:View>:View {
    @ViewBuilder var content:Content
    var body:some View {
        VStack(spacing:0) {content}.cardOutline(VeilbirdStyle.radius)
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
            // Outlined, not filled: the accent is light, not paint.
            .foregroundStyle(VeilbirdStyle.accent).background(VeilbirdStyle.accent.opacity(configuration.isPressed ? 0.14:0.06),in:RoundedRectangle(cornerRadius:2))
            .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(VeilbirdStyle.accent.opacity(0.7),lineWidth:1))
            .opacity(enabled ? 1:0.45)
    }
}

extension View {
    func veilbirdField()->some View {
        self.textFieldStyle(.plain).font(.system(size:VeilbirdStyle.mac ? 14:17)).foregroundStyle(VeilbirdStyle.text)
            .padding(.horizontal,16).frame(height:VeilbirdStyle.mac ? 38:50)
            .cardOutline(VeilbirdStyle.radius)
    }
}
