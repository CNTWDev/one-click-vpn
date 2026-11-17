import SwiftUI

/// The faint star field behind every page, same recipe as the Portal (portal-web/src/space.tsx) and the other
/// clients: the flat ground, a pixel Milky Way on a slant, far stars that drift very slowly and a few cross glints,
/// all at about half strength. No nebula, planet or texture, so the app stays flat like the Console. Stars are
/// seeded, so the sky is the same on every launch. Redrawn twice a second at most; still under Reduce Motion.
struct SpaceView:View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sky=SpaceSky()
    var body:some View {
        TimelineView(.periodic(from:.now,by:reduceMotion ? 3600:0.5)) {timeline in
            Canvas {context,size in
                sky.draw(&context,size:size,time:reduceMotion ? nil:timeline.date.timeIntervalSinceReferenceDate)
            }
        }.accessibilityHidden(true).allowsHitTesting(false)
    }
}

final class SpaceSky {
    struct Star {let x:Double;let y:Double;let size:Double;let color:Color;let alpha:Double;let twinkle:Bool;let delay:Double}
    private var laidOut=CGSize.zero
    private var band:[Star]=[]
    private var far:[Star]=[]

    private static let white=Color(red:232/255,green:236/255,blue:244/255)
    private static let mint=Color(red:191/255,green:203/255,blue:230/255)
    private static let pale=Color(red:214/255,green:240/255,blue:170/255)
    private static let strength=0.55

    private static func random(_ seed:Int32)->()->Double {
        var a=seed
        return {
            a=a &+ 0x6D2B79F5
            var t=(a ^ Int32(bitPattern:UInt32(bitPattern:a) >> 15)) &* (1 | a)
            t=(t &+ ((t ^ Int32(bitPattern:UInt32(bitPattern:t) >> 7)) &* (61 | t))) ^ t
            return Double(UInt32(bitPattern:t ^ Int32(bitPattern:UInt32(bitPattern:t) >> 14)))/4294967296
        }
    }

    private func layout(_ size:CGSize) {
        laidOut=size
        let W=size.width,H=size.height
        let r=Self.random(11),angle = -38*Double.pi/180,cx=W*0.5,cy=H*0.34
        band=[]
        for _ in 0..<260 {
            let along=(r()-0.5)*1.6*W
            let across=sqrt(-2*log(r()+1e-9))*cos(2*Double.pi*r())*0.07*W*(1-abs(along)/W*0.35)
            let x=cx+along*cos(angle)-across*sin(angle),y=cy+along*sin(angle)+across*cos(angle)
            let k=r(),alpha=0.12+r()*0.5
            if x>=0 && x<=W && y>=0 && y<=H {band.append(Star(x:x,y:y,size:k<0.8 ? 1:2,color:k<0.5 ? Self.mint:k<0.85 ? Self.white:VeilbirdStyle.accent,alpha:alpha,twinkle:false,delay:0))}
        }
        let f=Self.random(7)
        far=(0..<110).map {_ -> Star in
            let k=f(),size:Double=k<0.72 ? 1:k<0.97 ? 2:3
            let x=f()*W,y=pow(f(),1.25)*H
            let alpha=size==3 ? 0.85:0.14+f()*0.5
            let color=size==3 ? VeilbirdStyle.accent:f()<0.12 ? Self.pale:Self.white
            return Star(x:x,y:y,size:size,color:color,alpha:alpha,twinkle:f()<0.14,delay:f()*7)
        }
    }

    func draw(_ context:inout GraphicsContext,size:CGSize,time:Double?) {
        if size != laidOut {layout(size)}
        let W=size.width,H=size.height,full=Path(CGRect(origin:.zero,size:size))
        context.fill(full,with:.color(VeilbirdStyle.ground))

        for s in band {context.fill(Path(CGRect(x:s.x,y:s.y,width:s.size,height:s.size)),with:.color(s.color.opacity(s.alpha*Self.strength)))}
        // Far stars drift 30 pt down and back over four minutes.
        let drift=time.map {(1-cos($0/120*Double.pi))/2*30-30} ?? -30
        for s in far {
            let dim=time != nil && s.twinkle && (time!+s.delay).truncatingRemainder(dividingBy:7)>6.58
            context.fill(Path(CGRect(x:s.x,y:s.y+drift,width:s.size,height:s.size)),with:.color(s.color.opacity(s.alpha*Self.strength*(dim ? 0.2:1))))
        }
        let glint=Color(red:230/255,green:236/255,blue:248/255)
        for (i,g) in [(0.18,0.12,0.9),(0.84,0.38,0.7),(0.09,0.58,0.6)].enumerated() {
            let dim=time != nil && (time!+Double(i)*2.3).truncatingRemainder(dividingBy:9)>8.46
            let x=W*g.0,y=H*g.1
            var cross=Path()
            cross.addRect(CGRect(x:x-0.5,y:y-3.5,width:1,height:7));cross.addRect(CGRect(x:x-3.5,y:y-0.5,width:7,height:1));cross.addRect(CGRect(x:x-1.5,y:y-1.5,width:3,height:3))
            context.fill(cross,with:.color(glint.opacity(g.2*Self.strength*(dim ? 0.2:1))))
        }
    }
}
