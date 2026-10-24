using System.Diagnostics;
using System.Net.Sockets;
using System.Text.Json.Nodes;
namespace Veilbird;
/// "Automatic" location: the lowest TCP connect time to each node's probe port, measured from this device.
public static class Latency {
    /// Best of two connects in milliseconds; null when the node has no probe or does not answer.
    public static async Task<long?> Measure(JsonNode node) {
        var host=node["probe"]?["host"]?.GetValue<string>();var port=node["probe"]?["port"]?.GetValue<int>()??0;
        if(string.IsNullOrEmpty(host)||port is <1 or >65535) return null;
        long? best=null;
        // The first attempt may include DNS; the second is the plain round trip.
        for(var i=0;i<2;i++) {
            using var socket=new TcpClient();using var timeout=new CancellationTokenSource(1500);var clock=Stopwatch.StartNew();
            try {await socket.ConnectAsync(host,port,timeout.Token);best=Math.Min(best??long.MaxValue,clock.ElapsedMilliseconds);} catch {/* unreachable this round */}
        }
        return best;
    }
    /// Fastest first; unmeasured nodes follow in the server's least-loaded order.
    public static async Task<List<(JsonNode Node,long? Ms)>> Rank(JsonArray nodes) {
        var list=nodes.Where(n=>n is not null).Select(n=>n!).ToList();
        var measured=await Task.WhenAll(list.Select(Measure));
        return list.Select((node,i)=>(node,measured[i])).OrderBy(item=>item.Item2??long.MaxValue).ToList();
    }
}
