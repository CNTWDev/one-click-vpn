using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>
/// WireGuard engine on Windows: the official embeddable tunnel service (tunnel.dll + wireguard.dll from
/// wireguard-windows, MIT/GPL-compatible redistribution). The tunnel runs as its own Windows service, which
/// handles routes, DNS and the leak-blocking firewall; the UI only writes a config, starts it and reads stats.
/// See wireguard-windows/embeddable-dll-service/README.md for the service contract followed here.
/// </summary>
public static class Tunnel {
    public const string Name="Veilbird";
    private const string ServiceName="WireGuardTunnel$"+Name;
    // Administrators and SYSTEM only: the file holds the device's tunnel private key.
    private static readonly string Folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"Veilbird");
    private static string ConfigPath=>Path.Combine(Folder,Name+".conf");

    [DllImport("tunnel.dll",EntryPoint="WireGuardTunnelService",CallingConvention=CallingConvention.Cdecl)]
    [return:MarshalAs(UnmanagedType.I1)]
    private static extern bool RunService([MarshalAs(UnmanagedType.LPWStr)] string configFile);
    [DllImport("tunnel.dll",EntryPoint="WireGuardGenerateKeypair",CallingConvention=CallingConvention.Cdecl)]
    private static extern void GenerateKeypair(byte[] publicKey,byte[] privateKey);

    /// Entry point of `Veilbird.exe /service <conf>` (started by the service manager, never by the UI).
    public static int Service(string configFile)=>RunService(configFile)?0:1;

    public static (string Public,string Private) NewKeypair() {
        var publicKey=new byte[32];var privateKey=new byte[32];
        GenerateKeypair(publicKey,privateKey);
        return (Convert.ToBase64String(publicKey),Convert.ToBase64String(privateKey));
    }

    /// Writes the config from a connect lease and (re)starts the service. Ephemeral: the service is deleted right
    /// after it starts, so it disappears when stopped and never comes back after a reboot or a crashed UI.
    public static void Start(JsonObject lease,string privateKey) {
        var wg=lease["wireguard"]!.AsObject();
        var dns=string.Join(", ",wg["dns"]!.AsArray().Select(item=>item!.GetValue<string>()));
        var config=$"""
            [Interface]
            PrivateKey = {privateKey}
            Address = {wg["address"]!.GetValue<string>()}
            DNS = {dns}
            MTU = 1280

            [Peer]
            PublicKey = {wg["serverPublicKey"]!.GetValue<string>()}
            Endpoint = {wg["endpoint"]!.GetValue<string>()}
            AllowedIPs = 0.0.0.0/0, ::/0
            PersistentKeepalive = 25
            """;
        Stop();
        var folder=Directory.CreateDirectory(Folder);
        var acl=new DirectorySecurity();
        acl.SetAccessRuleProtection(true,false);
        foreach(var sid in new[]{WellKnownSidType.BuiltinAdministratorsSid,WellKnownSidType.LocalSystemSid})
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid,null),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        folder.SetAccessControl(acl);
        File.WriteAllText(ConfigPath,config);
        var scm=OpenSCManager(null,null,0xF003F);
        if(scm==IntPtr.Zero) throw new Win32Exception();
        try {
            var command=$"\"{Environment.ProcessPath}\" /service \"{ConfigPath}\"";
            var service=CreateService(scm,ServiceName,"TrackNothing",0xF01FF,0x10,3,1,command,null,IntPtr.Zero,"Nsi\0TcpIp\0",null,null);
            if(service==IntPtr.Zero) throw new Win32Exception();
            try {
                var sidType=1; // SERVICE_SID_TYPE_UNRESTRICTED: required by the tunnel service.
                if(!ChangeServiceConfig2(service,5,ref sidType)) throw new Win32Exception();
                if(!StartService(service,0,null)) throw new Win32Exception();
                DeleteService(service);
            } finally {CloseServiceHandle(service);}
        } finally {CloseServiceHandle(scm);}
    }

    /// Stops the tunnel (if any) and waits until the adapter and firewall rules are gone.
    public static void Stop() {
        var scm=OpenSCManager(null,null,0xF003F);
        if(scm==IntPtr.Zero) return;
        try {
            var service=OpenService(scm,ServiceName,0xF01FF);
            if(service==IntPtr.Zero) return;
            try {
                var status=new byte[28];
                ControlService(service,1,status);
                for(var i=0;i<30&&QueryServiceStatus(service,status)&&BinaryPrimitives.ReadInt32LittleEndian(status.AsSpan(4))!=1;i++) Thread.Sleep(500);
                DeleteService(service);
            } finally {CloseServiceHandle(service);}
        } finally {CloseServiceHandle(scm);}
        try {File.Delete(ConfigPath);} catch(IOException) {}
    }

    public static bool Running {get {
        var scm=OpenSCManager(null,null,0x0001);
        if(scm==IntPtr.Zero) return false;
        try {
            var service=OpenService(scm,ServiceName,0x0004);
            if(service==IntPtr.Zero) return false;
            try {var status=new byte[28];return QueryServiceStatus(service,status)&&BinaryPrimitives.ReadInt32LittleEndian(status.AsSpan(4)) is 2 or 4;}
            finally {CloseServiceHandle(service);}
        } finally {CloseServiceHandle(scm);}
    }}

    /// Last handshake and byte counters of the single peer, read from the wireguard-nt adapter.
    public static (DateTime? Handshake,ulong Tx,ulong Rx)? Stats() {
        var adapter=WireGuardOpenAdapter(Name);
        if(adapter==IntPtr.Zero) return null;
        try {
            uint size=1024;byte[] buffer;
            for(;;) {
                buffer=new byte[size];
                if(WireGuardGetConfiguration(adapter,buffer,ref size)) break;
                if(Marshal.GetLastWin32Error()!=234) return null; // ERROR_MORE_DATA: retry with the size returned
            }
            // WIREGUARD_INTERFACE is 80 bytes (PeersCount at 72); the first WIREGUARD_PEER follows it,
            // with TxBytes at 104, RxBytes at 112 and LastHandshake (FILETIME) at 120.
            if(BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(72))==0) return (null,0,0);
            var peer=buffer.AsSpan(80);
            var handshake=BinaryPrimitives.ReadInt64LittleEndian(peer[120..]);
            return (handshake>0?DateTime.FromFileTimeUtc(handshake):null,BinaryPrimitives.ReadUInt64LittleEndian(peer[104..]),BinaryPrimitives.ReadUInt64LittleEndian(peer[112..]));
        } finally {WireGuardCloseAdapter(adapter);}
    }

    [DllImport("wireguard.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr WireGuardOpenAdapter(string name);
    [DllImport("wireguard.dll")] private static extern void WireGuardCloseAdapter(IntPtr adapter);
    [DllImport("wireguard.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool WireGuardGetConfiguration(IntPtr adapter,byte[] config,ref uint bytes);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr OpenSCManager(string? machine,string? database,uint access);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr OpenService(IntPtr scm,string name,uint access);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] private static extern IntPtr CreateService(IntPtr scm,string name,string displayName,uint access,uint type,uint start,uint error,string path,string? group,IntPtr tag,string dependencies,string? user,string? password);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool ChangeServiceConfig2(IntPtr service,uint level,ref int info);
    [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool StartService(IntPtr service,uint count,string[]? args);
    [DllImport("advapi32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool ControlService(IntPtr service,uint control,byte[] status);
    [DllImport("advapi32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool QueryServiceStatus(IntPtr service,byte[] status);
    [DllImport("advapi32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll")] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool CloseServiceHandle(IntPtr handle);
}
