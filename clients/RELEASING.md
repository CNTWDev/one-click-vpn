# 客户端打包与分发（Android / Windows / Mac）

目标闭环：GitHub Actions 打包 → 安装包放到控制台「客户端发布」→ 门户登录后下载 → 客户端用同一账号登录、选节点、连接 → 以后有新版本时客户端提示下载。

Windows 版使用 WireGuard 官方隧道服务，需要在真机上验收一次。Mac 版在配好 Apple 开发者账号后自动打出签名、公证过的 DMG，见「Mac（DMG 直接下载）」。iPhone 暂不在闭环内，见文末。

## 一次性准备（只有你能做）

1. **生成 Android 签名密钥**（本机有 JDK 或 Docker 即可）：

   ```bash
   bash scripts/android-keystore.sh
   ```

   它会生成 `veilbird-release.jks`，并打印 4 个值。把 jks 文件和密码**离线备份**：以后每个版本都必须用同一把钥匙签名，丢了的话，已安装的用户只能卸载重装。

2. **把这 4 个值填到 GitHub**：仓库 → Settings → Secrets and variables → Actions → New repository secret，名称照抄：
   `VEILBIRD_ANDROID_KEYSTORE_BASE64`、`VEILBIRD_ANDROID_KEYSTORE_PASSWORD`、`VEILBIRD_ANDROID_KEY_ALIAS`、`VEILBIRD_ANDROID_KEY_PASSWORD`。

3. 同一页面的 Variables 标签新建 `VEILBIRD_API_ORIGIN`，值是你的 API 地址（例如 `https://api.example.com`）。打包时写进 App，用户安装后不用手填服务器地址。

4. 所有正常账号都能直接登录客户端并连接，订阅照常可用；设备数上限来自账号的套餐（后台「套餐」，新用户默认 1 台），客户端、订阅和节点配置合计计数；改某个账号的上限就在「访问详情」里给它更换套餐。如果服务器 `.env` 里有 `VEILBIRD_NATIVE_ACCESS_ENABLED=0`，改成 `1` 或删掉这一行，再运行 `sudo ./one-click-update.sh`。

不需要 Google Play、Google 开发者账号或代码混淆：自签名 APK 可以直接安装，用户首次安装时允许「安装未知来源应用」即可。Windows 安装程序未做代码签名，首次运行时 SmartScreen 会提示「更多信息 → 仍要运行」；以后想去掉这个提示，可以买代码签名证书（如 Azure Trusted Signing）。App 每次启动会请求一次管理员权限，用于创建虚拟网卡和路由。

三端内嵌同一个 mihomo 内核（`clients/core`）。Android：CI 先用 Go 和 Android NDK 运行 `clients/core/build-android.sh` 生成 `app/libs/veilbird-core.aar`，再跑 Gradle；本机构建同理，先装 Go（版本见 `clients/core/go.mod`）和 NDK 27，设置 `ANDROID_NDK_HOME` 后运行该脚本。Windows：`build.ps1` 自动用 Go 编译 `veilbird-core.exe` 并打进安装包。Apple：`scripts/build.sh` 自动生成 `TunnelCore.xcframework`。

## 每次发版

1. 改 `clients/version.json` 的版本号，提交后推送标签 `client-v<版本号>`；或在 GitHub → Actions →「Client release」→ Run workflow。
2. 运行结束后，在该次运行页面底部 **Artifacts** 下载各平台的 zip（不用解压）：
   - `TrackNothing-android-…` → `TrackNothing-<版本>-<构建号>-arm64.apk`（几乎所有手机）和 `TrackNothing-<版本>-<构建号>.apk`（通用包，给少数 32 位手机和网页下载），两个都导入
   - `TrackNothing-windows-x64-…` → `TrackNothing-<版本>-<构建号>-win-x64-setup.exe`（arm64 同理，给 ARM 笔记本用）
   - `TrackNothing-macos-…` → `TrackNothing-<版本>-<构建号>-macos.dmg`（配好 Apple 签名后才有）
