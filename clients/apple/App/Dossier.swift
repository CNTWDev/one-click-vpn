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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown:String?
    @State private var dots=false
    @State private var scrambling=false
    @State private var ready=false
    private static let glyphs=Array("01ABCDEF#%/<>*+=")
    init(text:String,sealed:Bool,delay:Double=0,size:CGFloat=13) {self.text=text;self.sealed=sealed;self.delay=delay;self.size=size}
    var body:some View {
        Text(verbatim:shown ?? text).font(.system(size:size,design:.monospaced)).lineLimit(1).truncationMode(.tail)
            .foregroundStyle(scrambling ? VeilbirdStyle.accent:(dots ? Color.clear:VeilbirdStyle.text))
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
