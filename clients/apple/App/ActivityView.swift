import SwiftUI

/// The activity view: open connections, where this connection's traffic went (by site and by rule), proxied vs
/// direct per hour, and the names looked up. The tunnel's core keeps it in memory while connected and forgets it on
/// disconnect; nothing is stored or sent. The Mac shows it as a panel beside the app with four views; the phone as
/// its own tab with connections and the ranking.
struct ActivityView:View {
    @EnvironmentObject private var model:ClientModel
    @State private var tab="conns"
    @State private var filter="all"
    @State private var query=""
    /// The connection whose route the "why" panel explains.
    @State private var why:[String:Any]?
    /// The last quick rule: what it says and the rules text before it (undo).
    @State private var toast:(text:String,before:String?)?
    @State private var toastTask:Task<Void,Never>?
    private let mac=VeilbirdStyle.mac
    private static let direct=Color(red:97/255,green:90/255,blue:80/255)
    private static let row=Color(red:26/255,green:24/255,blue:22/255)
    private static let line=Color(red:36/255,green:34/255,blue:30/255)
    private static let card=Color(red:21/255,green:19/255,blue:17/255)
    private static let dim=Color(red:126/255,green:117/255,blue:105/255)

    private var data:[String:Any]? {model.since == nil ? nil:model.activity}
    private var conns:[[String:Any]] {data?["conns"] as? [[String:Any]] ?? []}

    var body:some View {
        VStack(alignment:.leading,spacing:mac ? 14:12) {
            header
            if data == nil {
                Spacer()
                Text(L10n.text("activity_empty")).font(.system(size:VeilbirdStyle.detail)).foregroundStyle(VeilbirdStyle.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth:320).frame(maxWidth:.infinity)
                Spacer()
            } else {
                switch tab {
                case "rank":ranking
                case "hours":hours
                case "dns":lookups
                default:connections
                }
            }
        }
        .padding(.horizontal,mac ? 24:16).padding(.top,mac ? 16:8).padding(.bottom,mac ? 16:0)
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
        .overlay(alignment:.bottom) {if let toast {toastView(toast)}}
        .onChange(of:model.since) {_ in why=nil}
        .task(id:model.since) {
            // Once a second while connected; the view going away stops it. Not connected there is nothing to ask
            // (the task starts again when the connection is confirmed).
            if model.since == nil {await model.loadActivity();return}
            while !Task.isCancelled {
                await model.loadActivity()
                try? await Task.sleep(nanoseconds:1_000_000_000)
            }
        }
    }

