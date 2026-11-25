using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>
/// Advanced features, hidden until the person turns them on in Account: favorite locations (listed first on the
/// location page) and a per-location protocol lock. Both are kept on this PC only.
/// </summary>
public static class Advanced {
    /// The protocols a location can be locked to; "reality" covers REALITY on 443 and on the spare port.
    public static readonly string[] Protocols={"hysteria2","reality","xhttp","wireguard"};
    /// <summary>Always on since 1.0.35 (there is no switch any more): the features stay out of the way until used.</summary>
    public static bool Enabled=>true;
    private static HashSet<string> AllFavorites=>Settings.Get("advancedFavorites","").Split('\n',StringSplitOptions.RemoveEmptyEntries).ToHashSet();
    public static HashSet<string> Favorites=>Enabled?AllFavorites:new();
    public static void Favorite(string id,bool on) {
        var all=AllFavorites;if(on) all.Add(id); else all.Remove(id);
        Settings.Set("advancedFavorites",string.Join("\n",all.Order()));
    }
    private static JsonObject Locks {get {try {return JsonNode.Parse(Settings.Get("advancedLocks","{}")) as JsonObject??new();} catch {return new();}}}
    /// The protocol this location is locked to, or "" (automatic); nothing is locked while advanced is off.
    public static string Lock(string id) {
        if(!Enabled||id.Length==0) return "";
        var value=Locks[id]?.GetValue<string>()??"";
        return Protocols.Contains(value)?value:"";
    }
    public static void SetLock(string id,string protocol) {
        var all=Locks;if(protocol.Length==0) all.Remove(id); else all[id]=protocol;
        Settings.Set("advancedLocks",all.ToJsonString());
    }
    /// The transports of a locked location: only those of its protocol, or all of them when none of those is offered.
    public static List<string> Apply(List<string> transports,string locked) {
        if(locked.Length==0) return transports;
        var kept=transports.Where(t=>Family(t)==locked).ToList();
        return kept.Count>0?kept:transports;
    }
    public static string Family(string transport)=>transport=="reality-alt"?"reality":transport;

    /// The person's routing rules as typed (one per line); the core reads them (clients/core/rules.go).
    public static string RulesText {get=>Settings.Get("advancedRules","");set=>Settings.Set("advancedRules",value);}
    /// The lines the core will use; none while advanced is off.
    public static List<string> Rules=>Enabled?RulesText.Split('\n').Select(l=>l.Trim()).Where(l=>RuleState(l)==1).ToList():new();
    private static readonly HashSet<string> RuleTypes=new(StringComparer.OrdinalIgnoreCase){"DOMAIN","DOMAIN-SUFFIX","DOMAIN-KEYWORD","IP-CIDR","IP-CIDR6"};
    /// 1 a rule, 0 blank or a comment, -1 a line the core cannot read; the same reading as rules.go.
    public static int RuleState(string line) {
        var hash=line.IndexOf('#');if(hash>=0) line=line[..hash];
        var parts=line.Split(',').Select(p=>p.Trim()).Where(p=>p.Length>0).ToArray();
        if(parts.Length==0) return 0;
        string value;bool ip;
        if(parts.Length>=3&&RuleTypes.Contains(parts[0])) {value=parts[1];ip=parts[0].StartsWith("IP",StringComparison.OrdinalIgnoreCase);}
        else if(parts.Length==2) {value=parts[0];ip=value.Contains('/');}
        else return -1;
        if(value.Any(char.IsWhiteSpace)) return -1;
        if(ip) return System.Net.IPNetwork.TryParse(value,out _)||LooseCidr(value)?1:-1;
        return value.TrimStart('+').TrimStart('.').Length>0?1:-1;
    }
    /// A prefix with host bits set ("10.8.1.0/16"), which the core masks.
    private static bool LooseCidr(string value) {
        var slash=value.IndexOf('/');
        return slash>0&&System.Net.IPAddress.TryParse(value[..slash],out var address)&&int.TryParse(value[(slash+1)..],out var bits)&&bits>=0&&bits<=(address.AddressFamily==System.Net.Sockets.AddressFamily.InterNetworkV6?128:32);
    }

    private static bool IsAddress(string host)=>System.Net.IPAddress.TryParse(host,out _);
    /// The registrable part of a host, as the core groups sites (activity.go site): chat.openai.com -> openai.com.
    public static string Site(string host) {
        if(IsAddress(host)) return host;
        var labels=host.Split('.');
        var keep=2;
        if(labels.Length>=3&&labels[^1].Length==2&&new[]{"com","net","org","edu","gov","co","ac","or","ne","go"}.Contains(labels[^2])) keep=3;
        return labels.Length<=keep?host:string.Join('.',labels[^keep..]);
    }
    /// The line a quick rule writes: the whole site ("openai.com, direct") or only this name ("DOMAIN,chat.openai.com,direct").
    public static string QuickRule(string host,bool site,string policy)=>
        IsAddress(host)?host+(host.Contains(':')?"/128":"/32")+", "+policy:site?host+", "+policy:"DOMAIN,"+host+","+policy;
    /// Puts the person's quick rule for host first (the first matching rule wins), replacing an earlier one for the
    /// same name and reach; returns the text before it, for undo.
    public static string SetQuickRule(string host,bool site,string policy) {
        var before=RulesText;var name=host.ToLowerInvariant();
        var kept=before.Replace("\r","").Split('\n').Where(l=>!SameTarget(l,name,site));
        RulesText=string.Join('\n',new[]{QuickRule(name,site,policy)}.Concat(kept)).TrimEnd('\n');
        return before;
    }
    private static bool SameTarget(string line,string host,bool site) {
        var hash=line.IndexOf('#');if(hash>=0) line=line[..hash];
        var parts=line.Split(',').Select(p=>p.Trim()).Where(p=>p.Length>0).ToArray();
        static string Bare(string value)=>value.ToLowerInvariant().TrimStart('+','.');
        if(parts.Length==2) return Bare(parts[0])==host&&site||Bare(parts[0])==host+"/32"||Bare(parts[0])==host+"/128";
        if(parts.Length>=3) {
            var kind=parts[0].ToUpperInvariant();
            return Bare(parts[1])==host&&(kind=="DOMAIN-SUFFIX"?site:kind=="DOMAIN"&&!site);
        }
        return false;
    }
}
