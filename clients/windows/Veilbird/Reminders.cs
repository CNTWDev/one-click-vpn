using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
namespace Veilbird;

/// The account's access as the server reports it: state, period end and traffic quota (all nodes together).
/// Running low means 10% of the traffic or 7 days left, as in the reminder mail (server/access-jobs.ts).
public sealed record AccountAccess(string State,string? UntilText,DateTimeOffset? Until,long? Quota,long Remaining) {
    public static AccountAccess From(JsonNode? account) {
        var access=account?["access"];
        var untilText=access?["until"]?.GetValue<string>();
        DateTimeOffset? until=untilText is not null&&DateTimeOffset.TryParse(untilText,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out var date)?date:null;
        long? quota=access?["quotaBytes"] is { } q&&long.TryParse(q.ToString(),out var total)?total:null;
        var remaining=long.TryParse(access?["remainingBytes"]?.ToString(),out var left)?left:0;
        return new(access?["state"]?.GetValue<string>()??"active",untilText,until,quota,remaining);
    }
    public bool Low=>State=="active"&&Quota is { } quota&&Remaining<=quota/10;
    public bool Ending=>State=="active"&&Until is { } until&&until-DateTimeOffset.UtcNow<=TimeSpan.FromDays(7);
    /// The small titles above the two figures: the usual ones, or the reminder in their place (nothing moves).
    public string TrafficTitle=>State=="exhausted"?"access_used_title":Low?"access_low_title":Quota is null?"last_30_days":"traffic_left";
    public string UntilTitle=>State=="expired"?"access_expired_title":Ending?"access_soon_title":"valid_until_label";
    /// One line for the tray tooltip, or null when nothing is running out.
    public string? Line(Func<long,string> bytes)=>Low?L10n.Text("reminder_low_line",bytes(Remaining)):Ending?L10n.Text("reminder_soon_line",L10n.Date(UntilText)):null;
}

/// Once-per-step reminders before the access runs out: 7 days before the end, 1 day before, and at 10% traffic
/// left. A step is remembered only while it still holds, so after renewing or adding traffic they start over.
public static class AccessReminders {
    /// The (title, text) to show now, or null; remembers it as shown.
    public static (string Title,string Text)? Due(AccountAccess access,Func<long,string> bytes) {
        var saved=Settings.Get("remindersSent").Split('\n',StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        var sent=saved.Where(key=>key.StartsWith("low:")?access.Low:access.Ending&&key.EndsWith(":"+access.UntilText)).ToHashSet();
        var due=new List<(string Title,string Text)>();
        if(access.Ending&&access.UntilText is { } end&&access.Until is { } until) {
            // Less than a day left when first seen: the 7-day step counts as done, one reminder is enough.
            var keys=until-DateTimeOffset.UtcNow<=TimeSpan.FromDays(1)?new[]{"end1:"+end,"end7:"+end}:new[]{"end7:"+end};
            if(!sent.Contains(keys[0])) {sent.UnionWith(keys);due.Add((L10n.Text("reminder_soon_title"),L10n.Text("reminder_soon_body",L10n.Date(end))));}
        }
        if(access.Low&&access.Quota is { } quota&&sent.Add("low:"+quota)) due.Add((L10n.Text("reminder_low_title"),L10n.Text("reminder_low_body",bytes(access.Remaining),bytes(quota))));
        if(!sent.SetEquals(saved)) Settings.Set("remindersSent",string.Join("\n",sent));
        // A tray balloon holds one message: two at once go together under the first title.
        return due.Count==0?null:(due[0].Title,string.Join("\n",due.Select(item=>item.Text)));
    }

    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    /// The tray icon with a small amber dot at its top right, cut out of the mark by a thin ring of transparency.
    public static Icon Dotted(Icon icon) {
        using var bitmap=icon.ToBitmap();
        using(var graphics=Graphics.FromImage(bitmap)) {
            graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            var size=bitmap.Width;var dot=size*0.36f;var ring=size*0.1f;
            var x=size-dot-ring*0.5f;var y=ring*0.5f;
            graphics.CompositingMode=System.Drawing.Drawing2D.CompositingMode.SourceCopy;
            using(var clear=new SolidBrush(Color.Transparent)) graphics.FillEllipse(clear,x-ring,y-ring,dot+ring*2,dot+ring*2);
            graphics.CompositingMode=System.Drawing.Drawing2D.CompositingMode.SourceOver;
            using var amber=new SolidBrush(Color.FromArgb(224,164,88));
            graphics.FillEllipse(amber,x,y,dot,dot);
        }
        var handle=bitmap.GetHicon();
        try {using var made=Icon.FromHandle(handle);return (Icon)made.Clone();}
        finally {DestroyIcon(handle);}
    }
}
