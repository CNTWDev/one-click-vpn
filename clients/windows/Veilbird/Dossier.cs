using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
namespace Veilbird;

/// The file language shared by every TrackNothing client and the Portal (portal-web/src/dossier.tsx): one line of a
/// file that can be "sealed". Sealing or opening first runs the text through a few frames of random glyphs in amber,
/// then it settles: sealed it is a dim dot matrix of the same width, open it is the plain text. With Windows
/// animations off it switches at once.
public sealed class SealedText:Grid {
    private const string Glyphs="01ABCDEF#%/<>*+=";
    private static readonly Dictionary<string,Brush> dotBrushes=new();
    private static Brush DotBrush=>dotBrushes.TryGetValue(Look.Theme,out var brush)?brush:dotBrushes[Look.Theme]=MakeDots();
    private readonly TextBlock text=new() {FontFamily=new FontFamily("Cascadia Mono, Consolas"),TextTrimming=TextTrimming.CharacterEllipsis,TextWrapping=TextWrapping.NoWrap,VerticalAlignment=VerticalAlignment.Center};
    private readonly Rectangle dots=new() {Fill=DotBrush,Opacity=0,IsHitTestVisible=false,HorizontalAlignment=HorizontalAlignment.Left};
    private readonly DispatcherTimer timer=new() {Interval=TimeSpan.FromMilliseconds(42)};
    private readonly Random random=new();
    private string value="";
    private int frame;
    public bool Sealed {get;private set;}
    public SealedText(double size=13) {
        text.FontSize=size;text.Foreground=Look.Text;
        Children.Add(text);Children.Add(dots);
        // The dots cover exactly the text's width, so a sealed line keeps its length.
        text.SizeChanged+=(_,e)=>{dots.Width=e.NewSize.Width;dots.Height=Math.Max(0,e.NewSize.Height-2);};
        timer.Tick+=(_,_)=>Step();
        Unloaded+=(_,_)=>timer.Stop();
    }
    /// The line's face and ink (monospaced, plain text colour by default).
    public FontFamily Face {set=>text.FontFamily=value;}
    public Brush Ink {set=>text.Foreground=value;}
    public string Value {
        get=>value;
        set {this.value=value;if(!timer.IsEnabled) text.Text=value;AutomationProperties.SetName(this,Sealed?"":value);}
    }
    /// Seals or opens the line after delay ms; animate false switches at once (first show, animations off).
    public void Seal(bool on,int delay=0,bool animate=true) {
        if(on==Sealed&&!timer.IsEnabled) return;
        Sealed=on;timer.Stop();
        AutomationProperties.SetName(this,on?"":value);
        if(!animate||!SystemParameters.ClientAreaAnimation) {text.Text=value;text.Foreground=on?Brushes.Transparent:Look.Text;dots.BeginAnimation(OpacityProperty,null);dots.Opacity=on?1:0;return;}
        frame=-Math.Max(0,delay/42);
        timer.Start();
    }
    private void Step() {
        frame++;
        if(frame<=0) return;
        if(frame==1&&!Sealed) dots.BeginAnimation(OpacityProperty,new DoubleAnimation(0,TimeSpan.FromMilliseconds(200)));
        if(frame>=11) {
            timer.Stop();text.Text=value;
            if(Sealed) {text.Foreground=Brushes.Transparent;dots.BeginAnimation(OpacityProperty,new DoubleAnimation(1,TimeSpan.FromMilliseconds(500)));}
            else text.Foreground=Look.Text;
            return;
        }
        text.Foreground=Look.Accent;
        text.Text=new string(value.Select(c=>c is ' ' or '·'?c:Glyphs[random.Next(Glyphs.Length)]).ToArray());
    }
    private static Brush MakeDots() {
        var dot=new GeometryDrawing(new SolidColorBrush(Color.FromArgb(97,Look.LightColor.R,Look.LightColor.G,Look.LightColor.B)),null,new EllipseGeometry(new Point(2,2),0.85,0.85));
        var brush=new DrawingBrush(new DrawingGroup {Children={new GeometryDrawing(Brushes.Transparent,null,new RectangleGeometry(new Rect(0,0,4,4))),dot}}) {
            TileMode=TileMode.Tile,Viewport=new Rect(0,0,4,4),ViewportUnits=BrushMappingMode.Absolute,Viewbox=new Rect(0,0,4,4),ViewboxUnits=BrushMappingMode.Absolute};
        brush.Freeze();return brush;
    }
}

