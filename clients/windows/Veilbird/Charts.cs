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

/// 30 days of usage as columns of square blocks; the chosen range (the last Recent days) in amber.
public sealed class UsageBlocks:FrameworkElement {
    private static Brush Older=>Look.Past;
    private readonly IReadOnlyList<long> values;
    private int recent=7;
    public int Recent {get=>recent;set {recent=value;InvalidateVisual();}}
    public UsageBlocks(IReadOnlyList<long> values) {this.values=values;IsHitTestVisible=false;}
    protected override void OnRender(DrawingContext dc) {
        if(values.Count==0) return;
        double gap=3,width=(ActualWidth-gap*(values.Count-1))/values.Count,block=4,pitch=6;
        var rows=Math.Max(1,(int)((ActualHeight+pitch-block)/pitch));var top=Math.Max(values.Max(),1);
        for(var i=0;i<values.Count;i++) {
            var lit=values[i]<=0?1:Math.Max(1,(int)Math.Round((double)rows*values[i]/top));
            var brush=i>=values.Count-recent?Look.Accent:Older;
            for(var r=0;r<lit;r++) dc.DrawRectangle(brush,null,new Rect(i*(width+gap),ActualHeight-r*pitch-block,Math.Max(1,width),block));
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
