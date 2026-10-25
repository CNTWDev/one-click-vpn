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

    // ---- Tray ----
    private void SetupTray() {
        using(var stream=Application.GetResourceStream(new Uri("pack://application:,,,/Assets/Veilbird.ico")).Stream) tray.Icon=new System.Drawing.Icon(stream);
        tray.Visible=true;tray.ContextMenuStrip=new Forms.ContextMenuStrip();
        tray.ContextMenuStrip.Opening+=(_,_)=>BuildTrayMenu();
        tray.MouseClick+=(_,e)=>{if(e.Button==Forms.MouseButtons.Left) ToggleFlyout();};
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
    public void ShowFromTray() {flyout?.Hide();Show();if(WindowState==WindowState.Minimized) WindowState=WindowState.Normal;Activate();}
    private void OnClosing(object? sender,CancelEventArgs e) {
        if(quitting) return;
        e.Cancel=true;Hide();
        if(!trayHintShown) {trayHintShown=true;tray.ShowBalloonTip(3000,"TrackNothing",L10n.Text("running_in_tray"),Forms.ToolTipIcon.None);}
    }
    private async void Quit() {
        quitting=true;tray.Visible=false;flyout?.Close();
        try {await connection.Disconnect().WaitAsync(TimeSpan.FromSeconds(8));} catch {/* exiting anyway */}
        core.Dispose();api.Dispose();tray.Dispose();
        Application.Current.Shutdown();
    }

    /// The tray flyout: one switch, the location, usage, and the way back to the window.
    private void ToggleFlyout() {
        if(!api.SignedIn) {ShowFromTray();return;}
        // A click on the icon while the flyout is open first closes it (it loses focus): do not reopen it at once.
        if(flyout?.IsVisible==true||DateTime.UtcNow-flyoutHidden<TimeSpan.FromMilliseconds(300)) {flyout?.Hide();return;}
        flyout??=BuildFlyout();
        var area=SystemParameters.WorkArea;
        flyout.Left=area.Right-flyout.Width-12;flyout.Top=area.Bottom-flyout.Height-12;
        flyState=null;UpdateFlyout();
        flyout.Show();flyout.Activate();
        _=RefreshAccount();
    }
    private Window BuildFlyout() {
        var window=new Window {Width=300,Height=400,WindowStyle=WindowStyle.None,AllowsTransparency=true,Background=Brushes.Transparent,ResizeMode=ResizeMode.NoResize,ShowInTaskbar=false,Topmost=true,
            FontFamily=FontFamily,UseLayoutRounding=true,Title="TrackNothing"};
        window.Deactivated+=(_,_)=>{if(window.IsVisible) {window.Hide();flyoutHidden=DateTime.UtcNow;}};
        var root=new DockPanel {LastChildFill=false};
        var header=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(0,0,0,14)};
        var word=Look.Wordmark(14);word.Margin=new Thickness(8,0,0,0);header.Children.Add(Look.Mark(16,Look.Accent));header.Children.Add(word);
        DockPanel.SetDock(header,Dock.Top);root.Children.Add(header);

        var mark=new ContentControl {Width=40,Height=40};
        var title=new TextBlock {FontSize=18,FontWeight=FontWeights.SemiBold,TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var detail=new TextBlock {FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(0,3,0,0),TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var toggle=new ToggleButton {Style=(Style)FindResource("Switch"),VerticalAlignment=VerticalAlignment.Center};
        toggle.Click+=(_,_)=>{Toggle();toggle.IsChecked=connection.Active;};
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(14,0,12,0)};texts.Children.Add(title);texts.Children.Add(detail);
        var card=new Border {CornerRadius=new CornerRadius(8),Padding=new Thickness(16),BorderThickness=new Thickness(1),Child=Columns(mark,texts,toggle)};
        DockPanel.SetDock(card,Dock.Top);root.Children.Add(card);

        var badge=new ContentControl();
        var place=new TextBlock {FontSize=13,FontWeight=FontWeights.SemiBold,TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var placeDetail=new TextBlock {FontSize=11,Foreground=Look.Secondary,Margin=new Thickness(0,2,0,0),TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var placeTexts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,8,0)};placeTexts.Children.Add(place);placeTexts.Children.Add(placeDetail);
        var placeRow=new Button {Height=52,Padding=new Thickness(12,0,12,0),Background=Look.Hex("#1A221C"),Margin=new Thickness(0,14,0,0),Content=Columns(badge,placeTexts,Look.Icon("",10,Look.Secondary))};
        placeRow.Click+=(_,_)=>{page="nodes";Render();ShowFromTray();};
        DockPanel.SetDock(placeRow,Dock.Top);root.Children.Add(placeRow);

        var usage=new TextBlock {Text="—",FontSize=13,FontWeight=FontWeights.SemiBold};var until=new TextBlock {Text="—",FontSize=13,FontWeight=FontWeights.SemiBold};
        var cells=Cells(("last_30_days",usage,11),("valid_until_label",until,11));cells.Margin=new Thickness(4,14,4,0);
        DockPanel.SetDock(cells,Dock.Top);root.Children.Add(cells);

        var footer=new DockPanel {LastChildFill=false};
        var open=new Button {Content=L10n.Text("open_main_window"),FontSize=13,Height=32,Padding=new Thickness(10,0,10,0)};open.Click+=(_,_)=>ShowFromTray();
        var quit=new Button {Content=L10n.Text("quit_app"),FontSize=13,Height=32,Padding=new Thickness(10,0,10,0),Foreground=Look.Secondary};quit.Click+=(_,_)=>Quit();
        DockPanel.SetDock(open,Dock.Left);DockPanel.SetDock(quit,Dock.Right);footer.Children.Add(open);footer.Children.Add(quit);
        var bottom=new Border {BorderBrush=Look.Hex("#14ECF1E8"),BorderThickness=new Thickness(0,1,0,0),Padding=new Thickness(0,10,0,0),Child=footer};
        DockPanel.SetDock(bottom,Dock.Bottom);root.Children.Add(bottom);

        window.Content=new Border {Background=Look.Hex("#121915"),BorderBrush=Look.Edge,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(8),Padding=new Thickness(16),Child=root};
        TextElement.SetForeground(window,Look.Text);
        fly=(card,mark,title,detail,toggle,badge,place,placeDetail,usage,until);
        return window;
    }
    private void UpdateFlyout() {
        if(fly is not { } f||flyout?.IsVisible!=true&&flyState is not null) return;
        var state=State();
        if(state!=flyState) {
            flyState=state;
            var on=state==RingState.Connected;
            f.Card.Background=on?Look.Hex("#17221A"):Look.Surface;f.Card.BorderBrush=on?Look.Hex("#4DB7DC68"):Look.Hairline;
            f.Mark.Content=Look.Mark(34,state switch {RingState.Idle=>Look.Faint,RingState.Failed=>Look.Danger,_=>Look.Accent});
        }
        f.Title.Text=StatusTitle(state);f.Detail.Text=StatusDetail(state);
        f.Switch.IsChecked=connection.Active;f.Switch.IsEnabled=!busy||connection.Active;
        var place=Location();
        f.Badge.Content=Look.Badge(place.Code,28);f.Location.Text=place.Title;f.LocationDetail.Text=place.Detail;
        ShowFigures(f.Usage,f.Until);
    }

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
    private static string DeviceLimit(JsonNode account)=>account["limit"] is null?L10n.Text("devices_unlimited"):Number(account["limit"]).ToString("N0",L10n.Culture);
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

    // ---- Pages ----
    private void Render() {
        ContentPanel.Children.Clear();FullPanel.Children.Clear();NavigationPanel.Children.Clear();HeaderSlot.Content=null;
        ring=null;ringButton=null;statusTitle=statusDetail=statusTimer=stream=usageTotal=usageUntil=null;statusDot=null;location=null;badgeKey="";
        var view=api.SignedIn?page:"login";
        var full=view=="connect";
        Scroller.Visibility=full?Visibility.Collapsed:Visibility.Visible;FullPanel.Visibility=full?Visibility.Visible:Visibility.Collapsed;
        if(view!=lastView) {Scroller.ScrollToTop();Enter(full?FullPanel:ContentPanel);}
        lastView=view;
        Language=System.Windows.Markup.XmlLanguage.GetLanguage(L10n.Culture.IetfLanguageTag);
        if(!api.SignedIn) {
            // Before sign-in the only language entry is this small globe; afterwards it is a row on the account page.
            accountData=null;nodesData=null;
            var globe=new StackPanel {Orientation=Orientation.Horizontal};
            globe.Children.Add(Look.Icon("",13,Look.Secondary));globe.Children.Add(new TextBlock {Text=LanguageName(L10n.Preference=="system"?L10n.Culture.TwoLetterISOLanguageName:L10n.Preference),FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(6,0,0,0),VerticalAlignment=VerticalAlignment.Center});
            var button=new Button {Content=globe,Height=32,Padding=new Thickness(10,0,10,0)};
            AutomationProperties.SetName(button,L10n.Text("language")+": "+LanguageName(L10n.Preference));
            button.Click+=(_,_)=>ChooseLanguage(button);HeaderSlot.Content=button;
            Login();return;
        }
        foreach(var (id,key) in new[]{("connect","connect_tab"),("nodes","locations"),("account","account")}) {
            var selected=page==id||(page is "logs" or "devices"&&id=="account");
            var label=new TextBlock {Text=L10n.Text(key),FontSize=14,FontWeight=selected?FontWeights.SemiBold:FontWeights.Normal,Foreground=selected?Look.Text:Look.Secondary,VerticalAlignment=VerticalAlignment.Center};
            var tab=new Grid {Height=44};tab.Children.Add(label);
            if(selected) tab.Children.Add(new Border {Height=3,Width=16,CornerRadius=new CornerRadius(1.5),Background=Look.Accent,VerticalAlignment=VerticalAlignment.Bottom,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(0,0,0,6)});
            var button=new Button {Style=(Style)FindResource("Bare"),Content=tab,Margin=new Thickness(0,0,20,0),Padding=new Thickness(2,0,2,0)};
            AutomationProperties.SetName(button,L10n.Text(key)+(selected?L10n.Text("current_page"):""));
            button.Click+=(_,_)=>{if(!busy) {page=id;Render();}};NavigationPanel.Children.Add(button);
        }
        switch(page) {
            case "connect":Home();break;
            case "nodes":Nodes();break;
            case "devices":Devices();break;
            case "logs":Logs();break;
            default:Account();break;
        }
        UpdateLive();
    }
    /// Update and announcement notes: one compact card each, only when there is something to say.
    private FrameworkElement? Notices() {
        if(update is null&&announcement.Length==0) return null;
        var stack=new StackPanel();
        if(update is { } available) {
            var link=new Button {Content=L10n.Text("update_open_download"),Foreground=Look.Accent,FontSize=13,FontWeight=FontWeights.SemiBold,Height=32,Padding=new Thickness(8,0,8,0)};
            link.Click+=(_,_)=>Process.Start(new ProcessStartInfo(available.Download.AbsoluteUri) {UseShellExecute=true});
            var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
            texts.Children.Add(Words(L10n.Text("update_available",available.Version),13,strong:true));
            texts.Children.Add(Words(L10n.Text(available.Mandatory?"update_required_detail":"update_available_detail"),12,Look.Secondary,top:2));
            var grid=Columns(new FrameworkElement(),texts,link);
            stack.Children.Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(8),Padding=new Thickness(14,10,8,10),Child=grid,Margin=new Thickness(0,0,0,8)});
        }
        if(announcement.Length>0) stack.Children.Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(8),Padding=new Thickness(14,10,14,10),Child=Words(announcement,12,Look.Secondary),Margin=new Thickness(0,0,0,8)});
        return stack;
    }
    /// Everything needed to connect fits in the window: the ring, the state, the location, and usage.
    private void Home() {
        var layout=new Grid {Margin=new Thickness(16,8,16,16)};
        layout.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});layout.RowDefinitions.Add(new RowDefinition {Height=new GridLength(1,GridUnitType.Star)});layout.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});
        if(Notices() is { } notes) layout.Children.Add(notes);

        ring=new Ring();
        ringButton=new Button {Style=(Style)FindResource("Bare"),Content=ring.View,HorizontalAlignment=HorizontalAlignment.Center};
        ringButton.Click+=(_,_)=>Toggle();
        statusDot=new Rectangle {Width=8,Height=8,Fill=Look.Accent,Margin=new Thickness(0,0,10,0),VerticalAlignment=VerticalAlignment.Center};
        statusTitle=new TextBlock {FontSize=24,FontWeight=FontWeights.SemiBold,VerticalAlignment=VerticalAlignment.Center,TextWrapping=TextWrapping.NoWrap};
        var titleRow=new StackPanel {Orientation=Orientation.Horizontal,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(0,20,0,0)};
        titleRow.Children.Add(statusDot);titleRow.Children.Add(statusTitle);
        statusTimer=new TextBlock {FontFamily=Look.Dots,FontSize=30,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(0,8,0,0),Visibility=Visibility.Collapsed};
        statusDetail=new TextBlock {FontSize=13,Foreground=Look.Secondary,TextAlignment=TextAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(8,6,8,0),MaxHeight=40,TextTrimming=TextTrimming.CharacterEllipsis};
        stream=new TextBlock {FontFamily=Look.Dots,FontSize=14,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(0,14,0,0)};
        var center=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
        center.Children.Add(ringButton);center.Children.Add(titleRow);center.Children.Add(statusTimer);center.Children.Add(statusDetail);center.Children.Add(stream);
        Grid.SetRow(center,1);layout.Children.Add(center);

        var badge=new ContentControl();
        var title=Single("",14,strong:true);var detail=Single("",12,Look.Secondary);detail.Margin=new Thickness(0,2,0,0);
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,8,0)};texts.Children.Add(title);texts.Children.Add(detail);
        var row=new Button {Height=60,Background=Look.Surface,BorderBrush=Look.Hex("#0FECF1E8"),BorderThickness=new Thickness(1),Content=Columns(badge,texts,Look.Icon("",11,Look.Secondary))};
        AutomationProperties.SetHelpText(row,L10n.Text("tap_to_change"));
        row.Click+=(_,_)=>{if(!busy) {page="nodes";Render();}};
        location=(badge,title,detail);
        usageTotal=new TextBlock {Text="—",FontSize=14,FontWeight=FontWeights.SemiBold};usageUntil=new TextBlock {Text="—",FontSize=14,FontWeight=FontWeights.SemiBold};
        var cells=Cells(("last_30_days",usageTotal,12),("valid_until_label",usageUntil,12));cells.Margin=new Thickness(4,14,4,0);
        var bottom=new StackPanel();bottom.Children.Add(row);bottom.Children.Add(cells);
        Grid.SetRow(bottom,2);layout.Children.Add(bottom);
        FullPanel.Children.Add(layout);
        ShowUsage();
        _=RefreshAccount();
        if(directory.Count==0) _=QuietNodes();
    }
    private async Task QuietNodes() {try {await LoadNodes();badgeKey="";UpdateLive();} catch {/* codes fall back to initials */}}
    private string UsageText()=>accountData?["traffic"] is { } traffic?Bytes(Number(traffic["uploadBytes"])+Number(traffic["downloadBytes"])):"—";
    private void ShowUsage() {if(usageTotal is not null&&usageUntil is not null) ShowFigures(usageTotal,usageUntil);}
    /// Traffic left (or used in the last 30 days) and the end of the access period, tinted when either is running
    /// out or has run out. Traffic quotas count all nodes together.
    private void ShowFigures(TextBlock traffic,TextBlock until) {
        var access=accountData?["access"];var state=access?["state"]?.GetValue<string>()??"active";
        long? quota=access?["quotaBytes"] is { } q?Number(q):null;
        if(traffic.Parent is StackPanel cell&&cell.Children[0] is TextBlock title) title.Text=L10n.Text(quota is null?"last_30_days":"traffic_left");
        if(quota is { } total) {var left=Number(access?["remainingBytes"]);traffic.Text=Bytes(left);traffic.Foreground=state=="exhausted"?Look.Danger:state=="active"&&left<=total/10?Look.Fair:Look.Text;}
        else {traffic.Text=UsageText();traffic.Foreground=Look.Text;}
        until.Text=accountData is null?"—":L10n.Date(accountData["expiresAt"]?.GetValue<string>());
        var soon=access?["until"]?.GetValue<string>() is { } end&&DateTimeOffset.TryParse(end,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out var date)&&date-DateTimeOffset.UtcNow<=TimeSpan.FromDays(7);
        until.Foreground=state=="expired"?Look.Danger:state=="active"&&soon?Look.Fair:Look.Text;
    }
    private RingState State() {
        var active=connection.Active;
        if(active) return connection.Since is not null?RingState.Connected:RingState.Connecting;
        return failed?RingState.Failed:RingState.Idle;
    }
    private string StatusTitle(RingState state)=>L10n.Text(state switch {RingState.Connected=>"connected_status",RingState.Connecting=>"connecting",RingState.Failed=>"connect_failed_title",_=>"not_connected"});
    /// Time since the connection came up, or null while it is not (yet) confirmed.
    private string? Elapsed()=>connection.StatusKey!="confirming_connection_status"&&connection.Since is { } since?(DateTime.UtcNow-since).ToString(@"hh\:mm\:ss"):null;
    /// The flyout's one line keeps time and rates together; the window shows the time large above the rates.
    private string StatusDetail(RingState state,bool compact=true)=>state switch {
        RingState.Connected=>connection.StatusKey=="confirming_connection_status"?L10n.Text("confirming_connection_status")
            :Elapsed() is { } time?compact?L10n.Text("connection_stats",time,Mbps(connection.RxRate),Mbps(connection.TxRate)):L10n.Text("connection_rates",Mbps(connection.RxRate),Mbps(connection.TxRate)):"",
        RingState.Connecting=>L10n.Text("finding_best_route"),
        RingState.Failed=>failure,
        _=>L10n.Text(update?.Mandatory==true?"update_required_detail":"tap_ring_to_connect"),
    };
    /// The location the next (or current) connection uses, as title, detail and tile code (null: automatic).
    private (string Title,string Detail,string? Code) Location() {
        var active=connection.Active;var automatic=nodeId.Length==0;
        var id=active?connection.NodeId:nodeId;
        var quality=id.Length>0&&Latency.Recent.TryGetValue(id,out var known)?known:null;
        if(active&&id.Length>0) {
            var name=connection.NodeName.Length>0?connection.NodeName:directory.TryGetValue(id,out var entry)?entry.Name:L10n.Text("location");
            var detail=automatic?(Ms(quality) is { } ms?L10n.Text("connected_automatic_detail",ms):L10n.Text("automatic")):quality is not null?Summary(quality):L10n.Text("tap_to_change");
            return (name,detail,Code(id,name));
        }
        if(automatic) {
            // The location automatic mode would pick now, when this session measured one.
            var best=directory.Select(x=>(x.Value.Name,Quality:Latency.Recent.TryGetValue(x.Key,out var q)?q:null)).Where(x=>x.Quality?.Latency is not null).OrderBy(x=>x.Quality!.Score).FirstOrDefault();
            return (L10n.Text("automatic"),best.Quality is not null?best.Name+" · "+Ms(best.Quality):L10n.Text("auto_detail"),null);
        }
        return (nodeName.Length>0?nodeName:L10n.Text("location"),quality is not null?Summary(quality):L10n.Text("tap_to_change"),Code(nodeId,nodeName));
    }

    private void Nodes() {
        HeaderSlot.Content=IconButton("",L10n.Text("retest_latency"),()=>{});
        RoutingChoice();
        var list=new StackPanel();
        var query="";
        var ranked=new List<(JsonNode Node,Quality? Quality)>();
        void Rank(JsonArray nodes) {
            ranked=nodes.Where(n=>n is not null).Select(n=>(n!,Latency.Recent.TryGetValue(n!["id"]!.GetValue<string>(),out var known)?known:(Quality?)null)).OrderBy(x=>x.Item2?.Score??long.MaxValue).ToList();
        }
        var searchHost=Add(new ContentControl());
        Add(AutomaticRow(),12,0);
        Add(Caption(L10n.Text("all_locations")),20,8);
        ContentPanel.Children.Add(list);
        void Build(JsonArray nodes) {
            Rank(nodes);
            if(nodes.Count>6&&searchHost.Content is null) searchHost.Content=Search(text=>{query=text;ShowNodes(list,ranked,query);});
            ShowNodes(list,ranked,query);
        }
        async void Measure(JsonArray nodes) {
            if(measuring||connection.Active) return;
            measuring=true;BusyBar.Visibility=Visibility.Visible;
            if(HeaderSlot.Content is Button refreshing) refreshing.IsEnabled=false;
            ShowNodes(list,ranked,query);
            try {ranked=(await Latency.Rank(nodes)).Select(x=>(x.Node,(Quality?)x.Quality)).ToList();} catch {/* keep the last results */}
            measuring=false;if(!busy) BusyBar.Visibility=Visibility.Hidden;
            if(list.IsLoaded) {ShowNodes(list,ranked,query);if(HeaderSlot.Content is Button again) again.IsEnabled=!connection.Active;}
        }
        void Ready(JsonArray nodes) {
            Build(nodes);
            if(HeaderSlot.Content is Button refresh) {refresh.IsEnabled=!connection.Active;refresh.Click+=(_,_)=>Measure(nodes);}
            // Fresh results are kept for the session; opening the page again does not probe every node again.
            if(ranked.Any(x=>x.Quality is null)) Measure(nodes);
        }
        if(nodesData is { } cached) Ready(cached);
        else Work(async()=>Ready(await LoadNodes()));
    }
    private FrameworkElement Search(Action<string> changed) {
        var box=new TextBox {Padding=new Thickness(30,0,10,0)};
        AutomationProperties.SetName(box,L10n.Text("search_locations_or_regions"));
        var hint=new TextBlock {Text=L10n.Text("search_locations_or_regions"),FontSize=14,Foreground=Look.Faint,Margin=new Thickness(31,0,10,0),VerticalAlignment=VerticalAlignment.Center,IsHitTestVisible=false,TextWrapping=TextWrapping.NoWrap};
        var glass=Look.Icon("",13,Look.Secondary);glass.HorizontalAlignment=HorizontalAlignment.Left;glass.Margin=new Thickness(10,0,0,0);glass.IsHitTestVisible=false;
        box.TextChanged+=(_,_)=>{hint.Visibility=box.Text.Length==0?Visibility.Visible:Visibility.Collapsed;changed(box.Text);};
        var grid=new Grid {Margin=new Thickness(0,14,0,0)};grid.Children.Add(box);grid.Children.Add(hint);grid.Children.Add(glass);
        return grid;
    }
    private Button AutomaticRow() {
        var selected=nodeId.Length==0;
        var row=new Button {Height=56,Background=Look.Surface,BorderBrush=selected?Look.Hex("#73B7DC68"):Brushes.Transparent,BorderThickness=new Thickness(1),
            Content=Columns(Look.Badge(null),TwoLines(L10n.Text("automatic"),L10n.Text("select_an_available_location_for_you"),strong:true),selected?Look.Icon("",14,Look.Accent):null)};
        AutomationProperties.SetName(row,L10n.Text("automatic")+(selected?L10n.Text("current_page"):""));
        row.Click+=(_,_)=>Select("","");
        return row;
    }
    private void ShowNodes(StackPanel list,List<(JsonNode Node,Quality? Quality)> ranked,string query) {
        list.Children.Clear();
        var rows=new List<FrameworkElement>();
        foreach(var (node,quality) in ranked) {
            var name=node["name"]!.GetValue<string>();var id=node["id"]!.GetValue<string>();var region=node["region"]?.GetValue<string>()??"";
            if(!(name+" "+region).Contains(query,StringComparison.OrdinalIgnoreCase)) continue;
            var unreachable=quality is {Latency: null};
            var selected=id==nodeId;
            var right=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};
            if(quality is null) {if(measuring) right.Children.Add(Single("…",12,Look.Secondary));}
            else if(Ms(quality) is { } ms) {
                right.Children.Add(Single(ms,12,Look.Secondary));
                var (level,color)=Signal(quality);var bars=Look.Signal(level,color);bars.Margin=new Thickness(8,0,0,0);right.Children.Add(bars);
            } else right.Children.Add(Single(L10n.Text("quality_unreachable"),12,Look.Faint));
            if(selected) {var check=Look.Icon("",13,Look.Accent);check.Margin=new Thickness(10,0,0,0);right.Children.Add(check);}
            var label=Single(name+(region.Length>0&&region!=name?" · "+region:""),14,unreachable?Look.Faint:Look.Text);label.Margin=new Thickness(12,0,8,0);
            var row=new Button {Height=48,Content=Columns(Look.Badge(Code(id,name),28,unreachable?Look.Faint:null),label,right)};
            AutomationProperties.SetName(row,name+(quality is not null?", "+Summary(quality):"")+(selected?L10n.Text("current_page"):""));
            row.Click+=(_,_)=>Select(id,name);
            rows.Add(row);
        }
        if(rows.Count>0) list.Children.Add(Card(rows));
        else list.Children.Add(Caption(L10n.Text(ranked.Count==0?"no_locations_available_refresh_later_or_contact_your_administrator":"no_matching_locations_try_another_search")));
    }
    /// Smart (mainland China direct) or global routing; applies from the next connection.
    private void RoutingChoice() {
        var mode=Settings.Get("routing","smart");
        var choice=new UniformGrid {Rows=1};
        foreach(var (value,title) in new[]{("smart","routing_smart"),("global","routing_global")}) {
            var selected=value==mode;
            var button=new Button {Content=L10n.Text(title),Height=30,FontSize=13,Padding=new Thickness(6,0,6,0),Margin=new Thickness(2,0,2,0),HorizontalContentAlignment=HorizontalAlignment.Center,
                Background=selected?Look.Selected:Brushes.Transparent,Foreground=selected?Look.Text:Look.Secondary,FontWeight=selected?FontWeights.SemiBold:FontWeights.Normal};
            AutomationProperties.SetName(button,L10n.Text(title)+(selected?L10n.Text("current_page"):""));
            button.Click+=(_,_)=>{if(!busy&&!selected) ChooseRouting(value);};
            choice.Children.Add(button);
        }
        Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(8),Padding=new Thickness(1,3,1,3),Child=choice},4,6);
        Add(Caption(L10n.Text(mode=="smart"?"routing_smart_detail":"routing_global_detail")));
        if(connection.Active) Add(Caption(L10n.Text("test_after_disconnecting")),4,0);
    }

    private void Account() {
        if(accountData is { } cached) AccountPage(cached);
        else Work(async()=>{accountData=await api.Request("account");if(page=="account") Render();});
        if(accountData is not null) _=RefreshPage("account");
    }
    /// Refreshes the account quietly and redraws the page only when something changed.
    private async Task RefreshPage(string from) {
        try {
            var data=await api.Request("account");
            var changed=data.ToJsonString()!=accountData?.ToJsonString();accountData=data;
            if(changed&&page==from&&!busy) Render();
        } catch {/* shown from the last summary */}
    }
    private void AccountPage(JsonNode account) {
        var email=account["email"]?.GetValue<string>()??"";
        var name=account["name"]?.GetValue<string>() is { Length: >0 } given?given:email;
        var avatar=new Border {Width=40,Height=40,CornerRadius=new CornerRadius(20),Background=Look.Raised,VerticalAlignment=VerticalAlignment.Center,
            Child=new TextBlock {Text=name.Length>0?name[..1].ToUpperInvariant():"",FontSize=16,FontWeight=FontWeights.SemiBold,Foreground=Look.Accent,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center}};
        var identity=Columns(avatar,TwoLines(email,L10n.Text("account_valid_until",L10n.Date(account["expiresAt"]?.GetValue<string>())),strong:true));
        identity.Margin=new Thickness(4,0,4,0);Add(identity,4,16);
        if(account["traffic"] is { } traffic) Add(UsageCard(traffic),0,16);

        var devices=SettingRow(L10n.Text("authorized_devices"),$"{Number(account["used"]).ToString("N0",L10n.Culture)} / {DeviceLimit(account)}",_=>{page="devices";Render();});
        var language=SettingRow(L10n.Text("language"),LanguageName(L10n.Preference),ChooseLanguage);
        var startup=new ToggleButton {Style=(Style)FindResource("Switch"),IsChecked=LoginTask.Enabled,VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(startup,L10n.Text("open_at_login"));
        startup.Click+=(_,_)=>{var on=startup.IsChecked==true;if(!LoginTask.Set(on)) {startup.IsChecked=!on;Notify(L10n.Text("unable_to_reach_the_service_check_your_network_and"));}};
        var startupRow=new Border {Height=44,Padding=new Thickness(14,0,14,0),Child=Columns(new FrameworkElement(),Single(L10n.Text("open_at_login"),14),startup)};
        var updates=SettingRow(L10n.Text("check_for_updates"),update is { } available?L10n.Text("update_available",available.Version):L10n.Text("up_to_date"),_=>{
            if(update is { } found) Process.Start(new ProcessStartInfo(found.Download.AbsoluteUri) {UseShellExecute=true});
            else CheckForUpdate(true);
        });
        Add(Card(new FrameworkElement[]{devices,language,startupRow,updates},14));

        var signOut=new Button {Content=L10n.Text("sign_out"),Height=40,Background=Look.Surface,Foreground=Look.Danger,HorizontalContentAlignment=HorizontalAlignment.Center};
        signOut.Click+=(_,_)=>{
            if(connection.Active) {Notify(L10n.Text("disconnect_the_vpn_before_signing_out"));return;}
            Work(async()=>{await api.Logout();accountData=null;page="connect";Render();});
        };
        Add(signOut,16,0);
        // The diagnostic log has no visible entry: seven clicks on the version open it.
        var taps=0;var first=DateTime.MinValue;
        var version=Add(new TextBlock {Text="TRACKNOTHING "+(System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3)??"0"),FontFamily=Look.Dots,FontSize=12,Foreground=Look.Faint,HorizontalAlignment=HorizontalAlignment.Center,Padding=new Thickness(12,6,12,6),Background=Brushes.Transparent},12,0);
        version.MouseLeftButtonUp+=(_,_)=>{
            if(DateTime.UtcNow-first>TimeSpan.FromSeconds(4)) {taps=0;first=DateTime.UtcNow;}
            if(++taps>=7) {taps=0;page="logs";Render();}
        };
    }
    private Button SettingRow(string title,string value,Action<FrameworkElement> onClick) {
        var right=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};
        right.Children.Add(Single(value,13,Look.Secondary));
        var chevron=Look.Icon("",10,Look.Faint);chevron.Margin=new Thickness(8,0,0,0);right.Children.Add(chevron);
        var row=new Button {Height=44,Content=Columns(new FrameworkElement(),Single(title,14),right)};
        AutomationProperties.SetName(row,title+": "+value);
        row.Click+=(_,_)=>onClick(row);
        return row;
    }
    /// 30-day total, a bar per day, and the download / upload split.
    private static Border UsageCard(JsonNode traffic) {
        long down=Number(traffic["downloadBytes"]),up=Number(traffic["uploadBytes"]);
        var stack=new StackPanel();
        var days=DailyUsage(traffic);
        var header=new DockPanel();
        if(days.Count>0) {var daily=Single(L10n.Text("daily"),11,Look.Secondary);DockPanel.SetDock(daily,Dock.Right);header.Children.Add(daily);}
        header.Children.Add(Single(L10n.Text("traffic_30_days"),12,Look.Secondary));
        stack.Children.Add(header);
        var total=Bytes(down+up).Split(' ',2);
        var figure=new TextBlock {Margin=new Thickness(0,8,0,0)};
        figure.Inlines.Add(new Run(total[0]) {FontFamily=Look.Dots,FontSize=34});
        if(total.Length>1) figure.Inlines.Add(new Run(" "+total[1]) {FontSize=14,FontWeight=FontWeights.SemiBold,Foreground=Look.Secondary});
        stack.Children.Add(figure);
        if(days.Count>0) stack.Children.Add(new UsageBlocks(days) {Height=46,Margin=new Thickness(0,12,0,0)});
        var split=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(0,10,0,0)};
        split.Children.Add(Single(L10n.Text("download_amount",Bytes(down)),12,Look.Secondary));
        var upload=Single(L10n.Text("upload_amount",Bytes(up)),12,Look.Secondary);upload.Margin=new Thickness(20,0,0,0);split.Children.Add(upload);
        stack.Children.Add(split);
        return new Border {Background=Look.Surface,CornerRadius=new CornerRadius(8),Padding=new Thickness(16),Child=stack};
    }
    private static List<long> DailyUsage(JsonNode traffic) {
        if(traffic["days"] is not JsonArray days||days.Count==0) return new();
        var perDay=new Dictionary<string,long>();
        foreach(var day in days) if(day?["day"]?.GetValue<string>() is { } date) perDay[date]=Number(day["bytes"]);
        return Enumerable.Range(0,30).Reverse().Select(offset=>perDay.TryGetValue(DateTime.Now.AddDays(-offset).ToString("yyyy-MM-dd",System.Globalization.CultureInfo.InvariantCulture),out var bytes)?bytes:0).ToList();
    }
    private FrameworkElement SubHeader(string title) {
        var back=IconButton("",L10n.Text("back_action"),()=>{page="account";Render();});back.HorizontalAlignment=HorizontalAlignment.Left;
        var grid=new Grid {Height=40};
        grid.Children.Add(new TextBlock {Text=title,FontSize=14,FontWeight=FontWeights.SemiBold,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center});
        grid.Children.Add(back);
        return grid;
    }
    private void Devices() {
        Add(SubHeader(L10n.Text("authorized_devices")),0,8);
        if(accountData is null) {Work(async()=>{accountData=await api.Request("account");if(page=="devices") Render();});return;}
        var account=accountData;
        var summary=new DockPanel {Margin=new Thickness(4,0,4,0)};
        var hint=new TextBlock {Text=L10n.Text("devices_join_automatically"),FontSize=11,Foreground=Look.Secondary,TextAlignment=TextAlignment.Right,MaxWidth=180,Margin=new Thickness(12,0,0,0)};
        DockPanel.SetDock(hint,Dock.Right);summary.Children.Add(hint);
        summary.Children.Add(Single(L10n.Text("devices_used",Number(account["used"]).ToString("N0",L10n.Culture),DeviceLimit(account)),12,Look.Secondary));
        Add(summary,0,10);
        var rows=new List<FrameworkElement>();
        foreach(var device in account["devices"]?.AsArray()??new JsonArray()) {
            if(device?["status"]?.GetValue<string>() is not { } status||status=="revoked") continue;
            var current=device["isCurrent"]?.GetValue<bool>()==true;var revoking=status=="revoking";
            var platform=device["platform"]?.GetValue<string>()??"";
            var mobile=platform.ToLowerInvariant() is "android" or "ios" or "ipados";
            var platformName=platform.ToLowerInvariant() switch {"android"=>"Android","ios"=>"iOS","ipados"=>"iPadOS","macos"=>"macOS","windows"=>"Windows",_=>platform};
            var when=current?L10n.Text("this_device").Trim().TrimStart('·').Trim():L10n.Date(device["lastSeenAt"]?.GetValue<string>());
            var detail=platformName.Length>0?L10n.Text("last_active",platformName,when):when;
            var deviceName=device["name"]?.GetValue<string>()??L10n.Text("device");
            FrameworkElement action;
            if(revoking) action=Single(L10n.Text("revoking_short"),13,Look.Faint);
            else {
                var revoke=new Button {Content=L10n.Text("revoke_short"),Foreground=Look.Danger,FontSize=13,Height=32,Padding=new Thickness(10,0,10,0),VerticalAlignment=VerticalAlignment.Center};
                AutomationProperties.SetName(revoke,L10n.Text("revoke_access")+": "+deviceName);
                revoke.Click+=(_,_)=>{
                    if(MessageBox.Show(this,L10n.Text("this_device_will_lose_access_revoke_authorization"),"TrackNothing",MessageBoxButton.YesNo)!=MessageBoxResult.Yes) return;
                    Work(async()=>{await api.Action("revoke",new JsonObject {["enrollmentId"]=device["id"]!.GetValue<string>()});if(current) await connection.Disconnect();accountData=await api.Request("account");Render();});
                };
                action=revoke;
            }
            var row=new Border {MinHeight=60,Padding=new Thickness(14,0,6,0),Child=Columns(Look.Badge(null,32,current?Look.Accent:Look.Secondary,mobile?"":""),TwoLines(deviceName,detail,strong:true),action)};
            rows.Add(row);
        }
        if(rows.Count>0) Add(Card(rows));
        else Add(Caption(L10n.Text("no_authorized_devices_yet_they_appear_after_their_first")));
        Add(Caption(L10n.Text("revoke_release_hint")),10,0);
        _=RefreshPage("devices");
    }
    private void Logs() {
        Add(SubHeader(L10n.Text("logs_title")),0,8);
        var log=Journal.Read();
        Add(Caption(L10n.Text("logs_detail")),0,10);
        var actions=new UniformGrid {Rows=1};
        var copy=Plain(L10n.Text("copy_action"));copy.Click+=(_,_)=>{try {Clipboard.SetText(log);Notify(L10n.Text("copied"));} catch {/* clipboard busy */}};copy.IsEnabled=log.Length>0;copy.Margin=new Thickness(0,0,6,0);
        var clear=Plain(L10n.Text("clear_action"),Look.Danger);clear.Click+=(_,_)=>{Journal.Clear();Render();};clear.Margin=new Thickness(6,0,0,0);
        actions.Children.Add(copy);actions.Children.Add(clear);Add(actions,0,10);
        // Newest first: the last attempt is what someone opening the log is looking for.
        Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(8),Padding=new Thickness(10,8,10,8),Child=new TextBox {
            Text=log.Length==0?L10n.Text("logs_empty"):string.Join("\n",log.Split('\n').Reverse()),IsReadOnly=true,BorderBrush=Brushes.Transparent,Background=Brushes.Transparent,Height=double.NaN,VerticalContentAlignment=VerticalAlignment.Top,
            FontFamily=new FontFamily("Consolas"),FontSize=11,TextWrapping=TextWrapping.Wrap,Padding=new Thickness(0)}});
    }
    private void Login() {
        var logo=Look.Mark(72,Look.Accent);logo.HorizontalAlignment=HorizontalAlignment.Center;Add(logo,28,0);
        var word=Look.Wordmark(26);word.HorizontalAlignment=HorizontalAlignment.Center;Add(word,18,0);
        Add(new TextBlock {Text=L10n.Text("sign_in_tagline"),FontSize=13,Foreground=Look.Secondary,TextAlignment=TextAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center},6,24);
        if(Notices() is { } notes) Add(notes,0,8);
        Add(Caption(L10n.Text("server_address")),0,6);var origin=Add(new TextBox {Text=api.Origin},0,12);
        Add(Caption(L10n.Text("email")),0,6);var email=Add(new TextBox(),0,12);
        Add(Caption(L10n.Text("password")),0,6);
        var hidden=new PasswordBox {Padding=new Thickness(10,0,40,0)};var shown=new TextBox {Padding=new Thickness(10,0,40,0),Visibility=Visibility.Collapsed};
        var eye=new Button {Width=36,Height=32,Padding=new Thickness(0),HorizontalAlignment=HorizontalAlignment.Right,Margin=new Thickness(0,0,2,0),HorizontalContentAlignment=HorizontalAlignment.Center};
        void Reveal() {
            eye.Content=Look.Icon(showPassword?"":"",14,Look.Secondary);
            AutomationProperties.SetName(eye,L10n.Text(showPassword?"hide_password":"show_password"));
            hidden.Visibility=showPassword?Visibility.Collapsed:Visibility.Visible;shown.Visibility=showPassword?Visibility.Visible:Visibility.Collapsed;
        }
        eye.Click+=(_,_)=>{if(showPassword) hidden.Password=shown.Text;else shown.Text=hidden.Password;showPassword=!showPassword;Reveal();};
        Reveal();
        var field=new Grid();field.Children.Add(hidden);field.Children.Add(shown);field.Children.Add(eye);Add(field);
        AutomationProperties.SetName(origin,L10n.Text("server_address"));AutomationProperties.SetName(email,L10n.Text("email"));AutomationProperties.SetName(hidden,L10n.Text("password"));AutomationProperties.SetName(shown,L10n.Text("password"));
        var login=Add(Primary(L10n.Text("sign_in_action")),24,0);
        login.IsDefault=true;
        login.Click+=(_,_)=>{
            var password=showPassword?shown.Text:hidden.Password;
            if(string.IsNullOrWhiteSpace(email.Text)||password.Length==0) {Notify(L10n.Text("enter_your_email_and_password"));return;}
            Work(async()=>{api.Origin=origin.Text.Trim();await api.Login(email.Text.Trim(),password);hidden.Clear();shown.Clear();page="connect";Render();CheckForUpdate(false);});
        };
    }
    private static readonly (string Code,string Name)[] Languages={("system",""),("zh","简体中文"),("en","English"),("ru","Русский")};
    private static string LanguageName(string code)=>code=="system"?L10n.Text("language_system"):Languages.FirstOrDefault(l=>l.Code==code).Name??"English";
    /// The list of languages, by their own names, in a small dark popup under the entry.
    private void ChooseLanguage(FrameworkElement anchor) {
        var list=new StackPanel {MinWidth=200};
        var popup=new Popup {PlacementTarget=anchor,Placement=PlacementMode.Bottom,StaysOpen=false,AllowsTransparency=true,
            Child=new Border {Background=Look.Raised,BorderBrush=Look.Edge,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(8),Padding=new Thickness(4),Child=list,Margin=new Thickness(0,4,0,0)}};
        if(anchor.ActualWidth>200) popup.HorizontalOffset=anchor.ActualWidth-212;
        foreach(var (code,_) in Languages) {
            var chosen=L10n.Preference==code;
            var item=new Button {Height=34,Padding=new Thickness(10,0,10,0),Content=Columns(new FrameworkElement(),Single(LanguageName(code),13),chosen?Look.Icon("",12,Look.Accent):null)};
            AutomationProperties.SetName(item,LanguageName(code)+(chosen?L10n.Text("current_page"):""));
            item.Click+=(_,_)=>{popup.IsOpen=false;if(chosen) return;L10n.Select(code);flyout?.Close();flyout=null;fly=null;Render();UpdateTray();};
            list.Children.Add(item);
        }
        popup.IsOpen=true;
    }
    /// The new page eases in: a short fade and an 8 px rise.
    private static void Enter(FrameworkElement panel) {
        if(!Motion) {panel.BeginAnimation(OpacityProperty,null);panel.Opacity=1;return;}
        var shift=new TranslateTransform(0,8);panel.RenderTransform=shift;
        var ease=new CubicEase {EasingMode=EasingMode.EaseOut};
        panel.BeginAnimation(OpacityProperty,new DoubleAnimation(0,1,TimeSpan.FromMilliseconds(180)) {EasingFunction=ease});
        shift.BeginAnimation(TranslateTransform.YProperty,new DoubleAnimation(8,0,TimeSpan.FromMilliseconds(220)) {EasingFunction=ease});
    }

    /// Live parts of the connect page and the flyout, refreshed every second without rebuilding them.
    private void UpdateLive() {
        if(connection.Active) failed=false;
        var state=State();
        if(ring is not null&&ringButton is not null) {
            ring.Set(state,Motion);
            ringButton.IsEnabled=!busy||connection.Active;
            AutomationProperties.SetName(ringButton,L10n.Text(state switch {RingState.Idle=>"connect_action",RingState.Failed=>"retry_action",RingState.Connecting=>"cancel",_=>"disconnect_action"}));
        }
        if(statusTitle is not null) statusTitle.Text=StatusTitle(state);
        if(statusDot is not null) statusDot.Visibility=state==RingState.Connected?Visibility.Visible:Visibility.Collapsed;
        if(statusDetail is not null) statusDetail.Text=StatusDetail(state,false);
        if(statusTimer is not null) {
            var time=state==RingState.Connected?Elapsed():null;
            statusTimer.Text=time??"";statusTimer.Visibility=time is null?Visibility.Collapsed:Visibility.Visible;
        }
        if(stream is not null) {
            var running=state is RingState.Connecting or RingState.Connected;
            stream.Text=running&&Motion?Look.Stream(DateTime.UtcNow):Look.StreamIdle;stream.Foreground=running?Look.StreamOn:Look.StreamOff;
        }
        if(location is { } place) {
            var (title,detail,code)=Location();
            place.Title.Text=title;place.Detail.Text=detail;
            var key=code??"*";
            if(key!=badgeKey) {badgeKey=key;place.Badge.Content=Look.Badge(code);}
        }
        if(flyout?.IsVisible==true) UpdateFlyout();
    }
}
