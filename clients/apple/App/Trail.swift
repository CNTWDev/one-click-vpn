import SwiftUI
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

/// Time this device spent connected, per UTC day, kept for 90 days. Counted here only (the server knows traffic, not
/// time); the usage page's trail shows it as "hidden here".
enum HiddenTime {
    private static let key="hiddenSeconds"
    private static var pending=0.0
    private static var lastTick:Date?
    /// Called once a second by the model; writes at most once a minute.
    static func tick(_ connected:Bool) {
        let now=Date()
        defer {lastTick=connected ? now:nil}
        guard connected,let last=lastTick else {flush();return}
        pending+=min(5,max(0,now.timeIntervalSince(last)))
        if pending>=60 {flush()}
    }
    static func flush() {
        guard pending>0 else {return}
        var days=UserDefaults.standard.dictionary(forKey:key) as? [String:Double] ?? [:]
        let today=day(Date())
        days[today,default:0]+=pending;pending=0
        let oldest=day(Date().addingTimeInterval(-91*86400))
        days=days.filter {$0.key>=oldest}
        UserDefaults.standard.set(days,forKey:key)
    }
    /// Hours connected over the last `days` days, today included.
    static func hours(_ days:Int)->Double {
        let saved=UserDefaults.standard.dictionary(forKey:key) as? [String:Double] ?? [:]
        let since=day(Date().addingTimeInterval(-Double(days-1)*86400))
        let total=saved.filter {$0.key>=since}.reduce(pending) {$0+$1.value}
        return total/3600
    }
    private static func day(_ date:Date)->String {
        let formatter=DateFormatter();formatter.calendar=Calendar(identifier:.gregorian);formatter.locale=Locale(identifier:"en_US_POSIX")
        formatter.timeZone=TimeZone(identifier:"UTC");formatter.dateFormat="yyyy-MM-dd"
        return formatter.string(from:date)
    }
    static func text(_ hours:Double)->String {
        let formatter=NumberFormatter();formatter.locale=L10n.locale;formatter.minimumFractionDigits=0
        formatter.maximumFractionDigits=hours<10 ? 1:0
        return L10n.text("trail_hours",formatter.string(from:NSNumber(value:hours)) ?? "0")
    }
}

/// One exit on the trail: where it is and its share of the traffic (the busiest is 1).
struct TrailExit:Equatable {
    var spot:Spot
    var weight:Double
}