    // MARK: Header: title, the views, and the privacy line
    private var tabs:[(String,String)] {
        mac ? [("conns","activity_connections"),("rank","activity_ranking"),("hours","activity_traffic"),("dns","activity_dns")]
            :[("conns","activity_connections"),("rank","activity_ranking")]
    }
    private var tabButtons:some View {
        HStack(spacing:2) {
            ForEach(tabs,id:\.0) {item in
                let selected=tab==item.0
                Button {tab=item.0} label:{
                    HStack(spacing:6) {
                        Text(L10n.text(item.1)).font(.system(size:13)).lineLimit(1)
                        if item.0=="conns" && data != nil {Text(L10n.number(conns.count)).font(.system(size:11,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary)}
                    }
                    .foregroundStyle(selected ? VeilbirdStyle.text:VeilbirdStyle.secondary)
                    .padding(.horizontal,14).frame(maxWidth:mac ? nil:.infinity).frame(height:mac ? 28:30)
                    .background(selected ? Color(red:48/255,green:45/255,blue:40/255):Color.clear,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
                    .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
            }
        }.padding(2).background(Color(red:23/255,green:21/255,blue:19/255),in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }
    private var privacy:some View {
        HStack(spacing:6) {
            Rectangle().fill(VeilbirdStyle.past).frame(width:6,height:6)
            Text(L10n.text("activity_local_only")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.faint).lineLimit(1)
        }
    }
    @ViewBuilder private var header:some View {
        if mac {
            HStack(spacing:16) {
                Text(L10n.text("activity_title")).font(.system(size:17,weight:.semibold)).accessibilityAddTraits(.isHeader)
                tabButtons
                Spacer(minLength:12)
                privacy
            }
        } else {
            VStack(alignment:.leading,spacing:4) {
                SectionLabel(key:"section_activity").padding(.horizontal,-4)
                Text(L10n.text("activity_title")).font(.system(size:30,weight:.light)).accessibilityAddTraits(.isHeader)
                privacy
            }.padding(.horizontal,4)
            tabButtons
        }
    }

    // MARK: Connections
    private func exit(_ c:[String:Any])->String {
        flag(c["proxy"]) ? (model.nodeName.isEmpty ? (c["via"] as? String ?? ""):model.nodeName):L10n.text("activity_direct")
    }
    private var shown:[[String:Any]] {
        let q=query.trimmingCharacters(in:.whitespaces)
        return conns.filter {c in
            (filter=="all" || flag(c["proxy"])==(filter=="proxy"))
                && (q.isEmpty || [c["host"] as? String ?? "",c["rule"] as? String ?? "",exit(c)].contains {$0.localizedCaseInsensitiveContains(q)})
        }.prefix(100).map {$0}
    }
    private var chips:some View {
        let proxied=conns.filter {flag($0["proxy"])}.count
        return HStack(spacing:mac ? 6:8) {
            chip("all",L10n.text("activity_all"),conns.count,nil)
            chip("proxy",L10n.text("activity_proxy"),proxied,VeilbirdStyle.accent)
            chip("direct",L10n.text("activity_direct"),conns.count-proxied,Self.direct)
        }
    }
    private func chip(_ key:String,_ title:String,_ count:Int,_ color:Color?)->some View {
        let selected=filter==key
        return Button {filter=key} label:{
            HStack(spacing:6) {
                if let color {Rectangle().fill(color).frame(width:6,height:6)}
                Text(title).font(.system(size:mac ? 12:13))
                Text(L10n.number(count)).font(.system(size:11,design:.monospaced))
            }
            .foregroundStyle(selected ? VeilbirdStyle.text:VeilbirdStyle.secondary)
            .padding(.horizontal,mac ? 10:12).frame(height:mac ? 26:30)
            .background(selected ? VeilbirdStyle.selected:Self.card,in:RoundedRectangle(cornerRadius:VeilbirdStyle.mac ? 7:9))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected:[])
    }
    private var connections:some View {
        VStack(alignment:.leading,spacing:mac ? 10:6) {
            HStack {
                chips
                Spacer(minLength:12)
                if mac {
                    HStack(spacing:8) {
                        Image(systemName:"magnifyingglass").font(.system(size:11)).foregroundStyle(VeilbirdStyle.faint)
                        TextField(L10n.text("activity_filter"),text:$query).textFieldStyle(.plain).font(.system(size:12))
                    }.padding(.horizontal,10).frame(width:220,height:28)
                    .background(Self.card,in:RoundedRectangle(cornerRadius:7))
                }
            }
            if mac {
                HStack(spacing:12) {
                    Text(L10n.text("activity_domain")).padding(.leading,16).frame(maxWidth:.infinity,alignment:.leading)
                    Text(L10n.text("activity_rule")).frame(width:150,alignment:.leading)
                    Text(L10n.text("activity_out")).frame(width:76,alignment:.leading)
                    Text(L10n.text("activity_down")).frame(width:76,alignment:.trailing)
                    Text(L10n.text("activity_duration")).frame(width:52,alignment:.trailing)
                }.font(.system(size:11)).foregroundStyle(VeilbirdStyle.faint).lineLimit(1).frame(height:30)
                .overlay(alignment:.bottom) {Rectangle().fill(Self.line).frame(height:1)}
            }
            ScrollView {
                LazyVStack(spacing:0) {
                    ForEach(Array(shown.enumerated()),id:\.offset) {_,c in connectionRow(c)}
                    if shown.isEmpty {Text(L10n.text("activity_nothing")).font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary).frame(maxWidth:.infinity,alignment:.leading).padding(.top,16)}
                }
            }
            // The row as it is now (the list changes every second), or as last seen once it closed.
            if let why {whyPanel(conns.first {($0["id"] as? String)==(why["id"] as? String)} ?? why)}
        }
    }
    private func connectionRow(_ c:[String:Any])->some View {
        rowBody(c).contentShape(Rectangle())
            .onTapGesture {why=(why?["id"] as? String)==(c["id"] as? String) ? nil:c}
            .contextMenu {menu(c)}
    }
    @ViewBuilder private func rowBody(_ c:[String:Any])->some View {
        let proxy=flag(c["proxy"]),rate=int(c["rate"])
        if mac {
            HStack(spacing:12) {
                HStack(spacing:10) {
                    dot(proxy)
                    Text(c["host"] as? String ?? "").font(.system(size:13)).lineLimit(1).truncationMode(.middle)
                }.frame(maxWidth:.infinity,alignment:.leading)
                Text(c["rule"] as? String ?? "").font(.system(size:12,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1).frame(width:150,alignment:.leading)
                Text(exit(c)).font(.system(size:13)).foregroundStyle(proxy ? VeilbirdStyle.text:VeilbirdStyle.secondary).lineLimit(1).frame(width:76,alignment:.leading)
                Text(Self.rate(rate)).font(.system(size:12,design:.monospaced)).foregroundStyle(rate>0 ? VeilbirdStyle.text:Self.dim).lineLimit(1).frame(width:76,alignment:.trailing)
                Text(Self.elapsed(int(c["start"]))).font(.system(size:12,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1).frame(width:52,alignment:.trailing)
            }.frame(height:36).overlay(alignment:.bottom) {Rectangle().fill(Self.row).frame(height:1)}
        } else {
            HStack(spacing:12) {
                dot(proxy)
                VStack(alignment:.leading,spacing:3) {
                    Text(c["host"] as? String ?? "").font(.system(size:15)).lineLimit(1).truncationMode(.middle)
                    (Text(c["rule"] as? String ?? "").font(.system(size:12,design:.monospaced))+Text(" → ")+Text(exit(c)).foregroundColor(proxy ? VeilbirdStyle.text:VeilbirdStyle.secondary))
                        .font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)
                }
                Spacer(minLength:8)
                Text(Self.rate(rate)).font(.system(size:12,design:.monospaced)).foregroundStyle(rate>0 ? VeilbirdStyle.text:Self.dim).lineLimit(1)
            }.padding(.horizontal,4).frame(minHeight:58).overlay(alignment:.bottom) {Rectangle().fill(Self.row).frame(height:1)}
        }
    }

    // MARK: The row's menu (right click on the Mac, long press on the phone) and the "why" panel
    @ViewBuilder private func menu(_ c:[String:Any])->some View {
        let host=c["host"] as? String ?? "",id=c["id"] as? String ?? ""
        Text(host)
        if Advanced.enabled && !host.isEmpty {
            ruleItem("menu_always_proxy","proxy",host)
            ruleItem("menu_always_direct","direct",host)
            ruleItem("menu_block","block",host)
            Divider()
        }
        Button(L10n.text("menu_copy_domain")) {copy(host)}.disabled(host.isEmpty)
        if !id.isEmpty {Button(L10n.text("menu_close_connection")) {Task {await model.closeConnection(id)}}}
        Button(L10n.text("menu_why")) {why=c}
    }
    /// One rule choice: for a host under a site, a submenu picks the whole site or only this name.
    @ViewBuilder private func ruleItem(_ key:String,_ policy:String,_ host:String)->some View {
        let site=Advanced.site(host)
        if site != host {
            Menu(L10n.text(key)) {
                Button(L10n.text("menu_whole_site",site)) {addRule(site,site:true,policy)}
                Button(L10n.text("menu_only_domain",host)) {addRule(host,site:false,policy)}
            }
        } else {
            Button(L10n.text(key)) {addRule(host,site:true,policy)}
        }
    }
    private func addRule(_ name:String,site whole:Bool,_ policy:String) {
        let before=Advanced.setQuickRule(name,site:whole,policy:policy)
        Task {
            let live=await model.applyRules(closing:name,site:whole)
            show(L10n.text(live ? "rule_added":"rule_added_later",name,L10n.text(policy=="direct" ? "policy_direct":policy=="block" ? "policy_block":"policy_proxy")),before:before)
        }
    }
    private func show(_ text:String,before:String?) {
        toastTask?.cancel()
        withAnimation(.easeOut(duration:0.18)) {toast=(text,before)}
        toastTask=Task {
            try? await Task.sleep(nanoseconds:6_000_000_000)
            if !Task.isCancelled {withAnimation(.easeIn(duration:0.18)) {toast=nil}}
        }
    }
    private func toastView(_ toast:(text:String,before:String?))->some View {
        HStack(spacing:14) {
            Text(toast.text).font(.system(size:13)).lineLimit(2).fixedSize(horizontal:false,vertical:true)
            if let before=toast.before {
                Button {
                    Advanced.rulesText=before
                    Task {_ = await model.applyRules()}
                    show(L10n.text("rule_undone"),before:nil)
                } label:{Text(L10n.text("rule_undo")).font(.system(size:13,weight:.semibold)).foregroundStyle(VeilbirdStyle.accent)}.buttonStyle(.plain)
            }
        }
        .padding(.horizontal,16).padding(.vertical,10)
        .background(Color(red:44/255,green:41/255,blue:37/255),in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
        .padding(.bottom,mac ? 4:12).padding(.horizontal,mac ? 0:4)
        .transition(.opacity.combined(with:.offset(y:6)))
    }
    private func copy(_ text:String) {
        #if os(iOS)
        UIPasteboard.general.string=text
        #else
        NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string)
        #endif
        show(L10n.text("menu_copied"),before:nil)
    }
    /// Which rule sent the connection where it went: a short name for the path, and one sentence.
    private func reason(_ c:[String:Any])->(chip:String,line:String) {
        let rule=c["rule"] as? String ?? "",proxy=flag(c["proxy"])
        if flag(c["mine"]) {return (L10n.text("why_mine"),L10n.text("why_mine_line",rule))}
        switch rule {
        case "RULE-SET,ai":return (L10n.text("why_ai"),L10n.text("why_ai_line"))
        case "RULE-SET,cn_domain","RULE-SET,cn_ip":return (L10n.text("why_cn"),L10n.text("why_cn_line"))
        case "RULE-SET,private_domain":return (L10n.text("why_local"),L10n.text("why_local_line"))
        case "MATCH":return (L10n.text("why_rest"),L10n.text(proxy ? "why_rest_proxy":"why_rest_direct"))
        default:
            if rule.hasPrefix("IP-CIDR,") {return (L10n.text("why_local"),L10n.text("why_local_line"))}
            if rule.hasPrefix("PROCESS-NAME,") {return (L10n.text("why_app"),L10n.text("why_app_line"))}
            return (rule.isEmpty ? "—":rule,"")
        }
    }
    private func pathChip(_ text:String,lit:Bool=false,mono:Bool=false)->some View {
        Text(text).font(mono ? .system(size:12,design:.monospaced):.system(size:12)).lineLimit(1)
            .foregroundStyle(lit ? VeilbirdStyle.text:VeilbirdStyle.secondary)
            .padding(.horizontal,10).frame(height:26)
            .background(lit ? VeilbirdStyle.selected:Color(red:32/255,green:30/255,blue:27/255),in:RoundedRectangle(cornerRadius:7))
    }
    private func whyPanel(_ c:[String:Any])->some View {
        let host=c["host"] as? String ?? "",proxy=flag(c["proxy"]),via=c["via"] as? String ?? ""
        let (chip,line)=reason(c)
        let arrow=Text("→").font(.system(size:12)).foregroundStyle(VeilbirdStyle.faint)
        let steps=Group {
            pathChip(chip,lit:true)
            arrow
            pathChip(L10n.text(proxy ? "activity_proxy":"activity_direct"))
            if proxy {
                arrow
                pathChip(exit(c))
                if !via.isEmpty && via != exit(c) {arrow;pathChip(via,mono:true)}
            }
        }
        return VStack(alignment:.leading,spacing:10) {
            HStack(spacing:8) {
                Text(L10n.text("menu_why")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)
                Spacer(minLength:8)
                Button {why=nil} label:{Image(systemName:"xmark").font(.system(size:11,weight:.semibold)).foregroundStyle(VeilbirdStyle.secondary).frame(width:24,height:24).contentShape(Rectangle())}
                    .buttonStyle(.plain).accessibilityLabel(L10n.text("close"))
            }
            Text(host).font(.system(size:14,weight:.semibold)).lineLimit(1).truncationMode(.middle)
            ViewThatFits(in:.horizontal) {
                HStack(spacing:6) {steps}
                VStack(alignment:.leading,spacing:6) {HStack(spacing:6) {pathChip(chip,lit:true);arrow;pathChip(L10n.text(proxy ? "activity_proxy":"activity_direct"))}
                    if proxy {HStack(spacing:6) {arrow;pathChip(exit(c))}}}
            }
            if !line.isEmpty {Text(line).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).fixedSize(horizontal:false,vertical:true)}
            if Advanced.enabled && !host.isEmpty {
                HStack(spacing:8) {
                    Button {addRule(Advanced.site(host),site:true,proxy ? "direct":"proxy")} label:{
                        Text(L10n.text(proxy ? "why_make_direct":"why_make_proxy")).font(.system(size:12,weight:.semibold)).foregroundStyle(VeilbirdStyle.onAccent)
                            .padding(.horizontal,12).frame(height:28).background(VeilbirdStyle.accent,in:RoundedRectangle(cornerRadius:7))
                    }.buttonStyle(.plain)
                    Button {model.rulesShown+=1} label:{
                        Text(L10n.text("why_open_rules")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.text)
                            .padding(.horizontal,12).frame(height:28).background(VeilbirdStyle.selected,in:RoundedRectangle(cornerRadius:7))
                    }.buttonStyle(.plain)
                }
            }
        }.padding(14).frame(maxWidth:.infinity,alignment:.leading)
        .background(Self.card,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }

    // MARK: Ranking
    private var split:(proxy:Int,direct:Int) {(int(data?["proxy"]),int(data?["direct"]))}
    private func legend(_ proxy:Bool,_ bytes:Int,free:Bool=false)->some View {
        (Text("■ ").foregroundColor(proxy ? VeilbirdStyle.accent:Self.direct)
            + Text(L10n.text(proxy ? "activity_proxy":"activity_direct")+" ")
            + Text(Self.size(bytes)).font(.system(size:12,design:.monospaced)).foregroundColor(VeilbirdStyle.text)
            + Text(free ? " · "+L10n.text("activity_direct_free"):""))
            .font(.system(size:12)).foregroundStyle(proxy ? VeilbirdStyle.text:VeilbirdStyle.secondary).lineLimit(1)
    }
    private var splitBar:some View {
        let (p,d)=split
        return GeometryReader {g in
            HStack(spacing:p>0 && d>0 ? 3:0) {
                if p+d==0 {Rectangle().fill(VeilbirdStyle.raised)}
                else {
                    Rectangle().fill(VeilbirdStyle.accent).frame(width:max(0,(g.size.width-(d>0 && p>0 ? 3:0))*CGFloat(p)/CGFloat(p+d)))
                    Rectangle().fill(Self.direct)
                }
            }
        }.frame(height:8)
    }
    private var summary:some View {
        let (p,d)=split
        let parts=Self.size(p+d).split(separator:" ",maxSplits:1).map(String.init)
        let figure=HStack(alignment:.firstTextBaseline,spacing:6) {
            Text(parts.first ?? "").font(Pixel.font(mac ? 32:40))
            Text(parts.count>1 ? parts[1]:"").font(.system(size:mac ? 12:14,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary)
        }
        return Group {
            if mac {
                HStack(spacing:24) {
                    VStack(alignment:.leading,spacing:4) {Text(L10n.text("activity_this_session")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary);figure}
                    VStack(spacing:8) {splitBar;HStack {legend(true,p);Spacer(minLength:8);legend(false,d,free:true)}}
                }
            } else {
                VStack(alignment:.leading,spacing:12) {
                    HStack(alignment:.firstTextBaseline) {figure;Spacer();Text(L10n.text("activity_this_session")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)}
                    HourBars(hours:hourValues,now:Calendar.current.component(.hour,from:Date()),small:true).frame(height:48)
                    splitBar
                    HStack {legend(true,p);Spacer(minLength:8);legend(false,d,free:true)}
                }
            }
        }.padding(.horizontal,18).padding(.vertical,16).background(Self.card,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }
    private func rankList(_ title:String,_ rows:[[String:Any]],mono:Bool,note:String?)->some View {
        let top=max(1,int(rows.first?["bytes"]))
        return VStack(alignment:.leading,spacing:0) {
            Text(title).font(.system(size:12,weight:.medium)).foregroundStyle(VeilbirdStyle.secondary).padding(.bottom,4)
            ForEach(Array(rows.enumerated()),id:\.offset) {_,r in
                HStack(spacing:12) {
                    VStack(alignment:.leading,spacing:6) {
                        Text(r["name"] as? String ?? "").font(mono ? .system(size:12.5,design:.monospaced):.system(size:13)).lineLimit(1).truncationMode(.middle)
                        DotBar(share:Double(int(r["bytes"]))/Double(top),color:flag(r["proxy"]) ? VeilbirdStyle.accent:Self.direct).frame(height:4)
                    }
                    Text(Self.size(int(r["bytes"]))).font(.system(size:12,design:.monospaced)).lineLimit(1).frame(width:78,alignment:.trailing)
                }.padding(.vertical,6)
            }
            if rows.isEmpty {Text(L10n.text("activity_nothing")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).padding(.top,6)}
            if let note {Text(note).font(.system(size:11)).foregroundStyle(VeilbirdStyle.faint).fixedSize(horizontal:false,vertical:true).padding(.top,8)}
        }.padding(.horizontal,18).padding(.vertical,14).frame(maxWidth:.infinity,alignment:.topLeading)
        .background(Self.card,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }
    private var ranking:some View {
        let domains=data?["domains"] as? [[String:Any]] ?? []
        let rules=data?["rules"] as? [[String:Any]] ?? []
        return ScrollView {
            VStack(spacing:mac ? 14:12) {
                summary
                if mac {
                    HStack(alignment:.top,spacing:14) {
                        rankList(L10n.text("activity_by_domain"),domains,mono:false,note:nil)
                        rankList(L10n.text("activity_by_rule"),rules,mono:true,note:L10n.text("activity_no_apps"))
                    }
                } else {
                    rankList(L10n.text("activity_by_domain"),domains,mono:false,note:nil)
                    rankList(L10n.text("activity_by_rule"),rules,mono:true,note:L10n.text("activity_no_apps"))
                }
            }.padding(.bottom,16)
        }
    }

    // MARK: Per hour (Mac)
    private var hourValues:[(Int,Int)] {
        let rows=data?["hours"] as? [[Any]] ?? []
        return (0..<24).map {i in i<rows.count && rows[i].count==2 ? (int(rows[i][0]),int(rows[i][1])):(0,0)}
    }
    private var hours:some View {
        let (p,d)=split,values=hourValues
        let peak=(0..<24).max {values[$0].0+values[$0].1 < values[$1].0+values[$1].1} ?? 0
        return VStack(alignment:.leading,spacing:14) {
            HStack(spacing:18) {
                Text(L10n.text("activity_per_hour")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)
                legend(true,p)
                legend(false,d)
                Spacer(minLength:8)
                if values[peak].0+values[peak].1>0 {Text(L10n.text("activity_peak",String(peak),Self.size(values[peak].0+values[peak].1))).font(.system(size:12,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary).lineLimit(1)}
            }
            HourBars(hours:values,now:Calendar.current.component(.hour,from:Date()),small:false)
            HStack {
                ForEach(["0","6","12","18","24"],id:\.self) {tick in
                    Text(tick).font(.system(size:11,design:.monospaced)).foregroundStyle(VeilbirdStyle.faint)
                    if tick != "24" {Spacer()}
                }
            }
        }.padding(.horizontal,18).padding(.vertical,16).frame(maxHeight:.infinity)
        .background(Self.card,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
    }

    // MARK: Names looked up (Mac)
    private var lookups:some View {
        let rows=data?["dns"] as? [[String:Any]] ?? []
        return VStack(alignment:.leading,spacing:0) {
            HStack(spacing:12) {
                Text(L10n.text("activity_time")).frame(width:70,alignment:.leading)
                Text(L10n.text("activity_domain")).frame(maxWidth:.infinity,alignment:.leading)
                Text(L10n.text("activity_result")).frame(width:150,alignment:.leading)
                Text(L10n.text("activity_route")).frame(width:70,alignment:.leading)
            }.font(.system(size:11)).foregroundStyle(VeilbirdStyle.faint).lineLimit(1).frame(height:30)
            .overlay(alignment:.bottom) {Rectangle().fill(Self.line).frame(height:1)}
            ScrollView {
                LazyVStack(spacing:0) {
                    ForEach(Array(rows.enumerated()),id:\.offset) {_,r in
                        let proxy=flag(r["proxy"]),result=r["result"] as? String ?? ""
                        HStack(spacing:12) {
                            Text(Self.clock(int(r["time"]))).font(.system(size:12,design:.monospaced)).foregroundStyle(VeilbirdStyle.secondary).frame(width:70,alignment:.leading)
                            Text(r["host"] as? String ?? "").font(.system(size:13)).lineLimit(1).truncationMode(.middle).frame(maxWidth:.infinity,alignment:.leading)
                            Group {
                                if proxy {Text(L10n.text("activity_resolved_by_node")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary)}
                                else {Text(result.isEmpty ? "—":result).font(.system(size:12,design:.monospaced))}
                            }.lineLimit(1).frame(width:150,alignment:.leading)
                            HStack(spacing:6) {dot(proxy);Text(L10n.text(proxy ? "activity_proxy":"activity_direct")).font(.system(size:12))}.frame(width:70,alignment:.leading)
                        }.frame(height:36).overlay(alignment:.bottom) {Rectangle().fill(Self.row).frame(height:1)}
                    }
                    if rows.isEmpty {Text(L10n.text("activity_nothing")).font(.system(size:13)).foregroundStyle(VeilbirdStyle.secondary).frame(maxWidth:.infinity,alignment:.leading).padding(.top,16)}
                }
            }
            Text(L10n.text("activity_dns_note")).font(.system(size:11)).foregroundStyle(VeilbirdStyle.faint).padding(.top,12)
        }
    }

    // MARK: Helpers
    private func dot(_ proxy:Bool)->some View {Rectangle().fill(proxy ? VeilbirdStyle.accent:Self.direct).frame(width:6,height:6)}
    private func flag(_ value:Any?)->Bool {value as? Bool ?? false}
    private func int(_ value:Any?)->Int {(value as? NSNumber)?.intValue ?? (value as? Int) ?? 0}
    static func size(_ value:Int)->String {
        var bytes=Double(value);let units=["B","KB","MB","GB","TB"];var i=0
        while bytes>=1024 && i<units.count-1 {bytes/=1024;i+=1}
        return (i<3 ? String(format:"%.0f",bytes):String(format:"%.2f",bytes))+" "+units[i]
    }
    static func rate(_ value:Int)->String {value<=0 ? "0 B/s":size(value)+"/s"}
    static func elapsed(_ startMs:Int)->String {
        let seconds=max(0,Int(Date().timeIntervalSince1970)-startMs/1000)
        return seconds>=3600 ? String(format:"%d:%02d:%02d",seconds/3600,seconds%3600/60,seconds%60):String(format:"%02d:%02d",seconds/60,seconds%60)
    }
    static func clock(_ ms:Int)->String {
        let formatter=DateFormatter();formatter.dateFormat="HH:mm:ss"
        return formatter.string(from:Date(timeIntervalSince1970:Double(ms)/1000))
    }
}

/// A track of square dots, the lit share in color: the rankings' bars.
struct DotBar:View {
    let share:Double
    let color:Color
    var body:some View {
        Canvas {context,size in
            let count=Int((size.width+2)/6),lit=share<=0 ? 0:max(1,Int((Double(count)*min(1,share)).rounded()))
            for i in 0..<max(0,count) {
                context.fill(Path(CGRect(x:CGFloat(i)*6,y:0,width:4,height:size.height)),with:.color(i<lit ? color:Color(red:40/255,green:37/255,blue:33/255)))
            }
        }.accessibilityHidden(true)
    }
}

/// 24 columns of square dots, proxied (amber) stacked on direct (dark green); the current hour is outlined.
struct HourBars:View {
    let hours:[(Int,Int)]
    let now:Int
    let small:Bool
    var body:some View {
        Canvas {context,size in
            let pitch:CGFloat=small ? 5:6,block:CGFloat=small ? 3:4,width:CGFloat=small ? 8:12
            let step=(size.width-width)/23
            let rows=max(1,Int((size.height+pitch-block)/pitch))
            let top=max(1,hours.map {$0.0+$0.1}.max() ?? 1)
            let direct=Color(red:97/255,green:90/255,blue:80/255)
            for i in 0..<min(24,hours.count) {
                let left=(CGFloat(i)*step).rounded(),(p,d)=hours[i]
                if p+d==0 {context.fill(Path(CGRect(x:left,y:size.height-block,width:width,height:block)),with:.color(Color(red:30/255,green:28/255,blue:25/255)));continue}
                let dRows=d<=0 ? 0:max(1,Int((Double(rows)*Double(d)/Double(top)).rounded()))
                let pRows=p<=0 ? 0:max(1,min(rows-dRows,Int((Double(rows)*Double(p)/Double(top)).rounded())))
                for r in 0..<dRows {context.fill(Path(CGRect(x:left,y:size.height-block-CGFloat(r)*pitch,width:width,height:block)),with:.color(direct))}
                for r in 0..<max(0,pRows) {context.fill(Path(CGRect(x:left,y:size.height-block-CGFloat(dRows+r)*pitch,width:width,height:block)),with:.color(VeilbirdStyle.accent))}
                if i==now && !small {
                    let h=CGFloat(dRows+pRows)*pitch
                    context.stroke(Path(CGRect(x:left-3.5,y:size.height-h-3.5,width:width+7,height:h+5)),with:.color(VeilbirdStyle.text.opacity(0.5)),style:StrokeStyle(lineWidth:1,dash:[3,2]))
                }
            }
        }.accessibilityHidden(true)
    }
}
