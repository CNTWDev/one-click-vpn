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

/// The palette and the small drawn pieces every page uses, in the pixel language every TrackNothing client
/// shares: the ∅ mark on a 16×16 grid, rings of square dots and the Doto dot-matrix face for figures.
public static class Look {
    public static Brush Hex(string hex) {var brush=(Brush)new BrushConverter().ConvertFromString(hex)!;brush.Freeze();return brush;}
    public static readonly Brush Ground=Hex("#0D1310"),Surface=Hex("#151C17"),Raised=Hex("#1F2922"),Selected=Hex("#263127"),Text=Hex("#ECF1E8"),Secondary=Hex("#93A090"),Faint=Hex("#7F8B7C");
    public static readonly Brush Accent=Hex("#B7DC68"),OnAccent=Hex("#111912"),Danger=Hex("#F0907A"),Fair=Hex("#E2B85C"),Hairline=Hex("#0FECF1E8"),Edge=Hex("#1FECF1E8"),Off=Hex("#2E3A30");
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
        return new Border {Width=size,Height=size,CornerRadius=new CornerRadius(size*0.19),Background=Raised,Child=content,VerticalAlignment=VerticalAlignment.Center};
    }
    /// Three square bars: how many are lit and in which color says how good a location is.
    public static FrameworkElement Signal(int level,Brush color) {
        var bars=new StackPanel {Orientation=Orientation.Horizontal,VerticalAlignment=VerticalAlignment.Center,Height=12};
        for(var i=0;i<3;i++) bars.Children.Add(new Rectangle {Width=3,Height=5+3.5*i,Fill=i<level?color:Off,VerticalAlignment=VerticalAlignment.Bottom,Margin=new Thickness(i==0?0:2.5,0,0,0)});
        return bars;
    }
    public const string StreamIdle="---- ---- ---- ----";
    public static readonly Brush StreamOn=Hex("#7E9C4C"),StreamOff=Hex("#2E3B31");
    /// The "data stream" under the ring: hex digits that each change on their own slow beat (3–9 s),
    /// so about three change every second.
    public static string Stream(DateTime now) {
        var seconds=(long)(now-DateTime.UnixEpoch).TotalSeconds;const string hex="0123456789ABCDEF";
        var line=new System.Text.StringBuilder();
        for(var i=0;i<16;i++) {
            var beat=(ulong)(seconds/(3+i%7));
            var h=unchecked(beat*0x9E3779B97F4A7C15UL^(ulong)i*0xBF58476D1CE4E5B9UL);
            h^=h>>31;
            line.Append(hex[(int)(h%16)]);
            if(i%4==3&&i<15) line.Append(' ');
        }
        return line.ToString();
    }
}
