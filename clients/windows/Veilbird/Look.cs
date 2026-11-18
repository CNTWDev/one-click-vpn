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

public enum RingState {Idle,Connecting,Connected,Failed}

/// The palette and the small drawn pieces every page uses, in the file language every TrackNothing client shares
/// (warm near-black, amber only for light, nearly square corners) with the ∅ mark on a 16×16 grid, rings of square dots and the Doto dot-matrix face for figures.
public static class Look {
    public static Brush Hex(string hex) {var brush=(Brush)new BrushConverter().ConvertFromString(hex)!;brush.Freeze();return brush;}
    /// "amber" (the default) or "moon", a softer look where the light is pearl to rose; chosen in Account → Appearance.
    /// Pages are rebuilt on change, and the window's own chrome follows through dynamic resources (Apply).
    public static string Theme {get;private set;}=Settings.Get("appearance","amber")=="moon"?"moon":"amber";
    private sealed record Set(Brush Ground,Brush Surface,Brush Raised,Brush Selected,Brush Text,Brush Secondary,Brush Faint,Brush Accent,Brush Fair,Brush Hairline,Brush Edge,Brush AccentWash,Brush AccentLine,Brush Light,Brush Past,Color AccentColor,Color LightColor);
    private static readonly Set Amber=new(Hex("#080706"),Hex("#171513"),Hex("#211F1C"),Hex("#2E2B26"),Hex("#EDE7DF"),Hex("#A39B91"),Hex("#958B7C"),Hex("#E0A458"),Hex("#E8866A"),Hex("#0FEDE7DF"),Hex("#17FFD6A0"),Hex("#10E0A458"),Hex("#B3E0A458"),Hex("#FFD6A0"),Hex("#6F5A3F"),Color.FromRgb(224,164,88),Color.FromRgb(255,214,160));
    private static readonly Set Moon=new(Hex("#0A0809"),Hex("#181416"),Hex("#221D1F"),Hex("#30292C"),Hex("#F4EEE8"),Hex("#ACA0A2"),Hex("#988A8E"),Hex("#EBB8C3"),Hex("#E29678"),Hex("#0FF4EEE8"),Hex("#17F8E2E6"),Hex("#10EBB8C3"),Hex("#B3EBB8C3"),Hex("#F8E2E6"),Hex("#70565E"),Color.FromRgb(235,184,195),Color.FromRgb(248,226,230));
    private static Set Current=>Theme=="moon"?Moon:Amber;
    public static Brush Ground=>Current.Ground;
    public static Brush Surface=>Current.Surface;
    public static Brush Raised=>Current.Raised;
    public static Brush Selected=>Current.Selected;
    public static Brush Text=>Current.Text;
    public static Brush Secondary=>Current.Secondary;
    public static Brush Faint=>Current.Faint;
    public static Brush Accent=>Current.Accent;
    /// An "accent" control is outlined, not filled: OnAccent is the accent itself.
    public static Brush OnAccent=>Current.Accent;
    public static Brush Fair=>Current.Fair;
    public static Brush Hairline=>Current.Hairline;
    public static Brush Edge=>Current.Edge;
    public static Brush Line=>Current.Edge;
    /// A faint wash inside a line of the accent: the outlined "accent" control.
    public static Brush AccentWash=>Current.AccentWash;
    public static Brush AccentLine=>Current.AccentLine;
    /// The lamp, crop marks and sealed dots.
    public static Brush Light=>Current.Light;
    /// Past figures in charts (the accent, dimmed).
    public static Brush Past=>Current.Past;
    public static Color AccentColor=>Current.AccentColor;
    public static Color LightColor=>Current.LightColor;
    public static readonly Brush Danger=Hex("#F0675A"),Off=Hex("#34312B");
    /// Switches the look, saves it, and updates the application resources the XAML reads dynamically.
    public static void Apply(string theme) {
        Theme=theme=="moon"?"moon":"amber";Settings.Set("appearance",Theme);
        var resources=Application.Current.Resources;
        resources["Ground"]=Ground;resources["Surface"]=Surface;resources["Raised"]=Raised;resources["Selected"]=Selected;resources["Text"]=Text;
        resources["Secondary"]=Secondary;resources["Faint"]=Faint;resources["Accent"]=Accent;resources["OnAccent"]=Accent;resources["AccentWash"]=AccentWash;resources["Hairline"]=Hairline;
    }
    public static readonly FontFamily Icons=new("Segoe Fluent Icons, Segoe MDL2 Assets");
    /// Doto Black (SIL OFL, under Assets/Fonts), Latin only: wordmark, timers, totals and country codes.
    public static readonly FontFamily Dots=new(new Uri("pack://application:,,,/"),"./Assets/Fonts/#Doto Black");
    /// Same cells as scripts/brand-icons.py and the other clients.
    public static readonly (int X,int Y)[] MarkCells="14,1 5,2 6,2 7,2 8,2 9,2 10,2 13,2 3,3 4,3 11,3 12,3 2,4 11,4 13,4 2,5 10,5 13,5 1,6 9,6 14,6 1,7 8,7 14,7 1,8 7,8 14,8 1,9 6,9 14,9 2,10 5,10 13,10 2,11 4,11 13,11 3,12 4,12 11,12 12,12 2,13 5,13 6,13 7,13 8,13 9,13 10,13 1,14"
        .Split(' ').Select(cell=>{var xy=cell.Split(',');return (int.Parse(xy[0]),int.Parse(xy[1]));}).ToArray();
    /// The mark as squares in a 16-unit box.
    public static readonly Geometry MarkShape=Squares(MarkCells,0.86);
    public static Geometry Squares(IEnumerable<(int X,int Y)> cells,double square) {
        var geometry=new StreamGeometry();
        using(var draw=geometry.Open())
            foreach(var (x,y) in cells) {draw.BeginFigure(new Point(x,y),true,true);draw.PolyLineTo(new[]{new Point(x+square,y),new Point(x+square,y+square),new Point(x,y+square)},false,false);}
        geometry.Freeze();return geometry;
    }
    /// Cells one cell wide on a circle of `radius` in an n×n grid, each with its clockwise position from the top (0…1).
    public static (int X,int Y,double Turn)[] RingCells(int n,double radius) {
        var c=(n-1)/2.0;var cells=new List<(int,int,double)>();
        for(var y=0;y<n;y++) for(var x=0;x<n;x++) {
            if(Math.Abs(Math.Sqrt((x-c)*(x-c)+(y-c)*(y-c))-radius)>0.55) continue;
            var degrees=Math.Atan2(y-c,x-c)*180/Math.PI;
            cells.Add((x,y,(degrees+450)%360/360));
        }
        return cells.ToArray();
    }
    /// The ∅ mark: an empty set drawn in square pixels.
    public static FrameworkElement Mark(double size,Brush color) {
        var canvas=new Canvas {Width=16,Height=16};
        canvas.Children.Add(new System.Windows.Shapes.Path {Data=MarkShape,Fill=color});
        return new Viewbox {Width=size,Height=size,Child=canvas,IsHitTestVisible=false};
    }
    /// "TRACKNOTHING" in the dot-matrix face, shown once per screen next to the mark.
    public static TextBlock Wordmark(double size) {
        var text=new TextBlock {Text="TRACKNOTHING",FontFamily=Dots,FontSize=size,Foreground=Text,VerticalAlignment=VerticalAlignment.Center};
        AutomationProperties.SetName(text,"TrackNothing");
        return text;
    }
    public static TextBlock Icon(string glyph,double size,Brush color)=>new() {Text=glyph,FontFamily=Icons,FontSize=size,Foreground=color,VerticalAlignment=VerticalAlignment.Center,HorizontalAlignment=HorizontalAlignment.Center};
    /// A square tile with a two-letter country code, or the sparkle of automatic mode when code is null.
    public static Border Badge(string? code,double size=32,Brush? tint=null,string? glyph=null) {
        var content=glyph is not null?Icon(glyph,size*0.44,tint??Text)
            :code is null?new TextBlock {Text="✦",FontSize=size*0.46,Foreground=Accent,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center}
            :new TextBlock {Text=code,FontFamily=Dots,FontSize=size*0.42,Foreground=tint??Accent,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center};
        return new Border {Width=size,Height=size,CornerRadius=new CornerRadius(2),Background=Raised,Child=content,VerticalAlignment=VerticalAlignment.Center};
    }
    /// Three square bars: how many are lit and in which color says how good a location is.
    public static FrameworkElement Signal(int level,Brush color) {
        var bars=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center,Height=12};
        for(var i=0;i<3;i++) bars.Children.Add(new Rectangle {Width=3,Height=5+3.5*i,Fill=i<level?color:Off,VerticalAlignment=VerticalAlignment.Bottom,Margin=new Thickness(i==0?0:2.5,0,0,0)});
        return bars;
    }
}
