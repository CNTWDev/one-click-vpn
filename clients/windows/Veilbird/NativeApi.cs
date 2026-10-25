using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Veilbird;
public sealed class AccessFailure(string code) : Exception(code) {
    public string Code {get;}=code;
    public override string Message => Code switch {
        "DEVICE_LIMIT_REACHED" => L10n.Text("device_limit_reached_revoke_an_old_device_and_try"),
        "DEVICE_REVOKED" => L10n.Text("access_for_this_device_has_been_revoked_contact_your"),
        "AUTH_REQUIRED" => L10n.Text("your_session_has_expired_sign_in_again"),
        "INVALID_CREDENTIALS" => L10n.Text("incorrect_email_or_password"),
        "CLIENT_ACCESS_NOT_ENABLED" => L10n.Text("client_access_is_not_enabled_on_the_server"),
        "MANAGED_ACCESS_REQUIRED" => L10n.Text("ask_your_administrator_to_enable_veilbird_client_access"),
        "CLIENT_UPDATE_REQUIRED" => L10n.Text("client_update_required"),
        "NODE_UNAVAILABLE" => L10n.Text("this_location_is_unavailable_try_another"),
        "MEMBERSHIP_EXPIRED" => L10n.Text("membership_expired_hint"),
        "QUOTA_EXHAUSTED" => L10n.Text("quota_exhausted_hint"),
        "ACCESS_EXPIRED" => L10n.Text("connection_authorization_expired_connect_again"),
        "RATE_LIMITED" => L10n.Text("too_many_attempts_try_again_later"),
        "PASSWORD_RESET_UNAVAILABLE" => L10n.Text("password_reset_unavailable"),
        "INVALID_EMAIL" => L10n.Text("enter_a_valid_email"),
        _ => L10n.Text("unable_to_reach_the_service_check_your_network_or")
    };
}
/// <summary>
/// The TrackNothing API. Calls go through the core (Core.Fetch), which tries the address the user entered, the
/// other API domains the server lists (every site plus backup domains), addresses that worked before, and DNS
/// over HTTPS, so a blocked domain or poisoned DNS does not lock the app out.
/// </summary>
public sealed class NativeApi : IDisposable {
    private readonly Core core;
    private readonly string folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Veilbird");
    private readonly ECDsa identity;
    public NativeApi(Core core) {
        this.core=core;
        Directory.CreateDirectory(folder);
        identity=ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var key=Read("identity");
        if(key is null) Save("identity",identity.ExportPkcs8PrivateKey());
        else identity.ImportPkcs8PrivateKey(key,out _);
    }
    public string Origin {get;set;}="";
    private string Entered=>Origin.Trim().TrimEnd('/');
    /// Every origin of this server, best first: the one that answered last, the others the server listed, and the
    /// address the user entered. Another address entered means another server: only that address until it answers.
    private List<string> Origins() {
        var saved=Read("origins") is { } data?Encoding.UTF8.GetString(data).Split('\n',StringSplitOptions.RemoveEmptyEntries).ToList():[];
        return saved.Contains(Entered)?saved:[Entered];
    }
    private void Remember(string? answered,JsonArray? offered) {
        var list=Origins();
        if(offered is not null) list=offered.Select(o=>o?.GetValue<string>()??"").Where(o=>o.StartsWith("https://",StringComparison.Ordinal)).Take(12).Append(Entered).ToList();
        if(answered is { Length: >0 }) {list.Remove(answered);list.Insert(0,answered);}
        Save("origins",Encoding.UTF8.GetBytes(string.Join('\n',list.Distinct().Take(14))));
    }
    public bool SignedIn=>Read("token") is not null;
    public string SavedOrigin=>Read("origin") is { } value?Encoding.UTF8.GetString(value):"";
    private byte[]? Read(string name) {
        var path=Path.Combine(folder,name+".bin");
        return File.Exists(path)?ProtectedData.Unprotect(File.ReadAllBytes(path),null,DataProtectionScope.CurrentUser):null;
    }
    private void Save(string name,byte[]? data) {
        var path=Path.Combine(folder,name+".bin");
        if(data is null) {File.Delete(path);return;}
        var temporary=path+".tmp";
        File.WriteAllBytes(temporary,ProtectedData.Protect(data,null,DataProtectionScope.CurrentUser));
        File.Move(temporary,path,true);
    }
    /// Set for one connection attempt: the server's runtime log lines for it carry the same id.
    public string? Attempt {get;set;}
    private static bool ValidOrigin(string value)=>Uri.TryCreate(value,UriKind.Absolute,out var origin)&&origin.Scheme=="https"&&origin.UserInfo==""&&origin.Query==""&&origin.Fragment==""&&origin.AbsolutePath=="/";
    /// One call through the core; (status, body) of the first origin that answered.
    private async Task<(int Status,string Body)> Send(string method,string path,JsonObject? body,Dictionary<string,string> headers,int timeoutMs=15000) {
        if(!ValidOrigin(Entered+"/")) throw new AccessFailure("SERVER_REQUIRED");
        var origins=Origins();
        var request=new JsonObject {["origins"]=new JsonArray(origins.Select(o=>(JsonNode)o).ToArray()),["method"]=method,["path"]=path,["timeoutMs"]=timeoutMs};
        var all=new JsonObject();foreach(var (name,value) in headers) all[name]=value;
        if(body is not null) {all["Content-Type"]="application/json";request["body"]=body.ToJsonString();}
        request["headers"]=all;
        var reply=JsonNode.Parse(await core.Fetch(request.ToJsonString())) as JsonObject ?? throw new AccessFailure("SERVICE_UNAVAILABLE");
        if(reply["error"]?.GetValue<string>() is { Length: >0 } error) {Journal.Add("api: unreachable ("+Journal.Scrub(error)+")");throw new AccessFailure("SERVICE_UNAVAILABLE");}
        if(reply["origin"]?.GetValue<string>() is { Length: >0 } answered&&answered!=origins[0]) {Journal.Add("api: answered by another address");Remember(answered,null);}
        return (reply["status"]?.GetValue<int>()??0,reply["body"]?.GetValue<string>()??"");
    }
    public async Task<JsonObject> Request(string path,JsonObject? body=null) {
        var headers=new Dictionary<string,string> {["X-Veilbird-Client"]=ClientAgent};
        if(Attempt is { } attempt) headers["X-Request-Id"]=attempt;
        if(path!="login" && Read("token") is { } token) headers["Authorization"]="Bearer "+Encoding.UTF8.GetString(token);
        var (status,text)=await Send(body is null?"GET":"POST","/api/v2/native/"+path,body,headers);
        var json=(text.Length>0?JsonNode.Parse(text):null) as JsonObject ?? throw new AccessFailure("INVALID_RESPONSE");
        if(status is <200 or >=300) throw new AccessFailure(json["code"]?.GetValue<string>()??"SERVICE_UNAVAILABLE");
        if(json["apiOrigins"] is JsonArray offered) Remember(null,offered);
        return json;
    }
    /// Public release catalog: the operator's announcement, and a newer build for this install if one is published.
    public async Task<(string Announcement,(string Version,bool Mandatory,Uri Download)? Update)?> LatestRelease() {
        if(!ValidOrigin(Entered+"/")) return null;
        var origin=new Uri(Entered+"/");
        var installation=Read("installation") is { } saved?Encoding.UTF8.GetString(saved):Guid.NewGuid().ToString();Save("installation",Encoding.UTF8.GetBytes(installation));
        var build=ClientAgent[(ClientAgent.IndexOf('+')+1)..];
        var (status,text)=await Send("GET",$"/api/v1/client-releases/latest?platform=windows&arch={(System.Runtime.InteropServices.RuntimeInformation.OSArchitecture==System.Runtime.InteropServices.Architecture.Arm64?"arm64":"x64")}&build={build}&installation={installation}",null,new());
        if(status is <200 or >=300) return null;
        var json=JsonNode.Parse(text) as JsonObject;
        if(json is null) return null;
        var announcement=json["announcement"]?.GetValue<string>() is { } text?text[..Math.Min(text.Length,500)]:"";
        if(json["updateAvailable"]?.GetValue<bool>()!=true||json["latest"]?["version"]?.GetValue<string>() is not { } version) return (announcement,null);
        // The permanent link always resolves to the current stable installer.
        return (announcement,(version,json["mandatory"]?.GetValue<bool>()==true,new Uri(origin,json["downloadPath"]?.GetValue<string>()??"/download/windows")));
    }
    /// windows/0.1.0+1 (the fourth assembly version field is the build number; CI sets it per release).
    private static readonly string ClientAgent=typeof(NativeApi).Assembly.GetName().Version is { } v?$"windows/{v.Major}.{v.Minor}.{Math.Max(0,v.Build)}+{Math.Max(1,v.Revision)}":"windows/0.0.0+1";
    private static string B64(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
    public async Task Login(string email,string password) {
        var key=identity.ExportParameters(false);
        var result=await Request("login",new JsonObject { ["email"]=email,["password"]=password,["platform"]="windows",["deviceName"]=Environment.MachineName,
            ["identityKey"]=new JsonObject {["kty"]="EC",["crv"]="P-256",["x"]=B64(key.Q.X!),["y"]=B64(key.Q.Y!)} });
        Save("token",Encoding.UTF8.GetBytes(result["accessToken"]!.GetValue<string>()));Save("origin",Encoding.UTF8.GetBytes(Origin));
    }
    /// Emails the Portal's reset link; the answer is the same whether or not the address has an account.
    public async Task RequestPasswordReset(string email)=>await Request("password-reset",new JsonObject {["email"]=email,["language"]=L10n.Culture.TwoLetterISOLanguageName});
    public async Task<JsonObject> Action(string action,JsonObject input) {
        var challenge=await Request("challenge",new JsonObject {["action"]=action,["request"]=input.DeepClone()});
        var encoded=challenge["payload"]!.GetValue<string>().Replace('-','+').Replace('_','/');
        var bytes=Convert.FromBase64String(encoded.PadRight((encoded.Length+3)/4*4,'='));
        var signature=identity.SignData(bytes,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return await Request(action,new JsonObject {["challengeId"]=challenge["id"]!.GetValue<string>(),["signature"]=B64(signature),["request"]=input.DeepClone()});
    }
    /// Connection failure codes and scrubbed error texts for the Console (no keys, addresses or traffic); best effort.
    public async Task Report(string code,string nodeId="",string detail="",string network="",string? at=null) {
        var item=new JsonObject {["code"]=code,["at"]=at??DateTimeOffset.UtcNow.ToString("O")};
        if(nodeId.Length>0) item["nodeId"]=nodeId;
        if(detail.Length>0) item["detail"]=detail;
        if(network.Length>0) item["network"]=network;
        if(Attempt is { } attempt) item["attempt"]=attempt;
        try {await Request("diagnostics",new JsonObject {["events"]=new JsonArray(item)});} catch {/* diagnostics never block connecting */}
    }
    public async Task Logout() {try {await Request("logout",new JsonObject());}finally {Save("token",null);}}
    public void Dispose()=>identity.Dispose();
}
