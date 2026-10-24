using System.ComponentModel;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;
using Forms=System.Windows.Forms;
namespace Veilbird;

/// Location and routing choices, kept per Windows user.
public static class Settings {
    private static readonly string Path=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","settings.json");
    private static JsonObject Load() {try {return File.Exists(Path)?JsonNode.Parse(File.ReadAllText(Path)) as JsonObject??new():new();} catch {return new();}}
    public static string Get(string key,string fallback="")=>Load()[key]?.GetValue<string>()??fallback;
    public static void Set(string key,string value) {
        var all=Load();all[key]=value;
        try {Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);File.WriteAllText(Path,all.ToJsonString());} catch(IOException) {}
    }
}

/// <summary>
/// A small fixed-size tool window with three pages (connect, locations, account) and a tray icon for the
/// quick actions. Closing the window keeps TrackNothing running in the tray; Quit in the tray menu exits.
/// </summary>
public partial class MainWindow : Window {
    private readonly NativeApi api=new();
    private readonly Core core=new();
    private readonly Connection connection;
    private readonly Forms.NotifyIcon tray=new();
    private string page="connect",nodeId=Settings.Get("nodeId"),nodeName=Settings.Get("nodeName");
    private bool busy,measuring,quitting,trayHintShown;
    private (string Version,bool Mandatory,Uri Download)? update;
    private string announcement="";
    private readonly DispatcherTimer refresh=new() {Interval=TimeSpan.FromSeconds(1)};
    private TextBlock? status,stats;
    private Border? power;
    private Button? mainButton;
    private (TextBlock Title,TextBlock Detail,Ellipse Dot)? currentNode;
    private static readonly Brush Ink=Brush("#182731"),Muted=Brush("#5B6970"),Teal=Brush("#007A64"),Mint=Brush("#E2F7F0"),White=Brush("#FFFFFF"),Canvas=Brush("#F8F6EE");
    private static readonly Brush Good=Brush("#008C60"),Fair=Brush("#C48400"),Poor=Brush("#BE3C2D"),Unknown=Brush("#BEC4C0");
    private static Brush Brush(string hex)=>(Brush)new BrushConverter().ConvertFromString(hex)!;
    private static bool Smart=>Settings.Get("routing","smart")=="smart";

    public MainWindow() {
        L10n.Initialize();InitializeComponent();api.Origin=api.SavedOrigin;
        connection=new Connection(api,core);
        connection.Changed+=()=>Dispatcher.InvokeAsync(()=>{UpdateLive();UpdateTray();});
        refresh.Tick+=(_,_)=>UpdateLive();refresh.Start();
        SetupTray();
        Closing+=OnClosing;
        Render();CheckForUpdate();
    }

