# T3 发布、安装、更新与卸载

## 普通用户：Windows

支持 Windows 10/11 x64。下载并解压 `T3-版本-windows-x64.zip`，双击其中的 **T3.exe**，或 **Install.cmd**。安装完成会创建桌面快捷方式并打开应用，无需安装 Node、.NET、Python、OpenSSL 或开发工具。安装无需管理员权限，不添加开机自启，不自动修改防火墙。应用内操作手册在 `/manual/zh.html` 和 `/manual/en.html`。

从 1.0.5 起，ZIP 内层目录固定为 **TagTraceTrove**；版本号只在下载文件名和外层发行目录中。默认就地安装在该解压目录内，不再自动复制到 AppData。也可通过 `-InstallRoot` 指向已有安装：

| 目录 | 内容 |
| --- | --- |
| `versions\版本\` | 程序、内置资源和运行依赖 |
| `data\` | 资料库、图片、模板、设置、配对身份、SiteProbe 用户规则、登录会话与导出 |
| `backups\pre-update-*\` | 更新前的完整用户目录副本 |
| `installation.json` | 当前版本入口和资料路径 |

安装目录和备份可能含有私有资料及网站会话，应只保存在可信位置。浏览器中的显示偏好属于浏览器本地存储，不在此用户目录内。

**更新：**先等待手机待同步工作归零，再从电脑托盘退出要更新的实例。将新版 ZIP 解压到单独的外层版本目录，例如 `1.0.6\TagTraceTrove`；运行其中的 `Install.ps1 -InstallRoot D:\已有安装\TagTraceTrove -Start`。安装器会识别原有实例，校验文件，先备份其整个 `data`，写入内部 `versions\新版本`，最后切换入口。旧程序保留；实例名称、端口、资料和浏览器 origin 保留。

外层版本目录是下载／解压用目录；原有库的安装位置固定。不要把 `data` 一起覆盖，也不用手工覆盖内部 `versions`。如果已将新版解压内容合并到原 `TagTraceTrove` 根目录，运行根目录 `Install.cmd` 或 `T3.exe` 也会完成上述备份和切换。压缩包不含资料和实例配置，解压合并保留它们；执行前仍须退出该实例。

如需自定义位置，在解压目录执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -InstallRoot D:\Apps\T3 -Start`。后续更新使用同一个 `InstallRoot`。

### 长期保留第二个演示库

发行包提供 **Install-Demo.cmd**，为该目录创建独立演示实例：桌面快捷方式为 **T3 Demo**，网页地址 `http://127.0.0.1:8785`，手机加密连接端口为 8786。新库为空库，适合公开演示内容、安装版测试和宣传视频。从 1.0.5 起默认就地安装；1.0.4 的 AppData 安装可先退出，再将整个实例的资料与配置迁到指定安装树。

主安装默认端口为 8765/8766，演示库为 8785/8786。两个安装各自保留程序、资料、图片、模板、SiteProbe 会话与规则、配对身份、备份和快捷方式；网页本地存储按各自端口形成独立 origin。单实例锁按资料路径区分，关闭一个托盘只停止它自己的服务。端口被其它实例占用时，安装版启动器报错，不会打开那个实例的库。

平时双击 **T3 Demo** 或演示安装根目录的 **Start.cmd**。从该根目录执行 `Start.cmd -Stop` 可单独退出演示库。再次打开会保留上次资料。录制用的内容在演示库中自行添加；它不会复制现有主库。

更新演示库时，退出 **T3 Demo** 托盘，在新包 `TagTraceTrove` 目录运行 `Install.ps1 -InstallRoot D:\原演示安装\TagTraceTrove -Start`。已有安装继承自己的名称、端口和资料路径，并在自己的 `backups` 中备份。不要仅运行新目录的 `Install-Demo.cmd` 来更新旧目录，否则是在新目录创建另一个实例。端口和实例名称创建后固定。卸载使用该安装根目录的 **Uninstall.cmd**，默认保留演示资料与备份。

自定义额外实例可首次使用 `Install.ps1 -InstallRoot D:\Apps\T3-Other -Port 8795 -TlsPort 8796 -InstanceName Other -Start`，随后按同一根目录更新。每个实例使用不同的名称和两枚端口。

手机 App 的配对是独立操作。创建电脑演示库不会自动更换现有手机的配对。

**从源码目录迁移：**退出旧 T3 后执行 `Install.ps1 -LegacyRoot D:\旧T3目录 -Start`。仅在新安装尚无 `data` 时复制旧 `apps/server/.data`，不修改原件。旧版使用自定义 `T3_DATA_DIR`、`SITEPROBE_HOME` 或独立配对目录时，先自行将那些资料归入新 `data`，不能假定默认目录覆盖了全部资料。源码目录内的 `.venv` 与 `node_modules` 不属于个人资料，无需迁移。

**卸载：**退出托盘 T3，运行你实际安装的 `TagTraceTrove` 根目录中的 **Uninstall.cmd**。默认删除全部程序版本及该安装的桌面快捷方式，保留 `data`、更新前备份和安装记录。重新安装同版或新版可继续使用保留资料。彻底删除需显式执行 `Uninstall.ps1 -DeleteData`，并输入 `DELETE T3 DATA`；此操作也会删除更新备份。在安装根目录运行时会自动识别该实例；从其它位置调用卸载脚本时需指定 `-InstallRoot`。不会清除浏览器数据或手机 App。

