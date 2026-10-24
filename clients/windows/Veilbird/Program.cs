namespace Veilbird;

public static class Program {
    [STAThread]
    public static int Main(string[] args) {
        // The tunnel service runs this same executable; it must not start any UI.
        if(args.Length==2&&args[0]=="/service") return Tunnel.Service(args[1]);
        var app=new App();app.InitializeComponent();
        return app.Run();
    }
}
