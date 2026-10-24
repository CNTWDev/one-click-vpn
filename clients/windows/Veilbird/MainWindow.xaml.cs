using System.Windows;
using System.Windows.Controls;
using System.Text.Json.Nodes;
using System.Windows.Media;
using System.Windows.Automation;
using System.Windows.Threading;
namespace Veilbird;
public partial class MainWindow : Window {
    private readonly NativeApi api=new();
    private string page="connect",nodeId="",nodeName="";
    // Active connection: the lease is renewed every 90 s while the tunnel service carries traffic.
    private bool active,ticking;
    private string leaseNodeId="",leaseNodeName="",statusKey="not_connected",traffic="";
    private (string Public,string Private) keys;
    private DateTime deadline,renewAt,startedAt;
    private readonly DispatcherTimer timer=new() {Interval=TimeSpan.FromSeconds(5)};
    private bool busy;
    private (string Version,bool Mandatory,Uri Download)? update;
    private string announcement="";
    private static Brush Brush(string hex)=>(Brush)new BrushConverter().ConvertFromString(hex)!;
    public MainWindow() {
        L10n.Initialize();InitializeComponent();api.Origin=api.SavedOrigin;
        // A tunnel left by a crashed session has no lease any more: remove it before showing "not connected".
        try {Tunnel.Stop();} catch {/* nothing to clean up */}
        timer.Tick+=(_,_)=>Tick();
        Closing+=(_,_)=>{if(active)Disconnect("disconnected",wait:true);};
        Closed+=(_,_)=>api.Dispose();
        Render();CheckForUpdate();
    }
    private async Task<JsonObject> Acquire() {
        var input=new JsonObject {["publicKey"]=keys.Public};
        if(leaseNodeId.Length>0) input["nodeId"]=leaseNodeId;
        var lease=await api.Action("connect",input);
        leaseNodeId=lease["nodeId"]!.GetValue<string>();leaseNodeName=lease["nodeName"]?.GetValue<string>()??"";
        var remaining=DateTimeOffset.Parse(lease["expiresAt"]!.GetValue<string>(),System.Globalization.CultureInfo.InvariantCulture)-DateTimeOffset.UtcNow;
        if(remaining<=TimeSpan.Zero) throw new AccessFailure("ACCESS_EXPIRED");
        deadline=DateTime.UtcNow+(remaining<TimeSpan.FromMinutes(5)?remaining:TimeSpan.FromMinutes(5));renewAt=DateTime.UtcNow.AddSeconds(90);
        // The node applies the new peer within seconds; connect only once it reports ready.
        for(var attempt=0;attempt<15;attempt++) {
            if(DateTime.UtcNow>=deadline) throw new AccessFailure("ACCESS_EXPIRED");
            if((await api.Request("status/"+lease["leaseId"]!.GetValue<string>()))["ready"]?.GetValue<bool>()==true) return lease;
            await Task.Delay(1000);
        }
        throw new AccessFailure("NODE_UNAVAILABLE");
    }
    private void Connect()=>Work(async()=>{
        keys=Tunnel.NewKeypair();leaseNodeId=nodeId;statusKey="authorizing_and_connecting";Render();
        try {
            // Automatic: the fastest node measured from this PC, before the tunnel exists; if the list fails the server picks.
            if(leaseNodeId.Length==0) try {leaseNodeId=(await Latency.Rank((await api.Request("nodes"))["nodes"]!.AsArray())).FirstOrDefault().Node?["id"]?.GetValue<string>()??"";} catch {/* least-loaded fallback */}
            var lease=await Acquire();
            await Task.Run(()=>Tunnel.Start(lease,keys.Private));
        } catch(Exception error) {
            await api.Report(error is AccessFailure failure?failure.Code:"CONNECT_FAILED",leaseNodeId);
            await Task.Run(Tunnel.Stop);statusKey="not_connected";
            if(error is AccessFailure) throw;
            throw new AccessFailure("CONNECT_FAILED");
        }
        active=true;startedAt=DateTime.UtcNow;statusKey="confirming_connection_status";timer.Start();
    });
    private async void Tick() {
        if(!active||ticking) return;
        ticking=true;
        try {await Check();} finally {ticking=false;}
    }
    private async Task Check() {
        if(DateTime.UtcNow>=renewAt||DateTime.UtcNow>=deadline) {
            renewAt=DateTime.UtcNow.AddSeconds(15);
            try {await Acquire();}
            catch(AccessFailure error) when (error.Code is "AUTH_REQUIRED" or "DEVICE_REVOKED" or "MEMBERSHIP_EXPIRED" or "ACCOUNT_UNAVAILABLE" or "MANAGED_ACCESS_REQUIRED" or "CLIENT_UPDATE_REQUIRED") {
                await api.Report(error.Code,leaseNodeId);Disconnect("connection_authorization_expired_connect_again");MessageBox.Show(error.Message,"Veilbird");return;
            }
            catch {/* retried in 15 s until the lease runs out */}
            if(!active) return;
            if(DateTime.UtcNow>=deadline) {await api.Report("LEASE_RENEWAL_FAILED",leaseNodeId);Disconnect("connection_authorization_expired_connect_again");return;}
        }
        if(!Tunnel.Running) {await api.Report("TUNNEL_ERROR",leaseNodeId);Disconnect("connection_interrupted_try_again");return;}
        var stats=Tunnel.Stats();
        if(stats is { Handshake: { } handshake } && DateTime.UtcNow-handshake<TimeSpan.FromMinutes(3)) statusKey="connected_status";
        else {
            statusKey="confirming_connection_status";
            if(DateTime.UtcNow-startedAt>TimeSpan.FromSeconds(45)) {await api.Report("HANDSHAKE_TIMEOUT",leaseNodeId);Disconnect("this_location_is_not_responding_try_another");return;}
        }
        traffic=stats is { } s?$"↑ {Bytes((double)s.Tx)}   ↓ {Bytes((double)s.Rx)}":"";
        if(page=="connect"&&!busy) Render();
    }
    private void Disconnect(string message,bool wait=false) {
        active=false;timer.Stop();statusKey=message;traffic="";
        var stop=Task.Run(()=>{try {Tunnel.Stop();} catch {/* already gone */}});
        // Off the UI thread, so closing the window can wait for it without a deadlock.
        var release=Task.Run(()=>api.Action("disconnect",new JsonObject()));
        if(wait) {try {Task.WaitAll([stop,release],TimeSpan.FromSeconds(5));} catch {/* the lease also expires on its own */}}
        else _=release.ContinueWith(_=>{},TaskScheduler.Default);
        if(!wait&&IsLoaded) Render();
    }
    private async void CheckForUpdate() {
        try {
            if(await api.LatestRelease() is not { } found) return;
            if(found.Update?.Version!=update?.Version||found.Announcement!=announcement){update=found.Update;announcement=found.Announcement;if(!busy)Render();}
        } catch {/* checked again on next launch */}
    }
    private void Text(string value,int size=16)=>ContentPanel.Children.Add(new TextBlock {Text=value,FontSize=size,FontWeight=size>=22?FontWeights.Bold:FontWeights.Normal,Foreground=Brush(size>=22?"#182731":"#5B6970"),TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,8,0,16)});
    private void Card(string title,string detail) {
        var body=new StackPanel();body.Children.Add(new TextBlock {Text=title,FontSize=22,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,10)});
        body.Children.Add(new TextBlock {Text=detail,FontSize=15,Foreground=Brush("#5B6970"),LineHeight=24,TextWrapping=TextWrapping.Wrap});
        ContentPanel.Children.Add(new Border {Background=Brush("#FFFFFF"),CornerRadius=new CornerRadius(24),Padding=new Thickness(24),Margin=new Thickness(0,8,0,16),Child=body});
    }
    private Button Button(string title,Action action,bool enabled=true) {var button=new Button {Content=title,MinHeight=46,Padding=new Thickness(16,10,16,10),Margin=new Thickness(0,5,0,5),IsEnabled=enabled};button.Click+=(_,_)=>{if(!busy)action();};ContentPanel.Children.Add(button);return button;}
    private async void Work(Func<Task> action) {
        if(busy)return;busy=true;ContentPanel.IsEnabled=false;NavigationPanel.IsEnabled=false;BusyBanner.Visibility=Visibility.Visible;
        try {await action();}
        catch(Exception error) {if(error is AccessFailure {Code:"CLIENT_UPDATE_REQUIRED"})CheckForUpdate();MessageBox.Show(error is AccessFailure?error.Message:L10n.Text("unable_to_reach_the_service_check_your_network_and"),"Veilbird");}
        finally {busy=false;ContentPanel.IsEnabled=true;NavigationPanel.IsEnabled=true;BusyBanner.Visibility=Visibility.Collapsed;}
    }
    private void Render() {
        ContentPanel.Children.Clear();NavigationPanel.Children.Clear();Text("Veilbird",22);
        Title="Veilbird";BusyLabel.Text=L10n.Text("working");Language=System.Windows.Markup.XmlLanguage.GetLanguage(L10n.Culture.IetfLanguageTag);
        Text(L10n.Text("language"),14);
        var languages=new[]{"system","en","zh","ru"};
        var picker=new ComboBox {ItemsSource=new[]{L10n.Text("language_system"),"English","简体中文","Русский"},SelectedIndex=Array.IndexOf(languages,L10n.Preference),MinHeight=44,Margin=new Thickness(0,0,0,12)};
        AutomationProperties.SetName(picker,L10n.Text("language"));
        picker.SelectionChanged+=(_,_)=>{if(!busy&&picker.SelectedIndex>=0){L10n.Select(languages[picker.SelectedIndex]);Render();}};
        ContentPanel.Children.Add(picker);
        if(announcement.Length>0) Card(L10n.Text("announcement"),announcement);
        if(update is { } available) {
            Card(L10n.Text("update_available",available.Version),L10n.Text(available.Mandatory?"update_required_detail":"update_available_detail"));
            Button(L10n.Text("update_open_download"),()=>System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(available.Download.AbsoluteUri) {UseShellExecute=true}));
        }
        NavigationPanel.Visibility=api.SignedIn?Visibility.Visible:Visibility.Collapsed;
        if(!api.SignedIn) {Login();return;}
        foreach(var (id,name) in new[]{("connect",L10n.Text("connect_tab")),("nodes",L10n.Text("locations")),("account",L10n.Text("account"))}) {var b=new Button {Content=name,MinHeight=52,Margin=new Thickness(4),Background=Brush(page==id?"#E2F7F0":"#FFFFFF")};AutomationProperties.SetName(b,name+(page==id?L10n.Text("current_page"):""));b.Click+=(_,_)=>{if(!busy){page=id;Render();}};NavigationPanel.Children.Add(b);}
        if(page=="connect") {
            Text(L10n.Text("connect_with_ease"),32);Text(L10n.Text("choose_a_location_veilbird_takes_care_of_the_rest"));
            Card(L10n.Text(statusKey),active?$"{leaseNodeName}\n{traffic}".Trim():L10n.Text("a_location_is_selected_automatically_allow_the_system_vpn"));
            if(update?.Mandatory!=true||active) {
                var main=Button(L10n.Text(active?"disconnect_action":"connect_action"),()=>{if(active)Disconnect("disconnected");else Connect();});
                main.Background=Brush("#007A64");main.Foreground=Brush("#FFFFFF");main.MinHeight=56;
            }
            Card(L10n.Text("location"),string.IsNullOrEmpty(nodeName)?L10n.Text("automatic_recommended"):nodeName);
            Button(L10n.Text("change_location"),()=>{if(active)MessageBox.Show(L10n.Text("disconnect_before_changing_location"),"Veilbird");else{page="nodes";Render();}});
        } else if(page=="nodes") Work(async()=>{
            Text(L10n.Text("where_would_you_like_to_connect"),30);Text(L10n.Text("choose_a_location_then_return_to_connect"));
            var result=await api.Request("nodes");Button(L10n.Text("automatic_recommended"),()=>{nodeId="";nodeName="";page="connect";Render();});
            Text(L10n.Text("search_locations_or_regions"),14);var search=new TextBox {Margin=new Thickness(0,8,0,16)};AutomationProperties.SetName(search,L10n.Text("search_locations_or_regions"));ContentPanel.Children.Add(search);
            var list=new StackPanel();ContentPanel.Children.Add(list);
            var ranked=await Latency.Rank(result["nodes"]!.AsArray());
            void Filter() {list.Children.Clear();foreach(var (node,ms) in ranked) {var name=node["name"]!.GetValue<string>();var id=node["id"]!.GetValue<string>();var region=node["region"]?.GetValue<string>()??"";if(!(name+" "+region).Contains(search.Text,StringComparison.OrdinalIgnoreCase))continue;
                var item=new Button {Content=name+(ms is { } latency?"  ·  "+L10n.Text("latency_ms",latency.ToString("N0",L10n.Culture)):"")+(name==nodeName?"  ✓":"  ›"),HorizontalContentAlignment=HorizontalAlignment.Left,Background=Brush(name==nodeName?"#E2F7F0":"#FFFFFF"),Margin=new Thickness(0,0,0,12)};item.Click+=(_,_)=>{nodeId=id;nodeName=name;page="connect";Render();};list.Children.Add(item);}
                if(list.Children.Count==0)list.Children.Add(new TextBlock {Text=L10n.Text("no_matching_locations_change_your_search_or_refresh_later"),Margin=new Thickness(0,16,0,16)});
            } Filter();search.TextChanged+=(_,_)=>Filter();Button(L10n.Text("refresh_locations"),()=>Render());
        });
        else Work(async()=>{
            Text(L10n.Text("my_veilbird"),30);Text(L10n.Text("your_account_usage_and_devices_in_one_place"));
            var account=await api.Request("account");Card(account["name"]!.GetValue<string>(),account["email"]!.GetValue<string>()+L10n.Text("valid_until")+L10n.Date(account["expiresAt"]?.GetValue<string>()));
            var traffic=account["traffic"];Card(L10n.Text("traffic_30_days"),$"↑ {Bytes(traffic?["uploadBytes"])}    ↓ {Bytes(traffic?["downloadBytes"])}");
            Text(L10n.Text("account_device_quota",account["used"]?.ToString()??"0",account["limit"]?.ToString()??"0"),22);Text(L10n.Text("new_devices_are_added_on_their_first_connection_when"),14);
            foreach(var device in account["devices"]!.AsArray()) {
                if(device!["status"]!.GetValue<string>()=="revoked")continue;
                Text(device["name"]!.GetValue<string>()+(device["isCurrent"]!.GetValue<bool>()?L10n.Text("this_device"):""));
                if(device["status"]!.GetValue<string>()=="revoking")Text(L10n.Text("revoking_access_the_slot_is_released_in_about_5"));
                else Button(L10n.Text("revoke_access"),()=>{if(MessageBox.Show(L10n.Text("this_device_will_lose_access_revoke_authorization"),"Veilbird",MessageBoxButton.YesNo)==MessageBoxResult.Yes)Work(async()=>{await api.Action("revoke",new JsonObject {["enrollmentId"]=device["id"]!.GetValue<string>()});page="connect";Render();});});
            }
            Button(L10n.Text("refresh_devices"),()=>Render());Button(L10n.Text("sign_out"),()=>{if(active){MessageBox.Show(L10n.Text("disconnect_the_vpn_before_signing_out"),"Veilbird");return;}Work(async()=>{await api.Logout();Render();});});
        });
    }
    private void Login() {
        Text(L10n.Text("your_world_one_tap_away"),36);Text(L10n.Text("sign_in_to_veilbird_no_imports_or_configuration_needed"));
        Card(L10n.Text("your_location_your_connection"),L10n.Text("connect_automatically_or_choose_your_own_location"));
        Text(L10n.Text("server_address"));var origin=new TextBox {Text=api.Origin,MinHeight=36};ContentPanel.Children.Add(origin);
        Text(L10n.Text("email"));var email=new TextBox {MinHeight=36};ContentPanel.Children.Add(email);
        Text(L10n.Text("password"));var password=new PasswordBox {MinHeight=36};ContentPanel.Children.Add(password);
        AutomationProperties.SetName(origin,L10n.Text("server_address"));AutomationProperties.SetName(email,L10n.Text("email"));AutomationProperties.SetName(password,L10n.Text("password"));
        var login=Button(L10n.Text("sign_in_and_start"),()=>{if(string.IsNullOrWhiteSpace(email.Text)||password.Password.Length==0){MessageBox.Show(L10n.Text("enter_your_email_and_password"),"Veilbird");return;}Work(async()=>{api.Origin=origin.Text.Trim();await api.Login(email.Text.Trim(),password.Password);password.Clear();page="connect";Render();CheckForUpdate();});});login.Background=Brush("#007A64");login.Foreground=Brush("#FFFFFF");login.IsDefault=true;
    }
    private static string Bytes(JsonNode? value) {double.TryParse(value?.ToString(),out var bytes);return Bytes(bytes);}
    private static string Bytes(double bytes) {string[] units={"B","KB","MB","GB","TB"};var i=0;while(bytes>=1024&&i<units.Length-1){bytes/=1024;i++;}return $"{bytes:0.#} {units[i]}";}
}
