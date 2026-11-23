namespace Veilbird;

/// The connection as the person sees it, the same seven states on every client (Android Guidance.kt, Apple RingState):
/// each has one drawing of the portrait, one title, one detail and one action.
public enum LinkState {Idle,Connecting,Switching,Connected,Reconnecting,Waiting,Failed}

/// What went wrong, said as the cause, the next step and the button that takes it (the second one is optional).
public sealed record Trouble(string Title,string Detail,string Primary,string PrimaryDo,string? Secondary=null,string? SecondaryDo=null);

public static class Guidance {
    public static LinkState State(Connection c) {
        if(!c.Active) return c.ErrorCode.Length>0?LinkState.Failed:LinkState.Idle;
        return c.StatusKey switch {
            "waiting_for_network"=>LinkState.Waiting,
            "reconnecting_status" or "location_retrying"=>LinkState.Reconnecting,
            "confirming_connection_status"=>c.Since is null?LinkState.Connecting:LinkState.Switching,
            _=>c.Since is null?LinkState.Connecting:LinkState.Connected
        };
    }
    /// Seconds until the next try while reconnecting.
    public static int Countdown(Connection c)=>c.RetryAt is { } at?Math.Max(0,(int)Math.Ceiling((at-DateTime.UtcNow).TotalSeconds)):0;
    public static string Phase(Connection c)=>L10n.Text(c.Phase switch {0=>"phase_route",1=>"phase_tunnel",_=>"phase_confirm"});

