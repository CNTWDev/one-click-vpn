# NORTHSTAR 原生客户端工作区

状态：**开发验证阶段，不是正式可分发版本**。Android / Apple 已接入登录、账号设备管理、自动/指定节点和 WireGuard 引擎；Android APK、Mac 和 iOS 模拟器构建已验证，真机联网尚未验收。Windows 已接入登录、节点列表及授权设备管理，隧道服务尚未实现，连接按钮明确禁用。CI 不自动发布开发产物。

统一入口：`npm run clients:doctor` 检查本机工具；`npm run clients:build -- android` / `apple` / `windows` 构建后台、两个网页端与指定客户端；不指定平台构建全部。此命令**不部署服务器、不上传安装包**。正式一键联合发布尚未完成，不能把一次开发构建当成正式发布。

| 目录 | 平台 | 技术与职责 |
| --- | --- | --- |
| `android/` | Android | Kotlin 原生 UI、WireGuard GoBackend、前台连接服务、Android Keystore 身份签名与加密会话 |
| `apple/` | iPhone、iPad、Mac | SwiftUI 共享界面和 Swift Package；独立 iOS/macOS App 与 Packet Tunnel Extension |
| `windows/` | Windows x64/ARM64 | .NET 10 WPF、DPAPI 用户级密钥保护；UI 不提权，独立隧道服务仍待实现 |
| `contracts/` | 全平台 | 设备身份、连接授权和发布清单约定；不将订阅或证书数量当作设备数 |

详细设计见 [客户端架构](../docs/architecture/04-clients.md)。跨端共享接口语义与测试向量，不强行共享系统 VPN 实现。

## 客户端界面

三端统一采用暖白背景、白色圆角卡片、深墨色文字与青绿色主操作：背景 `#F8F6EE`，正文 `#182731`，强调 `#007A64`，浅色选中态 `#E2F7F0`。Apple 使用相近的原生颜色值。主按钮最小高度约 52–56，布局随系统字号换行，内容可滚动；大屏限制阅读宽度，底部固定「连接 / 节点 / 我的」。

连接页保留一个主要连接操作；节点支持搜索、选中反馈与无匹配提示，选择后回到连接页；账号将身份、用量和授权设备分组，解除授权需要确认。Windows 未集成隧道服务时继续明确禁用连接，视觉升级不代表 VPN 能力已完成。

验证记录：Android APK、iOS 模拟器与 macOS 构建通过，iOS 登录页已检查中/英/俄模拟器实图。Windows 已使用 .NET 10 SDK 交叉编译通过，仍需在 Windows 真机验收键盘操作、缩放与实际布局。Android 真机视觉与三端登录后全流程仍需测试环境验收。

## 语言与文案

