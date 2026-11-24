using System.Globalization;
using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;

namespace Veilbird;

/// <summary>A place on the globe, with the name written beside it (may be empty).</summary>
public sealed record Spot(double Lat,double Lon,string Label="");

/// <summary>
/// The land and the sums of the route globe, the same on every client (Android Globe.kt, Apple Globe.swift) and the
/// Portal (portal-web/src/globe.ts): an orthographic view of the earth, great circles between two places, and the
/// halftone light of the old dot sphere.
/// </summary>
public static class Earth {
    private const double Rad=Math.PI/180;
    private static float[]? mask;
    /// <summary>360×180 soft land mask (one value per degree) from the 720×360 bits of LandMask.</summary>
    private static float[] Mask {get {
        if(mask is not null) return mask;
        var bits=Convert.FromBase64String(LandMask.Base64);
        int Bit(int i)=>(bits[i>>3]>>(i&7))&1;
        var m=new float[360*180];
        for(var y=0;y<180;y++) for(var x=0;x<360;x++) {
            var a=0;
            for(var dy=0;dy<2;dy++) for(var dx=0;dx<2;dx++) a+=Bit((2*y+dy)*720+2*x+dx);
            // Antarctica stays dark: it would only show as a smudge at the bottom of the globe.
            m[y*360+x]=y>=152?0:a/4f;
        }
        var o=new float[360*180];
        for(var y=0;y<180;y++) for(var x=0;x<360;x++) {
            float t=0;var n=0;
            for(var dy=-1;dy<=1;dy++) {var yy=y+dy;if(yy<0||yy>=180) continue;for(var dx=-1;dx<=1;dx++) {t+=m[yy*360+(x+dx+360)%360];n++;}}
            o[y*360+x]=t/n;
        }
        return mask=o;
    }}
    public static double Land(double lat,double lon) {
        var fx=lon+180-0.5;fx=((fx%360)+360)%360;
        var fy=Math.Min(179,Math.Max(0,90-lat-0.5));
        int x0=(int)fx,y0=(int)fy,x1=(x0+1)%360,y1=Math.Min(179,y0+1);
        double tx=fx-x0,ty=fy-y0;var m=Mask;
        return (m[y0*360+x0]*(1-tx)+m[y0*360+x1]*tx)*(1-ty)+(m[y1*360+x0]*(1-tx)+m[y1*360+x1]*tx)*ty;
    }
    /// <summary>The old sphere's halftone falloff from its light (upper left).</summary>
    public static double Light(double f)=>f<0.22?1-f/0.22*0.15:f<0.48?0.85-(f-0.22)/0.26*0.5:f<0.66?0.35-(f-0.48)/0.18*0.27:f<0.72?0.08-(f-0.66)/0.06*0.08:0;
    /// <summary>Unit-disk position (y up) and depth of a place lifted h radii above the ground, seen from above (vLat, vLon).</summary>
    public static (double X,double Y,double Z) Project(double lat,double lon,double h,double vLat,double vLon) {
        double p=lat*Rad,l=lon*Rad,p0=vLat*Rad,l0=vLon*Rad,c=Math.Cos(p),k=1+h;
        return (c*Math.Sin(l-l0)*k,(Math.Cos(p0)*Math.Sin(p)-Math.Sin(p0)*c*Math.Cos(l-l0))*k,Math.Sin(p0)*Math.Sin(p)+Math.Cos(p0)*c*Math.Cos(l-l0));
    }
    /// <summary>The place under a unit-disk point.</summary>
    public static (double Lat,double Lon) Unproject(double nx,double ny,double vLat,double vLon) {
        var r=Math.Sqrt(nx*nx+ny*ny);if(r<1e-9) return (vLat,vLon);
        double c=Math.Asin(Math.Min(1,r)),p0=vLat*Rad;
        var lat=Math.Asin(Math.Cos(c)*Math.Sin(p0)+ny*Math.Sin(c)*Math.Cos(p0)/r);
        var lon=vLon*Rad+Math.Atan2(nx*Math.Sin(c),r*Math.Cos(c)*Math.Cos(p0)-ny*Math.Sin(c)*Math.Sin(p0));
        return (lat/Rad,lon/Rad);
    }
    private static (double,double,double) Vec(double lat,double lon)=>(Math.Cos(lat*Rad)*Math.Sin(lon*Rad),Math.Sin(lat*Rad),Math.Cos(lat*Rad)*Math.Cos(lon*Rad));
    public static double Angle(double aLat,double aLon,double bLat,double bLon) {
        var a=Vec(aLat,aLon);var b=Vec(bLat,bLon);
        return Math.Acos(Math.Clamp(a.Item1*b.Item1+a.Item2*b.Item2+a.Item3*b.Item3,-1,1));
    }
    /// <summary>The point a fraction t of the way along the great circle from a to b.</summary>
    public static (double Lat,double Lon) Slerp(double aLat,double aLon,double bLat,double bLon,double t) {
        var w=Angle(aLat,aLon,bLat,bLon);if(w<1e-6) return (aLat,aLon);
        var a=Vec(aLat,aLon);var b=Vec(bLat,bLon);double s=Math.Sin(w),k1=Math.Sin((1-t)*w)/s,k2=Math.Sin(t*w)/s;
        double x=a.Item1*k1+b.Item1*k2,y=a.Item2*k1+b.Item2*k2,z=a.Item3*k1+b.Item3*k2;
        return (Math.Asin(y/Math.Sqrt(x*x+y*y+z*z))/Rad,Math.Atan2(x,z)/Rad);
    }
    public static double Km(Spot a,Spot b)=>Angle(a.Lat,a.Lon,b.Lat,b.Lon)*6371;
    public static double Ease(double t)=>t<0.5?4*t*t*t:1-Math.Pow(-2*t+2,3)/2;
}

