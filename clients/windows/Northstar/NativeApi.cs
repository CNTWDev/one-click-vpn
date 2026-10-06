using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Northstar;
public sealed class AccessFailure(string code) : Exception(code) {
    public string Code {get;}=code;
    public override string Message => Code switch {
        "DEVICE_LIMIT_REACHED" => L10n.Text("device_limit_reached_revoke_an_old_device_and_try"),
        "DEVICE_REVOKED" => L10n.Text("access_for_this_device_has_been_revoked_contact_your"),
        "AUTH_REQUIRED" => L10n.Text("your_session_has_expired_sign_in_again"),
        "INVALID_CREDENTIALS" => L10n.Text("incorrect_email_or_password"),
        "CLIENT_ACCESS_NOT_ENABLED" => L10n.Text("client_access_is_not_enabled_on_the_server"),
        "MANAGED_ACCESS_REQUIRED" => L10n.Text("ask_your_administrator_to_enable_northstar_client_access"),
        "CLIENT_UPDATE_REQUIRED" => L10n.Text("client_update_required"),
        _ => L10n.Text("unable_to_reach_the_service_check_your_network_or")
    };
}
public sealed class NativeApi : IDisposable {
    private readonly HttpClient client=new(new HttpClientHandler {AllowAutoRedirect=false}) {Timeout=TimeSpan.FromSeconds(15)};
    private readonly string folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"NORTHSTAR");
    private readonly ECDsa identity;
    public NativeApi() {
        Directory.CreateDirectory(folder);
        identity=ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var key=Read("identity");
        if(key is null) Save("identity",identity.ExportPkcs8PrivateKey());
        else identity.ImportPkcs8PrivateKey(key,out _);
    }
    public string Origin {get;set;}="";
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
    public async Task<JsonObject> Request(string path,JsonObject? body=null) {
        if(!Uri.TryCreate(Origin,UriKind.Absolute,out var origin)||origin.Scheme!="https"||origin.UserInfo!=""||origin.Query!=""||origin.Fragment!=""||origin.AbsolutePath!="/") throw new AccessFailure("SERVER_REQUIRED");
        using var request=new HttpRequestMessage(body is null?HttpMethod.Get:HttpMethod.Post,new Uri(origin,"/api/v2/native/"+path));
        request.Headers.TryAddWithoutValidation("X-Northstar-Client",ClientAgent);
        if(path!="login" && Read("token") is { } token) request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",Encoding.UTF8.GetString(token));
        if(body is not null) request.Content=JsonContent.Create(body);
        using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead);
        await response.Content.LoadIntoBufferAsync(262144);
        var json=JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject ?? throw new AccessFailure("INVALID_RESPONSE");
        if(!response.IsSuccessStatusCode) throw new AccessFailure(json["code"]?.GetValue<string>()??"SERVICE_UNAVAILABLE");
        return json;
    }
    /// Public release catalog: the operator's announcement, and a newer build for this install if one is published.
    public async Task<(string Announcement,(string Version,bool Mandatory,Uri Download)? Update)?> LatestRelease() {
        if(!Uri.TryCreate(Origin,UriKind.Absolute,out var origin)||origin.Scheme!="https") return null;
        var installation=Read("installation") is { } saved?Encoding.UTF8.GetString(saved):Guid.NewGuid().ToString();Save("installation",Encoding.UTF8.GetBytes(installation));
        var build=ClientAgent[(ClientAgent.IndexOf('+')+1)..];
        using var response=await client.GetAsync(new Uri(origin,$"/api/v1/client-releases/latest?platform=windows&arch={(System.Runtime.InteropServices.RuntimeInformation.OSArchitecture==System.Runtime.InteropServices.Architecture.Arm64?"arm64":"x64")}&build={build}&installation={installation}"));
        if(!response.IsSuccessStatusCode) return null;
        await response.Content.LoadIntoBufferAsync(65536);
        var json=JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject;
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
    public async Task<JsonObject> Action(string action,JsonObject input) {
        var challenge=await Request("challenge",new JsonObject {["action"]=action,["request"]=input.DeepClone()});
        var encoded=challenge["payload"]!.GetValue<string>().Replace('-','+').Replace('_','/');
        var bytes=Convert.FromBase64String(encoded.PadRight((encoded.Length+3)/4*4,'='));
        var signature=identity.SignData(bytes,HashAlgorithmName.SHA256,DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return await Request(action,new JsonObject {["challengeId"]=challenge["id"]!.GetValue<string>(),["signature"]=B64(signature),["request"]=input.DeepClone()});
    }
    public async Task Logout() {try {await Request("logout",new JsonObject());}finally {Save("token",null);}}
    public void Dispose() {identity.Dispose();client.Dispose();}
}
