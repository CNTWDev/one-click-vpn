using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>
/// How the app reaches a node; the same ladder as the other apps, lightest first: WireGuard, Hysteria2 with
/// obfuscation, VLESS REALITY on TCP 443, REALITY over XHTTP. All are tested at once and the first that answers
/// in ladder order carries traffic. A transport that failed on a network while another worked goes to the end
/// of the ladder there for a week.
/// </summary>
public static class Transports {
    public static readonly string[] Ladder={"wireguard","hysteria2","reality","xhttp"};
    public const string Group="TrackNothing";
    public const string TestUrl="https://www.gstatic.com/generate_204";
    private static readonly TimeSpan Memory=TimeSpan.FromDays(7);
    private static readonly string MemoryPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","transports.json");

    /// A short one-way label for the network outside the tunnel: a hash of the active adapter's kind, gateways,
    /// DNS servers and DNS suffix. Nothing that names the network is stored.
    public static string NetworkKey() {
        try {
            var adapter=NetworkInterface.GetAllNetworkInterfaces()
                .Where(n=>n.OperationalStatus==OperationalStatus.Up&&n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
                    &&!n.Name.StartsWith("TrackNothing",StringComparison.OrdinalIgnoreCase)&&!n.Description.Contains("Wintun",StringComparison.OrdinalIgnoreCase))
                .Select(n=>(Adapter:n,Properties:n.GetIPProperties()))
                .Where(x=>x.Properties.GatewayAddresses.Any(g=>!g.Address.Equals(IPAddress.Any)&&!g.Address.Equals(IPAddress.IPv6Any)))
                .OrderBy(x=>x.Adapter.NetworkInterfaceType==NetworkInterfaceType.Ethernet?0:1).FirstOrDefault();
            if(adapter.Adapter is null) return "unknown";
            var kind=adapter.Adapter.NetworkInterfaceType==NetworkInterfaceType.Wireless80211?"wifi":"lan";
            var raw=string.Join("|",kind,string.Join(",",adapter.Properties.GatewayAddresses.Select(g=>g.Address.ToString()).Order()),
                string.Join(",",adapter.Properties.DnsAddresses.Select(d=>d.ToString()).Order()),adapter.Properties.DnsSuffix);
            return kind+":"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..12].ToLowerInvariant();
        } catch(NetworkInformationException) {return "unknown";}
    }

    private static JsonObject Load() {
        try {return File.Exists(MemoryPath)?JsonNode.Parse(File.ReadAllText(MemoryPath)) as JsonObject??new():new();} catch(Exception error) when (error is IOException or JsonException) {return new();}
    }
    /// Transports that failed on this network within the last week, while another one worked.
    public static HashSet<string> Blocked(string network) {
        var cutoff=DateTimeOffset.UtcNow.Add(-Memory).ToUnixTimeMilliseconds();
        return (Load()[network] as JsonObject)?.Where(p=>p.Value?.GetValue<long>()>cutoff).Select(p=>p.Key).ToHashSet()??new();
    }
    public static void Remember(string network,IEnumerable<string> failed,IEnumerable<string> working) {
        var all=Load();var now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();var cutoff=now-(long)Memory.TotalMilliseconds;
        var entry=all[network] as JsonObject??new JsonObject();
        foreach(var name in failed) entry[name]=now;
        foreach(var name in working) entry.Remove(name);
        // Forget networks not seen for a week, so the memory stays a handful of entries.
        foreach(var key in all.Select(p=>p.Key).ToList()) if(key!=network&&(all[key] as JsonObject)?.All(p=>p.Value?.GetValue<long>()<=cutoff)!=false) all.Remove(key);
        all.Remove(network);
        if(entry.Count>0) all[network]=entry.DeepClone();
        try {Directory.CreateDirectory(Path.GetDirectoryName(MemoryPath)!);File.WriteAllText(MemoryPath,all.ToJsonString());} catch(IOException) {}
    }
    /// Ladder order, with transports this network blocked moved to the end.
    public static List<string> Order(IEnumerable<string> names,ISet<string> blocked) {
        var offered=names.ToHashSet();
        return Ladder.Where(offered.Contains).OrderBy(name=>blocked.Contains(name)?1:0).ToList();
    }

    /// WireGuard as a mihomo proxy: this PC holds the private key, the lease gives the rest.
    public static JsonObject WireGuard(JsonObject lease,string privateKey) {
        var wg=lease["wireguard"]!.AsObject();var endpoint=wg["endpoint"]!.GetValue<string>();var colon=endpoint.LastIndexOf(':');
        return new JsonObject {
            ["name"]="wireguard",["type"]="wireguard",["server"]=endpoint[..colon].Trim('[',']'),["port"]=int.Parse(endpoint[(colon+1)..]),
            ["ip"]=wg["address"]!.GetValue<string>().Split('/')[0],["private-key"]=privateKey,["public-key"]=wg["serverPublicKey"]!.GetValue<string>(),
            ["allowed-ips"]=new JsonArray("0.0.0.0/0"),["udp"]=true,["mtu"]=1280,["remote-dns-resolve"]=true,["dns"]=wg["dns"]!.DeepClone(),
        };
    }
    /// What the core needs to build the configuration (clients/core/config.go): the same on every app.
    public static string Options(IEnumerable<JsonObject> proxies,IEnumerable<string> order,bool smart)=>new JsonObject {
        ["platform"]="windows",["smart"]=smart,
        ["proxies"]=new JsonArray(proxies.Select(p=>(JsonNode?)p.DeepClone()).ToArray()),
        ["order"]=new JsonArray(order.Select(n=>(JsonNode?)JsonValue.Create(n)).ToArray()),
    }.ToJsonString();
    /// "name=delay,..." from the core; -1 means no answer.
    public static Dictionary<string,long> ParseProbe(string result)=>result.Split(',',StringSplitOptions.RemoveEmptyEntries).Where(p=>p.Contains('='))
        .ToDictionary(p=>p[..p.IndexOf('=')],p=>long.TryParse(p[(p.IndexOf('=')+1)..],out var ms)?ms:-1);
}
