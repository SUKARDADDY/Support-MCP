// .NET Framework 4 client for Windows 7 to 11. One exe with several roles, chosen by the first argument:
// none (the customer's app), --elevate-install, --service, --helper and --window (full control, see FullInstall).
// Normal mode runs screen control (capture, input, UI Automation) in the user's own process; full control runs
// it in a SYSTEM helper on the user's console session, so it reaches the secure desktop too.
// The compiler names a helper class with a random GUID for a constant primitive
// array initializer of three or more elements and for a string switch with more than
// six cases, and that breaks the reproducible build. Use loops, if-else and
// non-constant arrays instead (docs/development.md).
// The customer window is WPF (part of .NET Framework 4); WinForms is used only
// for MessageBox and the DialogResult type of SupportAccess.Confirm.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Interop;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Microsoft.Win32.SafeHandles;
using Gdi = System.Drawing;
using Img = System.Drawing.Imaging;
using WF = System.Windows.Forms;
using Shapes = System.Windows.Shapes;

namespace SupportMcp {
    public static class SupportAccess {
        public static bool IsAdministrator() {
            using (var identity = WindowsIdentity.GetCurrent())
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        public static string ConsentMessage(bool administrator) { return ConsentMessage(administrator, true); }
        // screen = false is a reconnect whose earlier approval did not cover screen control: the prompt must say what will happen.
        public static string ConsentMessage(bool administrator, bool screen) {
            string what = screen ? "see your screen, control your mouse and keyboard, run commands and read or change files" : "run commands and read or change files";
            string rights = administrator
                ? "This client is running as Administrator. Allow remote support to " + what + " with administrator rights?\n\nSupport can change system settings and files for all users."
                : "Allow remote support to " + what + " as your signed-in user?";
            if (!screen) rights += "\n\nScreen, mouse and keyboard control stay off for this reconnect.";
            return rights + "\n\nA small window stays in the corner of your screen while support is connected. Access ends when you close it, click End session, or after 24 hours. Nothing reconnects after reboot unless separately prepared.";
        }
        public static bool Confirm(bool administrator, bool resume, Func<string, WF.DialogResult> prompt) { return Confirm(administrator, resume, true, prompt); }
        public static bool Confirm(bool administrator, bool resume, bool screen, Func<string, WF.DialogResult> prompt) {
            // A prepared reconnect never grants administrator access silently.
            return (resume && !administrator) || prompt(ConsentMessage(administrator, screen)) == WF.DialogResult.Yes;
        }
        // Full control is the default. UAC's own prompt is the consent; these texts are for when no prompt will
        // appear (FullHeading) and for the fallback when elevation was declined or failed (LimitedHeading).
        public const string Asking = "Windows will ask for permission to give support full control.";
        public const string FullHeading = "Give support full control of this PC?";
        public const string FullText = "Support can see your screen, control your mouse and keyboard, work through Windows security prompts and the sign-in screen, and keep working after a restart. Access ends when you click End session, or after 24 hours, and everything is removed.";
        public const string LimitedHeading = "Continue with limited support?";
        public const string LimitedText = "Support can see your screen and control your mouse and keyboard, but not Windows security prompts.";
        public const string LimitedAdmin = " This app was started as Administrator, so commands run with administrator rights.";
        public const string NoAdminNote = "Running without administrator access.";
    }

