using System.Globalization;
using System.IO;
using System.Resources;
namespace Northstar;

public static class L10n {
    private static readonly ResourceManager Resources = new("Northstar.Resources.Native", typeof(L10n).Assembly);
    private static readonly string PreferencePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NORTHSTAR", "language.txt");
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
    public static string Text(string key, params object[] args) => string.Format(Culture, Resources.GetString(key, Culture) ?? key, args);
    public static string Date(string? value) => string.IsNullOrWhiteSpace(value)?Text("no_expiry"):DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out var date)?date.ToLocalTime().ToString("d",Culture):value;
}