/// The trail: every location this account went out from in the range, lit by how much went through it. With the
/// home city, arcs from it; without (the poster's default), rings at the exits only, so nothing points home.
struct TrailGlobe:View {
    let exits:[TrailExit]
    var home:Spot?
    var labels=true
    @Environment(\.displayScale) private var displayScale
    var body:some View {
        Canvas {g,size in draw(g,size)}.accessibilityHidden(true)
    }
    private struct Geometry {
        var cx:Double
        var cy:Double
        var radius:Double
        var u:Double
        var vLat:Double
        var vLon:Double
        func screen(_ p:(x:Double,y:Double,z:Double))->(x:Double,y:Double,shown:Bool) {
            (cx+p.x*radius,cy-p.y*radius,p.z>0 || (p.x*p.x+p.y*p.y).squareRoot()>1)
        }
        func place(_ s:Spot)->(x:Double,y:Double,shown:Bool) {screen(Earth.project(s.lat,s.lon,0,vLat,vLon))}
    }
    /// Seen from above the middle of the exits (and home), weighted by traffic.
    static func centre(_ exits:[TrailExit],_ home:Spot?)->(lat:Double,lon:Double) {
        var x=0.0,y=0.0,z=0.0
        func add(_ s:Spot,_ w:Double) {
            let p=s.lat*Double.pi/180,l=s.lon*Double.pi/180
            x+=w*cos(p)*sin(l);y+=w*sin(p);z+=w*cos(p)*cos(l)
        }
        for e in exits {add(e.spot,0.3+e.weight)}
        if let home {add(home,1.3)}
        let n=(x*x+y*y+z*z).squareRoot()
        if n<1e-6 {return (home?.lat ?? 25,home?.lon ?? 110)}
        let lat=asin(y/n)*180/Double.pi,lon=atan2(x,z)*180/Double.pi
        return (min(50,max(-35,lat)),lon)
    }
    private func draw(_ g:GraphicsContext,_ size:CGSize) {
        let s=Double(min(size.width,size.height))
        if s<=0 {return}
        let v=Self.centre(exits,home)
        let f=Geometry(cx:Double(size.width)/2,cy:Double(size.height)/2,radius:s/2,u:s/320,vLat:v.lat,vLon:v.lon)
        drawSphere(g,f,s)
        let order=exits.sorted {$0.weight<$1.weight}
        for e in order {
            if let home {drawArc(g,f,home,e)} else {drawRings(g,f,e)}
        }
        for e in order {drawExit(g,f,e)}
        if let home {drawHome(g,f,home)}
        if labels {drawLabels(g,f,size)}
    }
    private func drawSphere(_ g:GraphicsContext,_ f:Geometry,_ s:Double) {
        guard let image=SphereCache.shared.image(size:Int(s),lat:f.vLat,lon:f.vLon,theme:VeilbirdStyle.theme,scale:displayScale) else {return}
        var layer=g
        layer.opacity=0.55
        layer.draw(Image(decorative:image,scale:1),in:CGRect(x:f.cx-f.radius,y:f.cy-f.radius,width:s,height:s))
    }
    private func arcPath(_ f:Geometry,_ a:Spot,_ b:Spot)->Path {
        let w=Earth.angle(a.lat,a.lon,b.lat,b.lon)
        var lift=max(0.06,0.08+0.28*w/Double.pi)
        var points:[(x:Double,y:Double,shown:Bool)]=[]
        for _ in 0..<5 {
            points=[]
            var far=0.0
            for i in 0...80 {
                let t=Double(i)/80
                let gc=Earth.slerp(a.lat,a.lon,b.lat,b.lon,t)
                let p=Earth.project(gc.lat,gc.lon,lift*sin(Double.pi*t),f.vLat,f.vLon)
                points.append(f.screen(p))
                far=max(far,(p.x*p.x+p.y*p.y).squareRoot())
            }
            if far<1.04 {break}
            lift*=0.7
        }
        var path=Path()
        var open=false
        for q in points {
            let r=((q.x-f.cx)*(q.x-f.cx)+(q.y-f.cy)*(q.y-f.cy)).squareRoot()
            if !q.shown || r>f.radius*0.93 {open=false;continue}
            if open {path.addLine(to:CGPoint(x:q.x,y:q.y))} else {path.move(to:CGPoint(x:q.x,y:q.y));open=true}
        }
        return path
    }
    private func drawArc(_ g:GraphicsContext,_ f:Geometry,_ home:Spot,_ e:TrailExit) {
        guard f.place(e.spot).shown else {return}
        let path=arcPath(f,home,e.spot)
        let w=e.weight
        g.stroke(path,with:.color(VeilbirdStyle.accent.opacity(0.07+0.08*w)),style:StrokeStyle(lineWidth:(7*w+2)*f.u,lineCap:.round,lineJoin:.round))
        g.stroke(path,with:.color(VeilbirdStyle.accent.opacity(0.35+0.55*w)),style:StrokeStyle(lineWidth:1.6*f.u,lineCap:.round,lineJoin:.round))
    }
    private func drawRings(_ g:GraphicsContext,_ f:Geometry,_ e:TrailExit) {
        let p=f.place(e.spot)
        guard p.shown else {return}
        for i in 1...2 {
            let r=(8+10*e.weight)*f.u*Double(i)*1.3
            let rect=CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)
            g.stroke(Path(ellipseIn:rect),with:.color(VeilbirdStyle.accent.opacity((0.12+0.3*e.weight)/Double(i))),style:StrokeStyle(lineWidth:max(1,f.u)))
        }
    }
    private func drawExit(_ g:GraphicsContext,_ f:Geometry,_ e:TrailExit) {
        let p=f.place(e.spot)
        guard p.shown else {return}
        let r=(10+16*e.weight)*f.u
        let gradient=Gradient(colors:[VeilbirdStyle.accent.opacity(0.25+0.4*e.weight),VeilbirdStyle.accent.opacity(0)])
        g.fill(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)),with:.radialGradient(gradient,center:CGPoint(x:p.x,y:p.y),startRadius:0,endRadius:r))
        let side=max(4,(4+3*e.weight)*f.u)
        g.fill(Path(CGRect(x:p.x-side/2,y:p.y-side/2,width:side,height:side)),with:.color(VeilbirdStyle.light.opacity(0.6+0.4*e.weight)))
    }
    private func drawHome(_ g:GraphicsContext,_ f:Geometry,_ home:Spot) {
        let p=f.place(home)
        guard p.shown else {return}
        let r=8*f.u
        g.stroke(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)),with:.color(VeilbirdStyle.text.opacity(0.4)),style:StrokeStyle(lineWidth:max(1,f.u)))
        let side=max(4,5*f.u)
        g.fill(Path(CGRect(x:p.x-side/2,y:p.y-side/2,width:side,height:side)),with:.color(VeilbirdStyle.text.opacity(0.95)))
    }
    /// The busiest visible exits get a name; one that would cover another is left out.
    private func drawLabels(_ g:GraphicsContext,_ f:Geometry,_ size:CGSize) {
        var taken:[CGRect]=[]
        let font=Font.system(size:max(11,11*f.u),weight:.medium)
        var layer=g
        layer.addFilter(.shadow(color:Color.black.opacity(0.9),radius:3*f.u))
        for e in exits.sorted(by:{$0.weight>$1.weight}).prefix(4) {
            let p=f.place(e.spot)
            guard p.shown,!e.spot.label.isEmpty else {continue}
            let top=e.weight>0.9
            let text=layer.resolve(Text(e.spot.label).font(font).foregroundColor(top ? VeilbirdStyle.accent:VeilbirdStyle.text.opacity(0.75)))
            let measured=text.measure(in:size)
            var x=p.x+12*f.u
            if x+Double(measured.width)>Double(size.width)-4 {x=p.x-12*f.u-Double(measured.width)}
            let rect=CGRect(x:x,y:p.y-Double(measured.height)*1.3,width:Double(measured.width),height:Double(measured.height))
            if taken.contains(where:{$0.insetBy(dx:-4,dy:-2).intersects(rect)}) {continue}
            taken.append(rect)
            layer.draw(text,in:rect)
        }
    }
}

