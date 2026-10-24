using System.Diagnostics;
using System.IO;
using System.Text;

namespace Veilbird;

/// <summary>
/// The embedded mihomo core (veilbird-core.exe, built from clients/core) as a child process. It creates the
/// TrackNothing tun adapter (wintun, needs the administrator rights the app runs with) and carries all traffic.
/// Commands go over stdin/stdout one line at a time, so the configuration with keys never touches the disk and
/// no local control port exists. The core exits when its stdin closes, including when this app dies.
/// </summary>
public sealed class Core : IDisposable {
    private readonly object gate=new();
    private Process? process;
    private readonly string home=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"Veilbird","core");

    private Process Running() {
        if(process is { HasExited: false }) return process;
        Directory.CreateDirectory(home);
        var start=new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory,"veilbird-core.exe")) {
            UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,
            StandardOutputEncoding=Encoding.UTF8,StandardInputEncoding=new UTF8Encoding(false),
        };
        start.ArgumentList.Add("-d");start.ArgumentList.Add(home);
        process=Process.Start(start) ?? throw new IOException("core did not start");
        return process;
    }
    private string Call(string line) {
        lock(gate) {
            var core=Running();
            core.StandardInput.WriteLine(line);core.StandardInput.Flush();
            return core.StandardOutput.ReadLine() ?? throw new IOException("core exited");
        }
    }
    /// Applies a full configuration; the tun comes up with it.
    public void Start(string configuration) {
        var reply=Call("start "+Convert.ToBase64String(Encoding.UTF8.GetBytes(configuration)));
        if(reply!="ok") throw new IOException(reply);
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
        lock(gate) {
            if(process is not { HasExited: false }) return;
            try {process.StandardInput.Close();if(!process.WaitForExit(5000)) process.Kill();} catch {/* exiting anyway */}
        }
    }
}
