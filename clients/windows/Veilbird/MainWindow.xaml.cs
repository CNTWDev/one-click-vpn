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
    private readonly Core core=new();
    private readonly NativeApi api;
    private readonly Connection connection;
    private readonly Forms.NotifyIcon tray=new();
    private Forms.ToolStripMenuItem? trayRates;
    private bool reminderBalloon;
    // The app stays in the tray for days and traffic runs down meanwhile: the account is read again every few hours.
    private readonly DispatcherTimer accountTimer=new() {Interval=TimeSpan.FromHours(3)};
    private string page="connect",nodeId=Settings.Get("nodeId"),nodeName=Settings.Get("nodeName");
    private bool busy,measuring,quitting,trayHintShown,showPassword;
    private ReleaseUpdate? update;
    // The update banner and the account row follow one state: available, downloading, ready, failed.
    private bool downloading;
    private JsonObject? download;
    private string downloadError="";
    private ContentControl? bannerHost;
    private TextBlock? updateRowValue;
    // Checks a few seconds after launch, then every six hours while the app runs (often for days in the tray).
    private readonly DispatcherTimer updateTimer=new() {Interval=TimeSpan.FromSeconds(3)},downloadTimer=new() {Interval=TimeSpan.FromMilliseconds(300)};
    private string announcement="";
    private readonly DispatcherTimer refresh=new() {Interval=TimeSpan.FromSeconds(1)},toastTimer=new() {Interval=TimeSpan.FromSeconds(5)};
    // Memory is handed back a little after the window leaves the screen, not at once (it may come straight back).
    private readonly DispatcherTimer trimTimer=new() {Interval=TimeSpan.FromSeconds(5)};
    private string lastView="";
    // The last account summary and location list, so pages show at once and refresh quietly.
    private JsonNode? accountData;
    private JsonArray? nodesData;
    private readonly Dictionary<string,(string Name,string Code)> directory=new();
    // Live parts of the connect page and the tray flyout.
    private TextBlock? statusTitle,statusDetail,usageTotal,usageUntil,actionLabel;
    private Border? stamp;
    private Button? actionButton,secondaryButton;
    private ContentControl? stepsHost;
    // The first run: sign in (1), pick a location (2), connect (3); the tabs show once the first connection is up.
    private static bool Onboarded {get=>Settings.Get("onboarded")=="1";set=>Settings.Set("onboarded",value?"1":"0");}
    /// First-run steps before the tabs appear: sign in, then connect (the location starts on Automatic).
    private const int Steps=2;
    private Ellipse? actionDot;
    private ScanLine? scan;
    private Portrait? portrait;
    private List<SealedText>? fileLines;
    // Whether the file was last shown sealed (null before the first show on a page, which does not animate), the state
    // the action last showed, and the public address the service saw before connecting.
    private bool? sealedShown;
    private string? shownState;
    private string? visitorIp;
    private (ContentControl Badge,TextBlock Title,TextBlock Detail)? location;
    /// Under a failure of the network: the four-step check, in place of the location row and the usage figures.
    private Border? checksCard;
    private FrameworkElement? placeRow,usageCells;
    private string? sentCheck;
    private RateBars? rateBars,flyRate;
    private Border? switchNote,flyNote;
    private TextBlock? switchText,flyNoteText;
    // The note is dismissed per switch: a later switch shows it again.
    private string dismissedSwitch="";
    // Download / upload rates of the last 40 seconds for the rate chart, newest last.
    private readonly List<long> rxHistory=new(),txHistory=new();
    /// The usage page's range in days.
    private int usageDays=30;
    // The activity panel beside the app's column, signed in only; filled from the core once a second.
    private ActivityPanel? activity;
    private bool activityLoading;
    private string badgeKey="";
    private Window? flyout;
    private DateTime flyoutHidden=DateTime.MinValue;
    private (Border Card,ContentControl Mark,TextBlock Title,TextBlock Detail,ToggleButton Switch,ContentControl Badge,TextBlock Location,TextBlock LocationDetail,TextBlock Usage,TextBlock Until)? fly;
    private LinkState? flyState;
    // Follows the Windows "Show animations" setting.
    private static bool Motion=>SystemParameters.ClientAreaAnimation;
    private static bool Smart=>Settings.Get("routing","smart")=="smart";

    public MainWindow() {
        api=new NativeApi(core);Latency.RealTest=core.Test;
        L10n.Initialize();InitializeComponent();api.Origin=api.SavedOrigin;
        TitleLogo.Content=Look.Mark(16,Look.Accent);
        connection=new Connection(api,core);
        // Hidden in the tray only the tray's tooltip follows the connection; the pages catch up when they show again.
        connection.Changed+=()=>Dispatcher.InvokeAsync(()=>{if(Seen) UpdateLive();UpdateTray();});
        refresh.Tick+=(_,_)=>{SampleRates();if(Seen) UpdateLive();RefreshActivity();};refresh.Start();
        toastTimer.Tick+=(_,_)=>{toastTimer.Stop();Toast.Visibility=Visibility.Collapsed;};
        Toast.MouseLeftButtonUp+=(_,_)=>{toastTimer.Stop();Toast.Visibility=Visibility.Collapsed;};
        SourceInitialized+=(_,_)=>DarkFrame();
        IsVisibleChanged+=(_,_)=>OnScreenChanged();StateChanged+=(_,_)=>OnScreenChanged();
        trimTimer.Tick+=(_,_)=>{trimTimer.Stop();if(!Seen) Trim();};
        // Started in the background at sign-in (tray only): trim once the launch work has settled.
        trimTimer.Start();
        SetupTray();
        Closing+=OnClosing;
        updateTimer.Tick+=(_,_)=>{
            // Not while a connection is being set up: the check would compete with it for the network.
            if(connection.Active&&connection.Since is null) {updateTimer.Interval=TimeSpan.FromSeconds(10);return;}
            updateTimer.Interval=TimeSpan.FromHours(6);CheckForUpdate(false);
        };
        updateTimer.Start();
        accountTimer.Tick+=(_,_)=>{if(api.SignedIn) _=RefreshAccount();};accountTimer.Start();
        downloadTimer.Tick+=async(_,_)=>{
            if(!downloading) {downloadTimer.Stop();return;}
            try {download=JsonNode.Parse(await Task.Run(core.Progress)) as JsonObject;} catch {/* next tick */}
            ShowUpdate();
        };
        // The saved list shows at once; it is loaded again at launch and when the window comes back after six hours.
        if(api.SignedIn&&NodeStore.Restore() is { } saved) Remember(saved);
        Activated+=(_,_)=>{if(DateTime.UtcNow-NodeStore.LoadedAt>NodeStore.RefreshAfter) _=QuietNodes();};
        // Signed in when this version arrives: already past the first run.
        if(Settings.Get("onboarded").Length==0) Onboarded=api.SignedIn;
        trayBlink.Tick+=(_,_)=>{blinkOn=!blinkOn;ShowTrayIcon();};
        Render();_=Crash.Send(api);
        _=QuietNodes();
        // Installed by an update while connected: reconnect as before.
        if(Settings.Get("reconnectAfterUpdate")=="1") {Settings.Set("reconnectAfterUpdate","0");Journal.Add("update: installed, reconnecting");Connection.Wanted=true;}
        // The user had left the VPN on (sign-in after a restart, an update, a crash): connect again until it works.
        if(api.SignedIn&&Connection.Wanted) _=Restore();
    }

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool SetProcessWorkingSetSize(IntPtr process,IntPtr minimum,IntPtr maximum);
    /// In the tray for hours: the window's pages, images and fonts stay built but untouched. A full collection and
    /// letting Windows trim the working set gives most of that memory back; it pages in again when the window shows.
    private static void Trim() {
        try {
            System.Runtime.GCSettings.LargeObjectHeapCompactionMode=System.Runtime.GCLargeObjectHeapCompactionMode.CompactOnce;
            GC.Collect(2,GCCollectionMode.Forced,true,true);GC.WaitForPendingFinalizers();
            SetProcessWorkingSetSize(GetCurrentProcess(),-1,-1);
        } catch {/* only an optimisation */}
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
        using(var stream=Application.GetResourceStream(new Uri("pack://application:,,,/Assets/Veilbird.ico")).Stream) iconOn=new System.Drawing.Icon(stream,Forms.SystemInformation.SmallIconSize);
        iconOff=Dimmed(iconOn);tray.Icon=iconOff;
        // A click on a reminder opens the window, where the figures say what is running out.
        tray.BalloonTipClicked+=(_,_)=>{if(reminderBalloon) ShowFromTray();};
        tray.BalloonTipClosed+=(_,_)=>reminderBalloon=false;
        tray.Visible=true;tray.ContextMenuStrip=new Forms.ContextMenuStrip();
        tray.ContextMenuStrip.Opening+=(_,_)=>BuildTrayMenu();
        tray.MouseClick+=(_,e)=>{if(e.Button==Forms.MouseButtons.Left) ToggleFlyout();};
        UpdateTray();
    }
    // The tray icon in three levels, as the Mac menu bar: off (half), busy (blinking: connecting, switching lines,
    // reconnecting, waiting for a network) and on (full). With Windows animations off, busy stays on.
    private System.Drawing.Icon? iconOn,iconOff;
    // The same two with the amber dot that says traffic or time is running out; made the first time it is needed.
    private System.Drawing.Icon? iconOnDot,iconOffDot;
    private readonly DispatcherTimer trayBlink=new() {Interval=TimeSpan.FromMilliseconds(600)};
    private bool blinkOn;
    private static System.Drawing.Icon Dimmed(System.Drawing.Icon icon) {
        using var bitmap=icon.ToBitmap();
        for(var y=0;y<bitmap.Height;y++) for(var x=0;x<bitmap.Width;x++) {
            var c=bitmap.GetPixel(x,y);bitmap.SetPixel(x,y,System.Drawing.Color.FromArgb(c.A/2,c.R,c.G,c.B));
        }
        return System.Drawing.Icon.FromHandle(bitmap.GetHicon());
    }
    private void ShowTrayIcon() {
        if(iconOn is null||iconOff is null) return;
        var state=State();
        var working=state is LinkState.Connecting or LinkState.Switching or LinkState.Reconnecting or LinkState.Waiting;
        if(working&&Motion) {if(!trayBlink.IsEnabled) trayBlink.Start();} else {trayBlink.Stop();blinkOn=false;}
        var lit=state==LinkState.Connected||(working&&(blinkOn||!Motion));
        var icon=lit?iconOn:iconOff;
        if(Reminder() is not null) icon=lit?(iconOnDot??=AccessReminders.Dotted(iconOn)):(iconOffDot??=AccessReminders.Dotted(iconOff));
        if(!ReferenceEquals(tray.Icon,icon)) tray.Icon=icon;
    }
    private void BuildTrayMenu() {
        var menu=tray.ContextMenuStrip!;menu.Items.Clear();
        var signedIn=api.SignedIn;
        menu.Items.Add(new Forms.ToolStripMenuItem(TrayStatus()) {Enabled=false});
        // Connected, the second line carries the live rates; UpdateTray refreshes it while the menu is open.
        trayRates=TrayConnected?new Forms.ToolStripMenuItem(TrayRates()) {Enabled=false}:null;
        if(trayRates is not null) menu.Items.Add(trayRates);
        menu.Items.Add(new Forms.ToolStripSeparator());
        if(signedIn&&update?.Mandatory!=true||connection.Active) menu.Items.Add(L10n.Text(connection.Active?"disconnect_action":"connect_action"),null,(_,_)=>Toggle());
        if(signedIn) {
            // The locations as a submenu, fastest first with their delay; a pick moves a running VPN there.
            var where=new Forms.ToolStripMenuItem(L10n.Text("location"));
            where.DropDownItems.Add(new Forms.ToolStripMenuItem(L10n.Text("automatic"),null,(_,_)=>PickLocation("","")) {Checked=nodeId.Length==0});
            var places=PickerNodes();
            if(places.Count>0) where.DropDownItems.Add(new Forms.ToolStripSeparator());
            foreach(var (id,name,quality) in places)
                where.DropDownItems.Add(new Forms.ToolStripMenuItem(name,null,(_,_)=>PickLocation(id,name)) {Checked=id==nodeId,ShortcutKeyDisplayString=PickerDelay(quality)});
            if(nodesData is null) _=QuietNodes();
            menu.Items.Add(where);
            menu.Items.Add(new Forms.ToolStripSeparator());
            foreach(var (value,title) in new[]{("smart","routing_smart"),("global","routing_global")})
                menu.Items.Add(new Forms.ToolStripMenuItem(L10n.Text(title),null,(_,_)=>ChooseRouting(value)) {Checked=Settings.Get("routing","smart")==value,Enabled=!connection.Active});
        }
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(L10n.Text("open_app"),null,(_,_)=>ShowFromTray());
        menu.Items.Add(L10n.Text("quit_app"),null,(_,_)=>Quit());
    }
    /// The tray icon's tooltip: status and location, and once connected a second line with the live rates
    /// (a tray icon can't show text of its own). Windows caps tooltips at 127 characters.
    private void UpdateTray() {
        var reminder=Reminder();
        var first="TrackNothing · "+TrayStatus();
        var second=(TrayConnected?"\n"+TrayRates():"")+(reminder is null?"":"\n"+reminder);
        var room=Math.Max(0,127-second.Length);
        tray.Text=(first.Length>room?first[..room]:first)+second;
        if(trayRates is not null&&TrayConnected) trayRates.Text=TrayRates();
        ShowTrayIcon();
    }
    /// "Traffic running low · 0.8 GB left" while traffic or time is running out, else null.
    private string? Reminder()=>api.SignedIn?AccountAccess.From(accountData).Line(Bytes):null;
    private bool TrayConnected=>connection.Active&&connection.Since is not null;
    private string TrayStatus()=>StatusTitle(State())+(connection.Active&&connection.NodeName.Length>0?" · "+connection.NodeName:"");
    private string TrayRates()=>"↓ "+RateText(connection.RxRate)+"   ↑ "+RateText(connection.TxRate);
    /// Bits per second like the rest of the app, the unit stepping up from Kb/s to Mb/s and Gb/s as needed.
    private static string RateText(long bytesPerSecond) {
        var bits=Math.Max(bytesPerSecond,0)*8.0;
        if(bits<1e6) return Math.Round(bits/1e3).ToString("0",L10n.Culture)+" "+L10n.Text("rate_unit_kbps");
        if(bits<99.95e6) return (bits/1e6).ToString("0.0",L10n.Culture)+" "+L10n.Text("rate_unit_mbps");
        if(bits<999.5e6) return Math.Round(bits/1e6).ToString("0",L10n.Culture)+" "+L10n.Text("rate_unit_mbps");
        return (bits/1e9).ToString("0.0",L10n.Culture)+" "+L10n.Text("rate_unit_gbps");
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
        flyState=null;UpdateFlyout();LightTiles();
        if(flyPicking) SetFlyPicking(false);
        flyout.Show();flyout.Activate();
        _=RefreshAccount();
    }
    private Window BuildFlyout() {
        var window=new Window {Width=320,Height=640,WindowStyle=WindowStyle.None,AllowsTransparency=true,Background=Brushes.Transparent,ResizeMode=ResizeMode.NoResize,ShowInTaskbar=false,Topmost=true,
            FontFamily=FontFamily,UseLayoutRounding=true,Title="TrackNothing"};
        window.Deactivated+=(_,_)=>{if(window.IsVisible) {window.Hide();flyoutHidden=DateTime.UtcNow;}};
        window.IsVisibleChanged+=(_,_)=>{if(!Seen) {trimTimer.Stop();trimTimer.Start();}};
        var root=new DockPanel {LastChildFill=true};
        var header=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(0,0,0,14)};
        var word=Look.Wordmark(14);word.Margin=new Thickness(8,0,0,0);header.Children.Add(Look.Mark(16,Look.Accent));header.Children.Add(word);
        DockPanel.SetDock(header,Dock.Top);root.Children.Add(header);

        var mark=new ContentControl {Width=40,Height=40};
        var title=new TextBlock {FontSize=18,FontWeight=FontWeights.SemiBold,TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var detail=new TextBlock {FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(0,3,0,0),TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var toggle=new ToggleButton {Style=(Style)FindResource("Switch"),VerticalAlignment=VerticalAlignment.Center};
        toggle.Click+=(_,_)=>{Toggle();toggle.IsChecked=connection.Active;};
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(14,0,12,0)};texts.Children.Add(title);texts.Children.Add(detail);
        var card=new Border {CornerRadius=new CornerRadius(10),Padding=new Thickness(16),Child=Columns(mark,texts,toggle)};
        // The status (card, note, rates) and the location list share one area that fills the flyout above the
        // location row: the list fades in over the status, so the flyout never changes size and nothing moves.
        var status=new StackPanel {VerticalAlignment=VerticalAlignment.Top};
        status.Children.Add(card);
        var (note,noteText)=SwitchNote(12);note.Margin=new Thickness(0,10,0,0);
        status.Children.Add(note);
        var rate=new RateBars {Height=36,Margin=new Thickness(2,12,2,0),Opacity=0};
        status.Children.Add(rate);
        var pickList=new StackPanel();
        var pickScroll=new ScrollViewer {VerticalScrollBarVisibility=ScrollBarVisibility.Auto,HorizontalScrollBarVisibility=ScrollBarVisibility.Disabled,Content=pickList,Margin=new Thickness(0,8,0,0)};
        var picker=new DockPanel {LastChildFill=true,Opacity=0,IsHitTestVisible=false};
        var pickTitle=Dossier.Section("section_locations");DockPanel.SetDock(pickTitle,Dock.Top);
        picker.Children.Add(pickTitle);picker.Children.Add(pickScroll);
        var middle=new Grid();middle.Children.Add(status);middle.Children.Add(picker);

        var badge=new ContentControl();
        var place=new TextBlock {FontSize=13,FontWeight=FontWeights.SemiBold,TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var placeDetail=new TextBlock {FontSize=11,Foreground=Look.Secondary,Margin=new Thickness(0,2,0,0),TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap};
        var placeTexts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,8,0)};placeTexts.Children.Add(place);placeTexts.Children.Add(placeDetail);
        // Points up at the list while it is open.
        var chevron=Look.Icon("",10,Look.Secondary);chevron.RenderTransformOrigin=new Point(0.5,0.5);chevron.RenderTransform=new RotateTransform(0);
        var placeRow=new Button {Height=52,Padding=new Thickness(12,0,12,0),Background=Look.Surface,BorderThickness=new Thickness(0),Margin=new Thickness(0,12,0,0),Content=Columns(badge,placeTexts,chevron)};
        AutomationProperties.SetHelpText(placeRow,L10n.Text("tap_to_change"));
        placeRow.Click+=(_,_)=>SetFlyPicking(!flyPicking);
        window.KeyDown+=(_,e)=>{if(e.Key==Key.Escape) {if(flyPicking) SetFlyPicking(false);else window.Hide();e.Handled=true;}};

        var usage=new TextBlock {Text="—",FontSize=13,FontWeight=FontWeights.SemiBold};var until=new TextBlock {Text="—",FontSize=13,FontWeight=FontWeights.SemiBold};
        var cells=Cells(("last_30_days",usage,11),("valid_until_label",until,11));cells.Margin=new Thickness(4,14,4,14);

        // The window's menu in small: open it, check for updates (its state on the right), quit.
        var footer=new StackPanel();
        footer.Children.Add(FlyMenuRow(L10n.Text("open_main_window"),null,ShowFromTray));
        var updateValue=new TextBlock();
        footer.Children.Add(FlyMenuRow(L10n.Text("check_for_updates"),updateValue,FlyCheckUpdate));
        footer.Children.Add(FlyMenuRow(L10n.Text("quit_app"),null,Quit));
        DockPanel.SetDock(footer,Dock.Bottom);root.Children.Add(footer);
        DockPanel.SetDock(cells,Dock.Bottom);root.Children.Add(cells);
        // The settings people change most, as four tiles, so the window need not open.
        var smartTile=QuickTile("\uE8AB",L10n.Text("quick_smart_routing"),()=>{Settings.Set("routing",Smart?"global":"smart");if(page=="nodes") Render();ApplyNow();});
        var guardTile=QuickTile("\uE72E",L10n.Text("kill_switch"),()=>{
            var on=!Connection.KillSwitchOn;Settings.Set("killSwitch",on?"on":"off");
            Work(async()=>{if(connection.Active) await Task.Run(()=>core.KillSwitch(on));else await connection.KillSwitchChanged();});
        });
        var loginTile=QuickTile("\uE7E8",L10n.Text("quick_open_at_login"),()=>{if(!LoginTask.Set(!LoginTask.Enabled)) Notify(L10n.Text("unable_to_reach_the_service_check_your_network_and"));});
        // Choosing programs needs the list: this one opens the window on that page.
        var appsTile=QuickTile("\uE71D",L10n.Text("quick_per_app"),()=>{ShowFromTray();page="apps";Render();});
        var tiles=new Grid {Margin=new Thickness(0,8,0,0)};
        for(var i=0;i<2;i++) {tiles.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});tiles.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});}
        var at=0;
        foreach(var tile in new[]{smartTile,guardTile,loginTile,appsTile}) {
            tile.Button.Margin=new Thickness(at%2==0?0:4,at<2?0:8,at%2==0?4:0,0);
            Grid.SetColumn(tile.Button,at%2);Grid.SetRow(tile.Button,at/2);tiles.Children.Add(tile.Button);at++;
        }
        DockPanel.SetDock(tiles,Dock.Bottom);root.Children.Add(tiles);
        DockPanel.SetDock(placeRow,Dock.Bottom);root.Children.Add(placeRow);
        root.Children.Add(middle);

        window.Content=new Border {Background=Look.Hex("#0E0D0C"),BorderBrush=Look.Edge,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(3),Padding=new Thickness(16),Child=root};
        TextElement.SetForeground(window,Look.Text);
        fly=(card,mark,title,detail,toggle,badge,place,placeDetail,usage,until);
        flyRate=rate;flyNote=note;flyNoteText=noteText;
        flyTiles=new[]{smartTile,guardTile,loginTile,appsTile};flyUpdate=updateValue;
        flyPick=(status,picker,pickList,pickScroll,chevron);flyPicking=false;
        return window;
    }
    private (UIElement Status,UIElement Picker,StackPanel List,ScrollViewer Scroll,TextBlock Chevron)? flyPick;
    private (Button Button,Border Dot,TextBlock Glyph)[] flyTiles=[];
    private TextBlock? flyUpdate;
    private bool flyChecking;
    /// One quick setting: a filled tile, its icon lit in the accent while the setting is on. No outline; the label
    /// may take two lines, the tile's height never changes.
    private (Button Button,Border Dot,TextBlock Glyph) QuickTile(string glyph,string title,System.Action onClick) {
        var icon=Look.Icon(glyph,13,Look.Secondary);
        var dot=new Border {Width=28,Height=28,CornerRadius=new CornerRadius(14),Background=Look.Selected,Child=icon,VerticalAlignment=VerticalAlignment.Center};
        var label=new TextBlock {Text=title,FontSize=12,FontWeight=FontWeights.Medium,TextWrapping=TextWrapping.Wrap,MaxHeight=34,TextTrimming=TextTrimming.CharacterEllipsis,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(10,0,0,0)};
        var button=new Button {Height=52,Padding=new Thickness(10,0,8,0),Background=Look.Surface,Content=Columns(dot,label)};
        AutomationProperties.SetName(button,title);
        button.Click+=(_,_)=>{onClick();LightTiles();UpdateFlyout();};
        return (button,dot,icon);
    }
    /// The tiles read the saved settings: when the flyout opens and after a click, not on every tick.
    private void LightTiles() {
        if(flyTiles.Length!=4) return;
        LightTile(flyTiles[0],Smart);LightTile(flyTiles[1],Connection.KillSwitchOn);LightTile(flyTiles[2],LoginTask.Enabled);LightTile(flyTiles[3],AppRouting.Effective.Mode!=AppRouting.All);
    }
    private static void LightTile((Button Button,Border Dot,TextBlock Glyph) tile,bool on) {
        tile.Dot.Background=on?Look.Accent:Look.Selected;tile.Glyph.Foreground=on?Look.OnAccent:Look.Secondary;
        AutomationProperties.SetItemStatus(tile.Button,L10n.Text(on?"on_state":"off_state"));
    }
    private Button FlyMenuRow(string title,TextBlock? value,System.Action onClick) {
        var label=Single(title,13);
        UIElement right=value is null?new FrameworkElement():value;
        if(value is not null) {value.FontSize=13;value.Foreground=Look.Faint;value.TextWrapping=TextWrapping.NoWrap;value.TextTrimming=TextTrimming.CharacterEllipsis;value.VerticalAlignment=VerticalAlignment.Center;value.Margin=new Thickness(8,0,0,0);value.MaxWidth=150;}
        var row=new Button {Height=30,Padding=new Thickness(8,0,8,0),Content=Columns(new FrameworkElement(),label,right)};
        row.Click+=(_,_)=>onClick();
        return row;
    }
    /// A running tunnel takes a changed routing at once, by connecting again; the kill switch keeps blocking meanwhile.
    private void ApplyNow() {
        if(!connection.Active||connection.Since is null) return;
        Work(async()=>{
            restoring?.Cancel();restoring=null;
            await connection.Disconnect("disconnected",unexpected:true);
            try {await connection.Connect(nodeId,Smart);}
            catch(AccessFailure) {Connection.Wanted=false;}
        });
    }
    /// The account row's action from the tray: a known update downloads (or installs); otherwise it checks, the
    /// answer showing on the row itself.
    private async void FlyCheckUpdate() {
        if(update is { } found) {ShowFromTray();StartDownload(found);return;}
        if(flyChecking) return;
        flyChecking=true;UpdateFlyout();
        try {await CheckForUpdateAsync(false);} finally {flyChecking=false;}
        UpdateFlyout();
    }
    private string FlyUpdateText()=>flyChecking?L10n.Text("checking_for_updates"):update is not { } row?L10n.Text("up_to_date"):Phase(row) switch {
        UpdatePhase.Downloading=>L10n.Text("update_downloading_value",Percent(row)+"%"),
        UpdatePhase.Ready=>L10n.Text("update_install"),
        _=>L10n.Text("update_banner_title",row.Version)};
    private bool flyPicking;
    /// Opens or closes the flyout's location list in place of the status.
    private void SetFlyPicking(bool open) {
        if(flyPick is not { } p) return;
        flyPicking=open;
        if(open) {FillFlyPicker();p.Scroll.ScrollToTop();if(nodesData is null) _=QuietNodes();}
        Fade(p.Status,!open);Fade(p.Picker,open);
        p.Chevron.Foreground=open?Look.Accent:Look.Secondary;
        var turn=new DoubleAnimation(open?-90:0,TimeSpan.FromMilliseconds(Motion?200:0)) {EasingFunction=new CubicEase {EasingMode=EasingMode.EaseOut}};
        ((RotateTransform)p.Chevron.RenderTransform).BeginAnimation(RotateTransform.AngleProperty,turn);
    }
    /// The locations, fastest first as in the window: automatic, then each one with its delay. The selected one is a
    /// lifted row with an amber tile; nothing is added, so the rows never move.
    private void FillFlyPicker() {
        if(flyPick is not { } p) return;
        p.List.Children.Clear();
        p.List.Children.Add(PickerRow("",L10n.Text("automatic"),null,null));
        foreach(var (id,name,quality) in PickerNodes()) p.List.Children.Add(PickerRow(id,name,Code(id,name),quality));
        if(nodesData is { Count: 0 }) p.List.Children.Add(new TextBlock {Text=L10n.Text("no_locations_available_refresh_or_contact_your_administrator"),FontSize=12,Foreground=Look.Secondary,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(10,8,10,0)});
    }
    private Button PickerRow(string id,string name,string? code,Quality? quality) {
        var selected=id==nodeId;var unreachable=quality is {Latency: null};
        var badge=Look.Badge(code,24,selected?Look.OnAccent:unreachable?Look.Faint:null);
        if(selected) {badge.Background=Look.Accent;if(badge.Child is TextBlock glyph) glyph.Foreground=Look.OnAccent;if(code is null&&badge.Child is TextBlock star) star.Foreground=Look.OnAccent;}
        var label=Single(name,13,unreachable&&!selected?Look.Faint:Look.Text,strong:selected);label.Margin=new Thickness(10,0,8,0);
        var delay=new TextBlock {Text=PickerDelay(quality),FontSize=11,Foreground=unreachable?Look.Danger:Look.Secondary,TextAlignment=TextAlignment.Right,VerticalAlignment=VerticalAlignment.Center};
        if(!unreachable) Typography.SetNumeralAlignment(delay,FontNumeralAlignment.Tabular);
        var right=new Border {Width=72,VerticalAlignment=VerticalAlignment.Center,
            Child=new Viewbox {Stretch=Stretch.Uniform,StretchDirection=StretchDirection.DownOnly,HorizontalAlignment=HorizontalAlignment.Right,Child=delay}};
        var row=new Button {Height=36,Padding=new Thickness(10,0,10,0),Background=selected?Look.Raised:Brushes.Transparent,Content=Columns(badge,label,right)};
        AutomationProperties.SetName(row,name+(delay.Text.Length>0?", "+delay.Text:"")+(selected?L10n.Text("current_page"):""));
        row.Click+=(_,_)=>{PickLocation(id,name);SetFlyPicking(false);UpdateFlyout();};
        return row;
    }
    /// The saved locations with this PC's last results, fastest first, never measured last.
    private List<(string Id,string Name,Quality? Quality)> PickerNodes()=>(nodesData??new JsonArray()).Where(n=>n?["id"] is not null)
        .Select(n=>(Id:n!["id"]!.GetValue<string>(),Name:n["name"]?.GetValue<string>()??"",Quality:Latency.Recent.TryGetValue(n["id"]!.GetValue<string>(),out var q)?q:null))
        .GroupBy(x=>x.Id).Select(g=>g.First()).OrderBy(x=>x.Quality?.Score??long.MaxValue).ToList();
    private static string PickerDelay(Quality? quality)=>quality is null?"":Ms(quality)??L10n.Text("quality_unreachable");
    /// A location picked in the tray: the window's choice, without opening it or changing its page. Picking the
    /// location already in use does nothing.
    private void PickLocation(string id,string name) {
        if(id==nodeId&&(id.Length==0||!connection.Active||connection.NodeId==id)) return;
        Select(id,name,showConnect:false);UpdateTray();
    }
    private void UpdateFlyout() {
        if(fly is not { } f||flyout?.IsVisible!=true&&flyState is not null) return;
        var state=State();
        if(state!=flyState) {
            flyState=state;
            var on=state==LinkState.Connected;
            f.Card.Background=on?Look.Raised:Look.Surface;
            f.Mark.Content=Look.Mark(34,state switch {LinkState.Idle=>Look.Faint,LinkState.Failed=>Look.Danger,_=>Look.Accent});
        }
        f.Title.Text=StatusTitle(state);f.Detail.Text=StatusDetail(state);
        f.Switch.IsChecked=connection.Active;f.Switch.IsEnabled=!busy||connection.Active;
        // The flyout's row opens the location list, not the connection check.
        var place=Location(checkable:false);
        f.Badge.Content=Look.Badge(place.Code,28);f.Location.Text=place.Title;f.LocationDetail.Text=place.Detail;
        ShowRates(flyRate,state);ShowSwitch(flyNote,flyNoteText,state);
        ShowFigures(f.Usage,f.Until);
        if(flyUpdate is not null) flyUpdate.Text=FlyUpdateText();
    }

    // ---- Actions ----
    private void Toggle() {
        restoring?.Cancel();restoring=null;
        if(connection.Active) {Connection.Wanted=false;_=connection.Disconnect();return;}
        if(!api.SignedIn) {ShowFromTray();return;}
        if(update?.Mandatory==true) {ShowFromTray();Notify(L10n.Text("update_required_detail"));return;}
        // A failed attempt shows as its cause and the button that fixes it, rather than in a dialog.
        Work(async()=>{
            try {await connection.Connect(nodeId,Smart);}
            catch(AccessFailure error) {Connection.Wanted=false;if(error.Code=="CLIENT_UPDATE_REQUIRED") CheckForUpdate(false);}
        });
    }
    private CancellationTokenSource? restoring;
    /// Connects at launch because the user had left the VPN on. Waits for a network, then retries with backoff
    /// until it connects, the account is refused, or the user connects or disconnects by hand.
    private async Task Restore() {
        var stop=new CancellationTokenSource();restoring=stop;
        Journal.Add("connect: restoring, the VPN was on");
        var attempt=0;
        while(!stop.IsCancellationRequested&&Connection.Wanted&&!connection.Active&&api.SignedIn) {
            var wait=TimeSpan.FromSeconds(5);
            if(await Task.Run(Transports.Online)) {
                try {await connection.Connect(nodeId,Smart);if(connection.Active) return;}
                catch(AccessFailure error) when (Connection.Fatal.Contains(error.Code)) {Render();return;}
                catch(Exception) {connection.ClearError();/* tried again below */}
                wait=Connection.Retries[Math.Min(attempt++,Connection.Retries.Length-1)];
            }
            try {await Task.Delay(wait,stop.Token);} catch(OperationCanceledException) {return;}
        }
    }
    private void ChooseRouting(string value) {
        if(connection.Active) {Notify(L10n.Text("disconnect_before_changing_routing"));return;}
        Settings.Set("routing",value);if(page=="nodes") Render();
    }
    private void Select(string id,string name,bool showConnect=true) {
        var reconnect=connection.Active&&id!=connection.NodeId;
        nodeId=id;nodeName=name;Settings.Set("nodeId",id);Settings.Set("nodeName",name);
        if(!connection.Active&&connection.ErrorCode.Length>0) connection.ClearError();
        if(showConnect) page="connect";
        if(showConnect||page is "connect" or "nodes") Render();
        // Connected (or reconnecting): one click moves the VPN to the new location; the kill switch keeps blocking meanwhile.
        if(reconnect) Work(async()=>{
            restoring?.Cancel();restoring=null;
            await connection.Disconnect("disconnected",unexpected:true);
            try {await connection.Connect(nodeId,Smart);}
            catch(AccessFailure) {Connection.Wanted=false;}
        });
    }
    /// What a failure's button does: try again, or go where the cause is fixed.
    private void Act(string? what) {
        switch(what) {
            case "devices" or "nodes" or "account":ShowFromTray();page=what!;Render();break;
            case "automatic":Select("","",showConnect:false);Toggle();break;
            case "update":ShowFromTray();CheckForUpdate(true);break;
            case "send":_=SendCheck();break;
            case "wifi":try {System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:network") {UseShellExecute=true});} catch {/* no Settings app */}break;
            case "signin":connection.ClearError();Work(async()=>{await api.Logout();accountData=null;page="connect";Render();});break;
            default:Toggle();break;
        }
    }
    private void CheckForUpdate(bool announce)=>_=CheckForUpdateAsync(announce);
    private async Task CheckForUpdateAsync(bool announce) {
        try {
            if(await api.LatestRelease() is not { } found) {if(announce) Notify(L10n.Text("unable_to_reach_the_service_check_your_network_and"));return;}
            if(found.Update?.Build!=update?.Build||found.Announcement!=announcement) {
                if(downloading&&found.Update?.Build!=update?.Build) await Task.Run(core.CancelDownload);
                update=found.Update;announcement=found.Announcement;downloadError="";if(!busy) Render();
            }
            if(announce&&update is null) Notify(L10n.Text("up_to_date"));
        } catch {/* checked again later */}
    }

    // ---- Updates: downloaded by the core (mirror first, then the server, resuming), then the installer runs silently.
    private enum UpdatePhase {Available,Downloading,Ready,Failed}
    private static string UpdateFile(ReleaseUpdate available)=>System.IO.Path.Combine(System.IO.Path.GetTempPath(),"TrackNothing-update",$"TrackNothing-{available.Build}-setup.exe");
    private static bool Downloaded(ReleaseUpdate available) {var file=new FileInfo(UpdateFile(available));return file.Exists&&file.Length==available.Size;}
    private UpdatePhase Phase(ReleaseUpdate available)=>downloading?UpdatePhase.Downloading:Downloaded(available)?UpdatePhase.Ready:downloadError.Length>0?UpdatePhase.Failed:UpdatePhase.Available;
    /// A "later" hides that build for three days; a newer build shows again at once.
    private static bool Dismissed(ReleaseUpdate available)=>!available.Mandatory&&Settings.Get("updateDismissedBuild")==available.Build.ToString()
        &&DateTime.TryParse(Settings.Get("updateDismissedAt"),null,System.Globalization.DateTimeStyles.RoundtripKind,out var at)&&DateTime.UtcNow-at<TimeSpan.FromDays(3);
    private (long Received,long Size,long Seconds) Progress(ReleaseUpdate available) {
        var size=download?["size"]?.GetValue<long>()??0;
        return (download?["received"]?.GetValue<long>()??0,size>0?size:available.Size,download?["seconds"]?.GetValue<long>()??-1);
    }
    private int Percent(ReleaseUpdate available) {var (received,size,_)=Progress(available);return (int)Math.Clamp(received*100/Math.Max(1,size),0,100);}
    /// "18.7 MB / 41.2 MB · about 10 s"; the time appears once the core's rate has settled.
    private string DownloadMeta(ReleaseUpdate available) {
        var (received,size,seconds)=Progress(available);
        var left=seconds<0?"":seconds<60?L10n.Text("update_seconds",seconds.ToString("N0",L10n.Culture)):L10n.Text("update_minutes",((seconds+59)/60).ToString("N0",L10n.Culture));
        return $"{Bytes(received)} / {Bytes(size)}"+(left.Length==0?"":" · "+L10n.Text("update_time_left",left));
    }
    /// Fills the home banner and the account row; called on every progress tick.
    private void ShowUpdate() {
        if(updateRowValue is not null) updateRowValue.Text=update is not { } row?L10n.Text("up_to_date"):Phase(row) switch {
            UpdatePhase.Downloading=>L10n.Text("update_downloading_value",Percent(row)+"%"),
            UpdatePhase.Ready=>L10n.Text("update_install"),
            _=>L10n.Text("update_banner_title",row.Version)};
        if(bannerHost is null) return;
        if(update is not { } available||Phase(available)==UpdatePhase.Available&&Dismissed(available)) {bannerHost.Content=null;bannerHost.Visibility=Visibility.Collapsed;return;}
        bannerHost.Visibility=Visibility.Visible;
        bannerHost.Content=Phase(available) switch {
            UpdatePhase.Downloading=>ProgressCard(available),
            UpdatePhase.Ready=>BannerRow(L10n.Text("update_ready_title",available.Version),L10n.Text(connection.Active?"update_ready_detail":"update_ready_detail_idle"),BannerButton(L10n.Text("update_install"),true,()=>InstallUpdate(available))),
            UpdatePhase.Failed=>BannerRow(L10n.Text("update_failed_title",available.Version),
                L10n.Text(downloadError switch {"digest"=>"update_failed_digest","storage"=>"update_failed_storage",_=>"update_failed_network"}),BannerButton(L10n.Text("update_retry"),false,()=>StartDownload(available))),
            _=>BannerRow(L10n.Text(available.Mandatory?"update_required_title":"update_banner_title",available.Version),
                available.Mandatory?L10n.Text("update_required_detail"):L10n.Notes(available.Notes).FirstOrDefault()??L10n.Text("update_available_detail"),
                BannerButton(L10n.Text("update_action"),false,()=>StartDownload(available)),available.Mandatory?null:LaterButton(available)),
        };
        // The banner shows the first improvement; a click lists them all, with the update button.
        if(Phase(available)==UpdatePhase.Available&&!available.Mandatory&&L10n.Notes(available.Notes) is { Count: >1 } items&&bannerHost.Content is Border banner) {
            banner.Cursor=Cursors.Hand;banner.Background=Brushes.Transparent;
            banner.MouseLeftButtonUp+=(_,_)=>{if(ShowNotes(available.Version,items,true)) StartDownload(available);};
        }
    }
    /// What's new in a version, one line per improvement; with offerUpdate, true when the user chose to update.
    private bool ShowNotes(string version,List<string> items,bool offerUpdate=false) {
        var text=string.Join("\n",items.Select(item=>"· "+item));
        if(!offerUpdate) {MessageBox.Show(this,text,L10n.Text("whats_new_title",version),MessageBoxButton.OK);return false;}
        return MessageBox.Show(this,text+"\n\n"+L10n.Text("update_action")+"?",L10n.Text("whats_new_title",version),MessageBoxButton.YesNo)==MessageBoxResult.Yes;
    }
    private static Button BannerButton(string title,bool filled,Action onClick) {
        var button=new Button {Content=title,FontSize=13,FontWeight=FontWeights.SemiBold,Height=32,Padding=new Thickness(12,0,12,0),Margin=new Thickness(8,0,0,0),
            Foreground=filled?Look.OnAccent:Look.Accent,Background=filled?Look.Accent:Brushes.Transparent,BorderThickness=new Thickness(0),VerticalAlignment=VerticalAlignment.Center};
        button.Click+=(_,_)=>onClick();
        return button;
    }
    private Button LaterButton(ReleaseUpdate available) {
        var button=new Button {Width=32,Height=32,Padding=new Thickness(0),Margin=new Thickness(2,0,0,0),Content=Look.Icon("\uE711",11,Look.Faint),HorizontalContentAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(button,L10n.Text("update_later"));
        button.Click+=(_,_)=>{Settings.Set("updateDismissedBuild",available.Build.ToString());Settings.Set("updateDismissedAt",DateTime.UtcNow.ToString("o"));ShowUpdate();};
        return button;
    }
    private static Border BannerRow(string title,string detail,Button action,Button? later=null) {
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
        texts.Children.Add(Words(title,13,strong:true));texts.Children.Add(Words(detail,12,Look.Secondary,top:2));
        var actions=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};actions.Children.Add(action);if(later is not null) actions.Children.Add(later);
        return new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(14,10,later is null?10:4,10),Child=Columns(new FrameworkElement(),texts,actions),Margin=new Thickness(0,0,0,8)};
    }
    /// Title, size and time left, a big percentage, and a bar of square blocks (the brand's pixel accent).
    private Border ProgressCard(ReleaseUpdate available) {
        var percent=Percent(available);
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
        texts.Children.Add(Single(L10n.Text(available.Mandatory?"update_required_title":"update_downloading_title",available.Version),13,strong:true));
        var meta=Single(DownloadMeta(available),12,Look.Secondary);meta.Margin=new Thickness(0,3,0,0);texts.Children.Add(meta);
        var right=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};
        right.Children.Add(new TextBlock {Text=percent+"%",FontFamily=Look.Dots,FontSize=24,Foreground=Look.Accent,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(8,0,0,0)});
        if(!available.Mandatory) {var cancel=new Button {Content=L10n.Text("cancel"),FontSize=13,Height=32,Padding=new Thickness(10,0,10,0),Foreground=Look.Secondary,Background=Brushes.Transparent,VerticalAlignment=VerticalAlignment.Center};
            cancel.Click+=async(_,_)=>await Task.Run(core.CancelDownload);right.Children.Add(cancel);}
        var blocks=new UniformGrid {Rows=1,Columns=40,Margin=new Thickness(0,10,8,0)};
        for(var i=0;i<40;i++) blocks.Children.Add(new Rectangle {Height=6,Margin=new Thickness(0,0,i<39?3:0,0),Fill=i<percent*40/100?Look.Accent:Look.Raised});
        AutomationProperties.SetName(blocks,percent+"%");
        var stack=new StackPanel();stack.Children.Add(Columns(new FrameworkElement(),texts,right));stack.Children.Add(blocks);
        return new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(14,12,6,12),Child=stack,Margin=new Thickness(0,0,0,8)};
    }
    private async void StartDownload(ReleaseUpdate available) {
        if(downloading) return;
        if(Downloaded(available)) {InstallUpdate(available);return;}
        // An older server sends no digest: only the download page is possible.
        if(!available.InApp) {Process.Start(new ProcessStartInfo(available.Download.AbsoluteUri) {UseShellExecute=true});return;}
        downloading=true;downloadError="";download=null;ShowUpdate();downloadTimer.Start();
        var file=UpdateFile(available);
        Journal.Add($"update: download {available.Version}+{available.Build} ({available.Size/1024} KB, {(available.Urls.Length==0?"server":"mirror first")})");
        JsonObject result;
        try {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
            foreach(var stale in Directory.GetFiles(System.IO.Path.GetDirectoryName(file)!).Where(f=>!System.IO.Path.GetFileName(f).StartsWith(System.IO.Path.GetFileName(file),StringComparison.Ordinal))) File.Delete(stale);
            result=await api.DownloadUpdate(available,file);
        } catch(Exception error) {result=new JsonObject {["state"]="failed",["error"]=error is IOException?"storage":"network"};}
        downloading=false;downloadTimer.Stop();download=result;
        var state=result["state"]?.GetValue<string>();
        Journal.Add($"update: {state}"+(result["source"]?.GetValue<string>() is { Length: >0 } source?" via "+source:"")+(result["error"]?.GetValue<string>() is { Length: >0 } code?$" ({code} {Journal.Scrub(result["detail"]?.GetValue<string>()??"")})":""));
        if(state=="failed") downloadError=result["error"]?.GetValue<string>() is { Length: >0 } failure?failure:"network";
        ShowUpdate();
        // Straight to the installer when nobody would lose a connection; otherwise the banner offers Install.
        if(state=="done"&&!connection.Active&&IsVisible) InstallUpdate(available);
    }
    /// Runs the verified installer silently; it closes this app, upgrades in place and starts the new version.
    private void InstallUpdate(ReleaseUpdate available) {
        if(!Downloaded(available)) {StartDownload(available);return;}
        Settings.Set("reconnectAfterUpdate",connection.Active?"1":"0");
        Journal.Add($"update: running installer {available.Build}");
        try {Process.Start(new ProcessStartInfo(UpdateFile(available),"/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS") {UseShellExecute=false});}
        catch(Exception error) {Journal.Add("update: installer did not start ("+error.GetType().Name+")");Settings.Set("reconnectAfterUpdate","0");Notify(L10n.Text("update_failed"));return;}
        Quit();
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
    /// Called with each newer location list loaded in the background, and as measurements arrive (false) and finish
    /// (true); set by the location page.
    private Action<JsonArray>? onNodes;
    private Action<bool>? onMeasured;
    private bool loadingNodes;
    /// Loads the location list and saves it on disk.
    private async Task<JsonArray> LoadNodes() {
        var nodes=(await api.Request("nodes"))["nodes"]!.AsArray();
        NodeStore.SaveNodes(nodes);
        Remember(nodes);
        return nodes;
    }
    private void Remember(JsonArray nodes) {
        nodesData=nodes;
        foreach(var node in nodes) {
            if(node?["id"]?.GetValue<string>() is not { } id) continue;
            var name=node["name"]?.GetValue<string>()??"";
            var code=node["countryCode"]?.GetValue<string>() is { Length: >0 } country?country.ToUpperInvariant():name.Length>0?name[..1].ToUpperInvariant():"";
            directory[id]=(name,code);
        }
    }
    private async Task RefreshAccount() {
        try {var data=await api.Request("account");accountData=data;ShowUsage();UpdateFlyout();UpdateTray();Remind();}
        catch {/* usage is a nicety; the next visit retries */}
    }
    /// The once-per-step reminder as a tray balloon (Windows shows it as a notification).
    private void Remind() {
        if(AccessReminders.Due(AccountAccess.From(accountData),Bytes) is not { } due) return;
        reminderBalloon=true;tray.ShowBalloonTip(8000,due.Title,due.Text,Forms.ToolTipIcon.None);
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
        return new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Child=stack};
    }
    private static Button Primary(string title)=>new() {Content=title,Height=40,Background=Look.Accent,BorderThickness=new Thickness(0),Foreground=Look.OnAccent,FontWeight=FontWeights.SemiBold,HorizontalContentAlignment=HorizontalAlignment.Center};
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

    // ---- Activity panel ----
    /// Signed in, the window widens to hold the activity panel; signed out it is the small window again.
    private void ShowActivity(bool on) {
        var width=on?1040.0:380.0;
        if(on) {
            // Rebuilt after a language change so its labels follow.
            if(activity is null||activity.Tag as string!=L10n.Culture.Name) {activity=new ActivityPanel {Tag=L10n.Culture.Name};ActivityHost.Content=activity;}
            ActivityHost.Visibility=Visibility.Visible;
        } else {ActivityHost.Visibility=Visibility.Collapsed;ActivityHost.Content=null;activity=null;}
        if(Width==width) return;
        Width=width;
        // Keep the wider window on the screen it is on.
        var area=SystemParameters.WorkArea;
        if(Left+width>area.Right) Left=Math.Max(area.Left,area.Right-width-8);
    }
    private async void RefreshActivity() {
        if(activity is null||activityLoading||!IsVisible||WindowState==WindowState.Minimized) return;
        if(!connection.Active||connection.Since is null) {activity.Update(null,"");return;}
        activityLoading=true;
        try {
            var json=await Task.Run(core.Activity);
            activity?.Update(JsonNode.Parse(json),connection.NodeName);
        } catch {/* the next tick tries again */}
        finally {activityLoading=false;}
    }

    // ---- Rate chart, switch note and connection check ----
    /// One sample a second while connected; cleared otherwise.
    private void SampleRates() {
        if(connection.Active&&connection.Since is not null) {
            rxHistory.Add(connection.RxRate);txHistory.Add(connection.TxRate);
            if(rxHistory.Count>RateBars.Count) {rxHistory.RemoveAt(0);txHistory.RemoveAt(0);}
        } else {rxHistory.Clear();txHistory.Clear();}
    }
    private void ShowRates(RateBars? bars,LinkState state) {
        if(bars is null) return;
        var on=state==LinkState.Connected;
        // The chart keeps its space and fades, so neither the window nor the tray flyout changes height.
        Fade(bars,on);
        if(on) bars.Set(rxHistory.ToArray(),txHistory.ToArray());
    }
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<UIElement,System.Runtime.CompilerServices.StrongBox<double>> fades=new();
    /// Fades an element in or out; it keeps its space either way. Calls with the target it already has do nothing,
    /// so the once-a-second refresh never restarts a fade.
    private static void Fade(UIElement element,bool on) {
        var target=on?1.0:0.0;
        if(fades.TryGetValue(element,out var box)&&box.Value==target) return;
        fades.AddOrUpdate(element,new System.Runtime.CompilerServices.StrongBox<double>(target));
        element.Visibility=Visibility.Visible;element.IsHitTestVisible=on;
        if(!Motion||!element.IsVisible) {element.BeginAnimation(OpacityProperty,null);element.Opacity=target;return;}
        element.BeginAnimation(OpacityProperty,new DoubleAnimation(target,TimeSpan.FromMilliseconds(on?220:160)) {EasingFunction=new CubicEase {EasingMode=EasingMode.EaseOut}});
    }
    /// "Tokyo 03 did not answer, switched to Tokyo 05": one line with a close button, shown after automatic switching.
    private (Border Note,TextBlock Text) SwitchNote(double size) {
        var text=Single("",size);text.Margin=new Thickness(12,0,8,0);
        var close=new Button {Width=32,Height=32,Padding=new Thickness(0),Content=Look.Icon("\uE711",10,Look.Secondary),HorizontalContentAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(close,L10n.Text("close"));
        close.Click+=(_,_)=>{dismissedSwitch=connection.SwitchedFrom;UpdateLive();};
        var dot=new Rectangle {Width=6,Height=6,Fill=Look.Accent,VerticalAlignment=VerticalAlignment.Center};
        var note=new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(14,4,4,4),Child=Columns(dot,text,close),Visibility=Visibility.Collapsed};
        return (note,text);
    }
    private void ShowSwitch(Border? note,TextBlock? text,LinkState state) {
        if(note is null||text is null) return;
        var from=connection.SwitchedFrom;
        var shown=state==LinkState.Connected&&from.Length>0&&from!=dismissedSwitch&&from!=connection.NodeName&&connection.NodeName.Length>0;
        text.Text=shown?L10n.Text("switched_location",from,connection.NodeName):"";
        note.Visibility=shown?Visibility.Visible:Visibility.Collapsed;
        if(shown) AutomationProperties.SetName(note,text.Text);
    }
    private JsonNode? NodeData(string id)=>nodesData?.FirstOrDefault(node=>node?["id"]?.GetValue<string>()==id);
    /// "host:port,host:port" the node answers TCP on (its latency probes), outside the tunnel; the first answer counts.
    private static string? ProbeAddress(JsonNode? node) {
        if(node is null) return null;
        var list=Latency.Probes(node).Select(p=>(p.Host.Contains(':')?$"[{p.Host}]":p.Host)+":"+p.Port).ToList();
        return list.Count==0?null:string.Join(",",list);
    }
    /// The connection check: three legs timed on demand. Your network = a small page fetched outside the tunnel,
    /// to the location = a TCP connect to the node outside the tunnel, opening a page = the test page through the
    /// transport carrying traffic now. One sentence then says which leg is slow.
    private async void ConnectionCheck() {
        if(nodesData is null) {try {await LoadNodes();} catch {/* the node leg shows no answer */}}
        var id=connection.NodeId;var name=connection.NodeName.Length>0?connection.NodeName:directory.TryGetValue(id,out var known)?known.Name:L10n.Text("location");
        var node=NodeData(id);var address=ProbeAddress(node);var region=node?["region"]?.GetValue<string>()??"";
        var window=new Window {Owner=this,Width=348,SizeToContent=SizeToContent.Height,WindowStyle=WindowStyle.None,AllowsTransparency=true,Background=Brushes.Transparent,
            ResizeMode=ResizeMode.NoResize,ShowInTaskbar=false,WindowStartupLocation=WindowStartupLocation.CenterOwner,FontFamily=FontFamily,UseLayoutRounding=true,Title=L10n.Text("check_title"),
            Language=Language};
        TextOptions.SetTextFormattingMode(window,TextFormattingMode.Display);
        window.Deactivated+=(_,_)=>{if(window.IsVisible) window.Close();};
        window.KeyDown+=(_,e)=>{if(e.Key==Key.Escape) window.Close();};
        var stack=new StackPanel();
        var status=Single("",12,Look.Secondary);status.Margin=new Thickness(12,0,4,0);status.HorizontalAlignment=HorizontalAlignment.Right;
        var close=IconButton("\uE711",L10n.Text("close"),window.Close);
        var right=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center};right.Children.Add(status);right.Children.Add(close);
        stack.Children.Add(Columns(Single(L10n.Text("check_title"),17,strong:true),new FrameworkElement(),right));
        (Rectangle Mark,TextBlock Value) Leg(string title,string detail) {
            var mark=new Rectangle {Width=8,Height=8,Fill=Look.Faint,VerticalAlignment=VerticalAlignment.Center};
            var value=new TextBlock {Text="—",FontFamily=Look.Dots,FontSize=20,Foreground=Look.Faint,VerticalAlignment=VerticalAlignment.Center,TextWrapping=TextWrapping.NoWrap,Margin=new Thickness(8,0,0,0)};
            var texts=TwoLines(title,detail);texts.Margin=new Thickness(14,0,8,0);
            stack.Children.Add(new Border {Height=56,Child=Columns(mark,texts,value)});
            return (mark,value);
        }
        var local=Leg(L10n.Text("check_local"),L10n.Text("check_local_detail"));
        var toNode=Leg(L10n.Text("check_node"),name);
        var web=Leg(L10n.Text("check_web"),L10n.Text("check_web_detail"));
        var verdict=Words("",13);verdict.TextWrapping=TextWrapping.Wrap;
        stack.Children.Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(14,12,14,12),Margin=new Thickness(0,8,0,0),Child=verdict});
        if(region.Length>0) {
            var exit=Columns(Single(L10n.Text("check_exit"),12,Look.Secondary),new FrameworkElement(),Single(region,12));
            exit.Margin=new Thickness(2,12,2,0);stack.Children.Add(exit);
        }
        // This node's lines (Line 1…4), each with its delay and the one carrying traffic marked "in use".
        var linesLabel=Single(L10n.Text("check_lines"),12,Look.Secondary);linesLabel.Margin=new Thickness(2,14,0,0);linesLabel.Visibility=Visibility.Collapsed;
        stack.Children.Add(linesLabel);
        var lineGrid=new UniformGrid {Columns=2,Margin=new Thickness(0,8,0,0),Visibility=Visibility.Collapsed};
        var lineBoxes=new List<(ContentControl Cell,TextBlock Now,TextBlock Value)>();
        for(var i=0;i<Latency.LineOrder.Length;i++) {
            var cellHost=new ContentControl {Focusable=false,Content=LineCells(new[]{LineState.Wait}),Margin=new Thickness(0,0,8,0),VerticalAlignment=VerticalAlignment.Center};
            var now=Single(L10n.Text("line_in_use"),11,Look.Accent);now.Opacity=0;now.Margin=new Thickness(6,0,0,0);
            var value=Single("—",12,Look.Faint);value.FontFamily=new FontFamily("Cascadia Mono, Consolas");
            var left=new StackPanel {Orientation=Orientation.Horizontal};left.Children.Add(cellHost);left.Children.Add(Single(LineName(i),13));left.Children.Add(now);
            lineGrid.Children.Add(new Border {Height=34,Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(10,0,10,0),
                Margin=new Thickness(i%2==0?0:3,i>1?6:0,i%2==0?3:0,0),Child=Columns(left,new FrameworkElement(),value)});
            lineBoxes.Add((cellHost,now,value));
        }
        stack.Children.Add(lineGrid);
        var lineNote=Words("",12,Look.Secondary,top:8);lineNote.TextWrapping=TextWrapping.Wrap;lineNote.Visibility=Visibility.Collapsed;
        stack.Children.Add(lineNote);
        void ShowLines(IReadOnlyDictionary<string,long>? lines,string current) {
            if(LineStates(lines) is not { } states||lines is null) return;
            linesLabel.Visibility=Visibility.Visible;lineGrid.Visibility=Visibility.Visible;
            for(var i=0;i<Latency.LineOrder.Length;i++) {
                var name_=Latency.LineOrder[i];var box=lineBoxes[i];var has=lines.TryGetValue(name_,out var lineMs);
                box.Cell.Content=LineCells(new[]{states[i]});
                box.Value.Text=LineValue(lines,name_);box.Value.Foreground=!has?Look.Faint:lineMs<0?Look.Danger:Look.Text;
                box.Now.BeginAnimation(UIElement.OpacityProperty,new DoubleAnimation(name_==current?1:0,new Duration(TimeSpan.FromMilliseconds(200))));
            }
            var down=Latency.LineOrder.Select((n,i)=>(Name:n,Index:i)).Where(x=>lines.TryGetValue(x.Name,out var v)&&v<0).ToList();
            var used=Array.IndexOf(Latency.LineOrder,current);
            var text=down.Count>0&&used>=0&&lines.TryGetValue(current,out var usedMs)&&usedMs>=0?L10n.Text("check_lines_note",string.Join(ListJoin,down.Select(x=>LineName(x.Index))),LineName(used)):"";
            lineNote.Text=text;lineNote.Visibility=text.Length>0?Visibility.Visible:Visibility.Collapsed;
        }
        var currentNow="";try {currentNow=core.Now(Transports.Group);} catch {/* not connected */}
        ShowLines(Latency.Recent.TryGetValue(id,out var known_)?known_.Lines:null,currentNow);

        // The speed of the current connection: a few seconds of download through the line carrying traffic now.
        var speedStack=new StackPanel();
        var elapsed=Single("—",11,Look.Secondary);elapsed.FontFamily=new FontFamily("Cascadia Mono, Consolas");
        speedStack.Children.Add(Columns(Single(L10n.Text("speed_title"),12,Look.Secondary),new FrameworkElement(),elapsed));
        var mbpsText=new TextBlock {Text="—",FontFamily=Look.Dots,FontSize=40,Foreground=OffCell,VerticalAlignment=VerticalAlignment.Bottom};
        var figure=new StackPanel {Orientation=Orientation.Horizontal,Height=50,Margin=new Thickness(0,8,0,0)};
        figure.Children.Add(mbpsText);
        var unit=Single("Mbps",12,Look.Secondary);unit.VerticalAlignment=VerticalAlignment.Bottom;unit.Margin=new Thickness(6,0,0,6);figure.Children.Add(unit);
        speedStack.Children.Add(figure);
        var bar=new UniformGrid {Rows=1,Columns=30,Margin=new Thickness(0,10,0,0)};
        var barEmpty=Look.Hex("#201E1B");
        for(var i=0;i<30;i++) bar.Children.Add(new Rectangle {Height=6,Margin=new Thickness(0,0,i<29?2:0,0),Fill=barEmpty});
        speedStack.Children.Add(bar);
        var stats=new UniformGrid {Columns=3,Margin=new Thickness(0,12,0,0)};
        TextBlock Stat(string title) {
            var value=Single("—",13);value.FontFamily=new FontFamily("Cascadia Mono, Consolas");
            var panel=new StackPanel();panel.Children.Add(Single(title,11,Look.Secondary));value.Margin=new Thickness(0,2,0,0);panel.Children.Add(value);stats.Children.Add(panel);
            return value;
        }
        var latencyText=Stat(L10n.Text("speed_latency"));var jitterText=Stat(L10n.Text("speed_jitter"));var usedText=Stat(L10n.Text("speed_used"));
        speedStack.Children.Add(stats);
        var speedNote=Single(L10n.Text("speed_hint"),12,Look.Secondary);speedNote.Height=18;speedNote.Margin=new Thickness(0,12,0,0);
        speedStack.Children.Add(speedNote);
        stack.Children.Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(14),Margin=new Thickness(0,16,0,0),Child=speedStack});
        var speedButton=Primary(L10n.Text("speed_start"));speedButton.Margin=new Thickness(0,14,0,0);
        stack.Children.Add(speedButton);
        var speedLine="";
        void ShowSpeed(JsonNode? status) {
            var state=status?["state"]?.GetValue<string>()??"idle";
            var running=state is "ping" or "download";
            var seconds=Math.Max(1,status?["seconds"]?.GetValue<int>()??6);
            var elapsedMs=status?["elapsedMs"]?.GetValue<long>()??0;
            var measured=state is "download" or "done";
            var fraction=state=="done"?1:state=="download"?Math.Min(1,elapsedMs/(seconds*1000.0)):0;
            for(var i=0;i<30;i++) ((Rectangle)bar.Children[i]).Fill=i<(int)(fraction*30)?(state=="done"?Look.Accent:Look.Secondary):barEmpty;
            elapsed.Text=measured?string.Format(L10n.Culture,"{0:0.0} / {1:0.0} s",Math.Min(elapsedMs,seconds*1000L)/1000.0,(double)seconds):"—";
            mbpsText.Text=measured?(status?["mbps"]?.GetValue<double>()??0).ToString("0.0",L10n.Culture):"—";
            mbpsText.Foreground=state=="done"?Look.Accent:state=="download"?Look.Secondary:OffCell;
            var latency=status?["latency"]?.GetValue<int>()??-1;var jitter=status?["jitter"]?.GetValue<int>()??-1;var bytes=status?["bytes"]?.GetValue<long>()??0;
            latencyText.Text=latency>=0?L10n.Text("latency_ms",latency.ToString("N0",L10n.Culture)):"—";
            jitterText.Text=jitter>=0?L10n.Text("latency_ms",jitter.ToString("N0",L10n.Culture)):"—";
            usedText.Text=bytes>0?Bytes(bytes):"—";
            if(status?["line"]?.GetValue<string>() is { Length: >0 } line) speedLine=line;
            var lineIndex=Array.IndexOf(Latency.LineOrder,speedLine);var over=lineIndex>=0?LineName(lineIndex):name;
            speedNote.Text=state switch {
                "ping" or "download"=>L10n.Text("speed_downloading",over),
                "done"=>lineIndex>=0?L10n.Text("speed_done",over,name):name,
                "failed"=>L10n.Text("speed_failed"),
                _=>L10n.Text("speed_hint"),
            };
            speedButton.Content=L10n.Text(running?"speed_running":state is "done" or "failed"?"speed_again":"speed_start");
            speedButton.IsEnabled=!running;
        }
        var speedTimer=new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(200)};
        speedTimer.Tick+=async(_,_)=>{
            if(!window.IsVisible) {speedTimer.Stop();return;}
            JsonNode? status=null;
            try {status=JsonNode.Parse(await Task.Run(core.SpeedProgress));} catch {/* keep the last figures */}
            if(status is null) return;
            ShowSpeed(status);
            var state=status["state"]?.GetValue<string>();
            if(state is "ping" or "download") return;
            speedTimer.Stop();
            if(state=="done") Journal.Add($"speed: {status["line"]} {status["mbps"]} Mbps, {status["bytes"]} bytes, latency {status["latency"]} ms, jitter {status["jitter"]} ms");
            else if(state=="failed") Journal.Add($"speed: failed {status["error"]} over {status["line"]}");
        };
        speedButton.Click+=async(_,_)=>{
            var request=new JsonObject {["group"]=Transports.Group,["pingUrl"]=Transports.TestUrl,["url"]=Latency.SpeedUrl,["seconds"]=6};
            var reply="error";
            try {reply=await Task.Run(()=>core.SpeedStart(request.ToJsonString()));} catch {/* core gone */}
            if(reply!="ok") {ShowSpeed(new JsonObject {["state"]="failed"});return;}
            speedLine="";ShowSpeed(new JsonObject {["state"]="ping"});speedTimer.Start();
        };
        window.Closed+=(_,_)=>{speedTimer.Stop();_=Task.Run(core.SpeedStop);};

        var other=Primary(L10n.Text("change_location").Replace("›","").Trim());other.Margin=new Thickness(0,14,0,0);other.Visibility=Visibility.Collapsed;
        other.Click+=(_,_)=>{window.Close();page="nodes";Render();};
        stack.Children.Add(other);
        var again=Plain(L10n.Text("check_again"));again.Height=40;again.Margin=new Thickness(0,10,0,0);
        stack.Children.Add(again);
        window.Content=new Border {Background=Look.Hex("#0E0D0C"),BorderBrush=Look.Edge,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(3),Padding=new Thickness(20,14,14,18),Child=stack};
        TextElement.SetForeground(window,Look.Text);
        void Paint((Rectangle Mark,TextBlock Value) leg,long ms,long limit) {
            var color=ms<0?Look.Danger:ms>limit?Look.Fair:Look.Accent;
            leg.Mark.Fill=color;leg.Value.Foreground=color;
            if(ms<0) {leg.Value.Text=L10n.Text("check_no_answer");leg.Value.FontFamily=FontFamily;leg.Value.FontSize=13;}
            else {leg.Value.Text=L10n.Text("latency_ms",ms.ToString("N0",L10n.Culture));leg.Value.FontFamily=Look.Dots;leg.Value.FontSize=20;}
        }
        var running=false;
        async void RunCheck() {
            if(running) return;
            running=true;again.IsEnabled=false;other.Visibility=Visibility.Collapsed;
            status.Text=L10n.Text("check_running");verdict.Text=L10n.Text("check_running");
            foreach(var leg in new[]{local,toNode,web}) {leg.Mark.Fill=Look.Faint;leg.Value.Foreground=Look.Faint;leg.Value.Text="—";leg.Value.FontFamily=Look.Dots;leg.Value.FontSize=20;}
            long a=-1,b=-1,c=-1;
            await Task.Run(()=>{
                try {a=core.ProbeUrl("DIRECT",Transports.LocalUrl,3000);} catch {/* no answer */}
                try {if(address is not null) b=core.Reach(address,3000);} catch {/* no answer */}
                try {var now=core.Now(Transports.Group);currentNow=now;if(now.Length>0) c=core.ProbeUrl(now,Transports.TestUrl,5000);} catch {/* no answer */}
            });
            // Each line again, outside the tunnel (the app is excluded from it), as the location list measures them.
            IReadOnlyDictionary<string,long>? fresh=null;
            if(node?["test"] is JsonArray { Count: >0 } tests&&await Latency.Real(id,tests) is { } real&&real.Lines.Count>0) {
                fresh=real.Lines;
                if(Latency.Recent.TryGetValue(id,out var last)) Latency.Recent[id]=last with {Lines=real.Lines};
            }
            running=false;again.IsEnabled=true;
            if(!window.IsVisible) return;
            Paint(local,a,300);Paint(toNode,b,300);Paint(web,c,1200);
            ShowLines(fresh??(Latency.Recent.TryGetValue(id,out var recent)?recent.Lines:null),currentNow);
            status.Text=name;
            bool localSlow=a<0||a>300,nodeSlow=b<0||b>300,webSlow=c<0||c>1200;
            verdict.Text=a<0&&b<0&&c<0?L10n.Text("check_failed")
                :localSlow&&(nodeSlow||webSlow)?L10n.Text("check_local_slow")
                :nodeSlow?L10n.Text("check_node_slow",name)
                :webSlow?L10n.Text("check_web_slow")
                :localSlow?L10n.Text("check_local_slow"):L10n.Text("check_ok");
            other.Visibility=!localSlow&&(nodeSlow||webSlow)?Visibility.Visible:Visibility.Collapsed;
        }
        again.Click+=(_,_)=>RunCheck();
        window.Show();window.Activate();
        RunCheck();
    }

    // ---- Pages ----
    private void Render() {
        ContentPanel.Children.Clear();FullPanel.Children.Clear();NavigationPanel.Children.Clear();HeaderSlot.Content=null;
        rateBars=null;switchNote=null;switchText=null;onNodes=null;onMeasured=null;
        statusTitle=statusDetail=usageTotal=usageUntil=actionLabel=null;stamp=null;actionButton=secondaryButton=null;stepsHost=null;actionDot=null;scan=null;fileLines=null;portrait=null;location=null;checksCard=null;placeRow=usageCells=null;badgeKey="";bannerHost=null;updateRowValue=null;
        var view=!api.SignedIn?"login":page;
        var full=view=="connect";
        Scroller.Visibility=full?Visibility.Collapsed:Visibility.Visible;FullPanel.Visibility=full?Visibility.Visible:Visibility.Collapsed;
        if(view!=lastView) {Scroller.ScrollToTop();Enter(full?FullPanel:ContentPanel);}
        lastView=view;
        Language=System.Windows.Markup.XmlLanguage.GetLanguage(L10n.Culture.IetfLanguageTag);
        ShowActivity(api.SignedIn);
        if(!api.SignedIn) {
            // Before sign-in the only language entry is this small globe; afterwards it is a row on the account page.
            // Signed out: the saved list and measurements belonged to that account.
            if(nodesData is not null||NodeStore.LoadedAt!=DateTime.MinValue) {NodeStore.Clear();directory.Clear();}
            accountData=null;nodesData=null;
            var globe=new StackPanel {Orientation=Orientation.Horizontal};
            globe.Children.Add(Look.Icon("",13,Look.Secondary));globe.Children.Add(new TextBlock {Text=LanguageName(L10n.Preference=="system"?L10n.Culture.TwoLetterISOLanguageName:L10n.Preference),FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(6,0,0,0),VerticalAlignment=VerticalAlignment.Center});
            var button=new Button {Content=globe,Height=32,Padding=new Thickness(10,0,10,0)};
            AutomationProperties.SetName(button,L10n.Text("language")+": "+LanguageName(L10n.Preference));
            button.Click+=(_,_)=>ChooseLanguage(button);
            // Beside it, the look as two small swatches, so a new user sees the choice; afterwards it is the Appearance row.
            var header=new StackPanel {Orientation=Orientation.Horizontal};
            foreach(var (code,key,color) in new[]{("amber","theme_amber",Color.FromRgb(224,164,88)),("moon","theme_moon",Color.FromRgb(235,184,195))}) {
                var chosen=Look.Theme==code;var brush=new SolidColorBrush(color);
                var dot=new Grid {Width=20,Height=20};
                dot.Children.Add(new Ellipse {Width=12,Height=12,Fill=brush});
                if(chosen) dot.Children.Add(new Ellipse {Width=20,Height=20,Stroke=brush,StrokeThickness=1});
                var swatch=new Button {Content=dot,Width=30,Height=32,Padding=new Thickness(0)};
                AutomationProperties.SetName(swatch,L10n.Text("appearance")+": "+L10n.Text(key)+(chosen?L10n.Text("current_page"):""));
                swatch.Click+=(_,_)=>ApplyAppearance(code);
                header.Children.Add(swatch);
            }
            header.Children.Add(button);HeaderSlot.Content=header;
            Login();return;
        }
        if(Onboarded) foreach(var (id,key) in new[]{("connect","connect_tab"),("nodes","locations"),("account","account")}) {
            var selected=page==id||(page is "logs" or "devices" or "apps"&&id=="account")||(page=="usage"&&id=="connect");
            var label=new TextBlock {Text=L10n.Text(key),FontSize=14,FontWeight=selected?FontWeights.SemiBold:FontWeights.Normal,Foreground=selected?Look.Text:Look.Secondary,VerticalAlignment=VerticalAlignment.Center};
            var tab=new Grid {Height=44};tab.Children.Add(label);
            if(selected) tab.Children.Add(new Border {Height=3,Width=16,CornerRadius=new CornerRadius(1.5),Background=Look.Accent,VerticalAlignment=VerticalAlignment.Bottom,HorizontalAlignment=HorizontalAlignment.Center,Margin=new Thickness(0,0,0,6)});
            var button=new Button {Style=(Style)FindResource("Bare"),Content=tab,Margin=new Thickness(0,0,20,0),Padding=new Thickness(2,0,2,0)};
            AutomationProperties.SetName(button,L10n.Text(key)+(selected?L10n.Text("current_page"):""));
            button.Click+=(_,_)=>{if(!busy) {page=id;Render();}};NavigationPanel.Children.Add(button);
        }
        switch(view) {
            case "connect":Home();break;
            case "nodes":Nodes();break;
            case "devices":Devices();break;
            case "apps":AppsPage();break;
            case "logs":Logs();break;
            case "usage":UsagePage();break;
            default:Account();break;
        }
        UpdateLive();
    }
    /// Update and announcement notes: one compact card each, only when there is something to say.
    private FrameworkElement? Notices() {
        if(update is null&&announcement.Length==0) return null;
        var stack=new StackPanel();
        if(update is not null) {bannerHost=new ContentControl {Focusable=false};stack.Children.Add(bannerHost);ShowUpdate();}
        if(announcement.Length>0) stack.Children.Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(14,10,14,10),Child=Words(announcement,12,Look.Secondary),Margin=new Thickness(0,0,0,8)});
        return stack;
    }
    /// The connect page as a file: its state, four lines of what anyone can see about this PC right now, one action,
    /// then the location and usage. Connecting seals the file (a line of light sweeps down and each line turns into
    /// dots, the lamp above goes out); disconnecting sweeps back up and opens it.
    private void Home() {
        var layout=new Grid {Margin=new Thickness(16,4,16,16)};
        layout.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});layout.RowDefinitions.Add(new RowDefinition {Height=new GridLength(1,GridUnitType.Star)});layout.RowDefinitions.Add(new RowDefinition {Height=GridLength.Auto});
        var top=new StackPanel();
        if(Notices() is { } notes) top.Children.Add(notes);
        var (homeNote,homeText)=SwitchNote(13);homeNote.Margin=new Thickness(0,0,0,8);top.Children.Add(homeNote);
        switchNote=homeNote;switchText=homeText;
        layout.Children.Add(top);
        HeaderSlot.Content=null;

        // The state block has one height in every state, so nothing below it moves when a connection comes up or goes
        // down: what only exists while connected fades in and out of space that is always reserved.
        var center=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
        stepsHost=new ContentControl {Focusable=false,Content=SectionRow("section_portrait",Onboarded?null:Steps)};
        center.Children.Add(stepsHost);
        // The portrait is the switch (the action below says what a tap does); hidden, its ring draws the state and holds
        // the time and the rates (or the phase, the countdown).
        portrait=new Portrait {Height=236,Margin=new Thickness(0,6,0,0)};
        portrait.MouseLeftButtonUp+=(_,_)=>Toggle();
        portrait.KeyDown+=(_,e)=>{if(e.Key is System.Windows.Input.Key.Enter or System.Windows.Input.Key.Space) {e.Handled=true;Toggle();}};
        center.Children.Add(portrait);
        // No separate address and device lines any more: the state line below says which address sites can see.
        fileLines=new List<SealedText>();
        // The state (or the cause of a failure) and two lines held for its detail (or the next step): one height in
        // every state, so nothing below moves when a connection comes up, drops or fails.
        statusTitle=new TextBlock {FontSize=24,FontWeight=FontWeights.Light,TextWrapping=TextWrapping.NoWrap,TextTrimming=TextTrimming.CharacterEllipsis};
        statusDetail=new TextBlock {FontSize=13,Foreground=Look.Secondary,Height=38,Margin=new Thickness(0,2,0,0),TextWrapping=TextWrapping.Wrap,TextTrimming=TextTrimming.CharacterEllipsis};
        var stateBlock=new StackPanel {Margin=new Thickness(4,8,4,0)};
        stateBlock.Children.Add(statusTitle);stateBlock.Children.Add(statusDetail);
        center.Children.Add(stateBlock);
        Grid.SetRow(center,1);layout.Children.Add(center);

        // One filled action: solid amber while exposed, a quiet dark fill with a breathing dot while sealed.
        actionLabel=new TextBlock {FontSize=14,FontWeight=FontWeights.SemiBold,VerticalAlignment=VerticalAlignment.Center,TextWrapping=TextWrapping.NoWrap,TextTrimming=TextTrimming.CharacterEllipsis};
        actionDot=new Ellipse {Width=6,Height=6,Margin=new Thickness(0,0,10,0),VerticalAlignment=VerticalAlignment.Center};
        var actionRow=new StackPanel {Orientation=Orientation.Horizontal,HorizontalAlignment=HorizontalAlignment.Center};actionRow.Children.Add(actionDot);actionRow.Children.Add(actionLabel);
        actionButton=new Button {Height=48,Padding=new Thickness(16,0,16,0),BorderThickness=new Thickness(0),Content=actionRow};
        actionButton.Click+=(_,_)=>{if(CurrentTrouble() is { } trouble) Act(trouble.PrimaryDo);else Toggle();};
        // After a failure, the way out of it beside the action: "try again" or "change location".
        secondaryButton=new Button {Height=48,Padding=new Thickness(16,0,16,0),Margin=new Thickness(10,0,0,0),Background=Look.Surface,BorderThickness=new Thickness(0),Foreground=Look.Text,FontSize=14,FontWeight=FontWeights.Medium,HorizontalContentAlignment=HorizontalAlignment.Center,Visibility=Visibility.Collapsed};
        secondaryButton.Click+=(_,_)=>Act(CurrentTrouble()?.SecondaryDo);
        var actions=new Grid();
        actions.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});actions.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});
        actions.Children.Add(actionButton);Grid.SetColumn(secondaryButton,1);actions.Children.Add(secondaryButton);

        var badge=new ContentControl();
        var title=Single("",14,strong:true);var detail=Single("",12,Look.Secondary);detail.Margin=new Thickness(0,2,0,0);
        var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,8,0)};texts.Children.Add(title);texts.Children.Add(detail);
        var place=new Button {Height=58,Margin=new Thickness(0,10,0,0),Background=Look.Surface,BorderThickness=new Thickness(0),Content=Columns(badge,texts,Look.Icon("",11,Look.Secondary))};
        AutomationProperties.SetHelpText(place,L10n.Text("tap_to_change"));
        // Connected, the location row opens the connection check; otherwise the location list.
        place.Click+=(_,_)=>{if(busy) return;if(connection.Active&&connection.Since is not null&&connection.StatusKey!="location_retrying") ConnectionCheck();else {page="nodes";Render();}};
        location=(badge,title,detail);
        usageTotal=new TextBlock {Text="—",FontSize=14,FontWeight=FontWeights.SemiBold};usageUntil=new TextBlock {Text="—",FontSize=14,FontWeight=FontWeights.SemiBold};
        var cells=Cells(("last_30_days",usageTotal,12),("valid_until_label",usageUntil,12));
        // A click opens the usage page (per day, device, location and program).
        var usageChevron=Look.Icon("\uE76C",10,Look.Faint);usageChevron.VerticalAlignment=VerticalAlignment.Center;
        var usageButton=new Button {Margin=new Thickness(0,8,0,0),Padding=new Thickness(4,6,8,6),Content=Columns(new FrameworkElement(),cells,usageChevron)};
        AutomationProperties.SetName(usageButton,L10n.Text("usage_open"));
        usageButton.Click+=(_,_)=>{if(!busy) {page="usage";Render();}};
        checksCard=new Border {Background=Look.Surface,CornerRadius=new CornerRadius(14),Padding=new Thickness(14,8,14,8),Margin=new Thickness(0,10,0,0),Visibility=Visibility.Collapsed};
        placeRow=place;usageCells=usageButton;
        var bottom=new StackPanel();bottom.Children.Add(actions);bottom.Children.Add(checksCard);bottom.Children.Add(place);bottom.Children.Add(usageButton);
        Grid.SetRow(bottom,2);layout.Children.Add(bottom);
        FullPanel.Children.Add(layout);
        sealedShown=null;shownState=null;
        ShowUsage();
        _=RefreshAccount();
        if(visitorIp is null&&!connection.Active) _=LoadVisitor();
        if(nodesData is null) _=QuietNodes();
    }
    /// A page's § label, with the first-run step on the right: two squares (done, current, to come) and "n/2";
    /// Steps+1 is "Ready".
    private static FrameworkElement SectionRow(string key,int? step) {
        var label=Dossier.Section(key);
        if(step is not { } n) return label;
        var marks=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(8,0,4,0)};
        var text=((SolidColorBrush)Look.Text).Color;
        for(var i=1;i<=Steps;i++) marks.Children.Add(new Rectangle {Width=6,Height=6,Margin=new Thickness(0,0,3,0),VerticalAlignment=VerticalAlignment.Center,
            Fill=i<n?new SolidColorBrush(Color.FromArgb(191,text.R,text.G,text.B)):i==n?Look.Accent:Look.Selected});
        var words=n>Steps?L10n.Text("onboarding_ready"):n.ToString(L10n.Culture)+"/"+Steps.ToString(L10n.Culture);
        marks.Children.Add(new TextBlock {Text=words,FontFamily=new FontFamily("Cascadia Mono, Consolas"),FontSize=11,Foreground=n>Steps?Look.Accent:Look.Secondary,Margin=new Thickness(4,0,0,0),VerticalAlignment=VerticalAlignment.Center});
        AutomationProperties.SetName(marks,words);
        var row=new DockPanel {LastChildFill=true};
        DockPanel.SetDock(marks,Dock.Right);row.Children.Add(marks);row.Children.Add(label);
        return row;
    }
    /// The public address the service sees, read once while not connected (afterwards it would be the location's).
    private async Task LoadVisitor() {
        try {visitorIp=await api.VisitorAddress();} catch {return;}
        if(statusDetail is not null&&!connection.Active) statusDetail.Text=StatusDetail(State(),false);
    }
    private bool? dotBreathing;
    /// The action's dot breathes while a connection is on, only while the window is on screen (a hidden or minimised
    /// window would keep the animation clock ticking all day in the tray).
    private void BreatheDot() {
        if(actionDot is null) return;
        var on=connection.Active&&Motion&&OnScreen;
        if(dotBreathing==on) return;
        dotBreathing=on;
        actionDot.BeginAnimation(OpacityProperty,null);actionDot.Opacity=1;
        if(on) actionDot.BeginAnimation(OpacityProperty,new DoubleAnimation(1,0.35,TimeSpan.FromMilliseconds(1800)) {AutoReverse=true,RepeatBehavior=RepeatBehavior.Forever,EasingFunction=new SineEase {EasingMode=EasingMode.EaseInOut}});
    }
    private bool OnScreen=>IsVisible&&WindowState!=WindowState.Minimized;
    /// The window or the tray flyout is on screen.
    private bool Seen=>OnScreen||flyout?.IsVisible==true;
    /// The window went to the tray, was minimised or came back: pause or resume what moves on it, and once it has
    /// been away a moment give memory back (see Trim).
    private void OnScreenChanged() {
        if(portrait is not null) portrait.Resting=WindowState==WindowState.Minimized;
        BreatheDot();
        if(OnScreen) {trimTimer.Stop();UpdateLive();}
        else {trimTimer.Stop();trimTimer.Start();}
    }
    /// Seals or opens the connect page's file when the connection starts or ends; the first show on a page is still.
    private void ShowSeal(LinkState state) {
        var seal=connection.Active;
        Backdrop.Lit=!seal;
        var trouble=CurrentTrouble();
        var key=state+"|"+connection.ErrorCode;
        if(key!=shownState&&actionButton is not null&&actionLabel is not null&&actionDot is not null) {
            var on=seal&&state!=LinkState.Connecting;
            actionLabel.Text=trouble?.Primary??L10n.Text(state switch {LinkState.Idle=>"seal_action",LinkState.Connecting=>"cancel",_=>"unseal_action"});
            // Filled, no outline: solid amber with dark text while exposed, a quiet dark fill while hidden.
            actionButton.Foreground=on?Look.Text:Look.OnAccent;
            actionButton.Background=on?Look.Raised:Look.Accent;
            AutomationProperties.SetName(actionButton,trouble?.Primary??L10n.Text(state switch {LinkState.Idle=>"connect_action",LinkState.Connecting=>"cancel",_=>"disconnect_action"}));
            if(secondaryButton is not null) {
                secondaryButton.Content=trouble?.Secondary??"";
                secondaryButton.Visibility=trouble?.Secondary is null?Visibility.Collapsed:Visibility.Visible;
            }
            actionDot.Fill=Look.Accent;actionDot.Visibility=on?Visibility.Visible:Visibility.Collapsed;
            shownState=key;dotBreathing=null;BreatheDot();
            ShowChecks(state);
        }
        if(actionButton is not null) actionButton.IsEnabled=!busy||connection.Active;
        if(statusTitle is not null) statusTitle.Foreground=state switch {LinkState.Connected=>Look.Accent,LinkState.Failed=>Look.Fair,_=>Look.Text};
        if(portrait is not null) portrait.Invite="";
        if(sealedShown==seal||portrait is null||fileLines is null) return;
        var moving=sealedShown is not null&&Motion;
        portrait.Set(seal,moving);
        AutomationProperties.SetName(portrait,L10n.Text(seal?"disconnect_action":"connect_action"));
        var n=fileLines.Count;
        for(var i=0;i<n;i++) fileLines[i].Seal(seal,moving?(int)(1200*((seal?i:n-1-i)+0.5)/n):0,moving);
        sealedShown=seal;
    }
    /// A failure of the network shows where it stopped (network, server, lines, tunnel): a square (passed, failed, not
    /// reached), the step and what it found; once sent, the reference. The location row and the usage give it their place.
    private void ShowChecks(LinkState state) {
        if(checksCard is null) return;
        var checks=state==LinkState.Failed?Guidance.Checks(connection.ErrorCode,connection.Lines,connection.NetworkState):null;
        checksCard.Visibility=checks is null?Visibility.Collapsed:Visibility.Visible;
        if(placeRow is not null) placeRow.Visibility=checks is null?Visibility.Visible:Visibility.Collapsed;
        if(usageCells is not null) usageCells.Visibility=checks is null?Visibility.Visible:Visibility.Collapsed;
        if(checks is null) {sentCheck=null;return;}
        var rows=new StackPanel();
        foreach(var check in checks) {
            var square=new Rectangle {Width=7,Height=7,Margin=new Thickness(0,0,10,0),VerticalAlignment=VerticalAlignment.Center,
                Fill=check.Status switch {CheckStatus.Ok=>Look.Secondary,CheckStatus.Bad=>Look.Fair,_=>Look.Selected}};
            var label=new TextBlock {Text=check.Label,FontSize=13,Foreground=check.Status==CheckStatus.Skip?Look.Secondary:Look.Text,VerticalAlignment=VerticalAlignment.Center,TextTrimming=TextTrimming.CharacterEllipsis};
            var value=new TextBlock {Text=check.Value,FontSize=12,Foreground=check.Status==CheckStatus.Bad?Look.Fair:Look.Secondary,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(8,0,0,0),TextTrimming=TextTrimming.CharacterEllipsis};
            var row=new DockPanel {Height=28,LastChildFill=true};
            DockPanel.SetDock(square,Dock.Left);DockPanel.SetDock(value,Dock.Right);
            row.Children.Add(square);row.Children.Add(value);row.Children.Add(label);
            AutomationProperties.SetName(row,check.Label+": "+check.Value);
            rows.Children.Add(row);
        }
        if(sentCheck is not null) rows.Children.Add(new TextBlock {Text=L10n.Text("check_sent",sentCheck),FontSize=11,Foreground=Look.Secondary,Margin=new Thickness(0,4,0,0),TextTrimming=TextTrimming.CharacterEllipsis});
        checksCard.Child=rows;
    }
    private async Task SendCheck() {
        sentCheck=await connection.SendCheck(Guidance.Summary(connection.ErrorCode,connection.Lines,connection.NetworkState));
        ShowChecks(State());
    }
    /// In the background: at launch, when the window comes back after six hours, and with the refresh button. Nothing
    /// changes on screen if it fails.
    private async Task QuietNodes() {
        if(loadingNodes||!api.SignedIn) return;
        loadingNodes=true;
        try {var fresh=await LoadNodes();badgeKey="";UpdateLive();onNodes?.Invoke(fresh);if(flyPicking) FillFlyPicker();} catch {/* the saved list stays */}
        finally {loadingNodes=false;}
    }
    private string UsageText()=>accountData?["traffic"] is { } traffic?Bytes(Number(traffic["uploadBytes"])+Number(traffic["downloadBytes"])):"—";
    private void ShowUsage() {if(usageTotal is not null&&usageUntil is not null) ShowFigures(usageTotal,usageUntil);}
    /// Traffic left (or used in the last 30 days) and the end of the access period. Running out, the small title above
    /// a figure becomes the reminder and both turn amber; run out, red. The titles swap in place: nothing moves.
    /// Traffic quotas count all nodes together.
    private void ShowFigures(TextBlock traffic,TextBlock until) {
        var access=AccountAccess.From(accountData);
        var trafficTint=Tint(access.State=="exhausted",access.Low);var untilTint=Tint(access.State=="expired",access.Ending);
        if(traffic.Parent is StackPanel cell&&cell.Children[0] is TextBlock title) {title.Text=L10n.Text(access.TrafficTitle);title.Foreground=trafficTint??Look.Secondary;}
        if(until.Parent is StackPanel untilCell&&untilCell.Children[0] is TextBlock untilTitle) {untilTitle.Text=L10n.Text(access.UntilTitle);untilTitle.Foreground=untilTint??Look.Secondary;}
        traffic.Text=access.Quota is not null?Bytes(access.Remaining):UsageText();traffic.Foreground=trafficTint??Look.Text;
        until.Text=accountData is null?"—":L10n.Date(accountData["expiresAt"]?.GetValue<string>());
        until.Foreground=untilTint??Look.Text;
    }
    /// Run out: red; running out: amber; otherwise the usual colour (null).
    private static Brush? Tint(bool over,bool low)=>over?Look.Danger:low?Look.Fair:null;
    private LinkState State()=>connection.Active?Guidance.State(connection):connection.ErrorCode.Length>0?LinkState.Failed:LinkState.Idle;
    /// The cause of the last failure and the way out of it; null unless the connection failed.
    private Trouble? CurrentTrouble() {
        if(connection.Active||connection.ErrorCode is not { Length: >0 } code) return null;
        var node=connection.NodeName.Length>0?connection.NodeName:nodeName.Length>0?nodeName:L10n.Text("location");
        return Guidance.For(code,node,nodeId.Length==0,new AccessFailure(code).Message,connection.NetworkState);
    }
    private string StatusTitle(LinkState state)=>state switch {
        LinkState.Connected=>L10n.Text("sealed_status"),
        LinkState.Connecting or LinkState.Switching=>L10n.Text("hiding_status"),
        LinkState.Reconnecting=>L10n.Text("reconnecting_title"),
        LinkState.Waiting=>L10n.Text("waiting_title"),
        LinkState.Failed=>CurrentTrouble()?.Title??L10n.Text("connect_failed_title"),
        _=>L10n.Text("exposed_status"),
    };
    /// Time since the connection came up, or null while it is not (yet) confirmed.
    private string? Elapsed()=>!Connection.Notices.Contains(connection.StatusKey)&&connection.Since is { } since?(DateTime.UtcNow-since).ToString(@"hh\:mm\:ss"):null;
    /// The flyout's one line keeps time and rates together; the window shows the time large above the rates.
    private string StatusDetail(LinkState state,bool compact=true)=>state switch {
        LinkState.Connected=>compact&&Elapsed() is { } time?L10n.Text("connection_stats",time,Mbps(connection.RxRate),Mbps(connection.TxRate)):L10n.Text("seen_as",connection.NodeName)+(Guidance.Bypass(connection.Bypass) is { } forced?"\n"+forced:""),
        LinkState.Connecting=>L10n.Text("finding_best_route"),
        LinkState.Switching=>L10n.Text("switching_detail"),
        LinkState.Reconnecting=>L10n.Text(connection.StatusKey=="location_retrying"?"location_retrying":"reconnecting_detail"),
        LinkState.Waiting=>L10n.Text("waiting_detail"),
        LinkState.Failed=>CurrentTrouble()?.Detail??"",
        _=>update?.Mandatory==true?L10n.Text("update_required_detail"):connection.Blocking?L10n.Text("kill_switch_blocking")
            :visitorIp is { Length: >0 } ip&&ip!="—"?L10n.Text("exposed_ip",ip):L10n.Text("exposed_plain"),
    };
    /// The location the next (or current) connection uses, as title, detail and tile code (null: automatic).
    private (string Title,string Detail,string? Code) Location(bool checkable=true) {
        var active=connection.Active;var automatic=nodeId.Length==0;
        var id=active?connection.NodeId:nodeId;
        var quality=id.Length>0&&Latency.Recent.TryGetValue(id,out var known)?known:null;
        if(active&&id.Length>0) {
            var name=connection.NodeName.Length>0?connection.NodeName:directory.TryGetValue(id,out var entry)?entry.Name:L10n.Text("location");
            var detail=automatic?(Ms(quality) is { } ms?L10n.Text("connected_automatic_detail",ms):L10n.Text("automatic")):quality is not null?Summary(quality):L10n.Text("tap_to_change");
            if(checkable&&connection.Since is not null) detail+=" · "+L10n.Text("tap_to_check");
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
        // Shown in this order while the page is open: new measurements change the figures in place, never the order.
        var ranked=new List<(JsonNode Node,Quality? Quality)>();
        JsonArray nodes=new();
        var searchHost=Add(new ContentControl());
        Add(AutomaticRow(),12,0);
        Add(Caption(L10n.Text("all_locations")),20,8);
        ContentPanel.Children.Add(list);
        Quality? Known(JsonNode node)=>Latency.Recent.TryGetValue(node["id"]!.GetValue<string>(),out var known)?known:null;
        void Figures() {ranked=ranked.Select(x=>(x.Node,Known(x.Node))).ToList();}
        bool Unmeasured()=>nodes.Any(n=>n is not null&&Known(n) is null);
        // Coalesces the redraws while results arrive node by node.
        var redraw=false;
        void RedrawSoon() {
            if(redraw) return;redraw=true;
            Dispatcher.InvokeAsync(()=>{redraw=false;if(list.IsLoaded) {Figures();ShowNodes(list,ranked,query);}},DispatcherPriority.Render);
        }
        async void Measure(bool all) {
            if(measuring||connection.Active||nodes.Count==0) return;
            measuring=true;BusyBar.Visibility=Visibility.Visible;
            if(HeaderSlot.Content is Button refreshing) refreshing.IsEnabled=false;
            ShowNodes(list,ranked,query);
            var input=nodes;
            try {
                // Each result replaces that node's figures as it arrives; the earlier figures stay until then. The page
                // shown at the time redraws (the person may have left and come back meanwhile).
                var result=await Latency.Rank(input,reuse:all?null:TimeSpan.MaxValue,each:(_,_)=>Dispatcher.InvokeAsync(()=>onMeasured?.Invoke(false)));
                NodeStore.SaveMeasured(nodesData);
                _=Latency.Report(api,result);
            } catch {/* keep the last results */}
            measuring=false;if(!busy) BusyBar.Visibility=Visibility.Hidden;
            onMeasured?.Invoke(true);
        }
        onMeasured=done=>{
            if(!list.IsLoaded&&!done) return;
            if(done&&HeaderSlot.Content is Button again) again.IsEnabled=!connection.Active;
            if(done) {Figures();ShowNodes(list,ranked,query);if(Unmeasured()) Measure(false);} else RedrawSoon();
        };
        // A newer list: rows that stay keep their place and figures, new ones go to the end, removed ones leave.
        void Apply(JsonArray fresh,bool first) {
            nodes=fresh;
            var byId=fresh.Where(n=>n is not null).Select(n=>n!).GroupBy(n=>n["id"]!.GetValue<string>()).ToDictionary(g=>g.Key,g=>g.First());
            if(first) ranked=byId.Values.Select(n=>(n,Known(n))).OrderBy(x=>x.Item2?.Score??long.MaxValue).ToList();
            else {
                var kept=ranked.Select(x=>byId.GetValueOrDefault(x.Node["id"]!.GetValue<string>())).Where(n=>n is not null).Select(n=>n!).ToList();
                var known=kept.Select(n=>n["id"]!.GetValue<string>()).ToHashSet();
                ranked=kept.Concat(byId.Values.Where(n=>!known.Contains(n["id"]!.GetValue<string>()))).Select(n=>(n,Known(n))).ToList();
            }
            if(nodes.Count>6&&searchHost.Content is null) searchHost.Content=Search(text=>{query=text;ShowNodes(list,ranked,query);});
            ShowNodes(list,ranked,query);
            // Measuring is by hand (the refresh button); only nodes this PC never measured are measured on their own.
            // Results are kept across launches, and automatic mode measures again when it connects.
            if(Unmeasured()) Measure(false);
        }
        if(HeaderSlot.Content is Button refresh) {refresh.IsEnabled=!connection.Active;refresh.Click+=(_,_)=>{if(measuring) return;_=QuietNodes();Measure(true);};}
        onNodes=fresh=>{if(list.IsLoaded||ranked.Count==0) Apply(fresh,ranked.Count==0);};
        if(nodesData is { } cached) Apply(cached,true);
        // First time on this PC: nothing to show yet, so this one load shows progress and errors.
        else Work(async()=>Apply(await LoadNodes(),true));
    }
    private FrameworkElement Search(Action<string> changed,string hintKey="search_locations_or_regions") {
        var box=new TextBox {Padding=new Thickness(30,0,10,0)};
        AutomationProperties.SetName(box,L10n.Text(hintKey));
        var hint=new TextBlock {Text=L10n.Text(hintKey),FontSize=14,Foreground=Look.Faint,Margin=new Thickness(31,0,10,0),VerticalAlignment=VerticalAlignment.Center,IsHitTestVisible=false,TextWrapping=TextWrapping.NoWrap};
        var glass=Look.Icon("",13,Look.Secondary);glass.HorizontalAlignment=HorizontalAlignment.Left;glass.Margin=new Thickness(10,0,0,0);glass.IsHitTestVisible=false;
        box.TextChanged+=(_,_)=>{hint.Visibility=box.Text.Length==0?Visibility.Visible:Visibility.Collapsed;changed(box.Text);};
        var grid=new Grid {Margin=new Thickness(0,14,0,0)};grid.Children.Add(box);grid.Children.Add(hint);grid.Children.Add(glass);
        return grid;
    }
    private Button AutomaticRow() {
        var selected=nodeId.Length==0;
        // Selected = a lifted row and a amber tile; no outline or check, so nothing moves.
        var badge=Look.Badge(null);
        if(selected) {badge.Background=Look.Accent;if(badge.Child is TextBlock glyph) glyph.Foreground=Look.OnAccent;if(badge.Child is TextBlock star) star.Foreground=Look.OnAccent;}
        var row=new Button {Height=56,Background=selected?Look.Selected:Look.Surface,BorderThickness=new Thickness(0),
            Content=Columns(badge,TwoLines(L10n.Text("automatic"),L10n.Text("select_an_available_location_for_you"),strong:true))};
        AutomationProperties.SetName(row,L10n.Text("automatic")+(selected?L10n.Text("current_page"):""));
        row.Click+=(_,_)=>Select("","");
        return row;
    }
    // ---- Lines (Line 1…4) ----
    private enum LineState {Ok,Slow,Down,Off,Wait}
    /// The node whose per-line detail is open in the list ("" = none).
    private string openNode="";
    private static string LineName(int index)=>L10n.Text("line_n",(index+1).ToString(L10n.Culture));
    private static string ListJoin=>L10n.Culture.TwoLetterISOLanguageName=="zh"?"、":", ";
    /// Each line's cell in the order Line 1…4; null when this PC has no line results for the node.
    private static List<LineState>? LineStates(IReadOnlyDictionary<string,long>? lines)=>lines is not { Count: >0 }?null
        :Latency.LineOrder.Select(name=>lines.TryGetValue(name,out var ms)?ms<0?LineState.Down:ms>300?LineState.Slow:LineState.Ok:LineState.Off).ToList();
    /// One sentence when a line is out ("Line 2 has no answer, using Line 1"); null when every offered line works.
    private static string? LinesNote(IReadOnlyDictionary<string,long>? lines) {
        if(lines is not { Count: >0 }) return null;
        var offered=Latency.LineOrder.Select((name,i)=>(Name:name,Index:i)).Where(x=>lines.ContainsKey(x.Name)).ToList();
        var working=offered.Where(x=>lines[x.Name]>=0).ToList();var down=offered.Where(x=>lines[x.Name]<0).ToList();
        if(working.Count==0) return L10n.Text("lines_none");
        if(down.Count==0) return null;
        if(working.Count==1&&offered.Count>2) return L10n.Text("lines_only",LineName(working[0].Index));
        return L10n.Text("lines_one_down",string.Join(ListJoin,down.Select(x=>LineName(x.Index))),LineName(working.MinBy(x=>lines[x.Name]).Index));
    }
    private static string LineValue(IReadOnlyDictionary<string,long> lines,string name)=>!lines.TryGetValue(name,out var ms)?L10n.Text("line_off")
        :ms<0?L10n.Text("line_down"):L10n.Text("latency_ms",ms.ToString("N0",L10n.Culture));
    private static readonly Brush WaitCell=Look.Hex("#2D2A25"),OffCell=Look.Hex("#443F39");
    private static StackPanel LineCells(IEnumerable<LineState> states,double size=6) {
        var panel=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center};
        foreach(var state in states) panel.Children.Add(new Rectangle {Width=size,Height=size,Margin=new Thickness(panel.Children.Count>0?3:0,0,0,0),
            Fill=state switch {LineState.Ok=>Look.Accent,LineState.Slow=>Look.Fair,LineState.Wait=>WaitCell,_=>Brushes.Transparent},
            Stroke=state switch {LineState.Down=>Look.Danger,LineState.Off=>OffCell,_=>null},StrokeThickness=1});
        return panel;
    }
    private void ShowNodes(StackPanel list,List<(JsonNode Node,Quality? Quality)> ranked,string query) {
        list.Children.Clear();
        var rows=new List<FrameworkElement>();
        var details=new Dictionary<string,(Border Detail,Border Item)>();
        foreach(var (node,quality) in ranked) {
            var name=node["name"]!.GetValue<string>();var id=node["id"]!.GetValue<string>();var region=node["region"]?.GetValue<string>()??"";
            if(!(name+" "+region).Contains(query,StringComparison.OrdinalIgnoreCase)) continue;
            var unreachable=quality is {Latency: null};
            var selected=id==nodeId;
            var states=LineStates(quality?.Lines);var note=LinesNote(quality?.Lines);
            var offered=node["test"] is JsonArray tests&&tests.Any(t=>t?["name"]?.GetValue<string>() is { } n&&Latency.LineOrder.Contains(n));
            // Fixed columns on every row: tile, name, delay (fixed width, right-aligned), cell slot (always 44 wide).
            // Selected = a lifted row, a amber tile and a bolder name; nothing is added, so the columns never move.
            var latency=quality is null?(measuring?"…":""):Ms(quality) ?? L10n.Text("quality_unreachable");
            var digits=new TextBlock {Text=latency,FontSize=12,Foreground=unreachable?Look.Danger:Look.Secondary,TextAlignment=TextAlignment.Right,VerticalAlignment=VerticalAlignment.Center};
            if(!unreachable) Typography.SetNumeralAlignment(digits,FontNumeralAlignment.Tabular);
            var right=new Border {Width=72,VerticalAlignment=VerticalAlignment.Center,
                Child=new Viewbox {Stretch=Stretch.Uniform,StretchDirection=StretchDirection.DownOnly,HorizontalAlignment=HorizontalAlignment.Right,Child=digits}};
            var label=note is null?Single(name+(region.Length>0&&region!=name?" · "+region:""),14,unreachable&&!selected?Look.Faint:Look.Text,strong:selected):(FrameworkElement)TwoLines(name,note,strong:selected);
            if(label is TextBlock single) single.Margin=new Thickness(12,0,8,0);
            if(unreachable&&!selected&&label is StackPanel two&&two.Children[0] is TextBlock title) title.Foreground=Look.Faint;
            var badge=Look.Badge(Code(id,name),28,selected?Look.OnAccent:unreachable?Look.Faint:null);
            if(selected) {badge.Background=Look.Accent;if(badge.Child is TextBlock glyph) glyph.Foreground=Look.OnAccent;}
            var row=new Button {Height=note is null?48:52,Content=Columns(badge,label,right)};
            var item=new Border {Background=selected?Look.Raised:Brushes.Transparent,Tag=selected};
            var stack=new StackPanel();item.Child=stack;
            var head=new Grid();head.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});head.ColumnDefinitions.Add(new ColumnDefinition {Width=GridLength.Auto});
            head.Children.Add(row);stack.Children.Add(head);
            // The cell slot is always there: the four line cells (tap to open each line's result), signal bars for a PC
            // without line results, or empty. Earlier results stay drawn while a node is measured again.
            if(states is null) {
                FrameworkElement slot=measuring&&quality is null&&offered?LineCells(Enumerable.Repeat(LineState.Wait,Latency.LineOrder.Length))
                    :quality is {Latency: not null}?Look.Signal(Signal(quality).Item1,Signal(quality).Item2):new Border();
                slot.HorizontalAlignment=HorizontalAlignment.Center;slot.VerticalAlignment=VerticalAlignment.Center;
                var holder=new Border {Width=44,Height=44,Margin=new Thickness(0,0,6,0),Child=slot};
                Grid.SetColumn(holder,1);head.Children.Add(holder);
            } else if(states is not null&&quality?.Lines is { } lines) {
                // Quieter than the row: no outlines, small grey text, indented to the name.
                var grid=new UniformGrid {Columns=2,Margin=new Thickness(54,0,16,8)};
                for(var i=0;i<Latency.LineOrder.Length;i++) {
                    var name_=Latency.LineOrder[i];var has=lines.TryGetValue(name_,out var lineMs);
                    var value=Single(LineValue(lines,name_),11,!has?Look.Faint:lineMs<0?Look.Hex("#BFF0675A"):Look.Secondary);value.FontFamily=new FontFamily("Cascadia Mono, Consolas");
                    var cell=LineCells(new[]{states[i]},4);cell.Margin=new Thickness(0,0,7,0);
                    var line=Columns(cell,Single(LineName(i),12,Look.Faint),value);line.Height=24;line.Margin=new Thickness(0,0,i%2==0?20:0,0);
                    AutomationProperties.SetName(line,LineName(i)+", "+LineValue(lines,name_));
                    grid.Children.Add(line);
                }
                var open=openNode==id;
                var detail=new Border {Child=grid,ClipToBounds=true,MaxHeight=open?double.PositiveInfinity:0,Opacity=open?1:0};
                stack.Children.Add(detail);
                if(open&&!selected) item.Background=OpenRow;
                details[id]=(detail,item);
                var toggle=new Button {Style=(Style)FindResource("Bare"),Width=44,Height=44,Margin=new Thickness(0,0,6,0),Content=LineCells(states),VerticalAlignment=VerticalAlignment.Center};
                AutomationProperties.SetName(toggle,L10n.Text("lines_detail",name,states.Count(x=>x!=LineState.Off).ToString(L10n.Culture),states.Count(x=>x is LineState.Ok or LineState.Slow).ToString(L10n.Culture)));
                toggle.Click+=(_,_)=>{
                    var opening=openNode!=id;
                    if(openNode.Length>0&&openNode!=id&&details.TryGetValue(openNode,out var previous)) Expand(previous.Detail,previous.Item,false);
                    openNode=opening?id:"";
                    Expand(detail,item,opening);
                };
                Grid.SetColumn(toggle,1);head.Children.Add(toggle);
            }
            rows.Add(item);
        }
        if(rows.Count>0) list.Children.Add(Card(rows));
        else list.Children.Add(Caption(L10n.Text(ranked.Count==0?"no_locations_available_refresh_later_or_contact_your_administrator":"no_matching_locations_try_another_search")));
    }
    private static readonly Brush OpenRow=Look.Hex("#100E0D");
    /// Opens or closes a node's line detail by animating its height, so the rows below slide instead of jumping.
    private static void Expand(Border detail,Border item,bool open) {
        detail.Child.Measure(new System.Windows.Size(detail.ActualWidth>0?detail.ActualWidth:double.PositiveInfinity,double.PositiveInfinity));
        var full=detail.Child.DesiredSize.Height;
        var from=double.IsInfinity(detail.MaxHeight)?full:detail.MaxHeight;
        var duration=new Duration(TimeSpan.FromMilliseconds(260));
        var height=new DoubleAnimation(from,open?full:0,duration) {EasingFunction=new CubicEase {EasingMode=EasingMode.EaseOut}};
        if(open) height.Completed+=(_,_)=>{detail.BeginAnimation(FrameworkElement.MaxHeightProperty,null);detail.MaxHeight=double.PositiveInfinity;};
        else height.Completed+=(_,_)=>{detail.BeginAnimation(FrameworkElement.MaxHeightProperty,null);detail.MaxHeight=0;};
        detail.BeginAnimation(FrameworkElement.MaxHeightProperty,height);
        detail.BeginAnimation(UIElement.OpacityProperty,new DoubleAnimation(open?1:0,duration));
        item.Background=item.Tag is true?Look.Raised:open?OpenRow:Brushes.Transparent;
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
        Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(1,3,1,3),Child=choice},4,6);
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
        var avatar=new Border {Width=40,Height=40,CornerRadius=new CornerRadius(3),Background=Look.Raised,VerticalAlignment=VerticalAlignment.Center,
            Child=new TextBlock {Text=name.Length>0?name[..1].ToUpperInvariant():"",FontSize=16,FontWeight=FontWeights.SemiBold,Foreground=Look.Accent,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center}};
        // The address is sealed on screen; pressing and holding opens it for as long as the button stays down.
        var sealedEmail=new SealedText(14) {Value=email,Cursor=Cursors.Hand,Background=Brushes.Transparent};sealedEmail.Seal(true,animate:false);
        AutomationProperties.SetName(sealedEmail,email);
        sealedEmail.MouseLeftButtonDown+=(_,_)=>{sealedEmail.CaptureMouse();sealedEmail.Seal(false);};
        sealedEmail.MouseLeftButtonUp+=(_,_)=>{sealedEmail.ReleaseMouseCapture();sealedEmail.Seal(true);};
        sealedEmail.LostMouseCapture+=(_,_)=>{if(!sealedEmail.Sealed) sealedEmail.Seal(true);};
        var who=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,0,0)};
        who.Children.Add(sealedEmail);
        var hint=Dossier.Section("hold_to_reveal");hint.FontSize=10;hint.Margin=new Thickness(0,2,0,0);who.Children.Add(hint);
        who.Children.Add(Single(L10n.Text("account_valid_until",L10n.Date(account["expiresAt"]?.GetValue<string>())),12,Look.Secondary));
        var identity=Columns(avatar,who);
        identity.Margin=new Thickness(4,0,4,0);Add(identity,4,16);

        var devices=SettingRow(L10n.Text("authorized_devices"),$"{Number(account["used"]).ToString("N0",L10n.Culture)} / {DeviceLimit(account)}",_=>{page="devices";Render();});
        var password=SettingRow(L10n.Text("change_password"),"",_=>ResetPassword(email,L10n.Text("reset_change_detail",email),L10n.Text("reset_link_sent_to",email)));
        var language=SettingRow(L10n.Text("language"),LanguageName(L10n.Preference),ChooseLanguage);
        var appearance=SettingRow(L10n.Text("appearance"),L10n.Text(Look.Theme=="moon"?"theme_moon":"theme_amber"),ChooseAppearance);
        var startup=new ToggleButton {Style=(Style)FindResource("Switch"),IsChecked=LoginTask.Enabled,VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(startup,L10n.Text("open_at_login"));
        startup.Click+=(_,_)=>{var on=startup.IsChecked==true;if(!LoginTask.Set(on)) {startup.IsChecked=!on;Notify(L10n.Text("unable_to_reach_the_service_check_your_network_and"));}};
        var startupRow=new Border {Height=44,Padding=new Thickness(14,0,14,0),Child=Columns(new FrameworkElement(),Single(L10n.Text("open_at_login"),14),startup)};
        // Kill switch: Windows Filtering Platform rules held by the core, applied with the next tunnel.
        var guard=new ToggleButton {Style=(Style)FindResource("Switch"),IsChecked=Connection.KillSwitchOn,VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(guard,L10n.Text("kill_switch"));
        guard.Click+=(_,_)=>{
            var on=guard.IsChecked==true;Settings.Set("killSwitch",on?"on":"off");
            Work(async()=>{if(connection.Active) await Task.Run(()=>core.KillSwitch(on));else await connection.KillSwitchChanged();});
        };
        var guardRow=new Border {Height=44,Padding=new Thickness(14,0,14,0),Child=Columns(new FrameworkElement(),Single(L10n.Text("kill_switch"),14),guard)};
        var updates=SettingRow(L10n.Text("check_for_updates"),L10n.Text("up_to_date"),_=>{
            if(update is { } found) StartDownload(found);
            else CheckForUpdate(true);
        });
        updateRowValue=((updates.Content as Grid)!.Children[2] as StackPanel)!.Children[0] as TextBlock;ShowUpdate();
        // This build's improvements, from clients/CHANGELOG.md (generated into the string resources).
        var appVersion=System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3)??"0";
        var whatsNew=SettingRow(L10n.Text("whats_new"),appVersion,_=>ShowNotes(appVersion,L10n.Text("whats_new_notes").Split('\n').Where(line=>line.Trim().Length>0).ToList()));
        var apps=SettingRow(L10n.Text("per_app_routing"),AppsValue(),_=>{page="apps";Render();});
        Add(Card(new FrameworkElement[]{devices,password,language,appearance,startupRow,guardRow,apps,updates,whatsNew},14));

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
        AutomationProperties.SetName(row,value.Length==0?title:title+": "+value);
        row.Click+=(_,_)=>onClick(row);
        return row;
    }
    // ---- Usage: the quota and end date, traffic per day over 7, 30 or 90 days (the server's UTC days), per device and
    // per location, and per program over the last 7 days (kept on this computer only). Opened from the home page.
    private void UsagePage() {
        Add(SubHeader(L10n.Text("usage_title"),"connect"),0,8);
        var quota=Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(16)});
        void FillQuota() {
            if(accountData is not { } account) {quota.Opacity=0;return;}
            quota.Opacity=1;
            var access=AccountAccess.From(account);
            var used=access.Quota is { } q?Math.Max(0,q-access.Remaining):Number(account["traffic"]?["uploadBytes"])+Number(account["traffic"]?["downloadBytes"]);
            var exhausted=access.State=="exhausted";var ended=access.State=="expired";
            var stack=new StackPanel();
            stack.Children.Add(Single(L10n.Text(access.Quota is null?"last_30_days":"usage_used_period"),12,Look.Secondary));
            var figure=new TextBlock {Margin=new Thickness(0,6,0,0),Foreground=exhausted?Look.Danger:Look.Text,VerticalAlignment=VerticalAlignment.Bottom};
            var parts=Bytes(used).Split(' ',2);
            figure.Inlines.Add(new Run(parts[0]) {FontFamily=Look.Dots,FontSize=34});
            if(parts.Length>1) figure.Inlines.Add(new Run(" "+parts[1]) {FontSize=14,FontWeight=FontWeights.SemiBold,Foreground=Look.Secondary});
            var of=Single(access.Quota is { } total?L10n.Text("usage_of",Bytes(total)):L10n.Text("usage_unlimited"),13,Look.Secondary);
            of.VerticalAlignment=VerticalAlignment.Bottom;of.Margin=new Thickness(8,0,0,6);
            stack.Children.Add(Columns(new FrameworkElement(),figure,of));
            if(access.Quota is { } limit) {
                var tint=exhausted?Look.Danger:access.Low?Look.Fair:Look.Accent;
                stack.Children.Add(ShareBar((double)used/Math.Max(limit,1),tint,8,new Thickness(0,12,0,0)));
                var left=Single(L10n.Text("usage_left",Bytes(access.Remaining)),12,exhausted||access.Low?tint:Look.Secondary);
                left.Margin=new Thickness(0,8,0,0);stack.Children.Add(left);
            }
            stack.Children.Add(new Border {Height=1,Background=Look.Hairline,Margin=new Thickness(0,14,0,12)});
            var untilText=ended?L10n.Text("access_expired_title"):access.Until is null?L10n.Text("no_expiry"):L10n.Text("valid_until_label")+" "+L10n.Date(access.UntilText);
            var untilLine=new TextBlock {Text=untilText,FontSize=13,Foreground=ended?Look.Danger:access.Ending?Look.Fair:Look.Secondary,TextWrapping=TextWrapping.Wrap,VerticalAlignment=VerticalAlignment.Center};
            FrameworkElement daysLeft=new FrameworkElement();
            if(access.Until is { } until&&!ended) {
                var days=Math.Max(0,(long)Math.Ceiling((until-DateTimeOffset.UtcNow).TotalDays));
                var label=Single(L10n.Text("usage_days_left",days.ToString("N0",L10n.Culture)),13,access.Ending?Look.Fair:Look.Text,strong:true);
                label.Margin=new Thickness(12,0,0,0);daysLeft=label;
            }
            stack.Children.Add(Columns(new FrameworkElement(),untilLine,daysLeft));
            quota.Child=stack;
        }
        FillQuota();
        // The range: 7, 30 or 90 days; changing it reloads the figures below in place.
        var ranges=new UniformGrid {Rows=1};
        Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(2),Child=ranges},12,0);
        var chart=Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(16),MinHeight=140},12,0);
        var lists=Add(new StackPanel(),12,0);
        var asked=0;
        async Task Load() {
            var ask=++asked;var days=usageDays;
            ranges.Children.Clear();
            foreach(var (value,key) in new[]{(7,"usage_7_days"),(30,"usage_30_days"),(90,"usage_90_days")}) {
                var on=value==usageDays;
                var choice=new Button {Content=L10n.Text(key),FontSize=12,Height=28,Padding=new Thickness(6,0,6,0),HorizontalContentAlignment=HorizontalAlignment.Center,
                    Background=on?Look.Selected:Brushes.Transparent,Foreground=on?Look.Text:Look.Secondary,FontWeight=on?FontWeights.SemiBold:FontWeights.Normal};
                AutomationProperties.SetName(choice,L10n.Text(key)+(on?L10n.Text("current_page"):""));
                choice.Click+=(_,_)=>{if(value!=usageDays) {usageDays=value;_=Load();}};
                ranges.Children.Add(choice);
            }
            chart.Opacity=0.5;lists.Opacity=0.5;
            JsonNode? data=null;var apps="[]";
            try {data=await api.Request("usage?days="+days);} catch {/* shown below */}
            try {apps=await Task.Run(()=>core.AppUsage(7));} catch {/* no programs */}
            if(ask!=asked||page!="usage") return;
            chart.Opacity=1;lists.Opacity=1;lists.Children.Clear();
            if(data is null) {lists.Children.Add(Caption(L10n.Text("usage_load_failed")));return;}
            JsonNode found=data;
            var perDay=new Dictionary<string,long>();
            foreach(var day in found["daily"]?.AsArray()??new JsonArray()) if(day?["day"]?.GetValue<string>() is { } dayKey) perDay[dayKey]=Number(day["upload"])+Number(day["download"]);
            var today=DateTime.UtcNow.Date;
            var series=Enumerable.Range(0,days).Reverse().Select(offset=>{
                var dayKey=today.AddDays(-offset).ToString("yyyy-MM-dd",System.Globalization.CultureInfo.InvariantCulture);
                return (Key:dayKey,Bytes:perDay.TryGetValue(dayKey,out var b)?b:0L);
            }).ToList();
            var sum=series.Sum(d=>d.Bytes);
            var stack=new StackPanel();
            var dayLabel=Single("",12,Look.Secondary);
            void Show(int index)=>dayLabel.Text=ShortDay(series[index].Key)+" · "+Bytes(series[index].Bytes);
            Show(series.Count-1);
            var totalLabel=Single(Bytes(sum),12,Look.Secondary);totalLabel.Margin=new Thickness(8,0,0,0);
            stack.Children.Add(Columns(new FrameworkElement(),dayLabel,totalLabel));
            var bars=new DayBars(series.Select(d=>d.Bytes).ToList(),series.Count-1) {Height=72,Margin=new Thickness(0,12,0,0)};
            bars.Picked+=Show;
            AutomationProperties.SetName(bars,L10n.Text(days==7?"usage_7_days":days==90?"usage_90_days":"usage_30_days")+" · "+Bytes(sum));
            stack.Children.Add(bars);
            var axis=Columns(new FrameworkElement(),Single(ShortDay(series[0].Key),11,Look.Faint),Single(ShortDay(series[^1].Key),11,Look.Faint));
            axis.Margin=new Thickness(0,8,0,0);stack.Children.Add(axis);
            chart.Child=stack;
            List<(string Name,long Bytes,bool Proxy)> Rows(string key,Func<JsonNode,string> name)=>
                (found[key]?.AsArray()??new JsonArray()).Where(n=>n is not null).Select(n=>(name(n!),Number(n!["bytes"]),true)).ToList();
            lists.Children.Add(RankCard(L10n.Text("usage_by_device"),Rows("devices",d=>{
                var given=d["name"]?.GetValue<string>() is { Length: >0 } text?text:L10n.Text("device");
                return d["isCurrent"]?.GetValue<bool>()==true?L10n.Text("usage_this_device",given):given;
            })));
            lists.Children.Add(RankCard(L10n.Text("usage_by_location"),Rows("nodes",n=>n["name"]?.GetValue<string>()??""),new Thickness(0,12,0,0)));
            // Programs: only this computer's, over the last 7 days, whatever the range above.
            var programs=new List<(string Name,long Bytes,bool Proxy)>();
            try {
                foreach(var row in JsonNode.Parse(apps)?.AsArray()??new JsonArray())
                    if(row is not null) programs.Add((row["name"]?.GetValue<string>()??"",Number(row["bytes"]),row["proxy"]?.GetValue<bool>()!=false));
            } catch {/* none */}
            if(programs.Count>0) {
                lists.Children.Add(RankCard(L10n.Text("usage_by_app")+" · "+L10n.Text("usage_7_days"),programs,new Thickness(0,12,0,0)));
                var note=Caption(L10n.Text("usage_apps_local"));note.Margin=new Thickness(4,8,4,0);lists.Children.Add(note);
            }
        }
        _=Load();
        // The account (quota, end date) may be newer than the home page's copy.
        _=RefreshUsageQuota(FillQuota);
    }
    private async Task RefreshUsageQuota(Action fill) {
        try {var fresh=await api.Request("account");accountData=fresh;if(page=="usage") fill();} catch {/* keep the copy */}
    }
    /// "Nov 22": a chart day in the app's language.
    private static string ShortDay(string key)=>DateTime.TryParseExact(key,"yyyy-MM-dd",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out var day)
        ?day.ToString(L10n.Culture.DateTimeFormat.MonthDayPattern,L10n.Culture):key;
    /// A share of a whole as a filled bar on a dim track, both rounded.
    private static Border ShareBar(double share,Brush tint,double height,Thickness margin) {
        var fill=Math.Clamp(share,0.01,1);
        var grid=new Grid {Height=height};
        grid.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(fill,GridUnitType.Star)});
        grid.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(Math.Max(0,1-fill),GridUnitType.Star)});
        grid.Children.Add(new Border {Background=tint,CornerRadius=new CornerRadius(height/2)});
        return new Border {Background=Look.Raised,CornerRadius=new CornerRadius(height/2),Child=grid,Margin=margin};
    }
    /// A titled card of names with a share bar and their bytes, largest first; dim bars for traffic that went direct.
    private static Border RankCard(string title,List<(string Name,long Bytes,bool Proxy)> rows,Thickness? margin=null) {
        var stack=new StackPanel();
        stack.Children.Add(Single(title,12,Look.Secondary,strong:true));
        var top=Math.Max(rows.Count>0?rows[0].Bytes:1,1);
        if(rows.Count==0) {var none=Single(L10n.Text("activity_nothing"),12,Look.Secondary);none.Margin=new Thickness(0,8,0,0);stack.Children.Add(none);}
        foreach(var (name,bytes,proxy) in rows) {
            var left=new StackPanel {VerticalAlignment=VerticalAlignment.Center};
            left.Children.Add(Single(name,13));
            left.Children.Add(ShareBar((double)bytes/top,proxy?Look.Accent:Look.Past,4,new Thickness(0,6,0,0)));
            var figure=Single(Bytes(bytes),12);figure.FontFamily=new FontFamily("Consolas");figure.Width=78;figure.TextAlignment=TextAlignment.Right;figure.Margin=new Thickness(12,0,0,0);
            var row=Columns(new FrameworkElement(),left,figure);row.Margin=new Thickness(0,10,0,0);
            stack.Children.Add(row);
        }
        return new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(16,14,16,14),Child=stack,Margin=margin??new Thickness(0)};
    }
    private FrameworkElement SubHeader(string title,string backTo="account") {
        var back=IconButton("",L10n.Text("back_action"),()=>{page=backTo;Render();});back.HorizontalAlignment=HorizontalAlignment.Left;
        var grid=new Grid {Height=40};
        grid.Children.Add(new TextBlock {Text=title,FontSize=14,FontWeight=FontWeights.SemiBold,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center});
        grid.Children.Add(back);
        return grid;
    }
    // ---- Per-app routing (AppRouting): three modes and, for the two that name programs, the programs to pick from.
    private static string AppsValue() {
        var (mode,apps)=AppRouting.Effective;
        return mode==AppRouting.All?L10n.Text("apps_all_value"):L10n.Text(mode==AppRouting.Only?"apps_only_value":"apps_except_value",apps.Count.ToString("N0",L10n.Culture));
    }
    /// Programs picked with "Add a program…" this run, so they stay listed while not running.
    private readonly Dictionary<string,AppRouting.Entry> addedPrograms=new(StringComparer.OrdinalIgnoreCase);
    private static FrameworkElement Radio(bool on) {
        var grid=new Grid {Width=16,Height=16,VerticalAlignment=VerticalAlignment.Top,Margin=new Thickness(0,2,0,0)};
        grid.Children.Add(new Ellipse {Fill=on?Look.Accent:Look.Selected});
        if(on) grid.Children.Add(new Ellipse {Width=6,Height=6,Fill=Look.OnAccent});
        return grid;
    }
    private static void Tick(Border box,bool on) {
        box.BorderThickness=new Thickness(0);box.Background=on?Look.Accent:Look.Selected;
        box.Child=on?Look.Icon("\uE73E",11,Look.OnAccent):null;
    }
    private void AppsPage() {
        Add(SubHeader(L10n.Text("per_app_routing")),0,8);
        var mode=AppRouting.Mode;
        var rows=new List<FrameworkElement>();
        foreach(var (value,title,detail) in new[]{(AppRouting.All,"apps_mode_all","apps_mode_all_detail"),(AppRouting.Only,"apps_mode_only","apps_mode_only_detail"),(AppRouting.Except,"apps_mode_except","apps_mode_except_detail")}) {
            var on=value==mode;
            var texts=new StackPanel {Margin=new Thickness(12,0,0,0)};
            texts.Children.Add(new TextBlock {Text=L10n.Text(title),FontSize=14,FontWeight=on?FontWeights.SemiBold:FontWeights.Normal,TextWrapping=TextWrapping.Wrap});
            texts.Children.Add(new TextBlock {Text=L10n.Text(detail),FontSize=12,Foreground=Look.Secondary,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,2,0,0)});
            var row=new Button {Padding=new Thickness(14,11,14,11),HorizontalContentAlignment=HorizontalAlignment.Stretch,Content=Columns(Radio(on),texts)};
            AutomationProperties.SetName(row,L10n.Text(title)+(on?L10n.Text("current_page"):""));
            row.Click+=(_,_)=>{if(!on) {AppRouting.SetMode(value);Render();}};
            rows.Add(row);
        }
        Add(Card(rows,14));
        Add(new TextBlock {Text=L10n.Text("apps_apply_next"),FontSize=12,Foreground=Look.Secondary,Margin=new Thickness(4,0,4,0),TextWrapping=TextWrapping.Wrap},8,0);
        if(mode==AppRouting.All) return;

        var selected=new HashSet<string>(AppRouting.Apps,StringComparer.OrdinalIgnoreCase);
        var count=new TextBlock {FontSize=11,Foreground=Look.Accent,VerticalAlignment=VerticalAlignment.Center};
        if(L10n.Culture.TwoLetterISOLanguageName!="zh") count.FontFamily=new FontFamily("Cascadia Mono, Consolas");
        void ShowCount()=>count.Text=L10n.Text("apps_selected",selected.Count.ToString("N0",L10n.Culture));
        ShowCount();
        var header=new DockPanel {Margin=new Thickness(4,0,4,0)};
        DockPanel.SetDock(count,Dock.Right);header.Children.Add(count);header.Children.Add(Single(L10n.Text("running_apps"),13,Look.Secondary));
        Add(header,16,0);
        var query="";
        List<AppRouting.Entry> programs=new();
        var list=new ContentControl {Focusable=false,Margin=new Thickness(0,8,0,0)};
        Add(Search(text=>{query=text.Trim();Draw();},"search_apps"),8,0);
        Add(list);
        var add=Primary(L10n.Text("add_program"));
        Add(add,10,0);
        void Draw() {
            // Selected programs first, in the order this page opened with: ticking a box never moves a row.
            var opened=AppRouting.Apps.ToHashSet(StringComparer.OrdinalIgnoreCase);
            var known=programs.Concat(addedPrograms.Values).GroupBy(p=>p.Name,StringComparer.OrdinalIgnoreCase).Select(g=>g.First()).ToList();
            // Selected programs that are not running are still listed (by file name) so they can be cleared.
            foreach(var name in opened) if(!known.Any(p=>p.Name.Equals(name,StringComparison.OrdinalIgnoreCase))) known.Add(new AppRouting.Entry(name,System.IO.Path.GetFileNameWithoutExtension(name),null));
            var shown=known.OrderBy(p=>opened.Contains(p.Name)?0:1)
                .Where(p=>query.Length==0||p.Title.Contains(query,StringComparison.CurrentCultureIgnoreCase)||p.Name.Contains(query,StringComparison.OrdinalIgnoreCase)).ToList();
            var items=new List<FrameworkElement>();
            foreach(var program in shown) {
                FrameworkElement icon=program.Icon is { } image?new Image {Source=image,Width=24,Height=24}:Look.Badge(program.Title.Length>0?program.Title[..1].ToUpperInvariant():"?",24);
                var texts=new StackPanel {VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,8,0)};
                texts.Children.Add(Single(program.Title,14));
                var file=Single(program.Name,11,Look.Faint);file.FontFamily=new FontFamily("Cascadia Mono, Consolas");texts.Children.Add(file);
                var box=new Border {Width=18,Height=18,CornerRadius=new CornerRadius(3),BorderThickness=new Thickness(1.5),VerticalAlignment=VerticalAlignment.Center};
                Tick(box,selected.Contains(program.Name));
                var row=new Button {Height=46,Padding=new Thickness(14,0,14,0),HorizontalContentAlignment=HorizontalAlignment.Stretch,Content=Columns(icon,texts,box)};
                void Describe()=>AutomationProperties.SetName(row,program.Title+(selected.Contains(program.Name)?", "+L10n.Text("selected_state"):""));
                Describe();
                row.Click+=(_,_)=>{
                    if(!selected.Remove(program.Name)) selected.Add(program.Name);
                    AppRouting.SetApps(selected);Tick(box,selected.Contains(program.Name));Describe();ShowCount();
                };
                items.Add(row);
            }
            list.Content=items.Count>0?Card(items,50):null;
        }
        add.Click+=(_,_)=>{
            var dialog=new Microsoft.Win32.OpenFileDialog {Filter="*.exe|*.exe",CheckFileExists=true};
            if(dialog.ShowDialog(this)!=true) return;
            var program=AppRouting.Describe(dialog.FileName);
            addedPrograms[program.Name]=program;selected.Add(program.Name);AppRouting.SetApps(selected);ShowCount();Draw();
        };
        Draw();
        Work(async()=>{programs=await Task.Run(AppRouting.Running);if(page=="apps") Draw();});
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
                    Work(async()=>{await api.Action("revoke",new JsonObject {["enrollmentId"]=device["id"]!.GetValue<string>()});if(current) {Connection.Wanted=false;await connection.Disconnect();}accountData=await api.Request("account");Render();});
                };
                action=revoke;
            }
            var row=new Border {MinHeight=60,Padding=new Thickness(14,0,6,0),Child=Columns(Look.Badge(null,32,current?Look.Accent:Look.Secondary,mobile?"":""),TwoLines(deviceName,detail,strong:true),action)};
            rows.Add(row);
        }
        if(rows.Count>0) Add(Card(rows));
        else Add(Caption(L10n.Text("no_authorized_devices_yet_they_appear_after_their_first")));
        var configs=Number(account["configs"]);
        if(configs>0) Add(Caption(L10n.Text("devices_configs_note",configs.ToString("N0",L10n.Culture))),10,0);
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
        Add(new Border {Background=Look.Surface,CornerRadius=new CornerRadius(10),Padding=new Thickness(10,8,10,8),Child=new TextBox {
            Text=log.Length==0?L10n.Text("logs_empty"):string.Join("\n",log.Split('\n').Reverse()),IsReadOnly=true,BorderBrush=Brushes.Transparent,Background=Brushes.Transparent,Height=double.NaN,VerticalContentAlignment=VerticalAlignment.Top,
            FontFamily=new FontFamily("Consolas"),FontSize=11,TextWrapping=TextWrapping.Wrap,Padding=new Thickness(0)}});
    }
    private void Login() {
        var logo=Look.Mark(72,Look.Accent);logo.HorizontalAlignment=HorizontalAlignment.Center;Add(logo,28,0);
        var word=Look.Wordmark(26);word.HorizontalAlignment=HorizontalAlignment.Center;Add(word,18,0);
        Add(new TextBlock {Text=L10n.Text("sign_in_tagline"),FontSize=13,Foreground=Look.Secondary,TextAlignment=TextAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center},6,24);
        if(Notices() is { } notes) Add(notes,0,8);
        if(!Onboarded) Add(SectionRow("section_sign_in",1),0,10);
        TextBox? origin=null;
        if(NativeApi.BuiltInOrigin.Length==0) {Add(Caption(L10n.Text("server_address")),0,6);origin=Add(new TextBox {Text=api.Origin},0,12);AutomationProperties.SetName(origin,L10n.Text("server_address"));}
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
        AutomationProperties.SetName(email,L10n.Text("email"));AutomationProperties.SetName(hidden,L10n.Text("password"));AutomationProperties.SetName(shown,L10n.Text("password"));
        var forgot=Add(new Button {Style=(Style)FindResource("Bare"),Content=new Border {Padding=new Thickness(8,0,2,0),Child=Single(L10n.Text("forgot_password"),12,Look.Secondary)},HorizontalAlignment=HorizontalAlignment.Right,Height=30},4,0);
        forgot.Click+=(_,_)=>{
            var address=email.Text.Trim();
            if(address.Length==0) {Notify(L10n.Text("reset_enter_email_first"));email.Focus();return;}
            ResetPassword(address,L10n.Text("reset_confirm_detail",address),L10n.Text("reset_link_sent"),()=>{if(origin is not null) api.Origin=origin.Text.Trim();});
        };
        var login=Add(Primary(L10n.Text("sign_in_action")),8,0);
        login.IsDefault=true;
        login.Click+=(_,_)=>{
            var password=showPassword?shown.Text:hidden.Password;
            if(string.IsNullOrWhiteSpace(email.Text)||password.Length==0) {Notify(L10n.Text("enter_your_email_and_password"));return;}
            Work(async()=>{if(origin is not null) api.Origin=origin.Text.Trim();await api.Login(email.Text.Trim(),password);connection.ClearError();hidden.Clear();shown.Clear();page="connect";Render();CheckForUpdate(false);});
        };
    }
    /// Both "forgot password" and "change password" email the Portal's reset link; the new password is set there.
    private void ResetPassword(string email,string detail,string sent,Action? before=null) {
        if(MessageBox.Show(this,detail,L10n.Text("reset_by_email"),MessageBoxButton.OKCancel)!=MessageBoxResult.OK) return;
        Work(async()=>{before?.Invoke();await api.RequestPasswordReset(email);Notify(sent);});
    }
    private static readonly (string Code,string Name)[] Languages={("system",""),("zh","简体中文"),("en","English"),("ru","Русский")};
    private static string LanguageName(string code)=>code=="system"?L10n.Text("language_system"):Languages.FirstOrDefault(l=>l.Code==code).Name??"English";
    /// The list of languages, by their own names, in a small dark popup under the entry.
    private void ChooseLanguage(FrameworkElement anchor) {
        var list=new StackPanel {MinWidth=200};
        var popup=new Popup {PlacementTarget=anchor,Placement=PlacementMode.Bottom,StaysOpen=false,AllowsTransparency=true,
            Child=new Border {Background=Look.Raised,BorderBrush=Look.Edge,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(3),Padding=new Thickness(4),Child=list,Margin=new Thickness(0,4,0,0)}};
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
    /// Amber (the default) or Moon: the same file, lit in a softer pearl-to-rose light. Applies at once.
    private void ChooseAppearance(FrameworkElement anchor) {
        var list=new StackPanel {MinWidth=200};
        var popup=new Popup {PlacementTarget=anchor,Placement=PlacementMode.Bottom,StaysOpen=false,AllowsTransparency=true,
            Child=new Border {Background=Look.Raised,BorderBrush=Look.Edge,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(3),Padding=new Thickness(4),Child=list,Margin=new Thickness(0,4,0,0)}};
        if(anchor.ActualWidth>200) popup.HorizontalOffset=anchor.ActualWidth-212;
        foreach(var (code,key) in new[]{("amber","theme_amber"),("moon","theme_moon")}) {
            var chosen=Look.Theme==code;
            var item=new Button {Height=34,Padding=new Thickness(10,0,10,0),Content=Columns(new FrameworkElement(),Single(L10n.Text(key),13),chosen?Look.Icon("\uE73E",12,Look.Accent):null)};
            AutomationProperties.SetName(item,L10n.Text(key)+(chosen?L10n.Text("current_page"):""));
            item.Click+=(_,_)=>{
                popup.IsOpen=false;ApplyAppearance(code);
            };
            list.Children.Add(item);
        }
        popup.IsOpen=true;
    }
    private void ApplyAppearance(string code) {
        if(Look.Theme==code) return;
        Look.Apply(code);TitleLogo.Content=Look.Mark(16,Look.Accent);Backdrop.InvalidateVisual();
        flyout?.Close();flyout=null;fly=null;activity=null;ShowActivity(api.SignedIn);Render();
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
        var state=State();
        ShowSeal(state);
        if(statusTitle is not null) statusTitle.Text=StatusTitle(state);
        if(portrait is not null) {
            portrait.State=state;portrait.Lines=connection.Lines;
            portrait.Centre=state switch {
                LinkState.Connected=>Elapsed()??"",
                LinkState.Connecting=>Guidance.Phase(connection),
                LinkState.Reconnecting=>TimeSpan.FromSeconds(Guidance.Countdown(connection)).ToString(@"mm\:ss"),
                LinkState.Waiting=>"—",
                _=>""};
            portrait.Sub=state switch {
                LinkState.Connected=>L10n.Text("connection_rates",Mbps(connection.RxRate),Mbps(connection.TxRate)),
                LinkState.Reconnecting=>connection.Retry>0?L10n.Text("attempt_n",connection.Retry):"",
                LinkState.Waiting=>L10n.Text("offline_centre"),
                _=>""};
        }
        if(statusDetail is not null) statusDetail.Text=StatusDetail(state,false);
        // The first connection ends the first run: "Ready" for a moment, then the tabs.
        if(!Onboarded&&state==LinkState.Connected) {
            Onboarded=true;
            if(stepsHost is not null) stepsHost.Content=SectionRow("section_portrait",Steps+1);
            var later=new DispatcherTimer {Interval=TimeSpan.FromSeconds(3)};
            later.Tick+=(_,_)=>{later.Stop();if(!busy) Render();};later.Start();
        }
        ShowRates(rateBars,state);
        ShowSwitch(switchNote,switchText,state);
        if(location is { } place) {
            var (title,detail,code)=Location();
            place.Title.Text=title;place.Detail.Text=detail;
            var key=code??"*";
            if(key!=badgeKey) {badgeKey=key;place.Badge.Content=Look.Badge(code);}
        }
        if(flyout?.IsVisible==true) UpdateFlyout();
    }
}
