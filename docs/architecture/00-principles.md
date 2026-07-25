# 00. 架构原则

## P1. 控制面和数据面分离

Controller 不承载 VPN 用户流量。Controller 只负责：

- 身份与权限；
- 节点和设备编排；
- 配置生成与版本管理；
- Agent 通信；
- 审计和观测。

Edge Node 承载 VPN 流量。Controller 不应成为所有用户流量的单点瓶颈。

## P2. 协议可插拔

系统不能把用户、设备或节点模型设计成 WireGuard 专属。WireGuard、OpenVPN、IKEv2 和未来协议都必须通过统一的 Protocol Adapter 接口接入。

## P3. 设备是授权最小单位

用户不是 VPN Peer。每台设备拥有独立的设备身份、协议凭据、IP Lease 和撤销状态。丢失一台设备不能迫使用户所有设备重新注册。

## P4. 私钥尽量在持有者一侧生成

- 用户设备的 VPN 私钥在客户端生成；
- Edge Node 的 VPN 私钥在节点本地生成；
- Agent mTLS 私钥在节点本地生成；
- Controller 保存公钥、CSR、证书和必要的加密恢复材料，但不默认保存客户端私钥。

## P5. Desired State 优先

Controller 保存“应该是什么”，Agent 上报“现在是什么”。所有节点配置都必须有版本、哈希、应用结果和回滚路径。按钮不能直接映射成任意 shell 命令。

## P6. 操作必须可审计

创建设备、分配 IP、生成 Profile、撤销设备、修改节点配置、证书轮换和恢复操作都必须产生 Audit Event。

## P7. 失败要可恢复

节点离线时，Controller 仍然保存 Desired State；节点恢复后继续 Reconcile。客户端协议切换必须有退避、最小保持时间和用户可见原因，不能无限重连抖动。

## P8. 不自研密码学和 VPN 协议

使用成熟的 WireGuard、OpenVPN3、IKEv2/IPsec、TLS/PKI 实现。Northstar 负责编排和策略，不负责发明新的加密协议或自定义“伪装协议”。

## P9. 云厂商是部署属性，不是业务模型

Alibaba Cloud、Tencent Cloud、GCP 和普通 VPS 都应该表现为 `NodeProvider` 或节点标签。业务层不应写死某家云厂商的实例 API。

## P10. 兼容性优先于炫技

第一阶段先把 WireGuard + 三端客户端 + desired state 做稳定，再增加 OpenVPN/IKEv2。多协议的价值来自可靠 fallback，而不是一次性堆叠大量协议。
