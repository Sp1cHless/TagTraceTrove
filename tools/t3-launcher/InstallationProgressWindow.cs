using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

[assembly: InternalsVisibleTo("T3Launcher.ContractTests")]

namespace T3Launcher;

internal sealed class InstallationProgressWindow : Form
{
    private readonly Func<Action<string>, Task> _install;
    private readonly bool _chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
    private readonly Label _stage = new() { AutoSize = false, Dock = DockStyle.Fill };
    private readonly Label _elapsed = new() { AutoSize = true, Dock = DockStyle.Fill };
    private readonly ProgressBar _progress = new() { Dock = DockStyle.Fill, Style = ProgressBarStyle.Marquee };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 1000 };
    private readonly Stopwatch _watch = new();
    private bool _finished;

    internal Exception? Failure { get; private set; }
    internal string StageText => _stage.Text;
    internal ProgressBarStyle ProgressStyle => _progress.Style;
    internal int ProgressValue => _progress.Value;

    internal InstallationProgressWindow(Func<Action<string>, Task> install)
    {
        _install = install;
        Text = _chinese ? "T3 · 正在安装" : "T3 · Installing";
        ClientSize = new System.Drawing.Size(460, 190);
        Font = new System.Drawing.Font("Microsoft YaHei UI", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        ControlBox = false;
        MaximizeBox = false;
        MinimizeBox = false;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 4 };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        _stage.Text = _chinese ? "正在准备安装…" : "Preparing installation…";
        layout.Controls.Add(_stage, 0, 0);
        layout.Controls.Add(_progress, 0, 1);
        layout.Controls.Add(new Label { Dock = DockStyle.Fill, Text = _chinese
            ? "首次安装或更新可能需要几十秒。\n完成后会自动打开 T3，请稍候。"
            : "First installation or an update may take a little while.\nT3 will open automatically when ready." }, 0, 2);
        layout.Controls.Add(_elapsed, 0, 3);
        Controls.Add(layout);
        _timer.Tick += (_, _) => UpdateElapsed();
        FormClosing += (_, e) => { if (!_finished) e.Cancel = true; };
        Shown += async (_, _) =>
        {
            _watch.Start();
            UpdateElapsed();
            _timer.Start();
            // Let Windows paint the window before starting any installer work.
            await Task.Yield();
            try { await _install(UpdateStage); }
            catch (Exception error) { Failure = error; }
            finally { _finished = true; _timer.Stop(); Close(); }
        };
    }

    private void UpdateElapsed() => _elapsed.Text = _chinese
        ? $"已等待 {_watch.Elapsed.TotalSeconds:F0} 秒"
        : $"Elapsed: {_watch.Elapsed.TotalSeconds:F0} seconds";

    internal void UpdateStage(string line)
    {
        string message = Regex.Replace(line, @"^\[\d{2}:\d{2}:\d{2}\]\s*", "");
        var count = Regex.Match(message, @"^(Verifying|Copying) (\d+)/(\d+)\s*:");
        if (count.Success && int.TryParse(count.Groups[2].Value, out int current)
            && int.TryParse(count.Groups[3].Value, out int total) && total > 0)
        {
            _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = (int)Math.Clamp(100L * current / total, 0, 100);
            string stage = count.Groups[1].Value == "Copying"
                ? (_chinese ? "正在安装程序" : "Installing program")
                : (_chinese ? "正在检查文件" : "Checking files");
            _stage.Text = $"{stage} ({current:N0} / {total:N0})";
            return;
        }
        string? caption = message switch
        {
            "Loading installation helpers" => _chinese ? "正在准备安装…" : "Preparing installation…",
            _ when message.StartsWith("Checking package at ") => _chinese ? "正在检查安装包…" : "Checking installation package…",
            "Checking destination paths and installation record" or "Acquiring installation lock" or "Checking process ownership (WMI)"
                => _chinese ? "正在检查安装环境…" : "Checking installation environment…",
            "Backing up existing data" => _chinese ? "正在备份已有资料…" : "Backing up existing data…",
            _ when message.StartsWith("Copying program to ") => _chinese ? "正在安装程序…" : "Installing program…",
            "Checking copied program" => _chinese ? "正在检查安装结果…" : "Checking installed files…",
            "Committing installed version" or "Updating installation entry points" or "Creating desktop shortcut"
                => _chinese ? "正在完成安装…" : "Finishing installation…",
            "Starting installed T3" or "Installation completed" => _chinese ? "正在启动 T3…" : "Starting T3…",
            _ when message.StartsWith("FAILED during ") => _chinese ? "安装未完成，正在保存错误信息…" : "Saving installation error details…",
            _ => null,
        };
        if (caption is null) return;
        _stage.Text = caption;
        _progress.Style = ProgressBarStyle.Marquee;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _timer.Dispose();
        base.Dispose(disposing);
    }
}
