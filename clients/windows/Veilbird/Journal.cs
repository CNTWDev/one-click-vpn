using System.IO;

namespace Veilbird;

/// <summary>
/// Diagnostic log of the connection process, opened from a hidden entry (7 taps on the version).
/// Only what the app writes: steps, node names, transport names, timings and error codes; never keys,
/// tokens, addresses or visited sites. Two files of 256 KB rotate and lines older than 7 days are
/// dropped, so the log never grows past 512 KB.
/// </summary>
public static class Journal {
    private const long Limit=256*1024;
    private static readonly TimeSpan Retention=TimeSpan.FromDays(7);
    private static readonly object Gate=new();
    private static readonly string Folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","logs");
    private static string Current=>Path.Combine(Folder,"veilbird.log");
    private static string Previous=>Path.Combine(Folder,"veilbird.1.log");

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
