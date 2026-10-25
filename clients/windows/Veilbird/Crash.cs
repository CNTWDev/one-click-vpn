using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows.Threading;

namespace Veilbird;

/// <summary>
/// Crash reports: an unhandled exception is written to crash.json as it happens (type, scrubbed message and the
/// app's own frames as Class/Method, never paths or values), and sent as an APP_CRASH diagnostic on the next start
/// (Console → 客户端发布 counts it; 运行日志 has the text).
/// </summary>
public static class Crash {
    private static readonly string File_=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird","crash.json");

    public static void Watch(Dispatcher dispatcher) {
        AppDomain.CurrentDomain.UnhandledException+=(_,e)=>{if(e.ExceptionObject is Exception error) Save(error);};
        dispatcher.UnhandledException+=(_,e)=>Save(e.Exception);
        TaskScheduler.UnobservedTaskException+=(_,e)=>Save(e.Exception);
    }
    /// "NullReferenceException: … at Connection/Tick < MainWindow/Render" (dots would read as host names to the scrubber).
    public static string Describe(Exception error) {
        var inner=error is AggregateException { InnerExceptions.Count: 1 } single?single.InnerException!:error;
        var frames=new StackTrace(inner,false).GetFrames().Select(frame=>frame.GetMethod()).Where(method=>method?.DeclaringType?.Namespace?.StartsWith("Veilbird",StringComparison.Ordinal)==true)
            .Select(method=>$"{method!.DeclaringType!.Name.Split('+','<','>').First(part=>part.Length>0)}/{method.Name.Trim('<','>')}").Distinct().Take(8);
        return $"{inner.GetType().Name}: {Journal.Scrub(inner.Message)} at {string.Join(" < ",frames)}";
    }
    private static void Save(Exception error) {
        try {
            Directory.CreateDirectory(Path.GetDirectoryName(File_)!);
            var version=typeof(Crash).Assembly.GetName().Version?.ToString(3)??"0";
            System.IO.File.WriteAllText(File_,new JsonObject {["at"]=DateTimeOffset.UtcNow.ToString("O"),["detail"]=$"{version} {Describe(error)}"}.ToJsonString());
            Journal.Add("crash: "+Describe(error));
        } catch {/* crashing anyway */}
    }
    /// Sends the last crash once, when signed in.
    public static async Task Send(NativeApi api) {
        if(!api.SignedIn||!System.IO.File.Exists(File_)) return;
        try {
            var saved=JsonNode.Parse(System.IO.File.ReadAllText(File_));
            System.IO.File.Delete(File_);
            await api.Report("APP_CRASH",detail:saved?["detail"]?.GetValue<string>()??"",at:saved?["at"]?.GetValue<string>());
        } catch {/* next start */}
    }
}
