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
    public static Trouble For(string code,string node,bool automatic,string fallback) {
        var retry=L10n.Text("retry_action");
        return code switch {
            "DEVICE_LIMIT_REACHED"=>new(L10n.Text("error_device_title"),L10n.Text("error_device_detail"),L10n.Text("manage_devices_action"),"devices",retry,"retry"),
            "HANDSHAKE_TIMEOUT" or "NODE_UNAVAILABLE" or "NODE_FULL"=>automatic
                ?new(L10n.Text("error_node_title",node),L10n.Text("error_node_auto_detail"),retry,"retry",L10n.Text("change_location_action"),"nodes")
                :new(L10n.Text("error_node_title",node),L10n.Text("error_node_detail"),L10n.Text("use_automatic_action"),"automatic",L10n.Text("change_location_action"),"nodes"),
            "MEMBERSHIP_EXPIRED"=>new(L10n.Text("error_expired_title"),L10n.Text("error_expired_detail"),retry,"retry"),
            "QUOTA_EXHAUSTED"=>new(L10n.Text("error_quota_title"),L10n.Text("error_quota_detail"),retry,"retry"),
            "AUTH_REQUIRED"=>new(L10n.Text("error_session_title"),L10n.Text("error_session_detail"),L10n.Text("sign_in_again_action"),"signin"),
            "DEVICE_REVOKED"=>new(L10n.Text("error_revoked_title"),L10n.Text("error_revoked_detail"),L10n.Text("view_account_action"),"account"),
            "CLIENT_UPDATE_REQUIRED"=>new(L10n.Text("error_update_title"),L10n.Text("error_update_detail"),L10n.Text("update_now"),"update"),
            "ACCESS_EXPIRED" or "LEASE_RENEWAL_FAILED"=>new(L10n.Text("error_lease_title"),L10n.Text("error_lease_detail"),L10n.Text("connect_again_action"),"retry"),
            "ACCOUNT_UNAVAILABLE" or "MANAGED_ACCESS_REQUIRED" or "CLIENT_ACCESS_NOT_ENABLED"=>new(L10n.Text("error_account_title"),fallback,retry,"retry"),
            "CONNECT_FAILED" or "TUNNEL_ERROR"=>new(L10n.Text("connect_failed_title"),fallback,retry,"retry"),
            _=>new(L10n.Text("error_service_title"),L10n.Text("error_service_detail_desktop"),retry,"retry")
        };
    }
}
