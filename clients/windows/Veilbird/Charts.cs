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

/// Traffic per day on the usage page: one rounded bar per day, the picked day lit in amber and the others dim.
/// A click (or drag) picks the day under the pointer.
public sealed class DayBars:FrameworkElement {
    private readonly IReadOnlyList<long> values;
    private int picked;
    public event Action<int>? Picked;
    public DayBars(IReadOnlyList<long> values,int picked) {
        this.values=values;this.picked=picked;Cursor=Cursors.Hand;
        MouseLeftButtonDown+=(_,e)=>{CaptureMouse();Pick(e.GetPosition(this).X);};
        MouseMove+=(_,e)=>{if(IsMouseCaptured) Pick(e.GetPosition(this).X);};
        MouseLeftButtonUp+=(_,_)=>ReleaseMouseCapture();
    }
    private void Pick(double x) {
        if(values.Count==0||ActualWidth<=0) return;
        var index=Math.Clamp((int)(x/ActualWidth*values.Count),0,values.Count-1);
        if(index==picked) return;
        picked=index;InvalidateVisual();Picked?.Invoke(index);
    }
    protected override void OnRender(DrawingContext dc) {
        // Hit testing needs a background across the whole area, not only the bars.
        dc.DrawRectangle(Brushes.Transparent,null,new Rect(0,0,ActualWidth,ActualHeight));
        if(values.Count==0) return;
        double pitch=ActualWidth/values.Count,gap=Math.Min(3,pitch*0.35),radius=Math.Min(2,(pitch-gap)/2);
        var top=Math.Max(values.Max(),1);
        for(var i=0;i<values.Count;i++) {
            var height=Math.Max(3,ActualHeight*values[i]/top);
            var brush=i==picked?Look.Accent:values[i]<=0?Look.Raised:Look.Past;
            dc.DrawRoundedRectangle(brush,null,new Rect(i*pitch+gap/2,ActualHeight-height,Math.Max(1,pitch-gap),height),radius,radius);
        }
    }
}

/// The last 40 samples of the connection: download as columns of square dots rising from a hairline, upload as
/// dimmer columns hanging below it. Both scale to the busiest sample shown, so the shape stays readable at any speed.
public sealed class RateBars:FrameworkElement {
    public const int Count=40;
    private static Brush Up=>Look.Past;
    private static readonly Brush Axis=Look.Hex("#2C2924");
    private IReadOnlyList<long> down=Array.Empty<long>(),up=Array.Empty<long>();
    public RateBars() {IsHitTestVisible=false;}
    public void Set(IReadOnlyList<long> down,IReadOnlyList<long> up) {this.down=down;this.up=up;InvalidateVisual();}
    protected override void OnRender(DrawingContext dc) {
        double block=4,pitch=6,pitchX=ActualWidth/Count,w=Math.Min(block,pitchX-1),axis=Math.Round(ActualHeight*0.64);
        var topRows=Math.Max(1,(int)((axis-2+pitch-block)/pitch));var bottomRows=Math.Max(1,(int)((ActualHeight-axis-2+pitch-block)/pitch));
        dc.DrawRectangle(Axis,null,new Rect(0,axis,ActualWidth,1));
        var max=Math.Max(1,down.Concat(up).DefaultIfEmpty(1).Max());
        // Newest on the right; an empty start before the first samples.
        var offset=Count-down.Count;
        for(var i=0;i<down.Count;i++) {
            var left=Math.Round((offset+i)*pitchX+(pitchX-w)/2);
            var lit=down[i]<=0?1:Math.Max(1,(int)Math.Round((double)topRows*down[i]/max));
            for(var r=0;r<lit;r++) dc.DrawRectangle(Look.Accent,null,new Rect(left,axis-2-r*pitch-block,w,block));
            var value=i<up.Count?up[i]:0;
            var litUp=value<=0?0:Math.Max(1,(int)Math.Round((double)bottomRows*value/max));
            for(var r=0;r<litUp;r++) dc.DrawRectangle(Up,null,new Rect(left,axis+3+r*pitch,w,block));
        }
    }
}
