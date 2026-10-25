using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using Forms=System.Windows.Forms;
namespace Veilbird;

/// <summary>
/// A small fixed-size tool window with three pages (connect, locations, account) and a tray icon whose flyout
/// carries the quick actions. Closing the window keeps TrackNothing running in the tray; Quit exits.
/// </summary>
public partial class MainWindow : Window {
    private readonly NativeApi api=new();
    private readonly Core core=new();
    private readonly Connection connection;
    private readonly Forms.NotifyIcon tray=new();
    private string page="connect",nodeId=Settings.Get("nodeId"),nodeName=Settings.Get("nodeName");
    private bool busy,measuring,quitting,trayHintShown,failed,showPassword;
    private string failure="";
    private (string Version,bool Mandatory,Uri Download)? update;
    private string announcement="";
    private readonly DispatcherTimer refresh=new() {Interval=TimeSpan.FromSeconds(1)},toastTimer=new() {Interval=TimeSpan.FromSeconds(5)};
    private string lastView="";
    // The last account summary and location list, so pages show at once and refresh quietly.
    private JsonNode? accountData;
    private JsonArray? nodesData;
    private readonly Dictionary<string,(string Name,string Code)> directory=new();
    // Live parts of the connect page and the tray flyout.
    private Ring? ring;
    private Button? ringButton;
    private TextBlock? statusTitle,statusDetail,statusTimer,stream,usageTotal,usageUntil;
    private Rectangle? statusDot;
    private (ContentControl Badge,TextBlock Title,TextBlock Detail)? location;
    private string badgeKey="";
    private Window? flyout;
    private DateTime flyoutHidden=DateTime.MinValue;
    private (Border Card,ContentControl Mark,TextBlock Title,TextBlock Detail,ToggleButton Switch,ContentControl Badge,TextBlock Location,TextBlock LocationDetail,TextBlock Usage,TextBlock Until)? fly;
    private RingState? flyState;
    // Follows the Windows "Show animations" setting.
    private static bool Motion=>SystemParameters.ClientAreaAnimation;
    private static bool Smart=>Settings.Get("routing","smart")=="smart";

