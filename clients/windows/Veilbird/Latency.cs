using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json.Nodes;
namespace Veilbird;

/// One node as measured from this PC: median TCP connect time, jitter and failed attempts.
public sealed record Quality(long? Latency,long Jitter,int Loss,int? Load) {
    /// Lower is better. Jitter and loss hurt more than a few extra milliseconds; a busy node is a last resort.
    public long Score=>Latency is { } ms?ms+2*Jitter+10L*Loss+((Load??0)>=85?150:0):long.MaxValue;
    public string Grade=>Latency is null?"quality_unreachable":Score<150&&Loss==0?"quality_good":Score<300&&Loss<=20?"quality_fair":"quality_poor";
}

/// "Automatic" location: the best score from TCP connects to each node's probe port. The app itself is
/// outside its own tunnel (a DIRECT rule for Veilbird.exe), so this measures the direct path even while connected.
public static class Latency {
    /// Last measurement per node id, so the home screen can show it without probing again.
    public static readonly ConcurrentDictionary<string,Quality> Recent=new();
    public static int? Load(JsonNode node)=>node["load"]?.GetValue<int>() is { } load&&load is >=0 and <=100?load:null;

    public static async Task<Quality> Measure(JsonNode node,int attempts=5) {
        var load=Load(node);
        var host=node["probe"]?["host"]?.GetValue<string>();var port=node["probe"]?["port"]?.GetValue<int>()??0;
        if(string.IsNullOrEmpty(host)||port is <1 or >65535) return new(null,0,100,load);
        IPAddress? address;
        // DNS once, so every attempt is a plain round trip.
        try {address=IPAddress.TryParse(host,out var literal)?literal:(await Dns.GetHostAddressesAsync(host)).FirstOrDefault();} catch {address=null;}
        if(address is null) return new(null,0,100,load);
        var samples=new List<long>();
        for(var attempt=0;attempt<attempts;attempt++) {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if(attempt==2&&samples.Count==0) return new(null,0,100,load);
            using var socket=new TcpClient(address.AddressFamily);using var timeout=new CancellationTokenSource(1500);var clock=Stopwatch.StartNew();
            try {await socket.ConnectAsync(address,port,timeout.Token);samples.Add(clock.ElapsedMilliseconds);} catch {/* unreachable this round */}
        }
        var loss=(attempts-samples.Count)*100/attempts;
        if(samples.Count==0) return new(null,0,loss,load);
        var sorted=samples.Order().ToList();
        var jitter=samples.Count<2?0:(long)samples.Zip(samples.Skip(1),(a,b)=>Math.Abs(a-b)).Average();
        return new(sorted[sorted.Count/2],jitter,loss,load);
    }
    /// Best first; unmeasured nodes follow in the server's least-loaded order.
    public static async Task<List<(JsonNode Node,Quality Quality)>> Rank(JsonArray nodes,int attempts=5) {
        var list=nodes.Where(n=>n is not null).Select(n=>n!).ToList();
        var measured=await Task.WhenAll(list.Select(node=>Measure(node,attempts)));
        for(var i=0;i<list.Count;i++) if(list[i]["id"]?.GetValue<string>() is { } id) Recent[id]=measured[i];
        return list.Select((node,i)=>(node,measured[i])).OrderBy(item=>item.Item2.Score).ToList();
    }
}
