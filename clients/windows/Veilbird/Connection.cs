using System.IO;
using System.Net.NetworkInformation;
using System.Text.Json.Nodes;

namespace Veilbird;

/// <summary>
/// One VPN connection, as on the phones: a lease for this PC on a node, then the core carries traffic over the
/// first transport that answers. Automatic mode keeps the next two fastest nodes as spares. Runs on a background
/// loop; the window and the tray read its state and listen to Changed.
///
/// Once connected it stays connected until the user disconnects or the account is refused: a lost network or a
/// node that stops answering puts it in "reconnecting" (the tunnel and the kill switch stay) and it retries with
/// backoff; without any network it waits for Windows to report one. Automatic mode moves to the fastest location
/// that answers; a location the user chose is retried. Wanted remembers that the user left it on, so the app
/// connects again at its next start (sign-in, after an update or a crash).
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
    /// The location automatic mode left because it stopped answering, for the one-line note; empty otherwise.
    public string SwitchedFrom {get;private set;}="";
    /// The connection dropped with the kill switch on: traffic stays blocked until the user connects again or
    /// turns the kill switch off.
    public bool Blocking {get;private set;}
    /// Where connecting is: finding the route (0), opening the tunnel (1), confirming (2); and how many lines this location has.
    public int Phase {get;private set;}
    public int Lines {get;private set;}
    /// While reconnecting: which attempt this is and when (UTC) the next one starts.
    public int Retry {get;private set;}
    public DateTime? RetryAt {get;private set;}
    /// Why the last connection ended (an API code, HANDSHAKE_TIMEOUT, CONNECT_FAILED…); empty when it did not fail.
    public string ErrorCode {get;private set;}="";
    public void ClearError() {ErrorCode="";Changed?.Invoke();}
    /// The network outside the VPN when the last attempt failed: "ok" or "offline".
    public string NetworkState {get;private set;}="ok";
    /// The last attempt's id (its request id in Console → 运行日志): a sent check shows its first letters as the reference.
    public string Request {get;private set;}="";
    /// Connected over a line the network forced: "udp:<transport>" (UDP blocked) or "port" (443 blocked), else empty.
    public string Bypass {get;private set;}="";
    /// Sends the failure's check with the last attempt's id, so an administrator finds its lines in 运行日志;
    /// returns the reference shown to the person.
    public async Task<string> SendCheck(string summary) {
        api.Attempt=Request.Length>0?Request:null;
        await api.Report("CONNECT_CHECK",NodeId,summary);
        return (Request.Length>0?Request:Guid.NewGuid().ToString("N"))[..6].ToUpperInvariant();
    }
    public static bool KillSwitchOn=>Settings.Get("killSwitch","off")=="on";
    /// Keep a working tunnel this long when the server cannot be reached to renew the lease (it is down or
    /// blocked); the node keeps the lease alive on its side for as long (Agent offline grace).
    private static readonly TimeSpan OfflineGrace=TimeSpan.FromHours(12);
    private CancellationTokenSource? loop;
    private readonly List<string> fallbacks=new();
    private (string Public,string Private) keys;
    private string leaseId="",network="",carrying="";
    private bool leaseReady;
    private DateTime deadline,renewAt,renewedAt,nextProbe,lastNetworkCheck;
    private List<string> transports=new();
    private int failures;
    /// The watchdog (core Health) looks at the user's traffic on every tick; a stall is handled at most every StallSpacing.
    private DateTime lastStall=DateTime.MinValue;
    private static readonly TimeSpan StallSpacing=TimeSpan.FromSeconds(20);
    /// Locations that failed the user's traffic here (until when): automatic mode does not move back to them meanwhile.
    private readonly Dictionary<string,DateTime> badNodes=new();
    private static readonly TimeSpan BadFor=TimeSpan.FromMinutes(15);
    /// Automatic moves in the last 10 minutes; after 3 the connection stays where it is (no flapping between locations).
    private readonly List<DateTime> moves=new();
    /// The user left the location to the app: when it stops answering, the connection moves to the fastest one.
    private bool automatic;
    private bool online=true;
    private volatile bool networkChanged;
    public static readonly string[] Fatal={"AUTH_REQUIRED","DEVICE_REVOKED","DEVICE_LIMIT_REACHED","MEMBERSHIP_EXPIRED","QUOTA_EXHAUSTED","ACCOUNT_UNAVAILABLE","MANAGED_ACCESS_REQUIRED","CLIENT_UPDATE_REQUIRED"};
    /// Probe interval while the connection works; the core's fallback group reacts to failed dials in between.
    private static readonly TimeSpan Healthy=TimeSpan.FromMinutes(2);
    /// After connecting, when every transport is tested (the connect probe stops at the first that works).
    private static readonly TimeSpan FullProbe=TimeSpan.FromSeconds(10);
    /// The next full probe reports to the server (the connect probe did not test every transport).
    private bool reportNext;
    /// Connecting in automatic mode stops measuring locations this long after the first one answered.
    private static readonly TimeSpan Settle=TimeSpan.FromSeconds(1.5);
    /// Waits between retries while nothing answers; the last repeats for as long as the user leaves the VPN on.
    public static readonly TimeSpan[] Retries={TimeSpan.FromSeconds(5),TimeSpan.FromSeconds(15),TimeSpan.FromSeconds(30),TimeSpan.FromMinutes(1),TimeSpan.FromMinutes(5)};
    /// Status lines shown in place of the rates while connected.
    public static readonly string[] Notices={"confirming_connection_status","reconnecting_status","waiting_for_network","location_retrying"};
    /// The user left the VPN on: set by a connection, cleared by the user's disconnect or a refusal.
    public static bool Wanted {get=>Settings.Get("vpnWanted","0")=="1";set=>Settings.Set("vpnWanted",value?"1":"0");}
    private void OnNetworkChanged(object? sender,EventArgs e)=>networkChanged=true;
    /// This connection session, summed up for the staged-rollout health check (Console → 客户端发布) and sent once,
    /// as CONNECT_SESSION, when it ends: never an address, a node name or traffic.
    private bool sessionOpen;
    private DateTime? sessionUp;
    private int sessionMs,sessionFallbacks,sessionDrops;
    private string sessionLine="",sessionNet="";

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
        var wasBlocking=Blocking;
        Active=true;Blocking=false;Since=null;RxRate=TxRate=0;NodeId=nodeId;failures=0;SwitchedFrom="";Bypass="";Phase=0;Retry=0;RetryAt=null;ErrorCode="";Set("authorizing_and_connecting");
        automatic=nodeId.Length==0;Wanted=true;
        try {
            await Task.Run(()=>core.KillSwitch(KillSwitchOn));
            keys=await Task.Run(core.NewKeypair);
            network=await Task.Run(Transports.NetworkKey);online=network!="unknown";lastNetworkCheck=DateTime.UtcNow;networkChanged=false;
            sessionOpen=true;sessionUp=null;sessionMs=sessionFallbacks=sessionDrops=0;sessionLine="";sessionNet=network.Split(':')[0];
            var began=DateTime.UtcNow;
            api.Attempt=Guid.NewGuid().ToString("N")[..16];
            Request=api.Attempt;
            // The attempt id is also the request id of this attempt's lines in Console → 运行日志.
            Journal.Add($"connect: start {api.Attempt}, network {network}, routing {(smart?"smart":"global")}, apps {AppRouting.Effective.Mode} {AppRouting.Effective.Apps.Count}");
            if(NodeId.Length==0) await ChooseFastest();
            await ConnectWithFallback(smart);
            if(Active) SessionConnected(began);
        } catch(Exception) when (!Active) {
            _=EndSession(failed:false);
            await Task.Run(core.Stop);return; // disconnected while connecting
        } catch(Exception error) {
            var code=error is AccessFailure failure?failure.Code:"CONNECT_FAILED";
            // Unexpected errors keep their (scrubbed) text, e.g. why the core refused its configuration.
            var detail=error is AccessFailure?"":$"{error.GetType().Name}: {Journal.Scrub(error.Message)}";
            Journal.Add($"connect: failed {code}"+(detail.Length>0?$" ({detail})":""));
            if(Fatal.Contains(code)) Wanted=false;
            NetworkState=System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable()?"ok":"offline";
            ErrorCode=code;
            await api.Report(code,NodeId,detail);
            await EndSession(failed:true);
            await Task.Run(core.Stop);Active=false;
            // A reconnect after a drop keeps blocking; a first attempt that failed does not.
            if(wasBlocking&&KillSwitchOn) {Blocking=true;Set("kill_switch_blocking");}
            else {await LiftKillSwitch();Set("not_connected");}
            throw error as AccessFailure ?? new AccessFailure("CONNECT_FAILED");
        }
        // Disconnect pressed while connecting: the core may have started after Disconnect stopped it.
        if(!Active) {await Task.Run(core.Stop);return;}
        NetworkChange.NetworkAddressChanged+=OnNetworkChanged;
        loop=new CancellationTokenSource();
        var token=loop.Token;
        _=Task.Run(async()=>{while(!token.IsCancellationRequested) {try {await Task.Delay(2000,token);await Tick(smart);} catch(OperationCanceledException) {return;}}});
    }
    private async Task ChooseFastest() {
        try {
            // Measurements from the last minute (the location list) are reused, so connecting does not probe again.
            var ranked=await Latency.Rank(AIExit.Usable((await api.Request("nodes"))["nodes"]!.AsArray()),attempts:3,reuse:TimeSpan.FromMinutes(1),settle:Settle);
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
        sessionFallbacks++;
        if(NodeName.Length>0) SwitchedFrom=NodeName;
        NodeId=fallbacks[0];fallbacks.RemoveAt(0);Since=null;Phase=0;Set("authorizing_and_connecting");
    }
    private async Task BringUp(bool smart) {
        var started=DateTime.UtcNow;
        if(Since is null) {Phase=0;Changed?.Invoke();}
        var lease=await Acquire(initial:true);
        var proxies=new List<JsonObject> {Transports.WireGuard(lease,keys.Private)};
        if(lease["proxies"] is JsonArray offered) proxies.AddRange(offered.OfType<JsonObject>().Where(p=>Transports.Ladder.Contains(p["name"]?.GetValue<string>())));
        var blocked=Transports.Blocked(network);
        // A location locked to one protocol (advanced) uses only that protocol's transports.
        var locked=Advanced.Lock(NodeId);
        transports=Advanced.Apply(Transports.Order(proxies.Select(p=>p["name"]!.GetValue<string>()),blocked),locked);
        Journal.Add($"node: {NodeName}, transports {string.Join(" > ",transports)}"+(blocked.Count>0?$" (blocked here before: {string.Join(", ",blocked)})":"")+(locked.Length>0?$" (locked to {locked})":""));
        if(Since is null) {Lines=transports.Count;Phase=1;Changed?.Invoke();}
        // Disconnect pressed while connecting cancels the attempt here, before the tunnel stays up.
        if(!Active) throw new OperationCanceledException();
        if(await Task.Run(()=>core.Run(Transports.Options(proxies,transports,smart))) is { } killSwitchError) {
            Journal.Add($"killswitch: not applied ({Journal.Scrub(killSwitchError)})");
            _=api.Report("KILL_SWITCH_FAILED",NodeId,Journal.Scrub(killSwitchError));
        }
        if(!Active) throw new OperationCanceledException();
        if(Since is null) {Phase=2;Changed?.Invoke();}
        if(!await Probe(initial:true)) {
            // WireGuard waits for the node to add this PC; give it the rest of the readiness window.
            while(!leaseReady&&DateTime.UtcNow-started<TimeSpan.FromSeconds(15)) {await Task.Delay(1000);if(!Active) throw new OperationCanceledException();leaseReady=await Status();}
            if(!leaseReady||!await Probe(initial:true)) throw new AccessFailure("HANDSHAKE_TIMEOUT");
        }
        if(!Active) throw new OperationCanceledException();
        Since=DateTime.UtcNow;Set("connected_status");
        Journal.Add($"connect: ready in {(int)(DateTime.UtcNow-started).TotalMilliseconds} ms via {carrying}");
        // The connect probe stopped at the first transport: test them all shortly, off the connect path, for the
        // transport memory and the report to the server.
        nextProbe=DateTime.UtcNow+FullProbe;reportNext=true;
    }
    /// All transports at once; true when at least one answers. Failures are remembered only when another transport worked.
    /// The connect probe (initial) returns as soon as traffic has a transport (core.ProbeFirst); the others are not waited for.
    private async Task<bool> Probe(bool initial=false,bool report=false) {
        var results=await Task.Run(()=>initial?core.ProbeFirst(transports,5000):core.Probe(transports,5000));
        var working=results.Where(r=>r.Value>=0).Select(r=>r.Key).ToList();
        // WireGuard cannot answer before the node has applied this PC; that is not a block.
        var failed=results.Where(r=>r.Value<0&&(r.Key!="wireguard"||leaseReady)).Select(r=>r.Key).ToList();
        if(initial||failed.Count>0) Journal.Add("probe: "+string.Join(", ",transports.Select(name=>!results.TryGetValue(name,out var ms)?$"{name} not waited for":ms>=0?$"{name} {ms} ms":$"{name} no answer")));
        if(working.Count>0) Transports.Remember(network,failed,working);
        // Tells the server which of this node's ports answer from here (Console: 云防火墙); off the connect path.
        if((report||reportNext)&&!initial&&working.Count>0) {
            reportNext=false;
            var summary=string.Join(",",working.Select(name=>$"{name}=ok").Concat(failed.Select(name=>$"{name}=fail")));
            _=api.Report("TRANSPORT_PROBE",NodeId,summary,network);
        }
        await UpdateCarrying();
        return working.Count>0;
    }
    private async Task UpdateCarrying() {
        var now=await Task.Run(()=>core.Now(Transports.Group));
        if(now.Length>0&&now!=carrying) {if(carrying.Length>0) Journal.Add($"transport: {carrying} -> {now}");carrying=now;}
        // A line the network forced, said once on the connect page: Hysteria2 (UDP) failed here while another works,
        // or 443 failed and the spare port carries traffic. The transport memory holds what failed on this network.
        var blocked=carrying.Length==0||carrying=="hysteria2"?new HashSet<string>():Transports.Blocked(network);
        Bypass=blocked.Contains("hysteria2")&&transports.Contains("hysteria2")?"udp:"+carrying:carrying=="reality-alt"&&blocked.Contains("reality")?"port":"";
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
        deadline=DateTime.UtcNow+(remaining<TimeSpan.FromMinutes(5)?remaining:TimeSpan.FromMinutes(5));renewAt=DateTime.UtcNow.AddSeconds(90);renewedAt=DateTime.UtcNow;
        leaseId=lease["leaseId"]!.GetValue<string>();leaseReady=lease["ready"]?.GetValue<bool>()==true;
        Changed?.Invoke();
        if(!initial) {if(!leaseReady) leaseReady=await Status();return lease;}
        // With other transports there is no wait: they carry traffic until WireGuard is ready (Tick switches then).
        var spare=lease["proxies"] is JsonArray { Count: >0 };
        for(var attempt=0;attempt<(spare?0:15)&&!leaseReady;attempt++) {
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
            // Windows reports address changes; a 30 s check is the safety net.
            if(networkChanged||now-lastNetworkCheck>TimeSpan.FromSeconds(30)) {lastNetworkCheck=now;networkChanged=false;await CheckNetwork(now);}
            // A refusal (account, device, quota) closes the tunnel. When the server cannot be reached the tunnel
            // stays while it still carries traffic, up to OfflineGrace after the last renewal; probes decide.
            if(online&&now>=renewAt) {
                try {await Acquire();}
                catch(AccessFailure error) when (Fatal.Contains(error.Code)) {await Fail(error.Code,"connection_authorization_expired_connect_again");return;}
                catch(Exception error) {
                    Journal.Add($"lease: renewal failed ({(error as AccessFailure)?.Code??"network"}), retrying");
                    renewAt=now.AddSeconds(now-renewedAt<TimeSpan.FromMinutes(5)?15:60);
                }
            } else if(online&&!leaseReady&&await Status()) {
                // WireGuard became usable: test it now so the fallback group can count on it right away.
                leaseReady=true;Journal.Add("lease: WireGuard ready");await Probe(report:true);
            }
            if(DateTime.UtcNow-renewedAt>=OfflineGrace) {Journal.Add("lease: expired");await Fail("LEASE_RENEWAL_FAILED","connection_authorization_expired_connect_again");return;}
            if(!online) StatusKey="waiting_for_network"; // no probes without a network: they would only fail
            else if(now>=nextProbe) {
                if(await Probe()) {
                    if(failures>=2) Journal.Add($"reconnect: {NodeName} answers again via {carrying}");
                    failures=0;nextProbe=DateTime.UtcNow+Healthy;
                } else await Missed(smart);
                if(!Active) return;
                StatusKey=Message();Retry=failures;RetryAt=failures>0?nextProbe:null;
            } else {
                await UpdateCarrying();
                if(failures==0) await AIExit.Note(core);
                if(failures==0&&now-lastStall>=StallSpacing&&(await Task.Run(core.Health)).StartsWith("stalled")) await Stalled(smart);
            }
            if(!Active) return;
            var (up,down)=await Task.Run(core.Rate);
            TxRate=up;RxRate=down;Changed?.Invoke();
        } catch(Exception error) {
            // Never a reason to give up: count it as a failed round and try again later.
            var detail=$"{error.GetType().Name}: {Journal.Scrub(error.Message)}";
            Journal.Add($"tunnel: error {detail}");
            if(failures==0) _=api.Report("TUNNEL_ERROR",NodeId,detail);
            failures++;nextProbe=DateTime.UtcNow+Backoff();StatusKey=Message();Retry=failures;RetryAt=nextProbe;Changed?.Invoke();
        }
    }
    /// Online state, transport memory key, and a clean start on a new network: old connections would hang.
    private async Task CheckNetwork(DateTime now) {
        var current=await Task.Run(Transports.NetworkKey);
        var wasOnline=online;online=current!="unknown";
        if(current==network&&online==wasOnline) return;
        Journal.Add(online?$"network: changed to {current}":"network: none");
        if(online) network=current;
        if(!online) return;
        await Task.Run(core.Reset);
        // Retry right away and restart the backoff; a renewal that failed meanwhile is due now too.
        nextProbe=DateTime.MinValue;failures=Math.Min(failures,1);
        if(now-renewedAt>TimeSpan.FromSeconds(90)) renewAt=DateTime.MinValue;
    }
    /// The user's traffic stopped coming back while the lines still answer probes (a stuck DNS connection, a line that
    /// passes a small test page but not real traffic): close what hangs, check the path the traffic takes, then keep the
    /// lines that fail it out of use and, when none carries traffic, treat it as a drop (automatic: move).
    private async Task Stalled(bool smart) {
        lastStall=DateTime.UtcNow;
        var line=carrying;
        Journal.Add($"watchdog: traffic stalled via {line}");
        await Task.Run(core.Reset);
        if(await Task.Run(()=>core.CheckPath(5000))) {Journal.Add("watchdog: recovered after closing stuck connections");_=api.Report("STALL",NodeId,$"recovered=reset line={line}");return;}
        // Nothing answers outside the tunnel either: the network is down (or a sign-in page), not the location.
        if(await Task.Run(()=>core.ProbeUrl("DIRECT",Transports.LocalUrl,3000))<0) {Journal.Add("watchdog: the network itself does not answer, waiting");return;}
        var results=await Task.Run(()=>core.CheckEach(transports,5000));
        var failed=transports.Where(name=>!results.TryGetValue(name,out var ms)||ms<0).ToList();
        Journal.Add("watchdog: "+string.Join(", ",transports.Select(name=>failed.Contains(name)?$"{name} fails":$"{name} ok")));
        if(failed.Count>0) await Task.Run(()=>core.Suspend(failed,600));
        if(failed.Count<transports.Count) {
            await Task.Run(core.Reset);await UpdateCarrying();
            Journal.Add($"watchdog: moved to {carrying}");_=api.Report("STALL",NodeId,$"recovered=line line={line}");return;
        }
        Journal.Add("watchdog: no line carries traffic");_=api.Report("STALL",NodeId,$"recovered=no line={line}");
        if(sessionUp is not null) sessionDrops++;
        failures=2;nextProbe=DateTime.UtcNow+Retries[1];
        if(automatic) await MoveToFastest(smart);
        StatusKey=Message();Retry=failures;RetryAt=failures>0?nextProbe:null;
    }
    /// A round where no transport answered while the PC has a network.
    private async Task Missed(bool smart) {
        failures++;nextProbe=DateTime.UtcNow+Backoff();
        if(failures<2) return;
        if(failures==2) {Journal.Add("probe: no transport answers, reconnecting");_=api.Report("HANDSHAKE_TIMEOUT",NodeId);if(sessionUp is not null) sessionDrops++;}
        if(automatic) await MoveToFastest(smart);
    }
    /// Automatic mode: measures every location now and moves to the fastest one that answers, if it is another.
    private async Task MoveToFastest(bool smart) {
        // The location that failed stays out for a while (its port may still answer the measurement below), and so do
        // others that failed here recently. Three moves in 10 minutes are the most: then stay and keep retrying.
        var now=DateTime.UtcNow;
        badNodes[NodeId]=now+BadFor;
        foreach(var key in badNodes.Where(entry=>entry.Value<=now).Select(entry=>entry.Key).ToList()) badNodes.Remove(key);
        moves.RemoveAll(at=>now-at>=TimeSpan.FromMinutes(10));
        if(moves.Count>=3) {Journal.Add("switch: moved 3 times in 10 minutes, staying");return;}
        JsonNode? best=null;
        try {
            var all=(await api.Request("nodes"))["nodes"]!.AsArray();
            var candidates=AIExit.Usable(new JsonArray(all.Where(node=>node?["id"]?.GetValue<string>() is { } key&&!badNodes.ContainsKey(key)).Select(node=>node!.DeepClone()).ToArray()));
            // While AI services are in use, a location in the same country first: AI accounts get flagged when the exit jumps.
            var country=all.FirstOrDefault(node=>node?["id"]?.GetValue<string>()==NodeId)?["countryCode"]?.GetValue<string>()??"";
            var same=country.Length>0&&await Task.Run(()=>core.AIActive(1800))
                ?new JsonArray(candidates.Where(node=>node?["countryCode"]?.GetValue<string>()==country).Select(node=>node!.DeepClone()).ToArray()):new JsonArray();
            if(same.Count>0) Journal.Add($"switch: AI in use, trying {country} first");
            foreach(var group in new[] {same,candidates}) {
                if(best is not null||group.Count==0) continue;
                best=(await Latency.Rank(group,attempts:1,settle:Settle)).FirstOrDefault(item=>item.Quality.Latency is not null).Node;
            }
        } catch {Journal.Add("switch: no location list, retrying");return;}
        if(best?["id"]?.GetValue<string>() is not { } id) {Journal.Add("switch: no other location answers, retrying");return;}
        if(id==NodeId) return;
        moves.Add(now);
        Journal.Add($"switch: {NodeName} failed (HANDSHAKE_TIMEOUT), moving to {best["name"]}");
        var from=NodeName;var previous=NodeId;
        NodeId=id;
        try {
            await BringUp(smart);
            SwitchedFrom=from;failures=0;
            // The new location must carry real traffic, not only answer the connect probe.
            if(!await Task.Run(()=>core.CheckPath(5000))) {
                Journal.Add($"switch: {NodeName} connected but carries no traffic");
                badNodes[id]=DateTime.UtcNow+BadFor;failures=2;nextProbe=DateTime.UtcNow+Retries[0];
            }
        } catch(AccessFailure error) when (Fatal.Contains(error.Code)) {
            await Fail(error.Code,"connection_authorization_expired_connect_again");
        } catch(AccessFailure error) when (error.Code=="HANDSHAKE_TIMEOUT") {
            Journal.Add("switch: failed HANDSHAKE_TIMEOUT, retrying");
        } catch(Exception) when (Active) {
            // The lease request did not reach the server: the tunnel still runs on the previous location.
            NodeId=previous;Journal.Add("switch: failed, retrying");
        }
    }
    private TimeSpan Backoff()=>Retries[Math.Min(Math.Max(failures-1,0),Retries.Length-1)];
    private string Message()=>!online?"waiting_for_network":failures switch {0=>"connected_status",1=>"confirming_connection_status",_=>automatic?"reconnecting_status":"location_retrying"};
    private async Task Fail(string code,string status) {Wanted=false;ErrorCode=code;await api.Report(code,NodeId);await Disconnect(status,unexpected:true);}
    private async Task LiftKillSwitch() {
        try {await Task.Run(()=>core.KillSwitch(false));} catch(IOException) {/* the core is gone, and its rules with it */}
    }
    /// Turning the kill switch off while it blocks lets traffic out again.
    public async Task KillSwitchChanged() {
        if(KillSwitchOn||!Blocking) return;
        Blocking=false;await LiftKillSwitch();Set("not_connected");
    }
    /// Closes the tunnel and releases the device slot (best effort, at most 5 s). A drop the user did not ask
    /// for keeps the kill switch blocking.
    private void SessionConnected(DateTime began) {
        sessionUp=DateTime.UtcNow;sessionMs=(int)(DateTime.UtcNow-began).TotalMilliseconds;sessionLine=carrying;
        if(transports.Count>0&&carrying.Length>0&&carrying!=transports[0]) sessionFallbacks++;
    }
    /// Sends the session once: ok when it connected at all, else failed (an error) or cancelled (the user stopped it).
    private async Task EndSession(bool failed) {
        if(!sessionOpen) return;
        sessionOpen=false;
        var outcome=sessionUp is not null?"ok":failed?"failed":"cancelled";
        var seconds=sessionUp is { } up?(int)(DateTime.UtcNow-up).TotalSeconds:0;
        var detail=$"outcome={outcome} ms={(sessionUp is null?-1:sessionMs)} line={(sessionLine.Length>0?sessionLine:"-")} fallbacks={sessionFallbacks} drops={sessionDrops} seconds={seconds} net={(sessionNet.Length>0?sessionNet:"unknown")}";
        try {await api.Report("CONNECT_SESSION",detail:detail);} catch {/* best effort */}
    }
    public async Task Disconnect(string status="disconnected",bool unexpected=false) {
        if(!Active) {
            if(Blocking&&!unexpected) {Blocking=false;await LiftKillSwitch();Set(status);}
            return;
        }
        Active=false;loop?.Cancel();Since=null;RxRate=TxRate=0;carrying="";Bypass="";
        _=EndSession(failed:false);
        NetworkChange.NetworkAddressChanged-=OnNetworkChanged;
        Journal.Add("disconnect: "+status);
        await Task.Run(core.Stop);
        if(unexpected&&KillSwitchOn) {Blocking=true;status="kill_switch_blocking";Journal.Add("killswitch: blocking until connected again");}
        else await LiftKillSwitch();
        Set(status);
        try {await api.Action("disconnect",new JsonObject()).WaitAsync(TimeSpan.FromSeconds(5));} catch {/* the lease also expires on its own */}
    }
}
