using System.Diagnostics;
using System.Text;

namespace CodexDreamSkin.Manager;

// Real processes exercise inherited pipe handles, not mocked Process results.
internal static class RunnerSelfTests
{
  public static bool Run(RuntimeProvisioner runtime)
  {
    var temporary = Path.Combine(Path.GetTempPath(), "codex-runner-test-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(temporary);
    var script = Path.Combine(temporary, "fixture.ps1");
    var identity = Path.Combine(temporary, "child.identity");
    var runner = new PowerShellRunner(runtime);
    const string spawnChild = """
      $start = New-Object System.Diagnostics.ProcessStartInfo
      $start.FileName = (Get-Command node.exe).Source
      $start.Arguments = '-e "setTimeout(() => {}, 30000)"'
      $start.UseShellExecute = $false
      $start.CreateNoWindow = $true
      $child = [System.Diagnostics.Process]::Start($start)
      $identity = @($child.Id, $child.StartTime.ToUniversalTime().ToString('o'))
      [System.IO.File]::WriteAllLines((Join-Path $PSScriptRoot 'child.identity'), $identity)
      """;

    ProcessResult RunFixture(string content, bool detached = false, CancellationToken token = default)
    {
      File.WriteAllText(script, content, new UTF8Encoding(false));
      return runner.RunScriptAsync(script, Array.Empty<string>(), token, detachedOutput: detached)
        .GetAwaiter().GetResult();
    }

    void StopFixtureChild()
    {
      if (!File.Exists(identity)) return;
      var parts = File.ReadAllLines(identity);
      try
      {
        using var child = Process.GetProcessById(int.Parse(parts[0]));
        if (!child.HasExited && child.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase) &&
            child.StartTime.ToUniversalTime().ToString("o") == parts[1])
        {
          child.Kill(entireProcessTree: true);
          child.WaitForExit(2000);
        }
      }
      catch (ArgumentException) { /* Already exited. */ }
      File.Delete(identity);
    }

    try
    {
      // Ordinary structured output must remain complete, including libraries > 64 KiB.
      var ordinary = RunFixture("[Console]::Out.Write('[' + ('1,' * 50000) + '0]'); [Console]::Error.Write('ordinary-error')");
      if (ordinary.ExitCode != 0 || ordinary.StandardOutput.Length != 100003 || ordinary.StandardError != "ordinary-error") return false;

      var bounded = RunFixture("[Console]::Out.Write('x' * 200000); [Console]::Error.Write('y' * 200000)", detached: true);
      if (bounded.ExitCode != 0 || bounded.StandardOutput.Length > PowerShellRunner.MaximumCapturedCharacters + 30 ||
          !bounded.StandardOutput.EndsWith("[output truncated]") || !bounded.StandardError.EndsWith("[output truncated]")) return false;

      using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
      {
        var stopwatch = Stopwatch.StartNew();
        var failed = RunFixture(spawnChild + "\n[Console]::Out.Write('parent-output'); [Console]::Error.Write('fixture launch failed'); exit 7", true, timeout.Token);
        if (failed.ExitCode != 7 || failed.StandardError != "fixture launch failed" || failed.StandardOutput != "parent-output" ||
            stopwatch.Elapsed > TimeSpan.FromSeconds(4) || !File.Exists(identity)) return false;
        using var child = Process.GetProcessById(int.Parse(File.ReadAllLines(identity)[0]));
        if (child.HasExited) return false; // Prove return preceded the inherited pipe's EOF.
        StopFixtureChild();
      }

      using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
      {
        var stopwatch = Stopwatch.StartNew();
        var success = RunFixture(spawnChild + "\n[Console]::Out.Write('started'); exit 0", true, timeout.Token);
        if (success.ExitCode != 0 || success.StandardOutput != "started" || stopwatch.Elapsed > TimeSpan.FromSeconds(4)) return false;
        StopFixtureChild();
      }

      using (var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(3)))
      {
        var cancelled = false;
        try { RunFixture(spawnChild + "\nStart-Sleep -Seconds 30", true, cancellation.Token); }
        catch (OperationCanceledException) { cancelled = true; }
        if (!cancelled || !File.Exists(identity)) return false;
        try
        {
          using var child = Process.GetProcessById(int.Parse(File.ReadAllLines(identity)[0]));
          if (!child.HasExited) return false;
        }
        catch (ArgumentException) { /* Cancellation killed the owned child tree. */ }
        StopFixtureChild();
      }

      var privatePath = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      try
      {
        new ProcessResult(1, string.Empty, $"api_key=fixture-private-secret authorization: Bearer fixture-bearer-secret \"password\":\"fixture quoted secret\" {privatePath}")
          .ThrowIfFailed("fixture");
        return false;
      }
      catch (InvalidOperationException error)
      {
        if (error.Message.Contains("fixture-private-secret") || error.Message.Contains("fixture-bearer-secret") || error.Message.Contains("fixture quoted secret") ||
            (!string.IsNullOrEmpty(privatePath) && error.Message.Contains(privatePath))) return false;
      }
      return true;
    }
    finally
    {
      StopFixtureChild();
      var temporaryRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar)
        + Path.DirectorySeparatorChar;
      var resolvedTemporary = Path.GetFullPath(temporary);
      if (!resolvedTemporary.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase) ||
          !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(resolvedTemporary), "^codex-runner-test-[a-f0-9]{32}$") ||
          (File.GetAttributes(resolvedTemporary) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Refusing to remove an unexpected test directory.");
      Directory.Delete(temporary, recursive: true);
    }
  }
}