/// The connect moment's light: a thin amber line with a soft trail that sweeps down the file when it is sealed and
/// back up when it is opened. Invisible at rest.
public sealed class ScanLine:Canvas {
    private readonly Rectangle trail=new() {Height=70},glow=new() {Height=6},line=new() {Height=1,Fill=Look.Accent};
    private readonly TranslateTransform move=new();
    private readonly Canvas band=new() {Opacity=0};
    public ScanLine() {
        IsHitTestVisible=false;ClipToBounds=true;
        band.RenderTransform=move;
        band.Children.Add(trail);band.Children.Add(glow);band.Children.Add(line);
        Children.Add(band);
        SizeChanged+=(_,e)=>{trail.Width=glow.Width=line.Width=e.NewSize.Width;};
    }
    public void Sweep(bool down,int duration=1300) {
        if(!SystemParameters.ClientAreaAnimation||ActualHeight<=0) return;
        var h=ActualHeight;var c=Look.AccentColor;
        trail.Fill=new LinearGradientBrush(Color.FromArgb(0,c.R,c.G,c.B),Color.FromArgb(28,c.R,c.G,c.B),down?90:270);
        glow.Fill=new SolidColorBrush(Color.FromArgb(60,c.R,c.G,c.B));line.Fill=Look.Accent;
        Canvas.SetTop(trail,down?-70:0);Canvas.SetTop(glow,-3);Canvas.SetTop(line,0);
        var time=TimeSpan.FromMilliseconds(duration);
        move.BeginAnimation(TranslateTransform.YProperty,new DoubleAnimation(down?0:h,down?h:0,time));
        var fade=new DoubleAnimationUsingKeyFrames {Duration=time};
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(0,KeyTime.FromPercent(0)));
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(1,KeyTime.FromPercent(0.12)));
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(1,KeyTime.FromPercent(0.85)));
        fade.KeyFrames.Add(new LinearDoubleKeyFrame(0,KeyTime.FromPercent(1)));
        band.BeginAnimation(OpacityProperty,fade);
    }
}

public static class Dossier {
    /// A short, stable file number for an account (same rule as the Portal's and the other clients'), not an id.
    public static string FileNumber(string seed) {
        ulong hash=7;
        foreach(var c in seed) hash=(hash*31+c)&0xFFFFFFFF;
        return (hash%10000).ToString("0000",System.Globalization.CultureInfo.InvariantCulture);
    }
    /// "§01 STATUS": the small monospaced number above a page or block.
    public static TextBlock Section(string key)=>new() {Text=L10n.Text(key),FontFamily=new FontFamily("Cascadia Mono, Consolas"),FontSize=11,Foreground=Look.Faint,Margin=new Thickness(4,0,4,0),TextWrapping=TextWrapping.NoWrap};
    /// The amber "SEALED" stamp, set slightly askew.
    public static Border Stamp()=>new() {
        Child=new TextBlock {Text="SEALED",FontFamily=new FontFamily("Cascadia Mono, Consolas"),FontSize=11,FontWeight=FontWeights.SemiBold,Foreground=Look.Accent,TextWrapping=TextWrapping.NoWrap},
        BorderBrush=Look.AccentLine,BorderThickness=new Thickness(1),CornerRadius=new CornerRadius(2),Padding=new Thickness(7,2,6,2),
        RenderTransformOrigin=new Point(0.5,0.5),RenderTransform=new TransformGroup {Children={new ScaleTransform(1,1),new RotateTransform(-6)}},Opacity=0,VerticalAlignment=VerticalAlignment.Center};
}

