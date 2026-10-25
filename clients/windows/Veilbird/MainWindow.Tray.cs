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

/// The tray icon, its menu and the flyout with the quick actions.
public partial class MainWindow {
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
}
