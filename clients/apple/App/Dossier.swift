import SwiftUI

/// The file language shared by every TrackNothing client and the Portal (portal-web/src/dossier.tsx): each page is a
/// sheet of a file with a § number, and the connect page's lines can be "sealed".

/// One line of the file. Sealing or opening first runs the text through a few frames of random glyphs in amber, then
/// it settles: sealed it is a dim dot matrix of the same width, open it is the plain text. The first show and Reduce
/// Motion switch at once.
struct SealedText:View {
    let text:String
    let sealed:Bool
    var delay:Double=0
    var size:CGFloat=13
    var design:Font.Design = .monospaced
    var color:Color=VeilbirdStyle.text
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown:String?
    @State private var dots=false
    @State private var scrambling=false
    @State private var ready=false
    private static let glyphs=Array("01ABCDEF#%/<>*+=")
    init(text:String,sealed:Bool,delay:Double=0,size:CGFloat=13,design:Font.Design = .monospaced,color:Color=VeilbirdStyle.text) {self.text=text;self.sealed=sealed;self.delay=delay;self.size=size;self.design=design;self.color=color}
    var body:some View {
        Text(verbatim:shown ?? text).font(.system(size:size,design:design)).lineLimit(1).truncationMode(.tail)
            .foregroundStyle(scrambling ? VeilbirdStyle.accent:(dots ? Color.clear:color))
            .overlay(DotMatrix().opacity(dots ? 1:0).animation(reduceMotion ? nil:.easeOut(duration:0.5),value:dots))
            .accessibilityLabel(Text(verbatim:dots ? "":text))
            .task(id:sealed) {
                if !ready || reduceMotion {ready=true;shown=nil;dots=sealed;scrambling=false;return}
                try? await Task.sleep(nanoseconds:UInt64(delay*1_000_000_000))
                if Task.isCancelled {return}
                if !sealed {dots=false}
                scrambling=true
                for _ in 0..<10 {
                    shown=String(text.map {$0 == " " || $0 == "·" ? $0:Self.glyphs.randomElement()!})
                    try? await Task.sleep(nanoseconds:42_000_000)
                    if Task.isCancelled {break}
                }
                shown=nil;scrambling=false;dots=sealed
            }
    }
}