/// <summary>
/// The connect page's globe: the old dot sphere, now the earth. Off, it marks where this PC is (a light with a slow
/// ripple); connecting, it turns to show both ends and a light runs the arc to the location; connected, the arc stays
/// lit, the location glows, and the time hidden and the rates sit in its lower half. The globe is the backdrop and
/// stays dim; the route is the bright layer. A still globe is one cached drawing, rebuilt only while it turns
/// (1.2 s); small loops run at most 30 frames a second, only while the window is shown, and not at all with Windows
/// animations off. Same drawing on every client (Android Globe.kt, Apple Globe.swift) and the Portal.
/// </summary>
public sealed class Portrait:FrameworkElement {
    private string invite="",centre="",sub="",distance="";
    public string Invite {get=>invite;set {if(invite!=value) {invite=value;InvalidateVisual();}}}
    /// <summary>In the lower half: the time hidden (or the countdown, or the phase), and the rates under it.</summary>
    public string Centre {get=>centre;set {if(centre!=value) {centre=value;InvalidateVisual();}}}
    public string Sub {get=>sub;set {if(sub!=value) {sub=value;InvalidateVisual();}}}
    /// <summary>Under the location's name, e.g. "1 760 km"; empty without an origin.</summary>
    public string Distance {get=>distance;set {if(distance!=value) {distance=value;InvalidateVisual();}}}
    private LinkState state=LinkState.Idle;private int lines=2;
    public LinkState State {get=>state;set {if(state!=value) {state=value;stateAt=clock.Elapsed.TotalSeconds;Aim();Loop();InvalidateVisual();}}}
    public int Lines {get=>lines;set {if(lines!=value) {lines=value;InvalidateVisual();}}}
    private Spot? origin,exit;
    /// <summary>This PC (null: unknown, or left off by the person) and the location it goes out from (null: unknown).</summary>
    public Spot? Origin {get=>origin;set {if(origin!=value) {origin=value;Aim();Loop();InvalidateVisual();}}}
    public Spot? Exit {get=>exit;set {if(exit!=value) {exit=value;Aim();Loop();InvalidateVisual();}}}

