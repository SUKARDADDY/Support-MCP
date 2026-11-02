// Compile with src/agent-app.cs, /main:AppTests and the same v4 references.
// Runs the real HTTP client and native Job containment on a Windows test host.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using SupportMcp;

public sealed class FakeRelay : IDisposable {
    readonly HttpListener listener = new HttpListener();
    readonly object gate = new object();
    readonly Thread server;
    public readonly string Origin;
    public volatile bool End, FailFirstResult;
    public int Results, Polls;
    public bool? Elevated;
    public int Lifetime = 30000;
    Dictionary<string, object> frame, result;
    public readonly Client Agent;
    readonly Thread agentThread;
    public readonly ManualResetEvent Connected = new ManualResetEvent(false);
    // Simulates a PC clock that runs ahead of the relay by this many milliseconds.
    public long ClockSkew;
    public volatile bool Refuse; // drop every request, so the client can never complete a handshake
    public FakeRelay() : this(null) { }
    public FakeRelay(Dictionary<string, object> config) {
        var tcp = new TcpListener(IPAddress.Loopback, 0); tcp.Start(); int port = ((IPEndPoint)tcp.LocalEndpoint).Port; tcp.Stop();
        Origin = "http://127.0.0.1:" + port;
        listener.Prefixes.Add(Origin + "/"); listener.Start();
        server = new Thread(Serve); server.IsBackground = true; server.Start();
        if (config != null) config["origin"] = Origin;
        Agent = new Client(config ?? Wire.Map("origin", Origin, "sid", new string('a', 64), "key", new string('b', 64), "startup_expires_at", Client.UnixNow() + 60000));
        agentThread = new Thread(Agent.Run); agentThread.IsBackground = true;
    }
    public void Launch() { agentThread.Start(); }
    public void Start() { agentThread.Start(); if (!Connected.WaitOne(10000)) throw new Exception("Client did not attach: " + Agent.LastError); }
    void Serve() {
        try { while (listener.IsListening) { var ctx = listener.GetContext(); ThreadPool.QueueUserWorkItem(delegate { Reply(ctx); }); } }
        catch (HttpListenerException) { } catch (ObjectDisposedException) { }
    }
    void Reply(HttpListenerContext ctx) {
        try {
            if (Refuse) { ctx.Response.Abort(); return; }
            if (ctx.Request.Headers["X-Attach-Key"] != new string('b', 64)) throw new Exception("Wrong auth header");
            string raw; using (var r = new StreamReader(ctx.Request.InputStream)) raw = r.ReadToEnd();
            var b = Wire.Json().Deserialize<Dictionary<string, object>>(raw);
            Dictionary<string, object> reply;
            lock (gate) {
                if (End) reply = Wire.Map("type", "end");
                else if (Wire.Text(b, "type") == "hello") { Elevated = Wire.Flag(b, "elevated"); long serverNow = Client.UnixNow() - ClockSkew; reply = Wire.Map("type", "welcome", "generation", 1, "server_time", serverNow, "expires_at", serverNow + Lifetime); Connected.Set(); }
                else if (Wire.Text(b, "type") == "end") { End = true; reply = Wire.Map("type", "end"); }
                else if (Wire.Text(b, "type") == "result") {
                    Results++;
                    if (FailFirstResult) { FailFirstResult = false; ctx.Response.StatusCode = 500; ctx.Response.Close(); return; }
                    result = b; frame = null; reply = Wire.Map("type", "ack"); Monitor.PulseAll(gate);
                } else { Polls++; reply = frame != null && !Wire.Flag(b, "busy") ? frame : Wire.Map("type", "idle"); }
            }
            if (Wire.Text(reply, "type") == "idle") Thread.Sleep(50);
            byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(reply));
            ctx.Response.ContentType = "application/json"; ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length); ctx.Response.Close();
        } catch (Exception) { try { ctx.Response.Abort(); } catch { } }
    }
    public void Queue(Dictionary<string, object> b) {
        lock (gate) { b["id"] = Guid.NewGuid().ToString(); result = null; frame = b; }
    }
    public Dictionary<string, object> WaitResult(int seconds = 15) {
        lock (gate) { var until = DateTime.UtcNow.AddSeconds(seconds); while (result == null && DateTime.UtcNow < until) Monitor.Wait(gate, 100); if (result == null) throw new Exception("No result: " + Agent.LastError); return result; }
    }
    public Dictionary<string, object> Call(Dictionary<string, object> b) { long t = Wire.Number(b, "timeout_s"); Queue(b); return WaitResult((int)Math.Max(15, t + 10)); }
    public void WaitExit() { if (!agentThread.Join(20000)) throw new Exception("Client failed to stop"); if (Agent.LastError != "") throw new Exception(Agent.LastError); }
    public void Dispose() { Agent.Stop(); if (agentThread.ThreadState != ThreadState.Unstarted) agentThread.Join(20000); Agent.Dispose(); listener.Close(); server.Join(1000); }
}

