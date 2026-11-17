using System.Globalization;
using System.IO;
using System.Resources;
namespace Veilbird;

public static class L10n {
    private static readonly ResourceManager Resources = new("Veilbird.Resources.Native", typeof(L10n).Assembly);
    private static readonly string PreferencePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Veilbird", "language.txt");
    private static readonly CultureInfo SystemCulture = CultureInfo.CurrentUICulture;
    public static string Preference { get; private set; } = "system";
    public static CultureInfo Culture => CultureInfo.CurrentUICulture;
    public static void Initialize() { try { if (File.Exists(PreferencePath)) Preference = File.ReadAllText(PreferencePath).Trim(); } catch (IOException) { } Apply(); }
    private static void Apply() {
        if (!new[]{"system","en","zh","ru"}.Contains(Preference)) Preference="system";
        var language = Preference=="system" ? SystemCulture.TwoLetterISOLanguageName : Preference;
        var culture=CultureInfo.GetCultureInfo(new[]{"en","zh","ru"}.Contains(language)?language:"en");
        CultureInfo.CurrentUICulture=culture;CultureInfo.CurrentCulture=culture;
        CultureInfo.DefaultThreadCurrentUICulture=culture;CultureInfo.DefaultThreadCurrentCulture=culture;
    }
    public static void Select(string value) { Preference=value;Apply();try{Directory.CreateDirectory(Path.GetDirectoryName(PreferencePath)!);File.WriteAllText(PreferencePath,Preference);}catch(IOException){ /* Current session still switches. */ } }
    /// The items of release notes in the app's language. Notes from clients/CHANGELOG.md have "### zh/en/ru" blocks
    /// of "- " items; notes typed in Console without blocks count for every language. English is the fallback.
    public static List<string> Notes(string text) {
        var blocks=new Dictionary<string,List<string>>();var block="";
        foreach(var raw in text.Split('\n')) {
            var line=raw.Trim();
            if(line.StartsWith("###")&&line[3..].Trim() is { Length: 2 } code) {block=code.ToLowerInvariant();continue;}
            foreach(var prefix in new[]{"- ","* ","• "}) if(line.StartsWith(prefix)) line=line[prefix.Length..];
            line=line.Trim();
            if(line.Length>0) {if(!blocks.TryGetValue(block,out var items)) blocks[block]=items=new();items.Add(line);}
        }
        return blocks.GetValueOrDefault(Culture.TwoLetterISOLanguageName)??blocks.GetValueOrDefault("en")??blocks.GetValueOrDefault("")??new();
    }
    public static string Text(string key, params object[] args) => string.Format(Culture, Resources.GetString(key, Culture) ?? key, args);
    public static string Date(string? value) => string.IsNullOrWhiteSpace(value)?Text("no_expiry"):DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out var date)?date.ToLocalTime().ToString("d",Culture):value;
}
