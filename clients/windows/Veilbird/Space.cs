using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
namespace Veilbird;

/// The deep-space backdrop behind the window, same recipe as the Portal (portal-web/src/space.tsx) and the other
/// clients: a near-black sky, a pixel Milky Way on a slant over a faint teal and lime nebula, far stars that drift
/// very slowly, a few cross glints, a dithered moon and a dark planet whose lit rim sits at the bottom. Stars are
/// seeded, so the sky is the same on every launch. Redrawn twice a second at most; still when animations are off.
public sealed class Space:FrameworkElement {
    private sealed record Star(double X,double Y,double Size,Brush Fill,Brush Dim,bool Twinkle,double Delay);
    private readonly DispatcherTimer timer=new() {Interval=TimeSpan.FromMilliseconds(500)};
    private readonly DateTime started=DateTime.UtcNow;
    private Size laidOut;
    private List<Star> band=[],far=[];
    private List<(Rect Rect,Brush Fill)> dots=[],moon=[];
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
    private static (double X,double Y,double R) Planet(Size size)=>(size.Width/2,size.Height-Math.Max(200,size.Height*0.26)+700,700);

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
        // Planet rim and lit surface as dots on a 6 px grid.
        var p=Planet(size);var top=p.Y-p.R;
        dots=[];
        for(var y=top-0.12*p.R;y<Math.Min(H,top+Math.Max(0.3*p.R,40));y+=6)
            for(var x=0.0;x<W;x+=6) {
                var dist=Math.Sqrt((x-p.X)*(x-p.X)+(y-p.Y)*(y-p.Y))/p.R;
                var rim=dist>=0.974 && dist<=1.12 ? (dist<1.04 ? (dist-0.974)/0.066:(1.12-dist)/0.08)*0.5*0.55:0;
                var e=Math.Pow((x-p.X)/p.R,2)+Math.Pow((y-top)/(0.28*p.R),2);
                var lit=dist<1 && e<1 ? (1-e)*0.5*0.2:0;
                if(rim+lit>0.01) dots.Add((new Rect(x,y,1.4,1.4),Solid(Lime,rim+lit)));
            }
        // Moon: a 22 px disc of 3 px dots, lit from the top left.
        double m=22,mx=W*0.76,my=H*0.09;
        moon=[];
        for(var row=0;row<7;row++) for(var col=0;col<7;col++) {
            double px=col*3,py=row*3;
            if(Math.Sqrt(Math.Pow(px+1.5-m/2,2)+Math.Pow(py+1.5-m/2,2))>m/2) continue;
            var t=Math.Min(1,Math.Sqrt(Math.Pow(px-m*0.32,2)+Math.Pow(py-m*0.30,2))/(m*0.75));
            var level=t<0.6 ? 0.79-(0.79-0.47)*t/0.6:0.47-(0.47-0.12)*(t-0.6)/0.4;
            moon.Add((new Rect(mx+px,my+py,2.2,2.2),Solid(Color.FromRgb((byte)(level*0.86*255),(byte)(level*0.9*255),(byte)(level*255)),0.7)));
        }
    }

    private static void Ellipse(DrawingContext dc,Point center,double rx,double ry,Color color,double alpha) {
        var brush=new RadialGradientBrush(new GradientStopCollection{new(Color.FromArgb((byte)(alpha*255),color.R,color.G,color.B),0),new(Color.FromArgb(0,color.R,color.G,color.B),0.7)});
        brush.Freeze();
        dc.DrawEllipse(brush,null,center,rx,ry);
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
        var sky=new LinearGradientBrush(new GradientStopCollection{new(Color.FromRgb(1,2,4),0),new(Color.FromRgb(3,5,10),0.5),new(Color.FromRgb(6,9,18),1)},90);
        sky.Freeze();dc.DrawRectangle(sky,null,full);

        // Nebula along the band.
        dc.PushTransform(new RotateTransform(-38,W*0.5,H*0.34));
        double bw=1.5*W,bh=0.6*H;
        Ellipse(dc,new Point(W*0.5-0.12*bw,H*0.34),0.30*bw,0.38*bh,Color.FromRgb(64,84,190),0.30);
        Ellipse(dc,new Point(W*0.5+0.12*bw,H*0.34-0.04*bh),0.22*bw,0.30*bh,Color.FromRgb(40,150,170),0.16);
        Ellipse(dc,new Point(W*0.5,H*0.34),0.50*bw,0.20*bh,Color.FromRgb(160,175,230),0.07);
        dc.Pop();

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
        foreach(var (rect,fill) in moon) dc.DrawRectangle(fill,null,rect);
        var vignette=new RadialGradientBrush(new GradientStopCollection{new(Colors.Transparent,0),new(Colors.Transparent,0.55),new(Color.FromArgb(153,0,0,0),1)}) {
            MappingMode=BrushMappingMode.Absolute,Center=new Point(W/2,H*0.42),GradientOrigin=new Point(W/2,H*0.42),RadiusX=Math.Sqrt(W*W+H*H)*0.6,RadiusY=Math.Sqrt(W*W+H*H)*0.6};
        vignette.Freeze();dc.DrawRectangle(vignette,null,full);

        // Planet: glow, body, rim line, then the dithered atmosphere and lit surface.
        var p=Planet(size);var top=p.Y-p.R;var glow=p.R+70;
        var halo=new RadialGradientBrush(new GradientStopCollection{new(Colors.Transparent,p.R/glow-0.01),new(Color.FromArgb(36,90,170,150),p.R/glow),new(Colors.Transparent,1)});
        halo.Freeze();dc.DrawEllipse(halo,null,new Point(p.X,p.Y),glow,glow);
        var body=new RadialGradientBrush(new GradientStopCollection{new(Color.FromRgb(18,26,42),0),new(Color.FromRgb(9,13,23),0.18),new(Color.FromRgb(3,5,10),0.45)}) {
            MappingMode=BrushMappingMode.Absolute,Center=new Point(p.X,top),GradientOrigin=new Point(p.X,top),RadiusX=2.24*p.R,RadiusY=2.24*p.R};
        body.Freeze();
        var rim=new Pen(Solid(Color.FromRgb(210,244,150),0.55),1);rim.Freeze();
        dc.DrawEllipse(body,rim,new Point(p.X,p.Y),p.R,p.R);
        foreach(var (rect,fill) in dots) dc.DrawRectangle(fill,null,rect);
        dc.Pop();
    }
}
