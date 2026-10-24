# 客户端打包与分发（Android / Windows）

目标闭环：GitHub Actions 打包 → 安装包放到控制台「客户端发布」→ 门户登录后下载 → 客户端用同一账号登录、选节点、连接 → 以后有新版本时客户端提示下载。

Windows 版使用 WireGuard 官方隧道服务，需要在真机上验收一次。iPhone / Mac 需要 Apple 开发者账号，见文末，暂不在闭环内。

## 一次性准备（只有你能做）

1. **生成 Android 签名密钥**（本机有 JDK 或 Docker 即可）：

   ```bash
   bash scripts/android-keystore.sh
   ```

   它会生成 `veilbird-release.jks`，并打印 4 个值。把 jks 文件和密码**离线备份**：以后每个版本都必须用同一把钥匙签名，丢了的话，已安装的用户只能卸载重装。

2. **把这 4 个值填到 GitHub**：仓库 → Settings → Secrets and variables → Actions → New repository secret，名称照抄：
   `VEILBIRD_ANDROID_KEYSTORE_BASE64`、`VEILBIRD_ANDROID_KEYSTORE_PASSWORD`、`VEILBIRD_ANDROID_KEY_ALIAS`、`VEILBIRD_ANDROID_KEY_PASSWORD`。

3. 同一页面的 Variables 标签新建 `VEILBIRD_API_ORIGIN`，值是你的 API 地址（例如 `https://api.example.com`）。打包时写进 App，用户安装后不用手填服务器地址。

4. 控制台为要用客户端的账号开启「客户端授权设备」（访问详情 → 客户端授权设备与会员额度），服务器 `.env` 需 `VEILBIRD_NATIVE_ACCESS_ENABLED=1`。

不需要 Google Play、Google 开发者账号或代码混淆：自签名 APK 可以直接安装，用户首次安装时允许「安装未知来源应用」即可。Windows 安装程序未做代码签名，首次运行时 SmartScreen 会提示「更多信息 → 仍要运行」；以后想去掉这个提示，可以买代码签名证书（如 Azure Trusted Signing）。App 每次启动会请求一次管理员权限，用于启动 VPN 服务。

## 每次发版

1. 改 `clients/version.json` 的版本号，提交后推送标签 `client-v<版本号>`；或在 GitHub → Actions →「Client release」→ Run workflow（Windows 勾选 `windows`）。
2. 运行结束后，在该次运行页面底部 **Artifacts** 下载（GitHub 会再套一层 zip，先解压）：
   - `Veilbird-android-…` → `Veilbird-<版本>-<构建号>.apk`
   - `Veilbird-windows-x64-…` → `Veilbird-<版本>-<构建号>-win-x64-setup.exe`（arm64 同理，给 ARM 笔记本用）
3. 控制台 → 客户端 → 客户端发布 →「上传安装包」，选择解压出来的 `.apk` 或 `-setup.exe`。平台、架构、版本号、构建号会按文件名自动填好，点「上传并保存草稿」。
4. 版本历史里点「发布」（测试版），自己装一遍确认没问题，再点「晋升正式版」。门户下载区和固定链接 `/download/android`、`/download/windows` 立即指向它，已安装的客户端下次启动会提示更新。
5. 需要强制所有人升级时，在「下载链接与最低版本」设置最低构建号。

## 可选：让 CI 自动上传（省掉第 2、3 步）

在服务器 `.env` 设置 `VEILBIRD_RELEASE_TOKEN`（`openssl rand -hex 32` 生成），运行 `sudo ./one-click-update.sh`。然后在 GitHub 新建 Secret `VEILBIRD_RELEASE_TOKEN`（同一个值）和 Variable `VEILBIRD_RELEASE_API`（Controller 地址）。之后 CI 会自己把安装包传到控制台并发布为测试版，你只需在控制台点「晋升正式版」。默认的本地存储和 S3 都支持。

## 客户端更新

- Android：启动时检查，下载后校验 SHA-256 和签名，交给系统安装器，用户点一次「安装」。必须升级时隐藏连接按钮。
- Windows：启动时检查，显示新版本卡片，点击下载新安装程序，运行后覆盖安装。
- 灰度：测试版可以设置比例，只有落在比例内的安装会收到提示。

## iPhone / Mac（有 Apple 开发者账号后再做）

Apple 不允许绕过签名安装 VPN 类应用。需要：Apple Developer Program（VPN 应用公开上架要求**组织账号**，需要邓白氏编码）；在 App Store Connect 创建 App；生成 App Store Connect API Key。届时 CI 用 API Key 自动签名并上传 TestFlight，控制台登记 TestFlight / App Store 链接，客户端已有的更新提示会打开对应链接。
