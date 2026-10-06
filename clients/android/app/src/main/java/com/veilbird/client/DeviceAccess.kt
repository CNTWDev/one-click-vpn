package com.veilbird.client

/** UI/session boundary only. No fake registration or local quota enforcement. */
interface DeviceAccess {
    suspend fun admit(challengeProof: String): Enrollment
    suspend fun lease(enrollmentId: String, nodeId: String): AccessLease
    suspend fun revoke(enrollmentId: String)
}
data class Enrollment(val id: String, val status: String, val authorizationVersion: Long)
data class AccessLease(val id: String, val enrollmentId: String, val expiresAt: String, val authorizationVersion: Long)
interface TunnelEngine {
    suspend fun connect(lease: AccessLease)
    suspend fun disconnect()
}
