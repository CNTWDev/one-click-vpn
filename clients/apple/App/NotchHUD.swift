#if os(macOS)
import SwiftUI
import AppKit
import Combine

/// The connection at the very top of the screen. While connecting, a black capsule grows out of the notch with a
/// spinner on its left and the destination on its right. When the connection lands it opens once into a small card
/// (the route, "Arrived", the city, the distance) for about two seconds, then shrinks back to two ears beside the
/// notch: an amber dot and the country code, which stay while connected. Hovering over the ears opens the card
/// again. When automatic mode moves to another location, the card says so. Macs without a notch (and external
/// displays) get the same capsule dropping from the top centre of the main screen. Not shown over full-screen apps
/// (the panel does not join full-screen spaces); turned off under 我的 → "Status at the top of the screen".
@MainActor final class NotchHUD:ObservableObject {
    static let shared=NotchHUD()
    static let preferenceKey="notchHUD"
    static var enabled:Bool {UserDefaults.standard.object(forKey:preferenceKey) as? Bool ?? true}

    enum Mode:Equatable {
        case hidden
        case connecting(String)
        case card(kicker:String,title:String,detail:String)
        case resting(code:String,title:String,detail:String)
    }
    @Published private(set) var mode:Mode = .hidden
    @Published private(set) var hover=false
    /// The notch's size on the main screen; width 0 when it has none (height is then the menu bar's).
    @Published private(set) var notch=CGSize(width:0,height:24)

    private weak var model:ClientModel?
    private var panel:NSPanel?
    private var watch:AnyCancellable?
    private var screens:NSObjectProtocol?
    private var monitors:[Any]=[]
    private var last:RingState = .idle
    /// The location the current connection landed on ("" when not connected yet).
    private var landedNode=""
    private var settle:DispatchWorkItem?
    private var hideLater:DispatchWorkItem?

    static let width:CGFloat=460
    static let extra:CGFloat=110

    func attach(_ model:ClientModel) {
        guard self.model == nil else {return}
        self.model=model
        // objectWillChange fires before the change; looking on the next turn of the run loop sees the new values.
        watch=model.objectWillChange.receive(on:RunLoop.main).sink {[weak self] _ in self?.refresh()}
        screens=NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main) {[weak self] _ in
            Task {@MainActor in self?.layout()}
        }
        refresh()
    }

    // MARK: state

    /// Looks at the model again (also after the setting changes).
    func refresh() {
        guard let model else {return}
        let state=model.ringState
        let node=model.connectedNodeId
        defer {last=state}
        guard Self.enabled else {landedNode=node;show(.hidden);return}
        let name=Self.name(model)
        switch state {
        case .connecting,.switching:
            if landedNode.isEmpty {show(.connecting(name))}
        case .connected:
            let landing=last == .connecting || last == .switching
            if landedNode.isEmpty && landing {
                landedNode=node;flash(L10n.text("notch_arrived"),model)
            } else if !landedNode.isEmpty && !node.isEmpty && node != landedNode {
                landedNode=node;flash(L10n.text("notch_switched"),model)
            } else {
                if landedNode.isEmpty {landedNode=node}
                if case .card=mode {return}
                show(Self.resting(model))
            }
        case .reconnecting,.waiting:
            // Still on (or about to be): the ears stay as they are.
            if mode == .hidden && !landedNode.isEmpty {show(Self.resting(model))}
        case .idle,.failed:
            landedNode="";show(.hidden)
        }
    }
    /// The card for about two seconds, then the ears.
    private func flash(_ kicker:String,_ model:ClientModel) {
        show(.card(kicker:kicker,title:Self.name(model),detail:model.globeDistance))
        settle?.cancel()
        let work=DispatchWorkItem {[weak self] in
            Task {@MainActor in
                guard let self,let model=self.model,model.ringState != .idle,model.ringState != .failed else {return}
                self.show(Self.resting(model))
            }
        }
        settle=work
        DispatchQueue.main.asyncAfter(deadline:.now()+2.1,execute:work)
    }
    private static func name(_ model:ClientModel)->String {
        if !model.nodeName.isEmpty {return model.nodeName}
        return model.selectedName.isEmpty ? L10n.text("automatic"):model.selectedName
    }
    private static func resting(_ model:ClientModel)->Mode {
        let name=Self.name(model)
        return .resting(code:model.code(model.connectedNodeId,name:name),title:name,detail:model.globeDistance)
    }

    // MARK: window

    private func show(_ next:Mode) {
        guard next != mode else {return}
        hideLater?.cancel()
        if next == .hidden {
            mode = .hidden;hover=false
            // After the capsule has shrunk back into the notch.
            let work=DispatchWorkItem {[weak self] in Task {@MainActor in if self?.mode == .hidden {self?.panel?.orderOut(nil)}}}
            hideLater=work
            DispatchQueue.main.asyncAfter(deadline:.now()+0.5,execute:work)
            return
        }
        let panel=ensurePanel()
        if !panel.isVisible {layout();panel.orderFrontRegardless()}
        mode=next
    }
    private func ensurePanel()->NSPanel {
        if let panel {return panel}
        let panel=NSPanel(contentRect:NSRect(x:0,y:0,width:Self.width,height:Self.extra+32),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:true)
        panel.isOpaque=false
        panel.backgroundColor = .clear
        panel.hasShadow=false
        panel.level = .statusBar
        // Clicks go to whatever is under it; hovering is watched with event monitors instead.
        panel.ignoresMouseEvents=true
        panel.collectionBehavior=[.canJoinAllSpaces,.stationary,.ignoresCycle]
        panel.isReleasedWhenClosed=false
        panel.hidesOnDeactivate=false
        panel.contentView=NSHostingView(rootView:NotchView(hud:self))
        self.panel=panel
        let moved:(NSEvent)->Void={[weak self] _ in Task {@MainActor in self?.track()}}
        if let global=NSEvent.addGlobalMonitorForEvents(matching:.mouseMoved,handler:moved) {monitors.append(global)}
        if let local=NSEvent.addLocalMonitorForEvents(matching:.mouseMoved,handler:{event in moved(event);return event}) {monitors.append(local)}
        return panel
    }
    /// Sits at the top centre of the main screen (the one with the menu bar).
    private func layout() {
        guard let screen=NSScreen.screens.first else {return}
        notch=Self.notchSize(screen)
        let height=notch.height+Self.extra
        panel?.setFrame(NSRect(x:screen.frame.midX-Self.width/2,y:screen.frame.maxY-height,width:Self.width,height:height),display:true)
    }
    private static func notchSize(_ screen:NSScreen)->CGSize {
        let top=screen.safeAreaInsets.top
        guard top>0,let left=screen.auxiliaryTopLeftArea,let right=screen.auxiliaryTopRightArea else {
            return CGSize(width:0,height:NSStatusBar.system.thickness)
        }
        return CGSize(width:screen.frame.width-left.width-right.width,height:top)
    }
    /// Hovering over the ears opens the card; leaving closes it.
    private func track() {
        guard case .resting=mode,let screen=NSScreen.screens.first else {if hover {hover=false};return}
        let point=NSEvent.mouseLocation
        let earsWidth=NotchView.restingWidth(notch)
        let over=abs(point.x-screen.frame.midX)<earsWidth/2 && point.y>screen.frame.maxY-notch.height-(hover ? Self.extra-14:0)
        if over != hover {hover=over}
    }
}