/// The connect page's portrait: what any site or app on this network can see of this PC, drawn as a sphere of light (a
/// halftone of amber dots lit from the upper left). It is also the switch: open, it breathes slowly and carries one
/// line, "tap to hide"; hidden, the dots go dark and a thin amber ring takes their place, holding the time hidden and
/// the rates (1.2 s change). Same drawing on every client (Android Portrait, Apple PortraitView).
public sealed class Portrait:FrameworkElement {
    public static readonly DependencyProperty HiddenProperty=DependencyProperty.Register(nameof(Hidden),typeof(double),typeof(Portrait),
        new FrameworkPropertyMetadata(0.0,FrameworkPropertyMetadataOptions.AffectsRender));
    public static readonly DependencyProperty PhaseProperty=DependencyProperty.Register(nameof(Phase),typeof(double),typeof(Portrait),
        new FrameworkPropertyMetadata(1.0,FrameworkPropertyMetadataOptions.AffectsRender));
    /// 0 visible … 1 hidden.
    public double Hidden {get=>(double)GetValue(HiddenProperty);set=>SetValue(HiddenProperty,value);}
    /// The slow breath, 0 … 1.
    public double Phase {get=>(double)GetValue(PhaseProperty);set=>SetValue(PhaseProperty,value);}
    private string invite="",centre="",sub="";
    /// The line in the open sphere, and in the ring once hidden the time and the rates.
    public string Invite {get=>invite;set {if(invite!=value) {invite=value;InvalidateVisual();}}}
    public string Centre {get=>centre;set {if(centre!=value) {centre=value;InvalidateVisual();}}}
    public string Sub {get=>sub;set {if(sub!=value) {sub=value;InvalidateVisual();}}}
    private DrawingGroup? dots;private double dotsSize;private Color dotsColor;
    public Portrait() {
        Cursor=System.Windows.Input.Cursors.Hand;Focusable=true;
        Loaded+=(_,_)=>Breathe();Unloaded+=(_,_)=>BeginAnimation(PhaseProperty,null);
    }
    private void Breathe() {
        if(!SystemParameters.ClientAreaAnimation) {BeginAnimation(PhaseProperty,null);Phase=1;return;}
        BeginAnimation(PhaseProperty,new DoubleAnimation(0,1,TimeSpan.FromMilliseconds(3000)) {AutoReverse=true,RepeatBehavior=RepeatBehavior.Forever,EasingFunction=new SineEase {EasingMode=EasingMode.EaseInOut}});
    }
    public void Set(bool hidden,bool moving) {
        var target=hidden?1.0:0.0;
        if(!moving) {BeginAnimation(HiddenProperty,null);Hidden=target;return;}
        BeginAnimation(HiddenProperty,new DoubleAnimation(target,TimeSpan.FromMilliseconds(1200)) {EasingFunction=new CubicEase {EasingMode=EasingMode.EaseInOut}});
    }
    protected override Size MeasureOverride(Size available)=>new(double.IsInfinity(available.Width)?0:available.Width,double.IsNaN(Height)?220:Height);
    private static Color Alpha(Color c,double a)=>Color.FromArgb((byte)Math.Clamp(a*255,0,255),c.R,c.G,c.B);
    /// The dot sphere, built once per size and look.
    private DrawingGroup Sphere(double s) {
        var light=Look.LightColor;
        if(dots is not null&&dotsSize==s&&dotsColor==light) return dots;
        var group=new DrawingGroup();
        using(var dc=group.Open()) {
            double pitch=s*6/320,r=s*1.15/320,radius=s/2,lx=s*0.42,ly=s*0.34;
            dc.DrawRectangle(Brushes.Transparent,null,new Rect(0,0,s,s));
            for(var y=pitch/2;y<s;y+=pitch) for(var x=pitch/2;x<s;x+=pitch) {
                if(Math.Sqrt((x-radius)*(x-radius)+(y-radius)*(y-radius))>radius) continue;
                var f=Math.Sqrt((x-lx)*(x-lx)+(y-ly)*(y-ly))/(s*0.82);
                var a=f<0.22?1-f/0.22*0.15:f<0.48?0.85-(f-0.22)/0.26*0.5:f<0.66?0.35-(f-0.48)/0.18*0.27:f<0.72?0.08-(f-0.66)/0.06*0.08:0;
                if(a>0) dc.DrawEllipse(new SolidColorBrush(Alpha(light,a)),null,new Point(x,y),r,r);
            }
        }
        group.Freeze();
        dots=group;dotsSize=s;dotsColor=light;
        return group;
    }
    private FormattedText Label(string text,double size,Brush ink,bool mono,double room) {
        var face=new Typeface(new FontFamily(mono?"Cascadia Mono, Consolas":"Segoe UI"),FontStyles.Normal,FontWeights.Normal,FontStretches.Normal);
        var dpi=VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var label=new FormattedText(text,L10n.Culture,FlowDirection.LeftToRight,face,size,ink,dpi);
        if(label.Width>room) label=new FormattedText(text,L10n.Culture,FlowDirection.LeftToRight,face,size*room/label.Width,ink,dpi);
        return label;
    }
    protected override void OnRender(DrawingContext dc) {
        double s=Math.Min(ActualWidth,ActualHeight),cx=ActualWidth/2,cy=ActualHeight/2,t=Math.Clamp(Hidden,0,1),phase=Phase;
        if(s<=0) return;
        dc.DrawRectangle(Brushes.Transparent,null,new Rect(cx-s/2,cy-s/2,s,s));
        var accent=Look.AccentColor;var text=((SolidColorBrush)Look.Text).Color;
        // The sphere: bright and breathing while visible, nearly dark once hidden.
        dc.PushTransform(new TranslateTransform(cx-s/2,cy-s/2));
        dc.PushOpacity((0.82+0.18*phase)*(1-t)+0.1*t);
        dc.DrawDrawing(Sphere(s));
        dc.Pop();dc.Pop();
        dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(text,0.07*(1-t))),1),new Point(cx,cy),s/2-1,s/2-1);
        if(invite.Length>0&&t<1) {
            var label=Label(invite,Math.Max(13,0.05*s),new SolidColorBrush(Alpha(accent,(1-t)*(0.75+0.25*phase))),false,0.8*s);
            dc.DrawText(label,new Point(cx-label.Width/2,cy-label.Height/2));
        }
        if(t<=0) return;
        // The ring that takes the sphere's place, with a soft glow; the time hidden and the rates inside.
        double rr=0.375*s,glow=(0.82+0.18*phase)*t;
        dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,0.11*glow)),8),new Point(cx,cy),rr,rr);
        dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,0.22*glow)),3),new Point(cx,cy),rr,rr);
        dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,glow)),1),new Point(cx,cy),rr,rr);
        if(centre.Length>0) {
            var time=Label(centre,0.072*s,new SolidColorBrush(Alpha(text,t)),true,0.62*s);
            dc.DrawText(time,new Point(cx-time.Width/2,cy-time.Height+0.01*s));
        }
        if(sub.Length>0) {
            var rates=Label(sub,Math.Max(10,0.036*s),new SolidColorBrush(Alpha(((SolidColorBrush)Look.Secondary).Color,t)),true,0.62*s);
            dc.DrawText(rates,new Point(cx-rates.Width/2,cy+0.03*s));
        }
    }
}
