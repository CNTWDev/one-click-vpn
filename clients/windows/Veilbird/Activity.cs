using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Shapes;
namespace Veilbird;

/// <summary>
/// The "Activity" panel beside the connect page: open connections, where this connection's traffic went
/// (by domain and by app), proxied vs direct per hour, and the names looked up. The core keeps all of it in
/// memory while connected and forgets it on disconnect; nothing is stored or sent.
/// </summary>
public sealed class ActivityPanel:Border {
    private static readonly Brush Direct=Look.Hex("#615A50"),Row=Look.Hex("#1A1816"),Line=Look.Hex("#24221E"),Card=Look.Hex("#151311"),Dim=Look.Hex("#7E7569");
    private string tab="conns",filter="all",query="";
    private JsonNode? data;
    private string node="";
    private readonly StackPanel tabs=new() {Orientation=Orientation.Horizontal};
    private readonly Grid toolbar=new() {Margin=new Thickness(0,14,0,0)};
    private readonly StackPanel chips=new() {Orientation=Orientation.Horizontal};
    private readonly ContentControl body=new() {Focusable=false};
    private readonly TextBox search=new() {Width=220,Height=28,FontSize=12,Padding=new Thickness(26,0,8,0),VerticalContentAlignment=VerticalAlignment.Center};

