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
    /// Controls are filled, never outlined: text on a solid amber (or pink) control is near-black.
    public static Brush OnAccent=>Theme=="moon"?MoonInk:AmberInk;
    private static readonly Brush AmberInk=Hex("#1C1307"),MoonInk=Hex("#26141A");
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
        resources["Secondary"]=Secondary;resources["Faint"]=Faint;resources["Accent"]=Accent;resources["OnAccent"]=OnAccent;resources["AccentWash"]=AccentWash;resources["Hairline"]=Hairline;
    }
    public static readonly FontFamily Icons=new("Segoe Fluent Icons, Segoe MDL2 Assets");
    /// Doto Black (SIL OFL, under Assets/Fonts), Latin only: wordmark, timers, totals and country codes.
    public static readonly FontFamily Dots=new(new Uri("pack://application:,,,/"),"./Assets/Fonts/#Doto Black");
    /// The ∅ mark in its 100×100 box, solid form: a heavy ring and bar with a gap where the bar crosses. Same geometry as
    /// scripts/brand-icons.py, shared/brand.tsx and the other clients.
    public static readonly Geometry MarkShape=Frozen(Geometry.Parse("M84.06,34.32A37.5,37.5 0 0,1 34.32,84.06L46.21,72.18A22.5,22.5 0 0,0 72.18,46.21ZM15.94,65.68A37.5,37.5 0 0,1 65.68,15.94L53.79,27.82A22.5,22.5 0 0,0 27.82,53.79ZM11.82,78.28L78.28,11.82L88.18,21.72L21.72,88.18Z"));
    /// The same shape as a halftone of dots lit from the upper left (dot size carries the light), for 40 px and up.
    public static readonly Geometry MarkDots=Frozen(BuildMarkDots());
    private static Geometry Frozen(Geometry geometry) {geometry.Freeze();return geometry;}
    private static Geometry BuildMarkDots() {
        var group=new GeometryGroup {FillRule=FillRule.Nonzero};
        double pitch=3.4,root2=Math.Sqrt(2);
        for(var j=0;j<31;j++) for(var i=0;i<31;i++) {
            double x=pitch/2+i*pitch+(j%2==1?pitch/2:0),y=pitch/2+j*pitch*0.866;
            double d=Math.Sqrt((x-50)*(x-50)+(y-50)*(y-50)),across=Math.Abs((x-50)+(y-50))/root2,along=Math.Abs((x-50)-(y-50))/root2;
            if(!((d>=25&&d<=37&&across>11)||(across<=5.6&&along<=46))) continue;
            var f=Math.Sqrt((x-42)*(x-42)+(y-34)*(y-34))/82;
            var light=f<0.22?1-f/0.22*0.15:f<0.48?0.85-(f-0.22)/0.26*0.5:f<0.66?0.35-(f-0.48)/0.18*0.27:0.08;
            var r=1.65*Math.Sqrt(Math.Max(0.5,light));
            group.Children.Add(new EllipseGeometry(new Point(x,y),r,r));
        }
        return group;
    }
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
    /// The ∅ mark; the shape's 8…92 span of its 100 box fills `size`. Dots from 40 px up, solid below.
    public static FrameworkElement Mark(double size,Brush color) {
        var canvas=new Canvas {Width=84,Height=84};
        var shape=new System.Windows.Shapes.Path {Data=size>=40?MarkDots:MarkShape,Fill=color};
        Canvas.SetLeft(shape,-8);Canvas.SetTop(shape,-8);canvas.Children.Add(shape);
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