    // How full control gets its consent. Prompt: UAC will ask (Yes/No for an administrator, a password for a
    // standard user). Confirm: elevation will happen without a prompt, so the app asks itself, because consent must
    // always be a click. Unavailable: this account cannot elevate (UAC is off and it is not an administrator).
    public enum Consent { Prompt, Confirm, Unavailable }
    public static class ConsentPath {
        // elevated: the process already has a full administrator token. elevationType: TokenElevationType (1 default,
        // 2 full, 3 limited, the filtered token of an administrator). enableLua and consentAdmin: the UAC policy values, -1 when absent.
        public static Consent Decide(bool elevated, int elevationType, int enableLua, int consentAdmin) {
            if (elevated) return Consent.Confirm;
            if (enableLua == 0) return Consent.Unavailable;
            if (elevationType == 3 && consentAdmin == 0) return Consent.Confirm;
            return Consent.Prompt;
        }
        public static Consent Detect() {
            int lua = -1, admin = -1;
            using (var hklm = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64))
            using (var key = hklm.OpenSubKey(SasShare.PolicyKey)) {
                if (key != null) { object v = key.GetValue("EnableLUA"); if (v is int) lua = (int)v; v = key.GetValue("ConsentPromptBehaviorAdmin"); if (v is int) admin = (int)v; }
            }
            using (var identity = WindowsIdentity.GetCurrent()) return Decide(SupportAccess.IsAdministrator(), Native.ElevationType(identity.Token), lua, admin);
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
        public static Dictionary<string, object> ReadConfig(string file) { return ReadConfig(File.ReadAllBytes(file)); }
        public static Dictionary<string, object> ReadConfig(byte[] all) {
            int start = Payload(all), n = all.Length - Footer.Length - 4 - start;
            for (int i = 0; i < Footer.Length; i++) if (all[all.Length - Footer.Length + i] != (byte)Footer[i]) throw new InvalidDataException("Invalid session configuration.");
            var cfg = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(all, start, n));
            if (!System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "sid"), "^[0-9a-f]{64}$") ||
                !System.Text.RegularExpressions.Regex.IsMatch(Text(cfg, "key"), "^[0-9a-f]{64}$")) throw new InvalidDataException("Invalid session credentials.");
            Uri origin = new Uri(Text(cfg, "origin"));
            if ((origin.Scheme != "https" && !(origin.Scheme == "http" && origin.IsLoopback)) ||
                origin.AbsolutePath != "/" || origin.UserInfo != "" || origin.Query != "" || origin.Fragment != "")
                throw new InvalidDataException("Invalid support server.");
            return cfg;
        }
        // The length of the exe without its appended session configuration. The corner window's copy is cut there,
        // so the file a signed-in user can read carries no attach key.
        public static int Payload(byte[] all) {
            int tail = Footer.Length + 4;
            if (all.Length < tail) throw new InvalidDataException("Missing session configuration.");
            int n = BitConverter.ToInt32(all, all.Length - tail);
            if (n < 1 || n > 4096 || n > all.Length - tail) throw new InvalidDataException("Invalid session configuration size.");
            return all.Length - tail - n;
        }
    }

    // The child starts suspended. Assign it to a kill-on-close Job before any
    // customer command can run. Refuse execution if Windows cannot contain it.
    public sealed class CommandJob : IDisposable {
        IntPtr job, process;
        readonly MemoryStream stdout = new MemoryStream(), stderr = new MemoryStream();
        Thread outReader, errReader;
        public bool OutClipped, ErrClipped;
        [StructLayout(LayoutKind.Sequential)] internal struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Startup {
            public int Size; public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref ExtendedLimits limits, int size);
        [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out Accounting info, int size, IntPtr returned);
        public const int SettleMs = 1000;
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(IntPtr p, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr t);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr p, uint timeout);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security s, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security s, uint create, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string exe, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcessAsUser(IntPtr token, string exe, StringBuilder args, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        [DllImport("userenv.dll", SetLastError = true)] internal static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
        [DllImport("userenv.dll")] internal static extern bool DestroyEnvironmentBlock(IntPtr env);
        // A Job that kills every process in it when its last handle closes, with no breakaway.
        internal static IntPtr KillOnClose() {
            IntPtr j = CreateJobObject(IntPtr.Zero, null); Check(j != IntPtr.Zero);
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            if (!SetInformationJobObject(j, 9, ref limits, Marshal.SizeOf(limits))) { int e = Marshal.GetLastWin32Error(); CloseHandle(j); throw new Win32Exception(e); }
            return j;
        }
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
        public Dictionary<string, object> Run(string scriptPath, string cwd, int timeoutSeconds, WaitHandle stop) { return Run(scriptPath, cwd, timeoutSeconds, stop, IntPtr.Zero); }
        // token: a primary token to run as (full control: the signed-in user, in their session), or zero for this process's own.
        public Dictionary<string, object> Run(string scriptPath, string cwd, int timeoutSeconds, WaitHandle stop, IntPtr token) {
            IntPtr outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, input = IntPtr.Zero, env = IntPtr.Zero;
            ProcessInfo pi = new ProcessInfo();
            try {
                job = KillOnClose(); // KILL_ON_JOB_CLOSE, no breakaway
                var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
                Check(CreatePipe(out outRead, out outWrite, ref security, 0));
                Check(CreatePipe(out errRead, out errWrite, ref security, 0));
                Check(SetHandleInformation(outRead, 1, 0)); Check(SetHandleInformation(errRead, 1, 0));
                input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero); Check(input != new IntPtr(-1));
                var si = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x101, Input = input, Output = outWrite, Error = errWrite };
                string exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
                string args = "\"" + exe + "\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -File \"" + scriptPath + "\"";
                if (token == IntPtr.Zero) Check(CreateProcess(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, cwd, ref si, out pi));
                else {
                    Check(CreateEnvironmentBlock(out env, token, false)); si.Desktop = @"winsta0\default";
                    Check(CreateProcessAsUser(token, exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, true, 0x08000404, env, cwd, ref si, out pi));
                }
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
                // PowerShell does not wait for a GUI program it starts, such as rundll32.exe user32.dll,LockWorkStation. Give what
                // is left in the Job up to SettleMs to finish by itself, so it is not stopped before it did its work.
                Accounting info; var settle = Stopwatch.StartNew();
                while (!timedOut && settle.ElapsedMilliseconds < SettleMs && QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && info.Active > 0 && !stop.WaitOne(20)) { }
                Close(ref job); // then stop the descendants that are still running
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
                if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
                if (outReader != null) outReader.Join(5000); if (errReader != null) errReader.Join(5000);
            }
        }
        public void Dispose() { Close(ref job); Close(ref process); }
    }

    // Pure helpers. Screenshots fit 1280x800 and are never scaled up. Clients send
    // coordinates in screenshot pixels; these map them to physical pixels and back.
    public static class ScreenMath {
        public const int MaxW = 1280, MaxH = 800;
        public static void Fit(int w, int h, out int tw, out int th) {
            double s = Math.Min(1.0, Math.Min((double)MaxW / w, (double)MaxH / h));
            tw = Math.Max(1, (int)Math.Round(w * s)); th = Math.Max(1, (int)Math.Round(h * s));
        }
        // A screenshot pixel to the physical pixel at its center, and a region edge to the nearest physical edge.
        public static int ToPhysical(int v, int imageLen, int physLen) { return Math.Max(0, Math.Min(physLen - 1, (int)((v + 0.5) * physLen / imageLen))); }
        public static int EdgeToPhysical(int v, int imageLen, int physLen) { return Math.Max(0, Math.Min(physLen, (int)Math.Round((double)v * physLen / imageLen))); }
        public static int ToImage(int phys, int imageLen, int physLen) { return Math.Max(0, Math.Min(imageLen - 1, (int)((phys + 0.5) * imageLen / physLen))); }
        // The relay accepts display numbers 0 to 15, so a result may report at most 16 displays.
        public const int MaxDisplays = 16;
        public static void CapDisplays(List<Gdi.Rectangle> list) { if (list.Count > MaxDisplays) list.RemoveRange(MaxDisplays, list.Count - MaxDisplays); }
        // The display that holds a point, or the nearest one when the point is on none of them. -1 for an empty list.
        public static int MonitorAt(IList<Gdi.Rectangle> list, int x, int y) {
            int best = -1; long bestDistance = long.MaxValue;
            for (int i = 0; i < list.Count; i++) {
                var r = list[i];
                long dx = x < r.Left ? r.Left - x : x >= r.Right ? x - r.Right + 1 : 0, dy = y < r.Top ? r.Top - y : y >= r.Bottom ? y - r.Bottom + 1 : 0;
                long d = dx * dx + dy * dy;
                if (d < bestDistance) { bestDistance = d; best = i; }
            }
            return best;
        }
    }

    // GetLastInputInfo covers the customer's input and the app's own. This tells the two apart by the tick of the
    // app's last injected input, so the pause still works when Windows has dropped a hook. The tick has the
    // resolution of the system clock (about 15.6 ms), so on its own it can miss a key pressed in the same tick as the
    // app's last event; Screen also watches the keys and buttons that are held down.
    public static class InputIdle {
        // SendInput updates the last-input time before it returns (300 of 300 on Windows 11), so no slack is needed on
        // that system. A little stays in case an older Windows updates it a moment later; it is far below the 20 ms gap.
        public const int SlackMs = 10;
        // Milliseconds since the customer last used the mouse or keyboard, or -1 when the last input was the app's own.
        public static long CustomerAgoMs(uint lastInputTick, uint nowTick, uint lastInjectedTick, bool injected) {
            if (injected && unchecked((int)(lastInputTick - lastInjectedTick)) <= SlackMs) return -1;
            // Unsigned: a PC idle for more than 24.8 days still reads as idle. A time a moment ahead of now (the clock
            // was read just before the input) reads as "just now".
            uint ago = unchecked(nowTick - lastInputTick);
            return ago > uint.MaxValue - 1000 ? 0 : ago;
        }
        // A key that has read down for this long while no input reached Windows is stuck, not held by the customer.
        public const long StuckMs = 10000;
        public static bool Stuck(long downForMs, bool inputSince) { return !inputSince && downForMs >= StuckMs; }
        // Milliseconds left of the pause window for that age, 0 when there is none.
        public static long RemainingMs(long agoMs) { return agoMs < 0 ? 0 : Math.Max(0, PauseClock.WindowMs - agoMs); }
    }

    // Customer input wins: agent input is refused for 3 s after the last physical event.
    public sealed class PauseClock {
        public const long WindowMs = 3000;
        long last = long.MinValue / 2;
        public static long Now() { return Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency; }
        public void Touch(long now) { Interlocked.Exchange(ref last, now); }
        public bool Paused(long now) { return RemainingMs(now) > 0; }
        public long RemainingMs(long now) { return Math.Max(0, WindowMs - (now - Interlocked.Read(ref last))); }
    }

    // xdotool-style key names (ctrl+s, alt+tab, Return, F5, "ctrl+a Delete") to virtual-key codes.
    public static class KeySpec {
        // Windows ignores an injected Win+L, and the L would be typed into the focused window.
        public const string LockHint = "Windows ignores an injected Win+L. To lock the PC, use run with as: \"user\" and the command rundll32.exe user32.dll,LockWorkStation";
        static readonly Dictionary<string, int> Names = Build();
        static Dictionary<string, int> Build() {
            var d = new Dictionary<string, int>();
            foreach (string pair in ("ctrl=11 control=11 alt=12 shift=10 super=5B win=5B meta=5B cmd=5B return=0D enter=0D tab=09 escape=1B esc=1B space=20 backspace=08 delete=2E del=2E insert=2D home=24 end=23 " +
                "page_up=21 prior=21 pageup=21 page_down=22 next=22 pagedown=22 up=26 down=28 left=25 right=27 minus=BD equal=BB comma=BC period=BE slash=BF backslash=DC semicolon=BA apostrophe=DE grave=C0 bracketleft=DB bracketright=DD capslock=14").Split(' '))
                d[pair.Split('=')[0]] = Convert.ToInt32(pair.Split('=')[1], 16);
            return d;
        }
        public static bool IsModifier(int vk) { return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B; }
        public static bool IsExtended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B; }
        public static List<int[]> Parse(string keys) {
            var combos = new List<int[]>();
            foreach (string combo in keys.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
                var mods = new List<int>(); var rest = new List<int>();
                foreach (string raw in combo.Split('+')) {
                    string t = raw.ToLowerInvariant(); int vk;
                    if (!Names.TryGetValue(t, out vk)) {
                        var m = System.Text.RegularExpressions.Regex.Match(t, "^f([1-9]|1[0-9]|2[0-4])$");
                        if (m.Success) vk = 0x6F + int.Parse(m.Groups[1].Value);
                        else if (t.Length == 1 && ((t[0] >= 'a' && t[0] <= 'z') || (t[0] >= '0' && t[0] <= '9'))) vk = char.ToUpperInvariant(t[0]);
                        else throw new ArgumentException("Unknown key \"" + raw + "\".");
                    }
                    (IsModifier(vk) ? mods : rest).Add(vk);
                }
                mods.AddRange(rest);
                if (mods.Contains(0x11) && mods.Contains(0x12) && mods.Contains(0x2E)) throw new ArgumentException("Ctrl+Alt+Del cannot be sent as a key; use send_sas.");
                if (mods.Contains(0x5B) && mods.Contains(0x4C)) throw new ArgumentException(LockHint);
                combos.Add(mods.ToArray());
            }
            if (combos.Count == 0) throw new ArgumentException("No keys given.");
            return combos;
        }
    }

    public static class UiLines {
        // [12] Button "OK" (640,412): the ref, the control type, the name and the center in screenshot pixels.
        // The verbs ui_act can use on an element, from the UI Automation patterns it supports: invoke (InvokePattern), set_value
        // (ValuePattern, not read-only), toggle, expand and collapse (ExpandCollapsePattern, unless the element is a leaf), select
        // (SelectionItemPattern), and focus when the element can take the keyboard focus. A disabled element has none and is
        // marked "disabled" instead, because every verb on it would fail. Empty when none.
        public static string Verbs(bool invoke, bool value, bool readOnly, bool toggle, bool expand, bool select, bool focus, bool enabled = true, bool leaf = false) {
            if (!enabled) return "disabled";
            var list = new List<string>();
            if (invoke) list.Add("invoke");
            if (value && !readOnly) list.Add("set_value");
            if (toggle) list.Add("toggle");
            if (expand && !leaf) { list.Add("expand"); list.Add("collapse"); }
            if (select) list.Add("select");
            if (focus) list.Add("focus");
            return string.Join(",", list.ToArray());
        }
        public static string Line(int n, string type, string name, int x, int y, string verbs = "") {
            if (type.StartsWith("ControlType.")) type = type.Substring(12);
            var clean = new StringBuilder();
            foreach (char c in name) clean.Append(char.IsControl(c) ? ' ' : c == '"' ? '\'' : c);
            string text = clean.ToString().Trim(); if (text.Length > 80) text = text.Substring(0, 77) + "...";
            return "[" + n + "] " + type + (text.Length > 0 ? " \"" + text + "\"" : "") + " (" + x + "," + y + ")" + (verbs.Length > 0 ? " " + verbs : "");
        }
        // The relay takes at most 200,000 characters of result text. Stop at MaxChars and say that more exists.
        public const int MaxChars = 190000;
        public const string MoreByCount = "[more elements not shown; raise max_lines]", MoreByChars = "[more elements not shown; the text limit was reached]";
        public static string Join(IList<string> lines, bool moreByCount, int maxChars, out int kept) {
            var text = new StringBuilder(); kept = 0; bool cut = false;
            foreach (string line in lines) {
                if (text.Length + line.Length + 1 > maxChars - MoreByChars.Length - 1) { cut = true; break; }
                if (kept > 0) text.Append('\n');
                text.Append(line); kept++;
            }
            if (cut || moreByCount) { if (kept > 0) text.Append('\n'); text.Append(cut ? MoreByChars : MoreByCount); }
            return text.ToString();
        }
    }

    public static class JpegFit {
        // Steps the quality down until the base64 text is under maxChars.
        public static byte[] Encode(Gdi.Image image, int maxChars, out int quality) {
            Img.ImageCodecInfo codec = null;
            foreach (var c in Img.ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
            for (int q = 80; q >= 10; q -= 10) { // a loop, not an array initializer: the compiler would name a helper class with a random GUID and break the reproducible build
                using (var ms = new MemoryStream()) using (var parameters = new Img.EncoderParameters(1)) {
                    parameters.Param[0] = new Img.EncoderParameter(Img.Encoder.Quality, (long)q);
                    image.Save(ms, codec, parameters);
                    if ((ms.Length + 2) / 3 * 4 < maxChars) { quality = q; return ms.ToArray(); }
                }
            }
            throw new ScreenError("the screenshot is too large to send");
        }
    }

    // After the customer answers "End the session?" with Keep connected, the focus goes back to the window that had it
    // before the confirm took it, so support is not left with the support window in front.
    static class FocusReturn {
        // The window to hand the focus back to, or zero for none. Only while the support window still holds the
        // focus (the customer has not clicked elsewhere meanwhile), and never to one of our own windows or one
        // that is gone, hidden, minimized, on another desktop or no longer the same window.
        public static IntPtr Target(IntPtr remembered, IntPtr foreground, Func<IntPtr, bool> ours, Func<IntPtr, bool> usable) {
            if (remembered == IntPtr.Zero || foreground == IntPtr.Zero || ours(remembered) || !ours(foreground)) return IntPtr.Zero;
            return usable(remembered) ? remembered : IntPtr.Zero;
        }
        // True when the handle is still the same visible, not minimized top-level window of this thread's current desktop:
        // the same process and thread own it as when it was remembered, so a reused handle is not mistaken for it.
        public static bool Usable(IntPtr window, uint pid, uint thread) {
            if (!Win.IsWindowVisible(window) || Win.IsIconic(window)) return false;
            uint now; uint nowThread = Win.GetWindowThreadProcessId(window, out now);
            if (now != pid || nowThread != thread) return false;
            bool found = false;
            Win.EnumDesktopWindows(Win.GetThreadDesktop(Win.GetCurrentThreadId()), delegate(IntPtr w, IntPtr data) { if (w == window) { found = true; return false; } return true; }, IntPtr.Zero);
            return found;
        }
        public static bool Ours(IntPtr window) { uint pid; Win.GetWindowThreadProcessId(window, out pid); return pid == Win.GetCurrentProcessId(); }
    }

    sealed class ScreenError : Exception { public ScreenError(string message) : base(message) { } }

    static class Win {
        public const uint NoActivate = 0x08000000, AppWindow = 0x00040000;
        public delegate bool WindowProc(IntPtr window, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] public struct Rc { public int L, T, R, B; }
        [StructLayout(LayoutKind.Sequential)] public struct Msg { public IntPtr Window; public uint Message; public IntPtr W, L; public uint Time; public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rc Monitor, Work; public uint Flags; }
        [StructLayout(LayoutKind.Sequential)] public struct MouseIn { public int Dx, Dy; public uint Data, Flags, Time; public IntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] public struct KeyIn { public ushort Vk, Scan; public uint Flags, Time; public IntPtr Extra; }
        // The INPUT union starts at offset 4 on x86, the only platform this app builds for (28 bytes in all).
        [StructLayout(LayoutKind.Explicit)] public struct In { [FieldOffset(0)] public uint Type; [FieldOffset(4)] public MouseIn Mouse; [FieldOffset(4)] public KeyIn Key; }
        public delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref Rc rect, IntPtr data);
        public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, In[] inputs, int size);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
        [StructLayout(LayoutKind.Sequential)] public struct LastInput { public uint Size, Time; }
        [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInput info);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rc rect);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out Gdi.Point p);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Gdi.Point p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] public static extern int SetWindowLong(IntPtr window, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr desktop, WindowProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetMessage(out Msg m, IntPtr window, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool PostThreadMessage(uint thread, uint message, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder name, int length, out int needed);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr source, int sx, int sy, uint op);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
    }

    // Physical input detection: low-level hooks on their own message-loop thread. The
    // injected flag is set on everything SendInput sends, so only the customer's input counts.
    public sealed class InputWatch : IDisposable {
        public readonly PauseClock Clock = new PauseClock();
        public volatile bool Ok;
        readonly Win.HookProc mouse, keys; // fields, so the delegates are not collected
        readonly ManualResetEvent ready = new ManualResetEvent(false);
        Thread thread; uint threadId;
        IntPtr desktop; // full control: the desktop the hooks watch (closed on Dispose), or zero for the thread's own
        public InputWatch() {
            mouse = delegate(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 12) & 3) == 0) Clock.Touch(PauseClock.Now()); return Win.CallNextHookEx(IntPtr.Zero, code, w, l); };
            keys = delegate(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 8) & 0x12) == 0) Clock.Touch(PauseClock.Now()); return Win.CallNextHookEx(IntPtr.Zero, code, w, l); };
        }
        public void Start() { Start(IntPtr.Zero); }
        // Low-level hooks see only the input of the desktop of their thread, so full control re-arms them on each desktop.
        public void Start(IntPtr desktop) {
            this.desktop = desktop;
            thread = new Thread(Loop); thread.IsBackground = true; thread.Start(); ready.WaitOne(5000);
        }
        void Loop() {
            threadId = Win.GetCurrentThreadId();
            if (desktop != IntPtr.Zero && !Win.SetThreadDesktop(desktop)) { ready.Set(); return; }
            IntPtr module = Win.GetModuleHandle(null), m = Win.SetWindowsHookEx(14, mouse, module, 0), k = Win.SetWindowsHookEx(13, keys, module, 0);
            Ok = m != IntPtr.Zero && k != IntPtr.Zero; ready.Set();
            Win.Msg msg; while (Ok && Win.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            if (m != IntPtr.Zero) Win.UnhookWindowsHookEx(m);
            if (k != IntPtr.Zero) Win.UnhookWindowsHookEx(k);
        }
        public void Dispose() {
            Ok = false; if (thread == null) return;
            Win.PostThreadMessage(threadId, 0x12, IntPtr.Zero, IntPtr.Zero);
            if (thread.Join(3000) && desktop != IntPtr.Zero) Win.CloseDesktop(desktop);
        }
    }

    // Capture, input and UI Automation for one screen operation at a time, all in the user's own process.
    public sealed class Screen : IDisposable {
        public const string PauseText = "customer is using the PC; try again in a few seconds";
        public const string NoFull = "this needs full control";
        // The only error text type_secret ever returns. Nothing about the secret or the target can leak through it.
        public const string SecretFailed = "type_secret failed";
        // Least time between two typed characters. Windows 11 Notepad reads the character of a Unicode key event late,
        // so a character injected before it has read the previous one replaces it (see TypeText). 20 ms is twice the
        // slowest gap that still went wrong in the measurements, and it holds the relay's 35 ms per character budget.
        public const int TypeGapMs = 20;
        internal volatile InputWatch Watch = new InputWatch();
        // Full control: this process is the SYSTEM helper on the console session. It may work on the secure desktop,
        // its own windows are the corner window's processes (OwnPids), Blocked is true while block_input holds the
        // customer's input (then the pause does not apply), and Step runs between the steps of an input.
        public static volatile bool Full;
        internal static volatile int[] OwnPids = new int[0];
        public Func<bool> Blocked;
        public Action Step;
        string watchDesktop;
        readonly object rearmGate = new object();
        volatile List<AutomationElement> refs = new List<AutomationElement>();
        volatile int treeDisplay; // the display the last ui_tree read; ui_act's screenshot comes from it
        static int injectedTick; static volatile bool injectedAny; // the app's own last injected input, for GetLastInputInfo
        public void Start() { Watch.Start(); if (!Watch.Ok) ProveFallback(); }
        // Full control, on a thread that is on the input desktop: move the hooks to that desktop when it changed.
        internal void Rearm() {
            lock (rearmGate) {
                string name = InputName();
                if (name == null || (name == watchDesktop && Watch.Ok)) return;
                IntPtr d = Win.OpenInputDesktop(0, false, 0x10000000);
                if (d == IntPtr.Zero) return;
                var fresh = new InputWatch(); fresh.Start(d);
                var old = Watch; Watch = fresh; watchDesktop = name; old.Dispose();
                if (!fresh.Ok) ProveFallback();
            }
        }
        public void Dispose() { Watch.Dispose(); }
        public bool Paused { get { return PausedForMs > 0; } }
        // The pause comes from three sources. The low-level hooks see only physical input, but Windows removes a hook
        // that times out, without telling the app. So there are two that cannot be dropped. GetLastInputInfo also
        // counts the app's own input, so it is compared with the tick of the app's last injection (Send records it
        // from the same call), and a later input counts. That tick is only as fine as the system clock, so a key
        // pressed in the same tick as the app's last event shows only in the third source: a key or mouse button that
        // is down right now. The app's own key events go down and up inside one SendInput call, so between its calls
        // nothing of its own is down.
        public long PausedForMs {
            get {
                var info = new Win.LastInput { Size = (uint)Marshal.SizeOf(typeof(Win.LastInput)) };
                bool known = Win.GetLastInputInfo(ref info);
                long external = known
                    ? InputIdle.RemainingMs(InputIdle.CustomerAgoMs(info.Time, unchecked((uint)Environment.TickCount), unchecked((uint)Thread.VolatileRead(ref injectedTick)), injectedAny)) : 0;
                if (AnyInputDown(known ? info.Time : 0)) Watch.Clock.Touch(PauseClock.Now());
                return Math.Max(external, Watch.Clock.RemainingMs(PauseClock.Now()));
            }
        }
        static int holding; // above 0 while the app itself keeps a key or mouse button down (Press, Drag)
        // Keys and mouse buttons the app pressed and has not yet seen come up. A key or click that switches the desktop
        // (Escape or Cancel on the Ctrl+Alt+Del screen, Return on the sign-in screen, Yes on UAC) does its work on the
        // way down; its up is refused, or lands on the desktop that is gone, so Windows keeps it down on the new one.
        // Unstick sends those ups on the desktop shown now, and AnyInputDown never takes them for the customer's.
        static readonly List<int> ours = new List<int>();
        static readonly object pad = new object(); // one sender of downs and ups at a time: an input, or Unstick
        static bool Ours(int vk) { lock (ours) return ours.Contains(vk); }
        static void NoteDowns(Win.In[] inputs) {
            foreach (var i in inputs) {
                int vk = i.Type == 1 ? ((i.Key.Flags & 6) == 0 ? i.Key.Vk : 0) : (i.Mouse.Flags & 2) != 0 ? 1 : (i.Mouse.Flags & 8) != 0 ? 2 : (i.Mouse.Flags & 0x20) != 0 ? 4 : 0;
                if (vk != 0) lock (ours) if (!ours.Contains(vk)) ours.Add(vk);
            }
        }
        static bool OnShownDesktop() {
            string shown = InputName(), mine = DesktopName(Win.GetThreadDesktop(Win.GetCurrentThreadId()));
            return shown != null && shown == mine; // GetAsyncKeyState reads nothing on any other desktop
        }
        // On a thread on the desktop shown now: release what the app left down, and forget what is up.
        internal static void Unstick() {
            if (Thread.VolatileRead(ref holding) > 0 || !OnShownDesktop()) return;
            lock (pad) {
                int[] list; lock (ours) list = ours.ToArray();
                foreach (int vk in list) {
                    if ((Win.GetAsyncKeyState(vk) & 0x8000) != 0) {
                        var up = vk == 1 ? MouseEvent(0, 0, 0, 4) : vk == 2 ? MouseEvent(0, 0, 0, 0x10) : vk == 4 ? MouseEvent(0, 0, 0, 0x40)
                            : KeyEvent(vk, (ushort)Win.MapVirtualKey((uint)vk, 0), (KeySpec.IsExtended(vk) ? 1u : 0u) | 2u);
                        Win.SendInput(1, new Win.In[] { up }, Marshal.SizeOf(typeof(Win.In))); RecordInjection();
                    }
                    if ((Win.GetAsyncKeyState(vk) & 0x8000) == 0) lock (ours) ours.Remove(vk);
                }
            }
        }
        // Since when each key has read down, and the last-input time then. A key the customer holds repeats, so the
        // last-input time moves; one that reads down for StuckMs while it does not is stuck, and stops the pause.
        static readonly Dictionary<int, long> downSince = new Dictionary<int, long>(); static readonly Dictionary<int, uint> downTick = new Dictionary<int, uint>();
        static bool AnyInputDown(uint lastInput) {
            if (Thread.VolatileRead(ref holding) > 0) return false;
            long now = PauseClock.Now(); bool any = false;
            lock (downSince) {
                for (int vk = 1; vk < 255; vk++) {
                    if ((Win.GetAsyncKeyState(vk) & 0x8000) == 0) { downSince.Remove(vk); continue; }
                    if (Ours(vk)) continue;
                    long since; uint tick;
                    if (!downSince.TryGetValue(vk, out since) || !downTick.TryGetValue(vk, out tick) || tick != lastInput) { downSince[vk] = since = now; downTick[vk] = lastInput; }
                    if (!InputIdle.Stuck(now - since, false)) any = true;
                }
            }
            return any;
        }
        // After the app's own input: the time Windows gave it. Any input later than this is the customer's.
        static void RecordInjection() {
            int now = Environment.TickCount, stamp = now;
            var info = new Win.LastInput { Size = (uint)Marshal.SizeOf(typeof(Win.LastInput)) };
            if (Win.GetLastInputInfo(ref info) && unchecked((int)(info.Time - (uint)now)) > 0) stamp = unchecked((int)info.Time);
            Interlocked.Exchange(ref injectedTick, stamp); injectedAny = true;
        }
        // When the hooks did not install, the two other sources are the only guard. Prove first that this session's
        // last-input time follows the app's own input: send one harmless key (F24) and read the time back.
        volatile bool fallbackProven;
        internal bool ProveFallback() {
            try {
                Send(KeyEvent(0x87, 0, 0), KeyEvent(0x87, 0, 2));
                var info = new Win.LastInput { Size = (uint)Marshal.SizeOf(typeof(Win.LastInput)) };
                bool ok = Win.GetLastInputInfo(ref info) && Math.Abs(unchecked((int)(info.Time - (uint)Environment.TickCount))) <= 100;
                fallbackProven = ok; return ok;
            } catch (ScreenError) { return false; }
        }

        // Physical pixels on every display: per-monitor aware for this thread on Windows 10 1607+,
        // system aware for the process before that. The manifest stays as it is, so the WPF
        // corner window keeps its look.
        internal static void Dpi() {
            try { if (Win.SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) Win.SetThreadDpiAwarenessContext(new IntPtr(-3)); }
            catch (EntryPointNotFoundException) { Win.SetProcessDPIAware(); }
        }
        internal static List<Gdi.Rectangle> Monitors() {
            var others = new List<Gdi.Rectangle>(); Gdi.Rectangle? primary = null;
            Win.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref Win.Rc rect, IntPtr data) {
                var info = new Win.MonitorInfo { Size = Marshal.SizeOf(typeof(Win.MonitorInfo)) };
                if (!Win.GetMonitorInfo(monitor, ref info)) return true;
                var r = Gdi.Rectangle.FromLTRB(info.Monitor.L, info.Monitor.T, info.Monitor.R, info.Monitor.B);
                if ((info.Flags & 1) != 0) primary = r; else others.Add(r);
                return true;
            }, IntPtr.Zero);
            others.Sort(delegate(Gdi.Rectangle a, Gdi.Rectangle b) { return a.X != b.X ? a.X.CompareTo(b.X) : a.Y.CompareTo(b.Y); });
            if (primary.HasValue) others.Insert(0, primary.Value);
            ScreenMath.CapDisplays(others); // the relay rejects a result that reports more displays than it can number
            return others;
        }
        // "default" for the user's desktop. The secure desktop (UAC, lock, sign-in, Ctrl+Alt+Del) is "secure" in full
        // control and "unknown" in normal mode, which cannot open it.
        internal static string Desktop() { string name = InputName(); return name == "Default" ? "default" : name == "Winlogon" ? "secure" : "unknown"; }
        internal static string InputName() {
            IntPtr d = Win.OpenInputDesktop(0, false, 1);
            if (d == IntPtr.Zero) d = Win.OpenInputDesktop(0, false, 0); // no access asked: the name is all that is read
            if (d == IntPtr.Zero) return null;
            try { return DesktopName(d); } finally { Win.CloseDesktop(d); }
        }
        internal static string DesktopName(IntPtr d) { var name = new StringBuilder(64); int needed; return Win.GetUserObjectInformation(d, 2, name, 128, out needed) ? name.ToString() : null; }

        sealed class View {
            public Gdi.Rectangle Phys; public int Index, Count, W, H;
            public int PhysX(int x) { return Phys.X + ScreenMath.ToPhysical(x, W, Phys.Width); }
            public int PhysY(int y) { return Phys.Y + ScreenMath.ToPhysical(y, H, Phys.Height); }
            public void Check(int x, int y) { if (x < 0 || y < 0 || x >= W || y >= H) throw new ScreenError("coordinate " + x + "," + y + " is outside the " + W + "x" + H + " screenshot"); }
        }
        static View GetView(int i) {
            var list = Monitors();
            if (i < 0 || i >= list.Count) throw new ScreenError("no display " + i + "; this PC has " + list.Count);
            var v = new View { Phys = list[i], Index = i, Count = list.Count }; ScreenMath.Fit(v.Phys.Width, v.Phys.Height, out v.W, out v.H); return v;
        }
        static View GetView(Dictionary<string, object> a) { return GetView((int)Wire.Number(a, "display")); }
        // The display of the last ui_tree, or the primary one when displays changed since: the ref may still be good.
        static View GetViewOrPrimary(int i) { return GetView(i >= 0 && i < Monitors().Count ? i : 0); }
        // ui_tree reads the foreground window, so it uses the display that holds the center of that window.
        static View ForegroundView() {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == IntPtr.Zero) throw new ScreenError("no window is in the foreground");
            Win.Rc rc; int index = 0;
            if (Win.GetWindowRect(fg, out rc)) index = Math.Max(0, ScreenMath.MonitorAt(Monitors(), (rc.L + rc.R) / 2, (rc.T + rc.B) / 2));
            return GetView(index);
        }
        static Gdi.Bitmap Grab(Gdi.Rectangle r) {
            var bmp = new Gdi.Bitmap(r.Width, r.Height, Img.PixelFormat.Format24bppRgb);
            // BitBlt with CAPTUREBLT, because CopyFromScreen cannot ask for layered windows (menus, tooltips).
            IntPtr screen = Win.GetDC(IntPtr.Zero); bool ok = false;
            try {
                using (var g = Gdi.Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); try { ok = Win.BitBlt(dc, 0, 0, r.Width, r.Height, screen, r.X, r.Y, 0x40CC0020); } finally { g.ReleaseHdc(dc); } }
            } finally { Win.ReleaseDC(IntPtr.Zero, screen); }
            if (!ok) { bmp.Dispose(); throw new ScreenError("cannot capture the screen; Windows may be locked"); }
            return bmp;
        }
        // A region in physical pixels, scaled down to fit 1280x800 and encoded under 700,000 base64 characters.
        static Dictionary<string, object> Shot(Gdi.Rectangle region) {
            int w, h, quality; ScreenMath.Fit(region.Width, region.Height, out w, out h);
            using (var full = Grab(region)) {
                var shown = full;
                if (w != region.Width || h != region.Height) {
                    shown = new Gdi.Bitmap(w, h, Img.PixelFormat.Format24bppRgb);
                    using (var g = Gdi.Graphics.FromImage(shown)) {
                        g.InterpolationMode = Gdi.Drawing2D.InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = Gdi.Drawing2D.PixelOffsetMode.HighQuality;
                        g.DrawImage(full, new Gdi.Rectangle(0, 0, w, h), 0, 0, region.Width, region.Height, Gdi.GraphicsUnit.Pixel);
                    }
                }
                try { return Wire.Map("image_b64", Convert.ToBase64String(JpegFit.Encode(shown, 700000, out quality)), "mime", "image/jpeg", "width", w, "height", h); }
                finally { if (shown != full) shown.Dispose(); }
            }
        }

        static bool Owns(IntPtr window) { uint pid; Win.GetWindowThreadProcessId(window, out pid); return OwnsPid((int)pid); }
        static bool OwnsPid(int pid) { return pid == (int)Win.GetCurrentProcessId() || Array.IndexOf(OwnPids, pid) >= 0; }
        // Normal mode cannot drive a window that runs elevated: Windows silently drops the input.
        static void NotElevated(IntPtr window) {
            if (window == IntPtr.Zero || SupportAccess.IsAdministrator()) return;
            uint pid; Win.GetWindowThreadProcessId(window, out pid);
            IntPtr process = Win.OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
            if (process == IntPtr.Zero) return;
            try {
                int elevated = 0, size;
                bool opened = Win.OpenProcessToken(process, 8, out token); int error = Marshal.GetLastWin32Error();
                if ((opened && Win.GetTokenInformation(token, 20, out elevated, 4, out size) && elevated != 0) || (!opened && error == 5))
                    throw new ScreenError("that window runs as administrator; this app cannot control it");
            } finally { if (token != IntPtr.Zero) Win.CloseHandle(token); Win.CloseHandle(process); }
        }
        void Free() {
            var blocked = Blocked; if (blocked != null && blocked()) return; // the customer's input is blocked, so it cannot pause support
            if (!Watch.Ok && !fallbackProven) throw new ScreenError("cannot watch for customer input");
            if (Paused) throw new ScreenError(PauseText);
        }
        // Between the steps of a longer input: stop when support access has ended, and give way to the customer.
        void Between(WaitHandle stop) {
            if (stop.WaitOne(0)) throw new ScreenError("support access ended");
            var step = Step; if (step != null) step();
            Free();
        }
        // Waits ms, or throws when support access ends first.
        static void Wait(WaitHandle stop, int ms) { if (stop.WaitOne(ms)) throw new ScreenError("support access ended"); }
        // Keystrokes go to the foreground window: refuse the support window and an elevated window. The check
        // is repeated for every step of a multi-step input, because the focus can change between steps.
        static void KeyTarget(ref IntPtr seen) {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == seen) return;
            if (fg != IntPtr.Zero && Owns(fg)) throw new ScreenError("the support window has the keyboard focus; click another window first");
            NotElevated(fg);
            seen = fg;
        }
        internal static void Send(params Win.In[] inputs) {
            NoteDowns(inputs);
            uint sent = Win.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win.In)));
            RecordInjection();
            if (sent != inputs.Length) throw new ScreenError("Windows refused the input");
        }
        static Win.In MouseEvent(int dx, int dy, int data, uint flags) {
            var i = new Win.In { Type = 0 }; i.Mouse = new Win.MouseIn { Dx = dx, Dy = dy, Data = unchecked((uint)data), Flags = flags }; return i;
        }
        internal static Win.In KeyEvent(int vk, ushort scan, uint flags) {
            var i = new Win.In { Type = 1 }; i.Key = new Win.KeyIn { Vk = (ushort)vk, Scan = scan, Flags = flags }; return i;
        }
        // Absolute move over the whole virtual desktop, rounded up so Windows lands on this exact pixel.
        static void MoveTo(int px, int py) {
            int vx = Win.GetSystemMetrics(76), vy = Win.GetSystemMetrics(77), vw = Math.Max(1, Win.GetSystemMetrics(78)), vh = Math.Max(1, Win.GetSystemMetrics(79));
            Send(MouseEvent((int)(((long)(px - vx) * 65536 + vw - 1) / vw), (int)(((long)(py - vy) * 65536 + vh - 1) / vh), 0, 0xC001));
        }
        static void Press(int[] combo) {
            var down = new List<Win.In>(); var up = new List<Win.In>();
            foreach (int vk in combo) {
                ushort scan = (ushort)Win.MapVirtualKey((uint)vk, 0); uint ext = KeySpec.IsExtended(vk) ? 1u : 0u;
                down.Add(KeyEvent(vk, scan, ext)); up.Insert(0, KeyEvent(vk, scan, ext | 2u));
            }
            Interlocked.Increment(ref holding);
            try {
                lock (pad) {
                string before = Full ? InputName() : null;
                Send(down.ToArray()); Thread.Sleep(30);
                // Full control: a key that switches the desktop (Return on the sign-in screen) has done its work, and Windows
                // refuses its key-up on the desktop that is gone. That is not a failure.
                try { Send(up.ToArray()); } catch (ScreenError) { if (!Full || InputName() == before) throw; }
                }
            } finally { Interlocked.Decrement(ref holding); }
        }
        // One real key press, down and up in a single call.
        static void Tap(int vk) {
            ushort scan = (ushort)Win.MapVirtualKey((uint)vk, 0); uint ext = KeySpec.IsExtended(vk) ? 1u : 0u;
            lock (pad) Send(KeyEvent(vk, scan, ext), KeyEvent(vk, scan, ext | 2u));
        }
        // Unicode key events type any character the target accepts, whatever the keyboard layout. Newline and tab are
        // real Return and Tab keys. A character above U+FFFF goes as its two surrogate halves, one event pair each.
        //
        // Pacing matters. Windows 11 Notepad does not take the character from each Unicode key event. It reads it
        // when it gets to the event, and by then a faster sender has already replaced it: "abc def 123" became
        // "abc 3333333". One call with every event gave the same result, so the fix is time between characters.
        // The old code slept 2 ms, which is 2 ms only while something (a browser, a WPF animation like this app's
        // own window) has raised the system timer to 1 ms; otherwise Windows rounds it up to 15.6 ms and the bug hid.
        // So this raises the timer itself and waits TypeGapMs between characters. Typing 5000 characters takes
        // about 100 s.
        internal void TypeText(string text, WaitHandle stop, bool secret) {
            int sent = 0, total = 0; IntPtr seen = IntPtr.Zero; var gap = new Stopwatch(); bool afterHigh = false;
            foreach (char c in text) if (c != '\r') total++;
            Win.timeBeginPeriod(1);
            try {
                foreach (char c in text) {
                    if (c == '\r') continue;
                    // The two halves of a surrogate pair go out as one character: nothing is checked between them.
                    bool secondHalf = afterHigh && char.IsLowSurrogate(c);
                    try {
                        // Wait out the gap, watching the customer and the stop flag all the time, then check once more
                        // right before the event. A check before the gap would be 20 ms old by the time it is sent.
                        // Thread.Sleep(1), not WaitOne(1): with the timer at 1 ms the sleep takes about 2 ms, but a 1 ms wait on a handle still takes about 15 ms.
                        while (gap.IsRunning && gap.ElapsedMilliseconds < TypeGapMs) { if (!secondHalf) Between(stop); Thread.Sleep(1); }
                        if (!secondHalf) { Between(stop); KeyTarget(ref seen); }
                        if (c == '\n') Tap(0x0D); else if (c == '\t') Tap(0x09);
                        else Send(KeyEvent(0, c, 4), KeyEvent(0, c, 6));
                    } catch (ScreenError e) {
                        // A secret's error carries no count, and the relay drops its text anyway.
                        if (secret || sent == 0) throw;
                        throw new ScreenError(e.Message + " (typed " + sent + " of " + total + " characters)");
                    }
                    gap.Reset(); gap.Start(); sent++; afterHigh = char.IsHighSurrogate(c);
                }
            } finally { Win.timeEndPeriod(1); }
        }
        // Refuse a target in this process's own windows (the corner window, dialogs) or in an elevated window.
        static void Target(int px, int py) {
            IntPtr hit = Win.WindowFromPoint(new Gdi.Point(px, py)), root = hit == IntPtr.Zero ? IntPtr.Zero : Win.GetAncestor(hit, 2);
            if (root != IntPtr.Zero && Owns(root)) throw new ScreenError("that spot is the support window; use another spot");
            NotElevated(root);
        }
        void Click(View v, int x, int y, string button, int count, WaitHandle stop) {
            v.Check(x, y); int px = v.PhysX(x), py = v.PhysY(y);
            Target(px, py); MoveTo(px, py);
            uint down = button == "right" ? 8u : button == "middle" ? 0x20u : 2u;
            for (int i = 0; i < count; i++) { if (i > 0) Between(stop); lock (pad) Send(MouseEvent(0, 0, 0, down), MouseEvent(0, 0, 0, down * 2)); Wait(stop, 40); }
        }
        // The button is released even when the drag stops early, so a pause never leaves it held down.
        void Drag(View v, int x1, int y1, int x2, int y2, WaitHandle stop) {
            v.Check(x1, y1); v.Check(x2, y2); int ax = v.PhysX(x1), ay = v.PhysY(y1), bx = v.PhysX(x2), by = v.PhysY(y2);
            Target(ax, ay); Target(bx, by);
            MoveTo(ax, ay); Wait(stop, 50);
            Interlocked.Increment(ref holding);
            lock (pad) try {
                Send(MouseEvent(0, 0, 0, 2));
                for (int i = 1; i <= 10; i++) { Wait(stop, 20); Between(stop); MoveTo(ax + (bx - ax) * i / 10, ay + (by - ay) * i / 10); }
                Wait(stop, 50);
            } finally { try { Send(MouseEvent(0, 0, 0, 4)); } finally { Interlocked.Decrement(ref holding); } }
        }

        // Input actions: refuse during a customer pause, in the support window and in elevated windows.
        void Input(string name, Dictionary<string, object> a, View v, WaitHandle stop) {
            Free();
            IntPtr seen = IntPtr.Zero;
            if (name == "type" || name == "type_secret" || name == "key") KeyTarget(ref seen);
            // type_secret shares the typing code; the name is mapped so the switch stays small (see the note at the top).
            switch (name == "type_secret" ? "type" : name) {
                case "move": v.Check((int)Wire.Number(a, "x"), (int)Wire.Number(a, "y")); MoveTo(v.PhysX((int)Wire.Number(a, "x")), v.PhysY((int)Wire.Number(a, "y"))); break;
                case "click": {
                    string button = Wire.Text(a, "button") == "" ? "left" : Wire.Text(a, "button");
                    if (button != "left" && button != "right" && button != "middle") throw new ScreenError("button must be left, right or middle");
                    Click(v, (int)Wire.Number(a, "x"), (int)Wire.Number(a, "y"), button, (int)Math.Max(1, Math.Min(3, a.ContainsKey("count") ? Wire.Number(a, "count") : 1)), stop); break;
                }
                case "drag": Drag(v, (int)Wire.Number(a, "x1"), (int)Wire.Number(a, "y1"), (int)Wire.Number(a, "x2"), (int)Wire.Number(a, "y2"), stop); break;
                case "scroll": {
                    string dir = Wire.Text(a, "direction") == "" ? "down" : Wire.Text(a, "direction");
                    int amount = (int)Math.Max(1, Math.Min(50, a.ContainsKey("amount") ? Wire.Number(a, "amount") : 3));
                    if (dir != "up" && dir != "down" && dir != "left" && dir != "right") throw new ScreenError("direction must be up, down, left or right");
                    if (a.ContainsKey("x")) Click(v, (int)Wire.Number(a, "x"), (int)Wire.Number(a, "y"), "none", 0, stop);
                    Send(MouseEvent(0, 0, 120 * amount * (dir == "up" || dir == "right" ? 1 : -1), dir == "up" || dir == "down" ? 0x800u : 0x1000u)); break;
                }
                case "type": {
                    string text = Wire.Text(a, "text");
                    if (text.Length > 5000) throw new ScreenError("text is longer than 5000 characters");
                    TypeText(text, stop, name == "type_secret"); break;
                }
                default:
                    foreach (int[] combo in KeySpec.Parse(Wire.Text(a, "keys"))) { Between(stop); KeyTarget(ref seen); Press(combo); Wait(stop, 20); }
                    break;
            }
        }

        // UI Automation of the foreground window. Refs are numbers in the lines and live until the next ui_tree.
        // The verbs of an element, read from the cache the walk already asked for (one round trip per element, not one per pattern).
        static string VerbsOf(AutomationElement e) {
            bool value = Cached(e, AutomationElement.IsValuePatternAvailableProperty), readOnly = false;
            if (value) { object o = e.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty); readOnly = !(o is bool) || (bool)o; } // unknown counts as read-only
            bool expand = Cached(e, AutomationElement.IsExpandCollapsePatternAvailableProperty), leaf = false;
            if (expand) { object o = e.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty); leaf = o is ExpandCollapseState && (ExpandCollapseState)o == ExpandCollapseState.LeafNode; }
            object enabled = e.GetCachedPropertyValue(AutomationElement.IsEnabledProperty); // unknown counts as enabled
            return UiLines.Verbs(Cached(e, AutomationElement.IsInvokePatternAvailableProperty), value, readOnly, Cached(e, AutomationElement.IsTogglePatternAvailableProperty),
                expand, Cached(e, AutomationElement.IsSelectionItemPatternAvailableProperty), e.Cached.IsKeyboardFocusable, !(enabled is bool) || (bool)enabled, leaf);
        }
        static bool Cached(AutomationElement e, AutomationProperty p) { object o = e.GetCachedPropertyValue(p); return o is bool && (bool)o; }
        string Tree(View v, int max) {
            IntPtr fg = Win.GetForegroundWindow();
            if (fg == IntPtr.Zero) throw new ScreenError("no window is in the foreground");
            if (Owns(fg)) throw new ScreenError("the foreground window is the support window");
            var cache = new CacheRequest { TreeScope = TreeScope.Element };
            foreach (var p in new AutomationProperty[] { AutomationElement.NameProperty, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsKeyboardFocusableProperty, AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsEnabledProperty }) cache.Add(p);
            cache.Add(ValuePattern.IsReadOnlyProperty); cache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
            var list = new List<AutomationElement>(); var lines = new List<string>(); var clock = Stopwatch.StartNew(); int visited = 0; bool more = false;
            using (cache.Activate()) {
                var walker = TreeWalker.ControlViewWalker; Action<AutomationElement, int> walk = null;
                walk = delegate(AutomationElement e, int depth) {
                    if (lines.Count >= max || ++visited > 4000 || clock.ElapsedMilliseconds > 8000) { more = true; return; }
                    try {
                        var c = e.Cached; if (c.IsOffscreen) return;
                        var r = c.BoundingRectangle;
                        if (!r.IsEmpty && (c.Name.Length > 0 || c.IsKeyboardFocusable)) {
                            int cx = (int)(r.X + r.Width / 2) - v.Phys.X, cy = (int)(r.Y + r.Height / 2) - v.Phys.Y;
                            if (cx >= 0 && cy >= 0 && cx < v.Phys.Width && cy < v.Phys.Height) {
                                list.Add(e); lines.Add(UiLines.Line(list.Count, c.ControlType.ProgrammaticName, c.Name, ScreenMath.ToImage(cx, v.W, v.Phys.Width), ScreenMath.ToImage(cy, v.H, v.Phys.Height), VerbsOf(e)));
                            }
                        }
                        if (depth < 40) for (var child = walker.GetFirstChild(e, cache); child != null; child = walker.GetNextSibling(child, cache)) walk(child, depth + 1);
                    } catch (ElementNotAvailableException) { } catch (InvalidOperationException) { } catch (COMException) { } // one bad element must not end the tree
                };
                walk(AutomationElement.FromHandle(fg), 0);
            }
            int kept; string text = UiLines.Join(lines, more, UiLines.MaxChars, out kept);
            if (kept < list.Count) list.RemoveRange(kept, list.Count - kept); // a ref the text does not show is not offered
            refs = list; treeDisplay = v.Index;
            return text;
        }
        static bool Limited(Action action, int ms) {
            // The new thread works on this thread's desktop, which in full control may be the secure one.
            Exception error = null; IntPtr desktop = Win.GetThreadDesktop(Win.GetCurrentThreadId());
            var t = new Thread(delegate() { try { Win.SetThreadDesktop(desktop); action(); } catch (Exception e) { error = e; } }); t.IsBackground = true; t.Start();
            if (!t.Join(ms)) return false;
            if (error != null) throw new ScreenError(error.Message);
            return true;
        }
        string UiAct(Dictionary<string, object> a) {
            Free();
            int n = (int)Wire.Number(a, "ref"); var list = refs; string verb = Wire.Text(a, "verb"), note = null;
            if (n < 1 || n > list.Count) throw new ScreenError("unknown ref " + n + "; call ui_tree first");
            var e = list[n - 1];
            try {
                if (OwnsPid(e.Current.ProcessId)) throw new ScreenError("that element belongs to the support window");
                Func<AutomationPattern, object> pattern = delegate(AutomationPattern p) {
                    object o; if (!e.TryGetCurrentPattern(p, out o)) throw new ScreenError("element " + n + " does not support " + verb); return o;
                };
                // if-else, not a switch on strings: the compiler would add a hash helper class named with a random GUID and break the reproducible build.
                if (verb == "invoke") { var invoke = (InvokePattern)pattern(InvokePattern.Pattern); if (!Limited(delegate { invoke.Invoke(); }, 5000)) note = "still running after 5 s; a dialog may be open"; }
                else if (verb == "set_value") ((ValuePattern)pattern(ValuePattern.Pattern)).SetValue(Wire.Text(a, "value"));
                else if (verb == "toggle") ((TogglePattern)pattern(TogglePattern.Pattern)).Toggle();
                else if (verb == "focus") e.SetFocus();
                else if (verb == "expand") ((ExpandCollapsePattern)pattern(ExpandCollapsePattern.Pattern)).Expand();
                else if (verb == "collapse") ((ExpandCollapsePattern)pattern(ExpandCollapsePattern.Pattern)).Collapse();
                else if (verb == "select") ((SelectionItemPattern)pattern(SelectionItemPattern.Pattern)).Select();
                else throw new ScreenError("verb must be invoke, set_value, toggle, focus, expand, collapse or select");
            } catch (ElementNotAvailableException) { throw new ScreenError("element " + n + " is gone; call ui_tree again"); }
            catch (InvalidOperationException x) { throw new ScreenError("element " + n + " cannot do " + verb + ": " + x.Message); }
            return note;
        }

        static void Merge(Dictionary<string, object> into, Dictionary<string, object> from) { foreach (var kv in from) into[kv.Key] = kv.Value; }
        static double Seconds(Dictionary<string, object> a) { object v; return a.TryGetValue("seconds", out v) && v != null ? Math.Max(0, Math.Min(10, Convert.ToDouble(v))) : 1; }
        // Runs one "screen" or "control" frame and returns its result. Never throws.
        // Full control: runs a capture on a fresh thread on the desktop shown now (the helper sets it), for the screenshot
        // after an input that switched the desktop. null in normal mode.
        public static Func<Func<Dictionary<string, object>>, Dictionary<string, object>> OnShown;
        public const int SettleMs = 2000;
        // The screenshot after an input. The input has happened whatever this finds: the capture follows a desktop switch
        // and is retried for SettleMs, and if it still fails the result says so in text and stays ok.
        static void Settle(Dictionary<string, object> r, View v, string before, WaitHandle stop) {
            var clock = Stopwatch.StartNew(); string reason = "the screen could not be captured";
            while (true) {
                try {
                    var onShown = OnShown;
                    Merge(r, onShown == null || InputName() == before ? Shot(v.Phys) : onShown(delegate { Dpi(); return Shot(v.Phys); }));
                    return;
                } catch (Exception e) { reason = e.Message; }
                if (clock.ElapsedMilliseconds >= SettleMs || stop.WaitOne(250)) break;
            }
            object note; r["text"] = (r.TryGetValue("text", out note) ? note + "\n" : "") + "input sent; no screenshot: " + reason;
        }
        public Dictionary<string, object> Run(Dictionary<string, object> frame, WaitHandle stop) {
            string desktop = "unknown"; bool secret = false;
            try {
                Dpi(); desktop = Desktop(); Unstick(); string startName = InputName();
                var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
                if (Wire.Text(frame, "type") == "control" || a == null) throw new ScreenError(Wire.Text(frame, "type") == "control" ? NoFull : "missing screen action");
                string name = Wire.Text(a, "name");
                secret = name == "type_secret";
                if (name == "block_input" || name == "send_sas" || name == "request_full_control") throw new ScreenError(NoFull);
                if (Array.IndexOf(new string[] { "screenshot", "zoom", "wait", "ui_tree", "ui_act", "click", "move", "drag", "scroll", "type", "type_secret", "key" }, name) < 0) throw new ScreenError("unknown screen action");
                var r = Wire.Map("ok", true);
                if (name == "wait") stop.WaitOne((int)(Seconds(a) * 1000));
                else if (desktop != "default" && !(Full && desktop == "secure")) throw new ScreenError(Full ? "cannot reach the screen right now" : "cannot reach the screen; Windows may be locked or showing a security prompt");
                // ui_tree reads the display of the foreground window and ui_act answers with the display of its ui_tree, so refs and pixels agree.
                View v = name == "wait" && !Wire.Flag(a, "screenshot") ? null : name == "ui_tree" ? ForegroundView() : name == "ui_act" ? GetViewOrPrimary(treeDisplay) : GetView(a);
                bool input = name == "click" || name == "move" || name == "drag" || name == "scroll" || name == "type" || name == "type_secret" || name == "key" || name == "ui_act";
                if (name == "screenshot" || (name == "wait" && v != null)) Merge(r, Shot(v.Phys));
                else if (name == "zoom") {
                    v.Check((int)Wire.Number(a, "x1"), (int)Wire.Number(a, "y1")); int x2 = (int)Wire.Number(a, "x2"), y2 = (int)Wire.Number(a, "y2");
                    int px1 = ScreenMath.EdgeToPhysical((int)Wire.Number(a, "x1"), v.W, v.Phys.Width), py1 = ScreenMath.EdgeToPhysical((int)Wire.Number(a, "y1"), v.H, v.Phys.Height);
                    int px2 = ScreenMath.EdgeToPhysical(x2, v.W, v.Phys.Width), py2 = ScreenMath.EdgeToPhysical(y2, v.H, v.Phys.Height);
                    if (px2 <= px1 || py2 <= py1) throw new ScreenError("zoom needs x2 > x1 and y2 > y1");
                    Merge(r, Shot(new Gdi.Rectangle(v.Phys.X + px1, v.Phys.Y + py1, px2 - px1, py2 - py1)));
                }
                else if (name == "ui_tree") r["text"] = Tree(v, (int)Math.Max(1, Math.Min(2000, a.ContainsKey("max_lines") ? Wire.Number(a, "max_lines") : 300)));
                else if (name == "ui_act") { string note = UiAct(a); if (note != null) r["text"] = note; }
                else if (name != "wait") Input(name, a, v, stop);
                if (input && (!a.ContainsKey("screenshot") || Wire.Flag(a, "screenshot"))) { Wait(stop, 300); Settle(r, v, startName, stop); }
                if (v != null) { r["display"] = v.Index; r["displays"] = v.Count; }
                r["desktop"] = input ? Desktop() : desktop; // after the input: it may have switched the desktop
                Unstick();
                return r;
            } catch (Exception e) {
                // Nothing of a secret, and no detail about where it went, can come back in an error.
                if (secret) return Wire.Map("ok", false, "error", SecretFailed);
                return Wire.Map("ok", false, "error", e is ScreenError || e is ArgumentException ? e.Message : e.GetType().Name + ": " + e.Message);
            }
        }
    }

    // What the window shows: the normal-mode Client, or the full-control service seen through its pipe (ServiceLink).
    public interface ISupportLink {
        event Action Connected; event Action<bool> LinkChanged; event Action<int> BusyChanged; event Action Finished;
        bool Paused { get; }
        bool Blocked { get; }
        DateTime ExpiresLocal { get; }
        // True when access goes on after the customer signs out or restarts, so closing the window then must not end it.
        bool SurvivesSignOut { get; }
        // True when the link finished because the session's service could not be reached, not because the session ended.
        bool Lost { get; }
        void Stop();
    }

    // The service's side of the Client in full control: screen frames go to the SYSTEM helper, commands may run as
    // the signed-in user or as SYSTEM, and the first welcome moves the service's own deadline.
    public interface IFullControl {
        string UserName { get; }
        Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop);
        // A primary token of the console user, elevated when they are an administrator, and their profile folder.
        // Throws ArgumentException with TokenChoice.NobodySignedIn when nobody is signed in.
        IntPtr UserToken(out string profile);
        void Report(Dictionary<string, object> poll, long serverOffsetMs);
        void Welcomed(long expiresAtMs);
    }

    public sealed class Client : IDisposable, ISupportLink {
        readonly Dictionary<string, object> config;
        readonly ManualResetEvent stop = new ManualResetEvent(false);
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly object gate = new object();
        readonly System.Threading.Timer deadlineTimer;
        // Raised when a lane finishes, so a parked poll ends and the result goes out at once.
        readonly AutoResetEvent signal = new AutoResetEvent(false);
        HttpWebRequest request;
        bool polling, woke;
        // The status code of the last 4xx answer the relay gave to a request, 0 if the last request had none.
        int rejected;
        long deadlineMs, generation, expiresAtMs, serverOffsetMs;
        int busy;
        string work;
        volatile Screen screen;
        // False when this run was resumed after a restart whose consent did not cover screen control. The app then
        // reports no screen cap and refuses any screen frame, so only commands and files work (see RestartResume).
        public volatile bool ScreenAllowed = true;
        // Full control (the service) when set. In normal mode CanElevate adds the "full" cap, and RequestFull runs
        // request_full_control; it returns null when the service took over, and then this client sends nothing more.
        public IFullControl Full;
        public bool CanElevate;
        public Func<Dictionary<string, object>> RequestFull;
        public string WorkRoot; // where the temporary command folder goes; the user's Temp folder when null
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
        public Client(Dictionary<string, object> cfg) : this(cfg, 7200000) { }
        // maxStartMs: the longest wait for the first connection. The service passes its own deadline, up to 24 hours.
        public Client(Dictionary<string, object> cfg, long maxStartMs) {
            config = cfg;
            // The relay sends the first-connect budget as milliseconds left when the
            // file was downloaded, so a PC clock that is wrong cannot end the client
            // at once. The absolute startup_expires_at is only a fallback for a
            // config without it. The relay enforces the same limit on its own clock.
            long remaining = cfg.ContainsKey("startup_ms") ? Wire.Number(cfg, "startup_ms") : Wire.Number(cfg, "startup_expires_at") - UnixNow();
            deadlineMs = Math.Max(0, Math.Min(maxStartMs, remaining));
            deadlineTimer = new System.Threading.Timer(delegate(object state) { if (clock.ElapsedMilliseconds >= Interlocked.Read(ref deadlineMs)) Stop(); }, null, 100, 100);
        }
        public DateTime ExpiresLocal {
            get {
                long ms = Interlocked.Read(ref expiresAtMs);
                return ms == 0 ? DateTime.MinValue : new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime();
            }
        }
        // The session's end on this PC's clock, Unix ms, 0 before the first welcome.
        public long ExpiresAtMs { get { return Interlocked.Read(ref expiresAtMs); } }
        public int BusyCount { get { return Thread.VolatileRead(ref busy); } }
        // True for 3 s after the customer last used the mouse or keyboard.
        public bool Paused { get { var s = screen; return s != null && s.Paused; } }
        public bool Blocked { get { return false; } }
        public bool SurvivesSignOut { get { return false; } }
        public bool Lost { get { return false; } }
        // One operation at a time per lane. Screen operations run while a command runs.
        sealed class Lane {
            public readonly string Name; public readonly ManualResetEvent Done = new ManualResetEvent(false);
            public Thread Op; public Dictionary<string, object> OpResult, Result; public string ActiveId = "", LastId = "";
            public bool Rejected; // the relay refused this lane's result, which was replaced by a plain error
            public Lane(string name) { Name = name; }
            public bool Busy { get { return ActiveId != ""; } }
        }
        static string LaneOf(string type) { return type == "run" || type == "put_file" || type == "get_file" ? "cmd" : type == "screen" || type == "control" ? "screen" : null; }
        public long ServerOffsetMs { get { return Interlocked.Read(ref serverOffsetMs); } }
        // Ends a parked poll, so the next poll carries a fresh report (the full-control service uses it after a change).
        public void Nudge() { Wake(); }
        void Wake() {
            signal.Set();
            lock (gate) { woke = true; if (polling && request != null) request.Abort(); }
        }
        bool Woken(bool poll) {
            lock (gate) { if (!poll || !woke || stop.WaitOne(0)) return false; woke = false; return true; }
        }
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
        // A poll that Wake ended early returns null.
        Dictionary<string, object> Send(Dictionary<string, object> body, bool ending, bool poll) {
            if (!ending && stop.WaitOne(0)) throw new OperationCanceledException();
            var req = (HttpWebRequest)WebRequest.Create(Wire.Text(config, "origin") + "/agent?sid=" + Wire.Text(config, "sid"));
            req.Method = "POST"; req.ContentType = "application/json"; req.AllowAutoRedirect = false;
            rejected = 0;
            req.Timeout = ending ? 3000 : 30000; req.ReadWriteTimeout = req.Timeout;
            req.Headers["X-Attach-Key"] = Wire.Text(config, "key");
            req.Proxy = WebRequest.DefaultWebProxy;
            byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(body)); req.ContentLength = bytes.Length;
            lock (gate) {
                if (!ending && stop.WaitOne(0)) throw new OperationCanceledException();
                if (poll && woke) { woke = false; return null; }
                request = req; polling = poll;
            }
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
                if (Woken(poll)) return null;
                var r = e.Response as HttpWebResponse;
                if (r != null) {
                    int code = (int)r.StatusCode; r.Close();
                    if (code >= 400 && code < 500) rejected = code;
                    if (code == 401 || code == 403 || code == 409 || code == 410) throw new OperationCanceledException("Support access has ended.");
                }
                throw;
            } catch (IOException) { if (Woken(poll)) return null; throw; }
            finally { lock (gate) { if (request == req) { request = null; polling = false; } } }
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
                if (type == "screen" || type == "control") {
                    if (Full != null) return Full.ScreenOp(frame, stop);
                    if (type == "control") { var request = RequestFull; return request == null ? Wire.Map("ok", false, "error", Screen.NoFull) : request(); }
                    var s = screen;
                    if (!ScreenAllowed || s == null) return Wire.Map("ok", false, "error", "the customer has not approved screen control for this session");
                    return s.Run(frame, stop);
                }
                if (type == "run") {
                    // Normal mode: every command runs as the signed-in user. Full control: as the console user (elevated
                    // when an administrator, in their session) or, with as: "system", as the service itself.
                    string runAs = Wire.Text(frame, "as");
                    if (Full == null && runAs == "system") return Wire.Map("ok", false, "error", "as: \"system\" needs full control");
                    if (runAs != "" && runAs != "user" && runAs != "system") return Wire.Map("ok", false, "error", Full == null ? "as must be user" : "as must be user or system");
                    string file = Path.Combine(work, "command-" + Guid.NewGuid().ToString("N") + ".ps1"), cwd = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    string prefix = "$ProgressPreference = 'SilentlyContinue'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n";
                    IntPtr token = IntPtr.Zero;
                    try {
                        if (Full != null && runAs != "system") token = Full.UserToken(out cwd);
                        File.WriteAllText(file, prefix + Wire.Text(frame, "command"), new UTF8Encoding(true));
                        // The work folder is SYSTEM's own. The user the command runs as may read this one script, not change it.
                        if (token != IntPtr.Zero) using (var identity = new WindowsIdentity(token)) File.SetAccessControl(file, FullAcl.Script(identity.User));
                        using (var job = new CommandJob()) return job.Run(file, cwd, (int)Math.Max(1, Math.Min(600, Wire.Number(frame, "timeout_s"))), stop, token);
                    } finally { if (token != IntPtr.Zero) Win.CloseHandle(token); try { File.Delete(file); } catch (Exception) { } }
                }
                string path = AbsolutePath(Wire.Text(frame, "path"));
                if (type == "put_file") {
                    string encoded = Wire.Text(frame, "data_b64");
                    if (encoded.Length > 700000) throw new ArgumentException("File chunk too large.");
                    byte[] data = Convert.FromBase64String(encoded);
                    // Same as the PowerShell agent: create missing parent directories (path is already validated). Full control
                    // writes as SYSTEM, so it refuses links and junctions on the way (Native.OpenPlain).
                    if (Full != null) { using (var s = Native.OpenPlain(path, true, Wire.Flag(frame, "append"))) s.Write(data, 0, data.Length); return Wire.Map("ok", true, "bytes", data.Length); }
                    string parent = Path.GetDirectoryName(path);
                    if (!String.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    using (var s = new FileStream(path, Wire.Flag(frame, "append") ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read)) s.Write(data, 0, data.Length);
                    return Wire.Map("ok", true, "bytes", data.Length);
                }
                if (type != "get_file") throw new ArgumentException("Unknown operation.");
                long offset = Math.Max(0, Wire.Number(frame, "offset"));
                int length = (int)Math.Max(1, Math.Min(524288, Wire.Number(frame, "length")));
                // FileShare.ReadWrite, like the PowerShell agent, so a log another process is writing can be read.
                using (var s = Full != null ? Native.OpenPlain(path, false, false) : new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                    s.Position = offset; byte[] data = new byte[length]; int total = 0, n;
                    while (total < length && (n = s.Read(data, total, length - total)) > 0) total += n;
                    return Wire.Map("ok", true, "data_b64", Convert.ToBase64String(data, 0, total), "size", s.Length, "eof", s.Position >= s.Length);
                }
            } catch (Exception e) { return Wire.Map("ok", false, "error", e.Message); }
        }
        // The largest request body the relay takes. A result over it, or one the relay answers with a 4xx
        // (400 invalid result, 413 too large), would be refused every time it is resent, and the client would
        // never poll again. So it is replaced once by a plain error result and the lane carries on.
        const int ResultMax = 750000;
        void RejectResult(Lane lane) {
            lane.Rejected = true;
            lane.Result = Wire.Map("type", "result", "id", lane.ActiveId, "generation", generation, "ok", false, "error", "result rejected by relay");
        }
        // Returns the relay's answer type: "ack" or "end".
        string SendResult(Lane lane) {
            while (true) {
                string json = null;
                try { json = Wire.Json().Serialize(lane.Result); } catch (InvalidOperationException) { }
                if (json == null || Encoding.UTF8.GetByteCount(json) > ResultMax) {
                    if (lane.Rejected) return "ack"; // even the plain error does not fit: drop it
                    RejectResult(lane); continue;
                }
                try { return Wire.Text(Send(lane.Result, false, false), "type"); }
                catch (WebException) {
                    // Only 400 (invalid result) and 413 (too large) say the result itself is bad. Anything else, 408 or 429
                    // for example, is a failure of the moment and takes the normal retry path.
                    if (rejected != 400 && rejected != 413) throw;
                    // The relay refused the plain error too. It always validates, so this is not expected. Drop it and
                    // carry on: the operator's call then ends with the relay's own timeout instead of hanging for ever.
                    if (lane.Rejected) return "ack";
                    RejectResult(lane);
                }
            }
        }
        public void Run() {
            var lanes = new Lane[] { new Lane("cmd"), new Lane("screen") }; string networkError = "";
            try {
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                work = Path.Combine(WorkRoot ?? Path.GetTempPath(), "remote-support-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(work, security);
                // Without screen consent there is no Screen at all: no global input hooks and no F24 probe. Execute
                // refuses screen frames, and the poll reports no pause. Full control has no Screen here: the helper does it.
                if (Full == null && ScreenAllowed) { screen = new Screen(); screen.Start(); }
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 on .NET 4.5.2
                while (!stop.WaitOne(0)) {
                    try {
                        if (generation == 0) {
                            // "full" in caps: this app can ask for full control (or has it); control: what it has now.
                            bool full = Full != null, canFull = full || (CanElevate && ScreenAllowed);
                            var welcome = Send(Wire.Map("type", "hello", "machine", Environment.MachineName, "user", full ? Full.UserName : Environment.UserName,
                                "ps", PowerShellVersion(), "agent", "windows-app-2", "elevated", full || SupportAccess.IsAdministrator(),
                                "caps", canFull ? new string[] { "screen", "uia", "lanes", "full" } : ScreenAllowed ? new string[] { "screen", "uia", "lanes" } : new string[] { "lanes" },
                                "control", full ? "full" : "normal"), false, false);
                            if (Wire.Text(welcome, "type") != "welcome") throw new InvalidDataException("Invalid support handshake.");
                            generation = Wire.Number(welcome, "generation");
                            long expires = Wire.Number(welcome, "expires_at"), now = Wire.Number(welcome, "server_time");
                            if (now == 0) now = UnixNow();
                            Interlocked.Exchange(ref serverOffsetMs, now - UnixNow()); // the relay reports deadlines on its own clock
                            long remainingMs = Math.Max(0, Math.Min(86400000, expires - now));
                            Interlocked.Exchange(ref deadlineMs, clock.ElapsedMilliseconds + remainingMs);
                            Interlocked.Exchange(ref expiresAtMs, UnixNow() + remainingMs);
                            if (full) Full.Welcomed(UnixNow() + remainingMs);
                            ShowStatus("Support session active. Close this window to end access.");
                            Print("Connected. Commands run as " + Environment.UserName + (SupportAccess.IsAdministrator() ? " with administrator rights." : " with normal user rights."));
                            var connected = Connected; if (connected != null) connected();
                        }
                        lock (gate) woke = false;
                        bool over = false;
                        foreach (var lane in lanes) {
                            if (lane.Op != null && lane.Done.WaitOne(0)) {
                                lane.Op.Join(); lane.Op = null; lane.Result = lane.OpResult;
                                if (lane.Result == null) { over = true; break; } // request_full_control handed the session to the service
                                lane.Result["type"] = "result"; lane.Result["id"] = lane.ActiveId; lane.Result["generation"] = generation;
                            }
                            if (lane.Result != null) {
                                string ack = SendResult(lane);
                                if (ack == "end") { over = true; break; }
                                if (ack != "ack") throw new InvalidDataException("Result not acknowledged.");
                                lane.LastId = lane.ActiveId; lane.ActiveId = ""; lane.Result = null; lane.Rejected = false; Work(-1);
                            }
                        }
                        if (over) break;
                        if (lanes[0].Busy && lanes[1].Busy) {
                            // The relay answers a poll at once when no lane is free, so do not spin on it. Wait
                            // for a lane and poll every 2 s. That keeps the client marked alive and notices an
                            // operator end or expiry within about 2 s.
                            if (WaitHandle.WaitAny(new WaitHandle[] { signal, stop }, 2000) == 0) continue;
                            if (stop.WaitOne(0)) break;
                        }
                        // While one lane works, keep polling for the other, so screen operations reach the
                        // client during a long command. A finishing lane ends the parked poll through Wake.
                        var busyLanes = new List<string>(); foreach (var lane in lanes) if (lane.Busy) busyLanes.Add(lane.Name);
                        var pollClock = Stopwatch.StartNew();
                        var poll = Wire.Map("type", "poll", "generation", generation, "busy", lanes[0].Busy, "busy_lanes", busyLanes);
                        if (Full != null) Full.Report(poll, serverOffsetMs);
                        else {
                            poll["desktop"] = Screen.Desktop();
                            var watching = screen; if (watching != null) poll["paused_until"] = watching.Paused ? UnixNow() + serverOffsetMs + watching.PausedForMs : (object)null;
                        }
                        var frame = Send(poll, false, true);
                        if (frame == null) continue;
                        if (networkError != "") { networkError = ""; ShowStatus("Support session active. Close this window to end access."); Print("Connection restored."); Link(true); }
                        string type = Wire.Text(frame, "type"), id = Wire.Text(frame, "id");
                        if (type == "end") break;
                        if (type == "idle") {
                            // An older relay answers a poll at once while a command runs: do not spin on it.
                            if ((lanes[0].Busy || lanes[1].Busy) && pollClock.ElapsedMilliseconds < 1000 && WaitHandle.WaitAny(new WaitHandle[] { signal, stop }, 2000) == 1) break;
                            continue;
                        }
                        string laneName = LaneOf(type); Lane target = laneName == null ? null : lanes[laneName == "cmd" ? 0 : 1];
                        if (id == "" || target == null) throw new InvalidDataException("Invalid support operation.");
                        if (target.Busy || id == target.LastId) { stop.WaitOne(1000); continue; }
                        Print(type == "run" ? "$ " + Wire.Text(frame, "command") : type == "screen" || type == "control" ? type : type + " " + Wire.Text(frame, "path"));
                        target.ActiveId = id; target.Done.Reset(); Work(1);
                        var command = frame; var running = target;
                        target.Op = new Thread(delegate() { running.OpResult = Execute(command); running.Done.Set(); Wake(); });
                        target.Op.IsBackground = true; target.Op.Start();
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
                foreach (var lane in lanes) if (lane.Op != null) lane.Op.Join(15000);
                if (EndRemote && generation != 0) { try { Send(Wire.Map("type", "end", "generation", generation), true, false); } catch { } }
                if (work != null) { try { Directory.Delete(work, true); } catch { } }
                Print(EndRemote ? "Support access stopped." : "Windows is restarting. One-time reconnect is prepared.");
                ShowStatus("Support session ended. You can close this window.");
                if (Interlocked.Exchange(ref busy, 0) > 0) { var changed = BusyChanged; if (changed != null) changed(0); }
                var finished = Finished; if (finished != null) finished();
                // The lanes' wait handles stay open: an op thread that outlived the join above may still Set one.
                if (screen != null) { var s = screen; screen = null; s.Dispose(); }
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
        // Screen control, mouse and keyboard are part of what the customer approves. A reconnect runs without a
        // prompt, so it may use them only when the prepare prompt said so. Arm records that approval under its own
        // value name; a reconnect prepared by an older app, or without it, gets commands and files only.
        static string ScreenValueName(Dictionary<string, object> cfg) { return Wire.Text(cfg, "sid") + "|screen"; }
        public static bool HasScreenConsent(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey))
                return key != null && String.Equals(key.GetValue(ScreenValueName(cfg)) as string, ConsentValue(cfg), StringComparison.Ordinal);
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
                key.SetValue(ScreenValueName(cfg), ConsentValue(cfg), Microsoft.Win32.RegistryValueKind.String);
            }
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunOnce))
                key.SetValue(ValueName(cfg), "\"" + PathFor(cfg) + "\" --resume", Microsoft.Win32.RegistryValueKind.String);
        }
        public static void Disarm(Dictionary<string, object> cfg) {
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunOnce, true))
                if (key != null) key.DeleteValue(ValueName(cfg), false);
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(ConsentKey, true))
                if (key != null) { key.DeleteValue(Wire.Text(cfg, "sid"), false); key.DeleteValue(ScreenValueName(cfg), false); }
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

    // ---- Full control -----------------------------------------------------------------------------------------
    // The customer's app elevates through UAC and runs itself with --elevate-install. That copies the exe (with its
    // session configuration) into an admin-only folder, writes the deadline, registers a backstop task and starts a
    // temporary LocalSystem service (--service). The service owns the relay connection, runs commands as the
    // signed-in user or as SYSTEM, and keeps two processes on the console session: a SYSTEM helper (--helper) that
    // runs every screen operation and so reaches the secure desktop, and the corner window as the user (--window).
    // It removes itself when the session ends or its deadline passes, and the backstop task removes it otherwise.

    static class Native {
        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint session, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr result);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, ref uint value, int length);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, out IntPtr value, int length, out int returned);
        [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeClientSessionId(SafePipeHandle pipe, out uint session);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref CommandJob.Security security);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr sd, IntPtr size);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool BlockInput(bool block);
        [DllImport("sas.dll")] static extern void SendSAS(bool asUser);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetDefaultDllDirectories(uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool MoveFileEx(string from, string to, uint flags);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ShellInfo {
            public int Size; public uint Mask; public IntPtr Window; public string Verb, File, Parameters, Directory; public int Show;
            public IntPtr InstApp, IdList; public string Class; public IntPtr ClassKey; public uint HotKey; public IntPtr Icon, Process;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ShellExecuteEx(ref ShellInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint create, uint flags, IntPtr template);
        [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes, C1, C2, A1, A2, W1, W2, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out FileInfo info);

        public static int ElevationType(IntPtr token) { int v, n; return GetTokenInformation(token, 18, out v, 4, out n) ? v : 1; }
        // The elevated half of an administrator's split token. SYSTEM, which holds SeTcbPrivilege, gets a primary token.
        public static IntPtr Linked(IntPtr token) { IntPtr v; int n; return GetTokenInformation(token, 19, out v, IntPtr.Size, out n) ? v : IntPtr.Zero; }
        public static string Profile(IntPtr token) { var b = new StringBuilder(260); int n = b.Capacity; return GetUserProfileDirectory(token, b, ref n) ? b.ToString() : Environment.SystemDirectory; }
        // This process's SYSTEM token as a primary token for another session: the helper's token on the console.
        public static IntPtr SystemTokenFor(uint session) {
            IntPtr own, dup;
            if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out own)) throw new Win32Exception();
            try { if (!DuplicateTokenEx(own, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Win32Exception(); } finally { CloseHandle(own); }
            if (!SetTokenInformation(dup, 12, ref session, 4)) { int e = Marshal.GetLastWin32Error(); CloseHandle(dup); throw new Win32Exception(e); }
            return dup;
        }
        // Starts exe on winsta0\default with a token of the console session. With a job it starts suspended and joins the
        // job before it runs a single instruction. Returns the process handle; the caller closes it.
        public static CommandJob.ProcessInfo Launch(IntPtr token, string exe, string args, bool environment, IntPtr job) {
            var si = new CommandJob.Startup { Size = Marshal.SizeOf(typeof(CommandJob.Startup)), Desktop = @"winsta0\default" };
            CommandJob.ProcessInfo pi; IntPtr env = IntPtr.Zero;
            try {
                if (environment && !CommandJob.CreateEnvironmentBlock(out env, token, false)) env = IntPtr.Zero;
                uint flags = (job != IntPtr.Zero ? 4u : 0u) | (env != IntPtr.Zero ? 0x400u : 0u);
                if (!CommandJob.CreateProcessAsUser(token, exe, new StringBuilder("\"" + exe + "\" " + args), IntPtr.Zero, IntPtr.Zero, false, flags, env, Environment.SystemDirectory, ref si, out pi)) throw new Win32Exception();
            } finally { if (env != IntPtr.Zero) CommandJob.DestroyEnvironmentBlock(env); }
            if (job != IntPtr.Zero && (!CommandJob.AssignProcessToJobObject(job, pi.Process) || CommandJob.ResumeThread(pi.Thread) == uint.MaxValue)) {
                int e = Marshal.GetLastWin32Error(); CommandJob.TerminateProcess(pi.Process, 1); CloseHandle(pi.Process); CloseHandle(pi.Thread); throw new Win32Exception(e);
            }
            CloseHandle(pi.Thread);
            return pi;
        }
        // A pipe that only the accounts in sddl can open, never from the network. first: fail when the name exists, so
        // nobody can create it before us and wait for our clients.
        public static NamedPipeServerStream PipeServer(string name, string sddl, int instances, bool first) { return PipeServer(name, sddl, instances, first, false); }
        // overlapped: reads on it can time out (Pipes.Read with ms).
        public static NamedPipeServerStream PipeServer(string name, string sddl, int instances, bool first, bool overlapped) {
            IntPtr sd;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, IntPtr.Zero)) throw new Win32Exception();
            try {
                var security = new CommandJob.Security { Size = Marshal.SizeOf(typeof(CommandJob.Security)), Descriptor = sd };
                var h = CreateNamedPipe(@"\\.\pipe\" + name, 3u | (first ? 0x80000u : 0u) | (overlapped ? 0x40000000u : 0u), 8u, (uint)instances, 65536, 65536, 0, ref security);
                if (h.IsInvalid) throw new Win32Exception();
                return new NamedPipeServerStream(PipeDirection.InOut, overlapped, false, h);
            } finally { LocalFree(sd); }
        }
        // UAC: runs exe elevated and waits for it. Returns its exit code, or -1223 when the customer said No.
        public static int RunElevated(string exe, string args, IntPtr owner) {
            var info = new ShellInfo { Size = Marshal.SizeOf(typeof(ShellInfo)), Mask = 0x40 | 0x100 | 0x400, Window = owner, Verb = "runas", File = exe, Parameters = args, Show = 1 };
            if (!ShellExecuteEx(ref info)) { int e = Marshal.GetLastWin32Error(); if (e == 1223) return -1223; throw new Win32Exception(e); }
            if (info.Process == IntPtr.Zero) throw new Win32Exception(5);
            try { CommandJob.WaitForSingleObject(info.Process, 0xFFFFFFFF); uint code; return GetExitCodeProcess(info.Process, out code) ? (int)code : -1; }
            finally { CloseHandle(info.Process); }
        }
        public static string SendSas() {
            try { SendSAS(false); return null; } catch (DllNotFoundException) { } catch (EntryPointNotFoundException) { }
            return "this version of Windows cannot send Ctrl+Alt+Del";
        }
        // The elevated installer runs from its own copy in a fresh Temp folder (Elevation.Stage). Also load DLLs from
        // System32 only after Main starts (Windows 8, or 7 with KB2533623).
        public static void SafeDllSearch() { try { SetDefaultDllDirectories(0x800); } catch (EntryPointNotFoundException) { } }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectory(string path, ref CommandJob.Security security);
        // Creates path with the security of sec in one step, and fails when anything exists there: an existing folder
        // is never adopted, so nobody can hold a handle to it from before.
        public static void CreateLocked(string path, DirectorySecurity sec) {
            var pin = GCHandle.Alloc(sec.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
            try {
                var security = new CommandJob.Security { Size = Marshal.SizeOf(typeof(CommandJob.Security)), Descriptor = pin.AddrOfPinnedObject() };
                if (!CreateDirectory(path, ref security)) throw new Win32Exception();
            } finally { pin.Free(); }
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern int GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder path, int size, int flags);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int kind, ref byte delete, int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectory(string path, IntPtr security);
        static string FinalPath(SafeFileHandle h) {
            var name = new StringBuilder(1024); int n = GetFinalPathNameByHandle(h, name, name.Capacity, 0);
            string final = n > 0 && n < name.Capacity ? name.ToString() : "";
            return final.StartsWith(@"\\?\") ? final.Substring(4) : final;
        }
        // Full control runs file operations as SYSTEM, and a user may put a junction, a link or a second hard link in a
        // path to aim SYSTEM at a protected file. So every folder of the path, from the drive down, is opened as itself
        // (never a link's target), checked to be a plain folder with exactly its own path, and held without delete
        // sharing, so nobody can rename or replace it until the file is open. A missing folder (to write) is created one
        // level at a time, each checked the same way before the next. The file itself must then have exactly the
        // requested path, be no link and (to write) have one name only. A file this call created somewhere else is
        // deleted again. 8.3 short names fail the check too; use the long path.
        public const string LinkRefused = "the path goes through a link or junction, or the file has another name; file operations as SYSTEM refuse those";
        static List<SafeFileHandle> HoldFolders(string full, bool create) {
            var held = new List<SafeFileHandle>(); var levels = new List<string>(); bool ok = false;
            for (string level = Path.GetDirectoryName(full); level != null; level = Path.GetDirectoryName(level)) levels.Insert(0, level);
            try {
                foreach (string level in levels) {
                    if (create && !Directory.Exists(level) && !File.Exists(level) && !CreateDirectory(level, IntPtr.Zero) && Marshal.GetLastWin32Error() != 183) throw new Win32Exception();
                    // FILE_READ_ATTRIBUTES; share read and write, not delete; BACKUP_SEMANTICS | OPEN_REPARSE_POINT
                    var h = CreateFile(level, 0x80, 3, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
                    if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    held.Add(h); FileInfo info;
                    if (!GetFileInformationByHandle(h, out info) || (info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0
                        || !String.Equals(FinalPath(h).TrimEnd('\\'), level.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException(LinkRefused);
                }
                ok = true; return held;
            } finally { if (!ok) foreach (var h in held) h.Dispose(); }
        }
        public static FileStream OpenPlain(string path, bool write, bool append) {
            string full = Path.GetFullPath(path);
            var held = HoldFolders(full, write);
            try {
                // write: GENERIC_WRITE, DELETE, FILE_READ_ATTRIBUTES, OPEN_ALWAYS, share read. read: GENERIC_READ, OPEN_EXISTING, share read and write.
                var h = CreateFile(full, write ? 0x40000000u | 0x10000u | 0x80u : 0x80000000u, write ? 1u : 3u, IntPtr.Zero, write ? 4u : 3u, 0x00200000, IntPtr.Zero);
                int error = Marshal.GetLastWin32Error();
                if (h.IsInvalid) throw new Win32Exception(error);
                bool created = write && error != 183, ok = false;
                try {
                    FileInfo info;
                    ok = GetFileInformationByHandle(h, out info) && (info.Attributes & 0x410) == 0 && (!write || info.Links <= 1)
                        && String.Equals(FinalPath(h), full, StringComparison.OrdinalIgnoreCase);
                    if (!ok) { if (created) { byte yes = 1; SetFileInformationByHandle(h, 4, ref yes, 1); } throw new ArgumentException(LinkRefused); }
                    var stream = new FileStream(h, write ? FileAccess.Write : FileAccess.Read);
                    if (write) { if (append) stream.Seek(0, SeekOrigin.End); else stream.SetLength(0); }
                    return stream;
                } finally { if (!ok) h.Dispose(); }
            } finally { foreach (var f in held) f.Dispose(); }
        }
    }

    // The pipes between the roles carry a 4-byte length and then UTF-8 JSON. Every message is checked before use.
    public static class Pipes {
        public const int ResultMax = 2000000;
        static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = ResultMax }; }
        public static void Write(Stream s, Dictionary<string, object> m) {
            byte[] body = Encoding.UTF8.GetBytes(Json().Serialize(m)), all = new byte[body.Length + 4];
            BitConverter.GetBytes(body.Length).CopyTo(all, 0); body.CopyTo(all, 4);
            s.Write(all, 0, all.Length); s.Flush();
        }
        public static Dictionary<string, object> Read(Stream s, int max) { return Read(s, max, 0); }
        // ms above 0: the whole message must arrive within ms (the stream must be overlapped), else TimeoutException.
        public static Dictionary<string, object> Read(Stream s, int max, int ms) {
            var clock = Stopwatch.StartNew();
            int n = BitConverter.ToInt32(Fill(s, 4, ms, clock), 0);
            if (n < 2 || n > max) throw new InvalidDataException("bad message size");
            Dictionary<string, object> m;
            try { m = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Fill(s, n, ms, clock))); }
            catch (Exception) { throw new InvalidDataException("bad message"); }
            if (m == null) throw new InvalidDataException("bad message");
            return m;
        }
        static byte[] Fill(Stream s, int n, int ms, Stopwatch clock) {
            var b = new byte[n]; int got = 0, r;
            while (got < n) {
                if (ms <= 0) r = s.Read(b, got, n - got);
                else {
                    var pending = s.BeginRead(b, got, n - got, null, null);
                    long left = ms - clock.ElapsedMilliseconds;
                    if (left <= 0 || !pending.AsyncWaitHandle.WaitOne((int)left)) throw new System.TimeoutException("the pipe client sent nothing in time");
                    r = s.EndRead(pending);
                }
                if (r <= 0) throw new EndOfStreamException();
                got += r;
            }
            return b;
        }
        // A client end that asks only for reading and writing data, and lets the server identify it but never act as it:
        // a process that took the name first must not be able to impersonate SYSTEM or the user.
        public static NamedPipeClientStream Client(string name) {
            return new NamedPipeClientStream(".", name, PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes | PipeAccessRights.Synchronize,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None);
        }
        // What a corner window may ask the service: exactly {"type":"status"} or {"type":"end"}. null for anything else.
        public static string UiRequest(Dictionary<string, object> m) {
            object t; if (m.Count != 1 || !m.TryGetValue("type", out t)) return null;
            return "status".Equals(t) || "end".Equals(t) ? (string)t : null;
        }
    }

    public static class FullAcl {
        public static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            AdminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), UsersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        // The service folder: SYSTEM and Administrators only, nothing inherited from %ProgramData%.
        public static DirectorySecurity Folder() {
            var s = new DirectorySecurity(); s.SetAccessRuleProtection(true, false);
            foreach (var who in new SecurityIdentifier[] { SystemSid, AdminsSid })
                s.AddAccessRule(new FileSystemAccessRule(who, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            return s;
        }
        static FileSecurity ForFile(SecurityIdentifier reader, FileSystemRights rights) {
            var s = new FileSecurity(); s.SetAccessRuleProtection(true, false);
            foreach (var who in new SecurityIdentifier[] { SystemSid, AdminsSid }) s.AddAccessRule(new FileSystemAccessRule(who, FileSystemRights.FullControl, AccessControlType.Allow));
            s.AddAccessRule(new FileSystemAccessRule(reader, rights, AccessControlType.Allow));
            return s;
        }
        // HKLM\SOFTWARE\SupportMCP: SYSTEM and Administrators only, inherited by its subkeys.
        public static RegistrySecurity Registry() {
            var s = new RegistrySecurity(); s.SetAccessRuleProtection(true, false);
            foreach (var who in new SecurityIdentifier[] { SystemSid, AdminsSid }) s.AddAccessRule(new RegistryAccessRule(who, RegistryRights.FullControl, InheritanceFlags.ContainerInherit, PropagationFlags.None, AccessControlType.Allow));
            return s;
        }
        // The corner window runs as the signed-in user, so its copy (which carries no session key) is readable by Users.
        public static FileSecurity Window() { return ForFile(UsersSid, FileSystemRights.ReadAndExecute); }
        // A command for as: "user" may be read, not changed, by the user it runs as.
        public static FileSecurity Script(SecurityIdentifier user) { return ForFile(user, FileSystemRights.Read); }
    }

    // state.json in the service folder: the full session id and the deadline (Unix ms on the UTC wall clock).
    public sealed class FullState {
        public const long DayMs = 86400000;
        public string Sid = "", Task = ""; public long Deadline; public bool Welcomed; public int AppPid;
        public static bool Expired(long deadline, long now) { return now >= deadline; }
        public static long Clamp(long deadline, long now) { return Math.Min(deadline, now + DayMs); }
        // The first welcome replaces connect_by with the session's expiry. A later one (after a restart) only brings it closer.
        public static long OnWelcome(long stored, bool welcomed, long sessionEnd, long now) { long d = Clamp(sessionEnd, now); return welcomed ? Math.Min(stored, d) : d; }
        public static string PathIn(string folder) { return Path.Combine(folder, "state.json"); }
        public void Save(string folder) {
            string file = PathIn(folder), temp = file + ".new";
            File.WriteAllText(temp, Wire.Json().Serialize(Wire.Map("sid", Sid, "task", Task, "deadline", Deadline, "welcomed", Welcomed, "app_pid", AppPid)));
            if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
        }
        // null when missing or damaged. The service then treats the session as over.
        public static FullState Load(string folder) {
            try {
                var m = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(PathIn(folder)));
                var st = new FullState { Sid = Wire.Text(m, "sid"), Task = Wire.Text(m, "task"), Deadline = Wire.Number(m, "deadline"), Welcomed = Wire.Flag(m, "welcomed"), AppPid = (int)Wire.Number(m, "app_pid") };
                return st.Deadline > 0 && st.Sid.Length == 64 && st.Task.StartsWith("SupportMcp-", StringComparison.Ordinal) ? st : null;
            } catch (Exception) { return null; }
        }
    }

    // SoftwareSASGeneration lets a service call SendSAS (1: services, 3: services and ease of access apps). Sessions
    // on one PC share it. Each holds a value named after its service under HoldersKey; the first that had to change
    // the value records what it found ("original": the number as text, or "absent") and what it wrote. The last holder to leave puts
    // the original back, and only when the value is still the one written, so a later change by an administrator stays.
    public static class SasShare {
        public const string PolicyKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", RootKey = @"SOFTWARE\SupportMCP", HoldersKey = RootKey + @"\SoftwareSASGeneration", Value = "SoftwareSASGeneration";
        // HKLM in the 64-bit view: this is an x86 process, and these keys must not land under Wow6432Node.
        public static Microsoft.Win32.RegistryKey Machine() { return Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64); }
        public static bool Needed(int value) { return value != 1 && value != 3; }
        public static int Wanted(int value) { return value == 2 ? 3 : 1; }
        static int Read(Microsoft.Win32.RegistryKey k, string name) { object v = k == null ? null : k.GetValue(name); return v is int ? (int)v : -1; }
        const Microsoft.Win32.RegistryValueKind Dword = Microsoft.Win32.RegistryValueKind.DWord;
        // Installs, services and backstop tasks of different sessions change the record at the same time: one machine-wide
        // mutex orders them (only administrators and services may create Global objects). The tests use a Local one.
        // Nothing touches the record without the mutex. When another process still holds it after WaitMs, the work is
        // skipped and the caller gets false: a skipped install shares nothing (send_sas then says Windows refuses it), and
        // a skipped release keeps this session's entry and its backstop task, which releases it at the deadline.
        public static string MutexName = @"Global\SupportMcp-Sas";
        public const string Refused = "Windows does not let this session send Ctrl+Alt+Del (SoftwareSASGeneration); ask the customer to press it";
        public static int WaitMs = 30000;
        static bool Locked(Action work) {
            using (var m = new Mutex(false, MutexName)) {
                bool own;
                try { own = m.WaitOne(WaitMs); } catch (AbandonedMutexException) { own = true; }
                if (!own) return false;
                try { work(); } finally { m.ReleaseMutex(); }
                return true;
            }
        }
        // False: the mutex was busy and nothing was changed.
        public static bool Acquire(Microsoft.Win32.RegistryKey root, string holder) { return Locked(delegate { AcquireLocked(root, holder); }); }
        public static bool Release(Microsoft.Win32.RegistryKey root, string holder) { return Locked(delegate { ReleaseLocked(root, holder); }); }
        // Whether Windows lets a service send Ctrl+Alt+Del now.
        public static bool Allowed(Microsoft.Win32.RegistryKey root) { using (var policy = root.OpenSubKey(PolicyKey)) return !Needed(Read(policy, Value)); }
        static void AcquireLocked(Microsoft.Win32.RegistryKey root, string holder) {
            using (var top = root.CreateSubKey(RootKey)) if (root.Name == "HKEY_LOCAL_MACHINE") top.SetAccessControl(FullAcl.Registry());
            using (var policy = root.CreateSubKey(PolicyKey)) using (var holders = root.CreateSubKey(HoldersKey)) {
                holders.SetValue(holder, 1, Dword); // first, so a crash after the change below still puts it back
                int current = Read(policy, Value); object written = holders.GetValue("written");
                if (written is int && current == (int)written) return; // another session changed it already
                holders.DeleteValue("written", false); holders.DeleteValue("original", false);
                if (!Needed(current)) return; // services may already send SAS: nothing to change or restore
                holders.SetValue("original", current < 0 ? "absent" : current.ToString(System.Globalization.CultureInfo.InvariantCulture), Microsoft.Win32.RegistryValueKind.String);
                holders.SetValue("written", Wanted(current), Dword);
                policy.SetValue(Value, Wanted(current), Dword);
            }
        }
        static void ReleaseLocked(Microsoft.Win32.RegistryKey root, string holder) {
            using (var holders = root.OpenSubKey(HoldersKey, true)) {
                if (holders == null) return;
                holders.DeleteValue(holder, false);
                foreach (string name in holders.GetValueNames()) if (name.StartsWith("SupportMcp-", StringComparison.Ordinal)) return; // still needed
                string original = holders.GetValue("original") as string; object written = holders.GetValue("written"); int number;
                if (original != null && written is int)
                    using (var policy = root.OpenSubKey(PolicyKey, true))
                        if (policy != null && Read(policy, Value) == (int)written) {
                            if (original == "absent") policy.DeleteValue(Value, false);
                            else if (int.TryParse(original, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out number)) policy.SetValue(Value, number, Dword);
                        }
            }
            root.DeleteSubKey(HoldersKey, false);
            bool empty; using (var top = root.OpenSubKey(RootKey)) empty = top != null && top.SubKeyCount == 0 && top.ValueCount == 0;
            if (empty) root.DeleteSubKey(RootKey, false);
        }
        // The same release in PowerShell for the backstop task, which must not run the app. psRoot is "HKLM:" there.
        // Without the mutex it changes nothing and exits with 1; the holder's entry stays, so the task does not delete
        // itself and runs again an hour later (see Backstop.Xml).
        public static string ReleaseScript(string psRoot, string holder) { return ReleaseScript(psRoot, holder, MutexName); }
        public static string ReleaseScript(string psRoot, string holder, string mutex) {
            string r = psRoot + "\\" + RootKey, k = psRoot + "\\" + HoldersKey, p = psRoot + "\\" + PolicyKey;
            return "$m = New-Object System.Threading.Mutex($false, '" + mutex + "'); $own = $false; try { try { $own = $m.WaitOne(" + WaitMs.ToString(System.Globalization.CultureInfo.InvariantCulture) + ") } catch [System.Threading.AbandonedMutexException] { $own = $true }; " +
                "if ($own) { $r='" + r + "'; $k='" + k + "'; $p='" + p + "'; if (Test-Path $k) { Remove-ItemProperty -Path $k -Name '" + holder + "' -ErrorAction SilentlyContinue; " +
                "$v = Get-ItemProperty -Path $k; if (@($v.PSObject.Properties | Where-Object { $_.Name -like 'SupportMcp-*' }).Count -eq 0) { " +
                "$c = (Get-ItemProperty -Path $p -ErrorAction SilentlyContinue).SoftwareSASGeneration; " +
                "if ($v.written -ne $null -and $v.original -ne $null -and $c -eq $v.written) { if ($v.original -eq 'absent') { Remove-ItemProperty -Path $p -Name SoftwareSASGeneration } elseif ($v.original -match '^[0-9]+$') { Set-ItemProperty -Path $p -Name SoftwareSASGeneration -Value ([int]$v.original) -Type DWord } }; " +
                "Remove-Item -Path $k; $g = Get-Item -Path $r; if ($g.SubKeyCount -eq 0 -and $g.ValueCount -eq 0) { Remove-Item -Path $r } } } } } finally { if ($own) { $m.ReleaseMutex() }; $m.Close() }; if (-not $own) { exit 1 }";
        }
    }

    public enum RunAs { System, User, ElevatedUser, Nobody }
    public static class TokenChoice {
        public const string NobodySignedIn = "nobody is signed in; use as: \"system\"";
        // elevationType of the console user's token: 3 is an administrator's filtered token, whose linked token is elevated.
        public static RunAs Pick(bool system, bool signedIn, int elevationType) { return system ? RunAs.System : !signedIn ? RunAs.Nobody : elevationType == 3 ? RunAs.ElevatedUser : RunAs.User; }
    }

    // block_input lasts 1 to 10 minutes. It ends when the time is up, when the operator turns it off, or when the
    // customer presses Ctrl+Alt+Del: Windows lifts the block and switches to the secure desktop. It then stays off
    // until the operator calls on again.
    public sealed class BlockTimer {
        long until;
        public bool Escaped { get; private set; }
        public void Arm(long now, long minutes) { until = now + Math.Max(1, Math.Min(10, minutes)) * 60000L; Escaped = false; }
        public void Off() { until = 0; }
        public bool On(long now) { return until > now; }
        public long RemainingMs(long now) { return Math.Max(0, until - now); }
        // While the block is held. False means lift it now: the time is up, or Windows already lifted it.
        public bool Check(long now, bool sameDesktop, bool stillBlocked) {
            if (until == 0) return false;
            if (!sameDesktop || !stillBlocked) { until = 0; Escaped = true; return false; }
            if (now >= until) { until = 0; return false; }
            return true;
        }
    }

    static class Shell {
        public static string Output(string tool, string args) {
            using (var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, tool), args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, WorkingDirectory = Environment.SystemDirectory })) {
                string text = p.StandardOutput.ReadToEnd(); p.WaitForExit(60000); return text;
            }
        }
        // Runs a Windows tool hidden. Returns its exit code, or -1 when it did not finish within a minute.
        public static int Run(string tool, string args) {
            using (var p = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, tool), args) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory })) {
                if (!p.WaitForExit(60000)) { try { p.Kill(); } catch (Exception) { } return -1; }
                return p.ExitCode;
            }
        }
    }

    // The backstop: a SYSTEM scheduled task at the deadline that removes the service, its share of the registry value
    // and the folder, then itself, in that order. It runs cmd and PowerShell, never agent.exe, which antivirus may have
    // deleted. The service moves it from connect_by to the session's expiry at the first welcome.
    public static class Backstop {
        public static string Name(string sid8) { return "SupportMcp-" + sid8; }
        // Each install's task has a name of its own, so the late self-delete of an earlier install's task, or of its
        // service's cleanup, can never remove the task of a later install of the same session.
        public static string NewTask(string sid8) { return Name(sid8) + "-" + Guid.NewGuid().ToString("N").Substring(0, 8); }
        // Full paths, from the 64-bit System32 (Task Scheduler resolves them without this process's redirection; the
        // service's own cmd is 32-bit and gets SysWOW64, which has the same tools). No spaces, so no quotes in cmd lines.
        public static string System32(string tool) { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"System32\" + tool); }
        // cmd: delete the folder, retrying while a closing window still holds window.exe.
        public static string RemoveFolder(string folder) {
            return "(for /l %i in (1,1,20) do @(if exist \"" + folder + "\" (rd /s /q \"" + folder + "\" 2>nul & if exist \"" + folder + "\" " + System32("PING.EXE") + " -n 3 127.0.0.1 >nul)))";
        }
        public static string DeleteTask(string task) { return System32("schtasks.exe") + " /delete /tn \"" + task + "\" /f"; }
        // cmd: delete the task only once the session has no entry left in the SoftwareSASGeneration record. An entry
        // stays when the release could not take the mutex; the task then runs again an hour later (Xml).
        public static string DeleteTaskWhenReleased(string sid8, string task) {
            return "(" + System32("reg.exe") + " query \"HKLM\\" + SasShare.HoldersKey + "\" /v \"" + Name(sid8) + "\" /reg:64 >nul 2>&1 || " + DeleteTask(task) + ")";
        }
        // The actions in order, as command and arguments.
        public static string[][] Actions(string sid8, string folder, string task) {
            string name = Name(sid8), sc = System32("sc.exe");
            return new string[][] {
                new string[] { System32("cmd.exe"), "/c " + sc + " stop \"" + name + "\" & " + System32("PING.EXE") + " -n 6 127.0.0.1 >nul & " + System32("taskkill.exe") + " /f /fi \"SERVICES eq " + name + "\" & " + sc + " delete \"" + name + "\"" },
                new string[] { System32(@"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript("HKLM:", name) + "\"" },
                new string[] { System32("cmd.exe"), "/c " + RemoveFolder(folder) + " & " + DeleteTaskWhenReleased(sid8, task) } };
        }
        public static string Xml(string[][] actions, long deadline) {
            // Whole seconds in UTC, rounded up, so the task never fires before the deadline.
            string at = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(deadline + 999).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture);
            var exec = new StringBuilder();
            foreach (string[] a in actions) exec.Append("<Exec><Command>" + System.Security.SecurityElement.Escape(a[0]) + "</Command><Arguments>" + System.Security.SecurityElement.Escape(a[1]) + "</Arguments></Exec>");
            return "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
                "<RegistrationInfo><Description>Removes a remote support session at its deadline if it is still installed.</Description></RegistrationInfo>" +
                "<Triggers><TimeTrigger><Repetition><Interval>PT1H</Interval></Repetition><StartBoundary>" + at + "</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>" +
                "<Principals><Principal id=\"System\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
                "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>" +
                "<Actions Context=\"System\">" + exec + "</Actions></Task>";
        }
        // The XML goes into the session folder, which only SYSTEM and Administrators can write and which was created
        // fresh by this install, so nobody else can change it before schtasks reads it.
        public static void Register(string sid8, string folder, FullState state) {
            string xml = Path.Combine(folder, "backstop.xml");
            File.WriteAllText(xml, Xml(Actions(sid8, folder, state.Task), state.Deadline), Encoding.Unicode);
            try { if (Shell.Run("schtasks.exe", "/create /tn \"" + state.Task + "\" /xml \"" + xml + "\" /f") != 0) throw new IOException("cannot register the backstop task"); }
            finally { File.Delete(xml); }
        }
        public static void Delete(string task) { Shell.Run("schtasks.exe", "/delete /tn \"" + task + "\" /f"); }
        // The tasks of every install of this session that are still registered.
        public static List<string> Tasks(string sid8) {
            var found = new List<string>(); string prefix = "\"\\" + Name(sid8) + "-";
            foreach (string line in Shell.Output("schtasks.exe", "/query /fo csv /nh").Split('\n'))
                if (line.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { string name = line.Substring(2, line.IndexOf('"', 2) - 2); if (!found.Contains(name)) found.Add(name); }
            return found;
        }
        // Runs the tasks of a leftover install and waits, at most 90 s, until each has deleted itself.
        public static void RunAndWait(string sid8) {
            foreach (string task in Tasks(sid8)) Shell.Run("schtasks.exe", "/run /tn \"" + task + "\"");
            var clock = Stopwatch.StartNew();
            while (Tasks(sid8).Count > 0 && clock.ElapsedMilliseconds < 90000) Thread.Sleep(2000);
        }
    }

    static class Scm {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateService(IntPtr scm, string name, string display, uint access, uint type, uint start, uint error, string path, string group, IntPtr tag, string dependencies, string account, string password);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenService(IntPtr scm, string name, uint access);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DeleteService(IntPtr service);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool CloseServiceHandle(IntPtr h);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Description { public string Text; }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ChangeServiceConfig2(IntPtr service, uint level, ref Description info);
        // Own process, auto start, LocalSystem.
        public static void Create(string name, string binary) {
            IntPtr scm = OpenSCManager(null, null, 0x0003); if (scm == IntPtr.Zero) throw new Win32Exception();
            try {
                IntPtr s = CreateService(scm, name, "Remote support session", 0xF01FF, 0x10, 2, 1, binary, null, IntPtr.Zero, null, null, null);
                if (s == IntPtr.Zero) throw new Win32Exception();
                var d = new Description { Text = "Gives remote support full control of this PC for one session, and removes itself when the session ends." };
                ChangeServiceConfig2(s, 1, ref d); CloseServiceHandle(s);
            } finally { CloseServiceHandle(scm); }
        }
        public static ServiceControllerStatus? Status(string name) { try { using (var c = new ServiceController(name)) return c.Status; } catch (InvalidOperationException) { return null; } }
        public static void Start(string name) { using (var c = new ServiceController(name)) { c.Start(); c.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30)); } }
        // Stops and deletes a service that is not this process.
        public static void Remove(string name) {
            try { using (var c = new ServiceController(name)) if (c.Status != ServiceControllerStatus.Stopped) { c.Stop(); c.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30)); } } catch (Exception) { }
            Delete(name);
        }
        // Marks it for deletion; a running service goes when it stops.
        public static void Delete(string name) {
            IntPtr scm = OpenSCManager(null, null, 0x0001); if (scm == IntPtr.Zero) return;
            try { IntPtr s = OpenService(scm, name, 0x10000); if (s != IntPtr.Zero) { DeleteService(s); CloseServiceHandle(s); } } finally { CloseServiceHandle(scm); }
        }
    }

    // --elevate-install and every cleanup that runs outside the service.
    public static class FullInstall {
        // %ProgramFiles%, from HKLM in the 64-bit view, not from an environment variable the user could set for the
        // elevated process. Users may not create, rename or delete anything in it.
        public static string Root {
            get {
                using (var hklm = SasShare.Machine()) using (var k = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion"))
                    return Convert.ToString(k.GetValue("ProgramFilesDir"));
            }
        }
        public static string Sid8(Dictionary<string, object> cfg) { return Wire.Text(cfg, "sid").Substring(0, 8); }
        public static string Folder(string sid8) { return Path.Combine(Root, "SupportMCP-" + sid8); }
        // The elevated installer reads its own exe once, through a handle that lets nobody write, rename or delete it
        // while the install runs, and takes the bytes and the configuration from that one read.
        public static byte[] ReadSelf(string exe, out FileStream held) {
            held = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.Read);
            var all = new byte[held.Length]; int got = 0, n;
            while (got < all.Length && (n = held.Read(all, got, all.Length - got)) > 0) got += n;
            if (got != all.Length) throw new IOException("short read");
            return all;
        }
        // --elevate-install <deadline, Unix ms> <1 when the session is already connected>. Exit code 0: installed and
        // running. Anything else: nothing of this install is left.
        public static int Install(byte[] self, Dictionary<string, object> cfg, string[] args) {
            long now = Client.UnixNow(), deadline;
            int appPid;
            if (args.Length != 4 || !long.TryParse(args[1], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out deadline) || deadline <= now
                || !int.TryParse(args[3], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out appPid)) return 2;
            string sid = Wire.Text(cfg, "sid"), sid8 = Sid8(cfg), name = Backstop.Name(sid8), folder = Folder(sid8);
            if (!System.Text.RegularExpressions.Regex.IsMatch(folder, @"^[A-Za-z]:\\[^%&|<>^""]+$")) return 2; // it goes into cmd lines
            var status = Scm.Status(name);
            if (status != null || Directory.Exists(folder) || File.Exists(folder) || Backstop.Tasks(sid8).Count > 0) {
                // A leftover (a crash in the middle of an install) or a running service. Only this session's is touched:
                // another session whose id starts with the same 8 characters is never adopted or removed.
                var old = FullState.Load(folder);
                if (old != null ? old.Sid != sid : status != null) return 3;
                if (status == ServiceControllerStatus.Running) return 0; // this session has full control already
                // No record to clean up with: the backstop tasks do it, and are waited for so they cannot delete anything new.
                if (old == null) Backstop.RunAndWait(sid8);
                Remove(sid8);
                if (Backstop.Tasks(sid8).Count > 0 || Directory.Exists(folder)) return 3;
            }
            try { Native.CreateLocked(folder, LockedFolder()); } catch (Exception) { return 1; } // not ours: leave it alone
            var state = new FullState { Sid = sid, Task = Backstop.NewTask(sid8), Deadline = FullState.Clamp(deadline, now), Welcomed = args[2] == "1", AppPid = appPid };
            try {
                File.WriteAllBytes(Path.Combine(folder, "agent.exe"), self);
                string window = Path.Combine(folder, "window.exe");
                using (var f = new FileStream(window, FileMode.CreateNew)) f.Write(self, 0, Wire.Payload(self));
                File.SetAccessControl(window, FullAcl.Window());
                state.Save(folder);
                Backstop.Register(sid8, folder, state); // before the registry share, so the backstop covers it from the start
                // False when the mutex stayed busy: full control still works, and send_sas says that Windows refuses it.
                using (var hklm = SasShare.Machine()) SasShare.Acquire(hklm, name);
                Scm.Create(name, "\"" + Path.Combine(folder, "agent.exe") + "\" --service");
                Scm.Start(name);
                return 0;
            } catch (Exception) { Remove(sid8); return 1; }
        }
        // The service folder: created by an elevated administrator, owned by Administrators.
        static DirectorySecurity LockedFolder() { var s = FullAcl.Folder(); s.SetOwner(FullAcl.AdminsSid); return s; }
        // Layer 1 from outside the service (a failed install, a leftover of this session): the service, the registry
        // share, the folder, and the backstop task last.
        public static void Remove(string sid8) {
            string folder = Folder(sid8);
            Scm.Remove(Backstop.Name(sid8));
            bool released = false;
            try { using (var hklm = SasShare.Machine()) released = SasShare.Release(hklm, Backstop.Name(sid8)); } catch (Exception) { }
            try { if (Directory.Exists(folder)) Directory.Delete(folder, true); else if (File.Exists(folder)) File.Delete(folder); } catch (Exception) { }
            // A share that was not released keeps its backstop task, which releases it at the deadline.
            if (released) foreach (string task in Backstop.Tasks(sid8)) Backstop.Delete(task);
        }
        // A running exe cannot delete itself: a detached cmd removes the folder after the service has exited, then the
        // backstop task, last. When cmd cannot start, Windows deletes the files at the next restart and the task stays
        // as the backstop it is.
        public static void RemoveLater(IList<string> tasks, string folder) {
            try {
                string line = "/c " + Backstop.System32("PING.EXE") + " -n 3 127.0.0.1 >nul & " + Backstop.RemoveFolder(folder);
                foreach (string task in tasks) line += " & " + Backstop.DeleteTask(task);
                using (Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), line) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory })) { }
            } catch (Exception) {
                try { foreach (string f in Directory.GetFiles(folder)) Native.MoveFileEx(f, null, 4); Native.MoveFileEx(folder, null, 4); } catch (Exception) { }
            }
        }
    }

    // The customer's side of --elevate-install.
    public static class Elevation {
        public const int Installed = 0, Declined = 1, Failed = 2;
        // The elevated child runs from a copy in a new folder of its own under the user's Temp, so nothing that sits
        // next to the download (an .exe.config, a DLL) is loaded by the elevated process. The caller deletes the folder.
        public static string Stage(string exe) {
            string dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")), copy = Path.Combine(dir, Path.GetFileName(exe));
            Directory.CreateDirectory(dir); File.Copy(exe, copy); return copy;
        }
        // UAC, then wait for the install. On a fresh STA thread, as ShellExecuteEx wants.
        public static int Install(string exe, long deadline, bool connected, IntPtr owner) {
            int outcome = Failed;
            var t = new Thread(delegate() {
                string staged = null;
                try {
                    staged = Stage(exe);
                    // The last argument is this process: the corner window until the service starts one, which the helper must not click.
                    int code = Native.RunElevated(staged, "--elevate-install " + deadline.ToString(System.Globalization.CultureInfo.InvariantCulture) + (connected ? " 1 " : " 0 ")
                        + Process.GetCurrentProcess().Id.ToString(System.Globalization.CultureInfo.InvariantCulture), owner);
                    outcome = code == 0 ? Installed : code == -1223 ? Declined : Failed;
                } catch (Exception) { outcome = Failed; }
                finally { if (staged != null) try { Directory.Delete(Path.GetDirectoryName(staged), true); } catch (Exception) { } }
            });
            t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
            return outcome;
        }
    }

    // The service's side of the SYSTEM helper on the console session. It starts the helper again when the console
    // session changes or the helper exits, keeps it in a kill-on-close Job so it dies with the service, and talks to
    // it over two pipes the helper serves (operations, status). Each end checks the other's process id. A Job takes
    // the session of its first process and refuses any other, so every helper gets a Job of its own.
    sealed class HelperHost {
        readonly string exe, sid8; IntPtr job;
        readonly object gate = new object(), opGate = new object();
        IntPtr process; int pid; uint session = 0xFFFFFFFF; long started;
        NamedPipeClientStream op, status;
        volatile Dictionary<string, object> last; long lastAt = long.MinValue / 2;
        public HelperHost(string exe, string sid8) {
            this.exe = exe; this.sid8 = sid8;
            var t = new Thread(Poll); t.IsBackground = true; t.Start();
        }
        public void Ensure() {
            uint s = Native.WTSGetActiveConsoleSessionId(); long now = PauseClock.Now();
            lock (gate) {
                bool alive = process != IntPtr.Zero && CommandJob.WaitForSingleObject(process, 0) != 0;
                if (alive && s == session && (now - Interlocked.Read(ref lastAt) < 15000 || now - started < 15000)) return;
                Kill();
                if (s == 0xFFFFFFFF) return;
                IntPtr token = Native.SystemTokenFor(s);
                try { job = CommandJob.KillOnClose(); var pi = Native.Launch(token, exe, "--helper " + Process.GetCurrentProcess().Id, false, job); process = pi.Process; pid = pi.Id; session = s; started = now; }
                finally { Native.CloseHandle(token); }
                try { string name = Backstop.Name(sid8) + "-h" + pid; op = Connect(name + "-op"); status = Connect(name + "-st"); }
                catch (Exception) { Kill(); }
            }
        }
        NamedPipeClientStream Connect(string name) {
            var c = Pipes.Client(name);
            try {
                c.Connect(15000); uint server;
                if (!Native.GetNamedPipeServerProcessId(c.SafePipeHandle, out server) || server != pid) throw new IOException("unexpected pipe server");
                return c;
            } catch (Exception) { c.Dispose(); throw; }
        }
        void Kill() { // the caller holds gate
            if (process != IntPtr.Zero) { CommandJob.TerminateProcess(process, 1); Native.CloseHandle(process); process = IntPtr.Zero; }
            if (job != IntPtr.Zero) { Native.CloseHandle(job); job = IntPtr.Zero; }
            if (op != null) { op.Dispose(); op = null; }
            if (status != null) { status.Dispose(); status = null; }
            session = 0xFFFFFFFF; last = null;
        }
        public void Stop() { lock (gate) Kill(); }
        public Dictionary<string, object> Op(Dictionary<string, object> frame) {
            NamedPipeClientStream pipe; IntPtr proc;
            lock (gate) { pipe = op; proc = process; }
            if (pipe == null) { try { Ensure(); } catch (Exception) { } lock (gate) { pipe = op; proc = process; } }
            if (pipe == null) return Wire.Map("ok", false, "error", "the screen cannot be reached right now; try again in a few seconds");
            lock (opGate) {
                // A helper that hangs is stopped, so the lane does not wait for ever. Supervise starts a new one.
                var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
                int limit = 40000 + (a == null ? 0 : Wire.Text(a, "text").Length * 60 + (int)Wire.Number(a, "seconds") * 1000);
                using (new System.Threading.Timer(delegate { lock (gate) if (process == proc) Kill(); }, null, limit, Timeout.Infinite)) {
                    try { Pipes.Write(pipe, frame); return Pipes.Read(pipe, Pipes.ResultMax); }
                    catch (Exception) { lock (gate) if (process == proc) Kill(); return Wire.Map("ok", false, "error", "the screen helper stopped; try again"); }
                }
            }
        }
        void Poll() { while (true) { Thread.Sleep(500); PollNow(); } }
        readonly object pollGate = new object();
        // Raised when the desktop or the block changed, so the service reports it to the relay at once.
        public event Action Changed;
        public void PollNow() {
            NamedPipeClientStream pipe; lock (gate) pipe = status;
            if (pipe == null) return;
            Dictionary<string, object> before = last, now;
            lock (pollGate) {
                try { Pipes.Write(pipe, Wire.Map("type", "status")); now = Pipes.Read(pipe, 4096, 5000); } catch (Exception) { return; }
                last = now; Interlocked.Exchange(ref lastAt, PauseClock.Now());
            }
            var changed = Changed;
            if (changed != null && (before == null || Wire.Text(before, "desktop") != Wire.Text(now, "desktop") || (Wire.Number(before, "blocked_ms") > 0) != (Wire.Number(now, "blocked_ms") > 0))) changed();
        }
        // The helper's status if it is under 3 s old: desktop, paused_ms, blocked_ms.
        public Dictionary<string, object> Status { get { var s = last; return s != null && PauseClock.Now() - Interlocked.Read(ref lastAt) < 3000 ? s : null; } }
    }

    // block_input in the helper. Only the thread that blocked input may inject input while the block lasts, and only
    // it can lift it, so one thread holds the block and runs every screen operation until it ends.
    sealed class Blocker {
        sealed class Work { public Func<Dictionary<string, object>> Run; public Dictionary<string, object> Result; public bool Ran; public readonly ManualResetEvent Done = new ManualResetEvent(false); }
        readonly BlockTimer timer = new BlockTimer(); readonly object gate = new object(); readonly Queue<Work> queue = new Queue<Work>(); readonly AutoResetEvent wake = new AutoResetEvent(false);
        Thread thread; IntPtr held; string desktop, startError; volatile bool active, off;
        public bool Active { get { return active; } }
        public long RemainingMs { get { lock (gate) return active ? timer.RemainingMs(PauseClock.Now()) : 0; } }
        public Dictionary<string, object> Set(bool on, long minutes) {
            long m = Math.Max(1, Math.Min(10, minutes));
            if (!on) { Lift(); return Wire.Map("ok", true, "text", "input is not blocked", "desktop", Screen.Desktop()); }
            lock (gate) if (active) { timer.Arm(PauseClock.Now(), m); return Wire.Map("ok", true, "text", "input stays blocked for " + m + " minutes", "desktop", Screen.Desktop()); }
            Lift();
            var ready = new ManualResetEvent(false); off = false; startError = null;
            thread = new Thread(delegate() { Hold(m, ready); }); thread.IsBackground = true; thread.Start();
            ready.WaitOne(5000);
            lock (gate) if (!active) return Wire.Map("ok", false, "error", startError ?? "Windows refused to block input");
            return Wire.Map("ok", true, "text", "input is blocked for " + m + " minutes", "desktop", Screen.Desktop());
        }
        void Lift() {
            off = true; wake.Set();
            var t = thread; if (t != null && t.Join(10000)) { thread = null; if (held != IntPtr.Zero) { Win.CloseDesktop(held); held = IntPtr.Zero; } }
        }
        void Hold(long minutes, ManualResetEvent ready) {
            held = Win.OpenInputDesktop(0, false, 0x10000000);
            try {
                if (held == IntPtr.Zero || !Win.SetThreadDesktop(held) || !Native.BlockInput(true)) { startError = "Windows refused to block input"; return; }
                lock (gate) { timer.Arm(PauseClock.Now(), minutes); desktop = Screen.DesktopName(held); active = true; }
                ready.Set();
                while (Keep()) {
                    Work w = null; lock (gate) if (queue.Count > 0) w = queue.Dequeue();
                    if (w == null) { wake.WaitOne(50); continue; }
                    w.Result = w.Run(); w.Ran = true; w.Done.Set();
                }
            } finally {
                Native.BlockInput(false);
                lock (gate) { active = false; while (queue.Count > 0) queue.Dequeue().Done.Set(); }
                ready.Set();
            }
        }
        // On the block thread: lifts the block when it must end. Ctrl+Alt+Del shows as a desktop switch, or as a
        // BlockInput(TRUE) that succeeds, because it fails while input is still blocked.
        bool Keep() {
            if (Thread.CurrentThread != thread || !active) return active;
            bool same = Screen.InputName() == desktop, still = same && !Native.BlockInput(true);
            if (same && !still) Native.BlockInput(false); // the probe blocked again after Windows had lifted it: undo that
            bool keep;
            lock (gate) { if (off) timer.Off(); keep = timer.Check(PauseClock.Now(), same, still); if (!keep) active = false; }
            if (!keep) Native.BlockInput(false);
            return keep;
        }
        // Screen.Step: between the steps of a long input on the block thread.
        public void Check() { Keep(); }
        // Runs work on the block thread while input is blocked. null when no block is held: the caller runs it.
        public Dictionary<string, object> Invoke(Func<Dictionary<string, object>> run) {
            var w = new Work { Run = run };
            lock (gate) { if (!active) return null; queue.Enqueue(w); }
            wake.Set(); w.Done.WaitOne();
            return w.Ran ? w.Result : null;
        }
        public void Stop() { Lift(); }
    }

    // --helper <service pid>: SYSTEM on the console session. It serves two pipes that only that service may open and
    // runs every screen operation on a thread that has switched to the input desktop (Default, or Winlogon for UAC,
    // the lock screen and the sign-in screen). It exits when the service goes away.
    public static class Helper {
        const string Sddl = "D:P(A;;GA;;;SY)";
        public static void Run(string exe, string[] args) {
            int service; if (args.Length != 2 || !int.TryParse(args[1], out service)) return;
            string name = Backstop.Name(FullInstall.Sid8(Wire.ReadConfig(exe))) + "-h" + Process.GetCurrentProcess().Id;
            Screen.Full = true; Screen.OnShown = delegate(Func<Dictionary<string, object>> f) { return OnInputDesktop(f); };
            var screen = new Screen(); var blocker = new Blocker();
            screen.Blocked = delegate { return blocker.Active; }; screen.Step = blocker.Check;
            NamedPipeServerStream op = Native.PipeServer(name + "-op", Sddl, 1, true), st = Native.PipeServer(name + "-st", Sddl, 1, true);
            using (new System.Threading.Timer(delegate { Environment.Exit(1); }, null, 20000, Timeout.Infinite)) { Accept(op, service); Accept(st, service); }
            var gone = new ManualResetEvent(false);
            var status = new Thread(delegate() {
                try {
                    while (Wire.Text(Pipes.Read(st, 1024), "type") == "status") {
                        Dictionary<string, object> r;
                        try { r = OnInputDesktop(delegate { screen.Rearm(); Screen.Unstick(); long b = blocker.RemainingMs; return Wire.Map("desktop", Screen.Desktop(), "paused_ms", b > 0 ? 0 : screen.PausedForMs, "blocked_ms", b); }); }
                        catch (Exception) { r = Wire.Map("desktop", Screen.Desktop(), "paused_ms", 0, "blocked_ms", blocker.RemainingMs); } // reading the name needs no switch
                        Pipes.Write(st, r);
                    }
                } catch (Exception) { }
                gone.Set(); blocker.Stop(); Environment.Exit(0);
            });
            status.IsBackground = true; status.Start();
            try { while (true) Pipes.Write(op, Dispatch(Pipes.Read(op, 1 << 20), screen, blocker, gone)); } catch (Exception) { }
            gone.Set(); blocker.Stop(); Environment.Exit(0);
        }
        static void Accept(NamedPipeServerStream pipe, int service) {
            pipe.WaitForConnection(); uint pid;
            if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || pid != service) Environment.Exit(1);
        }
        static Dictionary<string, object> Dispatch(Dictionary<string, object> frame, Screen screen, Blocker blocker, WaitHandle stop) {
            var pids = new List<int>(); object list;
            if (frame.TryGetValue("own_pids", out list) && list is System.Collections.ArrayList) foreach (object o in (System.Collections.ArrayList)list) if (o is int) pids.Add((int)o);
            Screen.OwnPids = pids.ToArray();
            var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
            if (a != null && Wire.Text(a, "name") == "block_input") return blocker.Set(Wire.Flag(a, "on"), a.ContainsKey("minutes") ? Wire.Number(a, "minutes") : 10);
            return blocker.Invoke(delegate { return screen.Run(frame, stop); }) ?? OnInputDesktop(delegate { screen.Rearm(); return screen.Run(frame, stop); });
        }
        // Runs f on a new thread that has switched to the input desktop. A thread that owns windows or hooks cannot
        // switch, so every operation gets a fresh one.
        internal static T OnInputDesktop<T>(Func<T> f) {
            T result = default(T); Exception error = null; IntPtr d = Win.OpenInputDesktop(0, false, 0x10000000);
            var t = new Thread(delegate() {
                try { if (d == IntPtr.Zero || !Win.SetThreadDesktop(d)) throw new ScreenError("cannot reach the screen right now"); result = f(); }
                catch (Exception e) { error = e; }
            });
            t.IsBackground = true; t.Start(); t.Join();
            if (d != IntPtr.Zero) Win.CloseDesktop(d);
            if (error != null) throw error;
            return result;
        }
    }

    // The corner windows' pipe. Interactive users may open it, the network may not, and nobody but SYSTEM may add a
    // pipe instance (0x12008B: read and write data, read attributes and permissions, synchronize). It serves only
    // clients in the active console session, at most 2 connections per process, so a process of another user (fast
    // user switching, Remote Desktop) cannot take the 8 instances. A request is {"type":"status"} or {"type":"end"};
    // anything else, or nothing for 5 s, closes the connection.
    sealed class UiServer {
        const string Sddl = "D:P(A;;GA;;;SY)(A;;0x12008B;;;IU)";
        public const int Instances = 8, ReadMs = 5000, PerProcess = 2;
        readonly Func<Dictionary<string, object>> status; readonly Action end; readonly Func<uint, bool> allowSession;
        readonly Dictionary<uint, long> seen = new Dictionary<uint, long>(); readonly Dictionary<uint, int> open = new Dictionary<uint, int>();
        public UiServer(string name, Func<Dictionary<string, object>> status, Action end) : this(name, status, end, delegate(uint s) { return s == Native.WTSGetActiveConsoleSessionId(); }, Sddl) { }
        // allowSession and sddl: the tests' own. Only the owner of a pipe's ACL may add instances, and the tests do not run as SYSTEM.
        internal UiServer(string name, Func<Dictionary<string, object>> status, Action end, Func<uint, bool> allowSession, string sddl) {
            this.status = status; this.end = end; this.allowSession = allowSession;
            for (int i = 0; i < Instances; i++) { var pipe = Native.PipeServer(name, sddl, Instances, i == 0, true); var t = new Thread(Serve); t.IsBackground = true; t.Start(pipe); }
        }
        void Serve(object o) {
            var pipe = (NamedPipeServerStream)o;
            while (true) {
                uint pid = 0; bool counted = false;
                try {
                    pipe.WaitForConnection(); uint session;
                    if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || !Native.GetNamedPipeClientSessionId(pipe.SafePipeHandle, out session) || !allowSession(session)) throw new UnauthorizedAccessException();
                    lock (open) { int n; open.TryGetValue(pid, out n); if (n >= PerProcess) throw new UnauthorizedAccessException(); open[pid] = n + 1; counted = true; }
                    while (true) {
                        string request = Pipes.UiRequest(Pipes.Read(pipe, 1024, ReadMs));
                        if (request == null) break;
                        if (request == "end") end();
                        lock (seen) seen[session] = PauseClock.Now();
                        Pipes.Write(pipe, status());
                    }
                } catch (Exception) { }
                if (counted) lock (open) { if (--open[pid] == 0) open.Remove(pid); }
                try { pipe.Disconnect(); } catch (Exception) { return; }
            }
        }
        // A window in that session asked for status within ms.
        public bool SeenWithin(uint session, long ms) { long at; lock (seen) return seen.TryGetValue(session, out at) && PauseClock.Now() - at < ms; }
        public bool AnySeenWithin(long ms) { lock (seen) foreach (long at in seen.Values) if (PauseClock.Now() - at < ms) return true; return false; }
    }

    // The corner window's view of the full-control service, through its pipe: status every 500 ms, "end" for End
    // session. End is sent again until the service reports the session ended. When the service cannot be reached the
    // link finishes as Lost, and the window says so instead of claiming the session ended.
    public sealed class ServiceLink : ISupportLink {
        public static int EndMs = 30000; // tests shorten it
        readonly string pipe; Thread loop, ender; volatile bool finished, lost, ending; bool connected, linkUp = true; int busy;
        volatile bool paused, blocked; long expires;
        public event Action Connected; public event Action<bool> LinkChanged; public event Action<int> BusyChanged; public event Action Finished;
        public ServiceLink(string sid8) { pipe = Backstop.Name(sid8) + "-ui"; }
        public bool Paused { get { return paused; } }
        public bool Blocked { get { return blocked; } }
        public bool Lost { get { return lost; } }
        public bool SurvivesSignOut { get { return true; } }
        public DateTime ExpiresLocal { get { long ms = Interlocked.Read(ref expires); return ms == 0 ? DateTime.MinValue : new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime(); } }
        static Dictionary<string, object> Ask(string name, string type, int ms) {
            using (var c = Pipes.Client(name)) { c.Connect(ms); Pipes.Write(c, Wire.Map("type", type)); return Pipes.Read(c, 4096, UiServer.ReadMs); }
        }
        // True when the service of this session answers and the session is not over.
        public static bool Running(string sid8) { try { return !Wire.Flag(Ask(Backstop.Name(sid8) + "-ui", "status", 1000), "ended"); } catch (Exception) { return false; } }
        // Sends "end" until the service says the session ended, for up to 30 s. False when that never came.
        public static bool End(string sid8) { return EndPipe(Backstop.Name(sid8) + "-ui", delegate { return false; }); }
        static bool EndPipe(string name, Func<bool> done) {
            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < EndMs && !done()) {
                try { if (Wire.Flag(Ask(name, "end", 2000), "ended")) return true; } catch (Exception) { }
                Thread.Sleep(500);
            }
            return done();
        }
        public void Start() { if (loop != null) return; loop = new Thread(Loop); loop.IsBackground = true; loop.Start(); }
        void Loop() {
            var clock = Stopwatch.StartNew(); bool reached = false;
            while (!finished) {
                try {
                    using (var c = Pipes.Client(pipe)) {
                        c.Connect(2000); reached = true;
                        while (true) { Pipes.Write(c, Wire.Map("type", ending ? "end" : "status")); if (Apply(Pipes.Read(c, 4096, UiServer.ReadMs))) { Finish(false); return; } Thread.Sleep(ending ? 300 : 500); }
                    }
                } catch (Exception) {
                    // Gone without saying ended, or never there: the service cannot be reached, which is not the same as ended.
                    if (reached || clock.ElapsedMilliseconds > 30000) break;
                    Thread.Sleep(500);
                }
            }
            Finish(true);
        }
        // True when the session is over. Values of the wrong type count as false or zero.
        bool Apply(Dictionary<string, object> s) {
            if (Wire.Flag(s, "ended")) return true;
            object v; long now = Client.UnixNow(), at = s.TryGetValue("expires_at", out v) && (v is int || v is long) ? Convert.ToInt64(v) : 0;
            Interlocked.Exchange(ref expires, at > now && at - now <= FullState.DayMs + 60000 ? at : 0);
            paused = Wire.Flag(s, "paused"); blocked = Wire.Flag(s, "blocked");
            int n = s.TryGetValue("busy", out v) && v is int ? Math.Max(0, (int)v) : 0;
            if (n != busy) { busy = n; var e = BusyChanged; if (e != null) e(n); }
            if (Wire.Flag(s, "connected") && !connected) { connected = true; var e = Connected; if (e != null) e(); }
            bool up = Wire.Flag(s, "link");
            if (connected && up != linkUp) { linkUp = up; var e = LinkChanged; if (e != null) e(up); }
            return false;
        }
        void Finish(bool unreachable) { lock (this) { if (finished) return; finished = true; lost = unreachable; } var f = Finished; if (f != null) f(); }
        // End session: the status loop sends "end" instead of "status" on the connection it holds, until the service
        // reports the session ended. Without that within EndMs, the link finishes as Lost.
        public void Stop() {
            if (finished || ender != null) return;
            ending = true;
            ender = new Thread(delegate() { var clock = Stopwatch.StartNew(); while (!finished && clock.ElapsedMilliseconds < EndMs) Thread.Sleep(100); Finish(true); }); ender.IsBackground = true; ender.Start();
        }
        // Before the app exits: wait until the end request is confirmed or given up.
        public void Flush(int ms) { var t = ender; if (t != null) t.Join(ms); }
    }

    // --service: the temporary LocalSystem service of one full-control session.
    public sealed class SupportService : ServiceBase, IFullControl {
        readonly string exe, sid8, folder; readonly Dictionary<string, object> config;
        readonly object gate = new object(), superviseGate = new object();
        readonly Stopwatch age = Stopwatch.StartNew();
        FullState state; Client client; Thread worker; HelperHost helper; UiServer ui; System.Threading.Timer timer;
        IntPtr window; int windowPid; uint windowSession = 0xFFFFFFFF; long windowStarted = long.MinValue / 2;
        volatile bool shutdown, stopping, ended, connected, linkUp = true, backstopDue; int busy, cleaned;
        public SupportService(string exe, Dictionary<string, object> cfg) {
            this.exe = exe; config = cfg; sid8 = FullInstall.Sid8(cfg); folder = Path.GetDirectoryName(exe);
            ServiceName = Backstop.Name(sid8); CanStop = true; CanShutdown = true; CanHandleSessionChangeEvent = true; AutoLog = false;
        }
        protected override void OnStart(string[] args) { worker = new Thread(Work); worker.IsBackground = true; worker.Start(); }
        // An explicit stop (the backstop task, an administrator) ends the session like End session does.
        protected override void OnStop() {
            stopping = true; RequestAdditionalTime(30000);
            var c = client; if (c != null) c.Stop();
            if (worker != null && worker != Thread.CurrentThread) worker.Join(25000);
            Cleanup();
        }
        // Windows shuts down or restarts: keep everything, so the session goes on after the restart.
        protected override void OnShutdown() {
            shutdown = true; var c = client; if (c != null) { c.EndRemote = false; c.Stop(); }
            if (worker != null) worker.Join(5000);
            if (helper != null) helper.Stop();
        }
        // Sign-in, sign-out, lock and a console switch: the helper and the window follow the console session.
        protected override void OnSessionChange(SessionChangeDescription change) { ThreadPool.QueueUserWorkItem(delegate { Supervise(); }); }
        void Work() {
            try {
                // Layer 2: the service's own clock. A deadline that passed while the PC was off ends it before it connects.
                state = FullState.Load(folder);
                if (state != null && state.Sid == Wire.Text(config, "sid") && !FullState.Expired(state.Deadline, Client.UnixNow()) && !stopping) {
                    ui = new UiServer(Backstop.Name(sid8) + "-ui", UiStatus, delegate { var c = client; if (c != null) c.Stop(); });
                    helper = new HelperHost(exe, sid8);
                    helper.Changed += delegate { var c = client; if (c != null) c.Nudge(); }; // an escape or a desktop switch reaches the relay at once
                    var cfg = new Dictionary<string, object>(config); cfg["startup_ms"] = state.Deadline - Client.UnixNow(); cfg.Remove("startup_expires_at");
                    client = new Client(cfg, FullState.DayMs) { Full = this, WorkRoot = folder };
                    client.Connected += delegate { connected = true; };
                    client.LinkChanged += delegate(bool up) { linkUp = up; };
                    client.BusyChanged += delegate(int n) { Thread.VolatileWrite(ref busy, n); };
                    timer = new System.Threading.Timer(delegate { Supervise(); }, null, 0, 2000);
                    if (!stopping) client.Run();
                }
            } catch (Exception) { }
            if (shutdown) return;
            Cleanup();
            if (!stopping) new Thread(delegate() { try { Stop(); } catch (Exception) { } }).Start();
        }
        void Supervise() {
            if (!Monitor.TryEnter(superviseGate)) return;
            try {
                if (ended || shutdown || helper == null) return;
                if (FullState.Expired(state.Deadline, Client.UnixNow())) { var c = client; if (c != null) c.Stop(); return; }
                if (backstopDue) { Backstop.Register(sid8, folder, state); backstopDue = false; }
            } catch (Exception) { } finally { Monitor.Exit(superviseGate); }
            try { helper.Ensure(); } catch (Exception) { }
            try { EnsureWindow(); } catch (Exception) { }
        }
        // The corner window runs as the signed-in user in their session. It starts at each sign-in, and again if it
        // closed or crashed while the session goes on. The app that installed the service is the first window, so wait.
        void EnsureWindow() {
            uint s = Native.WTSGetActiveConsoleSessionId();
            if (ended || s == 0xFFFFFFFF || age.ElapsedMilliseconds < 10000 || ui.SeenWithin(s, 4000)) return;
            if (window != IntPtr.Zero && CommandJob.WaitForSingleObject(window, 0) != 0 && windowSession == s) return;
            if (PauseClock.Now() - windowStarted < 10000) return;
            IntPtr token; if (!Native.WTSQueryUserToken(s, out token)) return; // the sign-in screen: nobody to show it to
            try {
                if (window != IntPtr.Zero) { Native.CloseHandle(window); window = IntPtr.Zero; }
                windowStarted = PauseClock.Now();
                var pi = Native.Launch(token, Path.Combine(folder, "window.exe"), "--window " + sid8, true, IntPtr.Zero);
                window = pi.Process; windowPid = pi.Id; windowSession = s;
            } finally { Native.CloseHandle(token); }
        }
        Dictionary<string, object> UiStatus() {
            var s = helper == null ? null : helper.Status; var c = client;
            return Wire.Map("connected", connected, "link", linkUp, "busy", Thread.VolatileRead(ref busy), "paused", s != null && Wire.Number(s, "paused_ms") > 0,
                "blocked", s != null && Wire.Number(s, "blocked_ms") > 0, "expires_at", c == null ? 0 : c.ExpiresAtMs, "ended", ended);
        }
        public string UserName {
            get {
                uint s = Native.WTSGetActiveConsoleSessionId(); IntPtr token;
                if (s == 0xFFFFFFFF || !Native.WTSQueryUserToken(s, out token)) return "SYSTEM";
                try { using (var id = new WindowsIdentity(token)) { string n = id.Name; return n.Substring(n.LastIndexOf('\\') + 1); } } finally { Native.CloseHandle(token); }
            }
        }
        public Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop) {
            if (Wire.Text(frame, "type") == "control") return Wire.Map("ok", true, "control", "full", "text", "full control is already on");
            var a = frame.ContainsKey("action") ? frame["action"] as Dictionary<string, object> : null;
            // The own-window guard covers the corner window this service started and the app that installed it, nothing else.
            var pids = new List<int>(); if (windowPid != 0) pids.Add(windowPid); if (state != null && state.AppPid != 0) pids.Add(state.AppPid);
            if (a != null && Wire.Text(a, "name") == "send_sas") {
                // SendSAS works from a service only, with SoftwareSASGeneration allowing it (the install sets it). Windows
                // drops it without an error otherwise, so check first: the install may have skipped the share (SasShare.Locked).
                bool allowed; using (var hklm = SasShare.Machine()) allowed = SasShare.Allowed(hklm);
                if (!allowed) return Wire.Map("ok", false, "error", SasShare.Refused);
                string error = Native.SendSas(); if (error != null) return Wire.Map("ok", false, "error", error);
                stop.WaitOne(1500);
                bool shot = !a.ContainsKey("screenshot") || Wire.Flag(a, "screenshot");
                var sas = helper.Op(Wire.Map("type", "screen", "own_pids", pids, "action", Wire.Map("name", shot ? "screenshot" : "wait", "seconds", 0.1, "screenshot", false, "display", Wire.Number(a, "display"))));
                helper.PollNow();
                // Ctrl+Alt+Del went out: a failed screenshot after it does not make the action fail.
                return Wire.Flag(sas, "ok") ? sas : Wire.Map("ok", true, "text", "Ctrl+Alt+Del sent; no screenshot: " + Wire.Text(sas, "error"));
            }
            var forward = new Dictionary<string, object>(frame); forward["own_pids"] = pids;
            var result = helper.Op(forward);
            helper.PollNow(); // the desktop and the block as they are now, for the next poll
            if (a != null && Wire.Text(a, "name") == "block_input" && Wire.Flag(result, "ok")) {
                var st = helper.Status; var c = client; long left = st == null ? 0 : Wire.Number(st, "blocked_ms");
                result["input_blocked_until"] = left > 0 && c != null ? Client.UnixNow() + c.ServerOffsetMs + left : (object)null;
            }
            return result;
        }
        public IntPtr UserToken(out string profile) {
            uint s = Native.WTSGetActiveConsoleSessionId(); IntPtr token = IntPtr.Zero;
            bool signedIn = s != 0xFFFFFFFF && Native.WTSQueryUserToken(s, out token);
            if (TokenChoice.Pick(false, signedIn, 0) == RunAs.Nobody) throw new ArgumentException(TokenChoice.NobodySignedIn);
            if (TokenChoice.Pick(false, true, Native.ElevationType(token)) == RunAs.ElevatedUser) {
                IntPtr linked = Native.Linked(token);
                if (linked != IntPtr.Zero) { Native.CloseHandle(token); token = linked; }
            }
            profile = Native.Profile(token);
            return token;
        }
        public void Report(Dictionary<string, object> poll, long serverOffsetMs) {
            var s = helper == null ? null : helper.Status;
            long now = Client.UnixNow() + serverOffsetMs, paused = s == null ? 0 : Wire.Number(s, "paused_ms"), blocked = s == null ? 0 : Wire.Number(s, "blocked_ms");
            poll["desktop"] = s == null ? "unknown" : Wire.Text(s, "desktop");
            poll["paused_until"] = paused > 0 ? now + paused : (object)null;
            poll["input_blocked_until"] = blocked > 0 ? now + blocked : (object)null;
        }
        public void Welcomed(long expiresAtMs) {
            lock (gate) {
                long d = FullState.OnWelcome(state.Deadline, state.Welcomed, expiresAtMs, Client.UnixNow());
                if (d == state.Deadline && state.Welcomed) return;
                state.Deadline = d; state.Welcomed = true;
                try { state.Save(folder); } catch (Exception) { }
                backstopDue = true;
            }
            ThreadPool.QueueUserWorkItem(delegate { Supervise(); });
        }
        // Layer 1: the end of the session (operator, customer, relay alarm, expiry). Open windows read "ended" and close
        // themselves; then the helper, this session's share of the registry value and the service registration go, and
        // a detached cmd removes the folder once this process has exited and then the backstop task, last. None of it
        // depends on state.json, so a damaged one cannot stop the registry value from being put back.
        void Cleanup() {
            if (Interlocked.Exchange(ref cleaned, 1) != 0) return;
            ended = true;
            if (timer != null) timer.Dispose();
            if (ui != null && ui.AnySeenWithin(3000)) Thread.Sleep(1500);
            if (helper != null) helper.Stop();
            bool released = false;
            try { using (var hklm = SasShare.Machine()) released = SasShare.Release(hklm, ServiceName); } catch (Exception) { }
            Scm.Delete(ServiceName);
            // A share that was not released keeps the backstop task, which releases it at the deadline.
            FullInstall.RemoveLater(!released ? new List<string>() : state != null ? new List<string> { state.Task } : Backstop.Tasks(sid8), folder);
        }
    }

    // request_full_control's two limits: one prompt at a time, and none within a minute of a declined one, so the operator
    // cannot nag the customer. A decline is UAC No or Don't allow, at the first start or on a request; a failure is not one.
    public sealed class FullRequestGate {
        public const long CooldownMs = 60000;
        public const string Cooling = "the customer declined full control less than a minute ago; ask them first, then try again";
        public const string Waiting = "a request for full control is already waiting for the customer";
        long declinedAt = long.MinValue / 2; int requesting;
        // Every elevation outcome goes through here, so a decline at the first start counts as much as a later one.
        public void Record(int outcome, long now) { if (outcome == Elevation.Declined) Interlocked.Exchange(ref declinedAt, now); }
        public Dictionary<string, object> Request(Func<Dictionary<string, object>> ask, long now) {
            if (now - Interlocked.Read(ref declinedAt) < CooldownMs) return Wire.Map("ok", false, "error", Cooling);
            if (Interlocked.CompareExchange(ref requesting, 1, 0) != 0) return Wire.Map("ok", false, "error", Waiting);
            try { return ask(); } finally { Interlocked.Exchange(ref requesting, 0); }
        }
    }

    // The customer's app from its first start: full control first, the fallback to normal mode, and the handover of a
    // normal-mode session to the service after request_full_control.
    sealed class StartFlow {
        readonly SupportWindow window; readonly Dictionary<string, object> config; readonly string exe, sid8; readonly long connectBy;
        Thread thread, clientThread, ender; Client client; ServiceLink link; Mutex windowMutex;
        readonly FullRequestGate gate = new FullRequestGate();
        public StartFlow(SupportWindow window, Dictionary<string, object> config, string exe, long connectBy) {
            this.window = window; this.config = config; this.exe = exe; this.connectBy = connectBy; sid8 = FullInstall.Sid8(config);
        }
        public void Begin() { thread = new Thread(Run); thread.IsBackground = true; thread.Start(); }
        // After the window closed: finish an install in progress (it ends the service if the customer ended), stop the client.
        public void Finish() {
            if (thread != null) thread.Join(120000);
            if (ender != null) ender.Join(35000);
            if (client != null) { client.Stop(); if (clientThread != null) clientThread.Join(20000); }
            if (link != null) link.Flush(3000);
        }
        T Ui<T>(Func<T> f) { return window.Dispatcher.Invoke(f); }
        void Ui(Action a) { window.Dispatcher.Invoke(a); }
        bool Ask(string heading, string text, bool warning) { return !window.EndedByCustomer && Ui(delegate { return ConsentDialog.Ask(heading, text, warning); }); }
        // The customer ended the session while the install ran: end the new service, and say so if that cannot be confirmed.
        void EndOrWarn() {
            if (!ServiceLink.End(sid8)) WF.MessageBox.Show("Cannot reach the support service. Support may still have access until the session ends by itself. Tell support.", "Remote support");
        }
        void Run() {
            try {
                // Opened again while this session has full control: be its window.
                if (ServiceLink.Running(sid8)) { Ui(BecomeWindow); return; }
                Consent path = ConsentPath.Detect();
                int outcome = path == Consent.Unavailable ? Elevation.Declined : Elevate(path, connectBy, false);
                if (path != Consent.Unavailable) gate.Record(outcome, PauseClock.Now()); // no request_full_control when Unavailable
                if (window.EndedByCustomer) { if (outcome == Elevation.Installed) EndOrWarn(); return; }
                if (outcome == Elevation.Installed) { Ui(BecomeWindow); return; }
                // UAC No, a failure, or Don't allow: limited support, if the customer wants it. Don't allow is the default.
                bool admin = SupportAccess.IsAdministrator();
                if (!Ask(SupportAccess.LimitedHeading, SupportAccess.LimitedText + (admin ? SupportAccess.LimitedAdmin : ""), admin)) { Ui(window.CloseQuietly); return; }
                Ui(delegate { StartNormal(admin, path != Consent.Unavailable); });
            } catch (Exception e) { Ui(delegate { WF.MessageBox.Show(e.Message, "Remote support"); window.CloseQuietly(); }); }
        }
        // Our own confirm when no UAC prompt will appear, the notice before UAC, then --elevate-install.
        int Elevate(Consent path, long deadline, bool connected) {
            if (path == Consent.Confirm && !Ask(SupportAccess.FullHeading, SupportAccess.FullText, true)) return Elevation.Declined;
            if (path == Consent.Prompt) { Ui(delegate { window.Notice(SupportAccess.Asking); }); Thread.Sleep(1500); }
            IntPtr owner = Ui(delegate { return new WindowInteropHelper(window).Handle; });
            try { return Elevation.Install(exe, deadline, connected, owner); }
            finally { Ui(delegate { window.Notice(null); }); }
        }
        void StartNormal(bool admin, bool canElevate) {
            window.SetAccess(admin, admin ? null : SupportAccess.NoAdminNote);
            client = new Client(config) { CanElevate = canElevate };
            if (canElevate) client.RequestFull = RequestFull;
            window.Bind(client);
            clientThread = new Thread(client.Run); clientThread.IsBackground = true; clientThread.Start();
        }
        // request_full_control, on the client's screen lane. On success the service has said hello, which answers the
        // operator; this client then stops without sending anything and the window shows the service.
        Dictionary<string, object> RequestFull() { return gate.Request(AskFull, PauseClock.Now()); }
        Dictionary<string, object> AskFull() {
            Consent path = ConsentPath.Detect();
            if (path == Consent.Unavailable) return Wire.Map("ok", false, "error", "this Windows account cannot get administrator rights, so full control is not possible");
            Ui(delegate { window.Hold(true); });
            int outcome = Elevation.Failed;
            try { outcome = Elevate(path, client.ExpiresAtMs, true); }
            finally {
                if (outcome == Elevation.Installed) { client.EndRemote = false; client.Stop(); Ui(BecomeWindow); }
                Ui(delegate { window.Hold(false); });
            }
            if (outcome == Elevation.Installed) return null;
            gate.Record(outcome, PauseClock.Now());
            return Wire.Map("ok", false, "error", outcome == Elevation.Declined ? "the customer declined full control" : "full control could not be set up on this PC");
        }
        void BecomeWindow() {
            if (window.EndedByCustomer) { ender = new Thread(EndOrWarn); ender.Start(); return; }
            bool mine; windowMutex = new Mutex(true, "Local\\SupportMcpWindow-" + sid8, out mine);
            if (!mine) { window.CloseQuietly(); return; } // the service already started the window
            window.SetAccess(false, null);
            link = new ServiceLink(sid8); window.Bind(link); link.Start();
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
            // Not String.Format(provider, format, a, b, c): that overload is new in .NET 4.6 and throws MissingMethodException on 4.5.2.
            var invariant = System.Globalization.CultureInfo.InvariantCulture;
            return (s / 3600).ToString("00", invariant) + ":" + ((s / 60) % 60).ToString("00", invariant) + ":" + (s % 60).ToString("00", invariant);
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
    // A button in a window that never takes the focus (the corner window) must not be focusable: a click would move the keyboard
    // focus into the window and activate it. Buttons of a dialog or confirm that is activated on purpose pass focusable: true,
    // so Tab, Enter and screen readers reach them.
    public sealed class FlatButton : Button {
        readonly Brush rest, hover;
        public FlatButton(object content, Brush foreground, Brush rest, Brush hover, Brush focusRing, double height, double minWidth, double padding, double radius, double fontSize, bool focusable = false) {
            this.rest = rest; this.hover = hover;
            Content = content; Foreground = foreground; Background = rest; Height = height; MinWidth = minWidth;
            Padding = new Thickness(padding, 0, padding, 0); FontSize = fontSize; FontWeight = FontWeights.SemiBold;
            Cursor = Cursors.Hand; Focusable = focusable; FocusVisualStyle = null; BorderThickness = new Thickness(0);
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

    // The window the customer sees while support is connected. Bind gives it the session to show: the normal-mode
    // Client, or the full-control service through ServiceLink. Before that it can show a notice, such as the one before UAC.
    public sealed class SupportWindow : Window {
        const double CardWidth = 336, Gap = 12, Pad = 20;
        ISupportLink link;
        readonly Palette p;
        readonly bool preparing;
        public volatile bool Preserve;
        // Set when the customer ended the session, so a full-control install still running can end the service it made.
        public volatile bool EndedByCustomer;
        bool connectedOnce, linkOk = true, busy, paused, blocked, workShown, ended, tucked, confirming, sessionEnding, sweeping, userMoved, placing, held, heldEnd, ending, lostEnd;
        string notice;
        readonly Stopwatch session = new Stopwatch(), workClock = new Stopwatch();
        TimeSpan endedAfter;
        double userLeft, userCardBottom;
        readonly DispatcherTimer tick = new DispatcherTimer(), hold = new DispatcherTimer(), closer = new DispatcherTimer(), pause = new DispatcherTimer();
        readonly Grid root;
        readonly Border card, tile, tuckTile, edge;
        readonly Glyph tileGlyph, tuckGlyph;
        readonly System.Windows.Shapes.Rectangle sweep;
        readonly TranslateTransform sweepMove = new TranslateTransform();
        readonly TextBlock head, status, until, adminLine, noteLine, tuckTitle, tuckTimer, askTitle, askText;
        readonly StackPanel fullView, tuckView, askFoot;
        readonly Border askBox, normalFoot;
        readonly FlatButton collapse, endButton, tuckEnd, expand, keep, sure;
        Run timerRun;

        public SupportWindow(Palette palette, bool administrator, bool preparing, string note) {
            this.p = palette; this.preparing = preparing;
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
            adminLine = Ui.Label("Running with administrator rights.", 12.5, FontWeights.Normal, p.Stop, Ui.TextFont); adminLine.Margin = new Thickness(0, 6, 0, 0);
            text.Children.Add(adminLine);
            noteLine = Ui.Label("", 12, FontWeights.Normal, p.Muted, Ui.TextFont); noteLine.Margin = new Thickness(0, 6, 0, 0);
            text.Children.Add(noteLine);
            this.administrator = administrator; noteLine.Text = note ?? "";
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
            keep = new FlatButton("Keep connected", p.Ink, Brushes.Transparent, p.Surface2, p.Work, 32, 0, 12, 6, 13, true);
            sure = new FlatButton("End session", Brushes.White, p.StopSolid, p.StopSolidHover, p.Work, 32, 0, 14, 6, 13, true); sure.Margin = new Thickness(8, 0, 0, 0);
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

            collapse.Click += delegate { tucked = true; if (confirming) KeepConnected(); else Render(); };
            expand.Click += delegate { tucked = false; Render(); };
            endButton.Click += delegate { AskToEnd(); };
            tuckEnd.Click += delegate { AskToEnd(); };
            keep.Click += delegate { KeepConnected(); };
            // Full control: the session is over only when the service confirms it (or the window says it cannot reach it).
            sure.Click += delegate {
                EndedByCustomer = true;
                if (link == null || !link.SurvivesSignOut) { if (link != null) link.Stop(); ShowEnded(); return; }
                ending = true; confirming = false; link.Stop(); Render();
            };
            PreviewKeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Escape && confirming) { KeepConnected(); e.Handled = true; } };

            tick.Interval = TimeSpan.FromSeconds(1); tick.Tick += delegate { UpdateTimer(); };
            pause.Interval = TimeSpan.FromMilliseconds(250);
            pause.Tick += delegate {
                bool now = link != null && link.Paused, locked = link != null && link.Blocked;
                if (now != paused || locked != blocked) { paused = now; blocked = locked; Render(); }
            };
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

            // The window never takes the keyboard focus when it appears or changes, so support can type into the app the customer was
            // using. Clicks on its buttons still work without activating it. Only AskToEnd activates it, after the customer asked to end.
            // APPWINDOW keeps its taskbar button, so the taskbar's Close and Alt+F4 still reach OnClosing and ask "End the session?".
            ShowActivated = false;
            SourceInitialized += delegate { IntPtr h = new WindowInteropHelper(this).Handle; Win.SetWindowLong(h, -20, Win.GetWindowLong(h, -20) | unchecked((int)(Win.NoActivate | Win.AppWindow))); };
            // The corner window's buttons are not focusable (FlatButton), so a click cannot activate it. The two buttons of the
            // confirm are, so the customer can answer it from the keyboard. Leaving the window while the confirm is open forgets
            // the window to go back to: a later Keep must not pull the focus to an older window.
            Deactivated += delegate { if (confirming) returnTo = IntPtr.Zero; };
            Closing += OnClosing;
            if (Application.Current != null)
                Application.Current.SessionEnding += delegate(object sender, SessionEndingCancelEventArgs e) { sessionEnding = true; };

        }
        bool administrator;

        // Link threads post to the UI thread only; nothing here shows commands or paths. Events of a link that was
        // replaced (request_full_control hands the session from the Client to the service) are ignored.
        public void Bind(ISupportLink l) {
            link = l; heldEnd = false;
            l.Connected += delegate { Post(delegate { if (link == l) OnConnected(); }); };
            l.LinkChanged += delegate(bool up) { Post(delegate { if (link == l) OnLink(up); }); };
            l.BusyChanged += delegate(int count) { Post(delegate { if (link == l) OnBusy(count > 0); }); };
            l.Finished += delegate { Post(delegate { if (link != l) return; if (held) heldEnd = true; else ShowEnded(); }); };
            Render();
        }
        // While the app asks for full control, an end of the current link waits: the service may be taking over.
        public void Hold(bool on) { held = on; if (!on && heldEnd) { heldEnd = false; ShowEnded(); } }
        public void Notice(string text) { notice = text; Render(); }
        public void SetAccess(bool administrator, string note) { this.administrator = administrator; noteLine.Text = note ?? ""; Render(); }
        // A session that never started (Don't allow, or another window already shows it) closes without a message.
        public void CloseQuietly() { ended = true; Close(); }

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
            if (connectedOnce || ended) { Render(); return; }
            connectedOnce = true; linkOk = true; session.Start(); tick.Start(); pause.Start(); Render();
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

        // The window that had the focus before the confirm took it (never one of ours), with its process and thread ids so
        // KeepConnected can tell that the handle still belongs to the same window.
        IntPtr returnTo; uint returnPid, returnThread;
        internal void AskToEnd() {
            if (ended) return;
            if (!confirming) {
                IntPtr fg = Win.GetForegroundWindow();
                returnTo = FocusReturn.Ours(fg) ? IntPtr.Zero : fg;
                returnThread = returnTo == IntPtr.Zero ? 0 : Win.GetWindowThreadProcessId(returnTo, out returnPid);
            }
            tucked = false; confirming = true; Render();
            UpdateLayout(); Activate(); keep.Focus();
        }
        // Keep connected, Escape, or tucking the window: close the confirm and give the focus back to where it came from.
        internal void KeepConnected() {
            confirming = false; Render();
            uint pid = returnPid, thread = returnThread;
            IntPtr back = FocusReturn.Target(returnTo, Win.GetForegroundWindow(), FocusReturn.Ours, delegate(IntPtr w) { return FocusReturn.Usable(w, pid, thread); });
            returnTo = IntPtr.Zero;
            if (back != IntPtr.Zero) Win.SetForegroundWindow(back);
        }
        void ShowEnded() {
            if (ended) return;
            ended = true; endedAfter = session.Elapsed; session.Stop(); tick.Stop(); pause.Stop(); hold.Stop(); paused = false; blocked = false;
            confirming = false; tucked = false; workShown = false; busy = false;
            lostEnd = link != null && link.Lost;
            Render(); if (!lostEnd) closer.Start();
        }
        void OnClosing(object sender, System.ComponentModel.CancelEventArgs e) {
            // User close (End session, Alt+F4, taskbar Close) asks inline first.
            // Windows shutdown and an already ended session close without asking.
            if (!ended && !sessionEnding) { e.Cancel = true; AskToEnd(); return; }
            if (link == null || (sessionEnding && link.SurvivesSignOut)) return; // full control goes on after a sign-out or restart
            var client = link as Client;
            if (preparing && !ended && sessionEnding && client != null) { Preserve = true; client.EndRemote = false; }
            link.Stop();
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

            head.Text = ended ? (lostEnd ? "Cannot reach the support service." : "Support is disconnected.") : ending ? "Ending the session..." : !connectedOnce ? "Connecting to support..." : !linkOk ? "Reconnecting to support..." : "A remote support agent is connected to your machine.";
            status.Inlines.Clear(); timerRun = null;
            if (ended && lostEnd) {
                status.Inlines.Add(new Run("Support may still have access until the session ends by itself. Tell support."));
            } else if (ended) {
                status.Inlines.Add(new Run("Session ended after " + Ui.Clock(endedAfter) + ". Support can no longer reach this PC."));
            } else if (!connectedOnce) {
                status.Inlines.Add(new Run(notice ?? "This window stays open while support is connected."));
            } else if (blocked && linkOk) {
                status.Inlines.Add(new Run("Support has locked your mouse and keyboard. Press Ctrl+Alt+Del to unlock.") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else if (paused && linkOk) {
                status.Inlines.Add(new Run("Paused while you use the PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else if (working) {
                status.Inlines.Add(new Run("Support is working on your PC") { FontWeight = FontWeights.SemiBold, Foreground = p.Ink });
            } else {
                status.Inlines.Add(new Run(linkOk ? "Connected for " : "Trying again. Session time "));
                timerRun = new Run(Ui.Clock(session.Elapsed)) { Foreground = p.Ink, FontFamily = new FontFamily(Ui.MonoFont), FontSize = 12 };
                status.Inlines.Add(timerRun);
            }
            DateTime expires = link != null ? link.ExpiresLocal : DateTime.MinValue;
            until.Text = connectedOnce && expires != DateTime.MinValue ? "Ends by itself " + expires.ToString("ddd d MMM, HH:mm", System.Globalization.CultureInfo.InvariantCulture) : "";
            tuckTitle.Text = working ? "Support is working" : "Remote support";
            tuckTimer.Text = connectedOnce ? Ui.Clock(session.Elapsed) : "";

            // Once the session has ended these lines would be stale.
            adminLine.Visibility = ended || !administrator ? Visibility.Collapsed : Visibility.Visible;
            noteLine.Visibility = ended || noteLine.Text.Length == 0 ? Visibility.Collapsed : Visibility.Visible;

            bool small = tucked && !ended;
            card.Width = small ? Double.NaN : CardWidth;
            fullView.Visibility = small ? Visibility.Collapsed : Visibility.Visible;
            tuckView.Visibility = small ? Visibility.Visible : Visibility.Collapsed;
            collapse.Visibility = ended ? Visibility.Hidden : Visibility.Visible;
            normalFoot.Visibility = (!ended && !confirming) || lostEnd ? Visibility.Visible : Visibility.Collapsed;
            endButton.Visibility = ended || ending ? Visibility.Collapsed : Visibility.Visible;
            askBox.Visibility = askFoot.Visibility = !ended && confirming ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    // Consent prompt in the same visual language. "Don't allow" is the default.
    public sealed class ConsentDialog : Window {
        bool allowed;
        public static bool Ask(string message, bool administrator) { return Ask("Allow remote support?", message, administrator); }
        // administrator: the warning look, for a grant of administrator rights or of full control.
        public static bool Ask(string heading, string message, bool administrator) {
            var dialog = new ConsentDialog(Palette.Detect(), heading, message, administrator);
            dialog.ShowDialog();
            return dialog.allowed;
        }
        ConsentDialog(Palette p, string headingText, string message, bool administrator) {
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
            var heading = Ui.Label(headingText, 15.5, FontWeights.SemiBold, administrator ? p.Stop : p.Ink, Ui.DisplayFont); heading.LineHeight = 21; heading.Margin = new Thickness(0, 0, 0, 6);
            var copy = Ui.Label(message, 12.5, FontWeights.Normal, p.Ink, Ui.TextFont); copy.LineHeight = 18;
            text.Children.Add(heading); text.Children.Add(copy);
            body.Children.Add(text);
            stack.Children.Add(body);

            var foot = new Border { BorderBrush = p.Line, BorderThickness = new Thickness(0, 1, 0, 0), Padding = new Thickness(8, 10, 12, 12) };
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var deny = new FlatButton("Don't allow", p.Ink, p.Surface2, p.Line, p.Work, 32, 96, 14, 6, 13, true);
            var allow = administrator
                ? new FlatButton("Allow", p.Stop, p.StopBg, p.StopBgHover, p.Work, 32, 80, 14, 6, 13, true)
                : new FlatButton("Allow", p.Live, p.LiveSoft, p.LiveSoftHover, p.Work, 32, 80, 14, 6, 13, true);
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
            string role = args.Length > 0 ? args[0] : "", executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
            // The roles that run elevated or as SYSTEM show nothing at all: no window, no message box.
            if (role == "--service") { try { ServiceBase.Run(new SupportService(executable, Wire.ReadConfig(executable))); } catch (Exception) { } return; }
            if (role == "--helper") { try { Helper.Run(executable, args); } catch (Exception) { } Environment.Exit(0); }
            if (role == "--elevate-install") {
                Native.SafeDllSearch(); int code = 1; FileStream held = null;
                try { byte[] self = FullInstall.ReadSelf(executable, out held); code = FullInstall.Install(self, Wire.ReadConfig(self), args); } catch (Exception) { }
                finally { if (held != null) held.Dispose(); }
                Environment.Exit(code);
            }
            WF.Application.EnableVisualStyles();
            try {
                var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                if (role == "--window") { RunWindow(app, args); return; }
                bool administrator = SupportAccess.IsAdministrator();
                var config = Wire.ReadConfig(executable);
                bool requestedResume = args.Length == 1 && (args[0] == "--prepare-restart" || args[0] == "--resume");
                if (!requestedResume) { RunStart(app, config); return; }
                // A prepared reconnect after a restart: normal mode, as before full control existed.
                bool resume = RestartResume.Valid(config, executable);
                if (!resume) {
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
                    // Read before Disarm clears it. A normal start and the prepare prompt show the screen control text themselves.
                    bool screenAllowed = !resume || preparing || RestartResume.HasScreenConsent(config);
                    if (!approvedAdministratorResume && !SupportAccess.Confirm(administrator, resume && !preparing, screenAllowed, delegate(string message) {
                        if (preparing) message += "\n\nAlso allow ONE automatic reconnect at the next Windows sign-in with these same rights, without another prompt? It keeps this session's original expiry. End session cancels it.";
                        return ConsentDialog.Ask(message, administrator) ? WF.DialogResult.Yes : WF.DialogResult.No;
                    })) return;
                    if (preparing) RestartResume.Arm(config, administrator);
                    else if (resume) RestartResume.Disarm(config); // one restart only
                    SupportWindow window = null;
                    try {
                        using (var client = new Client(config)) {
                            client.ScreenAllowed = screenAllowed;
                            string note = preparing ? "One automatic reconnect is enabled at the next sign-in. End session cancels it."
                                : resume ? "Reconnected after restart. No further automatic reconnect is installed." + (screenAllowed ? "" : " Screen control stays off, because this reconnect was approved before it existed.") : null;
                            window = new SupportWindow(Palette.Detect(), administrator, preparing, note);
                            var win = window; win.Bind(client);
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
        // A fresh start: the corner window, then full control or the fallback (StartFlow).
        static void RunStart(Application app, Dictionary<string, object> config) {
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcp-" + Wire.Text(config, "sid"), out first)) {
                if (!first) { WF.MessageBox.Show("This support session is already open.", "Remote support"); return; }
                // connect_by on this PC's clock, as the Client counts it: what was left of the first-connection window at download.
                long left = config.ContainsKey("startup_ms") ? Wire.Number(config, "startup_ms") : Wire.Number(config, "startup_expires_at") - Client.UnixNow();
                var window = new SupportWindow(Palette.Detect(), false, false, null);
                var flow = new StartFlow(window, config, System.Reflection.Assembly.GetExecutingAssembly().Location, Client.UnixNow() + Math.Max(0, Math.Min(7200000, left)));
                bool started = false;
                window.Loaded += delegate { if (!started) { started = true; flow.Begin(); } };
                window.Closed += delegate { app.Shutdown(); };
                app.Run(window);
                flow.Finish();
            }
        }
        // --window <sid8>: the corner window of a full-control session, as the signed-in user. It holds no session key.
        static void RunWindow(Application app, string[] args) {
            if (args.Length != 2 || !System.Text.RegularExpressions.Regex.IsMatch(args[1], "^[0-9a-f]{8}$")) return;
            bool first; using (var mutex = new Mutex(true, "Local\\SupportMcpWindow-" + args[1], out first)) {
                if (!first) return;
                var link = new ServiceLink(args[1]); var window = new SupportWindow(Palette.Detect(), false, false, null);
                window.Bind(link);
                window.Loaded += delegate { link.Start(); };
                window.Closed += delegate { app.Shutdown(); };
                app.Run(window);
                link.Flush(3000);
            }
        }
    }
}
