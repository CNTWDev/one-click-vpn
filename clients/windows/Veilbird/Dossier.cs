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
/// the rates (1.2 s change). Same drawing on every client (Android Portrait, Apple PortraitView); hidden, the ring draws
/// the state: connecting, an arc that circles (1.4 s a turn); switching lines, one segment per line, the one being tried
/// blinking; reconnecting, a bright dot going round a ring of dim square dots (4 s a turn); offline, the dots rest. With
/// Windows animations off every loop rests on its first frame.
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
    private LinkState state=LinkState.Idle;private int lines=2;
    public LinkState State {get=>state;set {if(state!=value) {state=value;Loop();InvalidateVisual();}}}
    /// The lines of the location being tried, one ring segment each while switching.
    public int Lines {get=>lines;set {if(lines!=value) {lines=value;InvalidateVisual();}}}
    private readonly System.Windows.Threading.DispatcherTimer frames=new() {Interval=TimeSpan.FromMilliseconds(33)};
    private readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
    private static bool Moving(LinkState s)=>s is LinkState.Connecting or LinkState.Switching or LinkState.Reconnecting;
    private void Loop() {
        if(Moving(state)&&SystemParameters.ClientAreaAnimation&&IsVisible&&!resting) frames.Start(); else frames.Stop();
    }
    private DrawingGroup? dots;private double dotsSize;private Color dotsColor;
    public Portrait() {
        Cursor=System.Windows.Input.Cursors.Hand;Focusable=true;
        frames.Tick+=(_,_)=>InvalidateVisual();
        // Breathes only while it can be seen: the window closed to the tray (hidden, not unloaded) or minimised
        // would otherwise keep redrawing the sphere every frame.
        IsVisibleChanged+=(_,_)=>{Breathe();Loop();};Unloaded+=(_,_)=>frames.Stop();
    }
    private bool breathing,resting;
    /// Set while the window is minimised: still "visible" to WPF, but nobody sees it breathe.
    public bool Resting {set {if(resting!=value) {resting=value;Breathe();Loop();}}}
    private void Breathe() {
        var on=IsVisible&&!resting&&SystemParameters.ClientAreaAnimation;
        if(on==breathing) return;
        breathing=on;
        if(!on) {BeginAnimation(PhaseProperty,null);Phase=1;return;}
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
    /// The arc from [from] degrees (0 at three o'clock, clockwise) over [sweep] degrees.
    private static StreamGeometry Arc(Point c,double r,double from,double sweep) {
        static Point At(Point c,double r,double degrees) {var a=degrees*Math.PI/180;return new Point(c.X+r*Math.Cos(a),c.Y+r*Math.Sin(a));}
        var g=new StreamGeometry();
        using(var ctx=g.Open()) {ctx.BeginFigure(At(c,r,from),false,false);ctx.ArcTo(At(c,r,from+sweep),new Size(r,r),0,sweep>180,SweepDirection.Clockwise,true,false);}
        g.Freeze();return g;
    }
    protected override void OnRender(DrawingContext dc) {
        double s=Math.Min(ActualWidth,ActualHeight),cx=ActualWidth/2,cy=ActualHeight/2,t=Math.Clamp(Hidden,0,1),phase=Phase;
        if(s<=0) return;
        dc.DrawRectangle(Brushes.Transparent,null,new Rect(cx-s/2,cy-s/2,s,s));
        var accent=Look.AccentColor;var text=((SolidColorBrush)Look.Text).Color;var secondary=((SolidColorBrush)Look.Secondary).Color;
        var failed=state==LinkState.Failed;
        // The sphere: bright and breathing while visible, dim and still after a failure, nearly dark once hidden.
        dc.PushTransform(new TranslateTransform(cx-s/2,cy-s/2));
        dc.PushOpacity((failed?0.42:0.82+0.18*phase)*(1-t)+0.1*t);
        dc.DrawDrawing(Sphere(s));
        dc.Pop();dc.Pop();
        dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(text,0.07*(1-t))),1),new Point(cx,cy),s/2-1,s/2-1);
        if(invite.Length>0&&t<1) {
            var ink=failed?Alpha(text,0.7*(1-t)):Alpha(accent,(1-t)*(0.75+0.25*phase));
            var label=Label(invite,Math.Max(13,0.05*s),new SolidColorBrush(ink),false,0.8*s);
            dc.DrawText(label,new Point(cx-label.Width/2,cy-label.Height/2));
        }
        if(t<=0) return;
        double rr=0.375*s;var c=new Point(cx,cy);
        // One clock for the loops; with animations off every loop rests on its first frame.
        var time=SystemParameters.ClientAreaAnimation?clock.Elapsed.TotalSeconds:0;
        var small=false;var middle=centre;
        switch(state) {
            case LinkState.Connecting: {
                // A faint track and an arc of light that circles it (1.4 s a turn), its tail fading.
                dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,0.16*t)),1),c,rr,rr);
                var head=time==0?90:time/1.4%1*360;
                for(var i=0;i<24;i++) dc.DrawGeometry(null,new Pen(new SolidColorBrush(Alpha(accent,t*(1-i/24.0))),i<2?2:1.5),Arc(c,rr,head-90-(i+1)*3,3.2));
                small=true;break;
            }
            case LinkState.Switching: {
                // One segment per line; the one being tried blinks and moves on every 0.6 s, the ones before it are dimmed.
                int n=Math.Max(lines,2),current=time==0?0:(int)(time/0.6)%n;
                var blink=time==0?1:0.45+0.55*Math.Abs(Math.Sin(time*Math.PI));
                for(var i=0;i<n;i++) {
                    double start=360.0*i/n-90+4.5,sweep=360.0/n-9;
                    if(i<current) dc.DrawGeometry(null,new Pen(new SolidColorBrush(Alpha(((SolidColorBrush)Look.Fair).Color,0.6*t)),1.5),Arc(c,rr,start,sweep));
                    else if(i==current) {
                        dc.DrawGeometry(null,new Pen(new SolidColorBrush(Alpha(accent,0.18*blink*t)),7),Arc(c,rr,start,sweep));
                        dc.DrawGeometry(null,new Pen(new SolidColorBrush(Alpha(accent,blink*t)),2),Arc(c,rr,start,sweep));
                    } else dc.DrawGeometry(null,new Pen(new SolidColorBrush(Alpha(accent,0.16*t)),1),Arc(c,rr,start,sweep));
                }
                middle=L10n.Text("switching_centre",current+1,n);
                small=true;break;
            }
            case LinkState.Reconnecting or LinkState.Waiting: {
                // A ring of dim square dots: reconnecting, a bright dot with a tail goes round (4 s a turn); offline, it rests.
                const int n=64;var head=state==LinkState.Reconnecting&&time>0?(int)(time/4%1*n):-99;
                for(var i=0;i<n;i++) {
                    var gap=(head-i+n)%n;
                    var a=state==LinkState.Waiting?0.2:0.28;
                    if(head>=0&&gap<8) a=Math.Max(a,1-gap/8.0);
                    var angle=(360.0*i/n-90)*Math.PI/180;
                    dc.DrawRectangle(new SolidColorBrush(Alpha(accent,a*t)),null,new Rect(cx+rr*Math.Cos(angle)-1.3,cy+rr*Math.Sin(angle)-1.3,2.6,2.6));
                }
                break;
            }
            default: {
                // The ring that takes the sphere's place, with a soft glow.
                var glow=(0.82+0.18*phase)*t;
                dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,0.11*glow)),8),c,rr,rr);
                dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,0.22*glow)),3),c,rr,rr);
                dc.DrawEllipse(null,new Pen(new SolidColorBrush(Alpha(accent,glow)),1),c,rr,rr);
                break;
            }
        }
        // Inside: the time hidden (or the countdown) and the rates under it; while connecting, one short line.
        if(middle.Length>0) {
            var label=Label(middle,(small?0.044:0.072)*s,new SolidColorBrush(Alpha(small?secondary:text,t)),true,0.62*s);
            dc.DrawText(label,new Point(cx-label.Width/2,small?cy-label.Height/2:cy-label.Height+0.01*s));
        }
        if(sub.Length>0&&!small) {
            var rates=Label(sub,Math.Max(10,0.036*s),new SolidColorBrush(Alpha(secondary,t)),true,0.62*s);
            dc.DrawText(rates,new Point(cx-rates.Width/2,cy+0.03*s));
        }
    }
}
