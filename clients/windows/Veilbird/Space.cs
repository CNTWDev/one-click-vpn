using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
namespace Veilbird;

/// The faint star field behind the window, same recipe as the Portal (portal-web/src/space.tsx) and the other
/// clients: the flat ground, a pixel Milky Way on a slant, far stars that drift very slowly and a few cross glints,
/// all at about half strength. No nebula, planet or moon, so the app stays flat like the Console. Stars are
/// seeded, so the sky is the same on every launch. Redrawn twice a second at most; still when animations are off.
public sealed class Space:FrameworkElement {
    private sealed record Star(double X,double Y,double Size,Brush Fill,Brush Dim,bool Twinkle,double Delay);
    private readonly DispatcherTimer timer=new() {Interval=TimeSpan.FromMilliseconds(500)};
    private readonly DateTime started=DateTime.UtcNow;
    private Size laidOut;
    private List<Star> band=[],far=[];
    private const double Strength=0.55;
    private static readonly Color White=Color.FromRgb(232,236,244),Mint=Color.FromRgb(191,203,230),Pale=Color.FromRgb(214,240,170),Lime=Color.FromRgb(198,242,110);

    public Space() {
        IsHitTestVisible=false;Focusable=false;
        timer.Tick+=(_,_)=>{if(IsVisible && SystemParameters.ClientAreaAnimation) InvalidateVisual();};
        Loaded+=(_,_)=>timer.Start();Unloaded+=(_,_)=>timer.Stop();
    }

    private static Brush Solid(Color color,double alpha) {var brush=new SolidColorBrush(Color.FromArgb((byte)Math.Clamp(alpha*255,0,255),color.R,color.G,color.B));brush.Freeze();return brush;}
    private static Func<double> Seeded(int seed) {
        var a=seed;
        return ()=>{
            unchecked {
                a+=0x6D2B79F5;
                var t=(a^(int)((uint)a>>15))*(1|a);
                t=(t+((t^(int)((uint)t>>7))*(61|t)))^t;
                return (uint)(t^(int)((uint)t>>14))/4294967296.0;
            }
        };
    }
    private void Layout(Size size) {
        laidOut=size;
        double W=size.Width,H=size.Height;
        var r=Seeded(11);double angle=-38*Math.PI/180,cx=W*0.5,cy=H*0.34;
        band=[];
        for(var i=0;i<260;i++) {
            var along=(r()-0.5)*1.6*W;
            var across=Math.Sqrt(-2*Math.Log(r()+1e-9))*Math.Cos(2*Math.PI*r())*0.07*W*(1-Math.Abs(along)/W*0.35);
            double x=cx+along*Math.Cos(angle)-across*Math.Sin(angle),y=cy+along*Math.Sin(angle)+across*Math.Cos(angle);
            double k=r(),alpha=0.12+r()*0.5;
            if(x>=0 && x<=W && y>=0 && y<=H) band.Add(new Star(x,y,k<0.8 ? 1:2,Solid(k<0.5 ? Mint:k<0.85 ? White:Lime,alpha),Brushes.Transparent,false,0));
        }
        var f=Seeded(7);
        far=[];
        for(var i=0;i<110;i++) {
            var k=f();double size2=k<0.72 ? 1:k<0.97 ? 2:3;
            double x=f()*W,y=Math.Pow(f(),1.25)*H;
            var alpha=size2==3 ? 0.85:0.14+f()*0.5;
            var color=size2==3 ? Lime:f()<0.12 ? Pale:White;
            far.Add(new Star(x,y,size2,Solid(color,alpha),Solid(color,alpha*0.2),f()<0.14,f()*7));
        }
    }

    protected override void OnRender(DrawingContext dc) {
        var size=RenderSize;
        if(size.Width<=0 || size.Height<=0) return;
        if(size!=laidOut) Layout(size);
        double W=size.Width,H=size.Height;
        var motion=SystemParameters.ClientAreaAnimation;
        var time=(DateTime.UtcNow-started).TotalSeconds;
        var full=new Rect(size);
        dc.PushClip(new RectangleGeometry(full));
        dc.DrawRectangle(Look.Ground,null,full);
        dc.PushOpacity(Strength);

        foreach(var s in band) dc.DrawRectangle(s.Fill,null,new Rect(s.X,s.Y,s.Size,s.Size));
        // Far stars drift 30 px down and back over four minutes.
        var drift=motion ? (1-Math.Cos(time/120*Math.PI))/2*30-30:-30;
        foreach(var s in far) {
            var dim=motion && s.Twinkle && (time+s.Delay)%7>6.58;
            dc.DrawRectangle(dim ? s.Dim:s.Fill,null,new Rect(s.X,s.Y+drift,s.Size,s.Size));
        }
        var glints=new[]{(0.18,0.12,0.9),(0.84,0.38,0.7),(0.09,0.58,0.6)};
        for(var i=0;i<glints.Length;i++) {
            var (gx,gy,ga)=glints[i];
            var dim=motion && (time+i*2.3)%9>8.46;
            var fill=Solid(Color.FromRgb(230,236,248),ga*(dim ? 0.2:1));
            double x=W*gx,y=H*gy;
            dc.DrawRectangle(fill,null,new Rect(x-0.5,y-3.5,1,7));dc.DrawRectangle(fill,null,new Rect(x-3.5,y-0.5,7,1));dc.DrawRectangle(fill,null,new Rect(x-1.5,y-1.5,3,3));
        }
        dc.Pop();
        dc.Pop();
    }
}
