// .NET Framework 4 client for Windows 7 and PowerShell 2.0. No installation,
// elevation request, autostart, WebSocket, or third-party runtime. Build with csc v4.
// The customer window is WPF (part of .NET Framework 4); WinForms is used only
// for MessageBox and the DialogResult type of SupportAccess.Confirm.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Microsoft.Win32.SafeHandles;
using WF = System.Windows.Forms;
using Shapes = System.Windows.Shapes;

namespace SupportMcp {
    public static class SupportAccess {
        public static bool IsAdministrator() {
            using (var identity = WindowsIdentity.GetCurrent())
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        public static string ConsentMessage(bool administrator) {
            string rights = administrator
                ? "This client is running as Administrator. Allow remote support to run commands and read or change files with administrator rights?\n\nSupport can change system settings and files for all users."
                : "Allow remote support to run commands and read or change files as your signed-in user?";
            return rights + "\n\nA small window stays in the corner of your screen while support is connected. Access ends when you close it, click End session, or after 24 hours. Nothing reconnects after reboot unless separately prepared.";
        }
        public static bool Confirm(bool administrator, bool resume, Func<string, WF.DialogResult> prompt) {
            // A prepared reconnect never grants administrator access silently.
            return (resume && !administrator) || prompt(ConsentMessage(administrator)) == WF.DialogResult.Yes;
        }
    }