    public MainWindow() {
        L10n.Initialize();InitializeComponent();api.Origin=api.SavedOrigin;
        TitleLogo.Content=Look.Mark(16,Look.Accent);
        connection=new Connection(api,core);
        connection.Changed+=()=>Dispatcher.InvokeAsync(()=>{UpdateLive();UpdateTray();});
        refresh.Tick+=(_,_)=>UpdateLive();refresh.Start();
        toastTimer.Tick+=(_,_)=>{toastTimer.Stop();Toast.Visibility=Visibility.Collapsed;};
        Toast.MouseLeftButtonUp+=(_,_)=>{toastTimer.Stop();Toast.Visibility=Visibility.Collapsed;};
        SourceInitialized+=(_,_)=>DarkFrame();
        SetupTray();
        Closing+=OnClosing;
        Render();CheckForUpdate(false);
    }

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window,int attribute,ref int value,int size);
    /// Dark window frame and Windows 11's rounded corners; older Windows ignores both.
    private void DarkFrame() {
        try {
            var handle=new WindowInteropHelper(this).Handle;
            int dark=1,round=2;
            DwmSetWindowAttribute(handle,20,ref dark,sizeof(int));DwmSetWindowAttribute(handle,33,ref round,sizeof(int));
        } catch {/* not available */}
    }
    private void OnMinimizeClick(object sender,RoutedEventArgs e)=>WindowState=WindowState.Minimized;
    private void OnCloseClick(object sender,RoutedEventArgs e)=>Close();
    // ---- Actions ----
    private void Toggle() {
        if(connection.Active) {_=connection.Disconnect();return;}
        if(!api.SignedIn) {ShowFromTray();return;}
        if(update?.Mandatory==true) {ShowFromTray();Notify(L10n.Text("update_required_detail"));return;}
        failed=false;
        // A failed attempt shows on the ring (coral, with a retry arrow) rather than in a dialog.
        Work(async()=>{
            try {await connection.Connect(nodeId,Smart);}
            catch(AccessFailure error) when (error.Code is not ("AUTH_REQUIRED" or "CLIENT_UPDATE_REQUIRED" or "DEVICE_LIMIT_REACHED")) {failed=true;failure=error.Message;}
        });
    }
    private void ChooseRouting(string value) {
        if(connection.Active) {Notify(L10n.Text("disconnect_before_changing_routing"));return;}
        Settings.Set("routing",value);if(page=="nodes") Render();
    }
    private void Select(string id,string name) {
        if(connection.Active) {Notify(L10n.Text("disconnect_before_selecting_another_location"));return;}
        nodeId=id;nodeName=name;Settings.Set("nodeId",id);Settings.Set("nodeName",name);failed=false;page="connect";Render();
    }
    private async void CheckForUpdate(bool announce) {
        try {
            if(await api.LatestRelease() is not { } found) return;
            if(found.Update?.Version!=update?.Version||found.Announcement!=announcement) {update=found.Update;announcement=found.Announcement;if(!busy) Render();}
            if(announce&&update is null) Notify(L10n.Text("up_to_date"));
        } catch {/* checked again on next launch */}
    }
    private async void Work(Func<Task> action) {
        if(busy) return;
        busy=true;BusyBar.Visibility=Visibility.Visible;NavigationPanel.IsEnabled=false;
        try {await action();}
        catch(Exception error) {
            if(error is AccessFailure {Code:"AUTH_REQUIRED"}) {await api.Logout().ContinueWith(_=>{});Render();}
            if(error is AccessFailure {Code:"CLIENT_UPDATE_REQUIRED"}) CheckForUpdate(false);
            Notify(error is AccessFailure?error.Message:L10n.Text("unable_to_reach_the_service_check_your_network_and"));
        }
        finally {busy=false;NavigationPanel.IsEnabled=true;if(!measuring) BusyBar.Visibility=Visibility.Hidden;UpdateLive();}
    }
    /// A short note at the bottom of the window that goes away by itself.
    private void Notify(string message) {
        ToastText.Text=message;Toast.Visibility=Visibility.Visible;toastTimer.Stop();toastTimer.Start();
        if(!IsVisible) tray.ShowBalloonTip(3000,"TrackNothing",message,Forms.ToolTipIcon.None);
    }
    private async Task<JsonArray> LoadNodes() {
        var nodes=(await api.Request("nodes"))["nodes"]!.AsArray();
        nodesData=nodes;
        foreach(var node in nodes) {
            if(node?["id"]?.GetValue<string>() is not { } id) continue;
            var name=node["name"]?.GetValue<string>()??"";
            var code=node["countryCode"]?.GetValue<string>() is { Length: >0 } country?country.ToUpperInvariant():name.Length>0?name[..1].ToUpperInvariant():"";
            directory[id]=(name,code);
        }
        return nodes;
    }
    private async Task RefreshAccount() {
        try {var data=await api.Request("account");accountData=data;ShowUsage();UpdateFlyout();}
        catch {/* usage is a nicety; the next visit retries */}
    }

    // ---- Building blocks ----
    private static TextBlock Words(string text,double size=14,Brush? color=null,bool strong=false,double top=0,double bottom=0)=>
        new() {Text=text,FontSize=size,Foreground=color??Look.Text,FontWeight=strong?FontWeights.SemiBold:FontWeights.Normal,Margin=new Thickness(0,top,0,bottom)};
    private static TextBlock Single(string text,double size,Brush? color=null,bool strong=false)=>
        new() {Text=text,FontSize=size,Foreground=color??Look.Text,FontWeight=strong?FontWeights.SemiBold:FontWeights.Normal,TextWrapping=TextWrapping.NoWrap,TextTrimming=TextTrimming.CharacterEllipsis,VerticalAlignment=VerticalAlignment.Center};
    private T Add<T>(T element,double top=0,double bottom=0) where T:FrameworkElement {element.Margin=new Thickness(element.Margin.Left,top,element.Margin.Right,bottom);ContentPanel.Children.Add(element);return element;}
    private static TextBlock Caption(string text)=>new() {Text=text,FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(4,0,4,0)};
    /// Left item, a stretching middle, and a right item.
    private static Grid Columns(UIElement left,UIElement middle,UIElement? right=null) {
        var grid=new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});grid.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});grid.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});
        grid.Children.Add(left);Grid.SetColumn(middle,1);grid.Children.Add(middle);
        if(right is not null) {Grid.SetColumn(right,2);grid.Children.Add(right);}
        return grid;
    }
    private static StackPanel TwoLines(string title,string detail,double size=14,bool strong=false) {
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,8,0)};
        texts.Children.Add(Single(title,size,strong:strong));
        if(detail.Length>0) {var line=Single(detail,12,Look.Secondary);line.Margin=new Thickness(0,2,0,0);texts.Children.Add(line);}
        return texts;
    }
    /// A card of rows separated by hairlines that start after the badge.
    private static Border Card(IEnumerable<FrameworkElement> rows,double inset=54) {
        var stack=new StackPanel();var first=true;
        foreach(var row in rows) {
            if(!first) stack.Children.Add(new Border {Height=1,Background=Look.Hairline,Margin=new Thickness(inset,0,0,0)});
            stack.Children.Add(row);first=false;
        }
        return new Border {Background=Look.Surface,CornerRadius=new CornerRadius(8),Child=stack};
    }
    private static Button Primary(string title)=>new() {Content=title,Height=40,Background=Look.Accent,Foreground=Look.OnAccent,FontWeight=FontWeights.SemiBold,HorizontalContentAlignment=HorizontalAlignment.Center};
    private static Button Plain(string title,Brush? color=null)=>new() {Content=title,Height=36,Background=Look.Surface,Foreground=color??Look.Text,FontSize=13,HorizontalContentAlignment=HorizontalAlignment.Center};
    /// Label-over-value cells side by side.
    private static Grid Cells(params (string Key,TextBlock Value,double Size)[] cells) {
        var grid=new Grid();
        foreach(var (key,value,size) in cells) {
            grid.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});
            var cell=new StackPanel {Margin=new Thickness(0,0,12,0)};
            cell.Children.Add(Single(L10n.Text(key),size,Look.Secondary));
            value.Margin=new Thickness(0,3,0,0);value.TextWrapping=TextWrapping.NoWrap;value.TextTrimming=TextTrimming.CharacterEllipsis;cell.Children.Add(value);
            Grid.SetColumn(cell,grid.ColumnDefinitions.Count-1);grid.Children.Add(cell);
        }
        return grid;
    }
    private static string Mbps(long bytesPerSecond)=>(bytesPerSecond*8/1_000_000.0).ToString("0.0",L10n.Culture);
    private static long Number(JsonNode? value)=>long.TryParse(value?.ToString(),out var number)?number:0;
    private static string Bytes(long value) {double bytes=value;string[] units={"B","KB","MB","GB","TB"};var i=0;while(bytes>=1024&&i<units.Length-1){bytes/=1024;i++;}return bytes.ToString(i==0?"0":"0.#",L10n.Culture)+" "+units[i];}
    private static string? Ms(Quality? quality)=>quality?.Latency is { } ms?L10n.Text("latency_ms",ms.ToString("N0",L10n.Culture)):null;
    private static string Summary(Quality quality)=>Ms(quality) is { } ms?ms+" · "+L10n.Text(quality.Grade):L10n.Text(quality.Grade);
    private static (int,Brush) Signal(Quality quality)=>quality.Grade switch {"quality_good"=>(3,Look.Accent),"quality_fair"=>(2,Look.Fair),_=>(1,Look.Danger)};
    private string Code(string id,string name)=>directory.TryGetValue(id,out var known)&&known.Code.Length>0?known.Code:name.Length>0?name[..1].ToUpperInvariant():"";
    private Button IconButton(string glyph,string label,System.Action onClick) {
        var button=new Button {Width=32,Height=32,Padding=new Thickness(0),Content=Look.Icon(glyph,14,Look.Secondary),HorizontalContentAlignment=HorizontalAlignment.Center};
        AutomationProperties.SetName(button,label);button.Click+=(_,_)=>onClick();
        return button;
    }
}
