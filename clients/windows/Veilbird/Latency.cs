using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json.Nodes;
namespace Veilbird;

/// One node as measured from this PC: median TCP connect time, jitter and failed attempts.
public sealed record Quality(long? Latency,long Jitter,int Loss,int? Load,int Users=0) {
    /// Lower is better. Jitter and loss hurt more than a few extra milliseconds. Load above half costs 4 ms per
    /// percent (a full node +200 ms) and each connected user 1 ms (at most 50), so close nodes win unless busy.
    public long Score=>Latency is { } ms?ms+2*Jitter+10L*Loss+Math.Max(0,(Load??0)-50)*4L+Math.Min(Users,50):long.MaxValue;
    public string Grade=>Latency is null?"quality_unreachable":Score<150&&Loss==0?"quality_good":Score<300&&Loss<=20?"quality_fair":"quality_poor";
}

/// "Automatic" location: the best score from TCP connects to each node's probe port. The app itself is
/// outside its own tunnel (a DIRECT rule for Veilbird.exe), so this measures the direct path even while connected.
public static class Latency {
    /// Last measurement per node id, so the home screen can show it without probing again.
    public static readonly ConcurrentDictionary<string,Quality> Recent=new();
    private static readonly ConcurrentDictionary<string,DateTime> MeasuredAt=new();
    public static int? Load(JsonNode node)=>node["load"]?.GetValue<int>() is { } load&&load is >=0 and <=100?load:null;
    public static int Users(JsonNode node)=>node["users"]?.GetValue<int>() is { } users&&users>=0?users:0;

    public static async Task<Quality> Measure(JsonNode node,int attempts=5) {
        var load=Load(node);var users=Users(node);
        var host=node["probe"]?["host"]?.GetValue<string>();var port=node["probe"]?["port"]?.GetValue<int>()??0;
        if(string.IsNullOrEmpty(host)||port is <1 or >65535) return new(null,0,100,load,users);
        IPAddress? address;
        // DNS once, so every attempt is a plain round trip.
        try {address=IPAddress.TryParse(host,out var literal)?literal:(await Dns.GetHostAddressesAsync(host)).FirstOrDefault();} catch {address=null;}
        if(address is null) return new(null,0,100,load,users);
        var samples=new List<long>();
        for(var attempt=0;attempt<attempts;attempt++) {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if(attempt==2&&samples.Count==0) return new(null,0,100,load,users);
            using var socket=new TcpClient(address.AddressFamily);using var timeout=new CancellationTokenSource(1500);var clock=Stopwatch.StartNew();
            try {await socket.ConnectAsync(address,port,timeout.Token);samples.Add(clock.ElapsedMilliseconds);} catch {/* unreachable this round */}
        }
        var loss=(attempts-samples.Count)*100/attempts;
        if(samples.Count==0) return new(null,0,loss,load,users);
        var sorted=samples.Order().ToList();
        var jitter=samples.Count<2?0:(long)samples.Zip(samples.Skip(1),(a,b)=>Math.Abs(a-b)).Average();
        return new(sorted[sorted.Count/2],jitter,loss,load,users);
    }
    /// Best first; unmeasured nodes follow in the server's least-loaded order. A node measured within reuse keeps
    /// that result (with the current load), so connecting right after the location list does not probe again.
    public static async Task<List<(JsonNode Node,Quality Quality)>> Rank(JsonArray nodes,int attempts=5,TimeSpan? reuse=null) {
        var list=nodes.Where(n=>n is not null).Select(n=>n!).ToList();
        Quality? Known(JsonNode node)=>reuse is { } age&&node["id"]?.GetValue<string>() is { } id&&MeasuredAt.TryGetValue(id,out var at)&&DateTime.UtcNow-at<age
            &&Recent.TryGetValue(id,out var quality)?quality:null;
        var measured=await Task.WhenAll(list.Select(async node=>{
            if(Known(node) is { } known) return known with {Load=Load(node),Users=Users(node)};
            var fresh=await Measure(node,attempts);
            if(node["id"]?.GetValue<string>() is { } id) MeasuredAt[id]=DateTime.UtcNow;
            return fresh;
        }));
        for(var i=0;i<list.Count;i++) if(list[i]["id"]?.GetValue<string>() is { } id) Recent[id]=measured[i];
        return list.Select((node,i)=>(node,measured[i])).OrderBy(item=>item.Item2.Score).ToList();
    }
}
