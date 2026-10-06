import XCTest
@testable import VeilbirdCore

@MainActor
final class DeviceAccessTests: XCTestCase {
    func testDevelopmentEngineNeverPretendsToConnect() async {
        let lease = AccessLease(id: "test", enrollmentId: "device", expiresAt: Date(), authorizationVersion: 1)
        do {
            try await UnavailableEngine().connect(lease: lease)
            XCTFail("Unimplemented engine must fail closed")
        } catch { XCTAssertEqual(error as? ClientError, .engineNotReady) }
    }
    func testWireStateNames() {
        XCTAssertEqual(ConnectionState.deviceLimitReached.rawValue, "device_limit_reached")
        XCTAssertEqual(ConnectionState.deviceRevoked.rawValue, "device_revoked")
    }
}
