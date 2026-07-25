# 03. 多协议数据面

## 1. Adapter 原则

Controller 使用统一接口，不直接操作某个协议的配置文件：

```ts
interface ProtocolAdapter {
  id: string;
  capabilities(): ProtocolCapabilities;
  enrollDevice(input: DeviceEnrollment): Promise<ProtocolCredential>;
  reconcileNode(input: DesiredProtocolState): Promise<ReconcilePlan>;
  revokeDevice(input: RevokeDevice): Promise<void>;
  renderProfile(input: ProfileRequest): Promise<ConnectionProfile>;
  readStatus(input: NodeProtocol): Promise<ProtocolStatus>;
}
```

## 2. 第一批 Adapter

### WireGuard

默认数据面。

- Edge Node 私钥只在节点本地生成；
- Device 私钥只在客户端生成；
- Controller 保存公钥和 Peer 元数据；
- 服务端 `AllowedIPs` 使用唯一的设备地址；
- 节点配置使用 revision/hash 管理；
- 移动设备在需要时使用 `PersistentKeepalive`；
- WireGuard UDP 监听端口和防火墙策略由节点能力声明提供。

### OpenVPN

兼容性 Adapter。

- 独立的 CA/证书模型；
- 独立的客户端 Profile；
- UDP/TCP 作为不同 transport capability；
- 不复用 WireGuard key；
- 服务端证书、客户端证书和吊销状态独立管理。

### IKEv2

第三阶段 Adapter，主要面向 Apple 原生 Personal VPN 和企业设备管理。Apple Network Extension 同时支持内置 IPsec/IKEv2 和自定义 Packet Tunnel Provider。[Apple Network Extension](https://developer.apple.com/documentation/networkextension)

## 3. Transport 与 Protocol 分离

不要把协议和传输写成一个不可拆分的名字：

```text
protocol = wireguard
transport = udp

protocol = openvpn
transport = tcp

protocol = wireguard
transport = quic-wrapper
```

WireGuard 本身使用 UDP；如果未来需要 HTTP/3/QUIC 承载 UDP，应作为 Transport Adapter，而不是修改 WireGuard 核心。[WireGuard Protocol](https://www.wireguard.com/protocol/)、[RFC 9298 CONNECT-UDP](https://datatracker.ietf.org/doc/html/rfc9298)

## 4. 能力声明

节点和客户端都声明能力，Controller 做交集：

```json
{
  "protocol": "openvpn",
  "transports": ["udp", "tcp"],
  "platforms": ["android", "ios", "macos"],
  "routing": ["full", "split"],
  "ipv6": true,
  "minClientVersion": "1.2.0",
  "configSchemaVersion": 3
}
```

旧客户端不能收到它不认识的协议或配置版本。

## 5. Connection Profile

Profile 是客户端可执行的连接配置，不是原始配置文件的简单下载：

```text
Profile
  id
  device_id
  node_id
  protocol
  transport
  endpoint(s)
  server_identity
  device_address
  dns
  routes
  mtu
  revision
  expires_at
  capabilities
```

Profile 必须：

- 绑定具体 Device；
- 绑定具体 Protocol；
- 具备过期时间和 revision；
- 可单独撤销；
- 不包含不必要的长期私钥；
- 在客户端安全存储中保存。

## 6. 协议选择策略

客户端支持：

- Auto：基于节点能力和连接测试选择；
- Manual：用户固定节点/协议；
- Enterprise policy：由管理员锁定节点、协议和路由模式。

自动切换必须有失败阈值、退避和最小保持时间，防止协议频繁抖动。
