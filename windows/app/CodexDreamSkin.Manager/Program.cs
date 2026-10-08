using System.Reflection;

namespace CodexDreamSkin.Manager;

internal static class Program
{
  private const string MutexName = @"Local\CodexDreamSkin.Manager";
  private const string ProductName = "Codex 动态壁纸";

  [STAThread]
  private static int Main(string[] args)
  {
    // Build validation must never unpack into the user's active runtime.
    if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
    {
      var testRoot = Path.Combine(Path.GetTempPath(), "codex-manager-self-test-" + Guid.NewGuid().ToString("N"));
      try
      {
        var testRuntime = new RuntimeProvisioner(testRoot);
        testRuntime.EnsureExtracted();
        return SelfTest.Run(testRuntime);
      }
      catch (Exception exception)
      {
        Console.Error.WriteLine(exception);
        return 1;
      }
      finally
      {
        if (Directory.Exists(testRoot))
        {
          var temporaryRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
          var resolvedRoot = Path.GetFullPath(testRoot);
          if (!resolvedRoot.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase) ||
              !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(resolvedRoot), "^codex-manager-self-test-[a-f0-9]{32}$") ||
              (File.GetAttributes(resolvedRoot) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Refusing to remove an unexpected self-test directory.");
          Directory.Delete(resolvedRoot, recursive: true);
        }
      }
    }

    using var mutex = new Mutex(true, MutexName, out var createdNew);
    if (!createdNew)
    {
      MessageBox.Show(
        $"{ProductName}已经在运行，请查看任务栏托盘。",
        ProductName,
        MessageBoxButtons.OK,
        MessageBoxIcon.Information);
      return 0;
    }

    try
    {
      var runtime = new RuntimeProvisioner();
      runtime.EnsureExtracted();

      Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);

      var settings = new SettingsStore();
      var service = new DreamSkinService(runtime);
      var minimized = args.Contains("--minimized", StringComparer.OrdinalIgnoreCase);
      Application.Run(new MainForm(service, settings, minimized));
      return 0;
    }
    catch (Exception exception)
    {
      var logPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CodexDreamSkin",
        "manager-error.log");
      try
      {
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        File.AppendAllText(logPath, $"[{DateTimeOffset.Now:O}] {exception}\r\n");
      }
      catch
      {
        // The original exception is more important than secondary logging.
      }

      MessageBox.Show(
        $"启动失败：{exception.Message}\r\n\r\n日志：{logPath}",
        ProductName,
        MessageBoxButtons.OK,
        MessageBoxIcon.Error);
      return 1;
    }
  }
}

internal static class SelfTest
{
  public static int Run(RuntimeProvisioner runtime)
  {
    try
    {
      runtime.ValidateExtractedPayload();
      if (!ValidateInjector(runtime)) return 6;
      if (!WallpaperCatalog.IsSupported("sample.mp4") ||
          !WallpaperCatalog.IsSupported("sample.webp") ||
          WallpaperCatalog.IsSupported("sample.exe"))
      {
        return 2;
      }

      var version = Assembly.GetExecutingAssembly().GetName().Version;
      if (version is null)
      {
        return 3;
      }
      return RunnerSelfTests.Run(runtime) ? 0 : 5;
    }
    catch
    {
      return 4;
    }
  }

  private static bool ValidateInjector(RuntimeProvisioner runtime)
  {
    var start = new System.Diagnostics.ProcessStartInfo
    {
      FileName = runtime.NodePath,
      WorkingDirectory = runtime.PayloadRoot,
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
    };
    start.ArgumentList.Add(Path.Combine(runtime.ScriptsRoot, "injector.mjs"));
    start.ArgumentList.Add("--check-payload");
    using var process = System.Diagnostics.Process.Start(start)
      ?? throw new InvalidOperationException("Cannot start embedded Node.js.");
    var output = process.StandardOutput.ReadToEndAsync();
    var error = process.StandardError.ReadToEndAsync();
    if (!process.WaitForExit(30000))
    {
      process.Kill(entireProcessTree: true);
      process.WaitForExit();
      return false;
    }
    Task.WaitAll(output, error);
    return process.ExitCode == 0;
  }

}
