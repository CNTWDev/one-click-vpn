import SwiftUI

/// The deep-space backdrop behind every page, same recipe as the Portal (portal-web/src/space.tsx) and the other
/// clients: a near-black sky, a pixel Milky Way on a slant over a faint teal and lime nebula, far stars that drift
/// very slowly, a few cross glints, a dithered moon and a dark planet whose lit rim sits at the bottom. Stars are
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
    private var dots:[(CGRect,Double)]=[]
    private var moon:[(CGRect,Color)]=[]

    private static let white=Color(red:232/255,green:238/255,blue:228/255)
    private static let mint=Color(red:191/255,green:216/255,blue:204/255)
    private static let pale=Color(red:207/255,green:230/255,blue:160/255)

    private static func random(_ seed:Int32)->()->Double {
        var a=seed
        return {
            a=a &+ 0x6D2B79F5
            var t=(a ^ Int32(bitPattern:UInt32(bitPattern:a) >> 15)) &* (1 | a)
            t=(t &+ ((t ^ Int32(bitPattern:UInt32(bitPattern:t) >> 7)) &* (61 | t))) ^ t
            return Double(UInt32(bitPattern:t ^ Int32(bitPattern:UInt32(bitPattern:t) >> 14)))/4294967296
        }
    }

    private func planet(_ size:CGSize)->(x:Double,y:Double,r:Double) {
        let r=700.0
        return (size.width/2,size.height-max(200,size.height*0.26)+r,r)
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
        // Planet rim and lit surface as dots on a 6 pt grid.
        let p=planet(size),top=p.y-p.r
        dots=[]
        var y=top-0.12*p.r
        while y<min(H,top+max(0.3*p.r,40)) {
            var x=0.0
            while x<W {
                let dist=hypot(x-p.x,y-p.y)/p.r
                let rim=dist>=0.974 && dist<=1.12 ? (dist<1.04 ? (dist-0.974)/0.066:(1.12-dist)/0.08)*0.5*0.55:0
                let e=pow((x-p.x)/p.r,2)+pow((y-top)/(0.28*p.r),2)
                let lit=dist<1 && e<1 ? (1-e)*0.5*0.2:0
                if rim+lit>0.01 {dots.append((CGRect(x:x,y:y,width:1.4,height:1.4),rim+lit))}
                x+=6
            }
            y+=6
        }
        // Moon: a 22 pt disc of 3 pt dots, lit from the top left.
        let m=22.0,mx=W*0.76,my=H*0.09
        moon=[]
        for row in 0..<7 {for col in 0..<7 {
            let px=Double(col)*3,py=Double(row)*3
            guard hypot(px+1.5-m/2,py+1.5-m/2)<=m/2 else {continue}
            let t=min(1,hypot(px-m*0.32,py-m*0.30)/(m*0.75))
            let level=t<0.6 ? 0.79-(0.79-0.47)*t/0.6:0.47-(0.47-0.12)*(t-0.6)/0.4
            moon.append((CGRect(x:mx+px,y:my+py,width:2.2,height:2.2),Color(red:level*0.92,green:level,blue:level*0.84)))
        }}
    }

    private func ellipse(_ context:inout GraphicsContext,_ center:CGPoint,_ rx:Double,_ ry:Double,_ color:Color) {
        let rect=CGRect(x:center.x-rx,y:center.y-ry,width:2*rx,height:2*ry)
        context.fill(Path(ellipseIn:rect),with:.radialGradient(Gradient(stops:[.init(color:color,location:0),.init(color:color.opacity(0),location:0.7)]),center:center,startRadius:0,endRadius:max(rx,ry)))
    }

    func draw(_ context:inout GraphicsContext,size:CGSize,time:Double?) {
        if size != laidOut {layout(size)}
        let W=size.width,H=size.height,full=Path(CGRect(origin:.zero,size:size))
        context.fill(full,with:.linearGradient(Gradient(stops:[.init(color:Color(red:1/255,green:2/255,blue:2/255),location:0),.init(color:Color(red:3/255,green:6/255,blue:5/255),location:0.5),.init(color:Color(red:5/255,green:10/255,blue:8/255),location:1)]),startPoint:.zero,endPoint:CGPoint(x:0,y:H)))

        // Nebula along the band.
        var nebula=context
        nebula.translateBy(x:W*0.5,y:H*0.34);nebula.rotate(by:.degrees(-38))
        let bw=1.5*W,bh=0.6*H
        ellipse(&nebula,CGPoint(x:-0.12*bw,y:0),0.30*bw,0.38*bh,Color(red:46/255,green:120/255,blue:112/255).opacity(0.30))
        ellipse(&nebula,CGPoint(x:0.12*bw,y:-0.04*bh),0.22*bw,0.30*bh,Color(red:140/255,green:190/255,blue:80/255).opacity(0.16))
        ellipse(&nebula,.zero,0.50*bw,0.20*bh,Color(red:150/255,green:200/255,blue:180/255).opacity(0.07))

        for s in band {context.fill(Path(CGRect(x:s.x,y:s.y,width:s.size,height:s.size)),with:.color(s.color.opacity(s.alpha)))}
        // Far stars drift 30 pt down and back over four minutes.
        let drift=time.map {(1-cos($0/120*Double.pi))/2*30-30} ?? -30
        for s in far {
            let dim=time != nil && s.twinkle && (time!+s.delay).truncatingRemainder(dividingBy:7)>6.58
            context.fill(Path(CGRect(x:s.x,y:s.y+drift,width:s.size,height:s.size)),with:.color(s.color.opacity(s.alpha*(dim ? 0.2:1))))
        }
        let glint=Color(red:228/255,green:242/255,blue:204/255)
        for (i,g) in [(0.18,0.12,0.9),(0.84,0.38,0.7),(0.09,0.58,0.6)].enumerated() {
            let dim=time != nil && (time!+Double(i)*2.3).truncatingRemainder(dividingBy:9)>8.46
            let x=W*g.0,y=H*g.1
            var cross=Path()
            cross.addRect(CGRect(x:x-0.5,y:y-3.5,width:1,height:7));cross.addRect(CGRect(x:x-3.5,y:y-0.5,width:7,height:1));cross.addRect(CGRect(x:x-1.5,y:y-1.5,width:3,height:3))
            context.fill(cross,with:.color(glint.opacity(g.2*(dim ? 0.2:1))))
        }
        for (rect,color) in moon {context.fill(Path(rect),with:.color(color.opacity(0.7)))}
        context.fill(full,with:.radialGradient(Gradient(stops:[.init(color:.clear,location:0),.init(color:.clear,location:0.55),.init(color:.black.opacity(0.6),location:1)]),center:CGPoint(x:W/2,y:H*0.42),startRadius:0,endRadius:hypot(W,H)*0.6))

        // Planet: glow, body, rim line, then the dithered atmosphere and lit surface.
        let p=planet(size),top=p.y-p.r,glow=p.r+70
        let disc=Path(ellipseIn:CGRect(x:p.x-p.r,y:p.y-p.r,width:2*p.r,height:2*p.r))
        context.fill(Path(ellipseIn:CGRect(x:p.x-glow,y:p.y-glow,width:2*glow,height:2*glow)),with:.radialGradient(Gradient(stops:[.init(color:.clear,location:p.r/glow-0.01),.init(color:Color(red:90/255,green:170/255,blue:150/255).opacity(0.14),location:p.r/glow),.init(color:.clear,location:1)]),center:CGPoint(x:p.x,y:p.y),startRadius:0,endRadius:glow))
        context.fill(disc,with:.radialGradient(Gradient(stops:[.init(color:Color(red:16/255,green:29/255,blue:22/255),location:0),.init(color:Color(red:7/255,green:16/255,blue:12/255),location:0.18),.init(color:Color(red:3/255,green:6/255,blue:5/255),location:0.45)]),center:CGPoint(x:p.x,y:top),startRadius:0,endRadius:2.24*p.r))
        context.stroke(disc,with:.color(Color(red:200/255,green:232/255,blue:140/255).opacity(0.55)),lineWidth:1)
        for (rect,alpha) in dots {context.fill(Path(rect),with:.color(VeilbirdStyle.accent.opacity(alpha)))}
    }
}
