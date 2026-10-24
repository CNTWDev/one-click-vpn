using System.Diagnostics;
namespace Veilbird;

public static class Program {
    [STAThread]
    public static int Main(string[] args) {
        // One instance owns the core and the tunnel; a second launch brings the first window back instead.
        using var instance=new Mutex(true,@"Global\TrackNothing.Instance",out var first);
        using var show=new EventWaitHandle(false,EventResetMode.AutoReset,@"Global\TrackNothing.Show");
        if(!first) {show.Set();return 0;}
        StopLegacyTunnel();
        var app=new App();app.InitializeComponent();
        // Started by the "open at login" task with --background: only the tray icon appears.
        var window=new MainWindow();app.MainWindow=window;
        if(!args.Contains("--background")) window.Show();
        var waiter=new Thread(()=>{while(show.WaitOne()) app.Dispatcher.InvokeAsync(()=>(app.MainWindow as MainWindow)?.ShowFromTray());}) {IsBackground=true};
        waiter.Start();
        return app.Run();
    }
    /// Versions before the built-in core ran WireGuard as a service named after the app; stop one left behind.
    private static void StopLegacyTunnel() {
        try {using var sc=Process.Start(new ProcessStartInfo("sc.exe","stop \"WireGuardTunnel$Veilbird\"") {CreateNoWindow=true,UseShellExecute=false});sc?.WaitForExit(5000);}
        catch {/* nothing to stop */}
    }
}
