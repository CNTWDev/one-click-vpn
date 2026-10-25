import Foundation
import CryptoKit
import Security
#if canImport(TunnelCore)
import TunnelCore
#endif

enum AccessFailure: LocalizedError {
    case code(String)
    var errorDescription: String? {
        guard case .code(let code) = self else { return nil }
        return ["DEVICE_LIMIT_REACHED":L10n.text("device_limit_reached_account_hint"),
                "DEVICE_REVOKED":L10n.text("access_for_this_device_has_been_revoked_contact_your"),
                "AUTH_REQUIRED":L10n.text("your_session_has_expired_sign_in_again"), "INVALID_CREDENTIALS":L10n.text("incorrect_email_or_password"),
                "NODE_UNAVAILABLE":L10n.text("this_location_is_unavailable_try_another"), "MEMBERSHIP_EXPIRED":L10n.text("membership_expired_hint"), "QUOTA_EXHAUSTED":L10n.text("quota_exhausted_hint"),
                "MANAGED_ACCESS_REQUIRED":L10n.text("ask_your_administrator_to_enable_veilbird_client_access"),
                "CLIENT_ACCESS_NOT_ENABLED":L10n.text("client_access_is_not_enabled_on_the_server"),
                "KEYCHAIN_UNAVAILABLE":L10n.text("secure_storage_is_unavailable_unlock_your_device_and_try"),
                "KEYCHAIN_SIGNATURE_REQUIRED":L10n.text("this_development_build_lacks_signing_entitlements_configure_your_developer"),
                "SIMULATOR_UNSUPPORTED":L10n.text("the_simulator_is_for_ui_testing_only_test_the"),
                "CONNECT_FROM_APP_FIRST":L10n.text("connect_from_app_first"),
                "MOVE_TO_APPLICATIONS":L10n.text("move_to_applications_first"), "SYSTEM_EXTENSION_FAILED":L10n.text("system_extension_failed"),
                "SERVER_REQUIRED":L10n.text("enter_a_valid_https_server_address"),
                "ACCOUNT_UNAVAILABLE":L10n.text("your_account_is_not_active"), "ACCESS_EXPIRED":L10n.text("connection_authorization_expired_connect_again"),
                "RATE_LIMITED":L10n.text("too_many_attempts_try_again_later"), "PASSWORD_RESET_UNAVAILABLE":L10n.text("password_reset_unavailable"), "INVALID_EMAIL":L10n.text("enter_a_valid_email"), "CLIENT_UPDATE_REQUIRED":L10n.text("client_update_required"), "INVALID_RESPONSE":L10n.text("invalid_server_response_try_again_later")] [code] ?? L10n.text("unable_to_connect_check_your_network_and_try_again")
    }
}

enum SecureStorage {
    /// The Mac tunnel is a system extension running as root, outside the user's keychain: the app hands it the
    /// session token and device key when it starts the tunnel (TunnelControl.secrets), and they stay in its memory.
    static var handed:[String:Data]?
    static func query(_ name: String) -> [String:Any] {
        var q:[String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"veilbird-native-v1",kSecAttrAccount as String:name]
        #if !targetEnvironment(simulator)
        if let group=Bundle.main.object(forInfoDictionaryKey:"VeilbirdKeychainGroup") as? String, !group.isEmpty { q[kSecAttrAccessGroup as String]=group }
        #endif
        return q
    }
    static func read(_ name: String) throws -> Data? {
        if let handed {return handed[name]}
        var q=query(name); q[kSecReturnData as String]=true; q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?
        let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }
        if status == errSecMissingEntitlement {throw AccessFailure.code("KEYCHAIN_SIGNATURE_REQUIRED")}
        guard status == errSecSuccess else { throw AccessFailure.code("KEYCHAIN_UNAVAILABLE") }
        return result as? Data
    }
    static func write(_ name:String,_ value:Data?) throws {
        if handed != nil {handed?[name]=value;return}
        let q=query(name)
        guard let value else { let status=SecItemDelete(q as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else {throw AccessFailure.code("KEYCHAIN_UNAVAILABLE")}; return }
        let status=SecItemUpdate(q as CFDictionary,[kSecValueData as String:value] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw AccessFailure.code("KEYCHAIN_UNAVAILABLE") }
        var item=q; item[kSecValueData as String]=value; item[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary,nil) == errSecSuccess else { throw AccessFailure.code("KEYCHAIN_UNAVAILABLE") }
    }
}

