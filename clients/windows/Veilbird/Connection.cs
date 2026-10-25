using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>
/// One VPN connection, as on the phones: a lease for this PC on a node, then the core carries traffic over the
/// first transport that answers. Automatic mode keeps the next two fastest nodes as spares. Runs on a background
/// loop; the window and the tray read its state and listen to Changed.
/// </summary>
public sealed class Connection(NativeApi api,Core core) {
    public event Action? Changed;
    public bool Active {get;private set;}
    public string StatusKey {get;private set;}="not_connected";
    public string NodeId {get;private set;}="";
    public string NodeName {get;private set;}="";
    /// UTC time the first transport answered; null while connecting or disconnected.
    public DateTime? Since {get;private set;}
    public long RxRate {get;private set;}
    public long TxRate {get;private set;}
    private CancellationTokenSource? loop;
    private readonly List<string> fallbacks=new();
    private (string Public,string Private) keys;
    private string leaseId="",network="",carrying="";
    private bool leaseReady;
    private DateTime deadline,renewAt,lastProbe,lastNetworkCheck;
    private List<string> transports=new();
    private int failures;
    private static readonly string[] Fatal={"AUTH_REQUIRED","DEVICE_REVOKED","MEMBERSHIP_EXPIRED","QUOTA_EXHAUSTED","ACCOUNT_UNAVAILABLE","MANAGED_ACCESS_REQUIRED","CLIENT_UPDATE_REQUIRED"};

    private void Set(string status) {StatusKey=status;Changed?.Invoke();}

