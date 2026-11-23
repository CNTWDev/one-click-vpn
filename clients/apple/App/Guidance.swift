import SwiftUI
import Network

/// What went wrong, said as the cause, the next step and the button that takes it (the second one is optional).
/// The same causes and buttons as Android (Guidance.kt) and Windows (Guidance.cs).
struct Trouble:Equatable {
    let title:String
    let detail:String
    let primary:String
    let primaryDo:String
    var secondary:String?=nil
    var secondaryDo:String?=nil
}

/// One row of the check shown under a failure: what was checked, what it found, and whether that step passed.
struct Check:Equatable,Hashable {
    enum Status {case ok,bad,skip}
    let key:String
    let label:String
    let value:String
    let status:Status
}

enum Guidance {
    /// [code]: why the last connection ended (an API code, HANDSHAKE_TIMEOUT, VPN_CONFIGURATION, SYSTEM_EXTENSION…).
    /// Actions: retry, devices, automatic, nodes, signin, settings, account, update.
    static func trouble(_ code:String,node:String,automatic:Bool,fallback:String,network:String="ok")->Trouble {
        let retry=L10n.text("retry_action")
        // The network explains a network failure first: no network at all outside the VPN.
        if failuresOfNetwork.contains(code) && network == "offline" {
            return Trouble(title:L10n.text("error_no_internet_title"),detail:L10n.text("error_no_internet_detail"),primary:L10n.text("open_network_settings"),primaryDo:"wifi",secondary:retry,secondaryDo:"retry")
        }
        let send=L10n.text("send_check_action")
        switch code {
        case "DEVICE_LIMIT_REACHED":
            return Trouble(title:L10n.text("error_device_title"),detail:L10n.text("error_device_detail"),primary:L10n.text("manage_devices_action"),primaryDo:"devices",secondary:retry,secondaryDo:"retry")
        case "HANDSHAKE_TIMEOUT":
            // Automatic already tried the fastest locations: the server answered, the lines did not.
            return automatic
                ? Trouble(title:L10n.text("error_lines_title"),detail:L10n.text("error_lines_detail"),primary:L10n.text("change_location_action"),primaryDo:"nodes",secondary:send,secondaryDo:"send")
                : Trouble(title:L10n.text("error_node_title",node),detail:L10n.text("error_node_detail"),primary:L10n.text("use_automatic_action"),primaryDo:"automatic",secondary:send,secondaryDo:"send")
        case "NODE_UNAVAILABLE","NODE_FULL":
            let title=L10n.text("error_node_title",node)
            return automatic
                ? Trouble(title:title,detail:L10n.text("error_node_auto_detail"),primary:retry,primaryDo:"retry",secondary:L10n.text("change_location_action"),secondaryDo:"nodes")
                : Trouble(title:title,detail:L10n.text("error_node_detail"),primary:L10n.text("use_automatic_action"),primaryDo:"automatic",secondary:L10n.text("change_location_action"),secondaryDo:"nodes")
        case "MEMBERSHIP_EXPIRED":
            return Trouble(title:L10n.text("error_expired_title"),detail:L10n.text("error_expired_detail"),primary:retry,primaryDo:"retry")
        case "QUOTA_EXHAUSTED":
            return Trouble(title:L10n.text("error_quota_title"),detail:L10n.text("error_quota_detail"),primary:retry,primaryDo:"retry")
        case "AUTH_REQUIRED":
            return Trouble(title:L10n.text("error_session_title"),detail:L10n.text("error_session_detail"),primary:L10n.text("sign_in_again_action"),primaryDo:"signin")
        case "VPN_CONFIGURATION":
            return Trouble(title:L10n.text("permission_needed_title"),detail:L10n.text("allow_vpn_configuration_short"),primary:retry,primaryDo:"retry")
        case "SYSTEM_EXTENSION":
            return Trouble(title:L10n.text("error_extension_title"),detail:L10n.text("error_extension_detail"),primary:L10n.text("open_system_settings"),primaryDo:"settings")
        case "DEVICE_REVOKED":
            return Trouble(title:L10n.text("error_revoked_title"),detail:L10n.text("error_revoked_detail"),primary:L10n.text("view_account_action"),primaryDo:"account")
        case "CLIENT_UPDATE_REQUIRED":
            return Trouble(title:L10n.text("error_update_title"),detail:L10n.text("error_update_detail"),primary:L10n.text("update_now"),primaryDo:"update")
        case "ACCESS_EXPIRED","LEASE_RENEWAL_FAILED":
            return Trouble(title:L10n.text("error_lease_title"),detail:L10n.text("error_lease_detail"),primary:L10n.text("connect_again_action"),primaryDo:"retry")
        case "ACCOUNT_UNAVAILABLE","MANAGED_ACCESS_REQUIRED","CLIENT_ACCESS_NOT_ENABLED":
            return Trouble(title:L10n.text("error_account_title"),detail:fallback,primary:retry,primaryDo:"retry")
        case "","CONNECT_FAILED":
            return Trouble(title:L10n.text("connect_failed_title"),detail:fallback,primary:retry,primaryDo:"retry",secondary:send,secondaryDo:"send")
        default:
            #if os(macOS)
            let detail=L10n.text("error_service_detail_desktop")
            #else
            let detail=L10n.text("error_service_detail")
            #endif
            return Trouble(title:L10n.text("error_service_title"),detail:detail,primary:retry,primaryDo:"retry")
        }
    }
    /// Failures the network itself can cause (no network then explains them better).
    static let failuresOfNetwork:Set<String>=["SERVICE_UNAVAILABLE","HANDSHAKE_TIMEOUT","CONNECT_FAILED",""]
    /// The four steps a connection takes (network, server, lines, tunnel) and where the last attempt stopped, for
    /// failures of the network itself; nil for a refusal of the account or the device, which has its own cause.
    static func checks(_ code:String,lines:Int,network:String)->[Check]? {
        let ok=L10n.text("diag_ok"),skip=L10n.text("diag_not_started")
        let labels=["network":L10n.text("diag_network"),"server":L10n.text("diag_server"),"lines":L10n.text("diag_lines"),"tunnel":L10n.text("diag_tunnel")]
        func row(_ key:String,_ value:String,_ status:Check.Status)->Check {Check(key:key,label:labels[key] ?? key,value:value,status:status)}
        let net=network == "offline" ? row("network",L10n.text("diag_no_internet"),.bad):row("network",ok,.ok)
        if net.status == .bad && failuresOfNetwork.contains(code) {return [net,row("server",skip,.skip),row("lines",skip,.skip),row("tunnel",skip,.skip)]}
        let reached=row("server",L10n.text("diag_reached"),.ok)
        switch code {
        case "SERVICE_UNAVAILABLE":return [net,row("server",L10n.text("diag_unreached"),.bad),row("lines",skip,.skip),row("tunnel",skip,.skip)]
        case "HANDSHAKE_TIMEOUT":return [net,reached,row("lines",lines>0 ? L10n.text("diag_lines_blocked",L10n.number(lines)):L10n.text("diag_all_blocked"),.bad),row("tunnel",skip,.skip)]
        case "VPN_CONFIGURATION","SYSTEM_EXTENSION":return [net,row("server",skip,.skip),row("lines",skip,.skip),row("tunnel",L10n.text("diag_no_permission"),.bad)]
        case "CONNECT_FAILED","":return [net,reached,row("lines",skip,.skip),row("tunnel",L10n.text("diag_tunnel_failed"),.bad)]
        default:return nil
        }
    }
    /// The check as one line for the report a person sends: "network=ok server=bad lines=skip tunnel=skip net=ok code=…".
    static func summary(_ code:String,lines:Int,network:String)->String {
        guard let rows=checks(code,lines:lines,network:network) else {return "code=\(code)"}
        return rows.map {"\($0.key)=\($0.status == .ok ? "ok":$0.status == .bad ? "bad":"skip")"}.joined(separator:" ")+" net=\(network) code=\(code.isEmpty ? "CONNECT_FAILED":code)"
    }
    /// The second line while connected over a line the network forced, or nil.
    static func bypass(_ value:String)->String? {
        if value.hasPrefix("udp:") {return L10n.text("bypass_udp",label(String(value.dropFirst(4))))}
        return value == "port" ? L10n.text("bypass_port"):nil
    }
    static func label(_ transport:String)->String {
        switch transport {
        case "hysteria2":return "Hysteria2"
        case "reality","reality-alt":return "REALITY"
        case "xhttp":return "XHTTP"
        case "wireguard":return "WireGuard"
        default:return transport
        }
    }
    /// "offline" when the device has no network outside the VPN (Wi-Fi, mobile data or Ethernet), else "ok".
    /// The monitor runs from the first call; an unvalidated network still counts as one (captive checks differ by network).
    static func networkState()->String {Transports.online(path.currentPath) ? "ok":"offline"}
    private static let path:NWPathMonitor={let monitor=NWPathMonitor();monitor.start(queue:DispatchQueue(label:"guidance.path"));return monitor}()
}

