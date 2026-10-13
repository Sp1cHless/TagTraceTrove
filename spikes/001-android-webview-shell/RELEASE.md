# Android 正式版

当前正式配置：显示名称 **T3**，版本从仓库根目录 `release.json` 读取，目前为 `versionName 1.0.5`，`versionCode 105`。
包名保持 `com.speechless666.t3.spike`，这是已存在的应用身份，不是显示名称。
后续正式更新必须增加 versionCode，并使用同一 Release 私钥。

Release 不可调试；WebView 调试沿用 Capacitor 的 debuggable 判断，原生桥日志仅在 debug 构建开启。
保留现有离线库、配对和原生插件实现，未开启代码混淆以避免额外引入反射兼容问题。

## 签名

私钥及签名属性文件保存在当前用户目录 `.t3/signing/`，不属于源码或发行包：

- `android-release.p12`
- `android-release.properties`

**请将这两个文件备份到安全位置。丢失私钥会影响后续更新。不要上传到 GitHub、聊天或公共网盘，不要放入发行 ZIP。**

新电脑应恢复这两个文件，或通过 `T3_ANDROID_SIGNING_PROPERTIES` 指定属性文件路径。
如果用户目录不同，修改私有属性文件中的 `storeFile`，或用 `T3_ANDROID_STORE_FILE` 指定恢复后的密钥路径。
CI 可使用 `T3_ANDROID_STORE_FILE`、`T3_ANDROID_STORE_PASSWORD`、`T3_ANDROID_KEY_ALIAS`、`T3_ANDROID_KEY_PASSWORD` 覆盖对应值。
缺少凭据时 Release 构建明确失败，不使用 debug 密钥，也不静默生成未签名发行包。
`android/release-signing.properties.example` 只有模板，不包含有效密钥。

首次创建密钥可在配置 JDK 后执行 `android/create-release-key.ps1`。
该脚本拒绝覆盖既有签名文件。已有正式版本后不要重新生成密钥。

## 构建

正式发行统一运行仓库根目录 **Release.bat** 或 `tools/release/release.ps1`，由 `release.json` 提供版本并生成配套的 Windows ZIP、APK 与校验值。以下为底层 Android 构建步骤。

使用项目兼容 Node 构建 `apps/web`；正式构建的 `VITE_T3_BUILD_ID` 应与 `release.json` 中的版本一致。
然后执行 `prepare-web.mjs`、Capacitor `copy android`，在 `android` 目录运行：

```powershell
./gradlew.bat assembleRelease --console=plain
```

生成文件：`android/app/build/outputs/apk/release/app-release.apk`。
发行前检查包名、版本、签名、非 debuggable 标志及 Web 资源与本次构建一致。
统一 APK + 桌面 ZIP 打包入口是根目录 `Release.bat`；版本配置来自根目录 `release.json`。安装、更新与卸载说明见 `docs/release-installation.md`。

## 与旧测试安装的关系

旧 r25 使用 Android Debug 证书；正式版使用专用 Release 证书。
两者签名不同，因此不能直接覆盖安装。存在未同步工作时，不要卸载或清数据。
2026-10-12 按用户要求安装正式版时，手机上的旧包已不存在；直接安装成功，没有执行卸载或清数据。冷启动、首页图片及安装包哈希检查通过，离线副本重新下载尚未检查。
在迁移测试手机前，应先确认所有工作同步成功，并明确离线副本与配对的重新建立流程。
新用户安装正式版以后，后续同签名正式版可按正常覆盖更新流程升级。
