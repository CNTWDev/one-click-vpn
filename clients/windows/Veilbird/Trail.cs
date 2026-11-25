using System.Globalization;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Veilbird;

/// <summary>
/// Time this PC spent connected, per UTC day, kept for 90 days. Counted here only (the server knows traffic, not
/// time); the usage page's trail shows it as "hidden here". Ticked by the window's one-second refresh.
/// </summary>
public static class HiddenTime {
    private const string Key="hiddenSeconds";
    private static DateTime last=DateTime.MinValue;
    private static double pending;
    private static string Day(DateTime utc)=>utc.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture);
    public static void Tick(bool connected) {
        var now=DateTime.UtcNow;
        // A gap over two minutes is a paused timer (sleep), not two minutes known to be connected.
        if(connected&&last!=DateTime.MinValue) pending+=Math.Clamp((now-last).TotalSeconds,0,120);
        last=connected?now:DateTime.MinValue;
        if(pending>=60||(!connected&&pending>0)) Flush();
    }
    public static void Flush() {
        if(pending<=0) return;
        var saved=Saved();
        var today=Day(DateTime.UtcNow);
        saved[today]=(saved[today]?.GetValue<double>()??0)+pending;pending=0;
        var oldest=Day(DateTime.UtcNow.AddDays(-91));
        var kept=new JsonObject();
        foreach(var (day,value) in saved) if(string.CompareOrdinal(day,oldest)>=0&&value is not null) kept[day]=value.GetValue<double>();
        Settings.Set(Key,kept.ToJsonString());
    }
    private static JsonObject Saved() {try {return JsonNode.Parse(Settings.Get(Key,"{}")) as JsonObject??new();} catch {return new();}}
    /// <summary>Hours connected over the last <paramref name="days"/> days, today included.</summary>
    public static double Hours(int days) {
        var since=Day(DateTime.UtcNow.AddDays(-(days-1)));
        var total=pending;
        foreach(var (day,value) in Saved()) if(string.CompareOrdinal(day,since)>=0&&value is not null) total+=value.GetValue<double>();
        return total/3600;
    }
    public static string Text(double hours)=>L10n.Text("trail_hours",hours.ToString(hours<10?"0.#":"0",L10n.Culture));
}

/// <summary>One exit on the trail: where it is and its share of the traffic (the busiest is 1).</summary>
public sealed record TrailExit(Spot Spot,double Weight);