/// The shared picture: 1080×1920 (drawn at 360×640, three times over). No IP, no account; the home city only when
/// the person turns it on.
struct TrailPoster:View {
    let exits:[TrailExit]
    let home:Spot?
    let range:String
    let stats:[(String,String)]
    var body:some View {
        VStack(alignment:.leading,spacing:14) {
            HStack(spacing:8) {PixelMark(size:16);Wordmark(size:11)}
            VStack(alignment:.leading,spacing:6) {
                Text(L10n.text("trail_poster_title")).font(.system(size:26,weight:.light)).foregroundStyle(VeilbirdStyle.text).lineLimit(2).minimumScaleFactor(0.8)
                Text(range).font(.system(size:12,weight:.medium)).foregroundStyle(VeilbirdStyle.faint)
            }
            TrailGlobe(exits:exits,home:home).frame(width:300,height:300).frame(maxWidth:.infinity)
            TrailStats(stats:stats,size:26)
            Spacer(minLength:0)
            Text(L10n.text("trail_poster_slogan")).font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
        }
        .padding(.horizontal,30).padding(.vertical,34)
        .frame(width:360,height:640,alignment:.topLeading)
        .background(VeilbirdStyle.ground)
        .environment(\.locale,L10n.locale)
    }
    /// The poster as an image, three pixels to the point.
    @MainActor func image()->CGImage? {
        let renderer=ImageRenderer(content:self.environment(\.displayScale,3))
        renderer.scale=3
        return renderer.cgImage
    }
}

/// Three figures side by side: the value large, its name small under it.
struct TrailStats:View {
    let stats:[(String,String)]
    var size:CGFloat=22
    /// "41.2 GB": the number in the dot face, the unit small beside it (the dot face has no CJK or Cyrillic).
    private func value(_ text:String,_ tint:Color)->Text {
        let parts=text.split(separator:" ",maxSplits:1).map(String.init)
        let number=Text(parts.first ?? text).font(Pixel.font(size)).foregroundColor(tint)
        guard parts.count>1 else {return number}
        return number+Text(" "+parts[1]).font(.system(size:size*0.5,weight:.medium)).foregroundColor(VeilbirdStyle.secondary)
    }
    var body:some View {
        HStack(alignment:.top,spacing:12) {
            ForEach(stats.indices,id:\.self) {i in
                VStack(alignment:.leading,spacing:4) {
                    value(stats[i].0,i == 0 ? VeilbirdStyle.accent:VeilbirdStyle.text).lineLimit(1).minimumScaleFactor(0.6)
                    Text(stats[i].1).font(.system(size:11)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
                }.frame(maxWidth:.infinity,alignment:.leading)
            }
        }
    }
}

#if os(macOS)
enum PosterFile {
    /// Asks where to save, then writes a PNG; false when cancelled or the write failed.
    @MainActor static func save(_ image:CGImage)->Bool {
        let panel=NSSavePanel()
        panel.allowedContentTypes=[.png]
        panel.nameFieldStringValue="TrackNothing.png"
        guard panel.runModal() == .OK,let url=panel.url else {return false}
        let rep=NSBitmapImageRep(cgImage:image)
        guard let data=rep.representation(using:.png,properties:[:]) else {return false}
        return (try? data.write(to:url)) != nil
    }
}
#endif
