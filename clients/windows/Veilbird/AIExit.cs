using System.Text.Json.Nodes;

namespace Veilbird;

/// Keeps AI services on a steady exit. ChatGPT, Claude and Gemini refuse some countries (the server marks such
/// locations "ai": false) and flag accounts whose exit keeps changing, so automatic mode keeps people who used AI in the
/// last week off refused locations, and moves inside the same country while AI is in use (Connection.MoveToFastest).
public static class AIExit {
    private const string Key="aiSeenAt";
    private static DateTime noted=DateTime.MinValue;
    /// AI services went through the tunnel in the last week.
    public static bool Recent=>long.TryParse(Settings.Get(Key,"0"),out var seen)&&DateTimeOffset.UtcNow.ToUnixTimeSeconds()-seen<7*86400;
    /// Called on the connection's tick: remembers (at most every 5 minutes) that AI is in use.
    public static async Task Note(Core core) {
        if(DateTime.UtcNow-noted<TimeSpan.FromMinutes(5)) return;
        noted=DateTime.UtcNow;
        if(await Task.Run(()=>core.AIActive(300))) Settings.Set(Key,DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString());
    }
    /// The locations automatic mode may pick: without those AI services refuse, for people who use AI (unless none is left).
    public static JsonArray Usable(JsonArray nodes) {
        if(!Recent) return nodes;
        var kept=nodes.Where(node=>node?["ai"] is not JsonValue value||!value.TryGetValue<bool>(out var ok)||ok).Select(node=>node!.DeepClone()).ToArray();
        return kept.Length==0?nodes:new JsonArray(kept);
    }
}