    // ---- Tray ----
    private void SetupTray() {
        using(var stream=Application.GetResourceStream(new Uri("pack://application:,,,/Assets/Veilbird.ico")).Stream) tray.Icon=new System.Drawing.Icon(stream);
        tray.Visible=true;tray.ContextMenuStrip=new Forms.ContextMenuStrip();
        tray.ContextMenuStrip.Opening+=(_,_)=>BuildTrayMenu();
        tray.MouseClick+=(_,e)=>{if(e.Button==Forms.MouseButtons.Left) ShowFromTray();};
        UpdateTray();
    }
    private void BuildTrayMenu() {
        var menu=tray.ContextMenuStrip!;menu.Items.Clear();
        var signedIn=api.SignedIn;
        menu.Items.Add(new Forms.ToolStripMenuItem(L10n.Text(connection.StatusKey)+(connection.Active&&connection.NodeName.Length>0?" · "+connection.NodeName:"")) {Enabled=false});
        menu.Items.Add(new Forms.ToolStripSeparator());
        if(signedIn&&update?.Mandatory!=true||connection.Active) menu.Items.Add(L10n.Text(connection.Active?"disconnect_action":"connect_action"),null,(_,_)=>Toggle());
        if(signedIn) {
            foreach(var (value,title) in new[]{("smart","routing_smart"),("global","routing_global")})
                menu.Items.Add(new Forms.ToolStripMenuItem(L10n.Text(title),null,(_,_)=>ChooseRouting(value)) {Checked=Settings.Get("routing","smart")==value,Enabled=!connection.Active});
        }
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(L10n.Text("open_app"),null,(_,_)=>ShowFromTray());
        menu.Items.Add(L10n.Text("quit_app"),null,(_,_)=>Quit());
    }
    private void UpdateTray() {
        var text="TrackNothing · "+L10n.Text(connection.StatusKey);
        tray.Text=text.Length>63?text[..63]:text;
    }
    public void ShowFromTray() {Show();if(WindowState==WindowState.Minimized) WindowState=WindowState.Normal;Activate();}
    private void OnClosing(object? sender,CancelEventArgs e) {
        if(quitting) return;
        e.Cancel=true;Hide();
        if(!trayHintShown) {trayHintShown=true;tray.ShowBalloonTip(3000,"TrackNothing",L10n.Text("running_in_tray"),Forms.ToolTipIcon.None);}
    }
    private async void Quit() {
        quitting=true;tray.Visible=false;
        try {await connection.Disconnect().WaitAsync(TimeSpan.FromSeconds(8));} catch {/* exiting anyway */}
        core.Dispose();api.Dispose();tray.Dispose();
        Application.Current.Shutdown();
    }

    // ---- Actions ----
    private void Toggle() {
        if(connection.Active) {_=connection.Disconnect();return;}
        if(!api.SignedIn) {ShowFromTray();return;}
        Work(async()=>await connection.Connect(nodeId,Smart));
    }
    private void ChooseRouting(string value) {
        if(connection.Active) {Alert(L10n.Text("disconnect_before_changing_routing"));return;}
        Settings.Set("routing",value);if(page=="nodes") Render();
    }
    private void Select(string id,string name) {
        if(connection.Active) {Alert(L10n.Text("disconnect_before_selecting_another_location"));return;}
        nodeId=id;nodeName=name;Settings.Set("nodeId",id);Settings.Set("nodeName",name);page="connect";Render();
    }
    private async void CheckForUpdate() {
        try {
            if(await api.LatestRelease() is not { } found) return;
            if(found.Update?.Version!=update?.Version||found.Announcement!=announcement) {update=found.Update;announcement=found.Announcement;if(!busy) Render();}
        } catch {/* checked again on next launch */}
    }
    private async void Work(Func<Task> action) {
        if(busy) return;
        busy=true;BusyBar.Visibility=Visibility.Visible;NavigationPanel.IsEnabled=false;
        try {await action();}
        catch(Exception error) {
            if(error is AccessFailure {Code:"AUTH_REQUIRED"}) {await api.Logout().ContinueWith(_=>{});Render();}
            if(error is AccessFailure {Code:"CLIENT_UPDATE_REQUIRED"}) CheckForUpdate();
            Alert(error is AccessFailure?error.Message:L10n.Text("unable_to_reach_the_service_check_your_network_and"));
        }
        finally {busy=false;NavigationPanel.IsEnabled=true;if(!measuring) BusyBar.Visibility=Visibility.Hidden;UpdateLive();}
    }
    private static void Alert(string message)=>MessageBox.Show(message,"TrackNothing");