3. 控制台 → 客户端 → 客户端发布 →「导入 GitHub 构建包」，把下载的 zip 一次全部拖进去（也可以拖 `.apk`、`.exe`、`.dmg`）。页面在浏览器里解压，按文件名识别平台、架构、版本号、构建号，只上传里面的安装包；浏览器算的 SHA-256 会和服务器收到的文件再核对一遍。选好渠道和「导入后：保存为草稿 / 立即发布」，点「导入」。已存在的构建会标记并跳过。文件名不规范时，用「上传安装包」手动填写。
4. 版本历史里点「发布」（测试版），自己装一遍确认没问题，再点「晋升正式版」。门户下载区和固定链接 `/download/android`、`/download/windows`、`/download/macos` 立即指向它，已安装的客户端下次启动会提示更新。
5. 需要强制所有人升级时，在「下载链接与最低版本」设置最低构建号。

## 可选：让 CI 自动上传（省掉第 2、3 步）

在服务器 `.env` 设置 `VEILBIRD_RELEASE_TOKEN`（`openssl rand -hex 32` 生成），运行 `sudo ./one-click-update.sh`。然后在 GitHub 新建 Secret `VEILBIRD_RELEASE_TOKEN`（同一个值）和 Variable `VEILBIRD_RELEASE_API`（Controller 地址）。之后 CI 会自己把安装包传到控制台并发布为测试版，你只需在控制台点「晋升正式版」。默认的本地存储和 S3 都支持。

## 可选：下载加速（阿里云 OSS + CDN、Cloudflare R2 等）

安装包仍然先存到服务器上；配置后，后台会把每个上传的构建自动复制到对象存储（约 1 分钟内）。客户端和网页下载都优先走 CDN，CDN 不通时改从服务器下载，并且接着已下载的部分继续。版本历史里会显示「CDN 已同步 / 同步中 / 同步失败」（鼠标移上去可以看到失败原因）。

在服务器 `.env` 加上下面几行，然后运行 `sudo ./one-click-update.sh`：

```
VEILBIRD_RELEASE_MIRROR_ENDPOINT=https://oss-ap-northeast-1.aliyuncs.com   # bucket 所在地域的外网 Endpoint，不带 bucket 名
VEILBIRD_RELEASE_MIRROR_REGION=ap-northeast-1                              # 地域 ID；签名报错时改成 oss-ap-northeast-1
VEILBIRD_RELEASE_MIRROR_BUCKET=<bucket 名>
VEILBIRD_RELEASE_MIRROR_ACCESS_KEY_ID=<RAM 用户 AccessKey ID>
VEILBIRD_RELEASE_MIRROR_SECRET_ACCESS_KEY=<RAM 用户 AccessKey Secret>
VEILBIRD_RELEASE_MIRROR_PUBLIC_BASE_URL=https://<CDN 加速域名>
```

阿里云侧：CDN 源站选这个 bucket，配 HTTPS 证书；bucket 私有时打开「阿里云 OSS 私有 Bucket 回源」；打开「Range 回源」（断点续传）；RAM 用户只给这个 bucket 的 `oss:PutObject` 和 `oss:DeleteObject`（Console 删除安装包时会一并删掉 OSS 上的文件；CDN 缓存会在过期后自然失效，急用可在 CDN 控制台刷新该 URL）。

## 客户端更新

- 检查时机：启动后约 3 秒；之后在前台或托盘里每隔 6 小时；正在建立连接时推迟。我的 →「检查更新」随时手动检查。
- 提示：首页一条提示条（可点 × 推迟 3 天，「我的」标签上的小点保留）；必须升级时不能关闭，也不能连接。
- 下载：在应用里进行，提示条显示百分比、已下载/总大小和剩余时间；CDN 优先，失败换服务器，断点续传，最后校验 SHA-256。
- Android：下载完交给系统安装器（只接受同一签名）；连接中时先显示「安装」，装好后自动重连。
- Windows：下载完静默运行安装程序，覆盖安装后自动启动新版本；连接中时装好后自动重连。
- Mac：下载并校验 DMG 后打开它，把新版本拖到「应用程序」里覆盖。iPhone 走 TestFlight / App Store。
- 灰度：测试版可以设置比例，只有落在比例内的安装会收到提示。

## Mac（DMG 直接下载）

