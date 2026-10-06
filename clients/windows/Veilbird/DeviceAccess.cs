namespace Veilbird;

public sealed record Enrollment(string Id, string Status, long AuthorizationVersion);
public sealed record AccessLease(string Id, string EnrollmentId, DateTimeOffset ExpiresAt, long AuthorizationVersion);
// Implement against the v2 device-proof contract, not the legacy credential API.
public interface IDeviceAccess {
    Task<Enrollment> AdmitAsync(string challengeProof, CancellationToken cancellationToken);
    Task<AccessLease> LeaseAsync(string enrollmentId, string nodeId, CancellationToken cancellationToken);
    Task RevokeAsync(string enrollmentId, CancellationToken cancellationToken);
}
// A future least-privilege service owns the engine. UI must never pass arbitrary
// commands or file paths across IPC; bind ACLs and requests to the logged-in user.
public interface ITunnelEngine {
    Task ConnectAsync(AccessLease lease, CancellationToken cancellationToken);
    Task DisconnectAsync(CancellationToken cancellationToken);
}
