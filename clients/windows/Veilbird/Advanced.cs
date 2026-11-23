using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>
/// Advanced features, hidden until the person turns them on in Account: favorite locations (listed first on the
/// location page) and a per-location protocol lock. Both are kept on this PC only.
/// </summary>
public static class Advanced {
    /// The protocols a location can be locked to; "reality" covers REALITY on 443 and on the spare port.
    public static readonly string[] Protocols={"hysteria2","reality","xhttp","wireguard"};
    public static bool Enabled {get=>Settings.Get("advanced","off")=="on";set=>Settings.Set("advanced",value?"on":"off");}
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
}