public static class AppTests {
    static void Assert(bool ok, string detail) { if (!ok) throw new Exception(detail); }
    static string Decode(Dictionary<string, object> r, string key) { return Encoding.UTF8.GetString(Convert.FromBase64String(Wire.Text(r, key))); }
    static Dictionary<string, object> Run(string command, int timeout) { return Wire.Map("type", "run", "command", command, "timeout_s", timeout); }
    static void WaitFile(string path) { var end = DateTime.UtcNow.AddSeconds(10); while (!File.Exists(path) && DateTime.UtcNow < end) Thread.Sleep(50); Assert(File.Exists(path), "Command did not start"); }
    static string ChildCommand(string sentinel, string started) {
        string script = "Start-Sleep -Seconds 3; Set-Content -LiteralPath '" + sentinel.Replace("'", "''") + "' -Value late";
        return "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) + "'; Set-Content -LiteralPath '" + started.Replace("'", "''") + "' -Value started; Start-Sleep -Seconds 20";
    }
    public static int Main() {
        string dir = Path.Combine(Path.GetTempPath(), "support-mcp-native-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try {
            Assert(Ui.Clock(TimeSpan.FromSeconds(0)) == "00:00:00" && Ui.Clock(TimeSpan.FromSeconds(3661)) == "01:01:01" && Ui.Clock(TimeSpan.FromHours(100)) == "100:00:00", "The session clock must format as hh:mm:ss");
            foreach (bool administrator in new bool[] { false, true }) {
                foreach (bool reconnect in new bool[] { false, true }) {
                    foreach (DialogResult answer in new DialogResult[] { DialogResult.Yes, DialogResult.No, DialogResult.Cancel }) {
                        int prompts = 0;
                        bool allowed = SupportAccess.Confirm(administrator, reconnect, delegate(string message) {
                            prompts++;
                            Assert(message.Contains("with administrator rights?") == administrator, "Consent must describe the actual access rights");
                            return answer;
                        });
                        bool preconsented = reconnect && !administrator;
                        Assert(allowed == (preconsented || answer == DialogResult.Yes), "Only explicit Yes grants new access");
                        Assert(prompts == (preconsented ? 0 : 1), "Administrator startup and reconnect must always prompt");
                    }
                }
            }
            Console.WriteLine("PASS consent accepts only Yes, describes actual rights, and never silently grants administrator reconnect");
            using (var relay = new FakeRelay()) {
                relay.Start();
                Assert(relay.Elevated == SupportAccess.IsAdministrator(), "Handshake must report actual token rights");
                var rights = relay.Call(Run("$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); [Console]::Write($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))", 60));
                Assert(Wire.Flag(rights, "ok") && Decode(rights, "stdout_b64") == SupportAccess.IsAdministrator().ToString(), "Commands must inherit the consented access rights: timed_out=" + Wire.Flag(rights, "timed_out") + " exit_code=" + Wire.Number(rights, "exit_code") + " stdout=[" + Decode(rights, "stdout_b64") + "] stderr=[" + Decode(rights, "stderr_b64") + "]");
                var r = relay.Call(Run("[Console]::Write('hello ' + [char]0x2713); [Console]::Error.Write('warning'); exit 7", 10));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "exit_code") == 7, "Exit code");
                Assert(Decode(r, "stdout_b64") == "hello \u2713" && Decode(r, "stderr_b64") == "warning", "Unicode and stderr");
                r = relay.Call(Run("[Console]::Write(('x' * 80000))", 10));
                Assert(Convert.FromBase64String(Wire.Text(r, "stdout_b64")).Length == 65536 && Wire.Flag(r, "stdout_truncated"), "Bounded output");
                string file = Path.Combine(dir, "a file 'with quotes' \u2713.bin"); byte[] data = new byte[700000]; new Random(17).NextBytes(data);
                r = relay.Call(Wire.Map("type", "put_file", "path", file, "data_b64", Convert.ToBase64String(data, 0, 500000), "append", false));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "bytes") == 500000, "First file write");
                relay.Call(Wire.Map("type", "put_file", "path", file, "data_b64", Convert.ToBase64String(data, 500000, 200000), "append", true));
                r = relay.Call(Wire.Map("type", "get_file", "path", file, "offset", 0, "length", 524288));
                Assert(!Wire.Flag(r, "eof") && Wire.Number(r, "size") == data.Length, "File size and first chunk");
                byte[] first = Convert.FromBase64String(Wire.Text(r, "data_b64"));
                r = relay.Call(Wire.Map("type", "get_file", "path", file, "offset", 524288, "length", 524288));
                byte[] last = Convert.FromBase64String(Wire.Text(r, "data_b64")); Assert(Wire.Flag(r, "eof"), "Last chunk");
                for (int i = 0; i < data.Length; i++) Assert(data[i] == (i < first.Length ? first[i] : last[i - first.Length]), "Byte round trip");
                r = relay.Call(Wire.Map("type", "get_file", "path", "relative.txt", "length", 1)); Assert(!Wire.Flag(r, "ok"), "Relative path refused");
                // put_file creates missing parent directories, like the PowerShell agent.
                string nested = Path.Combine(dir, "a", "b", "c", "data.bin"); byte[] nestedData = new byte[] { 1, 2, 3, 4, 5, 6 };
                Assert(!Directory.Exists(Path.Combine(dir, "a")), "Test setup: parent must not exist");
                r = relay.Call(Wire.Map("type", "put_file", "path", nested, "data_b64", Convert.ToBase64String(nestedData, 0, 4), "append", false));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "bytes") == 4, "First chunk into a missing directory: " + Wire.Text(r, "error"));
                r = relay.Call(Wire.Map("type", "put_file", "path", nested, "data_b64", Convert.ToBase64String(nestedData, 4, 2), "append", true));
                Assert(Wire.Flag(r, "ok") && Wire.Number(r, "bytes") == 2, "Append chunk after creating the directory: " + Wire.Text(r, "error"));
                Assert(Convert.ToBase64String(File.ReadAllBytes(nested)) == Convert.ToBase64String(nestedData), "Nested upload byte round trip");
                // get_file reads a file that another process is still writing, if the writer allows readers.
                string live = Path.Combine(dir, "live.log");
                using (var writer = new FileStream(live, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) {
                    byte[] one = Encoding.ASCII.GetBytes("first line\r\n"), two = Encoding.ASCII.GetBytes("second line\r\n");
                    writer.Write(one, 0, one.Length); writer.Flush();
                    r = relay.Call(Wire.Map("type", "get_file", "path", live, "offset", 0, "length", 1000));
                    Assert(Wire.Flag(r, "ok"), "Live file must be readable: " + Wire.Text(r, "error"));
                    Assert(Decode(r, "data_b64") == "first line\r\n" && Wire.Flag(r, "eof"), "Live file bytes written so far");
                    writer.Write(two, 0, two.Length); writer.Flush();
                    r = relay.Call(Wire.Map("type", "get_file", "path", live, "offset", one.Length, "length", 1000));
                    Assert(Wire.Flag(r, "ok") && Decode(r, "data_b64") == "second line\r\n" && Wire.Number(r, "size") == one.Length + two.Length, "Live file read continues while the writer keeps writing");
                }
                // put_file does not lock out a reader that already has the file open, like the PowerShell agent.
                using (var reader = new FileStream(nested, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                    r = relay.Call(Wire.Map("type", "put_file", "path", nested, "data_b64", Convert.ToBase64String(nestedData, 0, 1), "append", true));
                    Assert(Wire.Flag(r, "ok"), "Append while another process reads the file: " + Wire.Text(r, "error"));
                }
                int pollsBefore = relay.Polls;
                r = relay.Call(Run("Start-Sleep -Seconds 4; [Console]::Write('slept')", 15));
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == "slept", "Long operation result");
                Assert(relay.Polls - pollsBefore <= 4, "A busy client must wait for its operation instead of polling in a loop, polls: " + (relay.Polls - pollsBefore));
                string counter = Path.Combine(dir, "executed.txt"); relay.FailFirstResult = true;
                r = relay.Call(Run("Add-Content -LiteralPath '" + counter + "' -Value once", 10));
                Assert(File.ReadAllLines(counter).Length == 1, "Result retries must not repeat execution");
                string late = Path.Combine(dir, "timeout-late"), started = Path.Combine(dir, "timeout-started");
                r = relay.Call(Run(ChildCommand(late, started), 1));
                Assert(Wire.Flag(r, "timed_out") && r["exit_code"] == null, "Timeout result");
                Thread.Sleep(3500); Assert(!File.Exists(late), "Timeout must kill descendants");
                late = Path.Combine(dir, "end-late"); started = Path.Combine(dir, "end-started");
                relay.Queue(Run(ChildCommand(late, started), 20)); WaitFile(started); relay.End = true; relay.WaitExit();
                Thread.Sleep(3500); Assert(!File.Exists(late), "Operator end must kill descendants");
                Console.WriteLine("PASS commands, Unicode, bounded output, file chunks, retry deduplication, timeout and operator-end process trees");
            }
            using (var relay = new FakeRelay()) {
                relay.Start(); string late = Path.Combine(dir, "close-late"), started = Path.Combine(dir, "close-started");
                relay.Queue(Run(ChildCommand(late, started), 20)); WaitFile(started); relay.Agent.Stop(); relay.WaitExit();
                Thread.Sleep(3500); Assert(!File.Exists(late) && relay.End, "Customer close must kill descendants and end relay access");
                Console.WriteLine("PASS customer close cancels processes and ends relay access");
            }
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 800; relay.Start(); relay.WaitExit(); Assert(relay.End, "Local expiry must end access");
                Console.WriteLine("PASS local fixed expiry");
            }
            // A PC clock three hours ahead of the relay: the absolute startup deadline in the
            // file is then already in the past on the PC. The relative budget must still win.
            using (var relay = new FakeRelay(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "startup_expires_at", Client.UnixNow() - 10800000 + 60000, "startup_ms", 60000))) {
                relay.ClockSkew = 10800000; relay.Lifetime = 600000; relay.Start();
                for (int i = 0; i < 100 && relay.Agent.ExpiresLocal == DateTime.MinValue; i++) Thread.Sleep(50);
                Assert(Math.Abs((relay.Agent.ExpiresLocal.ToUniversalTime() - DateTime.UtcNow).TotalMilliseconds - 600000) < 5000, "Ends-by-itself time must come from the relay's remaining time on the PC's own clock");
                var r = relay.Call(Run("[Console]::Write('ok')", 10));
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == "ok", "A fast PC clock must not stop the client");
                Console.WriteLine("PASS fast PC clock keeps the startup and session deadlines relative");
            }
            using (var relay = new FakeRelay(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "startup_expires_at", Client.UnixNow() - 10800000 + 60000))) {
                relay.Refuse = true; relay.Launch();
                relay.WaitExit(); // no handshake can finish, so only the startup deadline can stop it, and an absolute one that is already past does
                Console.WriteLine("PASS absolute startup deadline is only a fallback");
            }
            using (var relay = new FakeRelay()) {
                relay.Start(); relay.Agent.EndRemote = false; relay.Agent.Stop(); relay.WaitExit();
                Assert(!relay.End, "An explicitly prepared Windows shutdown must preserve the relay session");
                Console.WriteLine("PASS prepared shutdown preserves relay access for reconnection");
            }
            var resume = Wire.Map("sid", Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"), "restart_resume", true, "resume_expires_at", Client.UnixNow() + 60000);
            string resumePath = RestartResume.PathFor(resume);
            Assert(RestartResume.Valid(resume, resumePath), "Scoped, unexpired reconnect must be valid");
            Assert(!RestartResume.Valid(resume, Path.Combine(dir, "agent.exe")), "A downloaded file cannot bypass consent with a resume switch");
            resume["resume_expires_at"] = Client.UnixNow() - 1;
            Assert(!RestartResume.Valid(resume, resumePath), "Expired reconnect must be refused");
            resume["resume_expires_at"] = Client.UnixNow() + 86401000;
            Assert(!RestartResume.Valid(resume, resumePath), "Reconnect cannot exceed 24 hours");
            try {
                RestartResume.Arm(resume);
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\RunOnce"))
                    Assert((string)key.GetValue(RestartResume.ValueName(resume)) == "\"" + resumePath + "\" --resume", "One-time sign-in command");
            } finally { RestartResume.Disarm(resume); }
            using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\RunOnce"))
                Assert(key.GetValue(RestartResume.ValueName(resume)) == null, "End must remove automatic reconnect");
            resume["resume_expires_at"] = Client.UnixNow() + 60000;
            try {
                Assert(!RestartResume.HasAdministratorConsent(resume), "Administrator resume needs advance consent");
                RestartResume.Arm(resume, true);
                Assert(RestartResume.HasAdministratorConsent(resume), "Preparation can consent to one administrator reconnect");
                long expiry = Wire.Number(resume, "resume_expires_at");
                resume["resume_expires_at"] = expiry + 1;
                Assert(!RestartResume.HasAdministratorConsent(resume), "Approval cannot extend or change the deadline");
                resume["resume_expires_at"] = expiry;
                RestartResume.Disarm(resume);
                Assert(!RestartResume.HasAdministratorConsent(resume), "Consuming or cancelling reconnect clears administrator consent");
                RestartResume.Arm(resume, false);
                Assert(!RestartResume.HasAdministratorConsent(resume), "Normal-user preparation cannot preapprove administrator access");
            } finally { RestartResume.Disarm(resume); }
            Console.WriteLine("PASS reconnect path/deadline constraints and one-time startup registration/removal");
            // The downloaded PE overlay must be readable by the actual .NET client.
            string overlay = Path.Combine(dir, "overlay.exe"); byte[] cfg = Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "origin", "https://support.example.com", "startup_expires_at", Client.UnixNow() + 10000)));
            using (var f = File.Create(overlay)) { f.WriteByte(77); f.WriteByte(90); f.Write(cfg, 0, cfg.Length); byte[] n = BitConverter.GetBytes(cfg.Length); f.Write(n, 0, n.Length); byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); f.Write(footer, 0, footer.Length); }
            Assert(Wire.Text(Wire.ReadConfig(overlay), "sid") == new string('a', 64), "Overlay configuration");
            Console.WriteLine("PASS executable session overlay"); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally { Directory.Delete(dir, true); }
    }
}
