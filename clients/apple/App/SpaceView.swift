import SwiftUI

/// Behind every page, same as the Portal (portal-web/src/space.tsx) and the other clients: the warm ground, one soft
/// lamp from above and four crop marks at the corners, as if each page were a sheet in a file. The lamp is "being
/// seen": it fades out while connected (`lit` false) and comes back when the connection ends.
struct SpaceView:View {
    var lit=true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body:some View {
        GeometryReader {geo in
            let w=geo.size.width, h=geo.size.height
            ZStack {
                VeilbirdStyle.ground
                RadialGradient(stops:[.init(color:VeilbirdStyle.light.opacity(0.16),location:0),.init(color:VeilbirdStyle.light.opacity(0.04),location:0.5),.init(color:VeilbirdStyle.light.opacity(0),location:1)],
                               center:UnitPoint(x:0.5,y:-0.06),startRadius:0,endRadius:max(w,h*0.6))
                    .opacity(lit ? 1:0).animation(reduceMotion ? nil:.easeOut(duration:1.6),value:lit)
            }
        }.ignoresSafeArea()
        .overlay(CropMarks().stroke(VeilbirdStyle.light.opacity(0.26),lineWidth:1).padding(10))
        .accessibilityHidden(true).allowsHitTesting(false)
    }
}

/// Four corner marks, 12 pt long, inside the safe area.
struct CropMarks:Shape {
    func path(in rect:CGRect)->Path {
        var p=Path(); let l:CGFloat=12
        for (x,y,dx,dy) in [(rect.minX,rect.minY,1.0,1.0),(rect.maxX,rect.minY,-1.0,1.0),(rect.minX,rect.maxY,1.0,-1.0),(rect.maxX,rect.maxY,-1.0,-1.0)] {
            p.move(to:CGPoint(x:x+l*dx,y:y));p.addLine(to:CGPoint(x:x,y:y));p.addLine(to:CGPoint(x:x,y:y+l*dy))
        }
        return p
    }
}
