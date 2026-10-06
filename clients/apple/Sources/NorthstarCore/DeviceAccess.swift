import Foundation

public struct Enrollment: Codable, Sendable {
    public let id: String
    public let status: String
    public let authorizationVersion: Int
}
public struct AccessLease: Codable, Sendable {
    public let id: String
    public let enrollmentId: String
    public let expiresAt: Date
    public let authorizationVersion: Int
}
// Implement with Keychain-backed identity and signed challenges; login is not VPN authorization.
public protocol DeviceAccess: Sendable {
    func admit(challengeProof: String) async throws -> Enrollment
    func lease(enrollmentId: String, nodeId: String) async throws -> AccessLease
    func revoke(enrollmentId: String) async throws
}
public enum ConnectionState: String, Codable, Sendable {
    case signedOut = "signed_out"
    case ready, authorizing
    case deviceLimitReached = "device_limit_reached"
    case deviceRevoked = "device_revoked"
    case preparing, connecting, connected, disconnecting, error
}
public enum ClientError: String, Error, Sendable {
    case engineNotReady = "ENGINE_NOT_READY"
}
public protocol TunnelEngine: Sendable {
    func connect(lease: AccessLease) async throws
    func disconnect() async
}
public struct UnavailableEngine: TunnelEngine {
    public init() {}
    public func connect(lease: AccessLease) async throws { throw ClientError.engineNotReady }
    public func disconnect() async {}
}