/// During the first run, on a page's § line: two squares (done, current, to come) and "n/2"; count+1 is "ready".
struct StepMarks:View {
    /// Sign in, then connect: the location starts on Automatic, so there is no step to choose one.
    static let count=2
    let step:Int
    var body:some View {
        let ready=step>StepMarks.count
        HStack(spacing:3) {
            ForEach(1...StepMarks.count,id:\.self) {i in
                Group {
                    if i<step {Rectangle().fill(VeilbirdStyle.text.opacity(0.75))}
                    else if i==step {Rectangle().fill(VeilbirdStyle.accent)}
                    else {Rectangle().fill(VeilbirdStyle.selected)}
                }.frame(width:6,height:6)
            }
            Text(verbatim:ready ? L10n.text("onboarding_ready"):L10n.number(step)+"/"+L10n.number(StepMarks.count))
                .font(.system(size:11,design:.monospaced)).foregroundStyle(ready ? VeilbirdStyle.accent:VeilbirdStyle.secondary).padding(.leading,4).lineLimit(1).fixedSize()
        }.accessibilityElement(children:.ignore).accessibilityLabel(Text(verbatim:ready ? L10n.text("onboarding_ready"):"\(step)/\(StepMarks.count)"))
    }
}

/// During the first run, the step on the right (two squares and "n/2"); afterwards nothing. [key] is kept for the
/// call sites but no longer shown: the § labels are gone.
struct SectionRow:View {
    let key:String
    let step:Int?
    var body:some View {
        HStack(spacing:8) {
            Spacer(minLength:0)
            if let step {StepMarks(step:step).padding(.trailing,4)}
        }
    }
}

