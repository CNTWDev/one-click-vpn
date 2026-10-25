using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Veilbird;

/// <summary>
/// The embedded mihomo core (veilbird-core.exe, built from clients/core) as a child process. It creates the
/// TrackNothing tun adapter (wintun, needs the administrator rights the app runs with) and carries all traffic.
/// Commands go over stdin/stdout one line at a time, so the configuration with keys never touches the disk and
/// no local control port exists. The core exits when its stdin closes, including when this app dies.
/// Commands are answered in order, except fetch (API calls) and download (updates), which answer "fetch:id ..."
/// and "download:id ..." whenever they are done.
/// </summary>
public sealed class Core : IDisposable {
    // gate keeps one ordinary command waiting for its answer at a time; writing guards the pipe and the process.
    private readonly object gate=new(),writing=new();
    private Process? process;
    private BlockingCollection<string> replies=new();
    private readonly ConcurrentDictionary<string,TaskCompletionSource<string>> fetches=new();
    private readonly string home=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"Veilbird","core");

    private Process Running() {
        if(process is { HasExited: false }) return process;
        Directory.CreateDirectory(home);
        var start=new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory,"veilbird-core.exe")) {
            UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,
            StandardOutputEncoding=Encoding.UTF8,StandardInputEncoding=new UTF8Encoding(false),
        };
        start.ArgumentList.Add("-d");start.ArgumentList.Add(home);
        var started=Process.Start(start) ?? throw new IOException("core did not start");
        var lines=new BlockingCollection<string>();replies=lines;
        new Thread(()=>Read(started,lines)) {IsBackground=true,Name="core"}.Start();
        process=started;
        return started;
    }
    private void Read(Process core,BlockingCollection<string> lines) {
        try {
            while(core.StandardOutput.ReadLine() is { } line) {
                var prefix=line.StartsWith("fetch:",StringComparison.Ordinal)?6:line.StartsWith("download:",StringComparison.Ordinal)?9:0;
                if(prefix>0) {
                    var space=line.IndexOf(' ');
                    if(space>prefix&&fetches.TryRemove(line[prefix..space],out var waiting)) waiting.TrySetResult(line[(space+1)..]);
                } else lines.Add(line);
            }
        } catch(IOException) {/* exited */}
        lines.CompleteAdding();
        foreach(var id in fetches.Keys) if(fetches.TryRemove(id,out var waiting)) waiting.TrySetException(new IOException("core exited"));
    }
    private string Call(string line) {
        lock(gate) {
            BlockingCollection<string> answers;
            lock(writing) {var core=Running();answers=replies;core.StandardInput.WriteLine(line);core.StandardInput.Flush();}
            try {return answers.Take();} catch(InvalidOperationException) {throw new IOException("core exited");}
        }
    }
    /// One API call (core.Fetch: every known origin, cached addresses first, DNS over HTTPS); JSON in and out.
    public async Task<string> Fetch(string request) {
        var id=Guid.NewGuid().ToString("N")[..12];
        var answer=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        fetches[id]=answer;
        lock(writing) {
            var core=Running();
            core.StandardInput.WriteLine($"fetch {id} {Convert.ToBase64String(Encoding.UTF8.GetBytes(request))}");core.StandardInput.Flush();
        }
        return await answer.Task.WaitAsync(TimeSpan.FromSeconds(60));
    }
    /// An update installer (core.Download: mirror first, then every API origin, resuming); status JSON when it ends.
    public async Task<string> Download(string request) {
        var id=Guid.NewGuid().ToString("N")[..12];
        var answer=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        fetches[id]=answer;
        lock(writing) {
            var core=Running();
            core.StandardInput.WriteLine($"download {id} {Convert.ToBase64String(Encoding.UTF8.GetBytes(request))}");core.StandardInput.Flush();
        }
        return await answer.Task;
    }
    /// The running download's status JSON (received, size, seconds left).
    public string Progress()=>Call("progress");
    /// Stops the download; its partial file stays and resumes next time.
    public void CancelDownload() {try {Call("cancel");} catch(IOException) {/* gone */}}
    /// Kill switch: while on, Windows lets traffic out only through the tunnel (WFP rules held by the core).
    public void KillSwitch(bool on) {
        var reply=Call("killswitch "+(on?"on":"off"));
        if(reply!="ok") throw new IOException(reply);
    }
    /// Builds and applies the configuration from Transports.Options; the tun comes up with it. Returns why the
    /// kill switch could not be applied, or null.
    public string? Run(string options) {
        var reply=Call("run "+Convert.ToBase64String(Encoding.UTF8.GetBytes(options)));
        if(reply.StartsWith("ok killswitch ",StringComparison.Ordinal)) return reply[14..];
        if(reply!="ok") throw new IOException(reply);
        return null;
    }
    /// Tests the named transports at once through url; -1 means no answer.
    public Dictionary<string,long> Probe(IEnumerable<string> names,int timeoutMs)=>
        Transports.ParseProbe(Call($"probe {string.Join(',',names)} {Transports.TestUrl} {timeoutMs}"));
    public string Now(string group)=>Call("now "+group);
    public (long Up,long Down) Rate() {
        var parts=Call("rate").Split(' ');
        return parts.Length==2&&long.TryParse(parts[0],out var up)&&long.TryParse(parts[1],out var down)?(up,down):(0,0);
    }
    /// Removes the tun and closes every connection; the process stays for the next connection.
    public void Stop() {try {Call("stop");} catch(IOException) {/* already gone */}}
    /// A WireGuard key pair generated on this PC; the private key never leaves it.
    public (string Public,string Private) NewKeypair() {
        var parts=Call("keypair").Split(' ');
        if(parts.Length!=2||parts[0]=="error") throw new IOException("keypair");
        return (parts[1],parts[0]);
    }
    public void Dispose() {
        lock(writing) {
            if(process is not { HasExited: false }) return;
            try {process.StandardInput.Close();if(!process.WaitForExit(5000)) process.Kill();} catch {/* exiting anyway */}
        }
    }
}
