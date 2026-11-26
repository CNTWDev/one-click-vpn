using System.Text;
using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>A stop on the route globe between this PC and the exit; Faint: the stretch to it was not measured.</summary>
public sealed record RouteStop(Spot Spot,bool Faint);
/// <summary>One line of the path list (kinds as core.Route: local, city, unknown, gap, exit).</summary>
public sealed record RouteRow(string Kind,int N,int Ms,string Name,string Network,bool Border);
/// <summary>The measured path of one connection: the globe's stops, the list, and the round trip to the node (0: no answer).</summary>
public sealed record RoutePath(string Key,IReadOnlyList<RouteStop> Stops,bool ExitFaint,IReadOnlyList<RouteRow> Rows,int Ms,double At);

/// <summary>
/// The path from this PC to its node, measured once a connection is up: the core traces it outside the tunnel
/// (core.Trace, from the physical network's address), the server places the routers' addresses at city level
/// (route-hops, nothing stored) and the core turns both into stops and rows (core.Route). Nothing is kept on disk;
/// when it cannot be measured the globe keeps its straight arc.
/// </summary>
public static class RouteHops {
    public static RoutePath? Path {get;private set;}
    private static string running="";

    public static async Task<bool> Measure(Core core,NativeApi api,string key,string probes,Spot? origin,Spot exit,double now) {
        if(Path?.Key==key||running==key||probes.Length==0) return false;
        running=key;
        try {
            // A moment for the connection to settle (the landing on the globe runs meanwhile).
            await Task.Delay(1500);
            if(running!=key) return false;
            var traced=await core.Trace(probes,2500);
            if(JsonNode.Parse(traced) is not JsonObject trace) return false;
            if(trace["error"] is { } error) {Journal.Add("route: not measured ("+error.ToString()+")");return false;}
            var ips=new JsonArray();
            foreach(var hop in trace["hops"]?.AsArray()??new JsonArray()) if(hop?["ip"]?.GetValue<string>() is { Length: >0 } ip) ips.Add(ip);
            JsonNode places=new JsonObject {["hops"]=new JsonArray()};
            if(ips.Count>0) {try {places=await api.Request("route-hops",new JsonObject {["ips"]=ips});} catch {/* no places: the list still shows the hops */}}
            var input=new JsonObject {["trace"]=trace,["places"]=places.DeepClone(),["exit"]=new JsonObject {["lat"]=exit.Lat,["lon"]=exit.Lon}};
            if(origin is not null) input["origin"]=new JsonObject {["lat"]=origin.Lat,["lon"]=origin.Lon};
            if(running!=key) return false;
            var built=await Task.Run(()=>core.Route(input.ToJsonString()));
            if(JsonNode.Parse(built) is not JsonObject route) return false;
            Path=Parse(key,route,now);
            return true;
        } catch {return false;}
        finally {if(running==key) running="";}
    }
    /// <summary>Forgets the path when the connection ends.</summary>
    public static void Clear() {Path=null;running="";}

    private static string Name(JsonNode? names) {
        var language=L10n.Culture.TwoLetterISOLanguageName;
        string? pick(string key) {try {return names?[key]?.GetValue<string>() is { Length: >0 } v?v:null;} catch {return null;}}
        return pick(language)??pick("en")??"";
    }
    private static double Number(JsonNode? value) {try {return value?.GetValue<double>()??0;} catch {return 0;}}
    private static int Whole(JsonNode? value) {try {return value?.GetValue<int>()??0;} catch {return 0;}}
    private static bool Flag(JsonNode? value) {try {return value?.GetValue<bool>()??false;} catch {return false;}}

    private static RoutePath Parse(string key,JsonObject route,double now) {
        var stops=new List<RouteStop>();
        foreach(var p in route["points"]?.AsArray()??new JsonArray()) if(p is not null) stops.Add(new RouteStop(new Spot(Number(p["lat"]),Number(p["lon"]),Name(p["names"])),Flag(p["faint"])));
        var rows=new List<RouteRow>();
        foreach(var r in route["rows"]?.AsArray()??new JsonArray()) if(r is not null)
            rows.Add(new RouteRow(r["kind"]?.GetValue<string>()??"",Whole(r["n"]),Whole(r["ms"]),Name(r["names"]),r["network"]?.GetValue<string>()??"",Flag(r["border"])));
        return new RoutePath(key,stops,Flag(route["exitFaint"]),rows,Whole(route["ms"]),now);
    }

    /// <summary>"Via Shanghai · 158 ms" for the line under the state; empty when nothing lies between you and the exit.</summary>
    public static string Via(RoutePath? path) {
        if(path is null||path.Stops.Count==0) return "";
        var names=path.Stops.Select(s=>s.Spot.Label).Where(n=>n.Length>0).Distinct().ToList();
        if(names.Count==0) return "";
        var tail=path.Ms>0?" · "+L10n.Text("latency_ms",path.Ms.ToString("N0",L10n.Culture)):"";
        return L10n.Text("route_via",string.Join(" · ",names)+tail);
    }

    /// <summary>The title and the second line of a row in the path list.</summary>
    public static (string Title,string Detail) Describe(RouteRow row,string exit)=>row.Kind switch {
        "local"=>(L10n.Text("route_local"),""),
        "gap"=>(row.N==0?L10n.Text("route_gap_end"):row.N==1?L10n.Text("route_gap_one"):L10n.Text("route_gap",row.N.ToString("N0",L10n.Culture)),""),
        "unknown"=>(L10n.Text("route_unknown"),row.Network),
        "exit"=>(exit,L10n.Text("route_exit")),
        _=>(row.Name,string.Join(" · ",new[]{row.Network,row.Border?L10n.Text("route_border"):""}.Where(s=>s.Length>0))),
    };
}
