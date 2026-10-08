using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace CodexDreamSkin.Manager;

internal sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError)
{
  public void ThrowIfFailed(string operation)
  {
    if (ExitCode == 0)
    {
      return;
    }

    var detail = string.IsNullOrWhiteSpace(StandardError) ? StandardOutput : StandardError;
    throw new InvalidOperationException($"{operation}失败（{ExitCode}）：{SanitizeDiagnostic(detail.Trim())}");
  }

  internal static string SanitizeDiagnostic(string detail)
  {
    // Only error presentation is redacted: successful structured output must stay intact.
    detail = Regex.Replace(detail, """(?i)(["']?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer\s+)?[^\s,;]+)""", "$1[redacted]");
    detail = Regex.Replace(detail, """(?i)(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)""", "$1[redacted]");
    detail = Regex.Replace(detail, @"\bsk-[A-Za-z0-9_-]{12,}", "[redacted]");
    foreach (var folder in new[] { Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.UserProfile })
    {
      var prefix = Environment.GetFolderPath(folder);
      if (!string.IsNullOrWhiteSpace(prefix)) detail = detail.Replace(prefix, "[user]", StringComparison.OrdinalIgnoreCase);
    }
    return detail;
  }
}

internal sealed class PowerShellRunner
{
  internal const int MaximumCapturedCharacters = 64 * 1024;
  private static readonly TimeSpan DrainTimeout = TimeSpan.FromMilliseconds(500);
  private readonly RuntimeProvisioner _runtime;
  private readonly string _powershellPath;

  public PowerShellRunner(RuntimeProvisioner runtime)
  {
    _runtime = runtime;
    _powershellPath = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.Windows),
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe");
    if (!File.Exists(_powershellPath))
    {
      throw new FileNotFoundException("找不到 Windows PowerShell 5.1。", _powershellPath);
    }
  }

  public async Task<ProcessResult> RunScriptAsync(
    string script,
    IEnumerable<string> arguments,
    CancellationToken cancellationToken = default,
    bool captureOutput = true,
    bool detachedOutput = false)
  {
    var startInfo = new ProcessStartInfo
    {
      FileName = _powershellPath,
      WorkingDirectory = _runtime.PayloadRoot,
      UseShellExecute = false,
      CreateNoWindow = true,
    };
    if (captureOutput)
    {
      startInfo.RedirectStandardOutput = true;
      startInfo.RedirectStandardError = true;
      startInfo.StandardOutputEncoding = System.Text.Encoding.UTF8;
      startInfo.StandardErrorEncoding = System.Text.Encoding.UTF8;
    }
    startInfo.ArgumentList.Add("-NoProfile");
    startInfo.ArgumentList.Add("-ExecutionPolicy");
    startInfo.ArgumentList.Add("RemoteSigned");
    startInfo.ArgumentList.Add("-File");
    startInfo.ArgumentList.Add(script);
    foreach (var argument in arguments)
    {
      startInfo.ArgumentList.Add(argument);
    }

    var nodeDirectory = Path.GetDirectoryName(_runtime.NodePath)!;
    startInfo.Environment["PATH"] = nodeDirectory + Path.PathSeparator +
      (startInfo.Environment.TryGetValue("PATH", out var path) ? path : Environment.GetEnvironmentVariable("PATH"));

    using var process = new Process { StartInfo = startInfo };
    process.Start();
    using var captureCancellation = new CancellationTokenSource();
    var output = new BoundedCapture(detachedOutput ? MaximumCapturedCharacters : int.MaxValue);
    var error = new BoundedCapture(detachedOutput ? MaximumCapturedCharacters : int.MaxValue);
    var outputTask = captureOutput ? output.ReadAsync(process.StandardOutput, captureCancellation.Token) : Task.CompletedTask;
    var errorTask = captureOutput ? error.ReadAsync(process.StandardError, captureCancellation.Token) : Task.CompletedTask;
    try
    {
      await process.WaitForExitAsync(cancellationToken);
    }
    catch (OperationCanceledException)
    {
      if (!process.HasExited)
      {
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync(CancellationToken.None);
      }
      throw;
    }
    finally
    {
      if (captureOutput)
      {
        // Descendants can inherit the write handles after PowerShell has exited.
        // Retain available diagnostics, but never wait for their lifetime or EOF.
        var readers = Task.WhenAll(outputTask, errorTask);
        try
        {
          if (detachedOutput || cancellationToken.IsCancellationRequested)
            await Task.WhenAny(readers, Task.Delay(DrainTimeout));
          else
            await readers.WaitAsync(cancellationToken);
        }
        finally
        {
          captureCancellation.Cancel();
          process.StandardOutput.Dispose();
          process.StandardError.Dispose();
        }
      }
    }
    if (!captureOutput)
    {
      return new ProcessResult(process.ExitCode, string.Empty, string.Empty);
    }
    return new ProcessResult(
      process.ExitCode,
      output.Snapshot(),
      error.Snapshot());
  }

  private sealed class BoundedCapture
  {
    private readonly int _maximumCharacters;
    private readonly StringBuilder _text = new();
    private bool _truncated;

    public BoundedCapture(int maximumCharacters) => _maximumCharacters = maximumCharacters;

    public async Task ReadAsync(StreamReader reader, CancellationToken cancellationToken)
    {
      var buffer = new char[4096];
      try
      {
        while (true)
        {
          var count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
          if (count == 0) return;
          lock (_text)
          {
            var retained = Math.Min(count, _maximumCharacters - _text.Length);
            _text.Append(buffer, 0, retained);
            _truncated |= retained < count;
          }
        }
      }
      catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
      catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested) { }
      catch (IOException) { /* A closed child pipe must not replace the process exit result. */ }
    }

    public string Snapshot()
    {
      lock (_text) return _text.ToString() + (_truncated ? "\n[output truncated]" : string.Empty);
    }
  }
}
