using System.Text.Json;
using T3Launcher;

internal static class BootstrapRecoveryCheck
{
    public static void Run()
    {
        string root = Path.Combine(Path.GetTempPath(), "t3-bootstrap-check-" + Guid.NewGuid().ToString("N"));
        string current = Path.Combine(root, "versions", "1.0.10");
        Directory.CreateDirectory(current);
        File.WriteAllText(Path.Combine(current, "T3.exe"), "never executed fixture");
        string Record(string version, string? directory, string product = "T3") => JsonSerializer.Serialize(new { product, version, currentDirectory = directory });
        void Require(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
        void Reject(string json)
        {
            bool rejected = false;
            try { LauncherPolicy.InstalledProgramToLaunch(root, json, "1.0.10"); }
            catch { rejected = true; }
            Require(rejected, "Invalid record was not rejected: " + json);
        }
        Require(LauncherPolicy.InstalledProgramToLaunch(root, Record("0.0.0", null), "1.0.10") is null, "Reported interrupted installation must resume without GetFullPath(null).");
        Require(LauncherPolicy.InstalledProgramToLaunch(root, Record("1.0.10", current), "1.0.10") == current, "A complete same-version install must hand off.");
        Require(LauncherPolicy.InstalledProgramToLaunch(root, Record("1.0.10", current), "1.0.11") is null, "A newer payload must run installation.");
        Reject(Record("1.0.10", null));
        Reject(Record("1.0.10", ""));
        Reject(Record("1.0.10", Path.GetTempPath()));
        Reject(Record("0.0.0", null, "Other"));
        Reject("{invalid");
        string? log = LauncherPolicy.AppendStartupLog(root, "interrupted installation fixture");
        Require(log is not null && File.ReadAllText(log).Contains("interrupted installation fixture"), "Startup log was not saved.");
        Console.WriteLine("PASS: interrupted/null recovery, completed handoff, upgrade, invalid records and startup logging. Fixture: " + root);
    }
}