    // ---- Building blocks ----
    private TextBlock Label(string text,double size=14,bool strong=false,Brush? color=null) {
        return new TextBlock {Text=text,FontSize=size,FontWeight=strong?FontWeights.SemiBold:FontWeights.Normal,Foreground=color??(strong?Ink:Muted),TextWrapping=TextWrapping.Wrap};
    }
    private T Add<T>(T element,double top=0,double bottom=8) where T:FrameworkElement {element.Margin=new Thickness(0,top,0,bottom);ContentPanel.Children.Add(element);return element;}
    private Button Action(string title,System.Action action,bool primary=false,bool danger=false) {
        var button=new Button {Content=title,Background=primary?Teal:danger?Brush("#FFEEEA"):Mint,Foreground=primary?White:danger?Brush("#A33125"):Teal};
        button.Click+=(_,_)=>{if(!busy) action();};
        return button;
    }
    private static Ellipse Dot(Brush color)=>new() {Width=9,Height=9,Fill=color,Margin=new Thickness(0,0,12,0),VerticalAlignment=VerticalAlignment.Center};
    private static Brush GradeColor(Quality? quality)=>quality?.Grade switch {"quality_good"=>Good,"quality_fair"=>Fair,"quality_poor"=>Poor,_=>Unknown};
    private static string Summary(Quality quality)=>quality.Latency is { } ms?L10n.Text("latency_ms",ms.ToString("N0",L10n.Culture))+" · "+L10n.Text(quality.Grade):L10n.Text(quality.Grade);
    /// A clickable list row: status dot, title with a muted detail line, and an optional value on the right.
    private Button Row(string title,string detail,Brush dot,string trailing,Brush trailingColor,bool selected,System.Action onClick,out TextBlock titleView,out TextBlock detailView,out Ellipse dotView) {
        var grid=new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});grid.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});grid.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});
        dotView=Dot(dot);grid.Children.Add(dotView);
        var text=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
        titleView=new TextBlock {Text=title,FontSize=14,FontWeight=FontWeights.SemiBold,Foreground=Ink,TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        detailView=new TextBlock {Text=detail,FontSize=12,FontWeight=FontWeights.Normal,Foreground=Muted,TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap,Visibility=detail.Length>0?Visibility.Visible:Visibility.Collapsed,Margin=new Thickness(0,2,0,0)};
        text.Children.Add(titleView);text.Children.Add(detailView);Grid.SetColumn(text,1);grid.Children.Add(text);
        var right=new TextBlock {Text=trailing,FontSize=14,FontWeight=FontWeights.SemiBold,Foreground=trailingColor,Margin=new Thickness(12,0,0,0),VerticalAlignment=VerticalAlignment.Center};
        Grid.SetColumn(right,2);grid.Children.Add(right);
        var button=new Button {Content=grid,HorizontalContentAlignment=HorizontalAlignment.Stretch,Background=selected?Mint:White,MinHeight=52,Padding=new Thickness(14,8,14,8)};
        AutomationProperties.SetName(button,title+(detail.Length>0?", "+detail:"")+(selected?L10n.Text("current_page"):""));
        button.Click+=(_,_)=>{if(!busy) onClick();};
        return button;
    }
    private void Link(string text,System.Action action) {
        HeaderAction.Text=text;HeaderAction.Visibility=Visibility.Visible;
        HeaderAction.MouseLeftButtonUp+=(_,_)=>action();
    }
    private static string Mbps(long bytesPerSecond)=>(bytesPerSecond*8/1_000_000.0).ToString("0.0",L10n.Culture);
    private static string Bytes(JsonNode? value) {double.TryParse(value?.ToString(),out var bytes);string[] units={"B","KB","MB","GB","TB"};var i=0;while(bytes>=1024&&i<units.Length-1){bytes/=1024;i++;}return $"{bytes:0.#} {units[i]}";}

    // ---- Pages ----
    private void Render() {
        ContentPanel.Children.Clear();NavigationPanel.Children.Clear();
        status=null;stats=null;power=null;mainButton=null;currentNode=null;
        // Replacing the header link drops the old click handler with the old element.
        var header=(DockPanel)HeaderAction.Parent;var link=new TextBlock {Foreground=Teal,Cursor=Cursors.Hand,VerticalAlignment=VerticalAlignment.Center,Padding=new Thickness(8,6,8,6),Visibility=Visibility.Collapsed};
        DockPanel.SetDock(link,Dock.Right);header.Children.Remove(HeaderAction);header.Children.Add(link);HeaderAction=link;
        Language=System.Windows.Markup.XmlLanguage.GetLanguage(L10n.Culture.IetfLanguageTag);
        if(announcement.Length>0) Add(new Border {Background=Mint,CornerRadius=new CornerRadius(12),Padding=new Thickness(12,8,12,8),Child=Label(announcement,13,color:Ink)});
        if(update is { } available) {
            Add(Label(L10n.Text("update_available",available.Version),15,true),4,2);
            Add(Label(L10n.Text(available.Mandatory?"update_required_detail":"update_available_detail"),13));
            Add(Action(L10n.Text("update_open_download"),()=>System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(available.Download.AbsoluteUri) {UseShellExecute=true}),primary:available.Mandatory));
        }
        NavigationPanel.Visibility=api.SignedIn?Visibility.Visible:Visibility.Collapsed;
        if(!api.SignedIn) {Link(L10n.Text("language"),ChooseLanguage);Login();return;}
        foreach(var (id,name) in new[]{("connect",L10n.Text("connect_tab")),("nodes",L10n.Text("locations")),("account",L10n.Text("account"))}) {
            var selected=page==id||(page=="logs"&&id=="account");
            var tab=new Button {Content=name,MinHeight=40,Margin=new Thickness(4,0,4,0),Background=selected?Mint:White,Foreground=selected?Teal:Muted};
            AutomationProperties.SetName(tab,name+(selected?L10n.Text("current_page"):""));
            tab.Click+=(_,_)=>{if(!busy){page=id;Render();}};NavigationPanel.Children.Add(tab);
        }
        switch(page) {
            case "connect":Home();break;
            case "nodes":Nodes();break;
            case "logs":Logs();break;
            default:Account();break;
        }
        UpdateLive();
    }
    /// Everything needed to connect fits in the window: state, current location, one button.
    private void Home() {
        power=Add(new Border {Width=88,Height=88,CornerRadius=new CornerRadius(44),Background=Mint,HorizontalAlignment=HorizontalAlignment.Center,
            Child=new TextBlock {Text="⏻",FontSize=34,Foreground=Teal,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center}},16,12);
        status=Add(new TextBlock {FontSize=19,FontWeight=FontWeights.Bold,Foreground=Ink,HorizontalAlignment=HorizontalAlignment.Center},0,2);
        stats=Add(new TextBlock {FontSize=12,Foreground=Muted,HorizontalAlignment=HorizontalAlignment.Center,Visibility=Visibility.Hidden},0,14);
        Add(Row("","",Teal,"›",Muted,false,()=>{page="nodes";Render();},out var title,out var detail,out var dot),0,8);
        currentNode=(title,detail,dot);
        if(update?.Mandatory!=true||connection.Active) {mainButton=Add(Action("",Toggle,primary:true));mainButton.MinHeight=46;}
    }
    private void Nodes() {
        Link(L10n.Text(measuring?"measuring_latency":"retest_latency"),()=>{});
        Add(Label(L10n.Text("locations"),17,true),0,6);
        RoutingChoice();
        var auto=Row(L10n.Text("automatic_recommended"),L10n.Text("auto_detail"),Teal,nodeId.Length==0?"✓":"",Teal,nodeId.Length==0,()=>Select("",""),out _,out _,out _);
        Add(auto,4,8);
        var list=new StackPanel();
        Work(async()=>{
            var nodes=(await api.Request("nodes"))["nodes"]!.AsArray();
            var ranked=new List<(JsonNode Node,Quality? Quality)>();
            foreach(var node in nodes) if(node is not null) ranked.Add((node,Latency.Recent.TryGetValue(node["id"]!.GetValue<string>(),out var known)?known:null));
            ranked=ranked.OrderBy(x=>x.Quality?.Score??long.MaxValue).ToList();
            if(nodes.Count==0) Add(Label(L10n.Text("no_locations_available_refresh_later_or_contact_your_administrator"),13));
            var query="";
            if(nodes.Count>6) {
                var search=Add(new TextBox());AutomationProperties.SetName(search,L10n.Text("search_locations_or_regions"));
                search.TextChanged+=(_,_)=>{query=search.Text;ShowNodes(list,ranked,query);};
            }
            ContentPanel.Children.Add(list);ShowNodes(list,ranked,query);
            async void Measure() {
                if(measuring) return;
                measuring=true;HeaderAction.Text=L10n.Text("measuring_latency");BusyBar.Visibility=Visibility.Visible;ShowNodes(list,ranked,query);
                try {ranked=(await Latency.Rank(nodes)).Select(x=>(x.Node,(Quality?)x.Quality)).ToList();} catch {/* keep the last results */}
                measuring=false;HeaderAction.Text=L10n.Text("retest_latency");if(!busy) BusyBar.Visibility=Visibility.Hidden;
                if(list.IsLoaded) ShowNodes(list,ranked,query);
            }
            HeaderAction.MouseLeftButtonUp+=(_,_)=>Measure();
            // Fresh results are kept for the session; opening the page again does not probe every node again.
            if(ranked.Any(x=>x.Quality is null)) Measure();
        });
    }
    private void ShowNodes(StackPanel list,List<(JsonNode Node,Quality? Quality)> ranked,string query) {
        list.Children.Clear();
        foreach(var (node,quality) in ranked) {
            var name=node["name"]!.GetValue<string>();var id=node["id"]!.GetValue<string>();var region=node["region"]?.GetValue<string>()??"";
            if(!(name+" "+region).Contains(query,StringComparison.OrdinalIgnoreCase)) continue;
            var load=quality?.Load??Latency.Load(node);
            var detail=string.Join(" · ",new[]{
                region.Length>0?region:null,
                quality is {Latency: not null}?L10n.Text("node_quality_detail",quality.Jitter.ToString("N0",L10n.Culture),quality.Loss.ToString("N0",L10n.Culture)):null,
                load is { } l?L10n.Text("node_load",l.ToString("N0",L10n.Culture)):null,
            }.Where(s=>s is not null));
            var trailing=quality is null?(measuring?"…":""):quality.Latency is { } ms?L10n.Text("latency_ms",ms.ToString("N0",L10n.Culture)):L10n.Text("quality_unreachable");
            var row=Row(name,detail,GradeColor(quality),trailing,quality is null?Muted:GradeColor(quality),id==nodeId,()=>Select(id,name),out _,out _,out _);
            row.Margin=new Thickness(0,0,0,6);list.Children.Add(row);
        }
        if(list.Children.Count==0&&ranked.Count>0) list.Children.Add(Label(L10n.Text("no_matching_locations_try_another_search"),13));
    }
    /// Smart (mainland China direct) or global routing; applies from the next connection.
    private void RoutingChoice() {
        var mode=Settings.Get("routing","smart");
        var choice=new UniformGrid {Rows=1};
        foreach(var (value,title) in new[]{("smart","routing_smart"),("global","routing_global")}) {
            var selected=value==mode;
            var button=new Button {Content=L10n.Text(title),MinHeight=34,Padding=new Thickness(6,4,6,4),Margin=new Thickness(2),Background=selected?Mint:White,Foreground=selected?Teal:Muted};
            AutomationProperties.SetName(button,L10n.Text(title)+(selected?L10n.Text("current_page"):""));
            button.Click+=(_,_)=>{if(!busy&&!selected) ChooseRouting(value);};
            choice.Children.Add(button);
        }
        Add(new Border {Background=White,CornerRadius=new CornerRadius(12),Padding=new Thickness(2),Child=choice},0,4);
        Add(Label(L10n.Text(mode=="smart"?"routing_smart_detail":"routing_global_detail"),12),0,4);
    }
    private void Account() {
        Add(Label(L10n.Text("my_veilbird"),17,true),0,6);
        Work(async()=>{
            var account=await api.Request("account");
            var card=new StackPanel();
            card.Children.Add(Label(account["name"]!.GetValue<string>(),15,true));
            card.Children.Add(Label(account["email"]!.GetValue<string>()+"\n"+L10n.Text("account_valid_until",L10n.Date(account["expiresAt"]?.GetValue<string>())),13));
            var traffic=account["traffic"];
            card.Children.Add(Label(L10n.Text("traffic_30_days")+"   ↑ "+Bytes(traffic?["uploadBytes"])+"   ↓ "+Bytes(traffic?["downloadBytes"]),13));
            Add(new Border {Background=White,CornerRadius=new CornerRadius(12),Padding=new Thickness(14,10,14,10),Child=card});
            Add(Label(L10n.Text("account_device_quota",account["used"]?.ToString()??"0",account["limit"]?.ToString()??"0"),15,true),6,2);
            Add(Label(L10n.Text("new_devices_are_added_on_their_first_connection_when"),12));
            foreach(var device in account["devices"]!.AsArray()) {
                if(device!["status"]!.GetValue<string>()=="revoked") continue;
                var current=device["isCurrent"]?.GetValue<bool>()==true;
                var revoking=device["status"]!.GetValue<string>()=="revoking";
                var row=Row(device["name"]!.GetValue<string>()+(current?L10n.Text("this_device"):""),revoking?L10n.Text("revoking_access_the_slot_is_released_in_about_5"):device["platform"]?.GetValue<string>()??"",Teal,revoking?"":L10n.Text("revoke_access"),Brush("#A33125"),false,()=>{
                    if(revoking) return;
                    if(MessageBox.Show(L10n.Text("this_device_will_lose_access_revoke_authorization"),"TrackNothing",MessageBoxButton.YesNo)!=MessageBoxResult.Yes) return;
                    Work(async()=>{await api.Action("revoke",new JsonObject {["enrollmentId"]=device["id"]!.GetValue<string>()});if(current) await connection.Disconnect();Render();});
                },out _,out _,out _);
                Add(row,0,6);
            }
            Add(Action(L10n.Text("language"),ChooseLanguage),4,6);
            Add(Action(L10n.Text("sign_out"),()=>{
                if(connection.Active) {Alert(L10n.Text("disconnect_the_vpn_before_signing_out"));return;}
                Work(async()=>{await api.Logout();Render();});
            },danger:true),0,6);
            // The diagnostic log has no visible entry: seven clicks on the version open it.
            var taps=0;var first=DateTime.MinValue;
            var version=Add(new TextBlock {Text=L10n.Text("version_label",System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3)??"0"),FontSize=11,Foreground=Muted,HorizontalAlignment=HorizontalAlignment.Center,Padding=new Thickness(12,6,12,6),Background=Brushes.Transparent},6,0);
            version.MouseLeftButtonUp+=(_,_)=>{
                if(DateTime.UtcNow-first>TimeSpan.FromSeconds(4)) {taps=0;first=DateTime.UtcNow;}
                if(++taps>=7) {taps=0;page="logs";Render();}
            };
        });
    }
    private void Logs() {
        Link(L10n.Text("back_action"),()=>{page="account";Render();});
        var log=Journal.Read();
        Add(Label(L10n.Text("logs_title"),17,true),0,4);
        Add(Label(L10n.Text("logs_detail"),12));
        var actions=new UniformGrid {Rows=1};
        var copy=Action(L10n.Text("copy_action"),()=>{try {Clipboard.SetText(log);} catch {/* clipboard busy */}});copy.IsEnabled=log.Length>0;copy.Margin=new Thickness(0,0,6,0);
        var clear=Action(L10n.Text("clear_action"),()=>{Journal.Clear();Render();},danger:true);
        actions.Children.Add(copy);actions.Children.Add(clear);Add(actions,0,8);
        // Newest first: the last attempt is what someone opening the log is looking for.
        Add(new Border {Background=White,CornerRadius=new CornerRadius(12),Padding=new Thickness(10,8,10,8),Child=new TextBox {
            Text=log.Length==0?L10n.Text("logs_empty"):string.Join("\n",log.Split('\n').Reverse()),IsReadOnly=true,BorderThickness=new Thickness(0),Background=Brushes.Transparent,
            FontFamily=new FontFamily("Consolas"),FontSize=11,TextWrapping=TextWrapping.Wrap,MinHeight=0,Padding=new Thickness(0)}});
    }
    private void Login() {
        Add(Label(L10n.Text("your_world_one_tap_away"),24,true),8,4);
        Add(Label(L10n.Text("sign_in_to_veilbird_no_imports_or_configuration_needed"),13),0,12);
        Add(Label(L10n.Text("server_address"),12),0,4);var origin=Add(new TextBox {Text=api.Origin});
        Add(Label(L10n.Text("email"),12),0,4);var email=Add(new TextBox());
        Add(Label(L10n.Text("password"),12),0,4);var password=Add(new PasswordBox());
        AutomationProperties.SetName(origin,L10n.Text("server_address"));AutomationProperties.SetName(email,L10n.Text("email"));AutomationProperties.SetName(password,L10n.Text("password"));
        var login=Add(Action(L10n.Text("sign_in_and_start"),()=>{
            if(string.IsNullOrWhiteSpace(email.Text)||password.Password.Length==0) {Alert(L10n.Text("enter_your_email_and_password"));return;}
            Work(async()=>{api.Origin=origin.Text.Trim();await api.Login(email.Text.Trim(),password.Password);password.Clear();page="connect";Render();CheckForUpdate();});
        },primary:true),6);
        login.IsDefault=true;
    }
    private void ChooseLanguage() {
        var values=new[]{"system","en","zh","ru"};var names=new[]{L10n.Text("language_system"),"English","简体中文","Русский"};
        var menu=new ContextMenu();
        for(var i=0;i<values.Length;i++) {
            var value=values[i];var item=new MenuItem {Header=names[i],IsCheckable=true,IsChecked=L10n.Preference==value};
            item.Click+=(_,_)=>{L10n.Select(value);Render();UpdateTray();};menu.Items.Add(item);
        }
        menu.IsOpen=true;
    }

    /// Live parts of the connect page, refreshed every second without rebuilding the page.
    private void UpdateLive() {
        var active=connection.Active;var connected=active&&connection.Since is not null;
        if(status is not null) status.Text=L10n.Text(connection.StatusKey);
        if(power is not null) {power.Background=connected?Teal:Mint;((TextBlock)power.Child).Foreground=connected?White:Teal;}
        if(stats is not null) {
            stats.Visibility=connected?Visibility.Visible:Visibility.Hidden;
            if(connection.Since is { } since) stats.Text=L10n.Text("connection_stats",(DateTime.UtcNow-since).ToString(@"hh\:mm\:ss"),Mbps(connection.RxRate),Mbps(connection.TxRate));
        }
        if(mainButton is not null) {mainButton.Content=L10n.Text(active?"disconnect_action":"connect_action");mainButton.IsEnabled=!busy||active;}
        if(currentNode is { } node) {
            var id=active?connection.NodeId:nodeId;
            var quality=id.Length>0&&Latency.Recent.TryGetValue(id,out var q)?q:null;
            node.Title.Text=active&&connection.NodeName.Length>0?connection.NodeName:nodeId.Length==0?L10n.Text("automatic_recommended"):nodeName;
            node.Detail.Text=quality is not null?Summary(quality):!active&&nodeId.Length==0?L10n.Text("auto_detail"):L10n.Text("tap_to_change");
            node.Detail.Visibility=Visibility.Visible;
            node.Dot.Fill=quality is null&&!active&&nodeId.Length==0?Teal:GradeColor(quality);
        }
    }
}