    private readonly DispatcherTimer frames=new() {Interval=TimeSpan.FromMilliseconds(33)};
    private readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
    private double stateAt;private bool moving,resting,aimed;
    private double viewLat=20,viewLon=105,fromLat,fromLon,toLat,toLon,turnAt=-1;
    private DrawingGroup? dots;private string dotsKey="";
    private readonly Dictionary<int,Brush> lightBrushes=new();private Color lightBrushesColor;

    public Portrait() {
        Cursor=System.Windows.Input.Cursors.Hand;Focusable=true;
        frames.Tick+=(_,_)=>{InvalidateVisual();Loop();};
        // Draws only while it can be seen: the window closed to the tray (hidden, not unloaded) or minimised would
        // otherwise keep redrawing every frame.
        IsVisibleChanged+=(_,_)=>Loop();Unloaded+=(_,_)=>frames.Stop();
    }
    /// <summary>Set while the window is minimised: still "visible" to WPF, but nobody sees it.</summary>
    public bool Resting {set {if(resting!=value) {resting=value;Loop();}}}
    private static bool Animations=>SystemParameters.ClientAreaAnimation;
    private bool On=>state is not (LinkState.Idle or LinkState.Failed);
    private bool Turning=>turnAt>=0&&clock.Elapsed.TotalSeconds-turnAt<(On?1.2:0.8);
    private void Loop() {
        var loops=Animations&&(state==LinkState.Idle&&origin is not null||state is LinkState.Connecting or LinkState.Switching or LinkState.Connected or LinkState.Reconnecting);
        if((loops||Turning)&&IsVisible&&!resting) {if(!frames.IsEnabled) frames.Start();} else frames.Stop();
    }
    /// <summary>Connecting or disconnecting; [moving] turns the globe (1.2 s) instead of jumping.</summary>
    public void Set(bool hidden,bool moving) {this.moving=moving;Aim();Loop();InvalidateVisual();}
    /// <summary>Where the globe should face: this PC when off, both ends (the route in the upper half) when on.</summary>
    private void Aim() {
        double lat,lon;
        if(On&&exit is { } b&&origin is { } a) {
            var m=Earth.Slerp(a.Lat,a.Lon,b.Lat,b.Lon,0.5);var w=Earth.Angle(a.Lat,a.Lon,b.Lat,b.Lon)*180/Math.PI;
            lat=m.Lat-8-w*0.12;lon=m.Lon;
        } else if(On&&exit is { } only) {lat=only.Lat-12;lon=only.Lon-22;}
        else if(origin is { } here) {lat=here.Lat-14;lon=here.Lon;}
        else if(exit is { } there) {lat=there.Lat-14;lon=there.Lon;}
        else return;
        lat=Math.Clamp(lat,-55,55);
        if(!aimed||!moving||!Animations) {viewLat=lat;viewLon=lon;aimed=true;turnAt=-1;return;}
        Current();
        fromLat=viewLat;fromLon=viewLon;
        var dl=lon-viewLon;dl=((dl+540)%360)-180;
        toLat=lat;toLon=viewLon+dl;turnAt=clock.Elapsed.TotalSeconds;
    }
    private void Current() {
        if(turnAt<0) return;
        var k=Math.Min(1,(clock.Elapsed.TotalSeconds-turnAt)/(On?1.2:0.8));var e=Earth.Ease(k);
        viewLat=fromLat+(toLat-fromLat)*e;viewLon=fromLon+(toLon-fromLon)*e;
        if(k>=1) turnAt=-1;
    }
    protected override Size MeasureOverride(Size available)=>new(double.IsInfinity(available.Width)?0:available.Width,double.IsNaN(Height)?220:Height);
    private static Color Alpha(Color c,double a)=>Color.FromArgb((byte)Math.Clamp(a*255,0,255),c.R,c.G,c.B);
    private static Brush Ink(Color c,double a) {var brush=new SolidColorBrush(Alpha(c,a));brush.Freeze();return brush;}
    /// <summary>One frozen brush per step of light: the lattice reuses 64 of them instead of a new one per dot.</summary>
    private Brush LightBrush(double alpha) {
        var light=Look.LightColor;
        if(light!=lightBrushesColor) {lightBrushes.Clear();lightBrushesColor=light;}
        var step=(int)Math.Round(Math.Clamp(alpha,0,1)*63);
        if(!lightBrushes.TryGetValue(step,out var brush)) lightBrushes[step]=brush=Ink(light,step/63.0);
        return brush;
    }
    /// <summary>The earth as the old sphere's dot lattice: each dot looks up the land under it; built once per view and size.</summary>
    private DrawingGroup Sphere(double s) {
        var key=$"{s:0.#} {Math.Round(viewLat*100)} {Math.Round(viewLon*100)} {Look.LightColor}";
        if(dots is not null&&dotsKey==key) return dots;
        var group=new DrawingGroup();
        using(var dc=group.Open()) {
            double pitch=s*6/320,r=s*1.15/320,radius=s/2,lx=s*0.42,ly=s*0.34;
            dc.DrawRectangle(Brushes.Transparent,null,new Rect(0,0,s,s));
            for(var y=pitch/2;y<s;y+=pitch) for(var x=pitch/2;x<s;x+=pitch) {
                double nx=(x-radius)/radius,ny=(radius-y)/radius,dd=nx*nx+ny*ny;
                if(dd>1) continue;
                var z=Math.Sqrt(1-dd);var place=Earth.Unproject(nx,ny,viewLat,viewLon);var land=Earth.Land(place.Lat,place.Lon);
                var a=Earth.Light(Math.Sqrt((x-lx)*(x-lx)+(y-ly)*(y-ly))/(s*0.98));var limb=Math.Min(1,z/0.18);
                var al=(land*(0.3+0.5*a)+(1-land)*(0.025+0.08*a))*limb;
                if(al<0.02) continue;
                var rr=r*(0.72+0.32*land);
                dc.DrawEllipse(LightBrush(al),null,new Point(x,y),rr,rr);
            }
        }
        group.Freeze();
        dots=group;dotsKey=key;
        return group;
    }
    private FormattedText Label(string text,double size,Color ink,FontFamily family) {
        var face=new Typeface(family,FontStyles.Normal,FontWeights.Normal,FontStretches.Normal);
        return new FormattedText(text,L10n.Culture,FlowDirection.LeftToRight,face,size,Ink(ink,ink.A/255.0),VisualTreeHelper.GetDpi(this).PixelsPerDip);
    }
    private static readonly FontFamily Sans=new("Segoe UI"),Mono=new("Cascadia Mono, Consolas");
    private void Glow(DrawingContext dc,Point p,double r,Color color,double alpha) {
        if(r<=0) return;
        var brush=new RadialGradientBrush(Alpha(color,Math.Min(1,alpha)),Alpha(color,0));brush.Freeze();
        dc.DrawEllipse(brush,null,p,r,r);
    }
    private static void Square(DrawingContext dc,Point p,double side,Brush ink)=>dc.DrawRectangle(ink,null,new Rect(p.X-side/2,p.Y-side/2,side,side));
    /// <summary>Text kept inside the element; side 0 centres it, 1 ends it at x, -1 starts it at x; y is its middle.</summary>
    private void Put(DrawingContext dc,string text,double x,double y,Color color,double alpha,double size,FontFamily family,int side) {
        var label=Label(text,size,Alpha(color,alpha),family);
        var left=side==0?x-label.Width/2:side==1?x-label.Width:x;
        left=Math.Clamp(left,4,Math.Max(4,ActualWidth-label.Width-4));
        var top=Math.Clamp(y-label.Height/2,0,Math.Max(0,ActualHeight-label.Height));
        // A soft dark halo keeps names readable over the dots.
        var halo=Label(text,size,Alpha(((SolidColorBrush)Look.Ground).Color,0.85),family);
        foreach(var (dx,dy) in new[]{(-1.0,0.0),(1.0,0.0),(0.0,-1.0),(0.0,1.0)}) dc.DrawText(halo,new Point(left+dx,top+dy));
        dc.DrawText(label,new Point(left,top));
    }

