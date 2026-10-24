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
    private static readonly string[] PrivateNetworks={"10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","100.64.0.0/10","127.0.0.0/8","169.254.0.0/16"};
    // Same small rule sets as the subscription profiles (server/mihomo-config.mjs), fetched through the tunnel.
    private const string RuleSets="https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo";
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
    private static JsonArray Strings(params string[] values)=>new(values.Select(v=>(JsonNode?)JsonValue.Create(v)).ToArray());
    private static JsonObject RuleSet(string kind,string name,string behavior)=>new() {
        ["type"]="http",["behavior"]=behavior,["format"]="mrs",["url"]=$"{RuleSets}/{kind}/{name}.mrs",["path"]=$"./rules/{kind}-{name}.mrs",["interval"]=86400,["proxy"]=Group,
    };
    /// The whole mihomo configuration for one node (JSON is valid YAML).
    public static string Config(IEnumerable<JsonObject> proxies,IEnumerable<string> order,bool smart) {
        var dns=new JsonObject {
            ["enable"]=true,["ipv6"]=false,["enhanced-mode"]="fake-ip",["fake-ip-range"]="198.18.0.1/16",
            ["fake-ip-filter"]=Strings("+.lan","+.local","+.msftconnecttest.com","+.msftncsi.com","time.*.com","+.ntp.org.cn"),
            ["respect-rules"]=true,["default-nameserver"]=Strings("223.5.5.5","119.29.29.29"),
            ["nameserver"]=Strings("https://1.1.1.1/dns-query","https://8.8.8.8/dns-query"),["proxy-server-nameserver"]=Strings("https://doh.pub/dns-query","223.5.5.5"),
        };
        if(smart) dns["nameserver-policy"]=new JsonObject {["rule-set:private_domain,cn_domain"]=Strings("https://doh.pub/dns-query","https://dns.alidns.com/dns-query")};
        // The app's own requests (API, latency tests) and the core's stay outside the tunnel, as on the phones.
        var rules=new List<string> {"PROCESS-NAME,Veilbird.exe,DIRECT"};
        rules.AddRange(PrivateNetworks.Select(cidr=>$"IP-CIDR,{cidr},DIRECT,no-resolve"));
        if(smart) rules.AddRange(new[]{"RULE-SET,private_domain,DIRECT","RULE-SET,cn_domain,DIRECT","RULE-SET,cn_ip,DIRECT"});
        rules.Add("MATCH,"+Group);
        var config=new JsonObject {
            ["mode"]="rule",["log-level"]="silent",["ipv6"]=true,["find-process-mode"]="strict",["unified-delay"]=true,["tcp-concurrent"]=true,["geo-auto-update"]=false,
            ["profile"]=new JsonObject {["store-selected"]=false,["store-fake-ip"]=false},
            ["dns"]=dns,
            // strict-route keeps DNS and other traffic from leaking around the adapter.
            ["tun"]=new JsonObject {["enable"]=true,["device"]="TrackNothing",["stack"]="mixed",["auto-route"]=true,["strict-route"]=true,["auto-detect-interface"]=true,["dns-hijack"]=Strings("any:53"),["mtu"]=1500},
            ["proxies"]=new JsonArray(proxies.Select(p=>(JsonNode?)p.DeepClone()).ToArray()),
            ["proxy-groups"]=new JsonArray(new JsonObject {["name"]=Group,["type"]="fallback",["proxies"]=Strings(order.ToArray()),["url"]=TestUrl,["interval"]=300,["lazy"]=false}),
            ["rules"]=Strings(rules.ToArray()),
        };
        if(smart) config["rule-providers"]=new JsonObject {["private_domain"]=RuleSet("geosite","private","domain"),["cn_domain"]=RuleSet("geosite","cn","domain"),["cn_ip"]=RuleSet("geoip","cn","ipcidr")};
        return config.ToJsonString();
    }
    /// "name=delay,..." from the core; -1 means no answer.
    public static Dictionary<string,long> ParseProbe(string result)=>result.Split(',',StringSplitOptions.RemoveEmptyEntries).Where(p=>p.Contains('='))
        .ToDictionary(p=>p[..p.IndexOf('=')],p=>long.TryParse(p[(p.IndexOf('=')+1)..],out var ms)?ms:-1);
}
