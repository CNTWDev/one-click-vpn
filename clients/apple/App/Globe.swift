import SwiftUI
import CoreGraphics

/// A place on the globe, with the name written beside it (may be empty).
struct Spot:Equatable {
    var lat:Double
    var lon:Double
    var label:String=""
}

/// The land and the sums of the route globe, the same on every client (Android Globe.kt, Windows Globe.cs) and the
/// Portal (portal-web/src/globe.ts): an orthographic view of the earth, great circles between two places, and the
/// halftone light of the old dot sphere. Kept in small typed helpers so Release builds type-check quickly.
enum Earth {
    private static let rad=Double.pi/180
    /// 360×180 soft land mask (one value per degree) from the 720×360 bits of LandMask.
    static let mask:[Float]={
        let bits=[UInt8](Data(base64Encoded:LandMask.base64) ?? Data())
        guard bits.count==32400 else {return [Float](repeating:0,count:360*180)}
        func bit(_ i:Int)->Int {Int(bits[i>>3]>>UInt8(i & 7)) & 1}
        var m=[Float](repeating:0,count:360*180)
        for y in 0..<180 {
            for x in 0..<360 {
                var a=0
                for dy in 0...1 {for dx in 0...1 {a+=bit((2*y+dy)*720+2*x+dx)}}
                // Antarctica stays dark: it would only show as a smudge at the bottom of the globe.
                m[y*360+x]=y>=152 ? 0:Float(a)/4
            }
        }
        var o=[Float](repeating:0,count:360*180)
        for y in 0..<180 {
            for x in 0..<360 {
                var t:Float=0,n:Float=0
                for dy in -1...1 {
                    let yy=y+dy
                    if yy<0 || yy>=180 {continue}
                    for dx in -1...1 {t+=m[yy*360+(x+dx+360)%360];n+=1}
                }
                o[y*360+x]=t/n
            }
        }
        return o
    }()
    static func land(_ lat:Double,_ lon:Double)->Double {
        var fx=lon+180-0.5
        fx=(fx.truncatingRemainder(dividingBy:360)+360).truncatingRemainder(dividingBy:360)
        let fy=min(179,max(0,90-lat-0.5))
        let x0=Int(fx),y0=Int(fy),x1=(x0+1)%360,y1=min(179,y0+1)
        let tx=Float(fx-Double(x0)),ty=Float(fy-Double(y0))
        let top=mask[y0*360+x0]*(1-tx)+mask[y0*360+x1]*tx
        let bottom=mask[y1*360+x0]*(1-tx)+mask[y1*360+x1]*tx
        return Double(top*(1-ty)+bottom*ty)
    }
    /// The old sphere's halftone falloff from its light (upper left).
    static func light(_ f:Double)->Double {
        if f<0.22 {return 1-f/0.22*0.15}
        if f<0.48 {return 0.85-(f-0.22)/0.26*0.5}
        if f<0.66 {return 0.35-(f-0.48)/0.18*0.27}
        if f<0.72 {return 0.08-(f-0.66)/0.06*0.08}
        return 0
    }
    /// Unit-disk position (y up) and depth of a place lifted h radii above the ground, seen from above (vLat, vLon).
    static func project(_ lat:Double,_ lon:Double,_ h:Double,_ vLat:Double,_ vLon:Double)->(x:Double,y:Double,z:Double) {
        let p=lat*rad,l=lon*rad,p0=vLat*rad,l0=vLon*rad,c=cos(p),k=1+h
        let x=c*sin(l-l0)*k
        let y=(cos(p0)*sin(p)-sin(p0)*c*cos(l-l0))*k
        let z=sin(p0)*sin(p)+cos(p0)*c*cos(l-l0)
        return (x,y,z)
    }
    /// The place under a unit-disk point.
    static func unproject(_ nx:Double,_ ny:Double,_ vLat:Double,_ vLon:Double)->(lat:Double,lon:Double) {
        let r=(nx*nx+ny*ny).squareRoot()
        if r<1e-9 {return (vLat,vLon)}
        let c=asin(min(1,r)),p0=vLat*rad
        let lat=asin(cos(c)*sin(p0)+ny*sin(c)*cos(p0)/r)
        let lon=vLon*rad+atan2(nx*sin(c),r*cos(c)*cos(p0)-ny*sin(c)*sin(p0))
        return (lat/rad,lon/rad)
    }
    private static func vec(_ lat:Double,_ lon:Double)->(Double,Double,Double) {
        (cos(lat*rad)*sin(lon*rad),sin(lat*rad),cos(lat*rad)*cos(lon*rad))
    }
    static func angle(_ aLat:Double,_ aLon:Double,_ bLat:Double,_ bLon:Double)->Double {
        let a=vec(aLat,aLon),b=vec(bLat,bLon)
        let dot=a.0*b.0+a.1*b.1+a.2*b.2
        return acos(max(-1,min(1,dot)))
    }
    /// The point a fraction t of the way along the great circle from a to b.
    static func slerp(_ aLat:Double,_ aLon:Double,_ bLat:Double,_ bLon:Double,_ t:Double)->(lat:Double,lon:Double) {
        let w=angle(aLat,aLon,bLat,bLon)
        if w<1e-6 {return (aLat,aLon)}
        let a=vec(aLat,aLon),b=vec(bLat,bLon),s=sin(w)
        let k1=sin((1-t)*w)/s,k2=sin(t*w)/s
        let x=a.0*k1+b.0*k2,y=a.1*k1+b.1*k2,z=a.2*k1+b.2*k2
        let n=(x*x+y*y+z*z).squareRoot()
        return (asin(y/n)/rad,atan2(x,z)/rad)
    }
    static func km(_ a:Spot,_ b:Spot)->Double {angle(a.lat,a.lon,b.lat,b.lon)*6371}
    static func ease(_ t:Double)->Double {t<0.5 ? 4*t*t*t:1-pow(-2*t+2,3)/2}
}