/// A grid of small warm dots: what a sealed line looks like.
struct DotMatrix:View {
    var body:some View {
        Canvas {context,area in
            let pitch:CGFloat=4, r:CGFloat=0.85
            var y=pitch/2+1
            while y<area.height-1 {
                var x=pitch/2
                while x<area.width {context.fill(Path(ellipseIn:CGRect(x:x-r,y:y-r,width:r*2,height:r*2)),with:.color(VeilbirdStyle.light.opacity(0.38)));x+=pitch}
                y+=pitch
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// The connect moment's light: a thin amber line with a soft trail that sweeps down the file when it is sealed and
/// back up when it is opened. `run` changes start a sweep; invisible at rest.
struct ScanLine:View {
    let down:Bool
    let run:Int
    var duration:Double=1.3
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start:Date?
    init(down:Bool,run:Int,duration:Double=1.3) {self.down=down;self.run=run;self.duration=duration}
    var body:some View {
        GeometryReader {geo in
            if let start,!reduceMotion {
                TimelineView(.animation) {context in
                    let t=min(1,context.date.timeIntervalSince(start)/duration)
                    let h=geo.size.height, y=down ? t*h:(1-t)*h
                    let fade=t<0.12 ? t/0.12:(t>0.85 ? (1-t)/0.15:1)
                    ZStack(alignment:.topLeading) {
                        LinearGradient(colors:[VeilbirdStyle.accent.opacity(0),VeilbirdStyle.accent.opacity(0.11)],startPoint:down ? .top:.bottom,endPoint:down ? .bottom:.top)
                            .frame(height:70).offset(y:down ? y-70:y)
                        Rectangle().fill(VeilbirdStyle.accent.opacity(0.24)).frame(height:6).offset(y:y-3).blur(radius:2)
                        Rectangle().fill(VeilbirdStyle.accent).frame(height:1).offset(y:y)
                    }.opacity(t>=1 ? 0:fade)
                }
            }
        }.allowsHitTesting(false).accessibilityHidden(true).clipped()
        .task(id:run) {
            guard run>0 else {return}
            start=Date()
            try? await Task.sleep(nanoseconds:UInt64((duration+0.1)*1_000_000_000))
            if !Task.isCancelled {start=nil}
        }
    }
}

/// The amber "SEALED" stamp, set slightly askew; it lands a moment after the scan line passes.
struct SealStamp:View {
    let shown:Bool
    var animated=true
    var body:some View {
        Text(verbatim:"SEALED").font(.system(size:VeilbirdStyle.mac ? 10:11,weight:.semibold,design:.monospaced)).tracking(2.4)
            .foregroundStyle(VeilbirdStyle.accent).padding(.horizontal,7).padding(.vertical,3)
            .overlay(RoundedRectangle(cornerRadius:2).strokeBorder(VeilbirdStyle.accent.opacity(0.8),lineWidth:1))
            .rotationEffect(.degrees(-6)).scaleEffect(shown ? 1:1.6).opacity(shown ? 1:0)
            .animation(animated ? (shown ? .easeOut(duration:0.26).delay(1.25):.easeIn(duration:0.2)):nil,value:shown)
            .accessibilityHidden(true)
    }
}

/// The file header on every main page: mark and name on the left, the account's file number on the right.
struct FileHeader:View {
    let number:String
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:10) {
                PixelMark(size:VeilbirdStyle.mac ? 14:18)
                Text(verbatim:"TRACKNOTHING").font(Pixel.font(VeilbirdStyle.mac ? 12:14)).tracking(0.6).foregroundStyle(VeilbirdStyle.secondary)
                    .accessibilityLabel(Text(verbatim:"TrackNothing"))
                Spacer(minLength:8)
                Text(verbatim:"№ "+number).font(.system(size:11,design:.monospaced)).tracking(0.9).foregroundStyle(VeilbirdStyle.faint)
            }.frame(height:VeilbirdStyle.mac ? 32:44).padding(.horizontal,4)
            Rectangle().fill(VeilbirdStyle.hairline).frame(height:1)
        }
    }
    /// A short, stable file number for an account (same rule as the Portal's and the other clients'), not an id.
    static func number(_ seed:String)->String {
        var hash:UInt64=7
        for unit in seed.utf16 {hash=(hash &* 31 &+ UInt64(unit)) & 0xFFFF_FFFF}
        return String(format:"%04d",Int(hash%10000))
    }
}

/// "§01 STATUS": the small monospaced number above a page or block.
struct SectionLabel:View {
    let key:String
    var body:some View {
        Text(L10n.text(key)).font(.system(size:11,design:.monospaced)).tracking(0.9).foregroundStyle(VeilbirdStyle.faint).lineLimit(1)
            .frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,4)
    }
}

/// The action's dot: dim while exposed; amber and slowly breathing while sealed (still under Reduce Motion).
struct BreathingDot:View {
    let on:Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var low=false
    init(on:Bool) {self.on=on}
    var body:some View {
        Circle().fill(on ? VeilbirdStyle.accent:VeilbirdStyle.text.opacity(0.35)).frame(width:6,height:6)
            .shadow(color:on ? VeilbirdStyle.accent.opacity(0.8):.clear,radius:4)
            .opacity(on && low ? 0.35:1)
            .animation(on && !reduceMotion ? .easeInOut(duration:1.8).repeatForever(autoreverses:true):.default,value:low)
            .onAppear {low=on && !reduceMotion}
            .onChange(of:on) {value in low=value && !reduceMotion}
            .accessibilityHidden(true)
    }
}

