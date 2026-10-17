using System.Diagnostics;
using System.Globalization;
using System.Windows.Forms;
using T3Launcher;

internal static class InstallationProgressCheck
{
    public static void Run()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Check(0, "zh-CN");
                Check(7, "en-US");
                Check(-1, "zh-CN");
            }
            catch (Exception error) { failure = error; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!thread.Join(TimeSpan.FromSeconds(15))) throw new TimeoutException("Installation progress window did not finish.");
        if (failure != null) throw failure;
        Console.WriteLine("PASS: visible window before process, streamed stage/count, responsive waiting, guarded close, success/nonzero/start-failure auto-close and logs, Chinese/English. No installation or library started.");
    }

    private static void Check(int expectedExit, string culture)
    {
        CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo(culture);
        void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        string root = Path.Combine(Path.GetTempPath(), "t3-progress-check-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string script = Path.Combine(root, "progress.ps1");
        File.WriteAllText(script, $"""
            Write-Host '[17:50:44] Verifying 250/1000 : apps/file.js'
            Start-Sleep -Milliseconds 300
            Write-Host '[17:50:45] Copying 500/1000 : apps/file.js'
            Start-Sleep -Milliseconds 300
            Write-Host '[17:50:46] Backing up existing data'
            Start-Sleep -Milliseconds 300
            Write-Host '[17:50:47] Starting installed T3'
            [Console]::Error.WriteLine('fixture stderr')
            exit {expectedExit}
            """);
        var setup = new ProcessStartInfo(expectedExit < 0 ? Path.Combine(root, "missing.exe") : "powershell.exe")
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        foreach (string argument in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script }) setup.ArgumentList.Add(argument);
        bool responsive = false;
        bool copied = false;
        int exit = -1;
        string? log = null;
        InstallationProgressWindow? window = null;
        using var timer = new System.Windows.Forms.Timer { Interval = 50 };
        timer.Tick += (_, _) => { responsive = true; };
        using var ownedWindow = new InstallationProgressWindow(async report =>
        {
            Require(window!.Visible, "Installer began before its window was visible.");
            window.Close();
            Require(window.Visible, "Closing the window interrupted installation.");
            timer.Start();
            (exit, log) = await T3Launcher.Program.RunInstallerAsync(setup, root, line =>
            {
                report(line);
                if (line.Contains("Verifying 250/1000"))
                    Require(window.ProgressStyle == ProgressBarStyle.Continuous && window.ProgressValue == 25, "Verification count did not update progress.");
                if (line.Contains("Copying 500/1000"))
                {
                    Require(window.StageText.Contains("500") && !window.StageText.Contains("apps/file.js"), "Copy progress did not display a user-facing stage.");
                    copied = true;
                    if (expectedExit == 0)
                    {
                        using var screenshot = new System.Drawing.Bitmap(window.Width, window.Height);
                        window.DrawToBitmap(screenshot, window.ClientRectangle with { Width = window.Width, Height = window.Height });
                        string image = Path.Combine(root, "installation-window.png");
                        screenshot.Save(image);
                        Console.WriteLine("Window screenshot: " + image);
                    }
                }
                if (line.Contains("Backing up existing data"))
                    Require(window.ProgressStyle == ProgressBarStyle.Marquee, "A stage without a file count must remain indeterminate.");
            });
            timer.Stop();
            Require(responsive, "Waiting blocked the window's message loop.");
        });
        window = ownedWindow;
        window.ShowDialog();
        Require(!window.Visible, "Finished installation did not close its window.");
        if (expectedExit < 0) Require(window.Failure is System.ComponentModel.Win32Exception, "Process creation failure was not preserved for the launcher error/log path.");
        else
        {
            Require(window.Failure is null && exit == expectedExit && copied, "Installer did not stream progress or preserve its exit code.");
            Require(log != null && File.ReadAllText(log).Contains("fixture stderr") && File.ReadAllText(log).Contains("Installer exit=" + expectedExit), "Installer output/exit was not logged.");
        }
    }
}