    protected override void OnRender(DrawingContext dc) {
        double s=Math.Min(ActualWidth,ActualHeight),cx=ActualWidth/2,cy=ActualHeight/2;
        if(s<=0) return;
        dc.DrawRectangle(Brushes.Transparent,null,new Rect(0,0,ActualWidth,ActualHeight));
        Current();
        double radius=s/2,u=s/320,now=clock.Elapsed.TotalSeconds;
        var still=!Animations;
        double time=still?0:now,since=still?9:now-stateAt;
        var breath=0.5-0.5*Math.Cos(time/3*Math.PI*2);
        var connected=state==LinkState.Connected;var busy=state is LinkState.Connecting or LinkState.Switching;var lost=state is LinkState.Reconnecting or LinkState.Waiting;
        var dim=state==LinkState.Failed?0.42:lost?0.5:connected?0.55:busy?0.6:0.8+0.12*breath;
        var accent=Look.AccentColor;var light=Look.LightColor;var text=((SolidColorBrush)Look.Text).Color;var secondary=((SolidColorBrush)Look.Secondary).Color;var fair=((SolidColorBrush)Look.Fair).Color;
        dc.PushTransform(new TranslateTransform(cx-radius,cy-radius));
        dc.PushOpacity(dim);
        dc.DrawDrawing(Sphere(s));
        dc.Pop();dc.Pop();
        // A faint rim of light just outside the globe.
        var rim=new RadialGradientBrush {GradientOrigin=new Point(0.5,0.5),Center=new Point(0.5,0.5),RadiusX=0.5,RadiusY=0.5};
        rim.GradientStops.Add(new GradientStop(Alpha(light,0),0));rim.GradientStops.Add(new GradientStop(Alpha(light,0),0.916));
        rim.GradientStops.Add(new GradientStop(Alpha(light,0.045*dim),0.918));rim.GradientStops.Add(new GradientStop(Alpha(light,0),1));rim.Freeze();
        dc.DrawEllipse(rim,null,new Point(cx,cy),radius*1.09,radius*1.09);

        (double X,double Y,bool Shown) Screen((double X,double Y,double Z) p)=>(cx+p.X*radius,cy-p.Y*radius,p.Z>0||Math.Sqrt(p.X*p.X+p.Y*p.Y)>1);
        var a=origin;var b=exit;
        (double X,double Y,bool Shown)? bs=b is null?null:Screen(Earth.Project(b.Lat,b.Lon,0,viewLat,viewLon));
        (double X,double Y,bool Shown)? aScreen=a is null?null:Screen(Earth.Project(a.Lat,a.Lon,0,viewLat,viewLon));

        // The route: a dotted great circle lifted off the ground, with a soft glow under its lit part.
        if(On&&b is not null) {
            var start=a is not null?(a.Lat,a.Lon):Earth.Unproject(-0.97,-0.05,viewLat,viewLon);
            var w=Earth.Angle(start.Item1,start.Item2,b.Lat,b.Lon);
            var lift=Math.Max(0.07,0.09+0.3*w/Math.PI);
            var pts=new (double X,double Y,bool Shown,double T)[97];
            for(var attempt=0;attempt<4;attempt++) {
                var far=0.0;
                for(var i=0;i<=96;i++) {
                    var t=i/96.0;var g=Earth.Slerp(start.Item1,start.Item2,b.Lat,b.Lon,t);
                    var p=Earth.Project(g.Lat,g.Lon,lift*Math.Sin(Math.PI*t),viewLat,viewLon);
                    var q=Screen(p);pts[i]=(q.X,q.Y,q.Shown,t);far=Math.Max(far,Math.Sqrt(p.X*p.X+p.Y*p.Y));
                }
                if(far<1.03||lift<0.04) break;
                lift*=0.7;
            }
            var charge=connected?(still?1:Math.Min(1,since/0.7)):1;
            if(connected||busy) foreach(var (width,alpha) in new[]{(10*u,connected?0.10:0.05),(4*u,connected?0.22:0.08)}) {
                var geometry=new StreamGeometry();
                using(var ctx=geometry.Open()) {
                    var open=false;
                    foreach(var q in pts) {
                        if(q.T>charge||!q.Shown) {open=false;continue;}
                        if(!open) {ctx.BeginFigure(new Point(q.X,q.Y),false,false);open=true;} else ctx.LineTo(new Point(q.X,q.Y),true,true);
                    }
                }
                geometry.Freeze();
                var pen=new Pen(Ink(accent,alpha),width) {StartLineCap=PenLineCap.Round,EndLineCap=PenLineCap.Round,LineJoin=PenLineJoin.Round};pen.Freeze();
                dc.DrawGeometry(null,pen,geometry);
            }
            var head=busy?since/1.4%1:state==LinkState.Reconnecting?since/4%1:connected?since/3%1:-1;
            var side=Math.Max(1.25,2.7*u);var gap=0.0;
            for(var i=1;i<=96;i++) {
                var q=pts[i];var p=pts[i-1];gap+=Math.Sqrt((q.X-p.X)*(q.X-p.X)+(q.Y-p.Y)*(q.Y-p.Y));
                if(gap<6.4*u&&i!=1) continue;
                gap=0;
                if(!q.Shown) continue;
                var fade=a is not null?1:Math.Min(1,q.T/0.35);double al;
                if(connected) {al=q.T<=charge?1:0.3;var g=head-q.T;if(!still&&since>0.7&&g>=0&&g<0.14) al=Math.Max(al,1-g/0.14*0.2);}
                else if(busy) {al=0.3;var g=((head-q.T)%1+1)%1;if(!still&&g<0.28) al=Math.Max(al,1-g/0.28);if(still) al=q.T<0.55?0.9:0.3;}
                else if(state==LinkState.Reconnecting) {al=0.2;var g=((head-q.T)%1+1)%1;if(!still&&g<0.12) al=Math.Max(al,1-g/0.12);}
                else al=0.16;
                al*=fade;
                Square(dc,new Point(q.X,q.Y),side,Ink(al>0.95?light:accent,Math.Min(1,al)));
            }
            // A soft light at the head: the runner while connecting, the flash crossing on landing, then one every 3 s.
            var at=still?-1:busy?head:connected?(since<0.7?since/0.7:head):-1;
            if(at>=0) {var q=pts[Math.Min(96,(int)Math.Round(at*96))];if(q.Shown) Glow(dc,new Point(q.X,q.Y),(busy?13:16)*u,light,connected&&since<0.7?0.9:0.7);}
        }
        // This PC: a light with a ripple while visible; a small white mark in a thin ring once hidden.
        if(aScreen is { Shown: true } here) {
            var p=new Point(here.X,here.Y);
            if(!On) {
                var k=state==LinkState.Failed?0.5:1;
                if(!still) for(var i=0;i<2;i++) {
                    var ph=(time/3+i*0.5)%1;
                    dc.DrawEllipse(null,new Pen(Ink(light,(1-ph)*0.65*k),Math.Max(1,u)),p,(5+24*ph)*u,(5+24*ph)*u);
                } else dc.DrawEllipse(null,new Pen(Ink(light,0.25*k),Math.Max(1,u)),p,14*u,14*u);
                Glow(dc,p,14*u,light,0.5*k);
                Square(dc,p,Math.Max(2.5,5*u),Ink(light,k));
            } else {
                dc.DrawEllipse(null,new Pen(Ink(text,0.35),Math.Max(1,u)),p,7*u,7*u);
                Square(dc,p,Math.Max(2.2,4.2*u),Ink(text,0.9));
            }
        }
        // The location: bright and glowing once connected, with two shock rings as it lands.
        if(bs is { Shown: true } there&&state!=LinkState.Idle) {
            var p=new Point(there.X,there.Y);
            if(state==LinkState.Failed) Square(dc,p,Math.Max(2.5,4.5*u),Ink(fair,0.9));
            else if(connected) {
                var flare=still||since<0.6?0:1-Math.Min(1,(since-0.6)/0.8);
                Glow(dc,p,(22+16*flare)*u,accent,0.4+0.15*breath+0.45*flare);
                if(!still&&since>0.6&&since<2.1) for(var i=0;i<2;i++) {
                    var k=(since-0.6-i*0.25)/1.2;if(k<=0||k>=1) continue;
                    var r=(6+64*Earth.Ease(k))*u;
                    dc.DrawEllipse(null,new Pen(Ink(accent,(1-k)*0.85),Math.Max(1,1.6*u*(1-k)+0.6)),p,r,r);
                }
                Square(dc,p,Math.Max(3.5,7*u),Ink(light,1));
            } else {
                var blink=busy&&!still?0.45+0.55*Math.Abs(Math.Sin(time*Math.PI*(state==LinkState.Switching?1.6:1))):lost?0.4:0.8;
                Square(dc,p,Math.Max(2.5,4.5*u),Ink(accent,blink));
            }
        }
        // Names: this PC's under its light while off; once on, both ends, each on the side away from the other.
        var fs=Math.Max(11,11.5*u);
        if(a is not null&&aScreen is { Shown: true } aa&&a.Label.Length>0) {
            if(!On) Put(dc,a.Label,aa.X,aa.Y+16*u+fs*0.6,light,state==LinkState.Failed?0.5:0.9,fs*1.08,Sans,0);
            else {var left=bs is null||aa.X<bs.Value.X;Put(dc,a.Label,aa.X+(left?-9:9)*u,aa.Y+fs*0.9,secondary,0.85,fs*1.08,Sans,left?1:-1);}
        }
        if((On||state==LinkState.Failed)&&b is not null&&bs is { Shown: true } bb&&b.Label.Length>0) {
            var left=aScreen is not null&&bb.X<aScreen.Value.X;var bx=bb.X+(left?-14:14)*u;var side=left?1:-1;
            Put(dc,b.Label,bx,bb.Y-fs*0.9,connected?accent:state==LinkState.Failed?fair:text,connected?1:0.8,fs*1.08,Sans,side);
            if(distance.Length>0&&(connected||busy)) Put(dc,distance,bx,bb.Y+fs*0.45,secondary,connected?0.85:0.55,fs,Mono,side);
        }
        // The lower half: the time hidden and the rates (connected), the countdown (reconnecting), or one short line.
        if(!On) return;
        var middle=centre;
        if(state==LinkState.Switching) {var n=Math.Max(lines,2);var current=still?0:(int)(time/0.6)%n;middle=L10n.Text("switching_centre",current+1,n);}
        var small=busy;
        if(middle.Length>0) {
            var size=small?Math.Max(11,0.044*s):Math.Max(16,0.072*s);
            var label=Label(middle,size,small?secondary:text,small?Mono:Look.Dots);
            if(label.Width>0.62*s) label=Label(middle,size*0.62*s/label.Width,small?secondary:text,small?Mono:Look.Dots);
            dc.DrawText(label,new Point(cx-label.Width/2,cy+radius*(small?0.47:0.42)-label.Height/2));
        }
        if(!small&&sub.Length>0) {
            var size=Math.Max(10,0.036*s);
            var rates=Label(sub,size,secondary,Mono);
            if(rates.Width>0.7*s) rates=Label(sub,size*0.7*s/rates.Width,secondary,Mono);
            dc.DrawText(rates,new Point(cx-rates.Width/2,cy+radius*0.42+Math.Max(16,0.072*s)*0.95-rates.Height/2));
        }
    }
}
