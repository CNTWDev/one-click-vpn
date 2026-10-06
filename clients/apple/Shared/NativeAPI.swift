import Foundation
import CryptoKit
import Security

enum AccessFailure: LocalizedError {
    case code(String)
    var errorDescription: String? {
        guard case .code(let code) = self else { return nil }
        return ["DEVICE_LIMIT_REACHED":L10n.text("device_limit_reached_account_hint"),
                "DEVICE_REVOKED":L10n.text("access_for_this_device_has_been_revoked_contact_your"),
                "AUTH_REQUIRED":L10n.text("your_session_has_expired_sign_in_again"), "INVALID_CREDENTIALS":L10n.text("incorrect_email_or_password"),
                "NODE_UNAVAILABLE":L10n.text("this_location_is_unavailable_try_another"), "MEMBERSHIP_EXPIRED":L10n.text("membership_expired_hint"),
                "MANAGED_ACCESS_REQUIRED":L10n.text("ask_your_administrator_to_enable_northstar_client_access"),
                "CLIENT_ACCESS_NOT_ENABLED":L10n.text("client_access_is_not_enabled_on_the_server"),
                "KEYCHAIN_UNAVAILABLE":L10n.text("secure_storage_is_unavailable_unlock_your_device_and_try"),
                "KEYCHAIN_SIGNATURE_REQUIRED":L10n.text("this_development_build_lacks_signing_entitlements_configure_your_developer"),
                "SIMULATOR_UNSUPPORTED":L10n.text("the_simulator_is_for_ui_testing_only_test_the"),
                "SERVER_REQUIRED":L10n.text("enter_a_valid_https_server_address"),
                "ACCOUNT_UNAVAILABLE":L10n.text("your_account_is_not_active"), "ACCESS_EXPIRED":L10n.text("connection_authorization_expired_connect_again"),
                "RATE_LIMITED":L10n.text("too_many_attempts_try_again_later"), "CLIENT_UPDATE_REQUIRED":L10n.text("client_update_required"), "INVALID_RESPONSE":L10n.text("invalid_server_response_try_again_later")] [code] ?? L10n.text("unable_to_connect_check_your_network_and_try_again")
    }
}

enum SecureStorage {
    static func query(_ name: String) -> [String:Any] {
        var q:[String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"northstar-native-v1",kSecAttrAccount as String:name]
        #if !targetEnvironment(simulator)
        if let group=Bundle.main.object(forInfoDictionaryKey:"NorthstarKeychainGroup") as? String, !group.isEmpty { q[kSecAttrAccessGroup as String]=group }
        #endif
        return q
    }
    static func read(_ name: String) throws -> Data? {
        var q=query(name); q[kSecReturnData as String]=true; q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?
        let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }
        if status == errSecMissingEntitlement {throw AccessFailure.code("KEYCHAIN_SIGNATURE_REQUIRED")}
        guard status == errSecSuccess else { throw AccessFailure.code("KEYCHAIN_UNAVAILABLE") }
        return result as? Data
    }
    static func write(_ name:String,_ value:Data?) throws {
        let q=query(name)
        guard let value else { let status=SecItemDelete(q as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else {throw AccessFailure.code("KEYCHAIN_UNAVAILABLE")}; return }
        let status=SecItemUpdate(q as CFDictionary,[kSecValueData as String:value] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw AccessFailure.code("KEYCHAIN_UNAVAILABLE") }
        var item=q; item[kSecValueData as String]=value; item[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary,nil) == errSecSuccess else { throw AccessFailure.code("KEYCHAIN_UNAVAILABLE") }
    }
}

final class NativeAPI: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let origin:String
    init(origin:String) throws {
        guard let url=URL(string:origin),url.scheme=="https",url.host != nil,url.user==nil,url.password==nil,url.query==nil,url.fragment==nil,["","/"].contains(url.path) else {throw AccessFailure.code("SERVER_REQUIRED")}
        self.origin=origin.hasSuffix("/") ? String(origin.dropLast()) : origin
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void) {completionHandler(nil)}
    func request(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
        var request=URLRequest(url:URL(string:"\(origin)/api/v2/native/\(path)")!);request.timeoutInterval=15
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        request.setValue(Self.clientAgent,forHTTPHeaderField:"X-Northstar-Client")
        if path != "login",let token=try SecureStorage.read("token").flatMap({String(data:$0,encoding:.utf8)}) {request.setValue("Bearer \(token)",forHTTPHeaderField:"Authorization")}
        if let body {request.httpMethod="POST";request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=try JSONSerialization.data(withJSONObject:body)}
        let session=URLSession(configuration:.ephemeral,delegate:self,delegateQueue:nil)
        defer { session.invalidateAndCancel() }
        let (data,response)=try await session.data(for:request)
        guard data.count<=262144,let json=try JSONSerialization.jsonObject(with:data) as? [String:Any],let response=response as? HTTPURLResponse else {throw AccessFailure.code("INVALID_RESPONSE")}
        guard (200..<300).contains(response.statusCode) else {throw AccessFailure.code(json["code"] as? String ?? "SERVICE_UNAVAILABLE")}
        return json
    }
    /// Public release catalog: whether a newer build (or a required one) exists for this install.
    func latestRelease(installation:String) async throws -> [String:Any] {
        let info=Bundle.main.infoDictionary ?? [:],build=Int(info["CFBundleVersion"] as? String ?? "") ?? 0
        var components=URLComponents(string:"\(origin)/api/v1/client-releases/latest")!
        components.queryItems=[URLQueryItem(name:"platform",value:Self.clientAgent.components(separatedBy:"/")[0]),URLQueryItem(name:"build",value:String(build)),URLQueryItem(name:"installation",value:installation)]
        var request=URLRequest(url:components.url!);request.timeoutInterval=15;request.setValue("application/json",forHTTPHeaderField:"Accept")
        let session=URLSession(configuration:.ephemeral,delegate:self,delegateQueue:nil)
        defer { session.invalidateAndCancel() }
        let (data,response)=try await session.data(for:request)
        guard (response as? HTTPURLResponse)?.statusCode==200,data.count<=65536,let json=try JSONSerialization.jsonObject(with:data) as? [String:Any] else {throw AccessFailure.code("SERVICE_UNAVAILABLE")}
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
    func action(_ action:String,_ input:[String:Any]) async throws -> [String:Any] {
        let challenge=try await request("challenge",["action":action,"request":input])
        guard let encoded=challenge["payload"] as? String,let id=challenge["id"] as? String else {throw AccessFailure.code("INVALID_RESPONSE")}
        var standard=encoded.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/");standard+=String(repeating:"=",count:(4-standard.count%4)%4)
        guard let data=Data(base64Encoded:standard) else {throw AccessFailure.code("INVALID_RESPONSE")}
        let signature=try Self.identity().signature(for:data)
        return try await request(action,["challengeId":id,"signature":Self.b64(signature.rawRepresentation),"request":input])
    }
}