    /// The cause of the last failure. [automatic]: the location is left to the app; [fallback]: the error's own text.
    /// Actions: retry, devices, automatic, nodes, signin, account, update.
    public static Trouble For(string code,string node,bool automatic,string fallback,string network="ok") {
        var retry=L10n.Text("retry_action");var send=L10n.Text("send_check_action");
        // The network explains a network failure first: no network at all outside the VPN.
        if(OfNetwork.Contains(code)&&network=="offline") return new(L10n.Text("error_no_internet_title"),L10n.Text("error_no_internet_detail"),L10n.Text("open_network_settings"),"wifi",retry,"retry");
        return code switch {
            "DEVICE_LIMIT_REACHED"=>new(L10n.Text("error_device_title"),L10n.Text("error_device_detail"),L10n.Text("manage_devices_action"),"devices",retry,"retry"),
            // Automatic already tried the fastest locations: the server answered, the lines did not.
            "HANDSHAKE_TIMEOUT"=>automatic
                ?new(L10n.Text("error_lines_title"),L10n.Text("error_lines_detail"),L10n.Text("change_location_action"),"nodes",send,"send")
                :new(L10n.Text("error_node_title",node),L10n.Text("error_node_detail"),L10n.Text("use_automatic_action"),"automatic",send,"send"),
            "NODE_UNAVAILABLE" or "NODE_FULL"=>automatic
                ?new(L10n.Text("error_node_title",node),L10n.Text("error_node_auto_detail"),retry,"retry",L10n.Text("change_location_action"),"nodes")
                :new(L10n.Text("error_node_title",node),L10n.Text("error_node_detail"),L10n.Text("use_automatic_action"),"automatic",L10n.Text("change_location_action"),"nodes"),
            "MEMBERSHIP_EXPIRED"=>new(L10n.Text("error_expired_title"),L10n.Text("error_expired_detail"),retry,"retry"),
            "QUOTA_EXHAUSTED"=>new(L10n.Text("error_quota_title"),L10n.Text("error_quota_detail"),retry,"retry"),
            "AUTH_REQUIRED"=>new(L10n.Text("error_session_title"),L10n.Text("error_session_detail"),L10n.Text("sign_in_again_action"),"signin"),
            "DEVICE_REVOKED"=>new(L10n.Text("error_revoked_title"),L10n.Text("error_revoked_detail"),L10n.Text("view_account_action"),"account"),
            "CLIENT_UPDATE_REQUIRED"=>new(L10n.Text("error_update_title"),L10n.Text("error_update_detail"),L10n.Text("update_now"),"update"),
            "ACCESS_EXPIRED" or "LEASE_RENEWAL_FAILED"=>new(L10n.Text("error_lease_title"),L10n.Text("error_lease_detail"),L10n.Text("connect_again_action"),"retry"),
            "ACCOUNT_UNAVAILABLE" or "MANAGED_ACCESS_REQUIRED" or "CLIENT_ACCESS_NOT_ENABLED"=>new(L10n.Text("error_account_title"),fallback,retry,"retry"),
            "CONNECT_FAILED" or "TUNNEL_ERROR"=>new(L10n.Text("connect_failed_title"),fallback,retry,"retry",send,"send"),
            _=>new(L10n.Text("error_service_title"),L10n.Text("error_service_detail_desktop"),retry,"retry")
        };
    }
    /// Failures the network itself can cause (no network then explains them better).
    private static readonly HashSet<string> OfNetwork=new() {"SERVICE_UNAVAILABLE","HANDSHAKE_TIMEOUT","CONNECT_FAILED","TUNNEL_ERROR"};
    /// The four steps a connection takes (network, server, lines, tunnel) and where the last attempt stopped, for
    /// failures of the network itself; null for a refusal of the account or the device, which has its own cause.
    public static List<Check>? Checks(string code,int lines,string network) {
        var ok=L10n.Text("diag_ok");var skip=L10n.Text("diag_not_started");
        Check Row(string key,string value,CheckStatus status)=>new(key,key switch {"network"=>L10n.Text("diag_network"),"server"=>L10n.Text("diag_server"),"lines"=>L10n.Text("diag_lines"),_=>L10n.Text("diag_tunnel")},value,status);
        var net=network=="offline"?Row("network",L10n.Text("diag_no_internet"),CheckStatus.Bad):Row("network",ok,CheckStatus.Ok);
        if(net.Status==CheckStatus.Bad&&OfNetwork.Contains(code)) return new() {net,Row("server",skip,CheckStatus.Skip),Row("lines",skip,CheckStatus.Skip),Row("tunnel",skip,CheckStatus.Skip)};
        var reached=Row("server",L10n.Text("diag_reached"),CheckStatus.Ok);
        return code switch {
            "SERVICE_UNAVAILABLE"=>new() {net,Row("server",L10n.Text("diag_unreached"),CheckStatus.Bad),Row("lines",skip,CheckStatus.Skip),Row("tunnel",skip,CheckStatus.Skip)},
            "HANDSHAKE_TIMEOUT"=>new() {net,reached,Row("lines",lines>0?L10n.Text("diag_lines_blocked",lines.ToString(L10n.Culture)):L10n.Text("diag_all_blocked"),CheckStatus.Bad),Row("tunnel",skip,CheckStatus.Skip)},
            "CONNECT_FAILED" or "TUNNEL_ERROR"=>new() {net,reached,Row("lines",skip,CheckStatus.Skip),Row("tunnel",L10n.Text("diag_tunnel_failed"),CheckStatus.Bad)},
            _=>null
        };
    }
    /// The check as one line for the report a person sends: "network=ok server=bad lines=skip tunnel=skip net=ok code=…".
    public static string Summary(string code,int lines,string network)=>Checks(code,lines,network) is { } rows
        ?string.Join(" ",rows.Select(r=>$"{r.Key}={(r.Status==CheckStatus.Ok?"ok":r.Status==CheckStatus.Bad?"bad":"skip")}"))+$" net={network} code={code}"
        :$"code={code}";
    /// The second line while connected over a line the network forced, or null.
    public static string? Bypass(string value)=>value.StartsWith("udp:")?L10n.Text("bypass_udp",Label(value[4..])):value=="port"?L10n.Text("bypass_port"):null;
    public static string Label(string transport)=>transport switch {"hysteria2"=>"Hysteria2","reality" or "reality-alt"=>"REALITY","xhttp"=>"XHTTP","wireguard"=>"WireGuard",_=>transport};
}

public enum CheckStatus {Ok,Bad,Skip}
/// One row of the check shown under a failure: what was checked, what it found, and whether that step passed.
public sealed record Check(string Key,string Label,string Value,CheckStatus Status);