/// A quiet amber-tinted note: what is about to happen, then what to do.
struct FirstNote:View {
    let title:String
    let detail:String
    var body:some View {
        HStack(alignment:.top,spacing:12) {
            Text(verbatim:"i").font(.system(size:11,weight:.semibold,design:.monospaced)).foregroundStyle(VeilbirdStyle.onAccent)
                .frame(width:18,height:18).background(VeilbirdStyle.accent,in:Circle()).padding(.top,1)
            VStack(alignment:.leading,spacing:2) {
                Text(title).font(.system(size:VeilbirdStyle.mac ? 12:13)).fixedSize(horizontal:false,vertical:true)
                Text(detail).font(.system(size:VeilbirdStyle.mac ? 11:12)).foregroundStyle(VeilbirdStyle.secondary).fixedSize(horizontal:false,vertical:true)
            }.frame(maxWidth:.infinity,alignment:.leading)
        }.padding(.horizontal,12).padding(.vertical,10)
        .background(VeilbirdStyle.accent.opacity(0.09),in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        .accessibilityElement(children:.combine)
    }
}

/// The hidden portrait's ring for each state (the same drawing as Android's Portrait and Windows' Portrait):
/// connecting, an arc that circles (1.4 s a turn); switching lines, one segment per line, the one being tried blinking;
/// reconnecting, a bright dot going round a ring of dim square dots (4 s a turn); offline, the dots rest; connected, a
/// steady glowing ring. Under Reduce Motion every loop rests on its first frame.
struct StateRing:View {
    let state:RingState
    let lines:Int
    let glow:Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body:some View {
        TimelineView(.animation(minimumInterval:1/30,paused:reduceMotion || ![RingState.connecting,.switching,.reconnecting].contains(state))) {context in
            let clock=reduceMotion ? 0:context.date.timeIntervalSinceReferenceDate
            Canvas {g,area in draw(g,area,clock)}
        }.accessibilityHidden(true)
    }
    /// The line being tried while switching, for the label inside the ring.
    static func current(lines:Int,at date:Date,still:Bool)->Int {still ? 0:Int(date.timeIntervalSinceReferenceDate/0.6)%max(lines,2)}
    private func draw(_ g:GraphicsContext,_ area:CGSize,_ clock:Double) {
        let s=min(area.width,area.height),c=CGPoint(x:area.width/2,y:area.height/2),r=s/2
        let accent=VeilbirdStyle.accent
        func arc(_ from:Double,_ sweep:Double)->Path {
            var p=Path();p.addArc(center:c,radius:r,startAngle:.degrees(from),endAngle:.degrees(from+sweep),clockwise:false);return p
        }
        switch state {
        case .connecting:
            g.stroke(Path(ellipseIn:CGRect(x:c.x-r,y:c.y-r,width:2*r,height:2*r)),with:.color(accent.opacity(0.16)),lineWidth:1)
            let head=clock == 0 ? 90:(clock/1.4).truncatingRemainder(dividingBy:1)*360
            for i in 0..<24 {
                g.stroke(arc(head-90-Double(i+1)*3,3.2),with:.color(accent.opacity(1-Double(i)/24)),lineWidth:i<2 ? 2:1.5)
            }
        case .switching:
            let n=max(lines,2),current=clock == 0 ? 0:Int(clock/0.6)%n
            let blink=clock == 0 ? 1:0.45+0.55*abs(sin(clock * .pi))
            for i in 0..<n {
                let start=360*Double(i)/Double(n)-90+4.5,sweep=360/Double(n)-9
                if i<current {g.stroke(arc(start,sweep),with:.color(VeilbirdStyle.fair.opacity(0.6)),lineWidth:1.5)}
                else if i==current {
                    g.stroke(arc(start,sweep),with:.color(accent.opacity(0.18*blink)),lineWidth:7)
                    g.stroke(arc(start,sweep),with:.color(accent.opacity(blink)),lineWidth:2)
                } else {g.stroke(arc(start,sweep),with:.color(accent.opacity(0.16)),lineWidth:1)}
            }
        case .reconnecting,.waiting:
            let n=64,head=state == .reconnecting && clock>0 ? Int((clock/4).truncatingRemainder(dividingBy:1)*Double(n)):-99
            for i in 0..<n {
                let gap=(head-i+n)%n
                var a=state == .waiting ? 0.2:0.28
                if head>=0 && gap<8 {a=max(a,1-Double(gap)/8)}
                let angle=(360*Double(i)/Double(n)-90) * .pi/180
                let x=c.x+r*cos(angle),y=c.y+r*sin(angle)
                g.fill(Path(CGRect(x:x-1.3,y:y-1.3,width:2.6,height:2.6)),with:.color(accent.opacity(a)))
            }
        default:
            let ring=Path(ellipseIn:CGRect(x:c.x-r,y:c.y-r,width:2*r,height:2*r))
            g.stroke(ring,with:.color(accent.opacity(0.11*glow)),lineWidth:8)
            g.stroke(ring,with:.color(accent.opacity(0.22*glow)),lineWidth:3)
            g.stroke(ring,with:.color(accent.opacity(glow)),lineWidth:1)
        }
    }
}

/// The words for each state, shared by the window and the menu bar.
extension ClientModel {
    var stateTitle:String {
        switch ringState {
        case .connected:return L10n.text("sealed_status")
        case .connecting,.switching:return L10n.text("hiding_status")
        case .reconnecting:return L10n.text("reconnecting_title")
        case .waiting:return L10n.text("waiting_title")
        case .failed:return trouble?.title ?? L10n.text("connect_failed_title")
        case .idle:return L10n.text("exposed_status")
        }
    }
    var stateDetail:String {
        switch ringState {
        case .connected:return L10n.text("seen_as",nodeName)+(Guidance.bypass(bypass).map {"\n"+$0} ?? "")
        case .connecting:return L10n.text("finding_best_route")
        case .switching:return L10n.text("switching_detail")
        case .reconnecting:return L10n.text(status == "location_retrying" ? "location_retrying":"reconnecting_detail")
        case .waiting:return L10n.text("waiting_detail")
        case .failed:return trouble?.detail ?? failure
        case .idle:
            if update?.mandatory == true {return L10n.text("update_required_detail")}
            return visitorIP.map {L10n.text("exposed_ip",$0)} ?? L10n.text("exposed_plain")
        }
    }
    var actionLabel:String {
        switch ringState {
        case .idle:return L10n.text("seal_action")
        case .connecting:return L10n.text("cancel")
        case .failed:return trouble?.primary ?? L10n.text("retry_action")
        default:return L10n.text("unseal_action")
        }
    }
    /// Inside the hidden portrait: the phase while connecting, the countdown while reconnecting, a dash while offline.
    func portraitCentre(_ state:RingState,now:Date)->String {
        switch state {
        case .connecting:return phaseText
        case .reconnecting:return Duration.seconds(countdown(now)).formatted(.time(pattern:.minuteSecond))
        case .waiting:return "—"
        default:return ""
        }
    }
    /// Under it: the rates once connected, the attempt while reconnecting.
    func portraitSub(_ state:RingState,rates:String)->String {
        switch state {
        case .connected:return rates
        case .reconnecting:return retries>0 ? L10n.text("attempt_n",L10n.number(retries)):""
        case .waiting:return L10n.text("offline_centre")
        default:return ""
        }
    }
}
