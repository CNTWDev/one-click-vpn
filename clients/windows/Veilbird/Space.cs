using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
namespace Veilbird;

/// Behind the window, same as the Portal (portal-web/src/space.tsx) and the other clients: the warm ground, one soft
/// lamp from above and four crop marks at the corners, as if each page were a sheet in a file. The lamp is "being
/// seen": it fades out while connected (Lit false) and comes back when the connection ends.
public sealed class Space:FrameworkElement {
    public static readonly DependencyProperty LampProperty=DependencyProperty.Register(nameof(Lamp),typeof(double),typeof(Space),
        new FrameworkPropertyMetadata(1.0,FrameworkPropertyMetadataOptions.AffectsRender));
    /// 1 = lamp on, 0 = off; animated by Lit.
    public double Lamp {get=>(double)GetValue(LampProperty);set=>SetValue(LampProperty,value);}
    private bool lit=true;
    public bool Lit {
        get=>lit;
        set {
            if(lit==value) return;
            lit=value;
            var target=value?1.0:0.0;
            if(!SystemParameters.ClientAreaAnimation||!IsVisible) {BeginAnimation(LampProperty,null);Lamp=target;return;}
            BeginAnimation(LampProperty,new DoubleAnimation(target,TimeSpan.FromMilliseconds(1600)) {EasingFunction=new CubicEase {EasingMode=EasingMode.EaseOut}});
        }
    }
    private static Color Light=>Look.LightColor;

    public Space() {IsHitTestVisible=false;Focusable=false;}

    protected override void OnRender(DrawingContext dc) {
        var size=RenderSize;
        if(size.Width<=0||size.Height<=0) return;
        double W=size.Width,H=size.Height;
        dc.DrawRectangle(Look.Ground,null,new Rect(size));
        if(Lamp>0.01) {
            var lamp=new RadialGradientBrush {
                MappingMode=BrushMappingMode.Absolute,Center=new Point(W/2,-H*0.06),GradientOrigin=new Point(W/2,-H*0.06),
                RadiusX=Math.Max(W,H*0.6),RadiusY=Math.Max(W,H*0.6),
                GradientStops={new GradientStop(Color.FromArgb((byte)(41*Lamp),Light.R,Light.G,Light.B),0),new GradientStop(Color.FromArgb((byte)(10*Lamp),Light.R,Light.G,Light.B),0.5),new GradientStop(Color.FromArgb(0,Light.R,Light.G,Light.B),1)}};
            lamp.Freeze();
            dc.DrawRectangle(lamp,null,new Rect(0,0,W,H*0.7));
        }
    }
}