/// Black, flush with the top edge, rounded at the bottom: it reads as the notch growing.
private struct NotchShape:Shape {
    var radius:CGFloat
    var animatableData:CGFloat {get {radius} set {radius=newValue}}
    func path(in rect:CGRect)->Path {
        let r=min(radius,rect.height/2,rect.width/2)
        var path=Path()
        path.move(to:CGPoint(x:rect.minX,y:rect.minY))
        path.addLine(to:CGPoint(x:rect.maxX,y:rect.minY))
        path.addLine(to:CGPoint(x:rect.maxX,y:rect.maxY-r))
        path.addQuadCurve(to:CGPoint(x:rect.maxX-r,y:rect.maxY),control:CGPoint(x:rect.maxX,y:rect.maxY))
        path.addLine(to:CGPoint(x:rect.minX+r,y:rect.maxY))
        path.addQuadCurve(to:CGPoint(x:rect.minX,y:rect.maxY-r),control:CGPoint(x:rect.minX,y:rect.maxY))
        path.closeSubpath()
        return path
    }
}

struct NotchView:View {
    @ObservedObject var hud:NotchHUD
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func restingWidth(_ notch:CGSize)->CGFloat {max(notch.width,140)+112}
    private static func connectingWidth(_ notch:CGSize)->CGFloat {max(notch.width,140)+180}
    private static let cardWidth:CGFloat=400
    private static let cardHeight:CGFloat=96

