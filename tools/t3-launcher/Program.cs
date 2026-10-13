using System.Diagnostics;
using System.Drawing;
using System.Net.Sockets;
using System.Windows.Forms;

namespace T3Launcher;

/// <summary>
/// T3 tray launcher. Default mode binds only 127.0.0.1. The tray exposes an
/// explicit trusted-network LAN switch which restarts the owned server with
/// T3_ENABLE_LAN=true and T3_HOST=0.0.0.0. Open T3 and health checks always
/// use localhost; phone URLs are listed separately. Pass --lan for an explicit
/// LAN startup or --no-browser for smoke tests.
/// </summary>
internal static class Program
{
    private static string MutexName = "T3Launcher_TagTraceTrove_SingleInstance";
    private static int Port = 8765;
    private static int TlsPort = 8766;
    private static string DisplayName = "T3";
    private static string? ManagedDataDirectory;
    private static readonly string RepoRoot =
        AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly string ServerDir = Path.Combine(RepoRoot, "apps", "server");
    private static readonly string TsxEntry = Path.Combine(ServerDir, "node_modules", "tsx", "dist", "cli.mjs");
    private static readonly string WebIndex = Path.Combine(RepoRoot, "apps", "web", "dist", "index.html");
    private static readonly string ServerLog = Path.Combine(RepoRoot, "t3-server.log");
    private static string LocalUrl => $"http://127.0.0.1:{Port}";

    private static NotifyIcon? _tray;
    private static ToolStripMenuItem? _lanToggleItem;
    private static ToolStripMenuItem? _mobileAddressesItem;
    private static Process? _server;
    private static string? _nodeExecutable;
    private static bool _noBrowser;
    private static bool _lanEnabled;

