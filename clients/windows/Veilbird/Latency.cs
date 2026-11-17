using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json.Nodes;
namespace Veilbird;

/// One node as measured from this PC: median TCP connect time, jitter and failed attempts.
/// Lines: each transport's result on this network (ms, -1 = no answer); null when not measured through the transports.
public sealed record Quality(long? Latency,long Jitter,int Loss,int? Load,int Users=0,IReadOnlyDictionary<string,long>? Lines=null) {
    /// Lower is better. Jitter and loss hurt more than a few extra milliseconds. Load above half costs 4 ms per
    /// percent (a full node +200 ms) and each connected user 1 ms (at most 50), so close nodes win unless busy.
    public long Score=>Latency is { } ms?ms+2*Jitter+10L*Loss+Math.Max(0,(Load??0)-50)*4L+Math.Min(Users,50):long.MaxValue;
    public string Grade=>Latency is null?"quality_unreachable":Score<150&&Loss==0?"quality_good":Score<300&&Loss<=20?"quality_fair":"quality_poor";
}

/// "Automatic" location: the best score from TCP connects to each node's probe ports. The app itself is
/// outside its own tunnel (a DIRECT rule for Veilbird.exe), so this measures the direct path even while connected.
public static class Latency {
    /// Last measurement per node id, so the home screen can show it without probing again.
    public static readonly ConcurrentDictionary<string,Quality> Recent=new();
    private static readonly ConcurrentDictionary<string,DateTime> MeasuredAt=new();
    public static int? Load(JsonNode node)=>node["load"]?.GetValue<int>() is { } load&&load is >=0 and <=100?load:null;
    public static int Users(JsonNode node)=>node["users"]?.GetValue<int>() is { } users&&users>=0?users:0;