    public ActivityPanel() {
        BorderBrush=Look.Hex("#1E1C19");BorderThickness=new Thickness(1,0,0,0);
        var title=new TextBlock {Text=L10n.Text("activity_title"),FontSize=17,FontWeight=FontWeights.SemiBold,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(0,0,16,0)};
        var tabsBox=new Border {Background=Look.Hex("#171513"),CornerRadius=new CornerRadius(3),Padding=new Thickness(2),Child=tabs,VerticalAlignment=VerticalAlignment.Center};
        var note=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};
        note.Children.Add(new Rectangle {Width=6,Height=6,Fill=Look.Hex("#6F5A3F"),Margin=new Thickness(0,0,6,0),VerticalAlignment=VerticalAlignment.Center});
        note.Children.Add(new TextBlock {Text=L10n.Text("activity_local_only"),FontSize=12,Foreground=Look.Faint,TextWrapping=TextWrapping.NoWrap,TextTrimming=TextTrimming.CharacterEllipsis});
        var head=new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});head.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});head.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});
        head.Children.Add(title);Grid.SetColumn(tabsBox,1);head.Children.Add(tabsBox);
        note.HorizontalAlignment=HorizontalAlignment.Right;note.Margin=new Thickness(12,0,0,0);Grid.SetColumn(note,2);head.Children.Add(note);

        // Filter chips and the search box (connections only).
        var hint=new TextBlock {Text=L10n.Text("activity_filter"),FontSize=12,Foreground=Look.Faint,Margin=new Thickness(27,0,8,0),VerticalAlignment=VerticalAlignment.Center,IsHitTestVisible=false,TextWrapping=TextWrapping.NoWrap,TextTrimming=TextTrimming.CharacterEllipsis};
        var glass=Look.Icon("",11,Look.Faint);glass.HorizontalAlignment=HorizontalAlignment.Left;glass.Margin=new Thickness(9,0,0,0);glass.IsHitTestVisible=false;
        AutomationProperties.SetName(search,L10n.Text("activity_filter"));
        search.TextChanged+=(_,_)=>{hint.Visibility=search.Text.Length==0?Visibility.Visible:Visibility.Collapsed;query=search.Text.Trim();Fill();};
        var box=new Grid {HorizontalAlignment=HorizontalAlignment.Right};box.Children.Add(search);box.Children.Add(hint);box.Children.Add(glass);
        toolbar.Children.Add(chips);toolbar.Children.Add(box);

        var root=new DockPanel {Margin=new Thickness(24,16,24,16)};
        DockPanel.SetDock(head,Dock.Top);root.Children.Add(head);
        DockPanel.SetDock(toolbar,Dock.Top);root.Children.Add(toolbar);
        root.Children.Add(body);
        Child=root;
        Fill();
    }

    /// New figures from the core (null when not connected), and the location carrying proxied traffic.
    public void Update(JsonNode? next,string location) {data=next;node=location;Fill();}

    private void Fill() {
        var conns=data?["conns"] as JsonArray;
        var count=conns?.Count??0;
        tabs.Children.Clear();
        foreach(var (key,label) in new[]{("conns","activity_connections"),("rank","activity_ranking"),("hours","activity_traffic"),("dns","activity_dns")}) {
            var on=tab==key;
            var content=new StackPanel {Orientation=Orientation.Horizontal};
            content.Children.Add(new TextBlock {Text=L10n.Text(label),FontSize=13,Foreground=on?Look.Text:Look.Secondary,VerticalAlignment=VerticalAlignment.Center});
            if(key=="conns"&&data is not null) content.Children.Add(new TextBlock {Text=count.ToString(L10n.Culture),FontFamily=Mono,FontSize=11,Foreground=Look.Secondary,Margin=new Thickness(6,0,0,0),VerticalAlignment=VerticalAlignment.Center});
            var button=new Button {Content=content,Height=28,Padding=new Thickness(14,0,14,0),Background=on?Look.Hex("#302D28"):Brushes.Transparent,HorizontalContentAlignment=HorizontalAlignment.Center};
            AutomationProperties.SetName(button,L10n.Text(label)+(on?L10n.Text("current_page"):""));
            button.Click+=(_,_)=>{tab=key;Fill();};
            tabs.Children.Add(button);
        }
        toolbar.Visibility=tab=="conns"&&data is not null?Visibility.Visible:Visibility.Collapsed;
        if(data is null) {body.Content=Empty(L10n.Text("activity_empty"));return;}
        body.Content=tab switch {"rank"=>Ranking(),"hours"=>Hours(),"dns"=>Lookups(),_=>Connections(conns??new JsonArray())};
    }

    // The lists are rebuilt every second: the new one keeps the scroll position of the one it replaces.
    private ScrollViewer? scroll;
    private string scrollTab="";
    private ScrollViewer Scroll(UIElement content) {
        var viewer=new ScrollViewer {Content=content,VerticalScrollBarVisibility=ScrollBarVisibility.Auto,Focusable=false};
        if(scroll is not null&&scrollTab==tab) viewer.ScrollToVerticalOffset(scroll.VerticalOffset);
        scroll=viewer;scrollTab=tab;
        return viewer;
    }
    private static readonly FontFamily Mono=new("Cascadia Mono, Consolas");
    private static TextBlock Text(string text,double size=13,Brush? color=null,bool mono=false,TextAlignment align=TextAlignment.Left)=>new() {
        Text=text,FontSize=mono?size-1:size,FontFamily=mono?Mono:null,Foreground=color??Look.Text,TextAlignment=align,TextWrapping=TextWrapping.NoWrap,TextTrimming=TextTrimming.CharacterEllipsis,VerticalAlignment=VerticalAlignment.Center};
    private static FrameworkElement Empty(string text)=>new TextBlock {Text=text,FontSize=13,Foreground=Look.Secondary,TextWrapping=TextWrapping.Wrap,TextAlignment=TextAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center,MaxWidth=320};
    private static Rectangle Dot(bool proxy)=>new() {Width=6,Height=6,Fill=proxy?Look.Accent:Direct,VerticalAlignment=VerticalAlignment.Center};
    private static long Num(JsonNode? value)=>long.TryParse(value?.ToString(),out var number)?number:0;
    private static bool Flag(JsonNode? value)=>value?.GetValue<bool>()==true;
    private static string Str(JsonNode? value)=>value?.GetValue<string>()??"";
    public static string Size(long value) {double bytes=value;string[] units={"B","KB","MB","GB","TB"};var i=0;while(bytes>=1024&&i<units.Length-1){bytes/=1024;i++;}return bytes.ToString(i==0?"0":i<3?"0":"0.##",L10n.Culture)+" "+units[i];}
    private static string Rate(long value)=>value<=0?"0 B/s":Size(value)+"/s";
    private string Exit(JsonNode row)=>Flag(row["proxy"])?(node.Length>0?node:Str(row["via"])):L10n.Text("activity_direct");

    private static Grid Table(params GridLength[] columns) {
        var grid=new Grid();
        foreach(var width in columns) grid.ColumnDefinitions.Add(new ColumnDefinition {Width=width});
        return grid;
    }
    private static GridLength Px(double value)=>new(value);
    private static GridLength Star(double value)=>new(value,GridUnitType.Star);
    private static Border Line_(UIElement content,double height,Brush line)=>new() {Height=height,BorderBrush=line,BorderThickness=new Thickness(0,0,0,1),Child=content};
    private static void Put(Grid grid,UIElement element,int column,double gap=12) {
        if(element is FrameworkElement framework&&column>0) framework.Margin=new Thickness(gap,framework.Margin.Top,framework.Margin.Right,framework.Margin.Bottom);
        Grid.SetColumn(element,column);grid.Children.Add(element);
    }

    private FrameworkElement Connections(JsonArray conns) {
        // The filter chips show the counts of all open connections.
        var proxied=conns.Count(c=>Flag(c?["proxy"]));
        chips.Children.Clear();
        foreach(var (key,label,number,brush) in new[]{("all","activity_all",conns.Count,(Brush?)null),("proxy","activity_proxy",proxied,Look.Accent),("direct","activity_direct",conns.Count-proxied,Direct)}) {
            var on=filter==key;
            var content=new StackPanel {Orientation=Orientation.Horizontal};
            if(brush is not null) content.Children.Add(new Rectangle {Width=6,Height=6,Fill=brush,Margin=new Thickness(0,0,6,0),VerticalAlignment=VerticalAlignment.Center});
            content.Children.Add(new TextBlock {Text=L10n.Text(label),FontSize=12,Foreground=on?Look.Text:Look.Secondary,VerticalAlignment=VerticalAlignment.Center});
            content.Children.Add(new TextBlock {Text=number.ToString(L10n.Culture),FontFamily=Mono,FontSize=11,Foreground=on?Look.Text:Look.Secondary,Margin=new Thickness(6,0,0,0),VerticalAlignment=VerticalAlignment.Center});
            var chip=new Button {Content=content,Height=26,Padding=new Thickness(10,0,10,0),Margin=new Thickness(0,0,6,0),Background=on?Look.Selected:Look.Surface};
            chip.Click+=(_,_)=>{filter=key;Fill();};
            chips.Children.Add(chip);
        }
        var shown=conns.Where(c=>c is not null).Select(c=>c!).Where(c=>filter=="all"||Flag(c["proxy"])==(filter=="proxy"))
            .Where(c=>query.Length==0||new[]{Str(c["host"]),Str(c["rule"]),Str(c["process"]),Exit(c)}.Any(v=>v.Contains(query,StringComparison.OrdinalIgnoreCase))).Take(100).ToList();
        GridLength[] columns={Px(14),Star(1.5),Px(104),Star(1),Px(76),Px(76)};
        var header=Table(columns);
        var labels=new[]{"","activity_domain","activity_app","activity_rule","activity_out","activity_down"};
        for(var i=1;i<labels.Length;i++) Put(header,Text(L10n.Text(labels[i]),11,Look.Faint,align:i==5?TextAlignment.Right:TextAlignment.Left),i,i==1?0:12);
        var list=new StackPanel();
        foreach(var c in shown) {
            var row=Table(columns);var proxy=Flag(c["proxy"]);var rate=Num(c["rate"]);
            Put(row,Dot(proxy),0);
            Put(row,Text(Str(c["host"])),1,0);
            Put(row,Text(Str(c["process"]),12,Look.Secondary,mono:true),2);
            Put(row,Text(Str(c["rule"]),12,Look.Secondary,mono:true),3);
            Put(row,Text(Exit(c),13,proxy?Look.Text:Look.Secondary),4);
            Put(row,Text(Rate(rate),12,rate>0?Look.Text:Dim,mono:true,align:TextAlignment.Right),5);
            list.Children.Add(Line_(row,36,Row));
        }
        if(shown.Count==0) list.Children.Add(new TextBlock {Text=L10n.Text("activity_nothing"),FontSize=13,Foreground=Look.Secondary,Margin=new Thickness(0,16,0,0)});
        var dock=new DockPanel {Margin=new Thickness(0,10,0,0)};
        var top=Line_(header,30,Line);DockPanel.SetDock(top,Dock.Top);dock.Children.Add(top);
        dock.Children.Add(Scroll(list));
        return dock;
    }

    private (long Proxy,long Direct) Split()=>(Num(data?["proxy"]),Num(data?["direct"]));
    private static Border CardOf(UIElement child,Thickness? margin=null)=>new() {Background=Card,CornerRadius=new CornerRadius(10),Padding=new Thickness(18,16,18,16),Child=child,Margin=margin??new Thickness(0)};
    private static FrameworkElement Legend(bool proxy,long bytes,bool free=false) {
        var line=new TextBlock {FontSize=12,Foreground=proxy?Look.Text:Look.Secondary,VerticalAlignment=VerticalAlignment.Center,TextWrapping=TextWrapping.NoWrap};
        line.Inlines.Add(new Run("■ ") {Foreground=proxy?Look.Accent:Direct});
        line.Inlines.Add(new Run(L10n.Text(proxy?"activity_proxy":"activity_direct")+" "));
        line.Inlines.Add(new Run(Size(bytes)) {FontFamily=Mono,Foreground=Look.Text});
        if(free) line.Inlines.Add(new Run(" · "+L10n.Text("activity_direct_free")));
        return line;
    }

    private FrameworkElement Ranking() {
        var (proxy,direct)=Split();
        var total=Size(proxy+direct).Split(' ',2);
        var figure=new StackPanel {Margin=new Thickness(0,0,24,0),VerticalAlignment=VerticalAlignment.Center};
        figure.Children.Add(Text(L10n.Text("activity_this_session"),12,Look.Secondary));
        var number=new TextBlock {Margin=new Thickness(0,4,0,0)};
        number.Inlines.Add(new Run(total[0]) {FontFamily=Look.Dots,FontSize=32});
        if(total.Length>1) number.Inlines.Add(new Run(" "+total[1]) {FontFamily=Mono,FontSize=12,Foreground=Look.Secondary});
        figure.Children.Add(number);
        var bar=new Grid {Height=8};
        bar.ColumnDefinitions.Add(new ColumnDefinition {Width=Star(Math.Max(proxy,1))});bar.ColumnDefinitions.Add(new ColumnDefinition {Width=Star(Math.Max(direct,proxy+direct==0?1:0))});
        bar.Children.Add(new Rectangle {Fill=proxy+direct==0?Look.Raised:Look.Accent,Margin=new Thickness(0,0,direct>0?3:0,0)});
        var directBar=new Rectangle {Fill=Direct};Grid.SetColumn(directBar,1);bar.Children.Add(directBar);
        var legend=new DockPanel {Margin=new Thickness(0,8,0,0)};
        var right=Legend(false,direct,true);DockPanel.SetDock(right,Dock.Right);legend.Children.Add(right);legend.Children.Add(Legend(true,proxy));
        var split=new StackPanel {VerticalAlignment=VerticalAlignment.Center};split.Children.Add(bar);split.Children.Add(legend);
        var summary=Table(GridLength.Auto,Star(1));Put(summary,figure,0);Put(summary,split,1,0);

        var cards=Table(Star(1),Star(1));cards.Margin=new Thickness(0,14,0,0);
        var byDomain=RankList(L10n.Text("activity_by_domain"),data?["domains"] as JsonArray,false,null);
        var apps=data?["apps"] as JsonArray;
        // Process names exist on Windows (find-process); without them the second list ranks by rule.
        var byApp=apps is { Count: >0 }?RankList(L10n.Text("activity_by_app"),apps,true,null):RankList(L10n.Text("activity_by_rule"),data?["rules"] as JsonArray,true,null);
        Put(cards,byDomain,0,0);byApp.Margin=new Thickness(14,0,0,0);Grid.SetColumn(byApp,1);cards.Children.Add(byApp);
        var stack=new StackPanel {Margin=new Thickness(0,14,0,0)};stack.Children.Add(CardOf(summary));stack.Children.Add(cards);
        return Scroll(stack);
    }
    private Border RankList(string title,JsonArray? rows,bool mono,string? note) {
        var stack=new StackPanel();
        stack.Children.Add(Text(title,12,Look.Secondary));
        var list=rows?.Where(r=>r is not null).Select(r=>r!).ToList()??new();
        var top=list.Count>0?Math.Max(1,Num(list[0]["bytes"])):1;
        foreach(var row in list) {
            var name=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
            name.Children.Add(Text(Str(row["name"]),mono?12.5:13,mono:mono));
            name.Children.Add(new DotBar((double)Num(row["bytes"])/top,Flag(row["proxy"])?Look.Accent:Direct) {Height=4,Margin=new Thickness(0,6,0,0)});
            var line=Table(Star(1),Px(78));line.Margin=new Thickness(0,7,0,7);
            Put(line,name,0);Put(line,Text(Size(Num(row["bytes"])),12,mono:true,align:TextAlignment.Right),1);
            stack.Children.Add(line);
        }
        if(list.Count==0) stack.Children.Add(new TextBlock {Text=L10n.Text("activity_nothing"),FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(0,10,0,0)});
        if(note is not null) stack.Children.Add(new TextBlock {Text=note,FontSize=11,Foreground=Look.Faint,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,10,0,0)});
        return CardOf(stack);
    }

    private FrameworkElement Hours() {
        var (proxy,direct)=Split();
        var hours=(data?["hours"] as JsonArray)?.Select(h=>(Proxy:Num(h?[0]),Direct:Num(h?[1]))).ToList()??new();
        while(hours.Count<24) hours.Add((0,0));
        var peak=Enumerable.Range(0,24).OrderByDescending(i=>hours[i].Proxy+hours[i].Direct).First();
        var head=new DockPanel();
        if(hours[peak].Proxy+hours[peak].Direct>0) {var max=Text(L10n.Text("activity_peak",peak,Size(hours[peak].Proxy+hours[peak].Direct)),12,Look.Secondary,mono:true);DockPanel.SetDock(max,Dock.Right);head.Children.Add(max);}
        var left=new StackPanel {Orientation=Orientation.Horizontal};
        left.Children.Add(Text(L10n.Text("activity_per_hour"),12,Look.Secondary));
        var p=Legend(true,proxy);p.Margin=new Thickness(18,0,0,0);left.Children.Add(p);
        var d=Legend(false,direct);d.Margin=new Thickness(14,0,0,0);left.Children.Add(d);
        head.Children.Add(left);
        var axis=new Grid {Margin=new Thickness(0,8,0,0)};
        for(var i=0;i<5;i++) axis.ColumnDefinitions.Add(new ColumnDefinition {Width=Star(1)});
        string[] ticks={"0","6","12","18","24"};
        for(var i=0;i<5;i++) Put(axis,Text(ticks[i],11,Look.Faint,mono:true,align:i==0?TextAlignment.Left:i==4?TextAlignment.Right:TextAlignment.Center),i,0);
        var chart=new HourBars(hours,DateTime.Now.Hour) {Margin=new Thickness(0,14,0,0)};
        var dock=new DockPanel();
        DockPanel.SetDock(head,Dock.Top);dock.Children.Add(head);
        DockPanel.SetDock(axis,Dock.Bottom);dock.Children.Add(axis);
        dock.Children.Add(chart);
        var card=CardOf(dock);card.Margin=new Thickness(0,14,0,0);
        return card;
    }

    private FrameworkElement Lookups() {
        var rows=(data?["dns"] as JsonArray)?.Where(r=>r is not null).Select(r=>r!).ToList()??new();
        GridLength[] columns={Px(72),Star(1),Px(150),Px(70)};
        var header=Table(columns);
        var labels=new[]{"activity_time","activity_domain","activity_result","activity_route"};
        for(var i=0;i<labels.Length;i++) Put(header,Text(L10n.Text(labels[i]),11,Look.Faint),i,i==0?0:12);
        var list=new StackPanel();
        foreach(var r in rows) {
            var proxy=Flag(r["proxy"]);
            var row=Table(columns);
            Put(row,Text(DateTimeOffset.FromUnixTimeMilliseconds(Num(r["time"])).ToLocalTime().ToString("HH:mm:ss",L10n.Culture),12,Look.Secondary,mono:true),0,0);
            Put(row,Text(Str(r["host"])),1);
            var result=Str(r["result"]);
            Put(row,proxy?Text(L10n.Text("activity_resolved_by_node"),12,Look.Secondary):Text(result.Length>0?result:"—",12,Look.Text,mono:true),2);
            var route=new StackPanel {Orientation=Orientation.Horizontal};route.Children.Add(Dot(proxy));
            route.Children.Add(new TextBlock {Text=L10n.Text(proxy?"activity_proxy":"activity_direct"),FontSize=12,Margin=new Thickness(6,0,0,0),VerticalAlignment=VerticalAlignment.Center});
            Put(row,route,3);
            list.Children.Add(Line_(row,36,Row));
        }
        if(rows.Count==0) list.Children.Add(new TextBlock {Text=L10n.Text("activity_nothing"),FontSize=13,Foreground=Look.Secondary,Margin=new Thickness(0,16,0,0)});
        var note=new TextBlock {Text=L10n.Text("activity_dns_note"),FontSize=11,Foreground=Look.Faint,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,12,0,0)};
        var dock=new DockPanel {Margin=new Thickness(0,14,0,0)};
        var top=Line_(header,30,Line);DockPanel.SetDock(top,Dock.Top);dock.Children.Add(top);
        DockPanel.SetDock(note,Dock.Bottom);dock.Children.Add(note);
        dock.Children.Add(Scroll(list));
        return dock;
    }
}