走 Developer ID：用你自己的证书签名，交给 Apple 自动公证（几分钟，不是人工审核），DMG 放在控制台的发布存储里下载，不经过 App Store。没配好下面这些时，CI 会跳过 Mac 并在运行页面提示缺什么，Android / Windows 照常打包。

### 一次性准备（在 [developer.apple.com](https://developer.apple.com/account) 和 [App Store Connect](https://appstoreconnect.apple.com)）

1. 加入 Apple Developer Program（个人账号即可，99 美元/年），在 Membership 页面记下 **Team ID**（10 位）。
2. Certificates → 新建 **Developer ID Application**（需要账号持有人操作）。按页面提示用「钥匙串访问」生成 CSR，下载 `.cer` 双击装入钥匙串，然后在钥匙串里右键这张证书 →「导出」为 `.p12`，设一个密码。
3. Identifiers → 新建两个 App ID（Bundle ID 前缀以 `com.veilbird.client` 为例）：
   - `com.veilbird.client.macos`：勾选 **Network Extensions** 和 **System Extension**
   - `com.veilbird.client.macos.tunnel`：勾选 **Network Extensions**
   Mac 用的 App Group 是「Team ID + 前缀」形式，不用单独注册。描述文件也不用手动建：CI 会用下面的 API Key 自动创建并下载。
4. App Store Connect → 用户和访问 → 集成 → App Store Connect API → 生成密钥，角色选 **管理**（Admin，CI 要用它自动创建描述文件）。下载 `.p8`（只能下载一次，离线备份），记下 Key ID 和页面上方的 Issuer ID。

### 填到 GitHub（仓库 → Settings → Secrets and variables → Actions）

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `VEILBIRD_APPLE_TEAM_ID` | Variable | Team ID |
| `VEILBIRD_APPLE_BUNDLE_ID` | Variable | Bundle ID 前缀，如 `com.veilbird.client` |
| `VEILBIRD_APPLE_API_KEY_ID` | Secret | API Key 的 Key ID |
| `VEILBIRD_APPLE_API_ISSUER_ID` | Secret | Issuer ID |
| `VEILBIRD_APPLE_API_KEY_P8` | Secret | `.p8` 文件全文（文本编辑器打开后整段复制） |
| `VEILBIRD_MACOS_DEVELOPER_ID_P12` | Secret | `.p12` 的 base64：`base64 -i developer-id.p12 \| pbcopy` |
| `VEILBIRD_MACOS_DEVELOPER_ID_P12_PASSWORD` | Secret | 导出 `.p12` 时设的密码 |

之后每次运行「Client release」都会多出 `TrackNothing-macos-…`。CI 做的事：导入证书 → `scripts/apple-profiles.mjs` 取描述文件 → `clients/apple/scripts/release-macos.sh` 打包签名、生成 DMG、公证并钉订票据。本机有 Xcode 时也可以手动跑这个脚本（需要的环境变量写在脚本开头）。

### 用户第一次安装

1. 打开 DMG，把 TrackNothing 拖进「应用程序」（系统扩展只能从这里加载，直接在 DMG 里打开会提示先移动）。
2. 第一次点连接时，macOS 提示「系统扩展已被阻止」：打开「系统设置 → 隐私与安全性」，点「允许」，App 会自动继续连接；再同意添加 VPN 配置。以后和普通 App 一样。
3. 升级：下载新 DMG 覆盖「应用程序」里的旧版，下次连接时新版系统扩展自动替换旧的。

注意：Mac 的隧道以 root 运行，读不到用户钥匙串，所以只能从 App（窗口、菜单栏或快捷指令）里连接；在「系统设置 → VPN」里直接打开会提示先在 App 里连接。

## iPhone（之后再做）

iPhone 没有直接下载的方式。个人账号可以用 TestFlight（内部测试最多 100 人；公开链接最多 10000 人，首个版本要过 Beta 审核）；公开上架 App Store 要求**组织账号**（需要邓白氏编码），且中国大陆区不上架 VPN 应用。届时 CI 用同一个 API Key 签名并上传 TestFlight，另需 `Apple Distribution` 证书（`VEILBIRD_IOS_DISTRIBUTION_P12` 和密码），控制台登记 TestFlight 链接，客户端已有的更新提示会打开它。
