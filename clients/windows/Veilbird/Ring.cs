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

/// The connect button: a ring of square dots around the ∅ mark, over a faint halftone glow. Dim when idle,
/// a comet of lit dots turning while connecting (held still when Windows animations are off), every dot lit
/// once connected, and a dark ring with the mark in red after a failure.
public sealed class Ring:FrameworkElement {
    private static readonly (int X,int Y,double Turn)[] Cells=Look.RingCells(41,18);
    private static readonly Brush IdleDot=Look.Hex("#243026"),FailedDot=Look.Hex("#2B2420");
    // The comet's fade, in 32 steps, so a frame allocates nothing.
    private static readonly Brush[] Comet=Enumerable.Range(0,33).Select(i=>{var brush=new SolidColorBrush(Color.FromRgb(183,220,104)) {Opacity=i/32.0};brush.Freeze();return (Brush)brush;}).ToArray();
    private readonly Stopwatch clock=Stopwatch.StartNew();
    private RingState state=RingState.Idle;
    private bool turning;
    private Drawing? glow;
    private double glowSide;
    public FrameworkElement View=>this;
    public Ring(double size=208) {
        Width=Height=size;
        Unloaded+=(_,_)=>Turn(false);
        Loaded+=(_,_)=>Turn(state==RingState.Connecting&&animate);
    }
    private bool animate;
    public void Set(RingState next,bool motion) {
        if(state==next&&animate==motion) return;
        if(state!=next) glow=null;
        state=next;animate=motion;
        Turn(next==RingState.Connecting&&motion&&IsLoaded);
        InvalidateVisual();
    }
    private void Turn(bool on) {
        if(on==turning) return;
        turning=on;
        if(on) CompositionTarget.Rendering+=OnFrame;else CompositionTarget.Rendering-=OnFrame;
    }
    private void OnFrame(object? sender,EventArgs e)=>InvalidateVisual();
    protected override void OnRender(DrawingContext dc) {
        double width=ActualWidth,height=ActualHeight,side=Math.Min(width,height),left=(width-side)/2,top=(height-side)/2;
        dc.DrawRectangle(Brushes.Transparent,null,new Rect(0,0,width,height));
        if(glow is null||glowSide!=side) {glow=Glow(side);glowSide=side;}
        if(glow is not null) {dc.PushTransform(new TranslateTransform(left,top));dc.DrawDrawing(glow);dc.Pop();}
        var cell=side/41;var square=cell*0.83;
        double? head=turning?clock.Elapsed.TotalSeconds%1.6/1.6:null;
        foreach(var (x,y,turn) in Cells) {
            var brush=state switch {
                RingState.Idle=>IdleDot,RingState.Failed=>FailedDot,RingState.Connected=>Look.Accent,
                // A comet: full at its head, fading over the next 38% of the turn.
                _=>head is { } h?Comet[(int)Math.Round(32*Tail((h-turn+1)%1))]:Comet[16],
            };
            dc.DrawRectangle(brush,null,new Rect(left+x*cell,top+y*cell,square,square));
        }
        var mark=side*80/246;
        dc.PushTransform(new TranslateTransform(width/2-mark/2,height/2-mark/2));dc.PushTransform(new ScaleTransform(mark/16,mark/16));
        dc.DrawGeometry(state switch {RingState.Idle=>Look.Faint,RingState.Failed=>Look.Danger,_=>Look.Accent},null,Look.MarkShape);
        dc.Pop();dc.Pop();
    }
    private static double Tail(double behind)=>behind<0.38?1-0.88*behind/0.38:0.12;
    /// Halftone dots that fade out from the centre; brighter the further the connection has come.
    private Drawing? Glow(double side) {
        var strength=state switch {RingState.Idle=>0.06,RingState.Connecting=>0.13,RingState.Connected=>0.22,_=>0.0};
        if(strength<=0||side<=0) return null;
        var group=new DrawingGroup();
        using(var draw=group.Open()) {
            double step=6,center=side/2,reach=side*0.62;
            for(var y=center%step;y<side;y+=step) for(var x=center%step;x<side;x+=step) {
                var fade=1-Math.Sqrt((x-center)*(x-center)+(y-center)*(y-center))/reach;
                if(fade<=0) continue;
                var brush=new SolidColorBrush(Color.FromRgb(183,220,104)) {Opacity=strength*Math.Min(1,fade*1.6)};brush.Freeze();
                draw.DrawEllipse(brush,null,new Point(x,y),0.9,0.9);
            }
        }
        group.Freeze();return group;
    }
}

/// 30 days of usage as columns of square blocks; the last seven days in lime.
public sealed class UsageBlocks:FrameworkElement {
    private static readonly Brush Older=Look.Hex("#5E7550");
    private readonly IReadOnlyList<long> values;
    public UsageBlocks(IReadOnlyList<long> values) {this.values=values;IsHitTestVisible=false;}
    protected override void OnRender(DrawingContext dc) {
        if(values.Count==0) return;
        double gap=3,width=(ActualWidth-gap*(values.Count-1))/values.Count,block=4,pitch=6;
        var rows=Math.Max(1,(int)((ActualHeight+pitch-block)/pitch));var top=Math.Max(values.Max(),1);
        for(var i=0;i<values.Count;i++) {
            var lit=values[i]<=0?1:Math.Max(1,(int)Math.Round((double)rows*values[i]/top));
            var brush=i>=values.Count-7?Look.Accent:Older;
            for(var r=0;r<lit;r++) dc.DrawRectangle(brush,null,new Rect(i*(width+gap),ActualHeight-r*pitch-block,Math.Max(1,width),block));
        }
    }
}