Portal、Console 和三类原生客户端支持中文、英文、俄语，默认跟随系统，登录前即可手动切换。不使用在线翻译服务。原生文案统一维护于 `locales/messages.json`，通过 `npm run i18n:generate` 生成平台标准资源；`npm run i18n:check` 检查缺失翻译、占位符与生成结果。资源 ID 保持稳定，显示语言与设备身份/协议状态分离。完整规则见[产品国际化约定](../docs/architecture/04-clients.md#产品国际化约定)。

## 开发构建命令

- Android：JDK 17+、Android SDK 35、Gradle 8.14.5；`cd clients/android && ./gradlew :app:assembleDebug`。完整 wrapper 已加入并固定发行包 SHA-256。`NORTHSTAR_API_ORIGIN` 在构建时内置服务地址；未设置的开发包需要填写 HTTPS 地址。APK 位于 `app/build/outputs/apk/debug/app-debug.apk`，仅用于测试。
- Apple：完整 Xcode、XcodeGen、Go 1.24.4；执行 `bash clients/apple/scripts/build.sh ios` 或 `macos`。iOS 使用模拟器 ad-hoc 签名；macOS 包含 arm64/x64，未签名。WireGuardKit 固定上游提交，构建脚本应用 tools-version 与 SDK 头文件兼容补丁；Go bridge 在独立临时目录构建以支持项目路径含空格。这些开发产物不能用于真机 VPN 验收或正式分发。
- Windows：Windows + .NET 10 SDK；`pwsh clients/windows/build.ps1 -Runtime win-x64`，ARM64 使用 `win-arm64`。生成自包含开发 ZIP，不包含 VPN 驱动或后台服务。
- GitHub Actions：手动运行 `Native client development builds`。三平台独立构建，只上传开发 artifacts，不创建公开 Release。

## 用户下载与正式发布

发布记录保存在数据库 `client_releases`，在控制台「客户端 → 客户端发布」管理。门户下载、固定下载链接和客户端更新检查都读取这里；旧的 `NORTHSTAR_CLIENT_RELEASES_JSON` 仍作为只读清单合并展示。

流程：

1. 改版本：编辑 `clients/version.json` 的 `version`（三端共用的对外版本号）。构建号由 CI 运行序号提供，更新检查只比较构建号。
2. 推送标签 `client-v<version>`（或手动运行 Actions「Client release」）：CI 构建签名的 Android prod APK（以及勾选时的 Windows x64/arm64），上传并**发布到测试版**。所需变量和密钥列在 `.github/workflows/client-release.yml` 顶部；Controller 需要 `NORTHSTAR_RELEASE_STORAGE=s3`。
3. 在控制台「客户端发布」先给测试版设置灰度比例（1–100%，默认 100），再点「晋升正式版」；已安装的客户端按安装随机 ID 分桶，只有落在比例内的才会收到更新提示，匿名的固定下载链接始终给全量正式版。确认没问题后把比例调到 100%。
4. 需要强制升级时设置最低构建号（只能指向全量发布的正式版）。

本地手动发布同样可用：`NORTHSTAR_RELEASE_API=https://api.example.com NORTHSTAR_RELEASE_TOKEN=… npm run release:client -- --platform android --version 1.2.0 --build 12 --min-os "Android 8.0" --file app-release.apk --publish`。`--file` 通过预签名 URL 直传对象存储（需要 `NORTHSTAR_RELEASE_STORAGE=s3`）；也可以用 `--url` 登记已经托管在别处的 HTTPS 地址，或在控制台手动登记。

Controller 下载一次安装包，记录**实际**的 SHA-256 和大小，不采信上传方提供的值。构建号对同一平台/架构不可重复。

发布令牌只能上传、登记草稿和发布到测试版（beta）；晋升正式版、灰度、撤回、最低版本和公告只能在控制台操作。

| 接口 | 用途 |
| --- | --- |
| `/download/{platform}[/{arch}]` | 固定下载链接，302 到最新已发布的正式版（`?channel=beta` 取测试版）；门户和 API 域名都可用 |
| `GET /api/v1/client-releases/latest?platform=&arch=&build=&channel=&installation=` | 客户端更新检查：`latest`、`updateAvailable`、`mandatory`、`minBuild`、`announcement`（灰度按 `installation` 分桶） |
| `GET /api/v1/client-releases` | 门户下载列表 |
| `POST /api/v1/admin/client-releases`、`…/uploads`、`…/{id}` | 登记草稿、申请上传 URL、publish / promote / rollout / withdraw / delete |
| `PUT /api/v1/admin/client-policy` | 设置平台最低构建号和客户端公告 |
| `POST /api/v2/native/diagnostics` | 客户端上报连接失败代码（不含密钥、地址或流量），控制台汇总近 7 天，保留 30 天 |

**版本上报与强制升级**：三端每个请求都带 `X-Northstar-Client: <platform>/<version>+<build>`。设置最低构建号后，低于该构建号（或不带此请求头）的客户端在登录和连接时收到 `426 CLIENT_UPDATE_REQUIRED`（附带 `minBuild` 和 `downloadPath`）。最低构建号必须有已发布的正式版满足，撤回版本时也会检查，避免用户无版本可升。默认不限制。

**客户端内更新**：Android prod 包启动时检查更新，下载后校验 SHA-256 和包名，交给系统安装器（系统同时校验签名一致，用户确认一次）；必须升级时隐藏连接按钮。dev 包（`com.northstar.client.dev`）不自更新。iOS / macOS / Windows 显示新版本提示并打开 App Store 或固定下载链接；macOS Sparkle 和 Windows 静默安装尚未实现。

Android 构建：`prod` / `dev` 两个 flavor；发布签名只从环境变量读取（`NORTHSTAR_ANDROID_KEYSTORE`、`…_KEYSTORE_PASSWORD`、`…_KEY_ALIAS`、`…_KEY_PASSWORD`），`NORTHSTAR_BUILD_NUMBER` 决定 versionCode。签名密钥丢失后已安装用户无法升级，务必离线备份。

清单校验不能代替二进制签名验证。iPhone / iPad 只登记 App Store / TestFlight 链接。

## 服务端试点与上线门槛

1. 备份后运行 `npm run db:migrate`，增加 native 会话、签名挑战、授权设备与租约表。现有账号默认保留兼容模式。
2. 测试环境设置 `NORTHSTAR_NATIVE_ACCESS_ENABLED=1`、`NORTHSTAR_NATIVE_DEVICE_LIMIT=3`。正式环境默认关闭。
3. 升级测试节点 Agent 至 2.10.0，确认 `northstar-native-expiry.timer` 正常，心跳报告 `nativeLeaseEnforcement:1`；旧 Agent 不参与原生节点选择。保持服务器时间同步。
4. 后台账号「访问详情 → 客户端授权设备与会员额度」为**未曾导出连接配置的新测试账号**启用 NORTHSTAR 模式，可设置设备上限和有效期。旧账号切换明确拒绝，尚未实现安全迁移流程。
5. 真机测试首次系统权限、实际出口 IP、IPv4/IPv6/DNS 防泄漏、锁屏后台续租、网络切换、断网恢复、撤销/停用/到期、Agent 停止与重启、跨端并发额度及安装升级卸载。普通终端重装会被视为新身份；当前实现不提供抗 root/管理员复制私钥的硬件证明。

当前租约 300 秒、客户端约 90 秒续租；通过设备签名及权益校验的连接/续租把会话滑动延长 `NORTHSTAR_NATIVE_SESSION_DAYS` 天（默认 30），闲置超过该天数才需重新登录；Agent 2.10 起续租只通过任务轮询下发截止时间，不再触发整节点重配。撤销后等待旧租约截止加 20 秒才释放名额，不能承诺“即时全网下线”。节点先安装内核 UTC 截止时间规则，再启用 peer；即使 Agent/watchdog 卡住，内核仍阻断过期流量。独立 watchdog 负责清理 live peer 和持久化配置，重启先恢复防火墙再拉起隧道。只有已经使用原生租约的节点启用这组规则，legacy-only 节点不改变防火墙。修改节点规则、回拨系统时间等不在保证边界内；必须完成 Linux 真机故障注入后才能制定 SLA。启用原生访问的节点不要回退旧 Agent：旧版本新增的 peer 会被保留的默认拒绝规则阻断。

未完成的发布门槛：Windows 隧道服务及安装器、三端生产签名、Apple Developer 团队/描述文件、生产 API 地址、真机端到端验收、自动发布与回滚、第三方许可证随包核验。现有开发包不可进入门户 stable 下载列表。

Android 发布签名 APK/AAB；macOS Developer ID 签名、公证后分发 DMG/PKG；Windows 对可执行文件和安装包签名。iPhone/iPad 默认走 TestFlight 或 App Store，不把普通 IPA 下载链接当作面向所有用户的安装入口。

发布项示例（仅格式示例，URL 与摘要必须替换，不是现成下载包）：

```json
{
  "platform": "android", "arch": "universal", "channel": "stable",
  "version": "1.0.0", "build": 100, "status": "published",
  "distribution": "direct", "url": "https://downloads.example.com/northstar-1.0.0.apk",
  "sha256": "替换为真实文件的64位十六进制SHA256", "sizeBytes": 12345678,
  "minOs": "Android 8.0", "publishedAt": "2026-10-06T00:00:00Z"
}
```

`platform`: android / ios / macos / windows（iPad 使用 ios）；`arch`: arm64 / x64 / universal；iOS 必须 universal + app-store（stable）或 testflight（beta）。完整字段和白名单在 `shared/client-releases.ts`。未发布时显示“尚未发布”，不会生成假链接。