/// The globe's still part (the dot lattice of the earth), drawn once per size and view. One cache for the whole app:
/// a page that opens again (switching tabs rebuilds it) or the menu bar's globe finds its image already drawn
/// instead of laying out some 3 000 dots in the first frame of its entrance.
private final class SphereCache {
    static let shared=SphereCache()
    /// The few latest images, newest last (the window's globe, the menu bar's, one while turning).
    private var images:[(key:String,image:CGImage)]=[]
    func image(size:Int,lat:Double,lon:Double,theme:String,scale:CGFloat)->CGImage? {
        let px=max(1,Int(CGFloat(size)*scale))
        let k="\(px) \(Int((lat*100).rounded())) \(Int((lon*100).rounded())) \(theme)"
        if let i=images.firstIndex(where:{$0.key==k}) {
            let hit=images.remove(at:i)
            images.append(hit)
            return hit.image
        }
        guard let image=SphereCache.render(px,lat,lon,theme) else {return nil}
        images.append((k,image))
        if images.count>3 {images.removeFirst()}
        return image
    }
    private static func render(_ s:Int,_ vLat:Double,_ vLon:Double,_ theme:String)->CGImage? {
        guard let ctx=CGContext(data:nil,width:s,height:s,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {return nil}
        // CoreGraphics counts y up; the lattice is laid out top-down like the other clients, then flipped.
        ctx.translateBy(x:0,y:CGFloat(s));ctx.scaleBy(x:1,y:-1)
        let rgb:(CGFloat,CGFloat,CGFloat)=theme=="moon" ? (248,226,230):(255,214,160)
        let size=Double(s),pitch=size*6/320,r=size*1.15/320,radius=size/2,lx=size*0.42,ly=size*0.34
        var y=pitch/2
        while y<size {
            var x=pitch/2
            while x<size {
                dot(ctx,x,y,radius,size,lx,ly,r,vLat,vLon,rgb)
                x+=pitch
            }
            y+=pitch
        }
        return ctx.makeImage()
    }
    private static func dot(_ ctx:CGContext,_ x:Double,_ y:Double,_ radius:Double,_ size:Double,_ lx:Double,_ ly:Double,_ r:Double,_ vLat:Double,_ vLon:Double,_ rgb:(CGFloat,CGFloat,CGFloat)) {
        let nx=(x-radius)/radius,ny=(radius-y)/radius,dd=nx*nx+ny*ny
        if dd>1 {return}
        let z=(1-dd).squareRoot()
        let place=Earth.unproject(nx,ny,vLat,vLon)
        let land=Earth.land(place.lat,place.lon)
        let fx=x-lx,fy=y-ly
        let a=Earth.light((fx*fx+fy*fy).squareRoot()/(size*0.98))
        let limb=min(1,z/0.18)
        let alpha=(land*(0.3+0.5*a)+(1-land)*(0.025+0.08*a))*limb
        if alpha<0.02 {return}
        let rr=r*(0.72+0.32*land)
        ctx.setFillColor(red:rgb.0/255,green:rgb.1/255,blue:rgb.2/255,alpha:CGFloat(min(1,alpha)))
        ctx.fillEllipse(in:CGRect(x:x-rr,y:y-rr,width:2*rr,height:2*rr))
    }
}

/// One frame's inputs, so the drawing stays a set of small typed functions.
private struct Frame {
    var size:CGSize
    var s:Double
    var cx:Double
    var cy:Double
    var radius:Double
    var u:Double
    var vLat:Double
    var vLon:Double
    var clock:Double
    var since:Double
    var still:Bool
    var state:RingState
    var small:Bool
    var on:Bool {state != .idle && state != .failed}
    var busy:Bool {state == .connecting || state == .switching}
    var connected:Bool {state == .connected}
    var breath:Double {0.5-0.5*cos(clock/3*Double.pi*2)}
    func screen(_ p:(x:Double,y:Double,z:Double))->(x:Double,y:Double,shown:Bool) {
        (cx+p.x*radius,cy-p.y*radius,p.z>0 || (p.x*p.x+p.y*p.y).squareRoot()>1)
    }
}

/// The connect page's globe: the old dot sphere, now the earth. Off, it marks where this device is (a light with a
/// slow ripple); connecting, it turns to show both ends and a light runs the arc to the location; connected, the arc
/// stays lit, the location glows, and the time hidden and the rates sit in its lower half. The globe is the backdrop
/// and stays dim; the route is the bright layer. A still globe is one cached image, drawn again only while it turns
/// (1.2 s); small loops run at most 30 frames a second and not at all under Reduce Motion. Same drawing on every
/// client (Android Globe.kt, Windows Globe.cs) and the Portal.
struct PortraitView:View {
    let hidden:Bool
    let invite:String
    let since:Date?
    let sub:String
    var state:RingState = .idle
    var lines=4
    /// In the lower half instead of the time: the phase while connecting, the countdown while reconnecting.
    var centre=""
    /// This device (nil: unknown, or left off by the person) and the location it goes out from (nil: unknown).
    var origin:Spot?=nil
    var exit:Spot?=nil
    /// Under the location's name, e.g. "1 760 km"; empty without an origin.
    var distance=""
    /// The menu bar's small globe: only the location's name, no distance and no time inside.
    var small=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @AppStorage(VeilbirdStyle.themeKey) private var theme="amber"
    @State private var stateAt=Date()
    @State private var from:(lat:Double,lon:Double)?=nil
    @State private var to:(lat:Double,lon:Double)?=nil
    @State private var turnAt=Date.distantPast

