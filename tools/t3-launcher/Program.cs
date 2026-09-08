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
    private const string MutexName = "T3Launcher_TagTraceTrove_SingleInstance";
    private const int Port = 8765;
    private static readonly string RepoRoot =
        AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly string ServerDir = Path.Combine(RepoRoot, "apps", "server");
    private static readonly string TsxCmd = Path.Combine(ServerDir, "node_modules", ".bin", "tsx.cmd");
    private static readonly string WebIndex = Path.Combine(RepoRoot, "apps", "web", "dist", "index.html");
    private static readonly string ServerLog = Path.Combine(RepoRoot, "t3-server.log");
    private static readonly string LocalUrl = $"http://127.0.0.1:{Port}";

    private static NotifyIcon? _tray;
    private static ToolStripMenuItem? _lanToggleItem;
    private static ToolStripMenuItem? _mobileAddressesItem;
    private static Process? _server;
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

        if (!File.Exists(TsxCmd) || !Directory.Exists(ServerDir))
        {
            MessageBox.Show(
                "T3 files were not found next to this executable." + Environment.NewLine
                + "Keep T3.exe at the repo root (the folder that contains apps\\).",
                "T3",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        if (IsPortOpen())
        {
            // The server is already running (tray instance or not): just open the UI.
            OpenBrowser();
            return;
        }

        using var mutex = new Mutex(true, MutexName, out bool isFirstInstance);
        if (!isFirstInstance)
        {
            OpenBrowser();
            return;
        }

        _tray = BuildTray();
        Application.ApplicationExit += (_, _) => StopServer();

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
            Icon = SystemIcons.Application,
            Text = "T3 - starting",
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
            _tray.Text = _lanEnabled ? "T3 - LAN access enabled" : "T3 - localhost only";
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
            using var build = Process.Start(new ProcessStartInfo
            {
                FileName = "npm",
                Arguments = "exec --yes --package=pnpm@10.15.0 -- pnpm run build",
                WorkingDirectory = RepoRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
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
            FileName = "cmd.exe",
            Arguments = "/c \"" + TsxCmd + "\" src\\http\\server-cli.ts",
            WorkingDirectory = ServerDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        LauncherPolicy.ApplyServerEnvironment(start, _lanEnabled);
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
            Thread.Sleep(500);
        }
        return IsPortOpen();
    }

    private static bool IsPortOpen()
    {
        try
        {
            using var client = new TcpClient();
            var task = client.ConnectAsync("127.0.0.1", Port);
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
        try
        {
            Process.Start(new ProcessStartInfo { FileName = LocalUrl, UseShellExecute = true });
        }
        catch
        {
            // No default browser; the URL remains visible in the tray UI.
        }
    }

    private static void Notify(string text)
    {
        if (_tray == null) { return; }
        _tray.BalloonTipTitle = "T3";
        _tray.BalloonTipText = text;
        _tray.ShowBalloonTip(4000);
    }
}
