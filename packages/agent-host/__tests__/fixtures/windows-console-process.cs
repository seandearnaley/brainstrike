using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Test-only bridge. SIGINT through Node's kill API forcibly terminates Windows
// processes: https://nodejs.org/api/process.html#signal-events . A hidden, new
// console confines real CTRL_C_EVENT delivery to this fixture and its broker:
// https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent .
public sealed class WindowsFixtureConsole : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int Length; public IntPtr Descriptor; public int Inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int Size; public string Reserved; public string Desktop; public string Title;
    public int X; public int Y; public int Width; public int Height;
    public int BufferWidth; public int BufferHeight; public int Fill; public int Flags;
    public short Show; public short ReservedSize; public IntPtr ReservedBytes;
    public IntPtr Input; public IntPtr Output; public IntPtr Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process; public IntPtr Thread; public uint Pid; public uint Tid;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo Info; public IntPtr Attributes;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr handle, int flags, StringBuilder name, ref int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool ignore);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] processes, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint control, uint group);

  static readonly object OutputLock = new object();
  static TextWriter Reporter;
  IntPtr handle;
  StreamWriter input;
  Task completed;
  public uint Pid { get; private set; }
  public long Start { get; private set; }
  public string Executable { get; private set; }
  public string CommandLine { get; private set; }

  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(string value) { lock (OutputLock) { Reporter.WriteLine(value); Reporter.Flush(); } }
  static string Quote(string argument) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in argument) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
      else { result.Append('\\', slashes); result.Append(character); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }
  static async Task Pump(Stream stream, string kind) {
    using (var reader = new StreamReader(stream, Encoding.UTF8)) {
      var buffer = new char[4096]; int count;
      while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0) {
        var data = Convert.ToBase64String(Encoding.UTF8.GetBytes(new string(buffer, 0, count)));
        Emit("{\"event\":\"" + kind + "\",\"base64\":\"" + data + "\"}");
      }
    }
  }
  public static WindowsFixtureConsole Launch(string executable, string[] arguments, string cwd) {
    Reporter = Console.Out;
    var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = 1 };
    IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
    IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
    IntPtr errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
    IntPtr attributeList = IntPtr.Zero, inheritedHandles = IntPtr.Zero;
    bool attributesInitialized = false;
    var owner = new WindowsFixtureConsole();
    try {
      Check(CreatePipe(out inputRead, out inputWrite, ref attributes, 0));
      Check(CreatePipe(out outputRead, out outputWrite, ref attributes, 0));
      Check(CreatePipe(out errorRead, out errorWrite, ref attributes, 0));
      Check(SetHandleInformation(inputWrite, 1, 0));
      Check(SetHandleInformation(outputRead, 1, 0));
      Check(SetHandleInformation(errorRead, 1, 0));
      var command = new StringBuilder(Quote(executable));
      foreach (var argument in arguments) command.Append(" ").Append(Quote(argument));
      owner.CommandLine = command.ToString();
      // Whitelist only the target's stdio handles. Otherwise the detached host
      // inherits the broker's report/control pipes and prevents broker close.
      // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
      IntPtr attributeBytes = IntPtr.Zero;
      if (InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes) || Marshal.GetLastWin32Error() != 122)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      attributeList = Marshal.AllocHGlobal(attributeBytes);
      Check(InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes));
      attributesInitialized = true;
      inheritedHandles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      Marshal.Copy(new[] { inputRead, outputWrite, errorWrite }, 0, inheritedHandles, 3);
      Check(UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x20002), inheritedHandles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var startup = new StartupInfoEx {
        Info = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfoEx)), Flags = 0x101, Show = 0, Input = inputRead, Output = outputWrite, Error = errorWrite },
        Attributes = attributeList
      };
      ProcessInfo created;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NEW_CONSOLE plus SW_HIDE.
      Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80010, IntPtr.Zero, cwd, ref startup, out created));
      owner.handle = created.Process; owner.Pid = created.Pid; CloseHandle(created.Thread);
      long started, ended, kernel, user;
      Check(GetProcessTimes(owner.handle, out started, out ended, out kernel, out user)); owner.Start = started;
      var name = new StringBuilder(32768); int size = name.Capacity;
      Check(QueryFullProcessImageNameW(owner.handle, 0, name, ref size)); owner.Executable = name.ToString();
      CloseHandle(inputRead); inputRead = IntPtr.Zero;
      CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
      CloseHandle(errorWrite); errorWrite = IntPtr.Zero;
      owner.input = new StreamWriter(new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write), new UTF8Encoding(false)) { AutoFlush = true }; inputWrite = IntPtr.Zero;
      var output = Pump(new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read), "stdout"); outputRead = IntPtr.Zero;
      var error = Pump(new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read), "stderr"); errorRead = IntPtr.Zero;
      owner.completed = Task.Run(async () => {
        if (WaitForSingleObject(owner.handle, 0xffffffff) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint code; Check(GetExitCodeProcess(owner.handle, out code));
        Emit("{\"event\":\"target-exit\",\"code\":" + code + "}");
        await Task.WhenAll(output, error);
        Emit("{\"event\":\"target-close\",\"code\":" + code + "}");
      });
      return owner;
    } catch { owner.Dispose(); throw; }
    finally {
      if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
      if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
      if (inheritedHandles != IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandles);
      foreach (var pipe in new[] { inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite }) if (pipe != IntPtr.Zero) CloseHandle(pipe);
    }
  }
  public void Write(string value) { input.Write(value); }
  public void EndInput() { if (input != null) { input.Dispose(); input = null; } }
  public uint[] Interrupt() {
    if (WaitForSingleObject(handle, 0) == 0) throw new InvalidOperationException("Owned target already exited");
    FreeConsole(); Check(AttachConsole(Pid));
    try {
      Check(SetConsoleCtrlHandler(IntPtr.Zero, true));
      uint[] attached = new uint[8]; uint count = GetConsoleProcessList(attached, (uint)attached.Length);
      if (count == 0 || count > attached.Length) throw new InvalidOperationException("Cannot establish exclusive fixture console");
      Array.Resize(ref attached, (int)count);
      uint broker = (uint)Process.GetCurrentProcess().Id;
      bool targetPresent = false;
      foreach (uint pid in attached) {
        if (pid == Pid) targetPresent = true;
        if (pid != Pid && pid != broker) throw new InvalidOperationException("Refusing signal to a console containing another process");
      }
      if (!targetPresent) throw new InvalidOperationException("Owned target absent from its console");
      Check(GenerateConsoleCtrlEvent(0, 0));
      return attached;
    } finally { FreeConsole(); }
  }
  public void Crash() {
    if (handle != IntPtr.Zero && WaitForSingleObject(handle, 0) != 0) Check(TerminateProcess(handle, 1));
  }
  public void Dispose() {
    if (handle == IntPtr.Zero) return;
    if (WaitForSingleObject(handle, 0) != 0) {
      Emit("{\"event\":\"cleanup-forced-termination\"}"); Crash();
    }
    if (completed != null) completed.GetAwaiter().GetResult();
    else if (WaitForSingleObject(handle, 0xffffffff) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    EndInput(); CloseHandle(handle); handle = IntPtr.Zero;
  }
}