    /// Long enough for one lost SYN to be resent (1 s) and still answer across a long, lossy route; mihomo's own
    /// delay test (what Clash apps show) waits 5 s, so a shorter wait called slow but working nodes unreachable.
    private const int TimeoutMs=3000;
    /// Every TCP port the node answers on (REALITY, XHTTP); older servers only send "probe".
    public static List<(string Host,int Port)> Probes(JsonNode node) {
        var items=new List<JsonNode>();
        if(node["probes"] is JsonArray array) items.AddRange(array.Where(item=>item is not null).Select(item=>item!));
        else if(node["probe"] is { } single) items.Add(single);
        return items.Select(item=>(Host:item["host"]?.GetValue<string>()??"",Port:item["port"]?.GetValue<int>()??0))
            .Where(p=>p.Host.Length>0&&p.Port is >=1 and <=65535).Distinct().ToList();
    }
    /// Connects to every port at once and takes the first answer: a network that blocks one port (often 443)
    /// still reaches the node on the other, as the app's own fallback transports would when connecting.
    private static async Task<long?> Race(List<(IPAddress Address,int Port)> targets) {
        using var timeout=new CancellationTokenSource(TimeoutMs);var clock=Stopwatch.StartNew();
        var pending=targets.Select(async target=>{
            using var socket=new TcpClient(target.Address.AddressFamily);
            try {await socket.ConnectAsync(target.Address,target.Port,timeout.Token);return (long?)clock.ElapsedMilliseconds;}
            catch {return null;}
        }).ToList();
        while(pending.Count>0) {
            var finished=await Task.WhenAny(pending);pending.Remove(finished);
            if(await finished is { } elapsed) {timeout.Cancel();return elapsed;}
        }
        return null;
    }
    /// The core's request through a node's transports (Core.Test); set once the core exists.
    public static Func<string,Task<string>>? RealTest;
    /// The wait for a request through a transport; mihomo's default, which Clash apps show.
    private const int RealTimeoutMs=5000;
    /// The transports a node can offer, in the order the apps show them as "线路 1…4": Hysteria2 (with port hopping),
    /// REALITY on 443, REALITY on the node's spare TCP port, XHTTP. Users only see the numbers; the transport names stay
    /// in the hidden log. WireGuard is not listed: it cannot be tested before a lease.
    public static readonly string[] LineOrder=["hysteria2","reality","reality-alt","xhttp"];
    /// The file the speed test downloads through the current connection (repeated for the test's few seconds).
    public const string SpeedUrl="https://speed.cloudflare.com/__down?bytes=100000000";
    /// A request to the test page through every transport the device has on this node (the server's "test" list,
    /// the lines a connect would use): the fastest answer in ms (-1 when none answers) and each transport's result;
    /// null when not measured. This is how Clash apps measure: it sees a node reached only over UDP, and one whose
    /// port answers but whose transport is blocked after the handshake.
    public static async Task<(long Ms,Dictionary<string,long> Lines)?> Real(string id,JsonArray transports) {
        if(RealTest is not { } test) return null;
        try {
            var input=new JsonObject {["nodes"]=new JsonObject {[id]=transports.DeepClone()},["url"]=Transports.TestUrl,["timeoutMs"]=RealTimeoutMs};
            if(JsonNode.Parse(await test(input.ToJsonString()))?[id] is not JsonObject result) return null;
            var lines=new Dictionary<string,long>();
            if(result["lines"] is JsonObject map) foreach(var (name,value) in map) if(value is not null) lines[name]=value.GetValue<long>();
            return (result["ms"]?.GetValue<long>()??-1,lines);
        } catch {return null;}
    }
    /// Tells the server which lines answered on this network (the block alerts in Console read it). A node's failures
    /// count only when some line somewhere answered, so a PC without internet reports nothing.
    public static async Task Report(NativeApi api,IEnumerable<(JsonNode Node,Quality Quality)> ranked) {
        var measured=ranked.Where(item=>item.Quality.Lines is { Count: >0 }&&item.Node["id"] is not null)
            .Select(item=>(Id:item.Node["id"]!.GetValue<string>(),Lines:item.Quality.Lines!)).ToList();
        if(!measured.Any(item=>item.Lines.Values.Any(ms=>ms>=0))) return;
        var network=Transports.NetworkKey();var at=DateTimeOffset.UtcNow.ToString("O");
        await api.ReportMany(measured.Take(19).Select(item=>new JsonObject {
            ["code"]="TRANSPORT_PROBE",["at"]=at,["nodeId"]=item.Id,["network"]=network,
            ["detail"]=string.Join(',',item.Lines.OrderBy(pair=>pair.Key,StringComparer.Ordinal).Select(pair=>pair.Key+"="+(pair.Value>=0?"ok":"fail"))),
        }));
    }
    /// TCP connects give jitter and loss; the request through the transports, when the device has them, decides
    /// whether the node answers and its latency. Devices that never connected (no "test" list) keep the TCP result.
    public static async Task<Quality> Measure(JsonNode node,int attempts=5) {
        var pending=node["test"] is JsonArray { Count: >0 } transports&&node["id"]?.GetValue<string>() is { } id?Real(id,transports):null;
        var tcp=await MeasureTcp(node,attempts);
        if(pending is null||await pending is not { } real) return tcp;
        var (delay,lines)=real;
        if(lines.Count>0) Journal.Add($"lines: {node["name"]?.GetValue<string>()} "+string.Join(", ",lines.Select(pair=>pair.Value>=0?$"{pair.Key} {pair.Value} ms":$"{pair.Key} no answer")));
        if(delay<0) return new(null,0,100,tcp.Load,tcp.Users,lines);
        return tcp.Latency is not null?tcp with {Latency=delay,Lines=lines}:new(delay,0,0,tcp.Load,tcp.Users,lines);
    }
    private static async Task<Quality> MeasureTcp(JsonNode node,int attempts) {
        var load=Load(node);var users=Users(node);
        var targets=new List<(IPAddress Address,int Port)>();
        // DNS once, so every attempt is a plain round trip.
        foreach(var (host,port) in Probes(node)) {
            try {
                var address=IPAddress.TryParse(host,out var literal)?literal:(await Dns.GetHostAddressesAsync(host)).FirstOrDefault();
                if(address is not null) targets.Add((address,port));
            } catch {/* unresolved: skip this port */}
        }
        if(targets.Count==0) return new(null,0,100,load,users);
        var samples=new List<long>();
        for(var attempt=0;attempt<attempts;attempt++) {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if(attempt==2&&samples.Count==0) return new(null,0,100,load,users);
            if(await Race(targets) is { } elapsed) samples.Add(elapsed);
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