/// <summary>
/// The trail: every location this account went out from in the range, lit by how much went through it. With the
/// home city, arcs from it; without (the poster's default), rings at the exits only, so nothing points home.
/// Same drawing as the Mac (Trail.swift) and Android (Trail.kt).
/// </summary>
public sealed class TrailGlobe:FrameworkElement {
    public IReadOnlyList<TrailExit> Exits {get;init;}=Array.Empty<TrailExit>();
    public Spot? Home {get;init;}
    public bool Labels {get;init;}=true;
    private static readonly FontFamily Sans=new("Segoe UI");
    private static Color Alpha(Color c,double a)=>Color.FromArgb((byte)Math.Clamp(a*255,0,255),c.R,c.G,c.B);
    private static Brush Ink(Color c,double a) {var brush=new SolidColorBrush(Alpha(c,a));brush.Freeze();return brush;}
    private static Color Of(Brush brush)=>brush is SolidColorBrush solid?solid.Color:Colors.White;
    /// <summary>Seen from above the middle of the exits (and home), weighted by traffic.</summary>
    public static (double Lat,double Lon) Centre(IEnumerable<TrailExit> exits,Spot? home) {
        double x=0,y=0,z=0;
        void Add(Spot s,double w) {
            var p=s.Lat*Math.PI/180;var l=s.Lon*Math.PI/180;
            x+=w*Math.Cos(p)*Math.Sin(l);y+=w*Math.Sin(p);z+=w*Math.Cos(p)*Math.Cos(l);
        }
        foreach(var e in exits) Add(e.Spot,0.3+e.Weight);
        if(home is not null) Add(home,1.3);
        var n=Math.Sqrt(x*x+y*y+z*z);
        if(n<1e-6) return (home?.Lat??25,home?.Lon??110);
        return (Math.Clamp(Math.Asin(y/n)*180/Math.PI,-35,50),Math.Atan2(x,z)*180/Math.PI);
    }
    private DrawingGroup? sphere;
    private string sphereKey="";
    protected override void OnRender(DrawingContext dc) {
        var s=Math.Min(ActualWidth,ActualHeight);
        if(s<=0||Exits.Count==0) return;
        var view=Centre(Exits,Home);
        double cx=ActualWidth/2,cy=ActualHeight/2,radius=s/2,u=s/320;
        var key=$"{s:0.#} {Math.Round(view.Lat)} {Math.Round(view.Lon)} {Look.LightColor}";
        if(sphere is null||sphereKey!=key) {
            var light=Look.LightColor;var brushes=new Dictionary<int,Brush>();
            sphere=Earth.Lattice(s,view.Lat,view.Lon,a=>{var step=(int)Math.Round(Math.Clamp(a,0,1)*63);if(!brushes.TryGetValue(step,out var b)) brushes[step]=b=Ink(light,step/63.0);return b;});
            sphereKey=key;
        }
        dc.PushTransform(new TranslateTransform(cx-radius,cy-radius));dc.PushOpacity(0.55);
        dc.DrawDrawing(sphere);
        dc.Pop();dc.Pop();
        (double X,double Y,bool Shown) Screen((double X,double Y,double Z) p)=>(cx+p.X*radius,cy-p.Y*radius,p.Z>0||Math.Sqrt(p.X*p.X+p.Y*p.Y)>1);
        (double X,double Y,bool Shown) Place(Spot p)=>Screen(Earth.Project(p.Lat,p.Lon,0,view.Lat,view.Lon));
        var accent=Look.AccentColor;var lightColor=Look.LightColor;var text=Of(Look.Text);
        var order=Exits.OrderBy(e=>e.Weight).ToList();
        foreach(var e in order) {
            var end=Place(e.Spot);
            if(!end.Shown) continue;
            var w=e.Weight;
            if(Home is not null) {
                var path=Arc(Home,e.Spot,view,cx,cy,radius);
                dc.DrawGeometry(null,new Pen(Ink(accent,0.07+0.08*w),(7*w+2)*u) {StartLineCap=PenLineCap.Round,EndLineCap=PenLineCap.Round,LineJoin=PenLineJoin.Round},path);
                dc.DrawGeometry(null,new Pen(Ink(accent,0.35+0.55*w),1.6*u) {StartLineCap=PenLineCap.Round,EndLineCap=PenLineCap.Round,LineJoin=PenLineJoin.Round},path);
            } else {
                for(var i=1;i<=2;i++) {
                    var r=(8+10*w)*u*i*1.3;
                    dc.DrawEllipse(null,new Pen(Ink(accent,(0.12+0.3*w)/i),Math.Max(1,u)),new Point(end.X,end.Y),r,r);
                }
            }
        }
        foreach(var e in order) {
            var p=Place(e.Spot);
            if(!p.Shown) continue;
            var w=e.Weight;var r=(10+16*w)*u;
            var glow=new RadialGradientBrush(Alpha(accent,0.25+0.4*w),Alpha(accent,0));glow.Freeze();
            dc.DrawEllipse(glow,null,new Point(p.X,p.Y),r,r);
            var side=Math.Max(4,(4+3*w)*u);
            dc.DrawRectangle(Ink(lightColor,0.6+0.4*w),null,new Rect(p.X-side/2,p.Y-side/2,side,side));
        }
        if(Home is not null) {
            var p=Place(Home);
            if(p.Shown) {
                dc.DrawEllipse(null,new Pen(Ink(text,0.4),Math.Max(1,u)),new Point(p.X,p.Y),8*u,8*u);
                var side=Math.Max(4,5*u);
                dc.DrawRectangle(Ink(text,0.95),null,new Rect(p.X-side/2,p.Y-side/2,side,side));
            }
        }
        if(!Labels) return;
        // The busiest visible exits get a name; one that would cover another is left out.
        var taken=new List<Rect>();
        var dip=VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var halo=Of(Look.Ground);
        foreach(var e in Exits.OrderByDescending(e=>e.Weight).Take(4)) {
            var p=Place(e.Spot);
            if(!p.Shown||e.Spot.Label.Length==0) continue;
            var top=e.Weight>0.9;
            var size=Math.Max(11,11*u);
            var face=new Typeface(Sans,FontStyles.Normal,FontWeights.Medium,FontStretches.Normal);
            var label=new FormattedText(e.Spot.Label,L10n.Culture,FlowDirection.LeftToRight,face,size,top?Ink(accent,1):Ink(text,0.75),dip);
            var x=p.X+12*u;
            if(x+label.Width>ActualWidth-4) x=p.X-12*u-label.Width;
            var rect=new Rect(x,p.Y-label.Height*1.3,label.Width,label.Height);
            var grown=rect;grown.Inflate(4,2);
            if(taken.Any(t=>t.IntersectsWith(grown))) continue;
            taken.Add(rect);
            var shadow=new FormattedText(e.Spot.Label,L10n.Culture,FlowDirection.LeftToRight,face,size,Ink(halo,0.85),dip);
            foreach(var (dx,dy) in new[]{(-1.0,0.0),(1.0,0.0),(0.0,-1.0),(0.0,1.0)}) dc.DrawText(shadow,new Point(rect.X+dx,rect.Y+dy));
            dc.DrawText(label,rect.TopLeft);
        }
    }
    /// <summary>A great circle lifted off the ground, flattened until it stays in the frame, cut where it passes behind.</summary>
    private static StreamGeometry Arc(Spot a,Spot b,(double Lat,double Lon) view,double cx,double cy,double radius) {
        var w=Earth.Angle(a.Lat,a.Lon,b.Lat,b.Lon);
        var lift=Math.Max(0.06,0.08+0.28*w/Math.PI);
        var points=new (double X,double Y,bool Shown)[81];
        for(var attempt=0;attempt<5;attempt++) {
            var far=0.0;
            for(var i=0;i<=80;i++) {
                var t=i/80.0;
                var gc=Earth.Slerp(a.Lat,a.Lon,b.Lat,b.Lon,t);
                var p=Earth.Project(gc.Lat,gc.Lon,lift*Math.Sin(Math.PI*t),view.Lat,view.Lon);
                points[i]=(cx+p.X*radius,cy-p.Y*radius,p.Z>0||Math.Sqrt(p.X*p.X+p.Y*p.Y)>1);
                far=Math.Max(far,Math.Sqrt(p.X*p.X+p.Y*p.Y));
            }
            if(far<1.04) break;
            lift*=0.7;
        }
        var geometry=new StreamGeometry();
        using(var g=geometry.Open()) {
            var open=false;
            foreach(var q in points) {
                var r=Math.Sqrt((q.X-cx)*(q.X-cx)+(q.Y-cy)*(q.Y-cy));
                if(!q.Shown||r>radius*0.93) {open=false;continue;}
                if(open) g.LineTo(new Point(q.X,q.Y),true,true); else {g.BeginFigure(new Point(q.X,q.Y),false,false);open=true;}
            }
        }
        geometry.Freeze();
        return geometry;
    }
}