/// The connect page's portrait: what any site or app on this network can see of this device, drawn as a sphere of light
/// (a halftone of amber dots lit from the upper left). It is also the switch: open, it breathes slowly and carries one
/// line, "tap to hide"; hidden, the dots go dark and a thin amber ring takes their place, holding the time hidden and
/// the rates. The change runs 1.2 s. Same drawing on every client (Android Portrait, Windows Portrait).
struct PortraitView:View {
    let hidden:Bool
    let invite:String
    let since:Date?
    let sub:String
    /// Which drawing (see StateRing); failed dims the sphere and stops its breathing.
    var state:RingState = .idle
    var lines=4
    /// Inside the ring instead of the time: the phase while connecting, the countdown while reconnecting.
    var centre=""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var low=true
    var body:some View {
        GeometryReader {geo in
            let s=min(geo.size.width,geo.size.height)
            let failed=state == .failed
            ZStack {
                ZStack {
                    DotSphere().opacity(failed ? 0.42:(low ? 0.82:1))
                    Text(verbatim:invite).font(.system(size:max(13,0.05*s))).tracking(0.8).foregroundStyle(failed ? VeilbirdStyle.text.opacity(0.7):VeilbirdStyle.accent)
                        .lineLimit(1).minimumScaleFactor(0.6).frame(width:0.8*s).opacity(failed || !low ? 1:0.75)
                    Circle().strokeBorder(VeilbirdStyle.text.opacity(0.07),lineWidth:1)
                }.opacity(hidden ? 0:1)
                DotSphere().opacity(hidden ? 0.1:0)
                StateRing(state:state,lines:lines,glow:low ? 0.82:1)
                    .frame(width:0.75*s,height:0.75*s).opacity(hidden ? 1:0).scaleEffect(hidden ? 1:0.92)
                inside(s).opacity(hidden ? 1:0)
            }.frame(width:s,height:s).position(x:geo.size.width/2,y:geo.size.height/2)
        }
        .animation(reduceMotion ? nil:.timingCurve(0.65,0,0.35,1,duration:1.2),value:hidden)
        .onAppear {if !reduceMotion {withAnimation(.easeInOut(duration:3).repeatForever(autoreverses:true)) {low=false}} else {low=false}}
    }
    /// The time hidden and the rates; the line being tried while switching; one short line while connecting.
    @ViewBuilder private func inside(_ s:CGFloat)->some View {
        if state == .switching {
            TimelineView(.periodic(from:.now,by:0.6)) {context in
                let n=max(lines,2)
                small(L10n.text("switching_centre",L10n.number(StateRing.current(lines:n,at:context.date,still:reduceMotion)+1),L10n.number(n)),s)
            }
        } else if state == .connecting {
            small(centre,s)
        } else {
            VStack(spacing:0.02*s) {
                if let since,state == .connected {
                    TimelineView(.periodic(from:since,by:1)) {context in
                        Text(verbatim:Duration.seconds(Int(context.date.timeIntervalSince(since))).formatted(.time(pattern:.hourMinuteSecond)))
                            .font(.system(size:0.072*s,design:.monospaced)).monospacedDigit().foregroundStyle(VeilbirdStyle.text).lineLimit(1)
                    }
                } else if !centre.isEmpty {
                    Text(verbatim:centre).font(.system(size:0.072*s,design:.monospaced)).monospacedDigit().foregroundStyle(VeilbirdStyle.text).lineLimit(1)
                }
                Text(verbatim:sub).font(.system(size:max(10,0.036*s),design:.monospaced)).monospacedDigit().foregroundStyle(VeilbirdStyle.secondary)
                    .lineLimit(1).minimumScaleFactor(0.6).frame(width:0.62*s)
            }
        }
    }
    private func small(_ text:String,_ s:CGFloat)->some View {
        Text(verbatim:text).font(.system(size:max(11,0.044*s),design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary)
            .lineLimit(1).minimumScaleFactor(0.6).frame(width:0.62*s)
    }
}

/// The halftone sphere, drawn once and kept as one layer.
private struct DotSphere:View {
    var body:some View {
        Canvas {context,area in
            let s=Double(min(area.width,area.height)),ox=(Double(area.width)-s)/2,oy=(Double(area.height)-s)/2
            let pitch=s*6/320,r=s*1.15/320,radius=s/2,lx=s*0.42,ly=s*0.34
            var y=pitch/2
            while y<s {
                var x=pitch/2
                while x<s {
                    if ((x-radius)*(x-radius)+(y-radius)*(y-radius)).squareRoot()<=radius {
                        let f=((x-lx)*(x-lx)+(y-ly)*(y-ly)).squareRoot()/(s*0.82)
                        let a=f<0.22 ? 1-f/0.22*0.15:(f<0.48 ? 0.85-(f-0.22)/0.26*0.5:(f<0.66 ? 0.35-(f-0.48)/0.18*0.27:(f<0.72 ? 0.08-(f-0.66)/0.06*0.08:0)))
                        if a>0 {context.fill(Path(ellipseIn:CGRect(x:ox+x-r,y:oy+y-r,width:2*r,height:2*r)),with:.color(VeilbirdStyle.light.opacity(a)))}
                    }
                    x+=pitch
                }
                y+=pitch
            }
        }.drawingGroup().accessibilityHidden(true)
    }
}
