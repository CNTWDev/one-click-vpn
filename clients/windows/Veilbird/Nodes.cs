using System.IO;
using System.Text.Json.Nodes;
namespace Veilbird;

/// The location list and this PC's measurements as last loaded, kept on disk: the list page shows them at once (also
/// right after launch); a background refresh replaces them and a failed one keeps them. Cleared on sign-out.
public static class NodeStore {
    private static readonly string FilePath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","nodes.json");
    /// The list changes rarely and people refresh it by hand: it is loaded when the app starts, and again when the
    /// window comes back after this long (the app stays in the tray for days). Opening the list page does not load it.
    public static readonly TimeSpan RefreshAfter=TimeSpan.FromHours(6);
    public static DateTime LoadedAt {get;private set;}=DateTime.MinValue;

    /// The saved list (null when there is none); puts the saved measurements back as well.
    public static JsonArray? Restore() {
        try {
            if(!File.Exists(FilePath)||JsonNode.Parse(File.ReadAllText(FilePath)) is not JsonObject saved) return null;
            if(saved["measured"] is JsonObject measured) Latency.Restore(measured);
            LoadedAt=saved["at"]?.GetValue<long>() is { } at?DateTimeOffset.FromUnixTimeMilliseconds(at).UtcDateTime:DateTime.MinValue;
            return saved["nodes"] is JsonArray nodes?(JsonArray)nodes.DeepClone():null;
        } catch {return null;}
    }
    public static void SaveNodes(JsonArray nodes) {LoadedAt=DateTime.UtcNow;Write(nodes);}
    public static void SaveMeasured(JsonArray? nodes) {if(nodes is not null) Write(nodes);}
    private static void Write(JsonArray nodes) {
        var saved=new JsonObject {["at"]=new DateTimeOffset(LoadedAt==DateTime.MinValue?DateTime.UtcNow:LoadedAt).ToUnixTimeMilliseconds(),["nodes"]=nodes.DeepClone(),["measured"]=Latency.Snapshot()};
        try {Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);File.WriteAllText(FilePath,saved.ToJsonString());} catch(IOException) {} catch(UnauthorizedAccessException) {}
    }
    public static void Clear() {
        LoadedAt=DateTime.MinValue;Latency.Forget();
        try {if(File.Exists(FilePath)) File.Delete(FilePath);} catch(IOException) {} catch(UnauthorizedAccessException) {}
    }
}
