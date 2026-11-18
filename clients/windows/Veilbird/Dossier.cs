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
    private static readonly Brush DotBrush=MakeDots();
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
        var dot=new GeometryDrawing(new SolidColorBrush(Color.FromArgb(97,255,214,160)),null,new EllipseGeometry(new Point(2,2),0.85,0.85));
        var brush=new DrawingBrush(new DrawingGroup {Children={new GeometryDrawing(Brushes.Transparent,null,new RectangleGeometry(new Rect(0,0,4,4))),dot}}) {
            TileMode=TileMode.Tile,Viewport=new Rect(0,0,4,4),ViewportUnits=BrushMappingMode.Absolute,Viewbox=new Rect(0,0,4,4),ViewboxUnits=BrushMappingMode.Absolute};
        brush.Freeze();return brush;
    }
}

/// The connect moment's light: a thin amber line with a soft trail that sweeps down the file when it is sealed and
/// back up when it is opened. Invisible at rest.
public sealed class ScanLine:Canvas {
    private readonly Rectangle trail=new() {Height=70},glow=new() {Height=6,Fill=new SolidColorBrush(Color.FromArgb(60,224,164,88))},line=new() {Height=1,Fill=Look.Accent};
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
        var h=ActualHeight;
        trail.Fill=new LinearGradientBrush(Color.FromArgb(0,224,164,88),Color.FromArgb(28,224,164,88),down?90:270);
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