    private var expanded:Bool {
        if case .card=hud.mode {return true}
        if case .resting=hud.mode {return hud.hover}
        return false
    }
    private var size:CGSize {
        let notch=hud.notch
        if expanded {return CGSize(width:Self.cardWidth,height:notch.height+Self.cardHeight)}
        switch hud.mode {
        case .hidden:return CGSize(width:notch.width>0 ? notch.width:120,height:notch.width>0 ? notch.height:0)
        case .connecting:return CGSize(width:Self.connectingWidth(notch),height:notch.height)
        default:return CGSize(width:Self.restingWidth(notch),height:notch.height)
        }
    }
    var body:some View {
        let size=self.size
        let shown=hud.mode != .hidden || hud.notch.width>0
        ZStack(alignment:.top) {
            NotchShape(radius:expanded ? 22:12).fill(Color.black)
            content.frame(width:size.width,height:size.height,alignment:.top).clipped()
        }
        .frame(width:size.width,height:size.height)
        .opacity(shown ? 1:0)
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
        .animation(reduceMotion ? .easeInOut(duration:0.2):.spring(response:0.42,dampingFraction:0.82),value:hud.mode)
        .animation(reduceMotion ? .easeInOut(duration:0.2):.spring(response:0.36,dampingFraction:0.85),value:hud.hover)
        .environment(\.colorScheme,.dark)
    }
    @ViewBuilder private var content:some View {
        VStack(spacing:0) {
            ears.frame(height:hud.notch.height)
            if expanded {card.transition(.opacity)}
        }
    }
    @ViewBuilder private var ears:some View {
        HStack(spacing:0) {
            switch hud.mode {
            case .connecting(let name):
                Spinner().frame(width:14,height:14)
                Spacer(minLength:hud.notch.width+8)
                Text(verbatim:name).font(.system(size:12,weight:.medium)).foregroundColor(VeilbirdStyle.secondary).lineLimit(1)
            case .resting(let code,_,_) where !expanded:
                Rectangle().fill(VeilbirdStyle.accent).frame(width:7,height:7).shadow(color:VeilbirdStyle.accent.opacity(0.8),radius:4)
                Spacer(minLength:hud.notch.width+8)
                Text(verbatim:code).font(.system(size:12,weight:.semibold,design:.monospaced)).foregroundColor(VeilbirdStyle.accent).lineLimit(1)
            default:
                Spacer(minLength:0)
            }
        }
        .padding(.horizontal,16)
        .transition(.opacity)
    }
    @ViewBuilder private var card:some View {
        let (kicker,title,detail)=texts
        HStack(spacing:18) {
            RouteArc().frame(width:112,height:52)
            VStack(alignment:.leading,spacing:3) {
                Text(verbatim:kicker.uppercased()).font(.system(size:10,weight:.medium,design:.monospaced)).tracking(1).foregroundColor(VeilbirdStyle.faint).lineLimit(1)
                Text(verbatim:title).font(.system(size:22,weight:.semibold)).foregroundColor(VeilbirdStyle.accent).lineLimit(1).minimumScaleFactor(0.7)
                if !detail.isEmpty {Text(verbatim:detail).font(.system(size:11,design:.monospaced)).foregroundColor(VeilbirdStyle.secondary).lineLimit(1)}
            }
            Spacer(minLength:0)
        }
        .padding(.horizontal,22).padding(.bottom,14).frame(height:Self.cardHeight)
    }
    private var texts:(String,String,String) {
        switch hud.mode {
        case .card(let kicker,let title,let detail):return (kicker,title,detail)
        case .resting(_,let title,let detail):return (L10n.text("connection_connected"),title,detail)
        default:return ("","","")
        }
    }
}

/// A short turning arc: the "connecting" mark in the left ear.
private struct Spinner:View {
    @State private var turn=false
    var body:some View {
        Circle().trim(from:0.15,to:0.85)
            .stroke(VeilbirdStyle.light,style:StrokeStyle(lineWidth:2,lineCap:.round))
            .rotationEffect(.degrees(turn ? 360:0))
            .onAppear {withAnimation(.linear(duration:0.9).repeatForever(autoreverses:false)) {turn=true}}
    }
}

/// The route in miniature: square dots from you (left) to the exit (right) along an arc, brighter towards the exit.
private struct RouteArc:View {
    var body:some View {
        Canvas {g,size in
            let start=CGPoint(x:8,y:size.height-8)
            let end=CGPoint(x:size.width-10,y:size.height-8)
            Self.glow(g,end)
            let count=24
            for i in 0...count {
                let t=Double(i)/Double(count)
                let p=Self.point(t,start,end,lift:size.height-14)
                let alpha=0.35+0.65*t
                g.fill(Path(CGRect(x:p.x-1.4,y:p.y-1.4,width:2.8,height:2.8)),with:.color(VeilbirdStyle.accent.opacity(alpha)))
            }
            g.fill(Path(CGRect(x:start.x-3,y:start.y-3,width:6,height:6)),with:.color(VeilbirdStyle.text.opacity(0.9)))
            g.fill(Path(CGRect(x:end.x-3.5,y:end.y-3.5,width:7,height:7)),with:.color(VeilbirdStyle.light))
        }
    }
    private static func point(_ t:Double,_ a:CGPoint,_ b:CGPoint,lift:CGFloat)->CGPoint {
        let x=a.x+(b.x-a.x)*CGFloat(t)
        let y=a.y-lift*CGFloat(sin(Double.pi*t))
        return CGPoint(x:x,y:y)
    }
    private static func glow(_ g:GraphicsContext,_ at:CGPoint) {
        let rect=CGRect(x:at.x-16,y:at.y-16,width:32,height:32)
        let shading=GraphicsContext.Shading.radialGradient(Gradient(colors:[VeilbirdStyle.accent.opacity(0.7),VeilbirdStyle.accent.opacity(0)]),center:at,startRadius:0,endRadius:16)
        g.fill(Path(ellipseIn:rect),with:shading)
        g.stroke(Path(ellipseIn:rect.insetBy(dx:5,dy:5)),with:.color(VeilbirdStyle.accent.opacity(0.5)),lineWidth:1)
    }
}
#endif
