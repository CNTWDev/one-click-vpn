using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Veilbird;

/// <summary>
/// Per-app routing: every program through the tunnel (the default), only the selected programs, or every program
/// except them. The core matches programs by file name (mihomo PROCESS-NAME, clients/core/config.go). Read when the
/// tunnel starts: changes apply from the next connection, like the routing mode.
/// </summary>
public static class AppRouting {
    public const string All="all",Only="only",Except="except";
    public sealed record Entry(string Name,string Title,ImageSource? Icon);

    public static string Mode=>Settings.Get("appMode",All) is Only or Except?Settings.Get("appMode",All):All;
    public static void SetMode(string mode)=>Settings.Set("appMode",mode);
    /// Program file names such as chrome.exe, kept as Windows reported them.
    public static List<string> Apps=>Settings.Get("apps","").Split('\n',StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    public static void SetApps(IEnumerable<string> apps)=>Settings.Set("apps",string.Join("\n",apps));
    /// The mode the core gets: "only" or "except" with at least one program; otherwise every program.
    public static (string Mode,List<string> Apps) Effective {
        get {var apps=Apps.Where(a=>!a.Equals("Veilbird.exe",StringComparison.OrdinalIgnoreCase)).ToList();return apps.Count==0?(All,apps):(Mode,Mode==All?new():apps);}
    }

    /// Programs with a window open now (what a person recognises), this app left out, one row per file name.
    public static List<Entry> Running() {
        var found=new Dictionary<string,Entry>(StringComparer.OrdinalIgnoreCase);
        foreach(var process in Process.GetProcesses()) {
            try {
                if(process.MainWindowHandle==IntPtr.Zero||process.Id==Environment.ProcessId) continue;
                var path=process.MainModule?.FileName;
                if(path is null) continue;
                var name=Path.GetFileName(path);
                if(found.ContainsKey(name)) continue;
                found[name]=Describe(path);
            } catch {/* another user's or a protected process */}
            finally {process.Dispose();}
        }
        return found.Values.OrderBy(p=>p.Title,StringComparer.CurrentCultureIgnoreCase).ToList();
    }
    /// A program's file name, its product description (or the file name) and its icon.
    public static Entry Describe(string path) {
        var name=Path.GetFileName(path);
        string title;
        try {title=FileVersionInfo.GetVersionInfo(path).FileDescription?.Trim() is { Length: >0 } description?description:Path.GetFileNameWithoutExtension(path);}
        catch {title=Path.GetFileNameWithoutExtension(path);}
        return new Entry(name,title,IconOf(path));
    }
    private static ImageSource? IconOf(string path) {
        try {
            using var icon=System.Drawing.Icon.ExtractAssociatedIcon(path);
            if(icon is null) return null;
            var image=Imaging.CreateBitmapSourceFromHIcon(icon.Handle,Int32Rect.Empty,BitmapSizeOptions.FromEmptyOptions());
            image.Freeze();return image;
        } catch {return null;}
    }
}