    private Task? attempt;
    /// Connects to nodeId, or to the fastest node when it is empty. Throws AccessFailure when it cannot.
    public async Task Connect(string nodeId,bool smart) {
        if(Active) return;
        // An attempt cancelled a moment ago may still be unwinding: let it finish before starting again.
        if(attempt is {IsCompleted:false} previous) {try {await previous;} catch {/* already reported */}}
        if(Active) return;
        var current=Attempt(nodeId,smart);attempt=current;
        await current;
    }
    private async Task Attempt(string nodeId,bool smart) {
        Active=true;Since=null;RxRate=TxRate=0;NodeId=nodeId;failures=0;Set("authorizing_and_connecting");
        try {
            keys=await Task.Run(core.NewKeypair);
            network=await Task.Run(Transports.NetworkKey);lastNetworkCheck=DateTime.UtcNow;
            api.Attempt=Guid.NewGuid().ToString("N")[..16];
            // The attempt id is also the request id of this attempt's lines in Console → 运行日志.
            Journal.Add($"connect: start {api.Attempt}, network {network}, routing {(smart?"smart":"global")}");
            if(NodeId.Length==0) await ChooseFastest();
            await ConnectWithFallback(smart);
        } catch(Exception) when (!Active) {
            await Task.Run(core.Stop);return; // disconnected while connecting
        } catch(Exception error) {
            var code=error is AccessFailure failure?failure.Code:"CONNECT_FAILED";
            // Unexpected errors keep their (scrubbed) text, e.g. why the core refused its configuration.
            var detail=error is AccessFailure?"":$"{error.GetType().Name}: {Journal.Scrub(error.Message)}";
            Journal.Add($"connect: failed {code}"+(detail.Length>0?$" ({detail})":""));
            await api.Report(code,NodeId,detail);
            await Task.Run(core.Stop);Active=false;Set("not_connected");
            throw error as AccessFailure ?? new AccessFailure("CONNECT_FAILED");
        }
        // Disconnect pressed while connecting: the core may have started after Disconnect stopped it.
        if(!Active) {await Task.Run(core.Stop);return;}
        loop=new CancellationTokenSource();
        var token=loop.Token;
        _=Task.Run(async()=>{while(!token.IsCancellationRequested) {try {await Task.Delay(2000,token);await Tick(smart);} catch(OperationCanceledException) {return;}}});
    }
    private async Task ChooseFastest() {
        try {
            var ranked=await Latency.Rank((await api.Request("nodes"))["nodes"]!.AsArray(),attempts:3);
            foreach(var (node,quality) in ranked.Take(3)) Journal.Add($"probe: {node["name"]} {(quality.Latency is { } ms?$"{ms} ms":"no answer")}, jitter {quality.Jitter} ms, loss {quality.Loss}%");
            NodeId=ranked.FirstOrDefault().Node?["id"]?.GetValue<string>()??"";
            fallbacks.Clear();fallbacks.AddRange(ranked.Skip(1).Take(2).Select(r=>r.Node["id"]!.GetValue<string>()));
        } catch {/* the server picks the least-loaded node */}
    }
    private async Task ConnectWithFallback(bool smart) {
        while(true) {
            try {await BringUp(smart);return;}
            catch(AccessFailure error) when (error.Code is "NODE_UNAVAILABLE" or "NODE_FULL" or "HANDSHAKE_TIMEOUT"&&fallbacks.Count>0&&Active) {await NextNode(error.Code);}
        }
    }
    private async Task NextNode(string code) {
        Journal.Add($"switch: {NodeName} failed ({code}), trying the next location");
        await api.Report(code,NodeId);
        NodeId=fallbacks[0];fallbacks.RemoveAt(0);Since=null;Set("authorizing_and_connecting");
    }
    private async Task BringUp(bool smart) {
        var started=DateTime.UtcNow;
        var lease=await Acquire(initial:true);
        var proxies=new List<JsonObject> {Transports.WireGuard(lease,keys.Private)};
        if(lease["proxies"] is JsonArray offered) proxies.AddRange(offered.OfType<JsonObject>().Where(p=>Transports.Ladder.Contains(p["name"]?.GetValue<string>())));
        var blocked=Transports.Blocked(network);
        transports=Transports.Order(proxies.Select(p=>p["name"]!.GetValue<string>()),blocked);
        Journal.Add($"node: {NodeName}, transports {string.Join(" > ",transports)}"+(blocked.Count>0?$" (blocked here before: {string.Join(", ",blocked)})":""));
        // Disconnect pressed while connecting cancels the attempt here, before the tunnel stays up.
        if(!Active) throw new OperationCanceledException();
        await Task.Run(()=>core.Run(Transports.Options(proxies,transports,smart)));
        if(!Active) throw new OperationCanceledException();
        if(!await Probe(initial:true)) {
            // WireGuard waits for the node to add this PC; give it the rest of the readiness window.
            while(!leaseReady&&DateTime.UtcNow-started<TimeSpan.FromSeconds(15)) {await Task.Delay(1000);if(!Active) throw new OperationCanceledException();leaseReady=await Status();}
            if(!leaseReady||!await Probe(initial:true)) throw new AccessFailure("HANDSHAKE_TIMEOUT");
        }
        if(!Active) throw new OperationCanceledException();
        Since=DateTime.UtcNow;Set("connected_status");
        Journal.Add($"connect: ready in {(int)(DateTime.UtcNow-started).TotalMilliseconds} ms via {carrying}");
    }
    /// All transports at once; true when at least one answers. Failures are remembered only when another transport worked.
    private async Task<bool> Probe(bool initial=false,bool? report=null) {
        var results=await Task.Run(()=>core.Probe(transports,5000));
        lastProbe=DateTime.UtcNow;
        var working=results.Where(r=>r.Value>=0).Select(r=>r.Key).ToList();
        // WireGuard cannot answer before the node has applied this PC; that is not a block.
        var failed=results.Where(r=>r.Value<0&&(r.Key!="wireguard"||leaseReady)).Select(r=>r.Key).ToList();
        if(initial||failed.Count>0) Journal.Add("probe: "+string.Join(", ",transports.Select(name=>results.TryGetValue(name,out var ms)&&ms>=0?$"{name} {ms} ms":$"{name} no answer")));
        if(working.Count>0) Transports.Remember(network,failed,working);
        // Tells the server which of this node's ports answer from here (Console: 云防火墙); off the connect path.
        if((report??initial)&&working.Count>0) {
            var summary=string.Join(",",working.Select(name=>$"{name}=ok").Concat(failed.Select(name=>$"{name}=fail")));
            _=api.Report("TRANSPORT_PROBE",NodeId,summary,network);
        }
        await UpdateCarrying();
        return working.Count>0;
    }
    private async Task UpdateCarrying() {
        var now=await Task.Run(()=>core.Now(Transports.Group));
        if(now.Length>0&&now!=carrying) {if(carrying.Length>0) Journal.Add($"transport: {carrying} -> {now}");carrying=now;}
    }
    private async Task<bool> Status() {try {return (await api.Request("status/"+leaseId))["ready"]?.GetValue<bool>()==true;} catch {return false;}}
    /// A first connection with other transports waits briefly for WireGuard; without them up to 15 s. Renewals only check readiness.
    private async Task<JsonObject> Acquire(bool initial=false) {
        var input=new JsonObject {["publicKey"]=keys.Public};
        if(NodeId.Length>0) input["nodeId"]=NodeId;
        var lease=await api.Action("connect",input);
        NodeId=lease["nodeId"]!.GetValue<string>();NodeName=lease["nodeName"]?.GetValue<string>()??"";
        var remaining=DateTimeOffset.Parse(lease["expiresAt"]!.GetValue<string>(),System.Globalization.CultureInfo.InvariantCulture)-DateTimeOffset.UtcNow;
        if(remaining<=TimeSpan.Zero) throw new AccessFailure("ACCESS_EXPIRED");
        deadline=DateTime.UtcNow+(remaining<TimeSpan.FromMinutes(5)?remaining:TimeSpan.FromMinutes(5));renewAt=DateTime.UtcNow.AddSeconds(90);
        leaseId=lease["leaseId"]!.GetValue<string>();leaseReady=lease["ready"]?.GetValue<bool>()==true;
        Changed?.Invoke();
        if(!initial) {if(!leaseReady) leaseReady=await Status();return lease;}
        var spare=lease["proxies"] is JsonArray { Count: >0 };
        for(var attempt=0;attempt<(spare?3:15)&&!leaseReady;attempt++) {
            if(DateTime.UtcNow>=deadline) throw new AccessFailure("ACCESS_EXPIRED");
            await Task.Delay(1000);leaseReady=await Status();
        }
        if(!leaseReady&&!spare) throw new AccessFailure("NODE_UNAVAILABLE");
        Journal.Add(leaseReady?"lease: WireGuard ready":"lease: WireGuard pending, starting on the other transports");
        return lease;
    }
    private async Task Tick(bool smart) {
        if(!Active) return;
        try {
            var now=DateTime.UtcNow;
            // After sleep the lease may already have lapsed: one renewal attempt before closing the tunnel.
            if(now>=renewAt||now>=deadline) {
                try {await Acquire();}
                catch(AccessFailure error) when (Fatal.Contains(error.Code)) {await Fail(error.Code,"connection_authorization_expired_connect_again");return;}
                catch(Exception error) {Journal.Add($"lease: renewal failed ({(error as AccessFailure)?.Code??"network"}), retrying");renewAt=now.AddSeconds(15);}
                if(DateTime.UtcNow>=deadline) {Journal.Add("lease: expired");await Fail("LEASE_RENEWAL_FAILED","connection_authorization_expired_connect_again");return;}
            } else if(!leaseReady&&await Status()) {
                // WireGuard became usable: test it now so traffic moves to the lightest transport right away.
                leaseReady=true;Journal.Add("lease: WireGuard ready");await Probe(report:true);
            }
            if(now-lastNetworkCheck>TimeSpan.FromSeconds(30)) {
                lastNetworkCheck=now;
                var current=await Task.Run(Transports.NetworkKey);
                if(current!=network) {Journal.Add($"network: changed to {current}");network=current;lastProbe=DateTime.MinValue;}
            }
            if(now-lastProbe>TimeSpan.FromSeconds(30)) {
                if(await Probe()) failures=0;
                else if(++failures>=2) {
                    Journal.Add("probe: no transport answers");
                    if(fallbacks.Count>0) {
                        await NextNode("HANDSHAKE_TIMEOUT");
                        try {await ConnectWithFallback(smart);failures=0;} catch(Exception error) {await Fail((error as AccessFailure)?.Code??"CONNECT_FAILED","this_location_is_not_responding_try_another");}
                        return;
                    }
                    await Fail("HANDSHAKE_TIMEOUT","this_location_is_not_responding_try_another");return;
                }
                StatusKey=failures==0?"connected_status":"confirming_connection_status";
            } else await UpdateCarrying();
            var (up,down)=await Task.Run(core.Rate);
            TxRate=up;RxRate=down;Changed?.Invoke();
        } catch(Exception error) {
            var detail=$"{error.GetType().Name}: {Journal.Scrub(error.Message)}";
            Journal.Add($"tunnel: error {detail}");await api.Report("TUNNEL_ERROR",NodeId,detail);await Disconnect("connection_interrupted_try_again");
        }
    }
    private async Task Fail(string code,string status) {await api.Report(code,NodeId);await Disconnect(status);}
    /// Closes the tunnel and releases the device slot (best effort, at most 5 s).
    public async Task Disconnect(string status="disconnected") {
        if(!Active) return;
        Active=false;loop?.Cancel();Since=null;RxRate=TxRate=0;carrying="";
        Journal.Add("disconnect: "+status);
        await Task.Run(core.Stop);
        Set(status);
        try {await api.Action("disconnect",new JsonObject()).WaitAsync(TimeSpan.FromSeconds(5));} catch {/* the lease also expires on its own */}
    }
}