    public static class Wire {
        public const string Footer = "SUPPORTMCPCFG1";
        public static Dictionary<string, object> Map(params object[] pairs) {
            var d = new Dictionary<string, object>();
            for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1];
            return d;
        }
        public static string Text(Dictionary<string, object> d, string key) {
            object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : "";
        }
        public static long Number(Dictionary<string, object> d, string key) {
            object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToInt64(v) : 0;
        }
        public static bool Flag(Dictionary<string, object> d, string key) {
            object v; return d.TryGetValue(key, out v) && v is bool && (bool)v;
        }
        public static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 800000 }; }
        public static Dictionary<string, object> ReadConfig(string file) {
            using (var s = File.OpenRead(file)) {
                byte[] footer = Encoding.ASCII.GetBytes(Footer), tail = new byte[footer.Length + 4];
                if (s.Length < tail.Length) throw new InvalidDataException("Missing session configuration.");
                s.Position = s.Length - tail.Length; s.Read(tail, 0, tail.Length);
                for (int i = 0; i < footer.Length; i++) if (tail[i + 4] != footer[i]) throw new InvalidDataException("Invalid session configuration.");
                int n = BitConverter.ToInt32(tail, 0);
                if (n < 1 || n > 4096 || n > s.Length - tail.Length) throw new InvalidDataException("Invalid session configuration size.");
                byte[] data = new byte[n]; s.Position -= n + tail.Length; s.Read(data, 0, n);
                var cfg = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(data));
                if (!System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "sid"), "^[0-9a-f]{64}$") ||
                    !System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "key"), "^[0-9a-f]{64}$")) throw new InvalidDataException("Invalid session credentials.");
                Uri origin = new Uri(Text(cfg, "origin"));
                if ((origin.Scheme != "https" && !(origin.Scheme == "http" && origin.IsLoopback)) ||
                    origin.AbsolutePath != "/" || origin.UserInfo != "" || origin.Query != "" || origin.Fragment != "")
                    throw new InvalidDataException("Invalid support server.");
                return cfg;
            }
        }
    }

    // The child starts suspended. Assign it to a kill-on-close Job before any
    // customer command can run. Refuse execution if Windows cannot contain it.
    public sealed class CommandJob : IDisposable {
        IntPtr job, process;
        readonly MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
        Thread outReader, errReader;
        public bool OutClipped, ErrClipped;
        [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
            public int Size; public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref ExtendedLimits limits, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr p, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security s, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security s, uint create, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static void Close(ref IntPtr h) { if (h != IntPtr.Zero && h != new IntPtr(-1)) CloseHandle(h); h = IntPtr.Zero; }
        Thread Drain(IntPtr h, MemoryStream target, bool isOut) {
            var t = new Thread(delegate() {
                try {
                    using (var stream = new FileStream(new SafeFileHandle(h, true), FileAccess.Read)) {
                        byte[] buf = new byte[4096]; int n;
                        while ((n = stream.Read(buf, 0, buf.Length)) != 0) {
                            int take = Math.Min(n, 65536 - (int)target.Length);
                            if (take > 0) target.Write(buf, 0, take);
                            if (take < n) { if (isOut) OutClipped = true; else ErrClipped = true; }
                        }
                    }
                } catch (IOException) { }
            }); t.IsBackground = true; t.Start(); return t;
        }
        public Dictionary<string, object> Run(string scriptPath, string cwd, int timeoutSeconds, WaitHandle stop) {
            IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, input = IntPtr.Zero;
            ProcessInfo pi = new ProcessInfo();
            try {
                job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
                Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)));
                var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
                Check(CreatePipe(out outRead, out outWrite, ref security, 0));
                Check(CreatePipe(out errRead, out errWrite, ref security, 0));
                Check(SetHandleInformation(outRead, 1, 0)); Check(SetHandleInformation(errRead, 1, 0));
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Check(input != new IntPtr(-1));
                var si = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x101, Input = input, Output = outWrite, Error = errWrite };
                string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
                string args = "\"" + exe + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -File \"" + scriptPath + "\"";
                Check(CreateProcess(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref si, out pi));
                process = pi.Process;
                Check(AssignProcessToJobObject(job, process));
                if (stop.WaitOne(0)) throw new OperationCanceledException();
                outReader = Drain(outRead, stdout, true); outRead = IntPtr.Zero;
                errReader = Drain(errRead, stderr, false); errRead = IntPtr.Zero;
                Close(ref outWrite); Close(ref errWrite); Close(ref input);
                Check(ResumeThread(pi.Thread) != uint.MaxValue);
                var clock = Stopwatch.StartNew(); bool timedOut = false;
                while (WaitForSingleObject(process, 100) != 0) {
                    if (stop.WaitOne(0)) throw new OperationCanceledException();
                    if (clock.ElapsedMilliseconds >= timeoutSeconds * 1000L) { timedOut = true; break; }
                }
                uint exit; Check(GetExitCodeProcess(process, out exit));
                Close(ref job); // also stop descendants after their parent exits
                WaitForSingleObject(process, 5000);
                outReader.Join(5000); errReader.Join(5000);
                return Wire.Map("ok", true, "exit_code", timedOut ? null : (object)unchecked((int)exit), "timed_out", timedOut,
                    "stdout_b64", Convert.ToBase64String(stdout.ToArray()), "stderr_b64", Convert.ToBase64String(stderr.ToArray()),
                    "stdout_truncated", OutClipped, "stderr_truncated", ErrClipped);
            } finally {
                // Assignment can fail on Windows 7 inside an existing Job. The
                // unassigned suspended process must be terminated explicitly.
                if (pi.Process != IntPtr.Zero) TerminateProcess(pi.Process, 1);
                Close(ref job); Close(ref process); Close(ref pi.Thread);
                Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite); Close(ref input);
                if (outReader != null) outReader.Join(5000); if (errReader != null) errReader.Join(5000);
            }
        }
        public void Dispose() { Close(ref job); Close(ref process); }
    }

    public sealed class Client : IDisposable {
        readonly Dictionary<string, object> config;
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly object gate = new object();
        readonly System.Threading.Timer deadlineTimer;
        HttpWebRequest request;
        long deadlineMs, generation, expiresAtMs;
        int busy;
        string work;
        public event Action<string> Log;
        public event Action<string> Status;
        public event Action Finished;
        // Raised once, after the first successful handshake. ExpiresLocal is valid.
        public event Action Connected;
        // false while polling fails with a network error, true once it works again.
        public event Action<bool> LinkChanged;
        // Number of command or file operations started and not yet reported to the relay.
        public event Action<int> BusyChanged;
        public string LastError = "";
        // Set only by the visible window when Windows shuts down for an
        // explicitly prepared restart. User close/End still ends the session.
        public volatile bool EndRemote = true;
        public Client(Dictionary<string, object> cfg) {
            config = cfg;
            // The relay sends the first-connect budget as milliseconds left when the
            // file was downloaded, so a PC clock that is wrong cannot end the client
            // at once. The absolute startup_expires_at is only a fallback for a
            // config without it. The relay enforces the same limit on its own clock.
            long remaining = cfg.ContainsKey("startup_ms") ? Wire.Number(cfg, "startup_ms") : Wire.Number(cfg, "startup_expires_at") - UnixNow();
            deadlineMs = Math.Max(0, Math.Min(7200000, remaining));
            deadlineTimer = new System.Threading.Timer(delegate(object state) { if (clock.ElapsedMilliseconds >= Interlocked.Read(ref deadlineMs)) Stop(); }, null, 100, 100);
        }
        public DateTime ExpiresLocal {
            get {
                long ms = Interlocked.Read(ref expiresAtMs);
                return ms == 0 ? DateTime.MinValue : new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime();
            }
        }
        public int BusyCount { get { return Thread.VolatileRead(ref busy); } }
        void Work(int delta) {
            int n = Interlocked.Add(ref busy, delta);
            var changed = BusyChanged; if (changed != null) changed(n);
        }
        void Link(bool up) { var link = LinkChanged; if (link != null) link(up); }
        public static long UnixNow() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
        static string PowerShellVersion() {
            foreach (string version in new string[] { "3", "1" }) {
                object value = Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\PowerShell\" + version + @"\PowerShellEngine", "PowerShellVersion", null);
                if (value != null) return Convert.ToString(value);
            }
            return "unknown";
        }
        void Print(string text) { var log = Log; if (log != null) log(text); }
        void ShowStatus(string text) { var status = Status; if (status != null) status(text); }
        public void Stop() {
            stop.Set(); lock (gate) { if (request != null) request.Abort(); }
        }
        Dictionary<string, object> Send(Dictionary<string, object> body, bool ending) {
            if (!ending && stop.WaitOne(0)) throw new OperationCanceledException();
            var req = (HttpWebRequest)WebRequest.Create(Wire.Text(config, "origin") + "/agent?sid=" + Wire.Text(config, "sid"));
            req.Method = "POST"; req.ContentType = "application/json"; req.AllowAutoRedirect = false;
            req.Timeout = ending ? 3000 : 30000; req.ReadWriteTimeout = req.Timeout;
            req.Headers["X-Attach-Key"] = Wire.Text(config, "key");
            req.Proxy = WebRequest.DefaultWebProxy;
            byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(body)); req.ContentLength = bytes.Length;
            lock (gate) { if (!ending && stop.WaitOne(0)) throw new OperationCanceledException(); request = req; }
            try {
                using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                using (var response = (HttpWebResponse)req.GetResponse()) {
                    if (response.StatusCode != HttpStatusCode.OK) throw new InvalidDataException("Unexpected support server response.");
                    using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                        char[] buf = new char[8192]; var data = new StringBuilder(); int n;
                        while ((n = reader.Read(buf, 0, buf.Length)) > 0) {
                            if (data.Length + n > 750000) throw new InvalidDataException("Support response too large.");
                            data.Append(buf, 0, n);
                        }
                        return Wire.Json().Deserialize<Dictionary<string, object>>(data.ToString());
                    }
                }
            } catch (WebException e) {
                var r = e.Response as HttpWebResponse;
                if (r != null) {
                    int code = (int)r.StatusCode; r.Close();
                    if (code == 401 || code == 403 || code == 409 || code == 410) throw new OperationCanceledException("Support access has ended.");
                }
                throw;
            } finally { lock (gate) { if (request == req) request = null; } }
        }
        static string AbsolutePath(string path) {
            // Only normal local absolute paths. Refuse relative, device, UNC,
            // and alternate-stream paths; do not turn a file op into a share login.
            if (!System.Text.RegularExpressions.Regex.IsMatch(path, @"^[A-Za-z]:[\\/]") || path.IndexOf(':', 2) >= 0)
                throw new ArgumentException("A local absolute file path is required.");
            return Path.GetFullPath(path);
        }
        Dictionary<string, object> Execute(Dictionary<string, object> frame) {
            try {
                if (stop.WaitOne(0)) throw new OperationCanceledException();
                string type = Wire.Text(frame, "type");
                if (type == "run") {
                    string file = Path.Combine(work, "command.ps1");
                    string prefix = "$ProgressPreference = 'SilentlyContinue'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n";
                    File.WriteAllText(file, prefix + Wire.Text(frame, "command"), new UTF8Encoding(true));
                    using (var job = new CommandJob()) return job.Run(file, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), (int)Math.Max(1, Math.Min(600, Wire.Number(frame, "timeout_s"))), stop);
                }
                string path = AbsolutePath(Wire.Text(frame, "path"));
                if (type == "put_file") {
                    string encoded = Wire.Text(frame, "data_b64");
                    if (encoded.Length > 700000) throw new ArgumentException("File chunk too large.");
                    byte[] data = Convert.FromBase64String(encoded);
                    using (var s = new FileStream(path, Wire.Flag(frame, "append") ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None)) s.Write(data, 0, data.Length);
                    return Wire.Map("ok", true, "bytes", data.Length);
                }
                if (type != "get_file") throw new ArgumentException("Unknown operation.");
                long offset = Math.Max(0, Wire.Number(frame, "offset"));
                int length = (int)Math.Max(1, Math.Min(524288, Wire.Number(frame, "length")));
                using (var s = File.OpenRead(path)) {
                    s.Position = offset; byte[] data = new byte[length]; int total = 0, n;
                    while (total < length && (n = s.Read(data, total, length - total)) > 0) total += n;
                    return Wire.Map("ok", true, "data_b64", Convert.ToBase64String(data, 0, total), "size", s.Length, "eof", s.Position >= s.Length);
                }
            } catch (Exception e) { return Wire.Map("ok", false, "error", e.Message); }
        }
        public void Run() {
            Thread operation = null; Dictionary<string, object> result = null, operationResult = null; string activeId = "", lastId = "", networkError = "";
            var done = new ManualResetEvent(false);
            try {
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                work = Path.Combine(Path.GetTempPath(), "remote-support-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(work, security);
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                while (!stop.WaitOne(0)) {
                    try {
                        if (generation == 0) {
                            var welcome = Send(Wire.Map("type", "hello", "machine", Environment.MachineName, "user", Environment.UserName,
                                "ps", PowerShellVersion(), "agent", "windows-app-1", "elevated", SupportAccess.IsAdministrator()), false);
                            if (Wire.Text(welcome, "type") != "welcome") throw new InvalidDataException("Invalid support handshake.");
                            generation = Wire.Number(welcome, "generation");
                            long expires = Wire.Number(welcome, "expires_at"), now = Wire.Number(welcome, "server_time");
                            if (now == 0) now = UnixNow();
                            long remainingMs = Math.Max(0, Math.Min(86400000, expires - now));
                            Interlocked.Exchange(ref deadlineMs, clock.ElapsedMilliseconds + remainingMs);
                            Interlocked.Exchange(ref expiresAtMs, UnixNow() + remainingMs);
                            ShowStatus("Support session active. Close this window to end access.");
                            Print("Connected. Commands run as " + Environment.UserName + (SupportAccess.IsAdministrator() ? " with administrator rights." : " with normal user rights."));
                            var connected = Connected; if (connected != null) connected();
                        }
                        if (operation != null && done.WaitOne(0)) {
                            operation.Join(); operation = null; result = operationResult;
                            result["type"] = "result"; result["id"] = activeId; result["generation"] = generation;
                        }
                        if (result != null) {
                            var ack = Send(result, false);
                            if (Wire.Text(ack, "type") == "end") break;
                            if (Wire.Text(ack, "type") != "ack") throw new InvalidDataException("Result not acknowledged.");
                            lastId = activeId; activeId = ""; result = null; Work(-1);
                        }
                        if (operation != null) {
                            // The relay answers a busy poll at once, so do not spin on it. Wait for
                            // the operation and poll busy every 2 s. That keeps the client marked alive
                            // and notices an operator end or expiry within about 2 s.
                            if (WaitHandle.WaitAny(new WaitHandle[] { done, stop }, 2000) == 0) continue;
                            if (stop.WaitOne(0)) break;
                        }
                        var frame = Send(Wire.Map("type", "poll", "generation", generation, "busy", operation != null), false);
                        if (networkError != "") { networkError = ""; ShowStatus("Support session active. Close this window to end access."); Print("Connection restored."); Link(true); }
                        string type = Wire.Text(frame, "type"), id = Wire.Text(frame, "id");
                        if (type == "end") break;
                        if (type == "idle") continue;
                        if (operation != null || id == lastId) { stop.WaitOne(1000); continue; }
                        if (id == "" || (type != "run" && type != "put_file" && type != "get_file")) throw new InvalidDataException("Invalid support operation.");
                        Print(type == "run" ? "$ " + Wire.Text(frame, "command") : type + " " + Wire.Text(frame, "path"));
                        activeId = id; done.Reset(); Work(1);
                        var command = frame;
                        operation = new Thread(delegate() { operationResult = Execute(command); done.Set(); });
                        operation.IsBackground = true; operation.Start();
                        stop.WaitOne(100);
                    } catch (OperationCanceledException) { break; }
                    catch (WebException e) {
                        if (networkError != e.Message) { networkError = e.Message; Print("Connection error: " + e.Message); }
                        ShowStatus("Connection interrupted. Retrying; close the window to end access."); Link(false); stop.WaitOne(3000);
                    }
                }
            } catch (Exception e) { LastError = e.Message; Print("Stopped: " + e.Message); }
            finally {
                Stop();
                if (operation != null) operation.Join(15000);
                if (EndRemote && generation != 0) { try { Send(Wire.Map("type", "end", "generation", generation), true); } catch { } }
                if (work != null) { try { Directory.Delete(work, true); } catch { } }
                Print(EndRemote ? "Support access stopped." : "Windows is restarting. One-time reconnect is prepared.");
                ShowStatus("Support session ended. You can close this window.");
                if (Interlocked.Exchange(ref busy, 0) > 0) { var changed = BusyChanged; if (changed != null) changed(0); }
                var finished = Finished; if (finished != null) finished();
                done.Close();
            }
        }
        public void Dispose() { Stop(); deadlineTimer.Dispose(); /* callbacks may still hold stop */ }
    }

    public static class RestartResume {
        const string RunOnce = @"Software\Microsoft\Windows\CurrentVersion\RunOnce";
        const string ConsentKey = @"Software\SupportMcp\ReconnectConsent";
        public static string Folder(Dictionary<string, object> cfg) {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SupportMcp", Wire.Text(cfg, "sid").Substring(0, 8));
        }
        public static string PathFor(Dictionary<string, object> cfg) { return Path.Combine(Folder(cfg), "agent.exe"); }
        public static string ValueName(Dictionary<string, object> cfg) { return "SupportMcp-" + Wire.Text(cfg, "sid").Substring(0, 8); }
        public static bool Scoped(Dictionary<string, object> cfg, string executable) {
            return Wire.Flag(cfg, "restart_resume") && String.Equals(Path.GetFullPath(executable), Path.GetFullPath(PathFor(cfg)), StringComparison.OrdinalIgnoreCase);
        }
        public static bool Valid(Dictionary<string, object> cfg, string executable) {
            long remaining = Wire.Number(cfg, "resume_expires_at") - Client.UnixNow();
            return Scoped(cfg, executable) && remaining > 0 && remaining <= 86400000;
        }
        static string ConsentValue(Dictionary<string, object> cfg) {
            using (var identity = WindowsIdentity.GetCurrent())
                return identity.User.Value + "|" + Wire.Number(cfg, "resume_expires_at").ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        public static bool HasAdministratorConsent(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey))
                return key != null && String.Equals(key.GetValue(Wire.Text(cfg, "sid")) as string, ConsentValue(cfg), StringComparison.Ordinal);
        }
        public static void Arm(Dictionary<string, object> cfg) { Arm(cfg, false); }
        public static void Arm(Dictionary<string, object> cfg, bool administrator) {
            // Written only after the visible preparation prompt approves one
            // reconnect with these rights. Bind it to this user and deadline.
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(ConsentKey)) {
                if (administrator) key.SetValue(Wire.Text(cfg, "sid"), ConsentValue(cfg), Microsoft.Win32.RegistryValueKind.String);
                else key.DeleteValue(Wire.Text(cfg, "sid"), false);
            }
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunOnce))
                key.SetValue(ValueName(cfg), "\"" + PathFor(cfg) + "\" --resume", Microsoft.Win32.RegistryValueKind.String);
        }
        public static void Disarm(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunOnce, true))
                if (key != null) key.DeleteValue(ValueName(cfg), false);
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey, true))
                if (key != null) key.DeleteValue(Wire.Text(cfg, "sid"), false);
        }
        public static void Cleanup(Dictionary<string, object> cfg) {
            Disarm(cfg);
            // Delete only the scoped support executable after it exits. Keep
            // this helper outside command Jobs; it performs no privileged work.
            string file = PathFor(cfg).Replace("'", "''"), folder = Folder(cfg).Replace("'", "''");
            string script = "$ErrorActionPreference='SilentlyContinue'; for($i=0;$i -lt 20;$i++){ Start-Sleep -Seconds 1; Remove-Item -LiteralPath '" + file + "' -Force; if(-not(Test-Path -LiteralPath '" + file + "')){ if(@(Get-ChildItem -LiteralPath '" + folder + "' -Force).Count -eq 0){ Remove-Item -LiteralPath '" + folder + "' -Force }; break } }";
            Process.Start(new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)),
                UseShellExecute = false, CreateNoWindow = true
            });
        }
    }

    // Colors for the customer windows. Light is the default; dark follows the
    // Windows "apps" theme when that registry value exists (not on Windows 7).
    public sealed class Palette {
        public readonly bool Dark;
        public readonly Brush Surface, Surface2, Ink, Muted, Line, Live, LiveSoft, LiveSoftHover, Work, WorkSoft, Stop, StopBg, StopBgHover, StopSolid, StopSolidHover;
        public readonly Color WorkColor, ShadowColor;
        public readonly double ShadowOpacity;
        public static Brush Solid(string hex, byte alpha) {
            Color c = (Color)ColorConverter.ConvertFromString(hex);
            var brush = new SolidColorBrush(Color.FromArgb(alpha, c.R, c.G, c.B)); brush.Freeze(); return brush;
        }
        public Palette(bool dark) {
            Dark = dark;
            if (dark) {
                Surface = Solid("#202227", 255); Surface2 = Solid("#2A2D33", 255); Ink = Solid("#F2F4F7", 255); Muted = Solid("#A3AAB6", 255); Line = Solid("#373B43", 255);
                Live = Solid("#3DD68C", 255); LiveSoft = Solid("#3DD68C", 46); LiveSoftHover = Solid("#3DD68C", 70);
                Work = Solid("#6EA0FF", 255); WorkSoft = Solid("#6EA0FF", 56); WorkColor = Color.FromRgb(0x6E, 0xA0, 0xFF);
                Stop = Solid("#FF8A80", 255); StopBg = Solid("#3A2224", 255); StopBgHover = Solid("#46292B", 255);
                StopSolid = Solid("#D9443B", 255); StopSolidHover = Solid("#C23B33", 255);
                ShadowColor = Colors.Black; ShadowOpacity = 0.45;
            } else {
                Surface = Solid("#FFFFFF", 255); Surface2 = Solid("#F5F6F8", 255); Ink = Solid("#141A24", 255); Muted = Solid("#5B6472", 255); Line = Solid("#E4E7EC", 255);
                Live = Solid("#1F9D55", 255); LiveSoft = Solid("#1F9D55", 41); LiveSoftHover = Solid("#1F9D55", 64);
                Work = Solid("#2563EB", 255); WorkSoft = Solid("#2563EB", 46); WorkColor = Color.FromRgb(0x25, 0x63, 0xEB);
                Stop = Solid("#B42318", 255); StopBg = Solid("#FDEDEC", 255); StopBgHover = Solid("#F9E0DE", 255);
                StopSolid = Solid("#C4302B", 255); StopSolidHover = Solid("#AC2823", 255);
                ShadowColor = Color.FromRgb(0x10, 0x18, 0x28); ShadowOpacity = 0.22;
            }
        }
        public static Palette Detect() {
            bool dark = false;
            try {
                object value = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", null);
                dark = value is int && (int)value == 0;
            } catch (Exception) { }
            return new Palette(dark);
        }
    }

    // Small builders shared by both windows.
    public static class Ui {
        public const string TextFont = "Segoe UI Variable Text, Segoe UI";
        public const string DisplayFont = "Segoe UI Variable Display, Segoe UI";
        public const string MonoFont = "Cascadia Mono, Consolas";
        public static TextBlock Label(string text, double size, FontWeight weight, Brush color, string font) {
            return new TextBlock { Text = text, FontSize = size, FontWeight = weight, Foreground = color, FontFamily = new FontFamily(font), TextWrapping = TextWrapping.Wrap };
        }
        public static string Clock(TimeSpan span) {
            long s = (long)span.TotalSeconds;
            return String.Format(System.Globalization.CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}", s / 3600, (s / 60) % 60, s % 60);
        }
        // The card: rounded, bordered, with a soft shadow. Content goes into
        // `inner`, which is clipped to the rounded corners.
        public static Border Card(Palette p, double width, out Grid inner) {
            var grid = new Grid();
            var card = new Border {
                Background = p.Surface, BorderBrush = p.Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8),
                HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Child = grid,
                Effect = new DropShadowEffect { BlurRadius = 24, ShadowDepth = 6, Direction = 270, Color = p.ShadowColor, Opacity = p.ShadowOpacity }
            };
            if (width > 0) card.Width = width;
            grid.SizeChanged += delegate { grid.Clip = new RectangleGeometry(new Rect(0, 0, grid.ActualWidth, grid.ActualHeight), 7, 7); };
            inner = grid; return card;
        }
        public static void Drag(Window window, UIElement handle) { Drag(window, handle, null); }
        public static void Drag(Window window, UIElement handle, Action moved) {
            handle.MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
                if (e.ButtonState != MouseButtonState.Pressed) return;
                double left = window.Left, top = window.Top;
                try { window.DragMove(); } catch (InvalidOperationException) { return; }
                if (moved != null && (window.Left != left || window.Top != top)) moved();
            };
        }
        public static void Transparent(Window w) {
            w.WindowStyle = WindowStyle.None; w.AllowsTransparency = true; w.Background = Brushes.Transparent; w.ResizeMode = ResizeMode.NoResize;
            w.Topmost = true; w.ShowInTaskbar = true; w.Title = "Remote support"; w.UseLayoutRounding = true; w.SnapsToDevicePixels = true;
            w.FontFamily = new FontFamily(TextFont); w.FontSize = 13;
        }
    }

    // A small vector icon: stroked and filled paths painted with one brush.
    public sealed class Glyph {
        public readonly Canvas Root;
        readonly List<Shapes.Path> strokes = new List<Shapes.Path>(), fills = new List<Shapes.Path>();
        public Glyph(double size) { Root = new Canvas { Width = size, Height = size }; }
        public Glyph Line(string data, double thickness) {
            var path = new Shapes.Path { Data = Geometry.Parse(data), StrokeThickness = thickness, StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round };
            strokes.Add(path); Root.Children.Add(path); return this;
        }
        public Glyph Fill(Geometry geometry) {
            var path = new Shapes.Path { Data = geometry };
            fills.Add(path); Root.Children.Add(path); return this;
        }
        public Glyph Paint(Brush brush) {
            foreach (var path in strokes) path.Stroke = brush;
            foreach (var path in fills) path.Fill = brush;
            return this;
        }
        public FrameworkElement Sized(double size) { return new Viewbox { Width = size, Height = size, Stretch = Stretch.Uniform, Child = Root }; }
        public static Glyph Screen() {
            return new Glyph(16).Line("M 3,2.5 L 13,2.5 A 1.5,1.5 0 0 1 14.5,4 L 14.5,10 A 1.5,1.5 0 0 1 13,11.5 L 3,11.5 A 1.5,1.5 0 0 1 1.5,10 L 1.5,4 A 1.5,1.5 0 0 1 3,2.5 Z", 1.3)
                .Line("M 5.5,14 L 10.5,14 M 8,11.5 L 8,14", 1.3);
        }
        public static Glyph Headset() {
            return new Glyph(20).Line("M 3.5,11 L 3.5,9.5 A 6.5,6.5 0 0 1 16.5,9.5 L 16.5,11", 1.6)
                .Fill(new RectangleGeometry(new Rect(2.5, 10.5, 3.5, 5), 1.4, 1.4)).Fill(new RectangleGeometry(new Rect(14, 10.5, 3.5, 5), 1.4, 1.4))
                .Line("M 15.8,15.5 C 15.8,16.9 14.4,17.7 12,17.7", 1.4);
        }
        public static Glyph Warning() {
            return new Glyph(20).Line("M 10,3 L 18,16.5 L 2,16.5 Z", 1.6).Line("M 10,8 L 10,12 M 10,14.2 L 10,14.3", 1.6);
        }
        public static Glyph Chevron(bool down) {
            return new Glyph(14).Line(down ? "M 3.5,5.5 L 7,9 L 10.5,5.5" : "M 3.5,8.5 L 7,5 L 10.5,8.5", 1.4);
        }
    }

    // Flat rounded button with a hover color and a keyboard focus ring.
    public sealed class FlatButton : Button {
        readonly Brush rest, hover;
        public FlatButton(object content, Brush foreground, Brush rest, Brush hover, Brush focusRing, double height, double minWidth, double padding, double radius, double fontSize) {
            this.rest = rest; this.hover = hover;
            Content = content; Foreground = foreground; Background = rest; Height = height; MinWidth = minWidth;
            Padding = new Thickness(padding, 0, padding, 0); FontSize = fontSize; FontWeight = FontWeights.SemiBold;
            Cursor = Cursors.Hand; Focusable = true; FocusVisualStyle = null; BorderThickness = new Thickness(0);
            var border = new FrameworkElementFactory(typeof(Border), "bd");
            border.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(radius));
            border.SetValue(Border.BorderThicknessProperty, new Thickness(2));
            border.SetValue(Border.BorderBrushProperty, Brushes.Transparent);
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetValue(FrameworkElement.MarginProperty, new TemplateBindingExtension(Control.PaddingProperty));
            border.AppendChild(presenter);
            var template = new ControlTemplate(typeof(Button)) { VisualTree = border };
            var focused = new Trigger { Property = UIElement.IsKeyboardFocusedProperty, Value = true };
            focused.Setters.Add(new Setter(Border.BorderBrushProperty, focusRing, "bd"));
            template.Triggers.Add(focused);
            Template = template;
            IsVisibleChanged += delegate { Background = IsMouseOver ? hover : rest; };
        }
        protected override void OnMouseEnter(MouseEventArgs e) { base.OnMouseEnter(e); Background = hover; }
        protected override void OnMouseLeave(MouseEventArgs e) { base.OnMouseLeave(e); Background = rest; }
    }

    // The window the customer sees while support is connected.
    public sealed class SupportWindow : Window {
        const double CardWidth = 336, Gap = 12, Pad = 20;
        readonly Client client;
        readonly Palette p;
        readonly bool preparing;
        public volatile bool Preserve;
        bool connectedOnce, linkOk = true, busy, workShown, ended, tucked, confirming, sessionEnding, sweeping, userMoved, placing;
        readonly Stopwatch session = new Stopwatch(), workClock = new Stopwatch();
        TimeSpan endedAfter;
        double userLeft, userCardBottom;
        readonly DispatcherTimer tick = new DispatcherTimer(), hold = new DispatcherTimer(), closer = new DispatcherTimer();
        readonly Grid root;
        readonly Border card, tile, tuckTile, edge;
        readonly Glyph tileGlyph, tuckGlyph;
        readonly System.Windows.Shapes.Rectangle sweep;
        readonly TranslateTransform sweepMove = new TranslateTransform();
        readonly TextBlock head, status, until, tuckTitle, tuckTimer, askTitle, askText;
        readonly StackPanel fullView, tuckView, askFoot;
        readonly Border askBox, normalFoot;
        readonly FlatButton collapse, endButton, tuckEnd, expand, keep, sure;
        Run timerRun;

        public SupportWindow(Client client, Palette palette, bool administrator, bool preparing, string note) {
            this.client = client; this.p = palette; this.preparing = preparing;
            Ui.Transparent(this);
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.Manual;
            Foreground = p.Ink;

            Grid inner; card = Ui.Card(p, CardWidth, out inner);
            root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);

            // 3 px edge: green when connected, blue sweep while working.
            edge = new Border { Height = 3 };
            var edgeHost = new Grid { Height = 3, ClipToBounds = true };
            edgeHost.Children.Add(edge);
            Color clear = Color.FromArgb(0, p.WorkColor.R, p.WorkColor.G, p.WorkColor.B);
            var sweepBrush = new LinearGradientBrush(clear, clear, 0);
            sweepBrush.GradientStops.Clear();
            sweepBrush.GradientStops.Add(new GradientStop(clear, 0)); sweepBrush.GradientStops.Add(new GradientStop(p.WorkColor, 0.5)); sweepBrush.GradientStops.Add(new GradientStop(clear, 1));
            sweep = new System.Windows.Shapes.Rectangle { Width = CardWidth * 0.45, Height = 3, Fill = sweepBrush, HorizontalAlignment = HorizontalAlignment.Left, RenderTransform = sweepMove, Visibility = Visibility.Collapsed };
            edgeHost.Children.Add(sweep);
            stack.Children.Add(edgeHost);

            // Full view: header, body, footer.
            fullView = new StackPanel(); stack.Children.Add(fullView);
            var header = new Grid { Height = 36, Margin = new Thickness(14, 0, 6, 0), Background = Brushes.Transparent };
            var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var screen = Glyph.Screen().Paint(p.Muted).Sized(16); screen.Margin = new Thickness(0, 0, 8, 0);
            title.Children.Add(screen);
            var titleText = Ui.Label("Remote support", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont); titleText.VerticalAlignment = VerticalAlignment.Center;
            title.Children.Add(titleText);
            header.Children.Add(title);
            collapse = IconButton(Glyph.Chevron(true), "Tuck into the corner"); collapse.HorizontalAlignment = HorizontalAlignment.Right;
            header.Children.Add(collapse);
            Ui.Drag(this, header, OnDragged);
            fullView.Children.Add(header);

            var body = new Grid { Margin = new Thickness(16, 2, 16, 14) };
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(40) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            tileGlyph = Glyph.Headset();
            tile = new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(10), VerticalAlignment = VerticalAlignment.Top, Child = tileGlyph.Sized(20) };
            body.Children.Add(tile);
            var text = new StackPanel { Margin = new Thickness(12, 0, 0, 0) };
            Grid.SetColumn(text, 1);
            head = Ui.Label("", 15.5, FontWeights.SemiBold, p.Ink, Ui.DisplayFont); head.LineHeight = 21; head.Margin = new Thickness(0, 0, 0, 5);
            status = Ui.Label("", 12.5, FontWeights.Normal, p.Muted, Ui.TextFont);
            text.Children.Add(head); text.Children.Add(status);
            if (administrator) {
                var admin = Ui.Label("Running with administrator rights.", 12.5, FontWeights.Normal, p.Stop, Ui.TextFont); admin.Margin = new Thickness(0, 6, 0, 0);
                text.Children.Add(admin);
            }
            if (!String.IsNullOrEmpty(note)) {
                var line = Ui.Label(note, 12, FontWeights.Normal, p.Muted, Ui.TextFont); line.Margin = new Thickness(0, 6, 0, 0);
                text.Children.Add(line);
            }
            body.Children.Add(text);
            fullView.Children.Add(body);

            // Normal footer.
            normalFoot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(8, 10, 12, 12) };
            var footGrid = new Grid();
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            until = Ui.Label("", 12, FontWeights.Normal, p.Muted, Ui.TextFont);
            until.Margin = new Thickness(4, 0, 8, 0); until.VerticalAlignment = VerticalAlignment.Center; until.TextWrapping = TextWrapping.NoWrap; until.TextTrimming = TextTrimming.CharacterEllipsis;
            footGrid.Children.Add(until);
            endButton = new FlatButton("End session", p.Stop, p.StopBg, p.StopBgHover, p.Work, 32, 0, 12, 6, 13);
            Grid.SetColumn(endButton, 1); footGrid.Children.Add(endButton);
            normalFoot.Child = footGrid;
            fullView.Children.Add(normalFoot);

            // Inline end confirmation.
            askBox = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(16, 12, 16, 0), Visibility = Visibility.Collapsed };
            var ask = new StackPanel();
            askTitle = Ui.Label("End the session?", 13, FontWeights.SemiBold, p.Ink, Ui.TextFont); askTitle.Margin = new Thickness(0, 0, 0, 2);
            askText = Ui.Label("Support loses access to this PC right away.", 12.5, FontWeights.Normal, p.Muted, Ui.TextFont);
            ask.Children.Add(askTitle); ask.Children.Add(askText); askBox.Child = ask;
            fullView.Children.Add(askBox);
            askFoot = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(8, 10, 12, 12), Visibility = Visibility.Collapsed };
            keep = new FlatButton("Keep connected", p.Ink, Brushes.Transparent, p.Surface2, p.Work, 32, 0, 12, 6, 13);
            sure = new FlatButton("End session", Brushes.White, p.StopSolid, p.StopSolidHover, p.Work, 32, 0, 14, 6, 13); sure.Margin = new Thickness(8, 0, 0, 0);
            askFoot.Children.Add(keep); askFoot.Children.Add(sure);
            fullView.Children.Add(askFoot);

            // Tucked bar.
            tuckGlyph = Glyph.Headset();
            tuckTile = new Border { Width = 26, Height = 26, CornerRadius = new CornerRadius(7), Child = tuckGlyph.Sized(14), VerticalAlignment = VerticalAlignment.Center };
            tuckView = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(8, 6, 6, 6), Background = Brushes.Transparent, Visibility = Visibility.Collapsed };
            tuckTitle = Ui.Label("Remote support", 12.5, FontWeights.SemiBold, p.Ink, Ui.TextFont); tuckTitle.Margin = new Thickness(8, 0, 0, 0); tuckTitle.VerticalAlignment = VerticalAlignment.Center; tuckTitle.TextWrapping = TextWrapping.NoWrap;
            tuckTimer = Ui.Label("", 12, FontWeights.Normal, p.Muted, Ui.MonoFont); tuckTimer.Margin = new Thickness(8, 0, 0, 0); tuckTimer.VerticalAlignment = VerticalAlignment.Center; tuckTimer.TextWrapping = TextWrapping.NoWrap;
            expand = IconButton(Glyph.Chevron(false), "Show the support window"); expand.Margin = new Thickness(4, 0, 0, 0);
            tuckEnd = new FlatButton("End", p.Stop, p.StopBg, p.StopBgHover, p.Work, 28, 0, 10, 6, 12.5); tuckEnd.Margin = new Thickness(2, 0, 0, 0);
            tuckView.Children.Add(tuckTile); tuckView.Children.Add(tuckTitle); tuckView.Children.Add(tuckTimer); tuckView.Children.Add(expand); tuckView.Children.Add(tuckEnd);
            Ui.Drag(this, tuckView, OnDragged);
            stack.Children.Add(tuckView);

            collapse.Click += delegate { tucked = true; confirming = false; Render(); };
            expand.Click += delegate { tucked = false; Render(); };
            endButton.Click += delegate { AskToEnd(); };
            tuckEnd.Click += delegate { AskToEnd(); };
            keep.Click += delegate { confirming = false; Render(); };
            sure.Click += delegate { client.Stop(); ShowEnded(); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape && confirming) { confirming = false; Render(); e.Handled = true; } };

            tick.Interval = TimeSpan.FromSeconds(1); tick.Tick += delegate { UpdateTimer(); };
            hold.Tick += delegate { hold.Stop(); if (!busy) workShown = false; Render(); };
            closer.Interval = TimeSpan.FromSeconds(4); closer.Tick += delegate { closer.Stop(); Close(); };

            // Placement is computed from the laid-out card (see Place), never from
            // an estimate. This rough first position only avoids a visible jump.
            Rect area = SystemParameters.WorkArea;
            Left = area.Right - Gap + Pad - Width;
            Top = area.Bottom - Gap - Pad - 300;
            Render();
            card.SizeChanged += delegate { Place(); Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(Place)); };
            ContentRendered += delegate { Place(); };
            PropertyChangedEventHandler workAreaChanged = delegate(object sender, PropertyChangedEventArgs e) { if (e.PropertyName == "WorkArea") Place(); };
            SystemParameters.StaticPropertyChanged += workAreaChanged;
            Closed += delegate { SystemParameters.StaticPropertyChanged -= workAreaChanged; };

            Closing += OnClosing;
            if (Application.Current != null)
                Application.Current.SessionEnding += delegate(object sender, SessionEndingCancelEventArgs e) { sessionEnding = true; };

            // Client threads post to the UI thread only; nothing here shows commands or paths.
            client.Connected += delegate { Post(OnConnected); };
            client.LinkChanged += delegate(bool up) { Post(delegate { OnLink(up); }); };
            client.BusyChanged += delegate(int count) { Post(delegate { OnBusy(count > 0); }); };
            client.Finished += delegate { Post(ShowEnded); };
        }

        // The visible card's right and bottom edges sit Gap pixels inside the work
        // area; the window is the card plus a transparent shadow margin of Pad.
        // After the customer drags the window, their spot is kept (bottom edge
        // fixed while the height changes) and only clamped onto the work area.
        void Place() {
            if (placing || card.ActualHeight <= 0) return;
            placing = true;
            try {
                Rect area = SystemParameters.WorkArea;
                double cardHeight = card.ActualHeight;
                double left = userMoved ? userLeft : area.Right - Gap + Pad - Width;
                double cardBottom = userMoved ? userCardBottom : area.Bottom - Gap;
                double top = cardBottom - cardHeight - Pad;
                if (userMoved) {
                    left = Math.Min(left, area.Right - Width + Pad); left = Math.Max(left, area.Left - Pad);
                    top = Math.Min(top, area.Bottom - cardHeight - Pad); top = Math.Max(top, area.Top - Pad);
                    userLeft = left; userCardBottom = top + Pad + cardHeight;
                }
                if (Math.Abs(Left - left) > 0.01) Left = left;
                if (Math.Abs(Top - top) > 0.01) Top = top;
            } finally { placing = false; }
        }
        void OnDragged() {
            userMoved = true; userLeft = Left; userCardBottom = Top + Pad + card.ActualHeight; Place();
        }

        FlatButton IconButton(Glyph glyph, string tip) {
            var button = new FlatButton(glyph.Paint(p.Muted).Sized(14), p.Muted, Brushes.Transparent, p.Surface2, p.Work, 28, 28, 0, 6, 12);
            button.Width = 28; button.ToolTip = tip; return button;
        }
        void Post(Action action) { Dispatcher.BeginInvoke(DispatcherPriority.Normal, action); }

        void OnConnected() {
            if (connectedOnce || ended) return;
            connectedOnce = true; linkOk = true; session.Start(); tick.Start(); Render();
        }
        void OnLink(bool up) { if (ended || linkOk == up) return; linkOk = up; Render(); }
        void OnBusy(bool now) {
            if (ended) return;
            busy = now;
            if (now) {
                hold.Stop();
                if (!workShown) { workShown = true; workClock.Reset(); workClock.Start(); }
            } else if (workShown) {
                long left = 1000 - workClock.ElapsedMilliseconds;
                if (left <= 0) workShown = false;
                else { hold.Interval = TimeSpan.FromMilliseconds(left); hold.Start(); }
            }
            Render();
        }

        void AskToEnd() {
            if (ended) return;
            tucked = false; confirming = true; Render();
            UpdateLayout(); Activate(); keep.Focus();
        }
        void ShowEnded() {
            if (ended) return;
            ended = true; endedAfter = session.Elapsed; session.Stop(); tick.Stop(); hold.Stop();
            confirming = false; tucked = false; workShown = false; busy = false;
            Render(); closer.Start();
        }
        void OnClosing(object sender, System.ComponentModel.CancelEventArgs e) {
            // User close (End session, Alt+F4, taskbar Close) asks inline first.
            // Windows shutdown and an already ended session close without asking.
            if (!ended && !sessionEnding) { e.Cancel = true; AskToEnd(); return; }
            if (preparing && !ended && sessionEnding) { Preserve = true; client.EndRemote = false; }
            client.Stop();
        }

        void UpdateTimer() {
            string time = Ui.Clock(session.Elapsed);
            if (timerRun != null) timerRun.Text = time;
            tuckTimer.Text = connectedOnce ? time : "";
        }
        void SetSweeping(bool on) {
            if (on == sweeping) return;
            sweeping = on;
            if (on) {
                sweep.Visibility = Visibility.Visible;
                var move = new DoubleAnimation(-CardWidth * 0.45, CardWidth, new Duration(TimeSpan.FromSeconds(1.15))) { RepeatBehavior = RepeatBehavior.Forever };
                sweepMove.BeginAnimation(TranslateTransform.XProperty, move);
            } else {
                sweepMove.BeginAnimation(TranslateTransform.XProperty, null);
                sweep.Visibility = Visibility.Collapsed;
            }
        }

        void Render() {
            bool live = connectedOnce && linkOk && !ended;
            bool working = live && workShown;
            bool animate = working && SystemParameters.ClientAreaAnimation;
            Brush tileBack = !live ? p.Surface2 : working ? p.WorkSoft : p.LiveSoft;
            Brush tileFore = !live ? p.Muted : working ? p.Work : p.Live;
            tile.Background = tileBack; tuckTile.Background = tileBack;
            tileGlyph.Paint(tileFore); tuckGlyph.Paint(tileFore);
            edge.Background = !live ? p.Line : working ? (animate ? p.WorkSoft : p.Work) : p.Live;
            SetSweeping(animate);

            head.Text = ended ? "Support is disconnected." : !connectedOnce ? "Connecting to support..." : !linkOk ? "Reconnecting to support..." : "A remote support agent is connected to your machine.";
            status.Inlines.Clear(); timerRun = null;
            if (ended) {
                status.Inlines.Add(new Run("Session ended after " + Ui.Clock(endedAfter) + ". Support can no longer reach this PC."));
            } else if (!connectedOnce) {
                status.Inlines.Add(new Run("This window stays open while support is connected."));
            } else if (working) {
                status.Inlines.Add(new Run("Support is working on your PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else {
                status.Inlines.Add(new Run(linkOk ? "Connected for " : "Trying again. Session time "));
                timerRun = new Run(Ui.Clock(session.Elapsed)) { Foreground = p.Ink, FontFamily = new FontFamily(Ui.MonoFont), FontSize = 12 };
                status.Inlines.Add(timerRun);
            }
            DateTime expires = client.ExpiresLocal;
            until.Text = connectedOnce && expires != DateTime.MinValue ? "Ends by itself " + expires.ToString("ddd d MMM, HH:mm", System.Globalization.CultureInfo.InvariantCulture) : "";
            tuckTitle.Text = working ? "Support is working" : "Remote support";
            tuckTimer.Text = connectedOnce ? Ui.Clock(session.Elapsed) : "";

            bool small = tucked && !ended;
            card.Width = small ? Double.NaN : CardWidth;
            fullView.Visibility = small ? Visibility.Collapsed : Visibility.Visible;
            tuckView.Visibility = small ? Visibility.Visible : Visibility.Collapsed;
            collapse.Visibility = ended ? Visibility.Hidden : Visibility.Visible;
            normalFoot.Visibility = !ended && !confirming ? Visibility.Visible : Visibility.Collapsed;
            askBox.Visibility = askFoot.Visibility = !ended && confirming ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // Consent prompt in the same visual language. "Don't allow" is the default.
    public sealed class ConsentDialog : Window {
        bool allowed;
        public static bool Ask(string message, bool administrator) {
            var dialog = new ConsentDialog(Palette.Detect(), message, administrator);
            dialog.ShowDialog();
            return dialog.allowed;
        }
        ConsentDialog(Palette p, string message, bool administrator) {
            const double CardWidth = 440, Pad = 20;
            Ui.Transparent(this);
            Width = CardWidth + 2 * Pad; SizeToContent = SizeToContent.Height; WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Foreground = p.Ink;
            Grid inner; var card = Ui.Card(p, CardWidth, out inner);
            var root = new Grid { Margin = new Thickness(Pad) }; root.Children.Add(card); Content = root;
            var stack = new StackPanel(); inner.Children.Add(stack);
            Brush accent = administrator ? p.Stop : p.Work;
            stack.Children.Add(new Border { Height = 3, Background = administrator ? p.Stop : p.Work });

            var header = new Grid { Height = 36, Margin = new Thickness(14, 0, 6, 0), Background = Brushes.Transparent };
            var title = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            var screen = Glyph.Screen().Paint(p.Muted).Sized(16); screen.Margin = new Thickness(0, 0, 8, 0);
            title.Children.Add(screen);
            var titleText = Ui.Label("Remote support", 12, FontWeights.SemiBold, p.Muted, Ui.TextFont); titleText.VerticalAlignment = VerticalAlignment.Center;
            title.Children.Add(titleText);
            header.Children.Add(title); Ui.Drag(this, header);
            stack.Children.Add(header);

            var body = new Grid { Margin = new Thickness(16, 2, 16, 16) };
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(40) });
            body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var glyph = administrator ? Glyph.Warning() : Glyph.Headset();
            glyph.Paint(administrator ? p.Stop : p.Work);
            body.Children.Add(new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(10), VerticalAlignment = VerticalAlignment.Top,
                Background = administrator ? p.StopBg : p.WorkSoft, Child = glyph.Sized(20) });
            var text = new StackPanel { Margin = new Thickness(12, 0, 0, 0) }; Grid.SetColumn(text, 1);
            var heading = Ui.Label("Allow remote support?", 15.5, FontWeights.SemiBold, administrator ? p.Stop : p.Ink, Ui.DisplayFont); heading.LineHeight = 21; heading.Margin = new Thickness(0, 0, 0, 6);
            var copy = Ui.Label(message, 12.5, FontWeights.Normal, p.Ink, Ui.TextFont); copy.LineHeight = 18;
            text.Children.Add(heading); text.Children.Add(copy);
            body.Children.Add(text);
            stack.Children.Add(body);

            var foot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(8, 10, 12, 12) };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var deny = new FlatButton("Don't allow", p.Ink, p.Surface2, p.Line, p.Work, 32, 96, 14, 6, 13);
            var allow = administrator
                ? new FlatButton("Allow", p.Stop, p.StopBg, p.StopBgHover, p.Work, 32, 80, 14, 6, 13)
                : new FlatButton("Allow", p.Live, p.LiveSoft, p.LiveSoftHover, p.Work, 32, 80, 14, 6, 13);
            allow.Margin = new Thickness(8, 0, 0, 0);
            deny.IsDefault = true;
            buttons.Children.Add(deny); buttons.Children.Add(allow);
            foot.Child = buttons; stack.Children.Add(foot);

            deny.Click += delegate { allowed = false; Close(); };
            allow.Click += delegate { allowed = true; Close(); };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape) { e.Handled = true; allowed = false; Close(); } };
            Loaded += delegate { Activate(); deny.Focus(); Keyboard.Focus(deny); };
        }
    }

    public static class Program {
        [STAThread] public static void Main(string[] args) {
            WF.Application.EnableVisualStyles();
            try {
                var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                bool administrator = SupportAccess.IsAdministrator();
                string executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
                var config = Wire.ReadConfig(executable);
                bool requestedResume = args.Length == 1 && (args[0] == "--prepare-restart" || args[0] == "--resume");
                bool resume = requestedResume && RestartResume.Valid(config, executable);
                if (requestedResume && !resume) {
                    if (RestartResume.Scoped(config, executable)) RestartResume.Cleanup(config);
                    WF.MessageBox.Show("This restart support session has expired or is invalid.", "Remote support"); return;
                }
                bool preparing = resume && args[0] == "--prepare-restart";
                if (resume) { config["startup_expires_at"] = Wire.Number(config, "resume_expires_at"); config.Remove("startup_ms"); }
                bool first; using (var mutex = new Mutex(true, "Local\\SupportMcp" + (resume ? "Resume-" : "-") + Wire.Text(config, "sid"), out first)) {
                    if (!first) { WF.MessageBox.Show("This support session is already open.", "Remote support"); return; }
                    // Resume is pre-consented through the existing support
                    // session and restricted to its private path and deadline.
                    bool approvedAdministratorResume = resume && !preparing && administrator && RestartResume.HasAdministratorConsent(config);
                    if (!approvedAdministratorResume && !SupportAccess.Confirm(administrator, resume && !preparing, delegate(string message) {
                        if (preparing) message += "\n\nAlso allow ONE automatic reconnect at the next Windows sign-in with these same rights, without another prompt? It keeps this session's original expiry. End session cancels it.";
                        return ConsentDialog.Ask(message, administrator) ? WF.DialogResult.Yes : WF.DialogResult.No;
                    })) return;
                    if (preparing) RestartResume.Arm(config, administrator);
                    else if (resume) RestartResume.Disarm(config); // one restart only
                    SupportWindow window = null;
                    try {
                        using (var client = new Client(config)) {
                            string note = preparing ? "One automatic reconnect is enabled at the next sign-in. End session cancels it."
                                : resume ? "Reconnected after restart. No further automatic reconnect is installed." : null;
                            window = new SupportWindow(client, Palette.Detect(), administrator, preparing, note);
                            var win = window;
                            client.Finished += delegate { if (resume && !win.Preserve) RestartResume.Disarm(config); };
                            var thread = new Thread(client.Run); thread.IsBackground = true;
                            bool started = false;
                            win.Loaded += delegate { if (!started) { started = true; thread.Start(); } };
                            win.Closed += delegate { app.Shutdown(); };
                            app.Run(win);
                            client.Stop();
                            if (started) thread.Join(20000);
                        }
                    } finally { if (resume && !(window != null && window.Preserve)) RestartResume.Cleanup(config); }
                }
            } catch (Exception e) { WF.MessageBox.Show(e.Message, "Remote support"); }
        }
    }
}
