# 05. 安全与身份架构

## 1. 四套身份必须分离

```text
Web User Identity
  -> 操作者是谁

Device Identity
  -> 哪一台 Mac/iPhone/Android

Protocol Identity
  -> WireGuard/OpenVPN/IKEv2 的连接凭据

Agent Identity
  -> 哪一台 Edge Node 在和 Controller 通信
```

不能使用一个 token 或一把私钥承担全部身份。

## 2. Agent mTLS 生命周期

目标流程：

```text
1. Controller 生成一次性、短 TTL bootstrap token
2. Agent 本地生成私钥和 CSR
3. Agent 使用 token 注册
4. CA 验证 token 和节点绑定
5. CA 签发短期 Agent client certificate
6. Agent 使用 mTLS 连接 Agent Gateway
7. Agent 在证书过期前自动续签
8. 节点撤销后拒绝新的 Agent session
```

当前 Agent 已升级为 v1 结构化任务通道，但认证仍是每节点 token。下一阶段再接入短期 mTLS：第一阶段可以使用成熟的独立 CA 服务；规模扩大后使用 SPIFFE/SPIRE 的 node attestation、registration entries 和短期 SVID。

## 3. VPN 凭据

### WireGuard

- 私钥只在设备或节点本地生成；
- Controller 只需要 public key；
- 删除 Device 时撤销对应 Peer；
- 节点轮换 key 时支持短暂双 key 过渡；
- 设备私钥不得写入 Controller 日志。

### OpenVPN/IKEv2

- 独立 CA 和证书；
- 客户端私钥本地生成；
- 证书有过期时间；
- 撤销和续签独立于 WireGuard；
- 不把证书内容放在普通数据库明文列中。

## 4. SSH

SSH 只用于：

- 首次 bootstrap；
- Agent 失联恢复；
- 明确审计的人工运维。

要求：

- host fingerprint 校验；
- 短期凭据；
- 优先使用密钥而不是密码；
- 密码和私钥只在统一 SSH 连接层决定认证方式，不进入 Agent 或 VPN Adapter；
- 非 root 云账号只允许使用预先配置的免密 `sudo -n`，不通过交互方式收集 sudo 密码；
- 私钥必须经过 SSH 解析器校验；当前不接收带口令私钥；
- 操作超时；
- 输出审计；
- 关闭任意命令 API。

## 5. Secret 管理

当前单机版本使用 master key + AES-256-GCM 保护恢复凭据。未来应迁移到：

- 云 KMS/HSM；或
- Vault/独立 Secret Manager；或
- 至少使用独立挂载的密钥文件和严格权限。

Master key 轮换必须是迁移流程，不能直接替换，否则旧密文无法解密。

## 6. 审计要求

必须审计：

- 登录成功/失败；
- 新建设备；
- 生成 Profile；
- 绑定/解绑节点；
- 撤销凭据；
- 修改 Desired State；
- Agent 证书签发和轮换；
- SSH 恢复操作；
- 协议切换和自动 fallback。

## 7. 不信任客户端输入

客户端可以请求 Profile，但不能决定：

- 任意节点地址；
- 任意 VPN IP；
- 任意 AllowedIPs；
- 任意服务器端路由；
- 任意 shell 命令。

所有这些都必须由 Controller 根据租户、用户、设备和节点策略生成。
