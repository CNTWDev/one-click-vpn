export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  approvedAt?: string | null;
  rejectionReason?: string | null;
  createdAt?: string;
  accessSummary?: AccessSummary;
};

export type AccessSummary = {
  deviceCount: number;
  activeDeviceCount: number;
  credentialCount: number;
  activeCredentialCount: number;
  profileCount: number;
  activeProfileCount: number;
  certificateCount: number;
  activeCertificateCount: number;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  lastActivityAt?: string | null;
};

export type AccountDeviceAccess = {
  deviceId: string; displayName: string; platform: string; appVersion: string; publicKey: string; status: string;
  createdAt: string; updatedAt: string; lastSeenAt?: string | null; lastActivityAt?: string | null;
  uploadBytes: number; downloadBytes: number; totalBytes: number;
};

export type AccountProfileAccess = {
  profileId: string; deviceId: string; credentialId?: string | null; protocol: string; nodeId: string; nodeName: string; regionName: string; regionCode: string;
  transport: string; revision: number; status: string; clientAddress?: string | null; issuedAt: string; expiresAt: string; updatedAt: string;
  credentialIdentity: string; lastActivityAt?: string | null; trafficAttribution: string;
  uploadBytes: number; downloadBytes: number; totalBytes: number;
};

export type AccountCertificateAccess = {
  certificateId: string; authorityId: string; deviceId: string; credentialId?: string | null; serial: string; subject: string; certificatePem: string; fingerprint: string;
  status: string; notBefore: string; notAfter: string; revokedAt?: string | null; createdAt: string; updatedAt: string;
  authorityRealm: string; authorityStatus: string; lastActivityAt?: string | null; trafficAttribution: string;
  uploadBytes: number; downloadBytes: number; totalBytes: number;
};

export type AccountCredentialAccess = {
  id: string; name: string; protocol: string; status: string; state: string; identitySuffix: string;
  online: boolean; connectionCount: number; lastActivityAt?: string | null; lastObservedAt?: string | null;
  profileCount: number; activeProfileCount: number; expiresAt?: string | null; revokedAt?: string | null;
  createdAt: string; updatedAt: string; uploadBytes: number; downloadBytes: number; totalBytes: number;
};

export type AccountAccessOverview = {
  from: string; to: string; updatedAt: string; totals: { uploadBytes: number; downloadBytes: number; totalBytes: number };
  summary: Omit<AccessSummary, "uploadBytes" | "downloadBytes" | "totalBytes" | "lastActivityAt">;
  credentials: AccountCredentialAccess[];
  devices: AccountDeviceAccess[];
  profiles: AccountProfileAccess[];
  certificates: AccountCertificateAccess[];
};

export type CredentialUsage = {
  profileId: string;
  deviceId: string;
  displayName: string;
  platform: string;
  profileStatus: string;
  protocol: string;
  nodeId: string;
  regionName: string;
  regionCode: string;
  credentialSuffix: string;
  online: boolean;
  lastActivityAt?: string | null;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
};

export type NodeMetrics = {
  collectedAt: string;
  cpuPercent: number;
  load1: number;
  memory: { usedBytes: number; totalBytes: number; percent: number };
  disk: { usedBytes: number; totalBytes: number; percent: number };
  network: { rxBytes: number; txBytes: number; rxBytesPerSecond: number; txBytesPerSecond: number };
};

export type NodeRecord = {
  id: string;
  name: string;
  place: string;
  region_id: string;
  ip: string;
  ssh_user: string;
  ssh_port: number;
  ssh_privilege_mode?: "auto" | "root" | "sudo";
  credential_type?: "password" | "private_key";
  status: string;
  latency: string;
  users: number;
  traffic: string;
  version: string;
  last_seen: string;
  host_fingerprint?: string | null;
  host_fingerprint_source?: "legacy" | "operator" | "ssh_tofu" | null;
  node_identity?: string | null;
  identity_verified_at?: string | null;
  deployment_policy?: string;
  policy_version?: number;
  metrics?: NodeMetrics | null;
};

export type Region = { id: string; name: string; country: string; code: string };

export type NodeAction = {
  id: string;
  action: string;
  status: string;
  output: string;
  error: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  current_phase: string;
  progress: number;
};

export type NodeActionEvent = {
  id: string;
  action_id: string;
  sequence: number;
  level: "info" | "warning" | "error";
  phase: string;
  message: string;
  created_at: string;
};

export type ReconcileTask = {
  id: string;
  protocol: string;
  taskType: string;
  desiredRevision: number;
  status: string;
  attempts: number;
  lastError: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt?: string | null;
};

export type NodeDiagnostics = {
  node?: NodeRecord;
  actions: NodeAction[];
  actionEvents: NodeActionEvent[];
  reconcile: {
    observed: Array<{ protocol: string; appliedRevision: number; status: string; lastError: string; updatedAt: string }>;
    tasks: ReconcileTask[];
  };
  connectivity?: {
    status: string;
    agentChannel: string;
    lastAuthenticatedHeartbeat: string | null;
    firewall: { manager: string; inputPolicy: string };
    protocols: Array<{
      protocol: string; state: string; configured: boolean; taskStatus: string | null; lastError: string;
      transport: string; port: number; installed: boolean; runtimeActive: boolean; listening: boolean;
      hostFirewall: string; cloudFirewall: string;
    }>;
    note: string;
  };
};

export type VpnService = {
  node_id: string;
  protocol: string;
  enabled: boolean;
  transport: string;
  listen_port: number;
  subnet: string;
  dns: string[];
  status: string;
  last_error: string;
  updated_at: string;
};

export type DeploymentPolicyOverview = {
  standard: { version: number; protocols: Array<{ protocol: string; transport: string; listenPort: number; configSchemaVersion: number }> };
  counts: { totalNodes: number; standardNodes: number; customNodes: number; agentOnlyNodes: number; driftedNodes: number; eligibleNodes: number; blockedNodes: number };
  driftedNodes: Array<{ id: string; name: string; currentVersion: number; status: string; missingProtocols: string[]; eligible: boolean; reason: string }>;
  rollouts: Array<{
    id: string; fromVersion: number; toVersion: number; mode: string; status: string; totalTargets: number;
    queuedTargets: number; succeededTargets: number; blockedTargets: number; failedTargets: number; createdAt: string;
  }>;
};

export type ControllerInfo = {
  settings: { display_name: string; location_label: string; latitude: number | null; longitude: number | null; location_source: "unset" | "environment" | "manual" };
  status: "healthy";
  publicOrigin: string;
  publicHost: string;
  publicIp: string | null;
  build: string;
  runtime: { uptimeSeconds: number; nodeVersion: string; rssBytes: number; heapUsedBytes: number; load1: number; observedAt: string };
};

export type OperationalLogLine = { timestamp: string; labels: Record<string, string>; message: string; actionId?: string };