    private var on:Bool {state != .idle && state != .failed}
    /// Where the globe should face: this device when off, both ends (the route in the upper half) when on.
    private var target:(lat:Double,lon:Double)? {
        var aim:(Double,Double)?=nil
        if on,let b=exit,let a=origin {
            let m=Earth.slerp(a.lat,a.lon,b.lat,b.lon,0.5)
            let w=Earth.angle(a.lat,a.lon,b.lat,b.lon)*180/Double.pi
            aim=(m.lat-8-w*0.12,m.lon)
        } else if on,let b=exit {aim=(b.lat-12,b.lon-22)}
        else if let a=origin {aim=(a.lat-14,a.lon)}
        else if let b=exit {aim=(b.lat-14,b.lon)}
        guard let aim else {return nil}
        return (max(-55,min(55,aim.0)),aim.1)
    }
    private var targetKey:String {
        guard let t=target else {return "none"}
        return "\(Int((t.lat*100).rounded())) \(Int((t.lon*100).rounded()))"
    }
    private func view(at now:Date)->(lat:Double,lon:Double) {
        guard let to else {return target ?? (20,105)}
        guard let from else {return to}
        let k=min(1,max(0,now.timeIntervalSince(turnAt)/(on ? 1.2:0.8)))
        let e=Earth.ease(k)
        return (from.lat+(to.lat-from.lat)*e,from.lon+(to.lon-from.lon)*e)
    }
    private func turning(_ now:Date)->Bool {now.timeIntervalSince(turnAt)<(on ? 1.2:0.8)}
    private var loops:Bool {
        if reduceMotion {return false}
        return (state == .idle && origin != nil) || state == .connecting || state == .switching || state == .connected || state == .reconnecting
    }