/// A track of square dots, the lit share in color: the rankings' bars.
public sealed class DotBar(double share,Brush color):FrameworkElement {
    private static readonly Brush Track=Look.Hex("#282521");
    protected override void OnRender(DrawingContext dc) {
        var count=(int)((ActualWidth+2)/6);var lit=share<=0?0:Math.Max(1,(int)Math.Round(count*Math.Min(1,share)));
        for(var i=0;i<count;i++) dc.DrawRectangle(i<lit?color:Track,null,new Rect(i*6,0,4,ActualHeight));
    }
}

/// 24 columns of square dots, proxied (amber) stacked on direct (dark green); the current hour is outlined.
public sealed class HourBars(IReadOnlyList<(long Proxy,long Direct)> hours,int now):FrameworkElement {
    private static readonly Brush Direct=Look.Hex("#615A50"),Empty=Look.Hex("#1E1C19");
    private static readonly Pen Now=new(Look.Hex("#80EDE7DF"),1) {DashStyle=DashStyles.Dash};
    protected override void OnRender(DrawingContext dc) {
        double pitch=6,block=4,width=12,step=(ActualWidth-width)/23;
        var rows=Math.Max(1,(int)((ActualHeight+pitch-block)/pitch));
        var max=Math.Max(1,hours.Max(h=>h.Proxy+h.Direct));
        for(var i=0;i<24;i++) {
            var left=Math.Round(i*step);var (p,d)=hours[i];
            if(p+d==0) {dc.DrawRectangle(Empty,null,new Rect(left,ActualHeight-block,width,block));continue;}
            var dRows=d<=0?0:Math.Max(1,(int)Math.Round((double)rows*d/max));
            var pRows=p<=0?0:Math.Max(1,Math.Min(rows-dRows,(int)Math.Round((double)rows*p/max)));
            for(var r=0;r<dRows;r++) dc.DrawRectangle(Direct,null,new Rect(left,ActualHeight-block-r*pitch,width,block));
            for(var r=0;r<pRows;r++) dc.DrawRectangle(Look.Accent,null,new Rect(left,ActualHeight-block-(dRows+r)*pitch,width,block));
            if(i==now) dc.DrawRectangle(null,Now,new Rect(left-3.5,ActualHeight-(dRows+pRows)*pitch-3.5,width+7,(dRows+pRows)*pitch+5));
        }
    }
}
