using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using Forms=System.Windows.Forms;
namespace Veilbird;

/// Location and routing choices, kept per Windows user.
public static class Settings {
    private static readonly string Path=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","settings.json");
    private static JsonObject Load() {try {return File.Exists(Path)?JsonNode.Parse(File.ReadAllText(Path)) as JsonObject??new():new();} catch {return new();}}
    public static string Get(string key,string fallback="")=>Load()[key]?.GetValue<string>()??fallback;
    public static void Set(string key,string value) {
        var all=Load();all[key]=value;
        try {Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);File.WriteAllText(Path,all.ToJsonString());} catch(IOException) {}
    }
}

/// "Open at login": a logon task with the highest privileges, since the app runs as administrator
/// (Windows skips elevated programs listed under the Run key).
public static class LoginTask {
    private const string Name="TrackNothing";
    private static bool? enabled;
    private static int Run(string arguments) {
        try {
            using var process=Process.Start(new ProcessStartInfo("schtasks.exe",arguments) {CreateNoWindow=true,UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true});
            if(process is null) return -1;
            process.WaitForExit(8000);
            return process.HasExited?process.ExitCode:-1;
        } catch {return -1;}
    }
    public static bool Enabled=>enabled??=Run($"/Query /TN \"{Name}\"")==0;
    public static bool Set(bool on) {
        var ok=on?Run($"/Create /TN \"{Name}\" /TR \"\\\"{Environment.ProcessPath}\\\" --background\" /SC ONLOGON /RL HIGHEST /F")==0:Run($"/Delete /TN \"{Name}\" /F")==0;
        if(ok) enabled=on;
        return ok;
    }
}
