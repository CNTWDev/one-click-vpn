using System.IO;

namespace Veilbird;

/// <summary>
/// Diagnostic log of the connection process, opened from a hidden entry (7 taps on the version).
/// Only what the app writes: steps, node names, transport names, timings, error codes and error texts
/// scrubbed of addresses (Scrub); never keys, tokens, addresses or visited sites. Two files of 256 KB rotate and lines older than 7 days are
/// dropped, so the log never grows past 512 KB.
/// </summary>
public static class Journal {
    private const long Limit=256*1024;
    private static readonly TimeSpan Retention=TimeSpan.FromDays(7);
    private static readonly object Gate=new();
    private static readonly string Folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","logs");
    private static string Current=>Path.Combine(Folder,"veilbird.log");
    private static string Previous=>Path.Combine(Folder,"veilbird.1.log");

    /// An error text without anything that names a place: URLs, IP addresses, host names and long tokens
    /// become "…" (same rule as the server's scrubDetail). At most 200 characters.
    public static string Scrub(string? text) {
        var value=text??"";
        foreach(var pattern in new[]{@"(?i)[a-z][a-z0-9+.-]*://\S+",@"\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b",@"(?i)\[?\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\]?(:\d+)?",
            @"(?i)\b(?:[a-z0-9-]+\.)+[a-z]{2,}(:\d+)?\b",@"[A-Za-z0-9+/=_-]{24,}"}) value=System.Text.RegularExpressions.Regex.Replace(value,pattern,"…");
        value=System.Text.RegularExpressions.Regex.Replace(value,@"\s+"," ").Trim();
        return value.Length>200?value[..200]:value;
    }
    public static void Add(string message) {
        lock(Gate) {
            try {
                Directory.CreateDirectory(Folder);
                foreach(var file in new[]{Previous,Current}) if(File.Exists(file)&&File.GetLastWriteTimeUtc(file)<DateTime.UtcNow-Retention) File.Delete(file);
                if(File.Exists(Current)&&new FileInfo(Current).Length>Limit) File.Move(Current,Previous,true);
                File.AppendAllText(Current,$"{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ssZ} {message.ReplaceLineEndings(" ")}\n");
            } catch(IOException) {/* logging never breaks connecting */}
        }
    }
    /// Oldest first, without lines past the retention window.
    public static string Read() {
        lock(Gate) {
            var cutoff=DateTime.UtcNow-Retention;
            return string.Join("\n",new[]{Previous,Current}.Where(File.Exists).SelectMany(File.ReadAllLines)
                .Where(line=>DateTime.TryParse(line.Split(' ')[0],System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.AdjustToUniversal,out var at)&&at>cutoff));
        }
    }
    public static void Clear() {lock(Gate) {foreach(var file in new[]{Previous,Current}) try {File.Delete(file);} catch(IOException) {}}}
}