/// The TrackNothing API over every origin of the server: the address the app was given, the other API domains the
/// server lists (every site plus backup domains) and, in the tunnel, the core's address cache and DNS over HTTPS
/// (CoreFetch), so a blocked domain or poisoned DNS does not lock the app out. The app itself (no core linked)
/// tries the origins in turn, the one that answered last first.
final class NativeAPI: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let origin:String
    /// Set by the packet tunnel for one connection attempt: the server's runtime log lines for it carry the same id.
    var attempt:String?
    init(origin:String) throws {
        guard let url=URL(string:origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,["","/"].contains(url.path) else {throw AccessFailure.code("SERVER_REQUIRED")}
        self.origin=origin.hasSuffix("/") ? String(origin.dropLast()) : origin
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) {completionHandler(nil)}
    /// Every origin of this server, best first. Another address means another server: only that one until it answers.
    private func origins() -> [String] {
        let saved=UserDefaults.standard.stringArray(forKey:"apiOrigins") ?? []
        return saved.contains(origin) ? saved:[origin]
    }
    private func remember(answered:String?,offered:[String]?) {
        var list=origins()
        if let offered {list=Array(offered.filter {$0.hasPrefix("https://")}.prefix(12))+[origin]}
        if let answered,!answered.isEmpty {list.removeAll {$0==answered};list.insert(answered,at:0)}
        var seen=Set<String>()
        UserDefaults.standard.set(Array(list.filter {seen.insert($0).inserted}.prefix(14)),forKey:"apiOrigins")
    }
    /// One call over the origins; status and body of the first that answered.
    private func send(_ method:String,_ path:String,body:Data?,headers:[String:String]) async throws -> (Int,Data) {
        let tried=origins()
        var all=headers;all["Accept"]="application/json"
        if body != nil {all["Content-Type"]="application/json"}
        #if canImport(TunnelCore)
        var request:[String:Any]=["origins":tried,"method":method,"path":path,"headers":all,"timeoutMs":15000]
        if let body {request["body"]=String(decoding:body,as:UTF8.self)}
        let input=String(decoding:try JSONSerialization.data(withJSONObject:request),as:UTF8.self)
        let home=Shared.folder.appendingPathComponent("core").path
        let output=await Task.detached {CoreFetch(home,input)}.value
        guard let reply=try JSONSerialization.jsonObject(with:Data(output.utf8)) as? [String:Any] else {throw AccessFailure.code("SERVICE_UNAVAILABLE")}
        if let error=reply["error"] as? String,!error.isEmpty {Journal.add("api: unreachable (\(Journal.scrub(error)))");throw AccessFailure.code("SERVICE_UNAVAILABLE")}
        if let answered=reply["origin"] as? String,!answered.isEmpty,answered != tried.first {Journal.add("api: answered by another address");remember(answered:answered,offered:nil)}
        let text=reply["body"] as? String ?? ""
        guard text.utf8.count<=262144 else {throw AccessFailure.code("INVALID_RESPONSE")}
        return (reply["status"] as? Int ?? 0,Data(text.utf8))
        #else
        var lastError:Error=AccessFailure.code("SERVICE_UNAVAILABLE")
        for (index,candidate) in tried.enumerated() {
            guard let url=URL(string:candidate+path) else {continue}
            var request=URLRequest(url:url);request.timeoutInterval=tried.count==1 ? 15:(index==0 ? 8:6)
            request.httpMethod=method;request.httpBody=body
            for (name,value) in all {request.setValue(value,forHTTPHeaderField:name)}
            let session=URLSession(configuration:.ephemeral,delegate:self,delegateQueue:nil)
            defer {session.invalidateAndCancel()}
            do {
                let (data,response)=try await session.data(for:request)
                guard let response=response as? HTTPURLResponse,data.count<=262144 else {throw AccessFailure.code("INVALID_RESPONSE")}
                if index>0 {remember(answered:candidate,offered:nil)}
                return (response.statusCode,data)
            } catch let error as URLError where error.code != .cancelled {lastError=error}
        }
        throw lastError
        #endif
    }
    func request(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
        var headers=["X-Veilbird-Client":Self.clientAgent]
        if let attempt {headers["X-Request-Id"]=attempt}
        if path != "login",let token=try SecureStorage.read("token").flatMap({String(data:$0,encoding:.utf8)}) {headers["Authorization"]="Bearer \(token)"}
        let (status,data)=try await send(body == nil ? "GET":"POST","/api/v2/native/\(path)",body:try body.map {try JSONSerialization.data(withJSONObject:$0)},headers:headers)
        guard let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw AccessFailure.code("INVALID_RESPONSE")}
        guard (200..<300).contains(status) else {throw AccessFailure.code(json["code"] as? String ?? "SERVICE_UNAVAILABLE")}
        if let offered=json["apiOrigins"] as? [String] {remember(answered:nil,offered:offered)}
        return json
    }
    /// Public release catalog: whether a newer build (or a required one) exists for this install.
    func latestRelease(installation:String) async throws -> [String:Any] {
        let info=Bundle.main.infoDictionary ?? [:],build=Int(info["CFBundleVersion"] as? String ?? "") ?? 0
        var components=URLComponents()
        components.path="/api/v1/client-releases/latest"
        components.queryItems=[URLQueryItem(name:"platform",value:Self.clientAgent.components(separatedBy:"/")[0]),URLQueryItem(name:"build",value:String(build)),URLQueryItem(name:"installation",value:installation)]
        let (status,data)=try await send("GET",components.string ?? "/api/v1/client-releases/latest",body:nil,headers:[:])
        guard status==200,data.count<=65536,let json=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw AccessFailure.code("SERVICE_UNAVAILABLE")}
        return json
    }
    /// `ios/1.2.3+45`: lets the server require an upgrade (CLIENT_UPDATE_REQUIRED) and track version adoption.
    static var clientAgent:String {
        #if os(iOS)
        let platform="ios"
        #else
        let platform="macos"
        #endif
        let info=Bundle.main.infoDictionary ?? [:]
        return "\(platform)/\(info["CFBundleShortVersionString"] as? String ?? "0.0.0")+\(info["CFBundleVersion"] as? String ?? "0")"
    }
    static func identity() throws -> P256.Signing.PrivateKey {
        if let data=try SecureStorage.read("identity") {return try P256.Signing.PrivateKey(rawRepresentation:data)}
        let key=P256.Signing.PrivateKey();try SecureStorage.write("identity",key.rawRepresentation);return key
    }
    static func b64(_ data:Data)->String {data.base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")}
    func login(email:String,password:String) async throws {
        let raw=try Self.identity().publicKey.x963Representation
        #if os(iOS)
        let platform="ios"
        #else
        let platform="macos"
        #endif
        let result=try await request("login",["email":email,"password":password,"platform":platform,"deviceName":ProcessInfo.processInfo.hostName,
            "identityKey":["kty":"EC","crv":"P-256","x":Self.b64(raw.subdata(in:1..<33)),"y":Self.b64(raw.subdata(in:33..<65))]])
        guard let token=result["accessToken"] as? String else {throw AccessFailure.code("INVALID_RESPONSE")}
        try SecureStorage.write("token",Data(token.utf8))
    }
    /// Emails the Portal's reset link; the answer is the same whether or not the address has an account.
    func requestPasswordReset(email:String) async throws {_ = try await request("password-reset",["email":email,"language":String(L10n.language.prefix(2))])}
    func action(_ action:String,_ input:[String:Any]) async throws -> [String:Any] {
        let challenge=try await request("challenge",["action":action,"request":input])
        guard let encoded=challenge["payload"] as? String,let id=challenge["id"] as? String else {throw AccessFailure.code("INVALID_RESPONSE")}
        var standard=encoded.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/");standard+=String(repeating:"=",count:(4-standard.count%4)%4)
        guard let data=Data(base64Encoded:standard) else {throw AccessFailure.code("INVALID_RESPONSE")}
        let signature=try Self.identity().signature(for:data)
        return try await request(action,["challengeId":id,"signature":Self.b64(signature.rawRepresentation),"request":input])
    }
}
