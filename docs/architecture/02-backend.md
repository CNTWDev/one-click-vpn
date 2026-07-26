# 02. 后端架构

## 1. Controller 分层

```text
HTTP/API Layer
  ├── Auth / Session
  ├── User / Device API
  ├── Node API
  ├── Profile API
  ├── Agent Gateway
  └── Audit API

Application Layer
  ├── Device Service
  ├── Node Service
  ├── IPAM Service
  ├── Protocol Orchestrator
  ├── Certificate Service
  └── Reconcile Service

Infrastructure Layer
  ├── Database
  ├── Secret/Credential Store
  ├── Job Queue
  ├── CA/PKI integration
  └── Cloud provider adapters
```

当前仓库的 Next.js API route 是 HTTP 入口，核心编排已经开始迁移到 `server/control-plane.ts`、`server/control-db.ts` 和协议 Adapter。后续继续保持 route 只做鉴权、校验和响应映射。

## 2. 核心实体

```text
User
  id, email, role, status

Device
  id, user_id, platform, name, app_version, status

Node
  id, provider, region, public_endpoint, status, capabilities

ProtocolCredential
  id, device_id, protocol, public_key/certificate, status

NodeAssignment
  device_id, node_id, protocol, priority, status

IpLease
  pool_id, address, device_id, node_id, expires_at

ConnectionProfile
  id, device_id, node_id, protocol, transport, revision, expires_at

DesiredConfig
  node_id, protocol, revision, config_hash, payload_reference

ObservedConfig
  node_id, protocol, applied_revision, observed_hash, last_seen

AuditEvent
  actor, action, target, metadata, created_at
```

## 3. API 方向

API 应该使用版本化路径，例如 `/api/v1`。当前 `/api` 是原型路径，后续迁移时保留兼容层。

```text
POST   /api/v1/auth/login
POST   /api/v1/devices
GET    /api/v1/devices
POST   /api/v1/devices/:id/credentials
POST   /api/v1/devices/:id/revoke

GET    /api/v1/nodes
POST   /api/v1/nodes
GET    /api/v1/nodes/:id
POST   /api/v1/nodes/:id/bootstrap
GET    /api/v1/nodes/:id/status

GET    /api/v1/profiles
POST   /api/v1/profiles/:id/activate
POST   /api/v1/profiles/:id/rotate

POST   /api/v1/agent/enroll
POST   /api/v1/agent/heartbeat
POST   /api/v1/agent/reconcile-result
```

## 4. Desired State 和 Reconcile

每个节点/协议组合有独立的配置版本：

```text
node_tokyo_01 / wireguard / revision 42
node_tokyo_01 / openvpn   / revision 11
node_tokyo_01 / ikev2     / revision 3
```

Agent 发送：

```json
{
  "nodeId": "node_tokyo_01",
  "protocol": "wireguard",
  "observedRevision": 41,
  "observedHash": "...",
  "lastHandshakeAt": "..."
}
```

Controller 只在 revision 不一致时生成任务。任务必须幂等，重复执行不能破坏现有连接。

## 5. 任务模型

任务必须是结构化操作：

```text
InstallRuntime
EnrollAgent
ApplyProtocolConfig
RotateProtocolKey
RotateAgentCertificate
RestartProtocol
CollectStatus
```

不允许公开通用的 `runShell(command)` API。紧急 SSH 也必须经过权限、审计、超时和命令 allowlist。

## 6. 数据库演进

当前控制面使用 PostgreSQL，控制面表已经通过运行时 schema 和 `scripts/migrate.mjs` 初始化。未来出现以下需求时再补充：

- 多个 Controller 实例；
- 多区域 Controller；
- 大量设备和审计记录；
- 并发 Reconcile Worker；
- 更复杂的统计和租户隔离。

数据库迁移必须可重复执行、可回滚或有明确前向迁移策略。不要直接修改已经发布的表结构而不生成 migration。
