using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shell;
namespace Veilbird;

/// <summary>
/// The app beyond its window: a command palette on a global shortcut (Ctrl+Alt+Space) to go somewhere by typing
/// its name, the taskbar button's state badge and preview buttons, and a jump list of recent places. Launching the
/// app with --connect &lt;id&gt;, --disconnect or --check (what the jump list does) runs that action in the instance
/// already running.
/// </summary>
public partial class MainWindow {
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window,int id);
    private const int HotKeyId=0x7A11,WmHotKey=0x0312;
    // MOD_ALT | MOD_CONTROL | MOD_NOREPEAT, VK_SPACE.
    private const uint HotKeyModifiers=0x0001|0x0002|0x4000,HotKeySpace=0x20;

    private Window? palette;
    private TextBox? paletteQuery;
    private StackPanel? paletteList;
    private readonly List<PaletteItem> paletteItems=new();
    private int paletteIndex;
    private string recentShown="";
    private ThumbButtonInfo? thumbToggle;
    private sealed record PaletteItem(string Code,string Glyph,string Title,string Detail,Action Run);

    /// Called once from the constructor: makes the window handle even when started in the tray (--background).
    private void SetupShell() {
        var handle=new WindowInteropHelper(this).EnsureHandle();
        HwndSource.FromHwnd(handle)?.AddHook(ShellHook);
        if(!RegisterHotKey(handle,HotKeyId,HotKeyModifiers,HotKeySpace)) Journal.Add("palette: Ctrl+Alt+Space is used by another app");
        Closed+=(_,_)=>UnregisterHotKey(handle,HotKeyId);
        // The taskbar button: a dot when connected, and three buttons in its preview.
        thumbToggle=new ThumbButtonInfo {ImageSource=Glyph("M8,2 L8,8 M4.2,4.4 A5.2,5.2 0 1 0 11.8,4.4"),Description=L10n.Text("connect_action")};
        thumbToggle.Click+=(_,_)=>Toggle();
        var fastest=new ThumbButtonInfo {ImageSource=Glyph("M9,1.5 L3.5,9 L8,9 L7,14.5 L12.5,7 L8,7 Z"),Description=L10n.Text("automatic")};
        fastest.Click+=(_,_)=>{Select("","",showConnect:false);if(!connection.Active) Toggle();};
        var check=new ThumbButtonInfo {ImageSource=Glyph("M3,8.5 L6.5,12 L13,4.5"),Description=L10n.Text("check_title")};
        check.Click+=(_,_)=>RunCheck();
        TaskbarItemInfo=new TaskbarItemInfo {ThumbButtonInfos=new ThumbButtonInfoCollection {thumbToggle,fastest,check}};
        UpdateShell();
    }
    private IntPtr ShellHook(IntPtr window,int message,IntPtr wParam,IntPtr lParam,ref bool handled) {
        if(message==WmHotKey&&wParam.ToInt32()==HotKeyId) {handled=true;TogglePalette();}
        return IntPtr.Zero;
    }
    /// A one-colour line icon for the preview buttons, 16 × 16.
    private static ImageSource Glyph(string path) {
        var pen=new Pen(Brushes.White,1.6) {StartLineCap=PenLineCap.Round,EndLineCap=PenLineCap.Round,LineJoin=PenLineJoin.Round};
        var group=new DrawingGroup();
        group.Children.Add(new GeometryDrawing(Brushes.Transparent,null,new RectangleGeometry(new Rect(0,0,16,16))));
        group.Children.Add(new GeometryDrawing(null,pen,Geometry.Parse(path)));
        var image=new DrawingImage(group);image.Freeze();return image;
    }
    private static ImageSource Dot(Color color) {
        var group=new DrawingGroup();
        group.Children.Add(new GeometryDrawing(Brushes.Transparent,null,new RectangleGeometry(new Rect(0,0,16,16))));
        group.Children.Add(new GeometryDrawing(new SolidColorBrush(Color.FromRgb(24,24,26)),null,new EllipseGeometry(new Point(8,8),7,7)));
        group.Children.Add(new GeometryDrawing(new SolidColorBrush(color),null,new EllipseGeometry(new Point(8,8),5,5)));
        var image=new DrawingImage(group);image.Freeze();return image;
    }
    /// Follows the connection (called with the tray's update).
    private void UpdateShell() {
        if(TaskbarItemInfo is not { } info) return;
        info.Overlay=TrayConnected?Dot(Look.AccentColor):null;
        info.Description=tray.Text;
        if(thumbToggle is not null) thumbToggle.Description=L10n.Text(connection.Active?"disconnect_action":"connect_action");
        // A connection that landed goes to the top of the recent places.
        if(TrayConnected&&connection.NodeId.Length>0) RememberRecent(connection.NodeId,connection.NodeName.Length>0?connection.NodeName:directory.GetValueOrDefault(connection.NodeId).Name??"");
        var recent=Settings.Get("recentNodes");
        if(recent!=recentShown) {recentShown=recent;BuildJumpList(recent);}
    }
    private static void RememberRecent(string id,string name) {
        var list=Recent(Settings.Get("recentNodes"));
        if(list.Count>0&&list[0].Id==id) return;
        list.RemoveAll(x=>x.Id==id);list.Insert(0,(id,name));
        Settings.Set("recentNodes",string.Join("\n",list.Take(3).Select(x=>x.Id+"\t"+x.Name)));
    }
    private static List<(string Id,string Name)> Recent(string saved)=>saved.Split('\n',StringSplitOptions.RemoveEmptyEntries)
        .Select(line=>line.Split('\t')).Where(parts=>parts.Length==2&&parts[0].Length>0).Select(parts=>(parts[0],parts[1])).ToList();
    /// Right-click on the taskbar button: the last three places, then the tasks.
    private static void BuildJumpList(string recent) {
        try {
            var exe=Environment.ProcessPath??"";
            if(exe.Length==0||Application.Current is null) return;
            var list=new JumpList {ShowRecentCategory=false,ShowFrequentCategory=false};
            foreach(var (id,name) in Recent(recent))
                list.JumpItems.Add(new JumpTask {Title=name,Arguments="--connect "+id,ApplicationPath=exe,IconResourcePath=exe,CustomCategory=L10n.Text("jump_recent")});
            list.JumpItems.Add(new JumpTask {Title=L10n.Text("disconnect_action"),Arguments="--disconnect",ApplicationPath=exe,IconResourcePath=exe});
            list.JumpItems.Add(new JumpTask {Title=L10n.Text("check_title"),Arguments="--check",ApplicationPath=exe,IconResourcePath=exe});
            JumpList.SetJumpList(Application.Current,list);
        } catch(Exception error) {Journal.Add("jump list: "+error.GetType().Name);}
    }
    /// A launch (or a second launch) with an action from the jump list; anything else brings the window back.
    public void Launched() {
        var action=Settings.Get("launchAction");
        if(action.Length==0) {ShowFromTray();return;}
        Settings.Set("launchAction","");
        if(action.StartsWith("connect:",StringComparison.Ordinal)) {
            var id=action["connect:".Length..];
            var name=directory.GetValueOrDefault(id).Name??Recent(Settings.Get("recentNodes")).FirstOrDefault(x=>x.Id==id).Name??"";
            if(id!=nodeId||!connection.Active) Select(id,name,showConnect:false);
            if(!connection.Active) Toggle();
        }
        else if(action=="disconnect") {if(connection.Active) Toggle();}
        else if(action=="check") RunCheck();
        else ShowFromTray();
    }
    private void RunCheck() {
        ShowFromTray();
        if(connection.Active&&connection.Since is not null) ConnectionCheck();
        else {page="nodes";Render();}
    }

    // ---- Command palette ----
    private void TogglePalette() {
        if(palette?.IsVisible==true) {palette.Hide();return;}
        if(!api.SignedIn) {ShowFromTray();return;}
        palette??=BuildPalette();
        var area=SystemParameters.WorkArea;
        palette.Left=area.Left+(area.Width-palette.Width)/2;palette.Top=area.Top+area.Height*0.2;
        paletteQuery!.Text="";FillPalette();
        palette.Show();palette.Activate();paletteQuery.Focus();
        if(nodesData is null) _=QuietNodes();
    }
    private Window BuildPalette() {
        var window=new Window {
            WindowStyle=WindowStyle.None,AllowsTransparency=true,Background=Brushes.Transparent,ResizeMode=ResizeMode.NoResize,
            ShowInTaskbar=false,Topmost=true,Width=620,SizeToContent=SizeToContent.Height,FontFamily=FontFamily,UseLayoutRounding=true,
            Title=L10n.Text("palette_placeholder"),
        };
        var query=new TextBox {
            FontSize=19,Foreground=Look.Text,CaretBrush=Look.Accent,Background=Brushes.Transparent,BorderThickness=new Thickness(0),
            VerticalContentAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,0,0),
        };
        System.Windows.Automation.AutomationProperties.SetName(query,L10n.Text("palette_placeholder"));
        var hint=new TextBlock {Text=L10n.Text("palette_placeholder"),FontSize=19,Foreground=Look.Faint,IsHitTestVisible=false,Margin=new Thickness(14,0,0,0),VerticalAlignment=VerticalAlignment.Center};
        query.TextChanged+=(_,_)=>{hint.Visibility=query.Text.Length==0?Visibility.Visible:Visibility.Hidden;FillPalette();};
        var field=new Grid();field.Children.Add(hint);field.Children.Add(query);
        var head=new DockPanel {Height=58,Margin=new Thickness(18,0,18,0)};
        var mark=Look.Mark(22,Look.Accent);DockPanel.SetDock(mark,Dock.Left);head.Children.Add(mark);head.Children.Add(field);
        var list=new StackPanel {Margin=new Thickness(6,0,6,8)};
        var foot=new StackPanel {Orientation=Orientation.Horizontal,Margin=new Thickness(18,10,18,12)};
        foreach(var (key,text) in new[] {("↵",L10n.Text("palette_run")),("↑↓",L10n.Text("palette_select")),("Esc",L10n.Text("palette_close"))}) {
            foot.Children.Add(new Border {Background=Look.Raised,CornerRadius=new CornerRadius(5),Padding=new Thickness(6,1,6,1),Child=new TextBlock {Text=key,FontSize=11,Foreground=Look.Secondary,FontFamily=new FontFamily("Consolas")}});
            foot.Children.Add(new TextBlock {Text=text,FontSize=12,Foreground=Look.Faint,Margin=new Thickness(6,1,18,0),VerticalAlignment=VerticalAlignment.Center});
        }
        var footer=new Border {Background=new SolidColorBrush(Color.FromArgb(46,0,0,0)),CornerRadius=new CornerRadius(0,0,14,14),Child=foot};
        var stack=new StackPanel();stack.Children.Add(head);stack.Children.Add(list);stack.Children.Add(footer);
        // Room for the shadow around the card.
        window.Content=new Border {Margin=new Thickness(24),Background=Look.Surface,CornerRadius=new CornerRadius(14),Child=stack,
            Effect=new System.Windows.Media.Effects.DropShadowEffect {BlurRadius=40,ShadowDepth=10,Opacity=0.55,Color=Colors.Black}};
        window.Width=620+48;
        window.PreviewKeyDown+=(_,e)=>{
            switch(e.Key) {
                case Key.Escape:window.Hide();e.Handled=true;break;
                case Key.Down:MovePalette(1);e.Handled=true;break;
                case Key.Up:MovePalette(-1);e.Handled=true;break;
                case Key.Enter:RunPalette(paletteIndex);e.Handled=true;break;
            }
        };
        window.Deactivated+=(_,_)=>window.Hide();
        paletteQuery=query;paletteList=list;
        return window;
    }
    private void MovePalette(int step) {
        if(paletteItems.Count==0) return;
        paletteIndex=(paletteIndex+step+paletteItems.Count)%paletteItems.Count;ShowPaletteRows();
    }
    private void RunPalette(int index) {
        if(index<0||index>=paletteItems.Count) return;
        palette?.Hide();paletteItems[index].Run();
    }
    /// What the query matches: locations by name or country code, then the commands.
    private void FillPalette() {
        var q=(paletteQuery?.Text??"").Trim();
        bool Match(string text)=>q.Length==0||text.Contains(q,StringComparison.CurrentCultureIgnoreCase);
        paletteItems.Clear();paletteIndex=0;
        var located=PickerNodes();
        if(q.Length==0) {
            // Nothing typed: where you went last, then the commands.
            foreach(var (id,name) in Recent(Settings.Get("recentNodes"))) {
                var found=located.FirstOrDefault(p=>p.Id==id);
                if(found.Id is not null) AddPlace(found.Id,found.Name,found.Quality);
            }
        } else {
            foreach(var p in located.Where(p=>Match(p.Name)||Code(p.Id).StartsWith(q,StringComparison.OrdinalIgnoreCase)).Take(5)) AddPlace(p.Id,p.Name,p.Quality);
        }
        if(Match(L10n.Text("automatic"))) paletteItems.Add(new("","",L10n.Text("palette_connect_to",L10n.Text("automatic")),nodeId.Length==0&&connection.Active?L10n.Text("palette_current"):"",()=>Go("","")));
        var routing=L10n.Text(Smart?"palette_to_global":"palette_to_smart");
        if(Match(routing)) paletteItems.Add(new("","",routing,L10n.Text(Smart?"routing_smart":"routing_global"),()=>{Settings.Set("routing",Smart?"global":"smart");if(page=="nodes") Render();ApplyNow();UpdateTray();}));
        if(connection.Active&&connection.Since is not null&&Match(L10n.Text("check_title"))) paletteItems.Add(new("","",L10n.Text("check_title"),"",RunCheck));
        var toggle=L10n.Text(connection.Active?"disconnect_action":"connect_action");
        if(Match(toggle)) paletteItems.Add(new("",connection.Active?"":"",toggle,connection.Active&&connection.NodeName.Length>0?connection.NodeName:"",Toggle));
        ShowPaletteRows();
    }
    private string Code(string id)=>directory.GetValueOrDefault(id).Code??"";
    private void AddPlace(string id,string name,Quality? quality) {
        var current=connection.Active&&connection.NodeId==id;
        paletteItems.Add(new(Code(id),"",L10n.Text("palette_connect_to",name),current?L10n.Text("palette_current"):PickerDelay(quality),()=>Go(id,name)));
    }
    private void Go(string id,string name) {
        if(id!=nodeId||!connection.Active) Select(id,name,showConnect:false);
        if(!connection.Active) Toggle();
        UpdateTray();
    }
    private void ShowPaletteRows() {
        if(paletteList is null) return;
        paletteList.Children.Clear();
        if(paletteItems.Count==0) {
            paletteList.Children.Add(new TextBlock {Text=L10n.Text("palette_empty"),FontSize=13,Foreground=Look.Secondary,Margin=new Thickness(14,10,14,10)});
            return;
        }
        for(var i=0;i<paletteItems.Count;i++) {
            var item=paletteItems[i];var on=i==paletteIndex;var index=i;
            var ink=on?Look.OnAccent:Look.Text;
            FrameworkElement badge=item.Code.Length>0
                ?new Border {Width=26,Height=26,CornerRadius=new CornerRadius(7),Background=on?new SolidColorBrush(Color.FromArgb(40,0,0,0)):Look.Raised,
                    Child=new TextBlock {Text=item.Code,FontSize=10,FontWeight=FontWeights.SemiBold,FontFamily=new FontFamily("Consolas"),Foreground=on?Look.OnAccent:Look.Accent,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center}}
                :new Border {Width=26,Height=26,CornerRadius=new CornerRadius(7),Background=on?new SolidColorBrush(Color.FromArgb(40,0,0,0)):Look.Raised,
                    Child=new TextBlock {Text=item.Glyph,FontSize=12,FontFamily=Look.Icons,Foreground=on?Look.OnAccent:Look.Accent,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center}};
            var detail=new TextBlock {Text=item.Detail,FontSize=12,Foreground=on?Look.OnAccent:Look.Faint,Opacity=on?0.75:1,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,0,0)};
            var title=new TextBlock {Text=item.Title,FontSize=14,Foreground=ink,TextTrimming=TextTrimming.CharacterEllipsis,VerticalAlignment=VerticalAlignment.Center,Margin=new Thickness(12,0,0,0)};
            var row=new DockPanel {LastChildFill=true};
            DockPanel.SetDock(badge,Dock.Left);DockPanel.SetDock(detail,Dock.Right);
            row.Children.Add(badge);row.Children.Add(detail);row.Children.Add(title);
            var border=new Border {Height=46,Padding=new Thickness(12,0,12,0),CornerRadius=new CornerRadius(10),Background=on?Look.Accent:Brushes.Transparent,Child=row,Cursor=Cursors.Hand};
            border.MouseEnter+=(_,_)=>{if(paletteIndex!=index) {paletteIndex=index;ShowPaletteRows();}};
            border.MouseLeftButtonUp+=(_,_)=>RunPalette(index);
            paletteList.Children.Add(border);
        }
    }
}
