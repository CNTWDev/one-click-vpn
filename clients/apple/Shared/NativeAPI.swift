import Foundation
import CryptoKit
import Security

enum AccessFailure: LocalizedError {
    case code(String)
    var errorDescription: String? {
        guard case .code(let code) = self else { return nil }
        return ["DEVICE_LIMIT_REACHED":"授权设备已满，请在「账号」解除旧设备的授权后重试。",
                "DEVICE_REVOKED":"这台设备的授权已解除，请联系管理员。",
                "AUTH_REQUIRED":"登录已过期，请重新登录。", "INVALID_CREDENTIALS":"邮箱或密码不正确。",
                "NODE_UNAVAILABLE":"节点暂时不可用，请换一个节点重试。", "MEMBERSHIP_EXPIRED":"账号已到期，请联系管理员续期。",
                "MANAGED_ACCESS_REQUIRED":"请联系管理员开通 NORTHSTAR 客户端访问。",
                "CLIENT_ACCESS_NOT_ENABLED":"服务端尚未启用客户端访问。",
                "KEYCHAIN_UNAVAILABLE":"无法访问安全存储，请解锁设备后重试。",
                "KEYCHAIN_SIGNATURE_REQUIRED":"当前开发包缺少签名授权，需配置开发者团队并签名后使用。",
                "SIMULATOR_UNSUPPORTED":"模拟器仅用于界面测试，请使用已签名的真机版本测试 VPN。",
                "SERVER_REQUIRED":"请填写有效的 HTTPS 服务地址。",
                "ACCOUNT_UNAVAILABLE":"账号尚未启用或已停用。", "ACCESS_EXPIRED":"连接授权已过期，请重新连接。",
                "RATE_LIMITED":"操作太频繁，请稍后重试。", "INVALID_RESPONSE":"服务器响应无效，请稍后重试。"] [code] ?? "暂时无法连接，请检查网络后重试。"
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
        if path != "login",let token=try SecureStorage.read("token").flatMap({String(data:$0,encoding:.utf8)}) {request.setValue("Bearer \(token)",forHTTPHeaderField:"Authorization")}
        if let body {request.httpMethod="POST";request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.httpBody=try JSONSerialization.data(withJSONObject:body)}
        let session=URLSession(configuration:.ephemeral,delegate:self,delegateQueue:nil)
        defer { session.invalidateAndCancel() }
        let (data,response)=try await session.data(for:request)
        guard data.count<=262144,let json=try JSONSerialization.jsonObject(with:data) as? [String:Any],let response=response as? HTTPURLResponse else {throw AccessFailure.code("INVALID_RESPONSE")}
        guard (200..<300).contains(response.statusCode) else {throw AccessFailure.code(json["code"] as? String ?? "SERVICE_UNAVAILABLE")}
        return json
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