/// <summary>The shared picture: 1080×1920 (laid out at 360×640, three times over). No IP, no account; the home city only when turned on.</summary>
public static class TrailPoster {
    public static FrameworkElement Page(IReadOnlyList<TrailExit> exits,Spot? home,string range,IReadOnlyList<(string Value,string Name)> stats) {
        var stack=new StackPanel();
        var brand=new StackPanel {Orientation=Orientation.Horizontal};
        brand.Children.Add(Look.Mark(16,Look.Accent));
        var word=Look.Wordmark(11);word.Margin=new Thickness(8,0,0,0);brand.Children.Add(word);
        stack.Children.Add(brand);
        stack.Children.Add(new TextBlock {Text=L10n.Text("trail_poster_title"),FontSize=26,FontWeight=FontWeights.Light,Foreground=Look.Text,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,14,0,0)});
        stack.Children.Add(new TextBlock {Text=range,FontSize=12,FontWeight=FontWeights.Medium,Foreground=Look.Faint,Margin=new Thickness(0,6,0,0)});
        stack.Children.Add(new TrailGlobe {Exits=exits,Home=home,Width=300,Height=300,Margin=new Thickness(0,14,0,0),HorizontalAlignment=HorizontalAlignment.Center});
        var figures=Stats(stats,26);figures.Margin=new Thickness(0,14,0,0);
        stack.Children.Add(figures);
        var slogan=new TextBlock {Text=L10n.Text("trail_poster_slogan"),FontSize=13,Foreground=Look.Secondary,VerticalAlignment=VerticalAlignment.Bottom};
        var page=new Grid {Width=360,Height=640,Background=Look.Ground};
        page.Children.Add(new Border {Padding=new Thickness(30,34,30,34),Child=stack});
        page.Children.Add(new Border {Padding=new Thickness(30,0,30,34),Child=slogan,VerticalAlignment=VerticalAlignment.Bottom});
        TextOptions.SetTextFormattingMode(page,TextFormattingMode.Ideal);
        return page;
    }
    /// <summary>Three figures side by side: the number in the dot face with its unit small beside it, the name under it.</summary>
    public static Grid Stats(IReadOnlyList<(string Value,string Name)> stats,double size) {
        var grid=new Grid();
        for(var i=0;i<stats.Count;i++) {
            grid.ColumnDefinitions.Add(new ColumnDefinition {Width=new GridLength(1,GridUnitType.Star)});
            var cell=new StackPanel {Margin=new Thickness(i>0?12:0,0,0,0)};
            var parts=stats[i].Value.Split(' ',2);
            var figure=new TextBlock {TextWrapping=TextWrapping.NoWrap};
            figure.Inlines.Add(new System.Windows.Documents.Run(parts[0]) {FontFamily=Look.Dots,FontSize=size,Foreground=i==0?Look.Accent:Look.Text});
            if(parts.Length>1) figure.Inlines.Add(new System.Windows.Documents.Run(" "+parts[1]) {FontSize=size*0.5,FontWeight=FontWeights.SemiBold,Foreground=Look.Secondary});
            cell.Children.Add(figure);
            cell.Children.Add(new TextBlock {Text=stats[i].Name,FontSize=11,Foreground=Look.Secondary,Margin=new Thickness(0,4,0,0),TextTrimming=TextTrimming.CharacterEllipsis});
            Grid.SetColumn(cell,i);grid.Children.Add(cell);
        }
        return grid;
    }
    /// <summary>The page as a 1080×1920 image.</summary>
    public static BitmapSource Render(FrameworkElement page) {
        page.Measure(new Size(360,640));page.Arrange(new Rect(0,0,360,640));page.UpdateLayout();
        var bitmap=new RenderTargetBitmap(1080,1920,288,288,PixelFormats.Pbgra32);
        bitmap.Render(page);bitmap.Freeze();
        return bitmap;
    }
    /// <summary>Asks where to save, then writes a PNG; false when cancelled or the write failed.</summary>
    public static bool Save(BitmapSource image,Window owner) {
        var dialog=new Microsoft.Win32.SaveFileDialog {FileName="TrackNothing.png",Filter="PNG|*.png",DefaultExt=".png",
            InitialDirectory=Environment.GetFolderPath(Environment.SpecialFolder.MyPictures)};
        if(dialog.ShowDialog(owner)!=true) return false;
        try {
            var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));
            using var file=System.IO.File.Create(dialog.FileName);encoder.Save(file);
            return true;
        } catch {return false;}
    }
}