**1.0.5 发行说明更正：**该版本已生成的 Windows ZIP 和附带 `INSTALL.md` 在卸载段落中仍写有旧的 `%LOCALAPPDATA%\T3` 路径。实际应使用上面的安装根目录入口；这仅是说明中的旧路径，安装器默认仍在选定目录内安装。已生成的发布文件及校验值保持不变，发布时将本段更正一并放入 Release 说明。

**恢复更新前状态：**退出 T3，保留当前 `data` 的额外副本，然后将所需 `backups/pre-update-*` 完整复制为 `data`；如需回到旧程序，同时将桌面快捷方式指向与该备份匹配的旧 `versions/版本/T3.exe`。数据库迁移后不要仅切换旧程序而继续使用新库。此恢复为人工流程，安装器不会自动回滚启动时发生的迁移。

## 普通用户：Android

首次安装 `T3-版本.apk`，按 Android 提示允许当前文件管理器安装应用。桌面 T3 启动后，在同一可信网络配对，并在“离线资料库”首次下载副本。

正式版更新直接打开新版 APK 覆盖安装，必须保持应用身份和签名不变，且 versionCode 增加。正常覆盖保留配对、离线副本和待同步工作；连接后自动同步并更新已下载的副本。

旧测试版使用 debug 签名，无法被正式签名直接覆盖。先连接原桌面库、确认待同步工作归零，再卸载旧测试版并安装正式版，重新配对和下载离线副本。安装脚本不会自动卸载或清除数据。

USB 可选入口：发行目录 `Install-Android.cmd -AdbPath D:\platform-tools\adb.exe`；多手机时加 `-Serial 手机序列号`。ADB 需另行准备并授权 USB 调试。脚本校验 APK 哈希和版本，使用 `adb install -r`；签名不符时原安装保留。

卸载在 Android 设置中进行。卸载或清除应用数据会删除本机离线副本和未同步工作，不影响桌面库；重装需要重新配对、下载离线库。仍有未同步工作时不要卸载。

## 维护者：一键打包

双击 **Release.bat**，或执行 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/release/release.ps1`。默认自动将补丁版本加一、Android `versionCode` 加一，并写回根目录 `release.json`；例如 `1.0.5 / 105` → `1.0.6 / 106`。会参考既有发行记录确保版本及 Android code 单调增加，跳过已占用的版本目录；package ID 与正式 signer SHA256 保留。构建依赖检查通过后才保存新版本，原配置的恢复副本保存在 `.releases/release-config.previous.json`。

需要手动指定大版本或小版本时，先设置 `release.json` 的版本及更大的 Android code，再运行 `Release.bat -KeepVersion`。该模式要求两个值均高于既有发行记录。构建失败不会回退已经分配的版本；修复后直接重跑，默认自动选择下一个版本。成功后应将更新后的 `release.json` 一并提交，并使用与产物一致的 Git 标签。

构建电脑需要：已安装并兼容的项目 Node 依赖、.NET 10 SDK、JDK 21、Android SDK/build-tools 36.0.0、现有 Release 签名私钥、Python 3.11 及 SiteProbe 的 browser/media 依赖、Windows x64 OpenSSL 3（含配套 DLL）。这些是构建依赖，不是用户安装要求。脚本优先检测当前项目运行环境；可用 `-NodePath`、`-PythonBase`、`-PythonPackages`、`-OpenSslDirectory`、`-JavaHome`、`-AndroidSdk` 指定路径。首次打包可能联网获取 .NET 自包含运行时、Node 版本对应的第三方授权说明和 Playwright Chromium；`-NodeLicenseFile` 可指定 Node 安装包自带的 LICENSE，`-BrowserDirectory` 可使用与已安装 Playwright 版本匹配的预下载浏览器目录。

产物位于 `.releases/版本/`：签名 APK、Windows ZIP、安装说明、USB 安装脚本、发布元数据和 `SHA256SUMS.txt`。桌面 ZIP 包含自包含 .NET 启动器、Node 原生依赖、便携 Python、SiteProbe 内置规则、Chromium 与 OpenSSL。ZIP 中不包含个人库、配对私钥、网站登录资料、抓取导出、Android 签名私钥或调试报告。`launcher-build` 与展开的桌面目录是本地中间产物，不需要上传。

桌面和 APK 使用同一次 Web 构建；发布清单记录输入源码指纹、版本、APK 签名及文件哈希。构建期间输入改变则拒绝发布。缺少签名或签名变化会失败，不创建新私钥、不退回 debug。签名备份见 `spikes/001-android-webview-shell/RELEASE.md`。

自动选版不会覆盖既有目录；显式指定的 `-OutputDirectory`（位于仓库内）已经存在时仍拒绝覆盖。发布入口使用独占构建锁，避免同时打包修改同一份版本配置。失败目录有 `RELEASE-FAILED.txt`，不得分发；修复后直接重跑 **Release.bat** 即可自动使用新版本。脚本只生成可分发文件，不上传、不创建 GitHub Release、不安装当前电脑/手机，也不操作正式资料库。发布前仍需维护者确认最终版本的用户验收。