    var body:some View {
        TimelineView(.animation(minimumInterval:1.0/30,paused:!loops && !turning(Date()))) {context in
            Canvas {g,size in draw(g,size,context.date)}
        }
        .accessibilityHidden(true)
        .onAppear {to=target;from=nil}
        .onChange(of:targetKey) {_ in retarget()}
        .onChange(of:state) {_ in stateAt=Date()}
    }
    private func retarget() {
        let now=Date()
        guard let t=target else {return}
        if reduceMotion || to == nil {from=nil;to=t;turnAt = .distantPast;return}
        let current=view(at:now)
        var dl=t.lon-current.lon
        dl=(dl+540).truncatingRemainder(dividingBy:360)-180
        from=current;to=(t.lat,current.lon+dl);turnAt=now
    }

    private func draw(_ g:GraphicsContext,_ size:CGSize,_ now:Date) {
        let s=Double(min(size.width,size.height))
        if s<=0 {return}
        let v=view(at:now)
        let still=reduceMotion
        var f=Frame(size:size,s:s,cx:Double(size.width)/2,cy:Double(size.height)/2,radius:s/2,u:s/320,vLat:v.lat,vLon:v.lon,
            clock:still ? 0:now.timeIntervalSinceReferenceDate,since:still ? 9:now.timeIntervalSince(stateAt),still:still,state:state,small:small)
        if f.since<0 {f.since=0}
        drawSphere(g,f)
        if on,let b=exit {drawRoute(g,f,b)}
        if let a=origin {drawOrigin(g,f,a)}
        if let b=exit {drawExit(g,f,b)}
        drawNames(g,f)
        if !small {drawInside(g,f,now)}
    }
    private func dimming(_ f:Frame)->Double {
        switch f.state {
        case .failed:return 0.42
        case .reconnecting,.waiting:return 0.5
        case .connected:return 0.55
        case .connecting,.switching:return 0.6
        default:return 0.8+0.12*f.breath
        }
    }
    private func drawSphere(_ g:GraphicsContext,_ f:Frame) {
        guard let image=SphereCache.shared.image(size:Int(f.s),lat:f.vLat,lon:f.vLon,theme:theme,scale:displayScale) else {return}
        var layer=g
        layer.opacity=dimming(f)
        let rect=CGRect(x:f.cx-f.radius,y:f.cy-f.radius,width:f.s,height:f.s)
        layer.draw(Image(decorative:image,scale:1),in:rect)
        // A faint rim of light just outside the globe.
        let rim=Path(ellipseIn:rect.insetBy(dx:-0.045*f.s,dy:-0.045*f.s))
        let gradient=Gradient(stops:[.init(color:VeilbirdStyle.light.opacity(0.045*dimming(f)),location:0.917),.init(color:VeilbirdStyle.light.opacity(0),location:1)])
        var ring=g
        ring.clip(to:Path(ellipseIn:rect),options:.inverse)
        ring.fill(rim,with:.radialGradient(gradient,center:CGPoint(x:f.cx,y:f.cy),startRadius:0,endRadius:f.radius*1.09))
    }
    private func glow(_ g:GraphicsContext,_ x:Double,_ y:Double,_ r:Double,_ color:Color,_ alpha:Double) {
        if r<=0 {return}
        let rect=CGRect(x:x-r,y:y-r,width:2*r,height:2*r)
        let gradient=Gradient(colors:[color.opacity(min(1,alpha)),color.opacity(0)])
        g.fill(Path(ellipseIn:rect),with:.radialGradient(gradient,center:CGPoint(x:x,y:y),startRadius:0,endRadius:r))
    }
    private func square(_ g:GraphicsContext,_ x:Double,_ y:Double,_ side:Double,_ color:Color) {
        g.fill(Path(CGRect(x:x-side/2,y:y-side/2,width:side,height:side)),with:.color(color))
    }
    /// The route's points: a great circle lifted off the ground, flattened until it stays in the frame.
    private func routePoints(_ f:Frame,_ b:Spot)->[(x:Double,y:Double,shown:Bool,t:Double)] {
        let start:(lat:Double,lon:Double)=origin.map {($0.lat,$0.lon)} ?? Earth.unproject(-0.97,-0.05,f.vLat,f.vLon)
        let w=Earth.angle(start.lat,start.lon,b.lat,b.lon)
        var lift=max(0.07,0.09+0.3*w/Double.pi)
        var points:[(x:Double,y:Double,shown:Bool,t:Double)]=[]
        for _ in 0..<4 {
            points=[]
            var far=0.0
            for i in 0...96 {
                let t=Double(i)/96
                let gc=Earth.slerp(start.lat,start.lon,b.lat,b.lon,t)
                let p=Earth.project(gc.lat,gc.lon,lift*sin(Double.pi*t),f.vLat,f.vLon)
                let q=f.screen(p)
                points.append((q.x,q.y,q.shown,t))
                far=max(far,(p.x*p.x+p.y*p.y).squareRoot())
            }
            if far<1.03 || lift<0.04 {break}
            lift*=0.7
        }
        return points
    }
    private func dotAlpha(_ f:Frame,_ t:Double,_ head:Double,_ charge:Double)->Double {
        let fade=origin != nil ? 1:min(1,t/0.35)
        var a=0.16
        if f.connected {
            a=t<=charge ? 1:0.3
            let gap=head-t
            if !f.still && f.since>0.7 && gap>=0 && gap<0.14 {a=max(a,1-gap/0.14*0.2)}
        } else if f.busy {
            a=0.3
            let gap=((head-t).truncatingRemainder(dividingBy:1)+1).truncatingRemainder(dividingBy:1)
            if !f.still && gap<0.28 {a=max(a,1-gap/0.28)}
            if f.still {a=t<0.55 ? 0.9:0.3}
        } else if f.state == .reconnecting {
            a=0.2
            let gap=((head-t).truncatingRemainder(dividingBy:1)+1).truncatingRemainder(dividingBy:1)
            if !f.still && gap<0.12 {a=max(a,1-gap/0.12)}
        }
        return a*fade
    }
    private func drawRoute(_ g:GraphicsContext,_ f:Frame,_ b:Spot) {
        let points=routePoints(f,b)
        let charge=f.connected ? (f.still ? 1:min(1,f.since/0.7)):1
        if f.connected || f.busy {
            var path=Path()
            var open=false
            for q in points {
                if q.t>charge || !q.shown {open=false;continue}
                if !open {path.move(to:CGPoint(x:q.x,y:q.y));open=true} else {path.addLine(to:CGPoint(x:q.x,y:q.y))}
            }
            let wide=StrokeStyle(lineWidth:10*f.u,lineCap:.round,lineJoin:.round),narrow=StrokeStyle(lineWidth:4*f.u,lineCap:.round,lineJoin:.round)
            g.stroke(path,with:.color(VeilbirdStyle.accent.opacity(f.connected ? 0.10:0.05)),style:wide)
            g.stroke(path,with:.color(VeilbirdStyle.accent.opacity(f.connected ? 0.22:0.08)),style:narrow)
        }
        var head = -1.0
        if f.busy {head=(f.since/1.4).truncatingRemainder(dividingBy:1)}
        else if f.state == .reconnecting {head=(f.since/4).truncatingRemainder(dividingBy:1)}
        else if f.connected {head=(f.since/3).truncatingRemainder(dividingBy:1)}
        let side=max(1.25,2.7*f.u)
        var gap=0.0
        for i in 1..<points.count {
            let q=points[i],p=points[i-1]
            gap+=((q.x-p.x)*(q.x-p.x)+(q.y-p.y)*(q.y-p.y)).squareRoot()
            if gap<6.4*f.u && i != 1 {continue}
            gap=0
            if !q.shown {continue}
            let a=dotAlpha(f,q.t,head,charge)
            square(g,q.x,q.y,side,(a>0.95 ? VeilbirdStyle.light:VeilbirdStyle.accent).opacity(min(1,a)))
        }
        // A soft light at the head: the runner while connecting, the flash crossing on landing, then one every 3 s.
        var at = -1.0
        if !f.still {
            if f.busy {at=head} else if f.connected {at=f.since<0.7 ? f.since/0.7:head}
        }
        if at>=0 {
            let q=points[min(96,Int((at*96).rounded()))]
            if q.shown {glow(g,q.x,q.y,(f.busy ? 13:16)*f.u,VeilbirdStyle.light,f.connected && f.since<0.7 ? 0.9:0.7)}
        }
    }
    private func drawOrigin(_ g:GraphicsContext,_ f:Frame,_ a:Spot) {
        let p=f.screen(Earth.project(a.lat,a.lon,0,f.vLat,f.vLon))
        if !p.shown {return}
        let line=StrokeStyle(lineWidth:max(1,f.u))
        if !f.on {
            let k=f.state == .failed ? 0.5:1
            if !f.still {
                for i in 0..<2 {
                    let ph=(f.clock/3+Double(i)*0.5).truncatingRemainder(dividingBy:1)
                    let r=(5+24*ph)*f.u
                    g.stroke(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)),with:.color(VeilbirdStyle.light.opacity((1-ph)*0.65*k)),style:line)
                }
            } else {
                let r=14*f.u
                g.stroke(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)),with:.color(VeilbirdStyle.light.opacity(0.25*k)),style:line)
            }
            glow(g,p.x,p.y,14*f.u,VeilbirdStyle.light,0.5*k)
            square(g,p.x,p.y,max(2.5,5*f.u),VeilbirdStyle.light.opacity(k))
        } else {
            let r=7*f.u
            g.stroke(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)),with:.color(VeilbirdStyle.text.opacity(0.35)),style:line)
            square(g,p.x,p.y,max(2.2,4.2*f.u),VeilbirdStyle.text.opacity(0.9))
        }
    }
    private func drawExit(_ g:GraphicsContext,_ f:Frame,_ b:Spot) {
        let p=f.screen(Earth.project(b.lat,b.lon,0,f.vLat,f.vLon))
        if !p.shown || f.state == .idle {return}
        if f.state == .failed {square(g,p.x,p.y,max(2.5,4.5*f.u),VeilbirdStyle.fair.opacity(0.9));return}
        if f.connected {
            let flare=f.still || f.since<0.6 ? 0:1-min(1,(f.since-0.6)/0.8)
            glow(g,p.x,p.y,(22+16*flare)*f.u,VeilbirdStyle.accent,0.4+0.15*f.breath+0.45*flare)
            if !f.still && f.since>0.6 && f.since<2.1 {
                for i in 0..<2 {
                    let k=(f.since-0.6-Double(i)*0.25)/1.2
                    if k<=0 || k>=1 {continue}
                    let r=(6+64*Earth.ease(k))*f.u
                    g.stroke(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)),with:.color(VeilbirdStyle.accent.opacity((1-k)*0.85)),style:StrokeStyle(lineWidth:max(1,1.6*f.u*(1-k)+0.6)))
                }
            }
            square(g,p.x,p.y,max(3.5,7*f.u),VeilbirdStyle.light)
            return
        }
        var blink=f.state == .reconnecting || f.state == .waiting ? 0.4:0.8
        if f.busy && !f.still {blink=0.45+0.55*abs(sin(f.clock*Double.pi*(f.state == .switching ? 1.6:1)))}
        square(g,p.x,p.y,max(2.5,4.5*f.u),VeilbirdStyle.accent.opacity(blink))
    }
    /// Text kept inside the view; side 0 centres it, 1 ends it at x, -1 starts it at x.
    private func put(_ g:GraphicsContext,_ f:Frame,_ text:Text,_ x:Double,_ y:Double,_ side:Int) {
        let resolved=g.resolve(text)
        let w=Double(resolved.measure(in:f.size).width)
        var left=side==0 ? x-w/2:(side==1 ? x-w:x)
        left=max(4,min(Double(f.size.width)-w-4,left))
        var layer=g
        layer.addFilter(.shadow(color:VeilbirdStyle.ground.opacity(0.95),radius:3))
        layer.draw(resolved,at:CGPoint(x:left,y:max(8,min(Double(f.size.height)-8,y))),anchor:.leading)
    }
    private func drawNames(_ g:GraphicsContext,_ f:Frame) {
        let fs=max(11,11.5*f.u)
        let a=origin.map {f.screen(Earth.project($0.lat,$0.lon,0,f.vLat,f.vLon))}
        let b=exit.map {f.screen(Earth.project($0.lat,$0.lon,0,f.vLat,f.vLon))}
        if !small,let origin,let a,a.shown,!origin.label.isEmpty {
            if !f.on {
                let text=Text(verbatim:origin.label).font(.system(size:fs*1.08,weight:.medium)).foregroundColor(VeilbirdStyle.light.opacity(f.state == .failed ? 0.5:0.9))
                put(g,f,text,a.x,a.y+16*f.u+fs*0.6,0)
            } else {
                let left=b.map {a.x<$0.x} ?? true
                let text=Text(verbatim:origin.label).font(.system(size:fs*1.08,weight:.medium)).foregroundColor(VeilbirdStyle.secondary.opacity(0.85))
                put(g,f,text,a.x+(left ? -9:9)*f.u,a.y+fs*0.9,left ? 1:-1)
            }
        }
        guard f.on || f.state == .failed,let exit,let b,b.shown,!exit.label.isEmpty else {return}
        let left=a.map {b.x<$0.x} ?? false
        let bx=b.x+(left ? -14:14)*f.u,side=left ? 1:-1
        let color:Color=f.connected ? VeilbirdStyle.accent:(f.state == .failed ? VeilbirdStyle.fair:VeilbirdStyle.text.opacity(0.8))
        put(g,f,Text(verbatim:exit.label).font(.system(size:fs*1.08,weight:.medium)).foregroundColor(color),bx,b.y-fs*0.9,side)
        if !small && !distance.isEmpty && (f.connected || f.busy) {
            put(g,f,Text(verbatim:distance).font(.system(size:fs,design:.monospaced)).foregroundColor(VeilbirdStyle.secondary.opacity(f.connected ? 0.85:0.55)),bx,b.y+fs*0.45,side)
        }
    }
    /// The lower half: the time hidden and the rates (connected), the countdown (reconnecting), or one short line.
    private func drawInside(_ g:GraphicsContext,_ f:Frame,_ now:Date) {
        guard f.on else {return}
        var middle=centre
        if f.state == .connected,let since {middle=Duration.seconds(max(0,Int(now.timeIntervalSince(since)))).formatted(.time(pattern:.hourMinuteSecond))}
        if f.state == .switching {
            let n=max(lines,2)
            middle=L10n.text("switching_centre",L10n.number(StateRing.current(lines:n,at:now,still:f.still)+1),L10n.number(n))
        }
        let smallLine=f.busy
        let room=0.62*f.s
        if !middle.isEmpty {
            let size=smallLine ? max(11,0.044*f.s):max(16,0.072*f.s)
            let font:Font=smallLine ? .system(size:size,design:.monospaced):Pixel.font(size)
            let text=Text(verbatim:middle).font(font).foregroundColor(smallLine ? VeilbirdStyle.secondary:VeilbirdStyle.text)
            var resolved=g.resolve(text)
            var w=Double(resolved.measure(in:f.size).width)
            if w>room {
                let smaller:Font=smallLine ? .system(size:size*room/w,design:.monospaced):Pixel.font(size*room/w)
                resolved=g.resolve(Text(verbatim:middle).font(smaller).foregroundColor(smallLine ? VeilbirdStyle.secondary:VeilbirdStyle.text))
                w=room
            }
            g.draw(resolved,at:CGPoint(x:f.cx,y:f.cy+f.radius*(smallLine ? 0.47:0.42)),anchor:.center)
        }
        if !smallLine && !sub.isEmpty {
            let size=max(10,0.036*f.s)
            var resolved=g.resolve(Text(verbatim:sub).font(.system(size:size,design:.monospaced)).foregroundColor(VeilbirdStyle.secondary))
            let w=Double(resolved.measure(in:f.size).width)
            if w>0.7*f.s {resolved=g.resolve(Text(verbatim:sub).font(.system(size:size*0.7*f.s/w,design:.monospaced)).foregroundColor(VeilbirdStyle.secondary))}
            g.draw(resolved,at:CGPoint(x:f.cx,y:f.cy+f.radius*0.42+max(16,0.072*f.s)*0.95),anchor:.center)
        }
    }
}

/// The connect portrait with its live rates, as the window and the menu bar show it. The rates come from
/// ClientModel.live, so while connected only this redraws every second, not the page around it.
struct LivePortrait:View {
    @EnvironmentObject private var model:ClientModel
    @EnvironmentObject private var live:LiveFeed
    let state:RingState
    let since:Date?
    /// The menu bar's: no distance, no time inside.
    var small=false
    var body:some View {
        TimelineView(.periodic(from:.now,by:1)) {context in
            PortraitView(hidden:model.connected || state == .reconnecting,invite:"",since:since,
                sub:model.portraitSub(state,rates:L10n.text("connection_rates",Self.mbps(live.rxRate),Self.mbps(live.txRate))),state:state,lines:model.lines,
                centre:model.portraitCentre(state,now:context.date),origin:model.globeOrigin,exit:model.globeExit,
                distance:small ? "":model.globeDistance,small:small)
        }
    }
    static func mbps(_ bytes:Int)->String {String(format:"%.1f",locale:L10n.locale,Double(bytes)*8/1_000_000)}
}