    [STAThread]
    private static void Main(string[] args)
    {
        LauncherOptions options = LauncherPolicy.ParseOptions(args);
        _noBrowser = options.NoBrowser;
        _lanEnabled = options.LanEnabled;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // A distribution's first launch installs it; installed versions share a
        // separate data directory so replacing program files cannot replace a library.
        string installMarker = Path.Combine(RepoRoot, "installed.json");
        if (File.Exists(Path.Combine(RepoRoot, "release-manifest.json")) && !File.Exists(installMarker))
        {
            string statePath = Path.Combine(RepoRoot, "installation.json");
            if (File.Exists(statePath))
            {
                using var state = System.Text.Json.JsonDocument.Parse(File.ReadAllText(statePath));
                using var release = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, "release-manifest.json")));
                string current = Path.GetFullPath(state.RootElement.GetProperty("currentDirectory").GetString()!);
                if (state.RootElement.GetProperty("product").GetString() != "T3"
                    || !current.StartsWith(Path.Combine(RepoRoot, "versions") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show("Invalid installation record.", "T3");
                    return;
                }
                if (state.RootElement.GetProperty("version").GetString() == release.RootElement.GetProperty("version").GetString()
                    && File.Exists(Path.Combine(current, "T3.exe")))
                {
                    var launch = new ProcessStartInfo(Path.Combine(current, "T3.exe")) { UseShellExecute = false, WorkingDirectory = current, CreateNoWindow = true };
                    foreach (string argument in args) launch.ArgumentList.Add(argument);
                    Process.Start(launch);
                    return;
                }
            }
            var setup = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (string value in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                Path.Combine(RepoRoot, "Install.ps1"), "-InstallRoot", RepoRoot, "-BootstrapPid", Environment.ProcessId.ToString(), "-Start" }) setup.ArgumentList.Add(value);
            using var installer = Process.Start(setup);
            installer?.WaitForExit();
            if (installer == null || installer.ExitCode != 0)
                MessageBox.Show("Installation failed. Run Install.cmd to see the error.", "T3");
            return;
        }
        if (File.Exists(installMarker))
        {
            try { ReadInstalledProfile(installMarker); }
            catch (Exception error)
            {
                MessageBox.Show("Invalid installation profile: " + error.Message, "T3", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }

        if (args.Contains("--exit", StringComparer.OrdinalIgnoreCase))
        {
            if (EventWaitHandle.TryOpenExisting(MutexName + "_Exit", out var signal))
            {
                using (signal) { signal.Set(); }
            }
            return;
        }

        if (!File.Exists(TsxEntry) || !Directory.Exists(ServerDir))
        {
            MessageBox.Show(
                "T3 files were not found next to this executable." + Environment.NewLine
                + "Keep T3.exe at the repo root (the folder that contains apps\\).",
                "T3",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        using var mutex = new Mutex(true, MutexName, out bool isFirstInstance);
        if (!isFirstInstance)
        {
            OpenBrowser();
            return;
        }
        if (IsPortOpen())
        {
            // A managed installation must never silently open another library's listener.
            if (ManagedDataDirectory != null)
                MessageBox.Show($"Port {Port} is already in use. This library was not started.", DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            else OpenBrowser();
            return;
        }
        if (ManagedDataDirectory != null && IsPortOpen(TlsPort))
        {
            MessageBox.Show($"Phone port {TlsPort} is already in use. This library was not started.", DisplayName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // Each installed library has its own exit signal and owned process tree.
        using var dispatcher = new Control();
        _ = dispatcher.Handle;
        using var exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, MutexName + "_Exit");
        var exitWait = ThreadPool.RegisterWaitForSingleObject(exitSignal,
            (_, _) => dispatcher.BeginInvoke(new Action(Application.Exit)), null, Timeout.Infinite, true);

        _tray = BuildTray();
        Application.ApplicationExit += (_, _) => StopServer();

        _nodeExecutable = LauncherPolicy.FindCompatibleNode(RepoRoot, ServerDir);
        if (_nodeExecutable == null)
        {
            Notify("T3 could not find a Node.js runtime compatible with the installed database module. See t3-server.log.");
            File.AppendAllText(ServerLog,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] no compatible Node.js runtime found{Environment.NewLine}");
            Application.Run();
            return;
        }
        File.AppendAllText(ServerLog,
            $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] using Node.js: {_nodeExecutable}{Environment.NewLine}");

        if (!File.Exists(WebIndex))
        {
            Notify("First run: building the web UI (one-time, may take a minute)...");
            if (!RunBuild())
            {
                Notify("Build failed - see the output in t3-server.log");
                return;
            }
        }

        StartServer();
        if (WaitForServer(TimeSpan.FromSeconds(25)))
        {
            OpenBrowser();
            RefreshTrayState();
            Notify(RunningMessage());
        }
        else
        {
            Notify("T3 failed to start - see t3-server.log");
        }

        Application.Run();
        exitWait.Unregister(null);
    }

    private static void ReadInstalledProfile(string marker)
    {
        using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(marker));
        var profile = document.RootElement;
        string root = Path.GetFullPath(profile.GetProperty("installRoot").GetString()!).TrimEnd(Path.DirectorySeparatorChar);
        string data = Path.GetFullPath(profile.GetProperty("dataDirectory").GetString()!).TrimEnd(Path.DirectorySeparatorChar);
        if (!RepoRoot.StartsWith(Path.Combine(root, "versions") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || !data.Equals(Path.Combine(root, "data"), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Program and data must belong to this installation.");
        for (string? path = data; path != null; path = Path.GetDirectoryName(path))
            if (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Redirected data directories are not supported.");
        Port = profile.TryGetProperty("port", out var port) ? port.GetInt32() : 8765;
        TlsPort = profile.TryGetProperty("tlsPort", out var tlsPort) ? tlsPort.GetInt32() : 8766;
        if (Port is < 1024 or > 65535 || TlsPort is < 1024 or > 65535 || Port == TlsPort)
            throw new InvalidOperationException("Invalid instance ports.");
        DisplayName = profile.TryGetProperty("displayName", out var name) ? name.GetString()! : "T3";
        if (string.IsNullOrWhiteSpace(DisplayName) || DisplayName.Length > 28)
            throw new InvalidOperationException("Invalid instance name.");
        ManagedDataDirectory = data;
        Environment.SetEnvironmentVariable("T3_DATA_DIR", data);
        string identity = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(data.ToUpperInvariant())));
        MutexName = "T3Launcher_TagTraceTrove_" + identity;
    }

    /// <summary>The icon compiled into this executable, which is T3's own artwork.</summary>
    private static Icon? LauncherIcon()
    {
        try
        {
            string? path = Environment.ProcessPath;
            return path is null ? null : Icon.ExtractAssociatedIcon(path);
        }
        catch
        {
            return null;
        }
    }

    private static NotifyIcon BuildTray()
    {
        var openItem = new ToolStripMenuItem("Open T3");
        openItem.Click += (_, _) => OpenBrowser();

        _lanToggleItem = new ToolStripMenuItem("Allow phone access (LAN)")
        {
            Checked = _lanEnabled,
            CheckOnClick = false,
        };
        _lanToggleItem.Click += (_, _) => SetLanMode(!_lanEnabled);

        _mobileAddressesItem = new ToolStripMenuItem("Mobile addresses");
        RefreshMobileAddressMenu();

        var firewallItem = new ToolStripMenuItem("Windows Firewall help");
        firewallItem.Click += (_, _) => ShowFirewallHelp();

        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (_, _) =>
        {
            if (_tray != null) { _tray.Visible = false; }
            Application.Exit();
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add(openItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_lanToggleItem);
        menu.Items.Add(_mobileAddressesItem);
        menu.Items.Add(firewallItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        var icon = new NotifyIcon
        {
            // The launcher's own artwork (the same one the exe carries), so the tray and the
            // taskbar cannot drift apart. Falls back to the system icon if it cannot be read.
            Icon = LauncherIcon() ?? SystemIcons.Application,
            Text = DisplayName + " - starting",
            ContextMenuStrip = menu,
            Visible = true,
        };
        icon.DoubleClick += (_, _) => OpenBrowser();
        return icon;
    }

    private static void SetLanMode(bool enabled)
    {
        if (enabled)
        {
            DialogResult answer = MessageBox.Show(
                "LAN access exposes this T3 library to devices on the current network."
                + Environment.NewLine + Environment.NewLine
                + "Enable it only on a trusted home network. T3 will not change Windows Firewall automatically."
                + Environment.NewLine + Environment.NewLine
                + "Continue?",
                "T3 - Enable LAN access",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes)
            {
                return;
            }
        }

        _lanEnabled = enabled;
        RefreshTrayState();
        StopServer();
        StartServer();

        if (WaitForServer(TimeSpan.FromSeconds(25)))
        {
            RefreshTrayState();
            if (_lanEnabled)
            {
                ShowLanAddresses();
            }
            else
            {
                Notify("LAN access is off. T3 is localhost-only.");
            }
            return;
        }

        if (_lanEnabled)
        {
            _lanEnabled = false;
            RefreshTrayState();
            StopServer();
            StartServer();
            WaitForServer(TimeSpan.FromSeconds(25));
        }
        Notify("T3 failed to switch mode - see t3-server.log");
    }

    private static void RefreshTrayState()
    {
        if (_lanToggleItem != null)
        {
            _lanToggleItem.Checked = _lanEnabled;
        }
        if (_tray != null)
        {
            _tray.Text = DisplayName + (_lanEnabled ? " - LAN access enabled" : " - localhost only");
        }
        RefreshMobileAddressMenu();
    }

    private static void RefreshMobileAddressMenu()
    {
        if (_mobileAddressesItem == null) { return; }
        _mobileAddressesItem.DropDownItems.Clear();
        _mobileAddressesItem.Enabled = _lanEnabled;
        if (!_lanEnabled) { return; }

        IReadOnlyList<string> urls = CurrentMobileUrls();
        if (urls.Count == 0)
        {
            _mobileAddressesItem.DropDownItems.Add(new ToolStripMenuItem("No private IPv4 address found")
            {
                Enabled = false,
            });
            return;
        }

        foreach (string url in urls)
        {
            var addressItem = new ToolStripMenuItem(url);
            addressItem.Click += (_, _) => CopyMobileUrl(url);
            _mobileAddressesItem.DropDownItems.Add(addressItem);
        }
    }

    private static IReadOnlyList<string> CurrentMobileUrls()
    {
        return LauncherPolicy.MobileUrls(LauncherPolicy.FindPrivateIpv4Addresses(), Port);
    }

    private static void ShowLanAddresses()
    {
        IReadOnlyList<string> urls = CurrentMobileUrls();
        string addresses = urls.Count > 0
            ? string.Join(Environment.NewLine, urls)
            : "No private IPv4 address was found. Check that this PC is connected to your home Wi-Fi.";
        MessageBox.Show(
            "LAN access is enabled for this T3 session." + Environment.NewLine + Environment.NewLine
            + addresses + Environment.NewLine + Environment.NewLine
            + "On the phone, open one address while connected to the same Wi-Fi."
            + Environment.NewLine
            + "Right-click the T3 tray icon > Mobile addresses to copy an address."
            + Environment.NewLine
            + "Uncheck Allow phone access (LAN) before using an untrusted network.",
            "T3 - Phone access",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private static void CopyMobileUrl(string url)
    {
        try
        {
            Clipboard.SetText(url);
            Notify("Copied: " + url);
        }
        catch
        {
            Notify("Could not copy the mobile address.");
        }
    }

    private static void ShowFirewallHelp()
    {
        MessageBox.Show(
            "T3 never changes Windows Firewall automatically." + Environment.NewLine + Environment.NewLine
            + "If the phone cannot connect:" + Environment.NewLine
            + "1. Open Windows Security > Firewall & network protection."
            + Environment.NewLine
            + "2. Confirm the current Wi-Fi uses the Private network profile."
            + Environment.NewLine
            + "3. Choose Allow an app through firewall > Change settings."
            + Environment.NewLine
            + "4. Allow Node.js JavaScript Runtime on Private networks only."
            + Environment.NewLine + Environment.NewLine
            + "Do not enable T3 or Node.js on Public networks.",
            "T3 - Windows Firewall",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private static string RunningMessage()
    {
        if (!_lanEnabled)
        {
            return "T3 is running at " + LocalUrl + Environment.NewLine
                + "Right-click the tray icon to stop it or enable phone access.";
        }

        IReadOnlyList<string> urls = CurrentMobileUrls();
        string mobile = urls.Count > 0 ? urls[0] : "No private IPv4 address found";
        return "T3 LAN access is enabled." + Environment.NewLine
            + mobile + Environment.NewLine
            + "Use only on a trusted home network.";
    }

    /// <summary>One-time `pnpm run build` when apps/web/dist is missing.</summary>
    private static bool RunBuild()
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = "npm",
                Arguments = "exec --yes --package=pnpm@10.15.0 -- pnpm run build",
                WorkingDirectory = RepoRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            LauncherPolicy.PrependExecutableDirectory(start, _nodeExecutable!);
            using var build = Process.Start(start);
            if (build == null) { return false; }
            string output = build.StandardOutput.ReadToEnd() + build.StandardError.ReadToEnd();
            build.WaitForExit();
            File.AppendAllText(ServerLog,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] build exit={build.ExitCode}{Environment.NewLine}{output}{Environment.NewLine}");
            return build.ExitCode == 0 && File.Exists(WebIndex);
        }
        catch (Exception error)
        {
            File.AppendAllText(ServerLog, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] build error: {error}{Environment.NewLine}");
            return false;
        }
    }

    private static void StartServer()
    {
        var start = new ProcessStartInfo
        {
            FileName = _nodeExecutable!,
            WorkingDirectory = ServerDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(TsxEntry);
        start.ArgumentList.Add("src/http/server-cli.ts");
        start.Environment["T3_PORT"] = Port.ToString();
        start.Environment["T3_TLS_PORT"] = TlsPort.ToString();
        if (ManagedDataDirectory != null)
        {
            start.Environment["T3_DATA_DIR"] = ManagedDataDirectory;
            start.Environment["T3_DB_NAME"] = "library.db";
            start.Environment["T3_PAIRING_CONFIG_DIR"] = Path.Combine(ManagedDataDirectory, "private-authorization");
            start.Environment["SITEPROBE_HOME"] = Path.Combine(ManagedDataDirectory, "siteprobe");
            start.Environment["T3_SITEPROBE_TOOL"] = Path.Combine(RepoRoot, "siteprobe");
            start.Environment["T3_STATIC_ROOT"] = Path.Combine(RepoRoot, "apps", "web", "dist");
            start.Environment.Remove("T3_PAIRED_HOST");
        }
        LauncherPolicy.PrependExecutableDirectory(start, _nodeExecutable!);
        string openssl = Path.Combine(RepoRoot, "tools", "openssl");
        if (Directory.Exists(openssl))
        {
            start.Environment["PATH"] = openssl + Path.PathSeparator + start.Environment["PATH"];
            start.Environment["OPENSSL_CONF"] = Path.Combine(openssl, "openssl.cnf");
        }
        string python = Path.Combine(RepoRoot, "siteprobe", ".venv", "Scripts", "python.exe");
        if (File.Exists(python)) start.Environment["SITEPROBE_PYTHON"] = python;
        string browsers = Path.Combine(RepoRoot, "tools", "playwright");
        if (Directory.Exists(browsers)) start.Environment["PLAYWRIGHT_BROWSERS_PATH"] = browsers;
        bool allowMobile = LauncherPolicy.AutoAllowMobileConnection(
            LauncherPolicy.SystemSettingsPath(ServerDir, Environment.GetEnvironmentVariable("T3_DATA_DIR")));
        if (!allowMobile)
        {
            File.AppendAllText(ServerLog, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] phone access is off in the desktop's System settings; not advertising a pairing address{Environment.NewLine}");
        }
        LauncherPolicy.ApplyServerEnvironment(start, _lanEnabled, allowMobile);
        try
        {
            _server = Process.Start(start);
            if (_server == null) { return; }
            _server.EnableRaisingEvents = true;
            _ = PumpAsync(_server.StandardOutput);
            _ = PumpAsync(_server.StandardError);
        }
        catch (Exception error)
        {
            File.AppendAllText(ServerLog, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] start error: {error}{Environment.NewLine}");
        }
    }

    private static async Task PumpAsync(StreamReader reader)
    {
        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                File.AppendAllText(ServerLog, $"[{DateTime.Now:HH:mm:ss}] {line}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never crash the launcher.
        }
    }

    private static void StopServer()
    {
        if (_server == null) { return; }
        LauncherPolicy.StopProcessTree(_server);
        _server.Dispose();
        _server = null;
    }

    private static bool WaitForServer(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (IsPortOpen()) { return true; }
            // The server boots on its own process; keep this one answering the
            // tray so a slow start never looks like a hang.
            Application.DoEvents();
            Thread.Sleep(250);
        }
        return IsPortOpen();
    }

    private static bool IsPortOpen(int? requestedPort = null)
    {
        try
        {
            using var client = new TcpClient();
            var task = client.ConnectAsync("127.0.0.1", requestedPort ?? Port);
            return task.Wait(400) && client.Connected;
        }
        catch
        {
            return false;
        }
    }

    private static void OpenBrowser()
    {
        if (_noBrowser) { return; }
        // Handing the URL to the shell can block for as long as a cold browser
        // needs to start up, and it never returns if Windows decides to ask which
        // app should handle it. The windowless `start` command owns the launch on
        // its own thread instead, so the tray never waits on a browser.
        Task.Run(() =>
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c start \"\" \"" + LocalUrl + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                })?.Dispose();
            }
            catch
            {
                // No default browser; the URL remains visible in the tray UI.
            }
        });
    }

    private static void Notify(string text)
    {
        if (_tray == null) { return; }
        _tray.BalloonTipTitle = DisplayName;
        _tray.BalloonTipText = text;
        _tray.ShowBalloonTip(4000);
    }
}
