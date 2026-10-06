# 04. 客户端架构

## 当前工程状态（2026-10-06）

产品名统一为 **NORTHSTAR**。原生工程位于 `clients/android`、`clients/apple`、`clients/windows`；Apple 覆盖 iOS/iPadOS 和 macOS。工程构建方式与发布步骤见 [客户端工作区](../../clients/README.md)。

已经实现：Android / Apple 登录、自动/指定节点、设备管理与 WireGuard 引擎；服务端签名挑战、账号锁下的设备额度、短期租约；Agent 独立到期 watchdog；后台账号设备设置；正式版本清单读取 API 和门户下载入口。Windows 已接入账号与设备 API，隧道仍未实现。

尚未完成：Windows 隧道服务、正式签名安装包、真机端到端验证、旧账号安全迁移及自动联合发布。数据库迁移新增表与默认关闭的账号开关，不改变老用户连接方式。原生 API 总开关默认关闭；不能将开发构建通过理解为生产 VPN 已验收。

当前实现与后续目标见 [设备接入 v2 契约](../../clients/contracts/device-access.md)。独立 `native_enrollments` 统计授权安装实例；历史 `devices` 仅用于地址和流量兼容，不参与设备额度。

## 1. 统一体验，平台原生 Tunnel

客户端不能只做“配置文件下载器”，也不能把所有 VPN 引擎硬塞进跨平台 UI 框架。建议采用：

```text
Shared API contract / Profile schema
Shared connection state model
Platform-native UI and system VPN integration
Protocol-specific native engines
```

## 2. macOS 和 iPhone

```text
Northstar App
  ├── Login / Device / Profile UI
  ├── API Client
  ├── Keychain / App Group storage
  └── NorthstarPacketTunnel.appex
        ├── WireGuard Engine
        ├── OpenVPN Engine
        └── VLESS / REALITY Engine
```

使用 Apple Network Extension entitlement。WireGuard/OpenVPN 及代理协议适配进入 `NEPacketTunnelProvider`；选择引擎前检查许可证、平台支持与内存约束。iPhone 和 iPad 共用 iOS target，macOS 独立 target，共享 SwiftUI 和 NorthstarCore；两个系统各有自己的 Tunnel Extension。[Apple Network Extension](https://developer.apple.com/documentation/networkextension)

主 App 不能承担持续 VPN 数据面工作，Extension 才是系统 VPN 的执行边界。

## 3. Android

```text
Northstar Android App
  ├── Native Android UI
  ├── API Client
  ├── Android Keystore
  └── NorthstarVpnService
        ├── WireGuard Engine
        ├── OpenVPN Engine
        └── Future Engines
```

Android 使用 `VpnService` 创建虚拟接口，并必须声明 `BIND_VPN_SERVICE`。系统对 VPN Service、前台通知、Always-on 和 Lockdown 有明确约束。[Android VpnService](https://developer.android.com/reference/android/net/VpnService)

## 4. Windows 与平台安全边界

Windows 采用 .NET 10 WPF 原生 UI，支持 x64 / ARM64 开发构建；后续独立的最小权限服务负责隧道适配、路由和租约到期。UI 保持普通用户权限。IPC 必须有用户 ACL、请求白名单与调用方检查，禁止把任意命令或路径传给高权限服务。驱动采用成熟签名实现，单独审查许可证和分发要求。

三端分别使用 Keychain / Android Keystore / Windows CNG 或系统凭据保护；密码不落盘、会话不进日志。设备身份密钥与协议凭据分离。未来加入客户端本地化时沿用 Portal 的 zh/en/ru 语言集合和服务端错误码，不复制后端中文异常作为 UI。

## 5. 客户端生命周期

```text
Install
  -> Login (does not occupy a slot)
  -> Generate local device identity, held in secure storage
  -> User selects Connect
  -> Verify signed challenge and atomically admit device if quota permits
  -> Select an authorized node and obtain a short-lived lease
  -> Start system VPN extension
  -> Confirm actual tunnel readiness before displaying Connected
  -> Report status/telemetry
  -> Rotate or revoke credentials
```

## 6. 连接状态机

```text
idle
  -> preparing
  -> connecting
  -> connected
  -> reconnecting
  -> switching
  -> expired / needs_auth / blocked / error
```

协议特有错误必须保留，但 UI 使用统一错误分类：

```text
endpoint_unreachable
handshake_timeout
certificate_expired
profile_expired
policy_denied
unsupported_protocol
network_changed
```

## 7. 实施与发布门槛

### 阶段一：基础工程（当前）

- 三端工程、开发构建、设备认证契约；
- 版本元数据、门户下载入口、多语言状态提示；
- 不提供可用 VPN，不将开发 artifacts 发布给普通用户。

### 阶段二：完整受控接入闭环

- 登录、设备签名、账号权益、原子准入与撤销；
- 选择一个已审查许可证的协议引擎先完成真机闭环；
- 节点/区域选择；
- 全隧道、DNS 和 IPv6 防泄漏；
- 连接状态和基础诊断；
- Agent 短期租约本地执行，设备撤销和现有会话断开；
- 验证复制、重装、失联节点、跨节点抢额度、旧 v1 访问旁路；
- 无法满足强约束的平台不得宣称已经具备严格设备限制。

### 阶段三：协议覆盖与公开发布

- 完成 WireGuard、OpenVPN、VLESS / REALITY 的适配；
- Auto protocol selection；
- 自动 fallback；
- Always-on/kill switch；
- 多 Profile 和配置 revision；
- 签名、公证、真机回归、隐私说明及商店审核；
- 人工批准发布清单，再展示下载入口。iOS/iPadOS 默认 App Store；beta 可用 TestFlight。普通 IPA 不是通用安装链接。

### 后续

- 签名更新清单、最低客户端版本与防降级策略；
- 企业策略和 MDM；
- 更复杂的 transport adapter；
- 平台 attestation。
