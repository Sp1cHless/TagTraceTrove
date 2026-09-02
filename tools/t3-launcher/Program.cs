using System.Diagnostics;
using System.Drawing;
using System.Net.Sockets;
using System.Windows.Forms;

namespace T3Launcher;

/// <summary>
/// T3 tray launcher. Double-click T3.exe (repo root): starts the single-process
/// server (API + built web UI on 127.0.0.1:8765) hidden in the background,
/// opens the default browser, then stays in the system tray. The tray's Exit
/// stops the server and the launcher. A second launch while the server is up
/// only (re)opens the browser. Pass --no-browser for smoke tests.
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
    private static readonly string Url = $"http://127.0.0.1:{Port}";

    private static NotifyIcon? _tray;
    private static Process? _server;
    private static bool _noBrowser;

    [STAThread]
    private static void Main(string[] args)
    {
        _noBrowser = args.Contains("--no-browser");
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
            // Another tray instance owns the server lifecycle; we only re-open.
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
            Notify("T3 is running at " + Url + Environment.NewLine
                + "Right-click the tray icon to stop it.");
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
        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (_, _) =>
        {
            if (_tray != null) { _tray.Visible = false; }
            Application.Exit();
        };
        var menu = new ContextMenuStrip();
        menu.Items.Add(openItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        var icon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "T3 - running",
            ContextMenuStrip = menu,
            Visible = true,
        };
        icon.DoubleClick += (_, _) => OpenBrowser();
        return icon;
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

    /// <summary>
    /// Starts the server hidden via the workspace-local tsx (no npm exec at
    /// runtime, no console window). The process tree is owned by this launcher
    /// and killed on Exit.
    /// </summary>
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
        start.Environment["T3_OPEN_BROWSER"] = "0";
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
        try
        {
            if (!_server.HasExited)
            {
                _server.Kill(entireProcessTree: true);
                _server.WaitForExit(5000);
            }
        }
        catch
        {
            // Already gone.
        }
        finally
        {
            _server.Dispose();
            _server = null;
        }
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
            Process.Start(new ProcessStartInfo { FileName = Url, UseShellExecute = true });
        }
        catch
        {
            // No default browser; the URL is shown in the tray balloon anyway.
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
