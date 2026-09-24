# 使用 WireGuard 凭据连接 Mihomo

本功能是现有 WireGuard 凭据的配置导出，不新增服务端协议，也不是订阅链接。适用于支持 WireGuard 的 Mihomo 内核客户端，不保证旧版 Clash 兼容。

1. 在个人平台创建 WireGuard 凭据，或选择已有的有效凭据。
2. 在凭据详情的「Clash / Mihomo 客户端」区下载配置。
3. 单节点得到 `.yaml`；多节点得到 ZIP，先解压，再选一份 YAML 作为本地配置导入客户端。每份文件对应一个节点，并非订阅或需要合并的配置片段。
4. 启用该本地配置，在客户端开启系统代理；如需接管不遵循系统代理的应用，可自行启用 TUN。导出不自动修改系统代理、不启用 TUN。

## 路由与安全

- 默认 MATCH 规则将进入 Mihomo 的流量交给该 WireGuard 节点，没有故障时自动直连的回退；不代表未接管的系统流量也会经过 VPN。
- 保留原 WireGuard AllowedIPs，若原配置是分流网段，其他目标可能不可达；本版不自动扩张授权网段。
- 当前服务端数据面为 IPv4，导出关闭 IPv6 DNS；不提供系统级 IPv6 防泄漏保障。
- DNS 沿用配置的 IPv4 DNS（空列表回退 1.1.1.1），业务 DNS 遵循代理规则。节点域名通过 1.1.1.1 / 8.8.8.8 直接解析以避免启动循环；这些引导解析器须在本地网络可达。
- YAML 内含私钥，不要分享、提交 Git、发到公共聊天或上传第三方转换网站。
- 同一份 WireGuard 凭据请勿在多个客户端并发连接，包括同时开启原生 WireGuard 与 Mihomo；需要并发时创建独立凭据。
- 到期、停用、撤销、账号限制继续生效；停用/撤销后需等待节点同步。下载另一种格式不会换发密钥或延长有效期。
- 无私钥材料的历史配置不能导出，需要创建新凭据。OpenVPN 不提供此导出入口。

## API

`GET /api/v1/profiles/:id/download?format=mihomo`

沿用登录认证、资源归属检查和凭据可用性检查；仅允许未过期且已激活的 WireGuard 配置。返回 YAML 附件，禁止缓存。省略 format 或使用 native 保留原生下载格式。

参考：[Mihomo WireGuard](https://wiki.metacubex.one/config/proxies/wg/)、[DNS 配置](https://wiki.metacubex.one/config/dns/)。
