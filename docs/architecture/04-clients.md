# 04. 客户端架构

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
        └── IKEv2 Personal VPN integration
```

使用 Apple Network Extension entitlement。自定义 WireGuard/OpenVPN 进入 `NEPacketTunnelProvider`；IKEv2 可使用系统 Personal VPN。Apple 官方文档说明 Network Extension 可以创建 packet-oriented custom VPN，也支持内置 VPN 配置。[Apple Network Extension](https://developer.apple.com/documentation/networkextension)

主 App 不能承担持续 VPN 数据面工作，Extension 才是系统 VPN 的执行边界。

## 3. Android

```text
Northstar Android App
  ├── Compose UI
  ├── API Client
  ├── Android Keystore
  └── NorthstarVpnService
        ├── WireGuard Engine
        ├── OpenVPN Engine
        └── Future Engines
```

Android 使用 `VpnService` 创建虚拟接口，并必须声明 `BIND_VPN_SERVICE`。系统对 VPN Service、前台通知、Always-on 和 Lockdown 有明确约束。[Android VpnService](https://developer.android.com/reference/android/net/VpnService)

## 4. 客户端生命周期

```text
Install
  -> Login / device registration
  -> Generate local device and protocol keys
  -> Fetch compatible profiles
  -> Store secrets in Keychain/Keystore
  -> Select profile
  -> Start system VPN extension
  -> Report status/telemetry
  -> Rotate or revoke credentials
```

## 5. 连接状态机

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

## 6. 客户端功能分期

### v1

- 登录和设备注册；
- WireGuard；
- 节点/区域选择；
- 全隧道和分流；
- 连接状态和基础诊断；
- 设备撤销。

### v2

- OpenVPN UDP/TCP；
- Auto protocol selection；
- 自动 fallback；
- Always-on/kill switch；
- 多 Profile 和配置 revision。

### v3

- IKEv2；
- 企业策略和 MDM；
- 更复杂的 transport adapter；
- 平台 attestation。
