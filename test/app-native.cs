// Compile with src/agent-app.cs, /main:AppTests and the same v4 references.
// Runs the real HTTP client and native Job containment on a Windows test host.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using SupportMcp;
using Screen = SupportMcp.Screen;

public sealed class FakeRelay : IDisposable {
    readonly HttpListener listener = new HttpListener();
    readonly object gate = new object();
    readonly Thread server;
    public readonly string Origin;
    public volatile bool End, FailFirstResult;
    public int Results, Polls;
    public bool? Elevated;
    public int Lifetime = 30000;
    // One pending frame per lane and the results by id, like the relay.
    readonly Dictionary<string, Dictionary<string, object>> frames = new Dictionary<string, Dictionary<string, object>>(), results = new Dictionary<string, Dictionary<string, object>>();
    string lastQueued = "";
    public volatile bool Closed;
    public int Park = 25000; // how long a poll waits for a frame, like the relay's 25 s
    public Dictionary<string, object> Hello;
    public volatile string[] LastBusy = new string[0];
    public volatile Dictionary<string, object> LastPoll;
    public readonly Client Agent;
    readonly Thread agentThread;
    public readonly ManualResetEvent Connected = new ManualResetEvent(false);
    // Simulates a PC clock that runs ahead of the relay by this many milliseconds.
    public long ClockSkew;
    public volatile bool Refuse; // drop every request, so the client can never complete a handshake
    public volatile int RejectOk; // answer every result with ok:true with this status (400, 413), like a relay that refuses it
    public readonly Dictionary<string, int> ResultCounts = new Dictionary<string, int>();
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
                else if (Wire.Text(b, "type") == "hello") { Hello = b; Elevated = Wire.Flag(b, "elevated"); long serverNow = Client.UnixNow() - ClockSkew; reply = Wire.Map("type", "welcome", "generation", 1, "server_time", serverNow, "expires_at", serverNow + Lifetime); Connected.Set(); }
                else if (Wire.Text(b, "type") == "end") { End = true; reply = Wire.Map("type", "end"); }
                else if (Wire.Text(b, "type") == "result") {
                    Results++;
                    { string seen = Wire.Text(b, "id"); int n; ResultCounts[seen] = ResultCounts.TryGetValue(seen, out n) ? n + 1 : 1; }
                    if (RejectOk != 0 && Wire.Flag(b, "ok")) { ctx.Response.StatusCode = RejectOk; ctx.Response.Close(); return; }
                    if (FailFirstResult) { FailFirstResult = false; ctx.Response.StatusCode = 500; ctx.Response.Close(); return; }
                    string rid = Wire.Text(b, "id"); results[rid] = b;
                    foreach (string lane in new List<string>(frames.Keys)) if (Wire.Text(frames[lane], "id") == rid) frames.Remove(lane);
                    reply = Wire.Map("type", "ack"); Monitor.PulseAll(gate);
                } else {
                    Polls++; var busy = new List<string>();
                    if (b.ContainsKey("busy_lanes")) foreach (object l in (System.Collections.ArrayList)b["busy_lanes"]) busy.Add((string)l); else if (Wire.Flag(b, "busy")) busy.Add("cmd");
                    LastBusy = busy.ToArray(); LastPoll = b; var until = DateTime.UtcNow.AddMilliseconds(Park); reply = null;
                    while (reply == null) {
                        if (End) reply = Wire.Map("type", "end");
                        foreach (var kv in frames) if (reply == null && !busy.Contains(kv.Key)) reply = kv.Value;
                        if (reply == null && (busy.Count >= 2 || Closed || DateTime.UtcNow >= until)) reply = Wire.Map("type", "idle");
                        if (reply == null) Monitor.Wait(gate, 50);
                    }
                }
            }
            if (Wire.Text(reply, "type") == "idle") Thread.Sleep(50);
            byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(reply));
            ctx.Response.ContentType = "application/json"; ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length); ctx.Response.Close();
        } catch (Exception) { try { ctx.Response.Abort(); } catch { } }
    }
    public string Queue(Dictionary<string, object> b) {
        string type = Wire.Text(b, "type"), lane = type == "screen" || type == "control" ? "screen" : "cmd";
        lock (gate) { b["id"] = lastQueued = Guid.NewGuid().ToString(); b["lane"] = lane; frames[lane] = b; Monitor.PulseAll(gate); return lastQueued; }
    }
    public Dictionary<string, object> WaitResult(int seconds = 15) { return WaitResult(lastQueued, seconds); }
    public Dictionary<string, object> WaitResult(string id, int seconds) {
        lock (gate) { var until = DateTime.UtcNow.AddSeconds(seconds); while (!results.ContainsKey(id) && DateTime.UtcNow < until) Monitor.Wait(gate, 100); if (!results.ContainsKey(id)) throw new Exception("No result: " + Agent.LastError); return results[id]; }
    }
    public bool HasResult(string id) { lock (gate) return results.ContainsKey(id); }
    public bool WaitBusy(Func<string[], bool> test, int ms) { var until = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < until) { if (test(LastBusy)) return true; Thread.Sleep(20); } return test(LastBusy); }
    public Dictionary<string, object> Call(Dictionary<string, object> b) { long t = Wire.Number(b, "timeout_s"); Queue(b); return WaitResult((int)Math.Max(15, t + 10)); }
    public void WaitExit() { if (!agentThread.Join(20000)) throw new Exception("Client failed to stop"); if (Agent.LastError != "") throw new Exception(Agent.LastError); }
    public void Dispose() { Closed = true; Agent.Stop(); if (agentThread.ThreadState != System.Threading.ThreadState.Unstarted) agentThread.Join(20000); Agent.Dispose(); listener.Close(); server.Join(1000); }
}

// A fake /device/ relay for DeviceLink, on an HttpListener like FakeRelay. Status and Body are what it answers next;
// LastPath, LastAuth and LastJson record the request it saw; Refuse drops the connection, so the client reads offline.
// /install is routed apart and answers with bytes: InstallBody with InstallStatus (and InstallLocation for a redirect);
// InstallCut sends half of the body it announced and drops the connection; InstallChunked sends the body chunked, with
// no Content-Length; InstallTrickleMs sends it 1 KB at a time with that pause between. InstallHits counts the
// downloads, and the Install* fields record the last download request.
sealed class FakeDevice : IDisposable {
    public volatile byte[] InstallBody; public volatile int InstallStatus = 200, InstallTrickleMs; public volatile bool InstallCut, InstallChunked;
    public volatile string InstallLocation, InstallMethod = "", InstallQuery = "", InstallOrigin, InstallType;
    public int InstallHits, InstallBodyLength = -1;
    readonly HttpListener listener = new HttpListener();
    readonly Thread server;
    public readonly string Origin;
    public volatile int Status = 200;
    public volatile string Body = "{\"protocol\":1}";
    public volatile string LastPath = "", LastAuth, LastJson = "";
    public volatile bool Refuse;
    // A hello can answer with its own body after a delay, so a test can hold one in flight while another request runs.
    public volatile string HelloBody; public volatile int HelloDelayMs;
    // /agent, a saved PC's session (PR 6): every request is logged as {query, auth, attach, body}. A decline or an end is
    // answered with end (DeclineStatus may make a decline fail), a hello with a welcome naming AgentDriver, a poll with
    // the next queued frame or, after a short wait, idle, and a result with an ack (kept by id).
    public readonly List<Dictionary<string, object>> AgentLog = new List<Dictionary<string, object>>();
    public volatile string AgentDriver = "tech@example.com"; public volatile int DeclineStatus = 200;
    readonly Queue<Dictionary<string, object>> agentFrames = new Queue<Dictionary<string, object>>();
    readonly Dictionary<string, Dictionary<string, object>> agentResults = new Dictionary<string, Dictionary<string, object>>();
    public string AgentQueue(Dictionary<string, object> frame) {
        string type = Wire.Text(frame, "type"); frame["id"] = Guid.NewGuid().ToString(); frame["lane"] = type == "screen" || type == "control" ? "screen" : "cmd";
        lock (agentFrames) { agentFrames.Enqueue(frame); agentTypes[(string)frame["id"]] = type; } return (string)frame["id"];
    }
    readonly Dictionary<string, string> agentTypes = new Dictionary<string, string>();
    public Dictionary<string, object> AgentResult(string id, int seconds) {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < until) { lock (agentResults) if (agentResults.ContainsKey(id)) return agentResults[id]; Thread.Sleep(50); }
        string t; lock (agentFrames) agentTypes.TryGetValue(id, out t);
        throw new Exception("no result in " + seconds + " s for the " + (t ?? "?") + " frame " + id);
    }
    // The logged /agent requests of one type ("hello", "decline", "end", ...).
    public List<Dictionary<string, object>> Agent(string type) {
        var list = new List<Dictionary<string, object>>();
        lock (AgentLog) foreach (var e in AgentLog) if (Wire.Text((Dictionary<string, object>)e["body"], "type") == type) list.Add(e);
        return list;
    }
    public bool WaitAgent(string type, int count, int ms) { var until = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < until) { if (Agent(type).Count >= count) return true; Thread.Sleep(50); } return Agent(type).Count >= count; }
    void AgentReply(HttpListenerContext ctx) {
        string raw; using (var r = new StreamReader(ctx.Request.InputStream)) raw = r.ReadToEnd();
        var b = Wire.Json().Deserialize<Dictionary<string, object>>(raw);
        lock (AgentLog) AgentLog.Add(Wire.Map("query", ctx.Request.Url.Query, "auth", ctx.Request.Headers["Authorization"], "attach", ctx.Request.Headers["X-Attach-Key"], "body", b));
        string type = Wire.Text(b, "type"); int code = 200; Dictionary<string, object> reply;
        if (type == "decline") { code = DeclineStatus; reply = Wire.Map("type", "end"); }
        else if (type == "end") reply = Wire.Map("type", "end");
        else if (type == "hello") reply = Wire.Map("type", "welcome", "generation", 1, "server_time", Client.UnixNow(), "expires_at", Client.UnixNow() + 600000, "driver", AgentDriver);
        else if (type == "result") { lock (agentResults) agentResults[Wire.Text(b, "id")] = b; reply = Wire.Map("type", "ack"); }
        else {
            Dictionary<string, object> next = null;
            for (int i = 0; i < 6 && next == null; i++) { lock (agentFrames) if (agentFrames.Count > 0) next = agentFrames.Dequeue(); if (next == null) Thread.Sleep(50); }
            reply = next ?? Wire.Map("type", "idle"); reply["driver"] = AgentDriver;
        }
        byte[] bytes = Encoding.UTF8.GetBytes(Wire.Json().Serialize(reply));
        ctx.Response.StatusCode = code; ctx.Response.ContentType = "application/json"; ctx.Response.ContentLength64 = bytes.Length;
        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length); ctx.Response.Close();
    }
    public FakeDevice() {
        var tcp = new TcpListener(IPAddress.Loopback, 0); tcp.Start(); int port = ((IPEndPoint)tcp.LocalEndpoint).Port; tcp.Stop();
        Origin = "http://127.0.0.1:" + port;
        listener.Prefixes.Add(Origin + "/"); listener.Start();
        server = new Thread(Serve); server.IsBackground = true; server.Start();
    }
    void Serve() {
        try { while (listener.IsListening) { var ctx = listener.GetContext(); ThreadPool.QueueUserWorkItem(delegate { Reply(ctx); }); } }
        catch (HttpListenerException) { } catch (ObjectDisposedException) { }
    }
    void Reply(HttpListenerContext ctx) {
        try {
            if (Refuse) { ctx.Response.Abort(); return; }
            if (ctx.Request.Url.AbsolutePath == "/install") { Install(ctx); return; }
            if (ctx.Request.Url.AbsolutePath == "/agent") { AgentReply(ctx); return; }
            string path = ctx.Request.Url.AbsolutePath, body = path == "/device/hello" && HelloBody != null ? HelloBody : Body;
            LastPath = path; LastAuth = ctx.Request.Headers["Authorization"];
            using (var r = new StreamReader(ctx.Request.InputStream)) LastJson = r.ReadToEnd();
            if (path == "/device/hello" && HelloDelayMs > 0) Thread.Sleep(HelloDelayMs);
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            ctx.Response.StatusCode = Status; ctx.Response.ContentType = "application/json"; ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length); ctx.Response.Close();
        } catch (Exception) { try { ctx.Response.Abort(); } catch (Exception) { } }
    }
    void Install(HttpListenerContext ctx) {
        Interlocked.Increment(ref InstallHits);
        InstallMethod = ctx.Request.HttpMethod; InstallQuery = ctx.Request.Url.Query; InstallOrigin = ctx.Request.Headers["Origin"]; InstallType = ctx.Request.ContentType;
        using (var seen = new MemoryStream()) { ctx.Request.InputStream.CopyTo(seen); InstallBodyLength = (int)seen.Length; }
        byte[] body = InstallBody ?? new byte[0];
        ctx.Response.StatusCode = InstallStatus;
        if (InstallLocation != null) ctx.Response.RedirectLocation = InstallLocation;
        ctx.Response.ContentType = "application/octet-stream";
        if (InstallChunked) ctx.Response.SendChunked = true; else ctx.Response.ContentLength64 = body.Length;
        if (InstallTrickleMs > 0) {
            for (int i = 0; i < body.Length; i += 1024) { ctx.Response.OutputStream.Write(body, i, Math.Min(1024, body.Length - i)); ctx.Response.OutputStream.Flush(); Thread.Sleep(InstallTrickleMs); }
            ctx.Response.Close(); return;
        }
        if (InstallCut) { ctx.Response.OutputStream.Write(body, 0, body.Length / 2); ctx.Response.OutputStream.Flush(); ctx.Response.Abort(); return; }
        ctx.Response.OutputStream.Write(body, 0, body.Length); ctx.Response.Close();
    }
    public Dictionary<string, object> Sent() { return Wire.Json().Deserialize<Dictionary<string, object>>(LastJson); }
    public void Dispose() { try { listener.Close(); } catch (Exception) { } server.Join(1000); }
}

// A loopback WebSocket server for the doorbell (Doorbell), on plain TCP. It answers the upgrade (Status, or a wrong
// accept value with BadAccept), records the request, counts the client's frames (Pings, Pongs, Unmasked: client
// frames without a mask), answers its pings unless NoPong, and lets the test send raw server frames (Send) on the
// newest connection. Opened and Closed are set per connection.
sealed class FakeBell : IDisposable {
    readonly TcpListener listener; readonly Thread acceptor;
    public readonly string Origin;
    public volatile int Status = 101; public volatile bool BadAccept, NoPong;
    public volatile string LastRequest = "";
    public int Upgrades, Pings, Pongs, Unmasked; public volatile string LastPong = "";
    volatile NetworkStream current; readonly object writeGate = new object();
    public readonly AutoResetEvent Opened = new AutoResetEvent(false), Closed = new AutoResetEvent(false);
    public FakeBell() {
        listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        Origin = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port;
        acceptor = new Thread(delegate() {
            while (true) {
                TcpClient c; try { c = listener.AcceptTcpClient(); } catch (Exception) { return; }
                var t = new Thread(delegate() { Serve(c); }); t.IsBackground = true; t.Start();
            }
        });
        acceptor.IsBackground = true; acceptor.Start();
    }
    static byte[] Read(Stream s, int n) { var b = new byte[n]; int got = 0; while (got < n) { int r = s.Read(b, got, n - got); if (r <= 0) throw new EndOfStreamException(); got += r; } return b; }
    // The RFC 6455 accept value, computed here and not by the app.
    public static string Accept(string key) { using (var sha = System.Security.Cryptography.SHA1.Create()) return Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))); }
    void Serve(TcpClient c) {
        using (c) {
            try {
                var s = c.GetStream(); var head = new StringBuilder(); var one = new byte[1];
                while (!head.ToString().EndsWith("\r\n\r\n")) { if (s.Read(one, 0, 1) != 1) return; head.Append((char)one[0]); }
                LastRequest = head.ToString(); string key = "";
                foreach (string line in LastRequest.Split(new string[] { "\r\n" }, StringSplitOptions.None)) if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)) key = line.Substring(18).Trim();
                if (Status != 101) { byte[] no = Encoding.ASCII.GetBytes("HTTP/1.1 " + Status + " Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); s.Write(no, 0, no.Length); return; }
                byte[] yes = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + (BadAccept ? Accept(key + "x") : Accept(key)) + "\r\n\r\n");
                s.Write(yes, 0, yes.Length);
                Interlocked.Increment(ref Upgrades); current = s; Opened.Set();
                while (true) {
                    byte[] h = Read(s, 2); int op = h[0] & 0x0F, len = h[1] & 0x7F;
                    if ((h[1] & 0x80) == 0) Interlocked.Increment(ref Unmasked);
                    if (len == 126) { byte[] e = Read(s, 2); len = (e[0] << 8) | e[1]; }
                    byte[] mask = (h[1] & 0x80) != 0 ? Read(s, 4) : new byte[4], data = Read(s, len);
                    for (int i = 0; i < len; i++) data[i] ^= mask[i % 4];
                    if (op == 9) { Interlocked.Increment(ref Pings); if (!NoPong) Send(Frame(10, data, true, false)); }
                    else if (op == 10) { Interlocked.Increment(ref Pongs); LastPong = Encoding.UTF8.GetString(data); }
                    else if (op == 8) break;
                }
            } catch (Exception) { }
            finally { Closed.Set(); }
        }
    }
    public void Send(byte[] raw) { var s = current; if (s == null) return; try { lock (writeGate) s.Write(raw, 0, raw.Length); } catch (Exception) { } }
    // A server frame: unmasked unless mask, FIN unless !fin, with a 2-byte length above 125.
    public static byte[] Frame(int op, byte[] payload, bool fin, bool mask) {
        var ms = new MemoryStream(); ms.WriteByte((byte)((fin ? 0x80 : 0) | op));
        int m = mask ? 0x80 : 0;
        if (payload.Length > 125) { ms.WriteByte((byte)(m | 126)); ms.WriteByte((byte)(payload.Length >> 8)); ms.WriteByte((byte)(payload.Length & 0xFF)); } else ms.WriteByte((byte)(m | payload.Length));
        if (mask) { var k = new byte[4]; ms.Write(k, 0, 4); } // a zero mask: the bytes stay as they are
        ms.Write(payload, 0, payload.Length); return ms.ToArray();
    }
    public static byte[] Text(string t) { return Frame(1, Encoding.UTF8.GetBytes(t), true, false); }
    public void Dispose() { try { listener.Stop(); } catch (Exception) { } var s = current; if (s != null) try { s.Dispose(); } catch (Exception) { } }
}

// A throwaway P-256 key made at run time, so the tests can sign any release note. Xy is its public key in the form the
// app carries (ReleaseKey). ECDsaCng.SignData gives the 64-byte r||s form the app takes.
sealed class TestSigner : IDisposable {
    readonly System.Security.Cryptography.ECDsaCng key;
    public readonly string Xy;
    public TestSigner() {
        key = new System.Security.Cryptography.ECDsaCng(256);
        key.HashAlgorithm = System.Security.Cryptography.CngAlgorithm.Sha256;
        byte[] blob = key.Key.Export(System.Security.Cryptography.CngKeyBlobFormat.EccPublicBlob), xy = new byte[64];
        Buffer.BlockCopy(blob, 8, xy, 0, 64); Xy = Convert.ToBase64String(xy);
    }
    public string Sign(string note) { return Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(note))); }
    public void Dispose() { key.Dispose(); }
}

// Reads a service's failure actions back the way Windows stores them (QueryServiceConfig2, levels 2 and 4), and makes
// a throwaway demand-start service for the service-control test.
static class ScmProbe {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenSCManager(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateService(IntPtr scm, string name, string display, uint access, uint type, uint start, uint error, string path, string group, IntPtr tag, string dependencies, string account, string password);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenService(IntPtr scm, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool CloseServiceHandle(IntPtr h);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryServiceConfig2(IntPtr service, uint level, IntPtr buffer, int size, out int needed);
    [StructLayout(LayoutKind.Sequential)] struct FailureActions { public uint ResetPeriod; public IntPtr RebootMessage, Command; public uint Count; public IntPtr Actions; }
    [StructLayout(LayoutKind.Sequential)] struct ScAction { public int Type; public uint Delay; }
    public sealed class Actions { public uint Reset; public string Command; public readonly List<string> Steps = new List<string>(); public bool NonCrash; }
    // A demand-start (3), own-process (0x10) service that is never started.
    public static void Create(string name, string binary) {
        IntPtr scm = OpenSCManager(null, null, 0x0003); if (scm == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try { IntPtr s = CreateService(scm, name, name, 0xF01FF, 0x10, 3, 1, binary, null, IntPtr.Zero, null, null, null); if (s == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(); CloseServiceHandle(s); }
        finally { CloseServiceHandle(scm); }
    }
    public static Actions Query(string name) {
        IntPtr scm = OpenSCManager(null, null, 0x0001); if (scm == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try {
            IntPtr s = OpenService(scm, name, 0x0001); if (s == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            IntPtr buf = Marshal.AllocHGlobal(8192);
            try {
                var r = new Actions(); int needed;
                if (!QueryServiceConfig2(s, 2, buf, 8192, out needed)) throw new System.ComponentModel.Win32Exception();
                var fa = (FailureActions)Marshal.PtrToStructure(buf, typeof(FailureActions));
                r.Reset = fa.ResetPeriod; r.Command = fa.Command == IntPtr.Zero ? null : Marshal.PtrToStringUni(fa.Command);
                int size = Marshal.SizeOf(typeof(ScAction));
                for (int i = 0; i < (int)fa.Count; i++) {
                    var a = (ScAction)Marshal.PtrToStructure(new IntPtr(fa.Actions.ToInt64() + i * size), typeof(ScAction));
                    r.Steps.Add(a.Type + "/" + a.Delay);
                }
                if (!QueryServiceConfig2(s, 4, buf, 8192, out needed)) throw new System.ComponentModel.Win32Exception();
                r.NonCrash = Marshal.ReadInt32(buf) != 0;
                return r;
            } finally { Marshal.FreeHGlobal(buf); CloseServiceHandle(s); }
        } finally { CloseServiceHandle(scm); }
    }
}

public static class AppTests {
    static void Assert(bool ok, string detail) { if (!ok) throw new Exception(detail); }
    // Windows adds Synchronize to an allow rule it reads back (a FileSecurity's ReadAndExecute comes back as
    // "ReadAndExecute, Synchronize"), so the update tests compare rights without it, and only without it.
    static FileSystemRights NoSync(FileSystemRights r) { return r & ~FileSystemRights.Synchronize; }
    // Test cleanup never throws: a file a failed test left open must not hide that failure behind another.
    static void TryDeleteDir(string dir) { try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch (Exception e) { Console.WriteLine("NOTE could not remove " + dir + ": " + e.Message); } }
    static void m3Release(System.Threading.Mutex m) { try { m.ReleaseMutex(); } catch (Exception) { } }
    static string Decode(Dictionary<string, object> r, string key) { return Encoding.UTF8.GetString(Convert.FromBase64String(Wire.Text(r, key))); }
    static Dictionary<string, object> Run(string command, int timeout) { return Wire.Map("type", "run", "command", command, "timeout_s", timeout); }
    static void WaitFile(string path) { var end = DateTime.UtcNow.AddSeconds(10); while (!File.Exists(path) && DateTime.UtcNow < end) Thread.Sleep(50); Assert(File.Exists(path), "Command did not start"); }
    static string ChildCommand(string sentinel, string started) {
        string script = "Start-Sleep -Seconds 3; Set-Content -LiteralPath '" + sentinel.Replace("'", "''") + "' -Value late";
        return "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) + "'; Set-Content -LiteralPath '" + started.Replace("'", "''") + "' -Value started; Start-Sleep -Seconds 20";
    }

    static int[] Vks(string keys, int index) { return KeySpec.Parse(keys)[index]; }
    static void Throws(Action action, string part) {
        try { action(); } catch (ArgumentException e) { Assert(e.Message.Contains(part), "Wrong message: " + e.Message); return; }
        throw new Exception("Expected an error containing: " + part);
    }
    static void ThrowsData(Action action, string detail) {
        try { action(); } catch (InvalidDataException) { return; }
        throw new Exception("Expected an InvalidDataException: " + detail);
    }
    // An exe with a footer, built like the relay's overlay: body bytes, the JSON, its length, then the magic string.
    static byte[] Overlay(Dictionary<string, object> cfg) {
        byte[] body = new byte[] { 77, 90, 1, 2, 3 }, json = Encoding.UTF8.GetBytes(Wire.Json().Serialize(cfg));
        var ms = new MemoryStream(); ms.Write(body, 0, body.Length); ms.Write(json, 0, json.Length);
        byte[] n = BitConverter.GetBytes(json.Length); ms.Write(n, 0, n.Length);
        byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); ms.Write(footer, 0, footer.Length);
        return ms.ToArray();
    }
    static List<Dictionary<string, object>> BadDeviceFooters() {
        var list = new List<Dictionary<string, object>>();
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH23", "workspace", "acme")); // both
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH2")); // short
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH0I")); // 0 and I are not in the alphabet
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "workspace", "Acme")); // uppercase slug
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "workspace", "")); // empty slug
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com", "extra", "1")); // an unknown field
        list.Add(Wire.Map("kind", "device", "origin", "http://evil.example.com")); // http that is not loopback
        list.Add(Wire.Map("kind", "device", "origin", "https://support.example.com/path")); // an origin with a path
        list.Add(Wire.Map("kind", "other", "origin", "https://support.example.com")); // not a device kind
        list.Add(Wire.Map("kind", "device")); // no origin
        return list;
    }
    // ReadConfig takes a session footer and refuses a device footer; ReadDevice does the reverse. The kind is read first.
    static void FooterReaderTests() {
        byte[] session = Overlay(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "origin", "https://support.example.com"));
        Assert(Wire.Kind(session) == "" && Wire.Text(Wire.ReadConfig(session), "sid") == new string('a', 64), "A session footer parses as a session");
        ThrowsData(delegate { Wire.ReadDevice(session); }, "a session footer is not a setup footer");
        byte[] device = Overlay(Wire.Map("kind", "device", "origin", "https://support.example.com", "code", "ABCDE-FGH23"));
        Assert(Wire.Kind(device) == "device", "The kind is read first");
        var d = Wire.ReadDevice(device);
        Assert(Wire.Text(d, "code") == "ABCDE-FGH23" && Wire.Text(d, "origin") == "https://support.example.com", "A device footer with a code parses");
        ThrowsData(delegate { Wire.ReadConfig(device); }, "no session role runs on a device footer");
        Assert(Wire.Text(Wire.ReadDevice(Overlay(Wire.Map("kind", "device", "origin", "https://support.example.com", "workspace", "acme-1"))), "workspace") == "acme-1", "A workspace footer parses");
        Assert(!Wire.ReadDevice(Overlay(Wire.Map("kind", "device", "origin", "https://support.example.com"))).ContainsKey("code"), "A plain device footer carries no code");
        Assert(Wire.Text(Wire.ReadDevice(Overlay(Wire.Map("kind", "device", "origin", "http://127.0.0.1:8787"))), "origin") == "http://127.0.0.1:8787", "Loopback http is allowed for a device footer");
        foreach (Dictionary<string, object> bad in BadDeviceFooters()) ThrowsData(delegate { Wire.ReadDevice(Overlay(bad)); }, Wire.Json().Serialize(bad));
        Console.WriteLine("PASS a setup footer parses, a session footer still parses, and each footer reader refuses the other");
    }
    // DeviceLink against a fake /device/ relay: every status maps, the key goes in the header, and a drop is offline.
    static void DeviceLinkTests() {
        using (var relay = new FakeDevice()) {
            var link = new DeviceLink(relay.Origin);
            relay.Status = 201; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "status", "active", "workspace", "default", "device_id", new string('a', 20), "key", "smd1.default.id.secret"));
            var a = link.Pair(Wire.Map("code", "ABCDE-FGH23", "name", "Front desk", "access", "any", "control", "full"));
            Assert(a.Result == DeviceLink.DeviceResult.Ok && a.Ok && Wire.Text(a.Body, "key").StartsWith("smd1.") && Wire.Text(a.Body, "status") == "active", "A 201 pair is Ok with the key and the device id");
            Assert(relay.LastPath == "/device/pair" && relay.LastAuth == null, "pair posts to /device/pair with no key");
            Assert(Wire.Number(relay.Sent(), "protocol") == 1 && Wire.Text(relay.Sent(), "code") == "ABCDE-FGH23", "Every request carries protocol 1");
            relay.Status = 202; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "status", "pending", "confirm", "482913", "key", "smd1.default.id.secret", "expires_at", 1));
            Assert(link.Pair(Wire.Map("workspace", "acme")).Result == DeviceLink.DeviceResult.Pending, "A 202 pair is Pending");
            relay.Status = 404; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "code_invalid", "message", "this code is not valid")));
            Assert(link.Pair(Wire.Map("code", "ZZZZZ-ZZZZZ")).Result == DeviceLink.DeviceResult.CodeInvalid, "A 404 code_invalid is CodeInvalid");
            relay.Status = 400; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "bad_request", "message", "send code or workspace")));
            var refused = link.Pair(Wire.Map());
            Assert(refused.Result == DeviceLink.DeviceResult.Refused && refused.Message == "send code or workspace", "A refusal carries the relay's own message");
            relay.Status = 200; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "workspace", "default", "status", "active", "name", "PC", "access", "ask", "control", "limited", "site_id", null)));
            var h = link.Hello("smd1.default.id.secret", Wire.Map("os", "Windows 11", "machine", "POS-1", "app_version", "0.4.0"));
            Assert(h.Result == DeviceLink.DeviceResult.Ok && relay.LastAuth == "Bearer smd1.default.id.secret" && relay.LastPath == "/device/hello", "hello sends the key in the Authorization header, never the URL");
            Assert(Wire.Text(h.Body["device"] as Dictionary<string, object>, "access") == "ask", "hello returns the device the relay sent");
            relay.Status = 401; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "device_unknown", "message", "this key is not valid")));
            Assert(link.Hello("smd1.k", Wire.Map()).Result == DeviceLink.DeviceResult.Removed, "A 401 is Removed");
            relay.Status = 426; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "protocol_unsupported", "message", "update needed"), "supported", Wire.Map("min", 2, "max", 2)));
            Assert(link.Hello("smd1.k", Wire.Map()).Result == DeviceLink.DeviceResult.UpdateNeeded, "A 426 is UpdateNeeded");
            relay.Status = 200; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "status", "active")));
            link.Update("smd1.k", Wire.Map("access", "any"));
            Assert(relay.LastPath == "/device/update" && Wire.Text(relay.Sent(), "access") == "any" && relay.LastAuth == "Bearer smd1.k", "update posts the change with the key");
            relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "removed", true));
            link.Leave("smd1.k");
            Assert(relay.LastPath == "/device/leave" && relay.Sent().Count == 1 && Wire.Number(relay.Sent(), "protocol") == 1, "leave posts only the protocol, with the key");
            relay.Refuse = true;
            Assert(link.Hello("smd1.k", Wire.Map()).Result == DeviceLink.DeviceResult.Offline && link.Hello("smd1.k", Wire.Map()).Status == 0, "A dropped connection is Offline with no status");
        }
        Console.WriteLine("PASS the device client speaks the /device/ wire: pair, check-in, update and leave, with status mapping and offline");
    }
    // The setup wizard's pure rules: code normalisation, step validation, the answers argument and the exit-code map.
    static void SetupRuleTests() {
        // A code is normalised to ABCDE-FGH23 whatever the case, spaces or hyphens; 0, 1, I and O are not in the alphabet.
        Assert(DeviceSetup.NormalizeCode("abcde-fgh23") == "ABCDE-FGH23", "lower case");
        Assert(DeviceSetup.NormalizeCode("ABCDEFGH23") == "ABCDE-FGH23", "no hyphen");
        Assert(DeviceSetup.NormalizeCode(" abc de-fg h23 ") == "ABCDE-FGH23", "spaces");
        foreach (string bad in new string[] { "", "ABCDE-FGH2", "ABCDE-FGH234", "ABCDE-FGH2I", "ABCDE-FGH2O", "ABCDE FGH2!", "11111-11111" })
            Assert(DeviceSetup.NormalizeCode(bad) == null, "a bad code is null: " + bad);
        Assert(DeviceSetup.CodeCharsOk("ABCDE-FGH") && DeviceSetup.CodeCharsOk("") && !DeviceSetup.CodeCharsOk("ABCDEFGHJKL") && !DeviceSetup.CodeCharsOk("ABC!"), "as typed: only the alphabet, at most ten");

        // A name is required, trimmed, at most 100 characters, no control characters.
        Assert(DeviceSetup.CheckName("Front desk") == "" && DeviceSetup.CheckName("  x  ") == "", "a plain name is fine");
        Assert(DeviceSetup.CheckName("") != "" && DeviceSetup.CheckName("   ") != "" && DeviceSetup.CheckName(new string('x', 101)) != "" && DeviceSetup.CheckName("a\tb") != "", "bad names are refused");

        // Step validation: nothing is preselected, so each choice must be made; a workspace install needs no code.
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Code, "", false, "", null, null) != "", "a missing code stops the code step");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Code, "", true, "", null, null) == "", "a workspace install needs no code");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Code, "abcde-fgh23", false, "", null, null) == "", "a good code passes the code step");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Name, "", false, "", null, null) != "" && DeviceSetup.Missing(DeviceSetup.Screen.Name, "", false, "PC", null, null) == "", "the name step");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Access, "", false, "PC", null, null) != "" && DeviceSetup.Missing(DeviceSetup.Screen.Access, "", false, "PC", "ask", null) == "" && DeviceSetup.Missing(DeviceSetup.Screen.Access, "", false, "PC", "any", null) == "", "the access step needs a choice");
        Assert(DeviceSetup.Missing(DeviceSetup.Screen.Control, "", false, "PC", "ask", null) != "" && DeviceSetup.Missing(DeviceSetup.Screen.Control, "", false, "PC", "ask", "full") == "" && DeviceSetup.Missing(DeviceSetup.Screen.Control, "", false, "PC", "ask", "limited") == "", "the control step needs a choice");
        Assert(DeviceSetup.StepOf(DeviceSetup.Screen.Code) == 1 && DeviceSetup.StepOf(DeviceSetup.Screen.Install) == 5 && DeviceSetup.StepOf(DeviceSetup.Screen.Intro) == 0 && DeviceSetup.StepOf(DeviceSetup.Screen.Done) == 0, "steps 1 to 5 are code to install");

        // The answers argument: base64url JSON, decoded and checked again. No owner contact (call 7).
        string withCode = DeviceSetup.EncodeAnswers(" Front desk ", "any", "full", "ABCDE-FGH23");
        Assert(System.Text.RegularExpressions.Regex.IsMatch(withCode, "^[A-Za-z0-9_-]+$"), "the argument is base64url with no padding");
        var back = DeviceSetup.DecodeAnswers(withCode);
        Assert(Wire.Text(back, "name") == "Front desk" && Wire.Text(back, "access") == "any" && Wire.Text(back, "control") == "full" && Wire.Text(back, "code") == "ABCDE-FGH23" && !back.ContainsKey("workspace"), "a code's answers round-trip, trimmed");
        var ws = DeviceSetup.DecodeAnswers(DeviceSetup.EncodeAnswers("PC", "ask", "limited", null));
        Assert(Wire.Flag(ws, "workspace") && !ws.ContainsKey("code") && Wire.Text(ws, "access") == "ask", "a workspace install carries workspace true, no code");
        Assert(!back.ContainsKey("owner_contact") && !ws.ContainsKey("owner_contact"), "the answers never carry an owner contact");
        foreach (string arg in new string[] { "", "not base64url!!", "====" })
            ThrowsData(delegate { DeviceSetup.DecodeAnswers(arg); }, "junk: " + arg);
        // Tampered JSON is refused: a bad access, a missing field, both a code and a workspace, an over-long argument.
        Func<Dictionary<string, object>, string> enc = delegate(Dictionary<string, object> m) {
            string b = Convert.ToBase64String(Encoding.UTF8.GetBytes(Wire.Json().Serialize(m)));
            return b.TrimEnd('=').Replace('+', '-').Replace('/', '_');
        };
        foreach (Dictionary<string, object> bad in new List<Dictionary<string, object>> {
            Wire.Map("name", "PC", "access", "sometimes", "control", "full", "code", "ABCDE-FGH23"),
            Wire.Map("name", "PC", "access", "ask", "control", "other", "code", "ABCDE-FGH23"),
            Wire.Map("name", "", "access", "ask", "control", "full", "code", "ABCDE-FGH23"),
            Wire.Map("name", "PC", "access", "ask", "control", "full", "code", "abcde-fgh23"),
            Wire.Map("name", "PC", "access", "ask", "control", "full", "code", "ABCDE-FGH23", "workspace", true),
            Wire.Map("name", "PC", "access", "ask", "control", "full"),
            Wire.Map("name", "PC", "access", "ask", "control", "full", "owner_contact", "x", "code", "ABCDE-FGH23"),
        }) ThrowsData(delegate { DeviceSetup.DecodeAnswers(enc(bad)); }, Wire.Json().Serialize(bad));
        ThrowsData(delegate { DeviceSetup.DecodeAnswers(new string('A', DeviceSetup.MaxAnswers + 1)); }, "too long");

        // The exit-code map: where the wizard goes and what it says.
        Assert(DeviceSetup.After(DeviceSetup.Active) == DeviceSetup.Screen.Done && DeviceSetup.After(DeviceSetup.Pending) == DeviceSetup.Screen.Waiting && DeviceSetup.After(DeviceSetup.CodeInvalid) == DeviceSetup.Screen.Code && DeviceSetup.After(DeviceSetup.AlreadySetUp) == DeviceSetup.Screen.Already, "each exit code goes to its screen");
        Assert(DeviceSetup.After(DeviceSetup.Network) == DeviceSetup.Screen.Install && DeviceSetup.After(DeviceSetup.Refused) == DeviceSetup.Screen.Install && DeviceSetup.After(999) == DeviceSetup.Screen.Install, "network, refused and anything unknown go back to the install step");
        Assert(DeviceSetup.ExitText(DeviceSetup.Active) == "" && DeviceSetup.ExitText(DeviceSetup.Pending) == "" && DeviceSetup.ExitText(DeviceSetup.AlreadySetUp) == "", "the success screens carry no error");
        Assert(DeviceSetup.ExitText(DeviceSetup.CodeInvalid).Contains("code") && DeviceSetup.ExitText(DeviceSetup.Network).Contains("reach") && DeviceSetup.ExitText(DeviceSetup.Refused).Contains("refused"), "code, network and refused each say what happened");
        Assert(DeviceSetup.ShowConfirm("482913") == "482 913" && DeviceSetup.ShowConfirm("abc") == null && DeviceSetup.ShowConfirm(null) == null, "six digits show as two groups");
        Assert(DeviceSetup.ModeText("any").Contains("any time") && DeviceSetup.ModeText("ask").Contains("asks you") && DeviceSetup.Folder.EndsWith("SupportMCP") && DeviceSetup.Exe.EndsWith("support.exe"), "the mode text and the install paths");
        // The OS line: Windows 11 still says "Windows 10" in ProductName, so the build decides; capped at the relay's 100.
        Assert(DeviceSetup.OsName("Windows 10 Pro", "26200", "25H2") == "Windows 11 Pro 25H2 (build 26200)", "Windows 11 by its build");
        Assert(DeviceSetup.OsName("Windows 10 Pro", "19045", "22H2") == "Windows 10 Pro 22H2 (build 19045)", "Windows 10 stays Windows 10");
        Assert(DeviceSetup.OsName("Windows 7 Professional", "7601", null) == "Windows 7 Professional (build 7601)", "Windows 7 has no release");
        Assert(DeviceSetup.OsName(null, "7601", null) == "Windows (build 7601)" && DeviceSetup.OsName(new string('x', 300), "1", null).Length == 100, "no name, and the cap");
        Assert(DeviceSetup.Os().StartsWith("Windows", StringComparison.Ordinal) && DeviceSetup.Os().IndexOf("NT 6.2", StringComparison.Ordinal) < 0, "this PC's line names Windows, not NT 6.2: " + DeviceSetup.Os());
        Console.WriteLine("PASS the setup wizard rules: code format, step validation, the answers argument, and the exit-code map");
    }
    // The elevated install's pure parts: the leftover decision, the service command line, the registry builders, the
    // Apps entry values, the install paths and the locked-folder ACL (read back as the FullControl tests do).
    static void DeviceInstallTests() {
        Assert(DeviceInstall.LeftoverAction(true, false) == DeviceInstall.Leftover.AlreadySetUp && DeviceInstall.LeftoverAction(true, true) == DeviceInstall.Leftover.AlreadySetUp, "a running service means Support is already set up");
        Assert(DeviceInstall.LeftoverAction(false, true) == DeviceInstall.Leftover.Clean, "the folder with no service is a crash leftover to clean");
        Assert(DeviceInstall.LeftoverAction(false, false) == DeviceInstall.Leftover.Proceed, "nothing installed means a clean install");

        string exe = @"C:\Program Files\SupportMCP\support.exe";
        Assert(DeviceInstall.ServiceBinary(exe) == "\"C:\\Program Files\\SupportMCP\\support.exe\" --device-service", "the service path is quoted, with --device-service");
        Assert(DeviceInstall.TrayRunValue(exe) == "\"C:\\Program Files\\SupportMCP\\support.exe\" --tray", "the tray startup value is quoted, with --tray");

        var apps = DeviceInstall.AppsValues("0.4.0", @"C:\Program Files\SupportMCP", exe, 512);
        Assert(Wire.Text(apps, "DisplayName") == "Support" && Wire.Text(apps, "DisplayVersion") == "0.4.0" && Wire.Text(apps, "Publisher") == "Support-MCP", "the Apps entry names the app, its version and publisher");
        Assert(Wire.Text(apps, "InstallLocation") == @"C:\Program Files\SupportMCP" && Wire.Text(apps, "UninstallString") == "\"" + exe + "\" --uninstall", "the Apps entry says where it is and how to uninstall it");
        Assert(apps["NoModify"] is int && (int)apps["NoModify"] == 1 && apps["NoRepair"] is int && (int)apps["NoRepair"] == 1 && apps["EstimatedSize"] is int && (int)apps["EstimatedSize"] == 512, "NoModify, NoRepair and EstimatedSize are whole numbers");
        Assert(!apps.ContainsKey("DisplayIcon"), "there is no DisplayIcon: the exe carries no icon");

        Assert(DeviceSetup.Folder.EndsWith("\\SupportMCP") && DeviceSetup.Exe == Path.Combine(DeviceSetup.Folder, "support.exe") && Directory.Exists(FullInstall.Root), "the install folder is under %ProgramFiles%\\SupportMCP and the app is support.exe in it");
        // A tray the wizard starts must not hold the install folder as its current directory, or it cannot be renamed aside.
        var trayStart = DeviceSetup.TrayStart(); string trayDir = Path.GetFullPath(trayStart.WorkingDirectory).TrimEnd('\\');
        Assert(trayStart.FileName == DeviceSetup.InstalledExe() && trayStart.Arguments == "--tray" && !trayStart.UseShellExecute, "the wizard starts the installed exe with --tray");
        Assert(UpdateSwitch.InFolder(DeviceSetup.InstalledExe(), DeviceSetup.Folder) && UpdateSwitch.IsVersionFile(Path.GetFileName(DeviceSetup.InstalledExe())), "the installed exe is a version file in the install folder (support.exe when not installed)");
        Assert(trayDir.Length > 0 && !(trayDir + "\\").StartsWith(DeviceSetup.Folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase), "the tray's working directory is not inside the install folder");

        // The locked folder: owner Administrators, SYSTEM and Administrators full, nothing inherited (as FullAcl.Folder,
        // which the one-off tests already check on disk, plus the owner this install sets).
        var locked = DeviceInstall.LockedFolder();
        Assert(locked.AreAccessRulesProtected && ((SecurityIdentifier)locked.GetOwner(typeof(SecurityIdentifier))).Equals(FullAcl.AdminsSid), "the locked folder is owned by Administrators and does not inherit");
        var rules = locked.GetAccessRules(true, true, typeof(SecurityIdentifier));
        Assert(rules.Count == 2, "two rules: " + rules.Count);
        foreach (FileSystemAccessRule r in rules)
            Assert((r.IdentityReference.Equals(FullAcl.SystemSid) || r.IdentityReference.Equals(FullAcl.AdminsSid)) && r.FileSystemRights == FileSystemRights.FullControl && !r.IsInherited
                && r.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit), "only SYSTEM and Administrators, full control, inherited by files and folders");
        Console.WriteLine("PASS the elevated install: the leftover decision, the service and tray command lines, the Apps entry, the paths and the locked folder");
    }
    // The saved PC service's pure parts: the state map for every wire result, the timing and backoff, the refresh
    // limit, the history cap, the status frame, and the live pipe (frame vocabulary and the ACL).
    static void DeviceServiceTests(string dir) {
        // Classify: a 200 is active or pending (from the body); a 401 is removed from active and expired from pending;
        // 426 is update_needed; offline and an unexpected refusal keep trying. (DeviceLink already maps each HTTP
        // status to these results, so this covers every wire status.)
        DeviceService.Schedule sched;
        Assert(DeviceService.Classify("active", DeviceLink.DeviceResult.Ok, "active", out sched) == DeviceState.Active && sched == DeviceService.Schedule.Normal, "200 active");
        Assert(DeviceService.Classify("pending", DeviceLink.DeviceResult.Ok, "pending", out sched) == DeviceState.Pending && sched == DeviceService.Schedule.Normal, "200 still pending");
        Assert(DeviceService.Classify("pending", DeviceLink.DeviceResult.Ok, "active", out sched) == DeviceState.Active, "200 pending to active");
        Assert(DeviceService.Classify("active", DeviceLink.DeviceResult.Removed, "", out sched) == DeviceState.Removed && sched == DeviceService.Schedule.Stopped, "401 after active is removed, and stops");
        Assert(DeviceService.Classify("pending", DeviceLink.DeviceResult.Removed, "", out sched) == DeviceState.Expired && sched == DeviceService.Schedule.Stopped, "401 while pending is expired, and stops");
        Assert(DeviceService.Classify("active", DeviceLink.DeviceResult.UpdateNeeded, "", out sched) == DeviceState.UpdateNeeded && sched == DeviceService.Schedule.Update, "426 is update_needed, re-checked later");
        foreach (DeviceLink.DeviceResult r in new DeviceLink.DeviceResult[] { DeviceLink.DeviceResult.Offline, DeviceLink.DeviceResult.Refused }) {
            Assert(DeviceService.Classify("active", r, "", out sched) == DeviceState.Offline && sched == DeviceService.Schedule.Backoff, "offline or refused keeps trying: " + r);
        }

        // Backoff: one minute, doubling, capped at fifteen; it resets to one on the next failure after a success (0).
        long b = 0; var seen = new List<long>();
        for (int i = 0; i < 6; i++) { b = DeviceService.NextBackoff(b); seen.Add(b); }
        Assert(seen[0] == 60000 && seen[1] == 120000 && seen[2] == 240000 && seen[3] == 480000 && seen[4] == 900000 && seen[5] == 900000, "backoff 1,2,4,8,15,15 minutes");
        Assert(DeviceService.NextBackoff(0) == 60000, "a reset backoff starts at one minute");

        // Jitter bounds: five minutes plus up to thirty seconds, never less, never more.
        var rnd = new Random(1234); long min = long.MaxValue, max = long.MinValue;
        for (int i = 0; i < 2000; i++) { long d = DeviceService.NextCheckDelay(rnd); if (d < min) min = d; if (d > max) max = d; }
        Assert(min >= DeviceService.CheckEveryMs && max <= DeviceService.CheckEveryMs + DeviceService.JitterMaxMs && max > DeviceService.CheckEveryMs, "every check-in is 5 minutes plus 0 to 30 seconds");
        Assert(DeviceService.UpdateEveryMs == 6 * 3600 * 1000L, "an update is re-checked every six hours");

        // The 30-second refresh limit.
        Assert(DeviceService.RefreshDue(0, DeviceService.RefreshMinMs) && !DeviceService.RefreshDue(0, DeviceService.RefreshMinMs - 1), "a refresh is allowed at most once every 30 seconds");

        // History: the lines a 200 adds, and the cap at 50 newest.
        Assert(DeviceService.HistoryFor("pending", "ask", "limited", "active", "ask", "limited").Count == 1, "approval alone is one line");
        Assert(DeviceService.HistoryFor("active", "ask", "full", "active", "any", "full").Count == 1 && DeviceService.HistoryFor("active", "any", "full", "active", "ask", "full").Count == 1, "a team access change, either way, is a line");
        Assert(DeviceService.HistoryFor("active", "ask", "limited", "active", "ask", "limited").Count == 0, "no change, no line");
        var hist = new System.Collections.ArrayList();
        for (int i = 0; i < 60; i++) { hist.Add(Wire.Map("at", (long)i, "text", "line " + i)); DeviceService.TrimHistory(hist); }
        Assert(hist.Count == DeviceService.HistoryCap && Wire.Text((Dictionary<string, object>)hist[0], "text") == "line 10" && Wire.Text((Dictionary<string, object>)hist[hist.Count - 1], "text") == "line 59", "the last 50 lines are kept, newest last");

        // The status frame: confirm is shown only while pending.
        var pending = DeviceService.StatusFrame("PC", "ask", "limited", DeviceState.Pending, "482913", 111, new System.Collections.ArrayList());
        Assert(Wire.Text(pending, "version") == Wire.Version, "the status frame carries the service's own version");
        Assert(Wire.Text(pending, "state") == DeviceState.Pending && Wire.Text(pending, "confirm") == "482913" && Wire.Number(pending, "last_ok_at") == 111, "a pending frame carries the six digits");
        foreach (string st in new string[] { DeviceState.Active, DeviceState.Expired, DeviceState.Removed, DeviceState.Offline }) {
            Assert(!DeviceService.StatusFrame("PC", "any", "full", st, "482913", 0, new System.Collections.ArrayList()).ContainsKey("confirm"), "no confirm outside pending: " + st);
        }

        // The pipe vocabulary: exactly status, allow_any_time and refresh; any extra field, or any attempt to set
        // "ask", is refused (the connection closes).
        Func<string, Dictionary<string, object>> one = delegate(string json) { return Wire.Json().Deserialize<Dictionary<string, object>>(json); };
        Assert(Pipes.DeviceRequest(one("{\"type\":\"status\"}")) == "status" && Pipes.DeviceRequest(one("{\"type\":\"allow_any_time\"}")) == "allow_any_time" && Pipes.DeviceRequest(one("{\"type\":\"refresh\"}")) == "refresh", "the three frames");
        Assert(Pipes.DeviceRequest(one("{\"type\":\"end_session\"}")) == "end_session", "and end_session (PR 6)");
        foreach (string json in new string[] { "{}", "{\"type\":\"end\"}", "{\"type\":\"run\"}", "{\"type\":\"ask\"}", "{\"type\":\"allow_any_time\",\"access\":\"ask\"}", "{\"type\":\"set_access\",\"access\":\"ask\"}", "{\"Type\":\"status\"}", "{\"type\":[\"status\"]}", "{\"type\":\"end_session\",\"session\":1}", "{\"type\":\"ask_session\"}" })
            Assert(Pipes.DeviceRequest(one(json)) == null, "refused: " + json);

        // A live pipe on the device ACL (the test account stands in for SYSTEM, which the tests do not run as): a
        // modest client gets in and reads status; a client that asks for full access, which includes new instances,
        // is refused; an unknown frame closes the connection.
        var me = WindowsIdentity.GetCurrent().User;
        string pipeName = "SupportMcpDeviceTest-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        string sddl = "D:P(A;;GA;;;" + me.Value + ")(A;;0x12008B;;;IU)";
        Func<Dictionary<string, object>, Dictionary<string, object>> handle = delegate(Dictionary<string, object> m) {
            string req = Pipes.DeviceRequest(m);
            if (req == null) return null;
            return DeviceService.StatusFrame("PC", "ask", "limited", DeviceState.Active, "", 7, new System.Collections.ArrayList());
        };
        new UiServer(pipeName, handle, delegate(uint ssn) { return true; }, sddl, 1024);
        // The greedy client is checked on one instance with the service's real ACL: this account holds full access on
        // the test pipe above, so a client running as it would always get in there.
        using (var real = Native.PipeServer(pipeName + "-acl", DeviceService.Sddl, 1, true)) {
            using (var greedy = new System.IO.Pipes.NamedPipeClientStream(".", pipeName + "-acl", System.IO.Pipes.PipeDirection.InOut)) {
                try { greedy.Connect(2000); throw new Exception("the device pipe gave out full access"); } catch (UnauthorizedAccessException) { }
            }
            // The refusal must come from the access mask, so a modest client on the same instance gets in. That holds only when
            // this token has the INTERACTIVE group (S-1-5-4) the ACL grants; a service or batch account does not.
            bool interactive = false;
            foreach (var g in WindowsIdentity.GetCurrent().Groups) if (g.Value == "S-1-5-4") interactive = true;
            if (interactive) {
                var accepting = new Thread(delegate() { try { real.WaitForConnection(); } catch (Exception) { } }); accepting.Start();
                using (var modest = Pipes.Client(pipeName + "-acl")) { modest.Connect(2000); Assert(modest.IsConnected, "a modest client gets in on the same instance, so the greedy one was refused by the access mask"); }
                accepting.Join(3000);
            } else Console.WriteLine("SKIP the modest client on the device ACL: this token lacks the INTERACTIVE group (S-1-5-4)");
        }
        using (var c = Pipes.Client(pipeName)) {
            c.Connect(2000);
            foreach (string t in new string[] { "status", "allow_any_time", "refresh" }) {
                Pipes.Write(c, Wire.Map("type", t));
                Assert(Wire.Text(Pipes.Read(c, DeviceService.PipeReadMax, UiServer.ReadMs), "state") == DeviceState.Active, "a valid frame is answered: " + t);
            }
        }
        using (var c = Pipes.Client(pipeName)) {
            c.Connect(2000); Pipes.Write(c, Wire.Map("type", "set_access", "access", "ask"));
            try { Pipes.Read(c, DeviceService.PipeReadMax, UiServer.ReadMs); throw new Exception("the service answered a frame it must refuse"); } catch (EndOfStreamException) { } catch (IOException) { }
        }
        Console.WriteLine("PASS the saved PC service: the state map, backoff and jitter, the refresh limit, the history cap, the status frame, and the pipe");
    }
    // The tray's pure parts: the state-to-text map, which actions show in which state and mode (the one-way rule), the
    // history lines, and the run-time icon (a handle created and freed).
    static void TrayTests() {
        Assert(TrayText.State(DeviceState.Active, "") == "Your support team can see this PC.", "active text");
        Assert(TrayText.State(DeviceState.Pending, "482913") == "Waiting for approval: read them 482 913.", "pending shows the six digits");
        Assert(TrayText.State(DeviceState.Pending, "") == "Waiting for approval.", "pending without digits");
        Assert(TrayText.State(DeviceState.Expired, "").Contains("wasn't approved") && TrayText.State(DeviceState.Removed, "").Contains("removed") && TrayText.State(DeviceState.UpdateNeeded, "").Contains("update") && TrayText.State(DeviceState.Offline, "").Contains("reach"), "each state has its own line");
        Assert(TrayText.Mode("any").Contains("any time") && TrayText.Mode("ask").Contains("asks you"), "the mode line");

        // The one-way rule: the any-time action shows only while active and asking first; never when any, never when
        // pending; uninstall always; no action ever sets "ask".
        foreach (string state in new string[] { DeviceState.Active, DeviceState.Pending, DeviceState.Expired, DeviceState.Removed, DeviceState.UpdateNeeded, DeviceState.Offline }) {
            foreach (string access in new string[] { "ask", "any" }) {
                var actions = TrayText.Actions(state, access);
                bool expectAllow = state == DeviceState.Active && access == "ask";
                Assert(actions.Contains("allow_any_time") == expectAllow, "allow_any_time only when active and asks first: " + state + "/" + access);
                Assert(actions.Contains("uninstall"), "uninstall always shows: " + state + "/" + access);
                foreach (string a in actions) Assert(a != "ask" && a != "allow_ask" && a.IndexOf("ask") < 0, "no action ever sets ask: " + a);
            }
        }
        Assert(!TrayText.Actions(DeviceState.Pending, "ask").Contains("allow_any_time"), "a pending PC never offers the any-time action");
        Assert(!TrayText.Actions(DeviceState.Active, "any").Contains("allow_any_time"), "an any-time PC never offers the action again");
        Assert(TrayText.ShowTeamOnly(DeviceState.Active, "any") && !TrayText.ShowTeamOnly(DeviceState.Active, "ask") && !TrayText.ShowTeamOnly(DeviceState.Removed, "any"), "only an any-time PC says only the team can change it");
        Assert(TrayText.ShowMode(DeviceState.Active) && TrayText.ShowMode(DeviceState.Pending) && !TrayText.ShowMode(DeviceState.Removed) && !TrayText.ShowMode(DeviceState.Expired), "a removed or unapproved PC shows no mode line");
        Assert(TrayText.AllowConfirm.Contains("undo this from this PC") && TrayText.AllowConfirm.Contains("Only your support team"), "the confirm says it can't be undone from this PC and only the team can turn it back");

        // Recent history, newest first, limited.
        var hist = new System.Collections.ArrayList();
        for (int i = 0; i < 6; i++) hist.Add(Wire.Map("at", (long)(1700000000000 + i), "text", "line " + i));
        var recent = TrayText.Recent(hist, 4);
        Assert(recent.Count == 4 && recent[0].Contains("line 5") && recent[3].Contains("line 2"), "the last four history lines, newest first");
        Assert(TrayText.Recent(null, 4).Count == 0, "no history is no lines");
        Assert(TrayText.Tip(new string('x', 200)).Length <= 63, "the tooltip fits 63 characters");
        Assert(TrayText.VersionLine("0.5.1") == "Version 0.5.1" && TrayText.VersionLine("") == "" && TrayText.VersionLine(null) == "" && TrayText.VersionLine("<b>1</b>") == "", "the version line, hidden for an older service or junk");

        // The icon is drawn at run time: Create makes a handle, DestroyIcon frees it. A different color per state.
        IntPtr h = TrayIcon.Create(16, TrayIcon.ColorFor(DeviceState.Active));
        Assert(h != IntPtr.Zero, "the tray icon is drawn to a handle");
        Assert(Native.DestroyIcon(h), "the icon handle is freed");
        Assert(!TrayIcon.ColorFor(DeviceState.Active).Equals(TrayIcon.ColorFor(DeviceState.Pending)) && !TrayIcon.ColorFor(DeviceState.Pending).Equals(TrayIcon.ColorFor(DeviceState.Removed)), "the icon colour follows the state");
        Console.WriteLine("PASS the tray: the state-to-text map, the one-way action rule, the history lines, and the run-time icon handle");
    }
    // Uninstall's pure parts: the removal plan (our names only, never the one-off shared record), the exit-code map,
    // the Temp-copy rule, and that a 401 from leave counts as done.
    static void UninstallTests(string dir) {
        var plan = DeviceUninstall.RemovalPlan();
        Assert(plan.Count == 4, "four artifacts");
        Assert(plan[0] == "service SupportMcpDevice", "the service by its exact name");
        Assert(plan[1].Contains("CurrentVersion\\Run\\SupportMcpTray"), "the HKLM Run tray value");
        Assert(plan[2].Contains("Uninstall\\SupportMcpDevice"), "the Apps uninstall entry");
        Assert(plan[3] == "folder " + DeviceSetup.Folder && plan[3].EndsWith("\\SupportMCP"), "the install folder");
        // Never the one-off sessions' shared record HKLM\SOFTWARE\SupportMCP, and nothing outside our names.
        foreach (string item in plan) {
            Assert(item.IndexOf("SOFTWARE\\SupportMCP") < 0, "never the shared record: " + item);
            Assert(item.Contains("SupportMcpDevice") || item.Contains("SupportMcpTray") || item.EndsWith("\\SupportMCP"), "only our names: " + item);
        }

        // The exit-code map.
        Assert(DeviceUninstall.Map(DeviceUninstall.Removed) == DeviceUninstall.Outcome.Removed, "0 is removed");
        Assert(DeviceUninstall.Map(DeviceUninstall.Unreachable) == DeviceUninstall.Outcome.RemovedUnreachable, "10 is removed but the relay was unreachable");
        Assert(DeviceUninstall.Map(-1223) == DeviceUninstall.Outcome.Declined, "a declined Windows prompt");
        Assert(DeviceUninstall.Map(DeviceUninstall.Fail) == DeviceUninstall.Outcome.Failed && DeviceUninstall.Map(999) == DeviceUninstall.Outcome.Failed, "anything else is a failure");

        // The Temp-copy rule: run from the install folder restages; run from anywhere else proceeds.
        Assert(DeviceUninstall.NeedsRestage(DeviceSetup.Exe), "the installed support.exe restages itself");
        Assert(!DeviceUninstall.NeedsRestage(Path.Combine(Path.GetTempPath(), "SupportMcpStage-x\\support.exe")), "a Temp copy proceeds");
        // The staged copy's folder is removed after the run, and only a SupportMcpStage-* folder directly under Temp is ever named.
        string tmp = Path.Combine(Path.GetTempPath(), "SupportMcpStage-" + Guid.NewGuid().ToString("N")), tmpExe = Path.Combine(tmp, "support.exe");
        Assert(DeviceUninstall.StagedFolder(tmpExe) == tmp, "a staged copy names its own folder");
        Assert(DeviceUninstall.StagedFolder(DeviceSetup.Exe) == null, "the installed exe names no folder");
        Assert(DeviceUninstall.StagedFolder(Path.Combine(Path.GetTempPath(), "other\\support.exe")) == null && DeviceUninstall.StagedFolder(Path.Combine(Path.GetTempPath(), "support.exe")) == null, "an arbitrary folder, or Temp itself, names no folder");
        Assert(DeviceUninstall.StagedFolder(Path.Combine(tmp, "deeper\\support.exe")) == null && DeviceUninstall.StagedFolder("support.exe", "C:\\Other") == null, "a folder not directly under Temp names nothing");

        // leave: a 200 or a 401 both count as done (reached); only a network failure leaves the PC on the list.
        Assert(DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Ok), "200 counts as done");
        Assert(DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Removed), "401 counts as done");
        Assert(!DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Offline), "a network failure is not reached");
        Assert(!DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.Refused) && !DeviceUninstall.LeaveReachedRelay(DeviceLink.DeviceResult.UpdateNeeded), "a refusal or a server error leaves the PC on the team's list, so the owner is told the team must remove it");

        // The real removal on a temp folder whose exe is running (as a tray left behind would be): it is renamed aside,
        // so the original path is free for a fresh install. A running exe, not an open file handle: Windows renames a
        // folder whose exe is running, but not one holding an open handle of any share mode. This drives the shared
        // DeviceInstall.RemoveFolderAside, not a parallel copy.
        string root = Path.Combine(dir, "uninst-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        string f = Path.Combine(root, "SupportMCP"); Directory.CreateDirectory(f);
        string fexe = Path.Combine(f, "support.exe"); File.Copy(Path.Combine(Environment.SystemDirectory, "PING.EXE"), fexe); File.WriteAllText(Path.Combine(f, "device.json"), "{}");
        var running = Process.Start(new ProcessStartInfo(fexe, "-n 60 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true });
        try {
            Thread.Sleep(500);
            DeviceUninstall.TestRemoveFolder(f);
            Assert(!Directory.Exists(f), "a folder whose exe is running is renamed aside, freeing the original path for a reinstall");
            Assert(Directory.GetDirectories(root, "SupportMCP.removed-*").Length >= 1, "the running exe's folder is kept under a unique removed name, not at the original path");
        } finally { try { running.Kill(); } catch (Exception) { } running.WaitForExit(5000); running.Dispose(); }
        foreach (string d in Directory.GetDirectories(root, "SupportMCP.removed-*")) try { Directory.Delete(d, true); } catch (Exception) { }
        // A plain (unlocked) folder is removed outright, with no leftover.
        Directory.CreateDirectory(f); File.WriteAllText(Path.Combine(f, "device.json"), "{}");
        DeviceUninstall.TestRemoveFolder(f);
        Assert(!Directory.Exists(f) && Directory.GetDirectories(root, "SupportMCP.removed-*").Length == 0, "an unlocked folder is removed with nothing left behind");

        // Two elevated installs or removes at once: the second is refused while the first holds the setup mutex.
        // Only SYSTEM and Administrators may open it, so a standard (or filtered) test account checks that refusal and
        // the held-mutex refusal on its own handle; an elevated one opens it twice, as two elevated installs would.
        string mn = "Local\\SupportMcpDeviceSetupTest-" + Guid.NewGuid().ToString("N");
        bool elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        using (var m1 = DeviceInstall.SetupMutex(mn)) {
            Assert(m1.WaitOne(0), "the first elevated install or remove takes the setup mutex");
            // A Win32 mutex is re-entrant for the thread that owns it, so the second taker always runs on another thread.
            if (elevated) {
                bool second = true; var other = new Thread(delegate() { using (var m2 = DeviceInstall.SetupMutex(mn)) { second = m2.WaitOne(0); if (second) m2.ReleaseMutex(); } }); other.Start(); other.Join();
                Assert(!second, "a second one is refused while the first holds it");
                m1.ReleaseMutex();
                using (var m3 = DeviceInstall.SetupMutex(mn)) { Assert(m3.WaitOne(0), "once released, the next one takes it"); m3Release(m3); }
            } else {
                try { DeviceInstall.SetupMutex(mn).Dispose(); throw new Exception("a standard user opened the setup mutex"); } catch (DeviceInstall.BlockedException) { }
                bool second = true; var other = new Thread(delegate() { second = m1.WaitOne(0); if (second) m1.ReleaseMutex(); }); other.Start(); other.Join();
                Assert(!second, "a second one is refused while the first holds it");
                m1.ReleaseMutex();
            }
        }
        Console.WriteLine("PASS uninstall: the removal plan and exit codes, the rename-aside removal, and the setup mutex refusal");
    }
    // Drives the real service against a fake relay with a real temp folder: a 200 with no device, a team access
    // change, allow_any_time only from "ask" (never sending "ask"), terminal states persisted and not re-checked after
    // a reload, and the uninstall event opened with Modify so a waiter sees the signal.
    static void DeviceServiceLiveTests(string dir) {
        string folder = Path.Combine(dir, "svc-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
        string exe = Path.Combine(folder, "support.exe");
        Func<string, string, string, string, string> dev = delegate(string st, string nm, string ac, string ct) {
            return Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "workspace", "default", "status", st, "name", nm, "access", ac, "control", ct, "site_id", null)));
        };
        Action<string> writeJson = delegate(string json) { File.WriteAllText(Path.Combine(folder, "device.json"), json); };
        Func<DeviceService, int> histCount = delegate(DeviceService svc) { var h = svc.TestStatus()["history"] as System.Collections.ArrayList; return h == null ? 0 : h.Count; };

        using (var relay = new FakeDevice()) {
            writeJson(Wire.Json().Serialize(Wire.Map("origin", relay.Origin, "workspace", "default", "device_id", "d", "key", "smd1.default.id.secret", "status", "active", "name", "PC", "access", "ask", "control", "limited")));
            var svc = new DeviceService(exe);
            Assert(svc.TestInit(), "the service loads device.json");
            relay.Status = 200; relay.Body = dev("active", "Front desk", "ask", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "state") == DeviceState.Active && Wire.Text(svc.TestStatus(), "name") == "Front desk", "a 200 updates name and state from the device");
            // A 200 with no "device" is treated as offline, not a crash that ends the loop.
            relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1));
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "state") == DeviceState.Offline, "a 200 with no device is offline, not a crash");
            // The team flips access to any: a history line is added.
            int before = histCount(svc);
            relay.Body = dev("active", "Front desk", "any", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "any" && histCount(svc) == before + 1, "a team access change applies and is a history line");
            // Back to ask (the team turned it off), so allow_any_time becomes possible again.
            relay.Body = dev("active", "Front desk", "ask", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "ask", "the team can set it back to ask");
            // allow_any_time: the pipe answers at once, and the update runs in the background and only ever sends "any".
            relay.Body = dev("active", "Front desk", "any", "limited"); relay.LastJson = ""; relay.LastPath = "";
            var reply = svc.TestHandle(Wire.Map("type", "allow_any_time"));
            Assert(reply != null && Wire.Text(reply, "state").Length > 0, "allow_any_time is answered at once");
            bool went = false;
            for (int i = 0; i < 100 && !went; i++) { if (Wire.Text(svc.TestStatus(), "access") == "any") went = true; else Thread.Sleep(50); }
            Assert(went, "allow_any_time turned on any in the background");
            Assert(relay.LastPath == "/device/update" && Wire.Text(relay.Sent(), "access") == "any", "it sent access any, never ask");
            // A second allow_any_time while already any sends nothing (and so can never send ask).
            relay.LastJson = ""; relay.LastPath = "";
            svc.TestHandle(Wire.Map("type", "allow_any_time")); Thread.Sleep(300);
            Assert(relay.LastJson == "", "allow_any_time does nothing once the mode is any");
            // A hello still in flight when the PC turns on "any time" answers with the older "ask". That stale access is
            // ignored: the mode stays any and no false "set to ask" line is logged. The next check-in brings the team's view.
            relay.Body = dev("active", "Front desk", "ask", "limited");
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "ask", "the team set it back to ask");
            int h0 = histCount(svc);
            relay.HelloBody = dev("active", "Front desk", "ask", "limited"); relay.HelloDelayMs = 1500; relay.Body = dev("active", "Front desk", "any", "limited");
            var inFlight = new Thread(delegate() { svc.TestCheckInOnce(); }); inFlight.IsBackground = true; inFlight.Start(); Thread.Sleep(300);
            svc.TestHandle(Wire.Map("type", "allow_any_time"));
            Assert(inFlight.Join(10000), "the held hello finishes");
            Assert(Wire.Text(svc.TestStatus(), "access") == "any", "a stale hello answer does not undo a local any-time change");
            Assert(histCount(svc) == h0 + 1, "only the local change is logged, no false set-to-ask line");
            relay.HelloBody = null; relay.HelloDelayMs = 0;
        }

        // Terminal states are persisted and a reload serves them without a fresh check-in or a duplicate history line.
        foreach (string[] pair in new string[][] { new string[] { "active", DeviceState.Removed }, new string[] { "pending", DeviceState.Expired } }) {
            string folder2 = Path.Combine(dir, "term-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder2);
            string exe2 = Path.Combine(folder2, "support.exe");
            using (var relay = new FakeDevice()) {
                var start = Wire.Map("origin", relay.Origin, "workspace", "default", "device_id", "d", "key", "smd1.default.id.secret", "status", pair[0], "name", "PC", "access", "ask", "control", "limited");
                if (pair[0] == "pending") start["confirm"] = "482913";
                File.WriteAllText(Path.Combine(folder2, "device.json"), Wire.Json().Serialize(start));
                var svc = new DeviceService(exe2); Assert(svc.TestInit(), "init " + pair[1]);
                relay.Status = 401; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "device_unknown", "message", "x")));
                svc.TestCheckInOnce();
                Assert(Wire.Text(svc.TestStatus(), "state") == pair[1] && svc.TestTerminal, "401 gives " + pair[1] + " and is terminal");
                var stored = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder2, "device.json")));
                Assert(Wire.Text(stored, "state") == pair[1], pair[1] + " is persisted to device.json");
                int lines = histCount(svc);
                // A reload serves the terminal state, stays terminal, and adds no duplicate history line at boot.
                var reloaded = new DeviceService(exe2); Assert(reloaded.TestInit(), "reload " + pair[1]);
                Assert(Wire.Text(reloaded.TestStatus(), "state") == pair[1] && reloaded.TestTerminal, "a reload serves " + pair[1] + " without a check-in");
                Assert(histCount(reloaded) == lines, "no duplicate " + pair[1] + " line at boot");
            }
        }

        // The uninstall event opened with Modify can be set, and a waiter sees it (the bug was Synchronize-only).
        string en = "Local\\SupportMcpTestUninstall-" + Guid.NewGuid().ToString("N");
        using (var created = DeviceService.TestCreateEvent(en)) {
            var got = new ManualResetEvent(false);
            var w = new Thread(delegate() { var we = DeviceService.TestOpenEvent(en, EventWaitHandleRights.Synchronize); if (we != null) using (we) if (we.WaitOne(5000)) got.Set(); });
            w.IsBackground = true; w.Start(); Thread.Sleep(200);
            var signaller = DeviceService.TestOpenEvent(en, EventWaitHandleRights.Synchronize | EventWaitHandleRights.Modify);
            Assert(signaller != null && signaller.Set(), "the event opens with Modify and sets");
            if (signaller != null) signaller.Dispose();
            Assert(got.WaitOne(5000), "a waiter sees the uninstall signal");
        }
        Console.WriteLine("PASS the live service: a 200 with no device, a team mode change, allow_any_time one-way and async, terminal persistence across a reload, and the uninstall event");
    }
    // ---- signed updates -----------------------------------------------------------------------------------------
    // The test-key vector: a note signed by a throwaway key whose private half was never committed. TestKeyXy is that
    // key; TestSigDer is the same note signed in DER form, which the app must refuse.
    const string TestKeyXy = "EIVL0HmT752JhnLYiey2OvyNAoKvG/GA7kJWMJABU2pxweY7hn0EzmZlSmF6584sb8cYDZBGRK1E5bOIckyGgg==";
    const string TestNote = "support-mcp-release 1\nversion 0.5.1\nsha256 abababababababababababababababababababababababababababababababab\nsize 229376\nreleased 1794000000\n";
    const string TestSig = "fLoDvxmMWPIAhN3RyHweH44dJX+aDX7jD2s8SnZ8iCdUhPjPnC0aGna+3dtLT1WjwhgDHZiYpE+tLglfCh0ZFg==";
    const string TestSigDer = "MEUCIGHh+cKtdr8sMRGKhXlqNwjVm95i/pDDpU0IEZ0/SQZTAiEA1wmbyICv4E4TMPnKjkA13XNQOR7giPBFAxokivEa2HQ=";
    // The real-key vector: a note signed by the real project key, for a version and hash no release can carry.
    const string RealNote = "support-mcp-release 1\nversion 0.0.1\nsha256 0000000000000000000000000000000000000000000000000000000000000000\nsize 1\nreleased 1794000000\n";
    const string RealSig = "tggCO4NlR1GiGwMYh2C2xtwbIQK9e5cO8Y3PCNM4QcPKuKOjk+Hibnv3Q6BbSaKynp1Uu2+O89jobT62EhGXNQ==";
    // Another P-256 public key, for "the wrong key".
    const string OtherKeyXy = "ryQntQ49C0HNyTj3BmEGPnJdHRhDVRjA+hU5AldhahWNhLCnnfyQ2OV+bfi+Td4QXhoXHdxWOZ9Q6lPUw/s2ug==";

    static string NoteFor(string version, string sha, long size) {
        return "support-mcp-release 1\nversion " + version + "\nsha256 " + sha + "\nsize " + size.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\nreleased 1794000000\n";
    }
    // An exe with a setup footer appended, as /install serves it.
    static byte[] WithFooter(byte[] exe, string origin) {
        byte[] json = Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("kind", "device", "origin", origin))), footer = Encoding.ASCII.GetBytes(Wire.Footer);
        var ms = new MemoryStream(); ms.Write(exe, 0, exe.Length); ms.Write(json, 0, json.Length);
        byte[] n = BitConverter.GetBytes(json.Length); ms.Write(n, 0, n.Length); ms.Write(footer, 0, footer.Length);
        return ms.ToArray();
    }
    static byte[] FakeExe(int size, int seed) { var b = new byte[size]; new Random(seed).NextBytes(b); b[0] = 77; b[1] = 90; return b; }
    static string Sha(byte[] b) { return ReleaseKey.Sha256Hex(b, 0, b.Length); }

    // The signature check, with the test-key vector: it verifies, and a tampered note, a flipped signature, a DER
    // signature, the wrong key and malformed input all fail. Also a key made here round-trips.
    static void ReleaseKeyTests() {
        byte[] note = Encoding.UTF8.GetBytes(TestNote), sig = Convert.FromBase64String(TestSig);
        Assert(ReleaseKey.Verify(note, sig, TestKeyXy), "the test-key vector verifies");
        byte[] tampered = (byte[])note.Clone(); tampered[30] ^= 1;
        Assert(!ReleaseKey.Verify(tampered, sig, TestKeyXy), "a tampered note fails");
        byte[] flipped = (byte[])sig.Clone(); flipped[10] ^= 1;
        Assert(!ReleaseKey.Verify(note, flipped, TestKeyXy), "a flipped signature fails");
        Assert(!ReleaseKey.Verify(note, Convert.FromBase64String(TestSigDer), TestKeyXy), "a DER signature fails, even of the right note by the right key");
        Assert(!ReleaseKey.Verify(note, sig, OtherKeyXy), "the wrong key fails");
        Assert(!ReleaseKey.Verify(note, sig, "not base64!") && !ReleaseKey.Verify(note, sig, Convert.ToBase64String(new byte[63])) && !ReleaseKey.Verify(note, sig, Convert.ToBase64String(new byte[64])), "a malformed key fails, never throws");
        byte[] longer = new byte[65]; Buffer.BlockCopy(sig, 0, longer, 0, 64);
        Assert(!ReleaseKey.Verify(note, longer, TestKeyXy) && !ReleaseKey.Verify(note, new byte[63], TestKeyXy) && !ReleaseKey.Verify(null, sig, TestKeyXy) && !ReleaseKey.Verify(note, null, TestKeyXy), "a signature of another size, or nothing, fails");
        Assert(Encoding.UTF8.GetBytes(TestNote.Replace("\n", "\r\n")).Length > note.Length && !ReleaseKey.Verify(Encoding.UTF8.GetBytes(TestNote.Replace("\n", "\r\n")), sig, TestKeyXy), "the same note with CRLF fails");
        using (var signer = new TestSigner()) {
            string s = signer.Sign(TestNote);
            Assert(Convert.FromBase64String(s).Length == 64 && ReleaseKey.Verify(note, Convert.FromBase64String(s), signer.Xy), "a key made here signs a note that verifies");
            Assert(!ReleaseKey.Verify(note, Convert.FromBase64String(s), TestKeyXy), "and only with its own key");
        }
        Assert(ReleaseKey.Sha256Hex(Encoding.ASCII.GetBytes("abc"), 0, 3) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 in lowercase hex");
        Assert(ReleaseKey.ProjectKey.Length == 88 && Convert.FromBase64String(ReleaseKey.ProjectKey).Length == 64, "the embedded key is 64 bytes X||Y");
        // The real-key vector verifies with the embedded key, and the test-key vector does not, so a build that carries
        // the test key, or a mistyped real key, can never ship.
        Assert(ReleaseKey.Verify(Encoding.UTF8.GetBytes(RealNote), Convert.FromBase64String(RealSig)), "the real-key vector verifies with the embedded release key");
        Assert(!ReleaseKey.Verify(Encoding.UTF8.GetBytes(RealNote), Convert.FromBase64String(RealSig), TestKeyXy), "and not with the test key");
        Assert(!ReleaseKey.Verify(note, sig), "the embedded release key is still the test key: put the real project key in ReleaseKey.ProjectKey and release-key.pub");
        Console.WriteLine("PASS the release key: the test-key and real-key vectors verify; tampered, flipped, DER, wrong-key and malformed input fail");
    }

    // The note parser takes the exact five lines and nothing else.
    static void ReleaseNoteTests() {
        var n = ReleaseNote.Parse(TestNote);
        string sha = "abababababababababababababababababababababababababababababababab";
        Assert(n != null && n.Version == "0.5.1" && n.Sha256 == sha && n.Size == 229376 && n.Released == 1794000000, "the vector's note parses");
        var bad = new List<string> {
            TestNote.Substring(0, TestNote.Length - 1),                                   // no final LF
            TestNote.Replace("\n", "\r\n"),                                               // CRLF
            TestNote + "extra 1\n",                                                       // an extra line
            TestNote.Replace("released 1794000000\n", ""),                                // a missing line
            TestNote.Replace("version 0.5.1\nsha256 " + sha, "sha256 " + sha + "\nversion 0.5.1"), // wrong order
            TestNote.Replace(sha, sha.ToUpperInvariant()),                                // uppercase hex
            TestNote.Replace(sha, sha.Substring(2)),                                      // short hex
            TestNote.Replace("size 229376", "size 0229376"),                              // a leading zero
            TestNote.Replace("size 229376", "size -1"),
            TestNote.Replace("size 229376", "size 0"),
            TestNote.Replace("version 0.5.1", "version 0.5.01"),                          // a leading zero in the version
            TestNote.Replace("version 0.5.1", "version v0.5.1"),
            TestNote.Replace("support-mcp-release 1", "support-mcp-release 2"),
            TestNote.Replace("size 229376", "size  229376"),
            TestNote.Replace("size 229376", "size 229376 "),
            TestNote.Replace("version 0.5.1", "version 0.5.1\u00e9"),
            "\n" + TestNote, "", null,
        };
        foreach (string text in bad) Assert(ReleaseNote.Parse(text) == null, "refused: " + (text == null ? "null" : text.Replace("\n", "\\n").Replace("\r", "\\r")));
        Console.WriteLine("PASS the release note parser takes the exact five lines and refuses any other text");
    }

    // SemVer order: 0.5.0 < 0.5.1 < 0.6.0, a prerelease below its release, build metadata ignored, leading zeros refused.
    static void SemVerTests() {
        string[] order = { "0.4.9", "0.5.0-alpha", "0.5.0-alpha.1", "0.5.0-alpha.beta", "0.5.0-beta.2", "0.5.0-beta.11", "0.5.0-rc.1", "0.5.0", "0.5.1", "0.6.0-rc.1", "0.6.0", "0.10.0", "1.0.0" };
        for (int i = 0; i < order.Length; i++)
            for (int j = 0; j < order.Length; j++) Assert(SemVer.Compare(order[i], order[j]) == Math.Sign(i - j), order[i] + " vs " + order[j]);
        Assert(SemVer.Compare("0.5.0+build.1", "0.5.0+build.2") == 0 && SemVer.Compare("0.5.0+x", "0.5.0") == 0, "build metadata is ignored");
        Assert(SemVer.Compare("10.0.0", "9.99.99") == 1, "numbers, not text");
        foreach (string v in new string[] { "01.0.0", "0.05.0", "0.5.0-01", "0.5", "v0.5.0", "", null, "0.5.0-", "0.5.0+", new string('1', 33), "\u0661.0.0" }) {
            Assert(!SemVer.Valid(v), "refused: " + v);
            bool threw = false; try { SemVer.Compare(v, "0.5.0"); } catch (ArgumentException) { threw = true; }
            Assert(threw, "Compare refuses " + v);
        }
        Assert(SemVer.Valid(Wire.Version), "this app's own version is valid: " + Wire.Version);
        Console.WriteLine("PASS SemVer order, build metadata ignored, leading zeros refused");
    }

    // Updater.Check and CheckDownload, as pure functions.
    static void UpdaterTests() {
        using (var signer = new TestSigner()) {
            byte[] exe = FakeExe(5000, 1); string sha = Sha(exe);
            Func<string, string, Dictionary<string, object>> offer = delegate(string version, string note) { return Wire.Map("version", version, "note", note, "signature", signer.Sign(note)); };
            string reason;
            string newer = NoteFor("99.0.0", sha, exe.Length);
            var taken = Updater.Check(offer("99.0.0", newer), Wire.Version, new List<string>(), signer.Xy, out reason);
            Assert(taken != null && reason == "" && taken.Version == "99.0.0" && taken.Size == exe.Length && taken.Sha256 == sha, "a newer signed release is taken: " + reason);
            Assert(Updater.Check(offer("99.0.0", newer), Wire.Version, null, TestKeyXy, out reason) == null && reason == "bad signature", "signed by another key: refused");
            var forged = offer("99.0.0", newer); forged["note"] = NoteFor("99.0.0", Sha(FakeExe(5000, 2)), exe.Length);
            Assert(Updater.Check(forged, Wire.Version, null, signer.Xy, out reason) == null && reason == "bad signature", "a note changed after signing: refused");
            Assert(Updater.Check(offer("0.0.1", NoteFor("0.0.1", sha, exe.Length)), Wire.Version, null, signer.Xy, out reason) == null && reason == "not newer", "an older signed version: refused");
            Assert(Updater.Check(offer(Wire.Version, NoteFor(Wire.Version, sha, exe.Length)), Wire.Version, null, signer.Xy, out reason) == null && reason == "not newer", "the same version: refused");
            Assert(Updater.Check(offer("99.0.1", newer), Wire.Version, null, signer.Xy, out reason) == null && reason == "version mismatch", "an outer version other than the note's: refused");
            var noOuter = offer("99.0.0", newer); noOuter.Remove("version");
            Assert(Updater.Check(noOuter, Wire.Version, null, signer.Xy, out reason) != null, "the outer version is never needed: the note's is used");
            Assert(Updater.Check(offer("99.0.0", newer), Wire.Version, new List<string> { "99.0.0" }, signer.Xy, out reason) == null && reason == "failed before", "a version that failed its trial: skipped");
            var der = offer("99.0.0", newer); der["signature"] = TestSigDer;
            Assert(Updater.Check(der, Wire.Version, null, signer.Xy, out reason) == null, "a DER signature: refused");
            var junk = offer("99.0.0", newer); junk["signature"] = "%%%";
            Assert(Updater.Check(junk, Wire.Version, null, signer.Xy, out reason) == null, "a signature that is not base64: refused");
            Assert(Updater.Check(Wire.Map("note", newer), Wire.Version, null, signer.Xy, out reason) == null && Updater.Check(null, Wire.Version, null, signer.Xy, out reason) == null, "no signature, or no update: nothing");
            string huge = NoteFor("99.0.0", sha, DeviceLink.DownloadCap + 1);
            Assert(Updater.Check(offer("99.0.0", huge), Wire.Version, null, signer.Xy, out reason) == null && reason == "too large", "a size over the download cap: refused");
            var crlf = offer("99.0.0", newer.Replace("\n", "\r\n"));
            Assert(Updater.Check(crlf, Wire.Version, null, signer.Xy, out reason) == null && reason == "bad note", "a signed note in another form: refused");

            // The download: footer stripped, then size and SHA-256.
            byte[] body = WithFooter(exe, "https://support.example.com");
            Assert(Updater.CheckDownload(body, taken) == exe.Length, "the served exe matches the note");
            byte[] other = WithFooter(FakeExe(5000, 3), "https://support.example.com");
            Assert(Updater.CheckDownload(other, taken) == -1, "another exe of the same size: refused");
            Assert(Updater.CheckDownload(WithFooter(FakeExe(5001, 1), "https://support.example.com"), taken) == -1, "another size: refused");
            Assert(Updater.CheckDownload(exe, taken) == -1, "no footer: refused");
            byte[] cut = new byte[body.Length / 2]; Buffer.BlockCopy(body, 0, cut, 0, cut.Length);
            Assert(Updater.CheckDownload(cut, taken) == -1 && Updater.CheckDownload(null, taken) == -1 && Updater.CheckDownload(new byte[3], taken) == -1, "a body cut short, or nothing: refused");
        }
        Console.WriteLine("PASS the update decision: newer, signed and never failed only; the download must match the note");
    }

    // DeviceLink.Download against the fake relay: POST /install with no query, Origin and an empty body; anything but a
    // whole 200 under the cap is null.
    static void DownloadTests() {
        using (var relay = new FakeDevice()) {
            var link = new DeviceLink(relay.Origin);
            byte[] body = WithFooter(FakeExe(70000, 4), relay.Origin);
            relay.InstallBody = body;
            byte[] got = link.Download();
            Assert(got != null && got.Length == body.Length && Sha(got) == Sha(body), "the download is the served bytes");
            Assert(relay.InstallMethod == "POST" && relay.InstallQuery == "" && relay.InstallOrigin == relay.Origin && relay.InstallBodyLength == 0, "POST /install, no query, Origin set, empty body: " + relay.InstallMethod + " " + relay.InstallQuery + " " + relay.InstallOrigin + " " + relay.InstallBodyLength);
            relay.InstallBody = new byte[DeviceLink.DownloadCap + 1];
            Assert(link.Download() == null, "over the cap: nothing");
            relay.InstallBody = body; relay.InstallStatus = 302; relay.InstallLocation = relay.Origin + "/elsewhere";
            Assert(link.Download() == null, "a redirect is not followed");
            relay.InstallLocation = null; relay.InstallStatus = 500;
            Assert(link.Download() == null, "a server error: nothing");
            relay.InstallStatus = 200; relay.InstallCut = true;
            Assert(link.Download() == null, "a body cut short: nothing");
            relay.InstallCut = false; relay.Refuse = true;
            Assert(link.Download() == null, "a dropped connection: nothing");
            relay.Refuse = false;
            // Chunked, with no Content-Length: under the cap it is read whole; over it, the streaming cap refuses it.
            relay.InstallChunked = true; relay.InstallBody = body;
            got = link.Download();
            Assert(got != null && Sha(got) == Sha(body), "a chunked body under the cap is the served bytes");
            relay.InstallBody = new byte[DeviceLink.DownloadCap + 200000];
            Assert(link.Download() == null, "a chunked body over the cap, with no Content-Length: nothing");
            // A body that keeps trickling in ends at the download deadline, though each read gets data in time.
            relay.InstallChunked = false; relay.InstallBody = body; relay.InstallTrickleMs = 100; // 69 KB at 1 KB per 100 ms: about 7 s
            int saved = DeviceLink.DownloadMs; DeviceLink.DownloadMs = 1500;
            try {
                var clock = Stopwatch.StartNew();
                Assert(link.Download() == null, "a trickling body past the deadline: nothing");
                Assert(clock.ElapsedMilliseconds < 5000, "ended at the deadline, not when the body was done: " + clock.ElapsedMilliseconds + " ms");
            } finally { DeviceLink.DownloadMs = saved; relay.InstallTrickleMs = 0; }
        }
        Console.WriteLine("PASS the release download: POST /install with Origin and no body, with the cap (also chunked), no redirects, drops refused, and the overall deadline");
    }

    // The names, places and decisions of the switch, as pure functions.
    static void UpdateSwitchRuleTests() {
        Assert(UpdateSwitch.VersionFileName("0.5.1", "abcdef12") == "support-0.5.1-abcdef12.exe", "the version file name");
        foreach (string good in new string[] { "support.exe", "SUPPORT.EXE", "support-0.5.1-abcdef12.exe", "support-0.6.0-rc.1-0123abcd.exe", "support-1.2.3+b.4-00000000.exe" }) Assert(UpdateSwitch.IsVersionFile(good), "a version file: " + good);
        foreach (string bad in new string[] { "support-0.5.1.exe", "support-0.5-abcdef12.exe", "support-0.5.1-abcdef1.exe", "support-0.5.1-abcdef12.dll", "other.exe", "support-.exe", "device.json", null }) Assert(!UpdateSwitch.IsVersionFile(bad), "not a version file: " + bad);
        string folder = @"C:\Program Files\SupportMCP";
        Assert(UpdateSwitch.InFolder(folder + @"\support-0.5.1-abcdef12.exe", folder) && UpdateSwitch.InFolder(folder + @"\support.exe", folder + "\\"), "a file directly in the folder");
        Assert(!UpdateSwitch.InFolder(folder + @"\sub\support.exe", folder) && !UpdateSwitch.InFolder(@"C:\Program Files\SupportMCP2\support.exe", folder) && !UpdateSwitch.InFolder(folder, folder), "not below it, beside it or the folder itself");
        Assert(DeviceSetup.ExeOf("\"" + folder + "\\support-0.5.1-abcdef12.exe\" --device-service", folder) == folder + @"\support-0.5.1-abcdef12.exe", "the service's command line names the installed exe");
        foreach (string cmd in new string[] { null, "", folder + @"\support-0.5.1-abcdef12.exe --device-service", "\"C:\\Windows\\evil.exe\" --device-service", "\"" + folder + "\\other.exe\" --device-service", "\"" })
            Assert(DeviceSetup.ExeOf(cmd, folder) == folder + @"\support.exe", "anything else falls back to support.exe: " + cmd);

        string old = folder + @"\support.exe", neu = folder + @"\support-0.5.1-abcdef12.exe";
        var st = new UpdateState();
        string third = folder + @"\support-0.4.0-11111111.exe";
        Assert(UpdateSwitch.OnStart(st, old, 1000) == UpdateSwitch.Start.Normal, "no trial: normal");
        st.Phase = UpdateState.Trial; st.From = old; st.To = neu; st.Version = "0.5.1"; st.Deadline = 1000;
        Assert(UpdateSwitch.OnStart(st, neu, 1000) == UpdateSwitch.Start.Trial && UpdateSwitch.OnStart(st, neu, 1000 + 10 * UpdateSwitch.StaleMs) == UpdateSwitch.Start.Trial, "the new version on trial, however late");
        Assert(UpdateSwitch.OnStart(st, old, 1000) == UpdateSwitch.Start.Interrupted, "the old version with the trial still open: interrupted, put itself back");
        Assert(UpdateSwitch.OnStart(st, third, 1000) == UpdateSwitch.Start.Waiting && UpdateSwitch.OnStart(st, third, 1000 + UpdateSwitch.StaleMs - 1) == UpdateSwitch.Start.Waiting, "a recent record about other files: touch nothing");
        Assert(UpdateSwitch.OnStart(st, third, 1000 + UpdateSwitch.StaleMs) == UpdateSwitch.Start.Stale, "a record about other files long past its deadline: stale, cleared");
        st.Phase = UpdateState.RollingBack;
        Assert(UpdateSwitch.OnStart(st, neu, 1000) == UpdateSwitch.Start.ResumeRollback && UpdateSwitch.OnStart(st, old, 1000) == UpdateSwitch.Start.Interrupted, "a rollback cut short: the new version starts it again; the old one finishes it");
        Assert(UpdateSwitch.OnStart(st, third, 1000) == UpdateSwitch.Start.Waiting && UpdateSwitch.OnStart(st, third, 1000 + UpdateSwitch.StaleMs) == UpdateSwitch.Start.Stale, "a rollback about other files waits, until it is stale");
        Assert(UpdateSwitch.WatchOver(st, neu) && !UpdateSwitch.WatchOver(new UpdateState { Phase = UpdateState.Trial, To = neu }, neu) && UpdateSwitch.WatchOver(new UpdateState(), neu), "the switch watches only its own open trial");
        // Trial health: 200, 202 and 401 commit; no network and 5xx retry; a 426 and every other refusal roll back.
        Assert(UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Ok, 200) == UpdateSwitch.Health.Healthy && UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Pending, 202) == UpdateSwitch.Health.Healthy && UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Removed, 401) == UpdateSwitch.Health.Healthy, "200, 202 and 401 are healthy");
        Assert(UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Offline, 0) == UpdateSwitch.Health.Retry && UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Offline, 200) == UpdateSwitch.Health.Retry, "no network, or a 200 with no device: retry");
        foreach (int code in new int[] { 500, 502, 503 }) Assert(UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Refused, code) == UpdateSwitch.Health.Retry, "a server error retries: " + code);
        Assert(UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.UpdateNeeded, 426) == UpdateSwitch.Health.Unhealthy, "a 426 is not healthy");
        foreach (int code in new int[] { 400, 403, 404, 409, 413, 429 }) Assert(UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.Refused, code) == UpdateSwitch.Health.Unhealthy, "a refusal is not healthy: " + code);
        Assert(UpdateSwitch.TrialHealth(DeviceLink.DeviceResult.CodeInvalid, 404) == UpdateSwitch.Health.Unhealthy, "nor a code_invalid");
        Assert(!UpdateSwitch.DecideNow(1000000 - UpdateSwitch.DecideBeforeMs - 1, 1000000) && UpdateSwitch.DecideNow(1000000 - UpdateSwitch.DecideBeforeMs, 1000000) && UpdateSwitch.DecideNow(2000000, 1000000), "an offline trial decides only near its deadline");
        Assert(UpdateSwitch.DecideBeforeMs > 2 * UpdateSwitch.RetryHelloMs && UpdateSwitch.DecideBeforeMs < UpdateSwitch.TrialMs, "with time for retries before, and a full retry window ahead of, the watcher's deadline");
        // A file still in use is set aside under a name no version-file pattern takes.
        string aside = UpdateSwitch.AsideName("support-0.4.0-11111111.exe", "abcdef12");
        Assert(aside == "support-0.4.0-11111111.exe.abcdef12.del" && UpdateSwitch.IsAside(aside) && !UpdateSwitch.IsVersionFile(aside), "the set-aside name: " + aside);
        Assert(UpdateSwitch.IsAside(UpdateSwitch.AsideName("support.exe", "00000000")) && !UpdateSwitch.IsAside("support.exe") && !UpdateSwitch.IsAside("other.exe.abcdef12.del") && !UpdateSwitch.IsAside("support.exe.abcdef1.del") && !UpdateSwitch.IsAside(null), "only our set-aside names");
        Assert(UpdateSwitch.UninstallBusy(st, 1000) && UpdateSwitch.UninstallBusy(st, 1000 + UpdateSwitch.StaleMs - 1) && !UpdateSwitch.UninstallBusy(st, 1000 + UpdateSwitch.StaleMs) && !UpdateSwitch.UninstallBusy(new UpdateState(), 0), "uninstall waits for an open trial, not a stale one");
        var files = new List<string> { old, neu, folder + @"\support-0.4.0-11111111.exe", folder + @"\support-0.3.0-22222222.exe", folder + @"\device.json", folder + @"\notes.exe" };
        var gone = UpdateSwitch.Obsolete(files, neu, old);
        Assert(gone.Count == 2 && gone.Contains(folder + @"\support-0.4.0-11111111.exe") && gone.Contains(folder + @"\support-0.3.0-22222222.exe"), "every version file but the current and the previous goes, nothing else");
        Assert(UpdateSwitch.Obsolete(files, neu, "").Contains(old), "with no previous, support.exe goes too");
        Assert(DeviceUpdate.RollbackCommand(old) == "\"" + old + "\" --device-update-rollback" && DeviceUpdate.SwitchArgs(neu) == "--device-update \"" + neu + "\"", "the command lines");

        // update.json round-trips, and a damaged one is an empty state.
        string dir = Path.Combine(Path.GetTempPath(), "support-mcp-upd-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(dir);
        try {
            var s1 = new UpdateState(); s1.AddFailed("0.5.2"); s1.Previous = old; s1.StagedFile = neu; s1.StagedVersion = "0.5.1"; s1.StagedSha = new string('a', 64); s1.StagedSize = 7;
            s1.Phase = UpdateState.Trial; s1.From = old; s1.FromVersion = "0.5.0"; s1.To = neu; s1.Version = "0.5.1"; s1.Deadline = 123;
            s1.Save(dir);
            var s2 = UpdateState.Load(dir);
            Assert(s2.Failed.Count == 1 && s2.Failed[0] == "0.5.2" && s2.Previous == old && s2.StagedFile == neu && s2.StagedSize == 7 && s2.Phase == UpdateState.Trial && s2.FromVersion == "0.5.0" && s2.Deadline == 123 && !s2.Started, "update.json round-trips");
            s2.Started = true; s2.Save(dir);
            Assert(UpdateState.Load(dir).Started && !File.Exists(Path.Combine(dir, UpdateState.FileName + ".new")), "the started marker round-trips, and no temp file is left");
            // A scanner that holds update.json for a moment without sharing does not make a save fail: it tries again.
            {
                var scanner = new FileStream(Path.Combine(dir, UpdateState.FileName), FileMode.Open, FileAccess.Read, FileShare.None);
                var release = new Thread(delegate() { Thread.Sleep(150); scanner.Dispose(); }); release.Start();
                try { s2.Deadline = 456; s2.Save(dir); } finally { release.Join(); scanner.Dispose(); }
                Assert(UpdateState.Load(dir).Deadline == 456, "a save goes through once the file is free again");
            }
            // Held without sharing (as a scanner might), the file cannot be read: TryLoad says so (null), never an empty state.
            using (new FileStream(Path.Combine(dir, UpdateState.FileName), FileMode.Open, FileAccess.Read, FileShare.None)) {
                Assert(UpdateState.TryLoad(dir) == null, "an update.json that cannot be read now is null, so nothing writes over it");
            }
            for (int i = 0; i < 30; i++) s2.AddFailed("0.0." + i);
            Assert(s2.Failed.Count == UpdateState.FailedCap && s2.Failed[s2.Failed.Count - 1] == "0.0.29", "the failed list keeps the newest " + UpdateState.FailedCap);
            File.WriteAllText(Path.Combine(dir, UpdateState.FileName), "{not json");
            Assert(!UpdateState.Load(dir).InTrial && UpdateState.Load(dir).Failed.Count == 0, "a damaged update.json is an empty state");
        } finally { TryDeleteDir(dir); }
        Console.WriteLine("PASS the switch rules: version files, the install folder, the start decision, health, uninstall waiting, cleanup and update.json");
    }

    static Dictionary<string, object> Dev(string status) { return Wire.Map("id", "d", "workspace", "default", "status", status, "name", "PC", "access", "ask", "control", "limited", "site_id", null); }
    static string Snapshot(string folder) {
        var names = new List<string>();
        foreach (string f in Directory.GetFiles(folder)) names.Add(Path.GetFileName(f) + ":" + new System.IO.FileInfo(f).Length);
        names.Sort(StringComparer.OrdinalIgnoreCase); return string.Join("|", names.ToArray());
    }
    static string NewServiceFolder(string dir, string origin) {
        string folder = Path.Combine(dir, "upd-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "device.json"), Wire.Json().Serialize(Wire.Map("origin", origin, "workspace", "default", "device_id", "d", "key", "smd1.default.id.secret", "status", "active", "name", "PC", "access", "ask", "control", "limited")));
        return folder;
    }

    // The real service against a hostile fake relay: a release whose exe does not match the signed size or SHA-256, a bad
    // signature, an older or equal version, an outer version other than the note's, a body cut short, no footer, and a
    // version that failed before are each refused and change nothing in the folder; a good one is staged as its own
    // version file with the app's ACL, held against writing, recorded, and handed to the switch.
    static void UpdateServiceTests(string dir) {
        using (var relay = new FakeDevice())
        using (var signer = new TestSigner()) {
            byte[] exe = FakeExe(60000, 5); string sha = Sha(exe);
            relay.InstallBody = WithFooter(exe, relay.Origin);
            Func<string, string, string, string> hello = delegate(string outer, string note, string signature) {
                return Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Dev("active"), "update", Wire.Map("version", outer, "note", note, "signature", signature)));
            };
            // Each case: a fresh service, one check-in, and the folder and the switch looked at after.
            Action<string, string, bool, Action<string>> refused = delegate(string name, string body, bool downloads, Action<string> setup) {
                string folder = NewServiceFolder(dir, relay.Origin);
                if (setup != null) setup(folder);
                var launched = new List<string>();
                var svc = new DeviceService(Path.Combine(folder, "support.exe"));
                svc.TestUpdates(signer.Xy, delegate(string f, string a) { launched.Add(f + " " + a); return null; });
                Assert(svc.TestInit(), "init: " + name);
                string before = Snapshot(folder); int hits = relay.InstallHits;
                relay.Status = 200; relay.Body = body;
                svc.TestCheckInOnce();
                Assert(Snapshot(folder) == before, name + ": nothing in the folder changes: " + Snapshot(folder));
                Assert(launched.Count == 0 && svc.TestStaged == "", name + ": no switch starts");
                Assert((relay.InstallHits > hits) == downloads, name + (downloads ? ": downloaded, then refused" : ": refused before any download"));
            };
            string good = NoteFor("99.0.0", sha, exe.Length);
            refused("a different exe of the same size", hello("99.0.0", NoteFor("99.0.0", Sha(FakeExe(60000, 6)), exe.Length), signer.Sign(NoteFor("99.0.0", Sha(FakeExe(60000, 6)), exe.Length))), true, null);
            refused("a different size", hello("99.0.0", NoteFor("99.0.0", sha, exe.Length + 1), signer.Sign(NoteFor("99.0.0", sha, exe.Length + 1))), true, null);
            using (var other = new TestSigner()) refused("a signature by another key", hello("99.0.0", good, other.Sign(good)), false, null);
            refused("a note changed after signing", hello("99.0.0", good, signer.Sign(NoteFor("99.0.0", sha, exe.Length - 1))), false, null);
            refused("an older signed version", hello("0.0.1", NoteFor("0.0.1", sha, exe.Length), signer.Sign(NoteFor("0.0.1", sha, exe.Length))), false, null);
            refused("the same signed version", hello(Wire.Version, NoteFor(Wire.Version, sha, exe.Length), signer.Sign(NoteFor(Wire.Version, sha, exe.Length))), false, null);
            refused("an outer version other than the note's", hello("99.0.1", good, signer.Sign(good)), false, null);
            relay.InstallCut = true;
            refused("a body cut short", hello("99.0.0", good, signer.Sign(good)), true, null);
            relay.InstallCut = false; relay.InstallBody = exe;
            refused("an exe with no footer", hello("99.0.0", good, signer.Sign(good)), true, null);
            relay.InstallBody = WithFooter(exe, relay.Origin);
            refused("a version that failed its trial before", hello("99.0.0", good, signer.Sign(good)), false, delegate(string folder) {
                var st = new UpdateState(); st.AddFailed("99.0.0"); st.Save(folder);
            });

            // A good release, offered in a 426 this time: staged, recorded and handed to the switch. The switch here is a
            // real process that keeps running (PING), so "one switch at a time" is checked against a live one.
            {
                string folder = NewServiceFolder(dir, relay.Origin);
                var launched = new List<string>();
                string self = Path.Combine(folder, "support.exe");
                var svc = new DeviceService(self);
                Process pinger = null;
                svc.TestUpdates(signer.Xy, delegate(string f, string a) {
                    launched.Add(f + " " + a);
                    pinger = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "PING.EXE"), "-n 60 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true });
                    return pinger;
                });
                try {
                    Assert(svc.TestInit(), "init good");
                    relay.Status = 426; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "protocol_unsupported", "message", "x"), "supported", Wire.Map("min", 2, "max", 2), "update", Wire.Map("version", "99.0.0", "note", good, "signature", signer.Sign(good))));
                    svc.TestCheckInOnce();
                    string staged = svc.TestStaged;
                    Assert(staged.Length > 0 && File.Exists(staged), "a good release is staged");
                    Assert(UpdateSwitch.InFolder(staged, folder) && System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(staged), @"^support-99\.0\.0-[0-9a-f]{8}\.exe$"), "as support-<version>-<8 hex>.exe in the install folder: " + staged);
                    byte[] written = File.ReadAllBytes(staged); // a reader gets in: the held handle denies only writing
                    Assert(Sha(written) == sha && written.Length == exe.Length, "the file is the exe without its footer");
                    var acl = File.GetAccessControl(staged);
                    Assert(acl.AreAccessRulesProtected, "the file inherits nothing");
                    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
                        bool full = (rule.IdentityReference.Equals(FullAcl.SystemSid) || rule.IdentityReference.Equals(FullAcl.AdminsSid)) && NoSync(rule.FileSystemRights) == NoSync(FileSystemRights.FullControl);
                        bool users = rule.IdentityReference.Equals(FullAcl.UsersSid) && NoSync(rule.FileSystemRights) == NoSync(FileSystemRights.ReadAndExecute);
                        Assert(rule.AccessControlType == AccessControlType.Allow && !rule.IsInherited && (full || users), "only SYSTEM and Administrators full, Users read and run: " + rule.IdentityReference + " " + rule.FileSystemRights);
                    }
                    bool writable = true;
                    try { using (new FileStream(staged, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { } } catch (IOException) { writable = false; } catch (UnauthorizedAccessException) { writable = false; }
                    Assert(!writable, "nobody can open the staged file for writing while it is held");
                    var st = UpdateState.Load(folder);
                    Assert(UpdateSwitch.Same(st.StagedFile, staged) && st.StagedVersion == "99.0.0" && st.StagedSha == sha && st.StagedSize == exe.Length && !st.InTrial, "update.json records the staged file and what it must hash to");
                    Assert(launched.Count == 1 && launched[0] == self + " --device-update \"" + staged + "\"", "the service starts its own exe with --device-update and the file: " + string.Join(";", launched.ToArray()));
                    // A second offer while the switch runs starts nothing more and keeps the staged file.
                    svc.TestCheckInOnce();
                    Assert(launched.Count == 1 && svc.TestStaged == staged && File.Exists(staged), "one switch at a time");
                    // The switch ends without stopping the service (refused or busy): the next offer lets the staged file go.
                    try { pinger.Kill(); pinger.WaitForExit(5000); } catch (Exception) { }
                    svc.TestCheckInOnce();
                    Assert(svc.TestStaged == "" && !File.Exists(staged) && UpdateState.Load(folder).StagedFile == "", "a switch that ended lets go of the staged file and its record");
                    Assert(launched.Count == 1, "and the same release is not tried again within the hour");
                } finally {
                    svc.TestDropStaged(); // the held handle must be closed before any cleanup touches the folder
                    try { if (pinger != null && !pinger.HasExited) pinger.Kill(); } catch (Exception) { }
                }
            }
            // A switch whose process could not be started (null) counts as ended, so switching never sticks.
            {
                string folder = NewServiceFolder(dir, relay.Origin);
                var launched = new List<string>();
                var svc = new DeviceService(Path.Combine(folder, "support.exe"));
                svc.TestUpdates(signer.Xy, delegate(string f, string a) { launched.Add(f + " " + a); return null; });
                try {
                    Assert(svc.TestInit(), "init null switch");
                    relay.Status = 200; relay.Body = hello("99.0.0", good, signer.Sign(good));
                    svc.TestCheckInOnce();
                    string staged = svc.TestStaged;
                    Assert(staged.Length > 0 && launched.Count == 1, "staged and handed to a switch that never started");
                    svc.TestCheckInOnce();
                    Assert(svc.TestStaged == "" && !File.Exists(staged) && UpdateState.Load(folder).StagedFile == "", "the next offer lets the staged file go");
                } finally { svc.TestDropStaged(); }
            }
        }
        Console.WriteLine("PASS updates against a hostile relay: wrong exe, size, signature, version, outer version, cut body, no footer and failed versions change nothing; a good release is staged, held and handed over, one switch at a time, and let go when the switch ends or never starts");
    }

    // The switch, the trial and the rollback, with the service and registry changes recorded (DeviceUpdate.Dry) and a
    // Local lock: a trial nobody commits rolls back at its deadline; refusals change nothing; a healthy first pass
    // commits; a 426 starts the rollback; the crash action's rollback; and an interrupted trial put back at start.
    static void UpdateTrialTests(string dir) {
        DeviceUpdate.Dry = true; DeviceUpdate.LockName = "Local\\SupportMcpUpdateTest-" + Guid.NewGuid().ToString("N"); DeviceUpdate.TrialMs = 1500; DeviceUpdate.PollMs = 100;
        Func<List<string>> log = delegate { lock (DeviceUpdate.DryLog) { var copy = new List<string>(DeviceUpdate.DryLog); DeviceUpdate.DryLog.Clear(); return copy; } };
        Func<List<string>, string> show = delegate(List<string> l) { return string.Join(" ; ", l.ToArray()); };
        try {
            using (var relay = new FakeDevice()) {
                // One folder: support.exe (the old version), a new version file, and an older leftover.
                Func<string> fresh = delegate {
                    string folder = NewServiceFolder(dir, relay.Origin);
                    File.WriteAllBytes(Path.Combine(folder, "support.exe"), FakeExe(3000, 7));
                    File.WriteAllBytes(Path.Combine(folder, "support-99.0.0-abcdef12.exe"), FakeExe(4000, 8));
                    File.WriteAllBytes(Path.Combine(folder, "support-0.0.9-00000000.exe"), FakeExe(100, 9));
                    return folder;
                };
                Action<string, string> stage = delegate(string folder, string file) {
                    var st = UpdateState.Load(folder); byte[] b = File.ReadAllBytes(file);
                    st.StagedFile = file; st.StagedVersion = "99.0.0"; st.StagedSha = Sha(b); st.StagedSize = b.Length; st.Save(folder);
                };
                Action<string, string, string> openTrial = delegate(string folder, string from, string to) {
                    var st = UpdateState.Load(folder); st.Phase = UpdateState.Trial; st.From = from; st.FromVersion = "0.4.0"; st.To = to; st.Version = "99.0.0"; st.Deadline = Client.UnixNow() + 240000; st.Save(folder);
                };
                // Decoded, not raw: the JSON writer stores an apostrophe as \u0027.
                Func<string, string> history = delegate(string folder) {
                    string path = Path.Combine(folder, "history.json"); if (!File.Exists(path)) return "";
                    var lines = Wire.Json().Deserialize<System.Collections.ArrayList>(File.ReadAllText(path)); var sb = new StringBuilder();
                    if (lines != null) foreach (object o in lines) { var m = o as Dictionary<string, object>; if (m != null) sb.Append(Wire.Text(m, "text")).Append('\n'); }
                    return sb.ToString();
                };

                // A trial nobody commits: the switch rolls back at the deadline, and the version is never taken again.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    stage(folder, neu); log();
                    int code = DeviceUpdate.Switch(old, neu, folder);
                    var seen = log();
                    Assert(code == UpdateSwitch.RolledBack, "an uncommitted trial rolls back: " + code);
                    var want = new List<string> { "actions " + DeviceUpdate.RollbackCommand(old), "stop", "point " + neu + " 99.0.0", "start", "stop", "point " + old + " " + Wire.Version, "actions restart", "start" };
                    Assert(show(seen) == show(want), "switch then rollback, in order: " + show(seen));
                    var st = UpdateState.Load(folder);
                    Assert(!st.InTrial && st.Failed.Contains("99.0.0") && st.StagedFile == "", "the trial is closed and the version recorded as failed");
                    Assert(history(folder).Contains("couldn't update to version 99.0.0"), "a history line says so");
                }
                // A rollback that cannot point the service back (the service database is locked while Windows starts
                // its services at boot) finishes nothing: the trial stays in its rollback phase, the rollback command stays
                // the failure action, and no history line claims it went back. A later run that can point back finishes it.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu); log();
                    DeviceUpdate.DryRepointFails = true;
                    try { DeviceUpdate.RollBack(folder); } finally { DeviceUpdate.DryRepointFails = false; }
                    var seen = log(); var st = UpdateState.Load(folder);
                    Assert(st.InTrial && st.Phase == UpdateState.RollingBack, "a rollback that could not point back stays open: " + st.Phase);
                    Assert(!seen.Contains("actions restart"), "the rollback command stays the failure action: " + show(seen));
                    Assert(!history(folder).Contains("went back"), "no history line claims it went back");
                    log(); DeviceUpdate.RollBack(folder); seen = log(); st = UpdateState.Load(folder);
                    Assert(!st.InTrial && seen.Contains("point " + old + " 0.4.0") && seen.Contains("actions restart"), "a later run points back and finishes: " + show(seen));
                    Assert(history(folder).Contains("couldn't update to version 99.0.0"), "and only then says so");
                }
                // A rollback with the old file gone has nothing to go back to: the trial closes on the new version, the
                // normal restarts come back, nothing is pointed, and the history does not claim it went back.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu); File.Delete(old); log();
                    DeviceUpdate.RollBack(folder);
                    var seen = log(); var st = UpdateState.Load(folder);
                    Assert(!st.InTrial && seen.Contains("actions restart") && !seen.Exists(delegate(string l) { return l.StartsWith("point "); }), "a missing old file closes the trial without pointing: " + show(seen));
                    Assert(history(folder).Contains("couldn't update to version 99.0.0") && !history(folder).Contains("went back"), "and the history does not claim it went back");
                }
                // Refusals: a file that was not staged, outside the folder, the running exe, changed since staging, or the lock held.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    log();
                    Assert(DeviceUpdate.Switch(old, neu, folder) == UpdateSwitch.Refused, "a file the service did not stage");
                    stage(folder, neu);
                    Assert(DeviceUpdate.Switch(old, Path.Combine(dir, "support-99.0.0-abcdef12.exe"), folder) == UpdateSwitch.Refused, "a file outside the install folder");
                    Assert(DeviceUpdate.Switch(old, Path.Combine(folder, "device.json"), folder) == UpdateSwitch.Refused, "not a version file");
                    Assert(DeviceUpdate.Switch(neu, neu, folder) == UpdateSwitch.Refused, "the running exe itself");
                    File.WriteAllBytes(neu, FakeExe(4000, 10));
                    Assert(DeviceUpdate.Switch(old, neu, folder) == UpdateSwitch.Refused, "a file changed since the service checked it");
                    stage(folder, neu);
                    using (var held = DeviceInstall.SetupMutex(DeviceUpdate.LockName)) {
                        Assert(held.WaitOne(0), "the test holds the lock");
                        int code = -1; var t = new Thread(delegate() { code = DeviceUpdate.Switch(old, neu, folder); }); t.Start(); t.Join();
                        Assert(code == UpdateSwitch.Busy, "the lock held by an install or uninstall: busy");
                        held.ReleaseMutex();
                    }
                    Assert(log().Count == 0 && !UpdateState.Load(folder).InTrial, "no refusal touches the service, the registry or the trial");
                }
                // A healthy first pass of the new version commits: normal restarts back, the old file kept as the previous one, older files removed.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    // The switch runs in its own thread, as its own process would; the commit below ends its watch.
                    stage(folder, neu); DeviceUpdate.TrialMs = 20000; log();
                    int switched = -1; var switching = new Thread(delegate() { switched = DeviceUpdate.Switch(old, neu, folder); }); switching.IsBackground = true; switching.Start();
                    Func<bool> started = delegate { lock (DeviceUpdate.DryLog) return DeviceUpdate.DryLog.Contains("start"); };
                    for (int i = 0; i < 200 && !started(); i++) Thread.Sleep(50);
                    Assert(started(), "the switch started the new version");
                    Thread.Sleep(500); // and let go of the lock
                    var svc = new DeviceService(neu); var launched = new List<string>();
                    svc.TestUpdates(TestKeyXy, delegate(string f, string a) { launched.Add(f + " " + a); return null; });
                    Assert(svc.TestPrepare() && svc.TestTrial, "the new version starts on trial");
                    var marked = UpdateState.Load(folder);
                    Assert(marked.Started && marked.Deadline >= Client.UnixNow() + 15000, "it records that it started and renews its trial window");
                    Assert(launched.Count == 1 && launched[0] == old + " " + DeviceUpdate.WatchArgs, "and starts the old exe's deadline watcher: " + string.Join(";", launched.ToArray()));
                    relay.Status = 200; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Dev("active")));
                    svc.TestCheckInOnce();
                    Assert(!svc.TestTrial && launched.Count == 1, "a 200 commits the trial");
                    Assert(switching.Join(10000) && switched == UpdateSwitch.Ok, "the switch stops watching once the trial is committed: " + switched);
                    DeviceUpdate.TrialMs = 1500;
                    var st = UpdateState.Load(folder);
                    Assert(!st.InTrial && UpdateSwitch.Same(st.Previous, old) && st.Failed.Count == 0, "committed: no trial, the old file is the previous one");
                    var seen = log();
                    Assert(show(seen) == show(new List<string> { "actions " + DeviceUpdate.RollbackCommand(old), "stop", "point " + neu + " 99.0.0", "start", "actions restart" }), "switch, then the commit puts the normal restarts back: " + show(seen));
                    Assert(File.Exists(old) && File.Exists(neu) && !File.Exists(Path.Combine(folder, "support-0.0.9-00000000.exe")), "the current and previous files stay, an older one goes");
                    bool line = false; foreach (object h in (System.Collections.ArrayList)svc.TestStatus()["history"]) if (Wire.Text((Dictionary<string, object>)h, "text") == "Support updated to version 99.0.0.") line = true;
                    Assert(line, "the history says Support updated");
                }
                // A 401 commits at once. No network or a server error keeps the trial open (the hello is retried), until
                // the deadline is near: then it commits, as a network failure is not the new version's fault.
                Action<string, long> deadline = delegate(string folder, long at) { var st = UpdateState.TryLoad(folder); st.Deadline = at; st.Save(folder); };
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu); log();
                    var svc = new DeviceService(neu); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { return null; });
                    Assert(svc.TestPrepare() && svc.TestTrial, "on trial");
                    relay.Status = 401; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "device_unknown", "message", "x")));
                    svc.TestCheckInOnce();
                    Assert(!svc.TestTrial && !UpdateState.Load(folder).InTrial && show(log()) == "actions restart", "a 401 commits");
                }
                foreach (bool drop in new bool[] { true, false }) {
                    string what = drop ? "no network" : "a 503";
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu); log();
                    var launched = new List<string>();
                    var svc = new DeviceService(neu); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { launched.Add(f + " " + a); return null; });
                    Assert(svc.TestPrepare() && svc.TestTrial, "on trial");
                    relay.Refuse = drop; relay.Status = 503; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "unavailable", "message", "x")));
                    try {
                        svc.TestCheckInOnce();
                        Assert(svc.TestTrial && UpdateState.Load(folder).Phase == UpdateState.Trial && log().Count == 0 && launched.Count == 1, what + " well before the deadline: the trial stays open, nothing rolls back: " + string.Join(";", launched.ToArray()));
                        deadline(folder, Client.UnixNow() + UpdateSwitch.DecideBeforeMs - 5000);
                        svc.TestCheckInOnce();
                    } finally { relay.Refuse = false; }
                    Assert(!svc.TestTrial && !UpdateState.Load(folder).InTrial && show(log()) == "actions restart" && launched.Count == 1, what + " still near the deadline: committed");
                }
                // A 426, or any other refusal, on a pass starts the old exe's rollback and does not commit.
                foreach (int code in new int[] { 426, 403, 409, 429 }) {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu); log();
                    var svc = new DeviceService(neu); var launched = new List<string>();
                    svc.TestUpdates(TestKeyXy, delegate(string f, string a) { launched.Add(f + " " + a); return null; });
                    Assert(svc.TestPrepare() && svc.TestTrial, "on trial");
                    Assert(launched.Count == 1 && launched[0] == old + " " + DeviceUpdate.WatchArgs, "the new version starts the old exe's deadline watcher: " + string.Join(";", launched.ToArray()));
                    relay.Status = code; relay.Body = code == 426
                        ? Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "protocol_unsupported", "message", "x"), "supported", Wire.Map("min", 2, "max", 2)))
                        : Wire.Json().Serialize(Wire.Map("protocol", 1, "error", Wire.Map("code", "refused", "message", "x")));
                    svc.TestCheckInOnce();
                    Assert(launched.Count == 2 && launched[1] == old + " --device-update-rollback", "a " + code + " starts the rollback from the old exe: " + string.Join(";", launched.ToArray()));
                    Assert(UpdateState.Load(folder).Phase == UpdateState.Trial && log().Count == 0, "the service itself commits nothing and changes nothing");
                    if (code != 426) continue;
                    // The rollback that starts (also the failure action after a crash).
                    Assert(DeviceUpdate.RollBack(folder) == UpdateSwitch.RolledBack, "the rollback role puts the old version back");
                    var seen = log();
                    Assert(show(seen) == show(new List<string> { "stop", "point " + old + " 0.4.0", "actions restart", "start" }), "stop, point at the old file, normal restarts, start: " + show(seen));
                    var st = UpdateState.Load(folder);
                    Assert(!st.InTrial && st.Failed.Contains("99.0.0"), "the version is recorded as failed");
                    Assert(DeviceUpdate.RollBack(folder) == UpdateSwitch.Ok && show(log()) == "actions restart ; start", "with no trial, the failure action only restarts the service with normal restarts");
                }
                // A trial interrupted (a restart midway): the old version puts itself back at start. The version is failed
                // only when update.json says its service started; one that never ran is tried again later.
                foreach (bool ran in new bool[] { false, true }) {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu);
                    if (ran) { var rs = UpdateState.TryLoad(folder); rs.Started = true; rs.Save(folder); }
                    log();
                    var svc = new DeviceService(old); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { return null; });
                    Assert(svc.TestPrepare() && !svc.TestTrial, "the old version starts normally");
                    var seen = log();
                    Assert(show(seen) == show(new List<string> { "point " + old + " 0.4.0", "actions restart" }), "points everything back without stopping itself: " + show(seen));
                    var st = UpdateState.Load(folder);
                    Assert(!st.InTrial && st.Failed.Contains("99.0.0") == ran && !File.Exists(neu), ran ? "a version that ran is failed and its file removed" : "a version that never ran is not failed; its file is removed");
                    bool line = false; foreach (object h in (System.Collections.ArrayList)svc.TestStatus()["history"]) if (Wire.Text((Dictionary<string, object>)h, "text").Contains("couldn't update to version 99.0.0")) line = true;
                    Assert(line, "the history line shows in the tray");
                }
                // A rollback decided and written down, then cut short by a restart, while the new file still runs: the new
                // version starts the rollback again at its start and does not take the trial.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu);
                    var rs = UpdateState.TryLoad(folder); rs.Phase = UpdateState.RollingBack; rs.AddFailed("99.0.0"); rs.Save(folder);
                    log();
                    var launched = new List<string>();
                    var svc = new DeviceService(neu); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { launched.Add(f + " " + a); return null; });
                    Assert(svc.TestPrepare() && !svc.TestTrial && launched.Count == 1 && launched[0] == old + " --device-update-rollback" && log().Count == 0, "an interrupted rollback is started again: " + string.Join(";", launched.ToArray()));
                    Assert(DeviceUpdate.RollBack(folder) == UpdateSwitch.RolledBack && !UpdateState.Load(folder).InTrial, "and finishes");
                    log();
                }
                // A record about files this service is neither, long past its deadline, is cleared; the failed versions and
                // the previous file stay. A recent one is left alone.
                foreach (bool stale in new bool[] { true, false }) {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe");
                    var rs = new UpdateState(); rs.AddFailed("98.0.0"); rs.Previous = Path.Combine(folder, "support-0.0.9-00000000.exe");
                    rs.Phase = UpdateState.Trial; rs.From = Path.Combine(folder, "support-0.0.8-11111111.exe"); rs.To = Path.Combine(folder, "support-0.0.7-22222222.exe"); rs.Version = "0.0.7";
                    rs.Deadline = stale ? Client.UnixNow() - UpdateSwitch.StaleMs - 1000 : Client.UnixNow();
                    rs.Save(folder); log();
                    var svc = new DeviceService(old); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { return null; });
                    Assert(svc.TestPrepare() && !svc.TestTrial, "a service the record does not name runs normally");
                    var st = UpdateState.Load(folder);
                    Assert(st.InTrial != stale && st.Failed.Contains("98.0.0") && UpdateSwitch.Same(st.Previous, rs.Previous) && log().Count == 0, stale ? "a stale record is cleared, failed and previous kept" : "a recent one is left alone");
                }
                // The deadline watcher a restart leaves behind (--device-update-rollback --at-deadline): it renews the
                // deadline to a fresh window, and rolls back a trial nobody commits; with nothing to watch it exits.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    Assert(DeviceUpdate.WatchDeadline(folder) == UpdateSwitch.Ok, "no trial: nothing to watch");
                    openTrial(folder, old, neu); deadline(folder, Client.UnixNow() - 60000); log();
                    var clock = Stopwatch.StartNew();
                    int code = DeviceUpdate.WatchDeadline(folder);
                    Assert(code == UpdateSwitch.RolledBack && clock.ElapsedMilliseconds >= DeviceUpdate.TrialMs, "a trial long past its deadline gets a fresh window, then rolls back: " + code + " after " + clock.ElapsedMilliseconds + " ms");
                    var st = UpdateState.Load(folder);
                    Assert(!st.InTrial && st.Failed.Contains("99.0.0") && show(log()) == show(new List<string> { "stop", "point " + old + " 0.4.0", "actions restart", "start" }), "rolled back and failed");
                }
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    openTrial(folder, old, neu); log();
                    DeviceUpdate.TrialMs = 20000;
                    try {
                        int watched = -1; var watcher = new Thread(delegate() { watched = DeviceUpdate.WatchDeadline(folder); }); watcher.IsBackground = true; watcher.Start();
                        Thread.Sleep(500);
                        var svc = new DeviceService(neu); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { return null; });
                        Assert(svc.TestPrepare() && svc.TestTrial, "on trial");
                        relay.Status = 200; relay.Body = Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Dev("active")));
                        svc.TestCheckInOnce();
                        Assert(!svc.TestTrial && watcher.Join(10000) && watched == UpdateSwitch.Ok, "a commit ends the watcher: " + watched);
                    } finally { DeviceUpdate.TrialMs = 1500; log(); }
                }
                // A removed PC never checks in, so its trial is committed at start.
                {
                    string folder = fresh(), old = Path.Combine(folder, "support.exe"), neu = Path.Combine(folder, "support-99.0.0-abcdef12.exe");
                    var dev = Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(folder, "device.json"))); dev["state"] = DeviceState.Removed;
                    File.WriteAllText(Path.Combine(folder, "device.json"), Wire.Json().Serialize(dev));
                    openTrial(folder, old, neu); log();
                    var svc = new DeviceService(neu); svc.TestUpdates(TestKeyXy, delegate(string f, string a) { return null; });
                    Assert(svc.TestPrepare() && !svc.TestTrial && !UpdateState.Load(folder).InTrial && show(log()) == "actions restart", "a removed PC commits its trial at start");
                }
            }
        } finally { DeviceUpdate.Dry = false; DeviceUpdate.LockName = DeviceInstall.SetupMutexName; DeviceUpdate.TrialMs = UpdateSwitch.TrialMs; DeviceUpdate.PollMs = 2000; log(); }
        Console.WriteLine("PASS the switch and trial: deadline rollback, refusals, commit on 200 or 401, retry then commit on no network or 5xx, rollback on 426 or another refusal and by the failure action, an interrupted trial blamed only when it ran, a rollback resumed, a stale record cleared, the deadline watcher, and a removed PC");
    }

    // Uninstall and updates: the busy exit code, restaging from any file in the install folder, and ending trays started
    // from any exe in the folder (a live tray from a renamed copy of PING).
    static void UninstallUpdateTests(string dir) {
        Assert(DeviceUninstall.Map(DeviceUninstall.Busy) == DeviceUninstall.Outcome.Busy && DeviceUninstall.Busy != DeviceUninstall.Fail, "busy has its own exit code and outcome");
        Assert(DeviceUninstall.BusyText.Contains("Try again in a few minutes"), "and its own message");
        Assert(DeviceUninstall.NeedsRestage(Path.Combine(DeviceSetup.Folder, "support-0.5.1-abcdef12.exe")) && DeviceUninstall.NeedsRestage(DeviceSetup.Exe), "any exe in the install folder restages");
        Assert(!DeviceUninstall.NeedsRestage(Path.Combine(DeviceSetup.Folder, "sub\\support.exe")) && !DeviceUninstall.NeedsRestage(Path.Combine(Path.GetTempPath(), "support-0.5.1-abcdef12.exe")), "nothing outside it does");
        Assert(DeviceUninstall.StagedFolder(Path.Combine(DeviceSetup.Folder, "support-0.5.1-abcdef12.exe")) == null, "a version file in the install folder names no folder to remove");
        // EndTrays looks only at processes outside session 0, so this check skips when the tests run in session 0 (a CI
        // runner as a service). It stays: the VM runs, in a signed-in session, cover it.
        if (Process.GetCurrentProcess().SessionId == 0) { Console.WriteLine("SKIP ending trays by folder: this test runs in session 0, where no tray runs"); }
        else {
            string trays = Path.Combine(dir, "trays-" + Guid.NewGuid().ToString("N")), elsewhere = Path.Combine(dir, "elsewhere-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(trays); Directory.CreateDirectory(elsewhere);
            string a = Path.Combine(trays, "support-9.9.9-abcdef12.exe"), b = Path.Combine(trays, "support.exe"), c = Path.Combine(elsewhere, "support-9.9.9-abcdef12.exe");
            foreach (string f in new string[] { a, b, c }) File.Copy(Path.Combine(Environment.SystemDirectory, "PING.EXE"), f);
            var procs = new List<Process>();
            foreach (string f in new string[] { a, b, c }) procs.Add(Process.Start(new ProcessStartInfo(f, "-n 60 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true }));
            try {
                Thread.Sleep(500);
                DeviceUninstall.EndTrays(trays);
                Assert(procs[0].WaitForExit(5000) && procs[1].WaitForExit(5000), "trays started from any exe in the folder end");
                Assert(!procs[2].HasExited, "a process from another folder is left alone");
            } finally { foreach (var p in procs) { try { if (!p.HasExited) p.Kill(); } catch (Exception) { } p.WaitForExit(5000); p.Dispose(); } }
        }
        Console.WriteLine("PASS uninstall with updates: the busy code, restaging from any version file, and ending trays by folder");
    }

    // The real service-control calls the switch and rollback make, on a throwaway demand-start service that is never
    // started: the command line (Scm.SetBinary, read back with Scm.ImagePath, quoting included) and the failure actions
    // (Scm.SetFailureActions with the rollback command and with the normal restarts, read back at levels 2 and 4). Needs
    // an elevated run; otherwise it says SKIP.
    static void ScmCallTests() {
        if (!SupportAccess.IsAdministrator()) { Console.WriteLine("SKIP the service-control calls: the tests are not running elevated"); return; }
        string name = "SupportMcpScmTest-" + Guid.NewGuid().ToString("N").Substring(0, 12);
        ScmProbe.Create(name, "\"" + Path.Combine(Environment.SystemDirectory, "PING.EXE") + "\"");
        try {
            string exe = Path.Combine(DeviceSetup.Folder, "support-99.0.0-abcdef12.exe"), bin = DeviceInstall.ServiceBinary(exe);
            Assert(bin == "\"" + exe + "\" --device-service" && exe.Contains(" "), "the command line quotes a path with a space: " + bin);
            Scm.SetBinary(name, bin);
            Assert(Scm.ImagePath(name) == bin, "SetBinary is stored exactly, quotes included: " + Scm.ImagePath(name));
            string cmd = DeviceUpdate.RollbackCommand(Path.Combine(DeviceSetup.Folder, "support.exe"));
            Scm.SetFailureActions(name, cmd);
            var q = ScmProbe.Query(name);
            Assert(q.Command == cmd && q.Reset == 86400 && string.Join(",", q.Steps.ToArray()) == "3/1000,3/1000,3/1000" && q.NonCrash,
                "the trial's actions: run the rollback on every failure, stops with an error included: " + q.Command + " " + q.Reset + " " + string.Join(",", q.Steps.ToArray()) + " " + q.NonCrash);
            Scm.SetFailureActions(name, null);
            q = ScmProbe.Query(name);
            Assert(string.IsNullOrEmpty(q.Command) && q.Reset == 86400 && string.Join(",", q.Steps.ToArray()) == "1/60000,1/60000,0/0" && !q.NonCrash,
                "the normal actions: two restarts a minute apart, no command, crashes only: " + q.Command + " " + q.Reset + " " + string.Join(",", q.Steps.ToArray()) + " " + q.NonCrash);
            Assert(Scm.Status(name) == System.ServiceProcess.ServiceControllerStatus.Stopped, "the service was never started");
        } finally { try { Scm.Delete(name); } catch (Exception) { } }
        Console.WriteLine("PASS the service-control calls: the command line and both sets of failure actions round-trip");
    }

    // The focus the confirm gives back: only to the window that had it, only while the support window still holds it.
    static void FocusReturnTests() {
        Func<IntPtr, bool> ours = delegate(IntPtr w) { return (int)w >= 100; }, here = delegate(IntPtr w) { return (int)w != 7; };
        IntPtr notepad = (IntPtr)10, corner = (IntPtr)100, other = (IntPtr)11;
        Assert(FocusReturn.Target(notepad, corner, ours, here) == notepad, "Keep connected gives the focus back to the window that had it");
        Assert(FocusReturn.Target(IntPtr.Zero, corner, ours, here) == IntPtr.Zero, "Nothing remembered, nothing to give back");
        Assert(FocusReturn.Target(notepad, other, ours, here) == IntPtr.Zero, "The customer clicked elsewhere meanwhile: the focus is not taken from that window");
        Assert(FocusReturn.Target(notepad, IntPtr.Zero, ours, here) == IntPtr.Zero, "No foreground window, no hand-back");
        Assert(FocusReturn.Target(corner, corner, ours, here) == IntPtr.Zero, "Never to one of the app's own windows");
        Assert(FocusReturn.Target((IntPtr)7, corner, ours, here) == IntPtr.Zero, "Not to a window that is gone or on another desktop");
        Console.WriteLine("PASS keep connected returns the focus to the remembered window and nowhere else");
    }
    static void ScreenPureTests(string dir) {
        FocusReturnTests();
        int w, h;
        foreach (int[] c in new int[][] { new int[] { 1920, 1080, 1280, 720 }, new int[] { 2560, 1600, 1280, 800 }, new int[] { 3840, 2160, 1280, 720 }, new int[] { 1280, 1024, 1000, 800 },
            new int[] { 1024, 768, 1024, 768 }, new int[] { 800, 600, 800, 600 }, new int[] { 1366, 768, 1280, 720 }, new int[] { 1, 1, 1, 1 } }) {
            ScreenMath.Fit(c[0], c[1], out w, out h);
            Assert(w == c[2] && h == c[3], "Fit " + c[0] + "x" + c[1] + " gave " + w + "x" + h);
        }
        // Screenshot pixels to physical pixels and back, on a scaled display and on one left of the primary.
        Assert(ScreenMath.ToPhysical(640, 1280, 1920) == 960 && ScreenMath.ToPhysical(0, 1280, 1920) == 0 && ScreenMath.ToPhysical(1279, 1280, 1920) == 1919, "Scaled point mapping");
        Assert(ScreenMath.ToPhysical(500, 1024, 1024) == 500 && ScreenMath.ToPhysical(5000, 1280, 1920) == 1919 && ScreenMath.ToPhysical(-4, 1280, 1920) == 0, "Unscaled mapping and clamping");
        Assert(ScreenMath.EdgeToPhysical(1280, 1280, 1920) == 1920 && ScreenMath.EdgeToPhysical(640, 1280, 1920) == 960, "Region edges");
        foreach (int[] d in new int[][] { new int[] { 1920, 1080 }, new int[] { 2560, 1600 }, new int[] { 3840, 2160 }, new int[] { 2113, 1182 }, new int[] { 1366, 768 }, new int[] { 1024, 768 } }) {
            ScreenMath.Fit(d[0], d[1], out w, out h);
            for (int x = 0; x < w; x += 7) {
                int p = ScreenMath.ToPhysical(x, w, d[0]);
                Assert(p >= 0 && p < d[0] && ScreenMath.ToImage(p, w, d[0]) == x, "Round trip x " + x + " on " + d[0] + " gave " + ScreenMath.ToImage(p, w, d[0]));
            }
            for (int y = 0; y < h; y += 7) Assert(ScreenMath.ToImage(ScreenMath.ToPhysical(y, h, d[1]), h, d[1]) == y, "Round trip y " + y + " on " + d[1]);
        }
        Assert(Marshal.SizeOf(typeof(Win.In)) == (IntPtr.Size == 4 ? 28 : 40), "SendInput structure size");
        Console.WriteLine("PASS screenshot scaling and coordinate mapping, both ways");
        Assert(Vks("ctrl+s", 0).Length == 2 && Vks("ctrl+s", 0)[0] == 0x11 && Vks("ctrl+s", 0)[1] == 0x53, "ctrl+s");
        Assert(Vks("alt+Tab", 0)[0] == 0x12 && Vks("alt+Tab", 0)[1] == 0x09, "alt+Tab");
        Assert(Vks("Return", 0)[0] == 0x0D && Vks("F5", 0)[0] == 0x74 && Vks("f12", 0)[0] == 0x7B && Vks("F24", 0)[0] == 0x87, "Return and function keys");
        Assert(Vks("shift+ctrl+Escape", 0)[0] == 0x10 && Vks("shift+ctrl+Escape", 0)[1] == 0x11 && Vks("Escape+ctrl", 0)[0] == 0x11 && Vks("Escape+ctrl", 0)[1] == 0x1B, "Modifiers come first");
        Assert(Vks("super+r", 0)[0] == 0x5B && Vks("Page_Down", 0)[0] == 0x22 && Vks("5", 0)[0] == 0x35 && Vks("A", 0)[0] == 0x41, "super, page_down, digits, letters");
        var seq = KeySpec.Parse("ctrl+a  Delete"); Assert(seq.Count == 2 && seq[1][0] == 0x2E, "Key sequences");
        Throws(delegate { KeySpec.Parse("ctrl+alt+Delete"); }, "send_sas"); Throws(delegate { KeySpec.Parse("Delete+alt+Control"); }, "send_sas");
        Throws(delegate { KeySpec.Parse("ctrl+banana"); }, "Unknown key"); Throws(delegate { KeySpec.Parse("   "); }, "No keys");
        Throws(delegate { KeySpec.Parse("super+l"); }, "LockWorkStation"); Throws(delegate { KeySpec.Parse("L+win"); }, "rundll32.exe user32.dll,LockWorkStation"); Throws(delegate { KeySpec.Parse("ctrl+a super+L"); }, "Win+L");
        Assert(KeySpec.Parse("super+r")[0].Length == 2 && KeySpec.Parse("ctrl+l")[0].Length == 2, "Other Win and L combinations still work");
        Assert(KeySpec.IsExtended(0x25) && KeySpec.IsExtended(0x2E) && !KeySpec.IsExtended(0x41), "Extended keys");
        Console.WriteLine("PASS xdotool-style key parsing, and ctrl+alt+del is refused with a pointer to send_sas");
        var clock = new PauseClock();
        Assert(!clock.Paused(0) && !clock.Paused(PauseClock.Now()), "No pause before any physical input");
        clock.Touch(10000);
        Assert(clock.Paused(10000) && clock.Paused(12999) && !clock.Paused(13000) && !clock.Paused(20000), "Pause lasts 3 s from the last physical event");
        clock.Touch(12000); Assert(clock.Paused(14999) && !clock.Paused(15000), "Each physical event restarts the pause");
        Console.WriteLine("PASS customer-input pause timer");
        using (var bmp = new System.Drawing.Bitmap(1280, 800, System.Drawing.Imaging.PixelFormat.Format24bppRgb)) {
            var noise = new Random(5); var pixels = new byte[1280 * 800 * 3]; noise.NextBytes(pixels);
            var data = bmp.LockBits(new System.Drawing.Rectangle(0, 0, 1280, 800), System.Drawing.Imaging.ImageLockMode.WriteOnly, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
            for (int row = 0; row < 800; row++) Marshal.Copy(pixels, row * 1280 * 3, new IntPtr(data.Scan0.ToInt64() + row * data.Stride), 1280 * 3);
            bmp.UnlockBits(data);
            int quality; byte[] jpeg = JpegFit.Encode(bmp, 700000, out quality);
            Assert(jpeg[0] == 0xFF && jpeg[1] == 0xD8 && Convert.ToBase64String(jpeg).Length < 700000, "Noise must fit under 700,000 characters as a JPEG");
            Assert(quality < 80, "Noise cannot fit at the first quality, quality " + quality);
            int easy; Assert(Convert.ToBase64String(JpegFit.Encode(bmp, 2000000, out easy)).Length < 2000000 && easy == 80, "A roomy limit keeps the first quality");
            int tight; byte[] small = JpegFit.Encode(bmp, 300000, out tight);
            Assert(Convert.ToBase64String(small).Length < 300000 && tight < quality, "A tighter limit steps the quality down further: " + tight + " vs " + quality);
        }
        Console.WriteLine("PASS JPEG quality steps down until the base64 text fits");
        Assert(UiLines.Line(12, "ControlType.Button", "OK", 640, 412) == "[12] Button \"OK\" (640,412)", "Basic line");
        Assert(UiLines.Line(3, "ControlType.Pane", "", 10, 20) == "[3] Pane (10,20)", "No name");
        Assert(UiLines.Line(4, "Edit", "say \"hi\"\r\nnow", 1, 2) == "[4] Edit \"say 'hi'  now\" (1,2)", "Quotes and line breaks");
        Assert(UiLines.Line(5, "Text", new string('x', 200), 1, 2).Length == "[5] Text \"".Length + 80 + "\" (1,2)".Length, "Long names are cut at 80 characters");
        // Each line ends with the verbs ui_act can use, from the patterns the element supports.
        Assert(UiLines.Line(12, "ControlType.Button", "OK", 640, 412, "invoke,focus") == "[12] Button \"OK\" (640,412) invoke,focus", "A line with verbs");
        Assert(UiLines.Line(12, "ControlType.Button", "OK", 640, 412, "") == "[12] Button \"OK\" (640,412)", "A line without verbs has no trailing space");
        Assert(UiLines.Verbs(true, false, false, false, false, false, true) == "invoke,focus", "A button: invoke and focus");
        Assert(UiLines.Verbs(false, true, false, false, false, false, true) == "set_value,focus", "A writable edit: set_value and focus");
        Assert(UiLines.Verbs(false, true, true, false, false, false, true) == "focus", "A read-only value is not set_value");
        Assert(UiLines.Verbs(false, false, false, true, false, false, false) == "toggle", "A check box that cannot take the focus: toggle only");
        Assert(UiLines.Verbs(false, false, false, false, true, false, true) == "expand,collapse,focus", "A tree node or combo box: expand, collapse and focus");
        Assert(UiLines.Verbs(true, true, false, true, true, true, true) == "invoke,set_value,toggle,expand,collapse,select,focus", "Every verb, in a fixed order");
        Assert(UiLines.Verbs(false, false, false, false, false, false, false) == "", "No pattern and no focus: no verbs");
        Assert(UiLines.Verbs(true, true, false, true, true, true, true, false) == "disabled", "A disabled element has no verbs and says so");
        Assert(UiLines.Line(5, "ControlType.Button", "Find next", 1, 2, UiLines.Verbs(true, false, false, false, false, false, true, false)) == "[5] Button \"Find next\" (1,2) disabled", "A disabled line");
        Assert(UiLines.Verbs(false, false, false, false, true, false, true, true, true) == "focus", "A leaf node has no expand or collapse");
        Assert(UiLines.Verbs(true, false, false, false, true, true, true, true, true) == "invoke,select,focus", "A leaf keeps its other verbs");
        Console.WriteLine("PASS ui_tree line formatting");
        // ui_tree text stays under the relay's 200,000 character limit and says when it was cut.
        var many = new List<string>(); for (int i = 1; i <= 3000; i++) many.Add(UiLines.Line(i, "ControlType.Text", new string('n', 80), 1000, 700));
        int kept; string joined = UiLines.Join(many, false, UiLines.MaxChars, out kept);
        Assert(joined.Length <= UiLines.MaxChars && joined.Length > UiLines.MaxChars - 400 && kept < many.Count && kept > 1000 && joined.EndsWith(UiLines.MoreByChars) && joined.Split('\n').Length == kept + 1, "A long tree is cut under the limit with a closing line, kept " + kept + " length " + joined.Length);
        Assert(UiLines.MaxChars + 10000 <= 200000, "The cap leaves room under the relay's text limit");
        var few = new List<string>(); few.Add("[1] A"); few.Add("[2] B");
        Assert(UiLines.Join(few, false, UiLines.MaxChars, out kept) == "[1] A\n[2] B" && kept == 2, "A short tree is unchanged");
        Assert(UiLines.Join(few, true, UiLines.MaxChars, out kept) == "[1] A\n[2] B\n" + UiLines.MoreByCount && kept == 2, "More elements than max_lines");
        Assert(UiLines.Join(new List<string>(), false, UiLines.MaxChars, out kept) == "" && kept == 0, "An empty tree");
        Console.WriteLine("PASS ui_tree text is capped below the relay limit");
        // The relay refuses a result that reports more than 16 displays.
        var rects = new List<System.Drawing.Rectangle>(); for (int i = 0; i < 20; i++) rects.Add(new System.Drawing.Rectangle(i * 100, 0, 100, 100));
        ScreenMath.CapDisplays(rects); Assert(rects.Count == 16 && rects[15].X == 1500, "Displays are clamped to 16");
        var few3 = new List<System.Drawing.Rectangle>(); few3.Add(new System.Drawing.Rectangle(0, 0, 10, 10)); ScreenMath.CapDisplays(few3); Assert(few3.Count == 1, "A normal PC keeps its displays");
        // ui_tree uses the display that holds the foreground window: left of, above, right of the primary, and off all of them.
        var layout = new List<System.Drawing.Rectangle>(); layout.Add(new System.Drawing.Rectangle(0, 0, 1920, 1080)); layout.Add(new System.Drawing.Rectangle(-1280, 100, 1280, 1024)); layout.Add(new System.Drawing.Rectangle(1920, 0, 1600, 900));
        Assert(ScreenMath.MonitorAt(layout, 960, 540) == 0 && ScreenMath.MonitorAt(layout, -1, 500) == 1 && ScreenMath.MonitorAt(layout, -1280, 100) == 1 && ScreenMath.MonitorAt(layout, 1920, 0) == 2 && ScreenMath.MonitorAt(layout, 1919, 1079) == 0, "A point maps to the display that holds it");
        Assert(ScreenMath.MonitorAt(layout, 3600, 450) == 2 && ScreenMath.MonitorAt(layout, -2000, 600) == 1 && ScreenMath.MonitorAt(layout, 500, 1500) == 0 && ScreenMath.MonitorAt(new List<System.Drawing.Rectangle>(), 1, 1) == -1, "A point on no display maps to the nearest one");
        Console.WriteLine("PASS display clamp and foreground display choice");
        // The pause survives a dropped hook: GetLastInputInfo counts, minus the app's own injected input.
        Assert(InputIdle.CustomerAgoMs(10000, 10500, 0, false) == 500 && InputIdle.RemainingMs(500) == 2500, "Input with no injection by the app is the customer's");
        Assert(InputIdle.CustomerAgoMs(10000, 10500, 10000, true) == -1 && InputIdle.CustomerAgoMs(10000, 10500, 10020, true) == -1 && InputIdle.RemainingMs(-1) == 0, "Input at the app's own injection tick is not the customer's");
        Assert(InputIdle.CustomerAgoMs(10100, 10500, 10000, true) == 400 && InputIdle.CustomerAgoMs(10011, 10500, 10000, true) == 489, "A later input after the app's injection is the customer's");
        Assert(InputIdle.CustomerAgoMs(10010, 10500, 10000, true) == -1 && InputIdle.SlackMs < 20, "The slack stays below the 20 ms typing gap");
        Assert(InputIdle.CustomerAgoMs(16, 32, 0, true) == 16, "One clock tick after the app's last event is the customer's, as it is for a key pressed during the typing gap");
        Assert(InputIdle.RemainingMs(3000) == 0 && InputIdle.RemainingMs(2999) == 1 && InputIdle.RemainingMs(0) == 3000, "Three seconds from the customer's input");
        Assert(InputIdle.CustomerAgoMs(4294967000u, 200u, 0, false) == 496 && InputIdle.CustomerAgoMs(4294967000u, 200u, 4294966900u, true) == 496 && InputIdle.CustomerAgoMs(4294967200u, 200u, 4294967290u, true) == -1, "The tick counter wraps");
        long month = 30L * 86400000; uint monthAgo = unchecked((uint)(5000 + month));
        Assert(InputIdle.CustomerAgoMs(5000, monthAgo, 0, false) == month && InputIdle.RemainingMs(month) == 0, "A PC idle for 30 days is idle, not paused");
        Assert(InputIdle.CustomerAgoMs(10005, 10000, 0, false) == 0 && InputIdle.RemainingMs(0) == 3000, "An input a moment ahead of the clock reads as just now");
        Assert(!InputIdle.Stuck(InputIdle.StuckMs - 1, false) && InputIdle.Stuck(InputIdle.StuckMs, false) && !InputIdle.Stuck(InputIdle.StuckMs * 10, true), "A key down for 10 s with no input since is stuck; one with input since (a held key repeats) is not");
        Console.WriteLine("PASS pause cross-check against GetLastInputInfo, and the stuck-key rule");
    }
    static string Hex(string b64) { return Convert.ToBase64String(Convert.FromBase64String(b64), 0, 2); }
    static Dictionary<string, object> Act(string name, params object[] pairs) {
        var a = Wire.Map(pairs); a["name"] = name; return Wire.Map("type", "screen", "lane", "screen", "action", a);
    }
    // Typing, results and run: the parts that need a client but no screen.
    static void ClientRuleTests(string dir) {
        // A result the relay refuses is replaced once by a plain error, and the client carries on.
        foreach (int code in new int[] { 400, 413 }) {
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 300000; relay.Start();
                relay.RejectOk = code;
                string id = relay.Queue(Run("[Console]::Write('refused')", 20));
                var r = relay.WaitResult(id, 20);
                Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == "result rejected by relay", "A refused result is replaced by an error (" + code + "): " + Wire.Text(r, "error"));
                Assert(relay.ResultCounts[id] == 2, "The refused result is sent once and its replacement once, not forever: " + relay.ResultCounts[id]);
                relay.RejectOk = 0;
                var next = relay.Call(Run("[Console]::Write('next')", 20));
                Assert(Wire.Flag(next, "ok") && Decode(next, "stdout_b64") == "next", "The client polls and runs the next command after a refused result");
                for (int i = 0; i < 100 && relay.Agent.BusyCount != 0; i++) Thread.Sleep(20);
                Assert(relay.Agent.BusyCount == 0, "The lane is free again");
            }
        }
        Console.WriteLine("PASS a result the relay refuses is replaced by an error once, and the client carries on");
        // Any other 4xx is a failure of the moment: the same result is sent again, not replaced.
        foreach (int code in new int[] { 408, 429 }) {
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 300000; relay.Start();
                relay.RejectOk = code;
                string id = relay.Queue(Run("[Console]::Write('kept')", 20));
                for (int i = 0; i < 100 && !relay.ResultCounts.ContainsKey(id); i++) Thread.Sleep(50);
                Assert(relay.ResultCounts.ContainsKey(id), "The result was sent");
                relay.RejectOk = 0;
                var r = relay.WaitResult(id, 20);
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == "kept" && relay.ResultCounts[id] >= 2, "A " + code + " takes the retry path and the real result gets through: " + Wire.Text(r, "error"));
            }
        }
        Console.WriteLine("PASS only 400 and 413 replace a result");
        // Run as: only the signed-in user in normal mode.
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            string marker = Path.Combine(dir, "as-system");
            foreach (string who in new string[] { "system", "root", "SYSTEM" }) {
                var cmd = Run("Set-Content -LiteralPath '" + marker + "' -Value ran", 20); cmd["as"] = who;
                var r = relay.Call(cmd);
                Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == (who == "system" ? "as: \"system\" needs full control" : "as must be user"), "as " + who + " is refused: " + Wire.Text(r, "error"));
                Assert(!File.Exists(marker), "A refused command does not run");
            }
            var user = Run("[Console]::Write('u')", 20); user["as"] = "user";
            var ok = relay.Call(user); Assert(Wire.Flag(ok, "ok") && Decode(ok, "stdout_b64") == "u", "as user runs");
            Console.WriteLine("PASS run as: system and anything but user is refused in normal mode");
        }
        // A reconnect without screen consent reports no screen cap and refuses screen frames.
        var withoutScreen = new FakeRelay();
        try {
            withoutScreen.Agent.ScreenAllowed = false; withoutScreen.Lifetime = 300000; withoutScreen.Start();
            var caps = (System.Collections.ArrayList)withoutScreen.Hello["caps"];
            Assert(caps.Count == 1 && caps.Contains("lanes") && !caps.Contains("screen"), "Hello without screen consent reports only lanes");
            var shot = withoutScreen.Call(Act("screenshot")); Assert(!Wire.Flag(shot, "ok") && Wire.Text(shot, "error").Contains("not approved"), "A screen frame is refused without consent: " + Wire.Text(shot, "error"));
            var run = withoutScreen.Call(Run("[Console]::Write('cmd')", 20)); Assert(Wire.Flag(run, "ok") && Decode(run, "stdout_b64") == "cmd", "Commands still run");
            // No Screen means no global input hooks and no F24 probe on the customer's PC.
            var screenField = typeof(Client).GetField("screen", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
            Assert(screenField != null && screenField.GetValue(withoutScreen.Agent) == null, "No Screen is created without screen consent");
            Assert(!withoutScreen.Agent.Paused, "Paused is false without a Screen");
            var lastPoll = withoutScreen.LastPoll;
            Assert(lastPoll != null && lastPoll.ContainsKey("desktop") && !lastPoll.ContainsKey("paused_until"), "The poll reports the desktop and no pause without a Screen");
        } finally { withoutScreen.Dispose(); }
        Console.WriteLine("PASS a reconnect without screen consent has commands and files only, and installs no input hooks");
        // Stop flag and pause between the steps of an input; type_secret keeps its errors generic.
        using (var screen = new Screen()) {
            screen.Start();
            var stop = new ManualResetEvent(true);
            try { screen.TypeText("abc", stop, false); throw new Exception("typing did not stop"); } catch (ScreenError e) { Assert(e.Message == "support access ended", "Stopped typing: " + e.Message); }
            stop = new ManualResetEvent(false);
            screen.TypeText("\r", stop, false); screen.TypeText("", stop, false);
            screen.Watch.Clock.Touch(PauseClock.Now());
            try { screen.TypeText("abc", stop, false); throw new Exception("typing did not pause"); } catch (ScreenError e) { Assert(e.Message == Screen.PauseText, "A pause before the first character has no count: " + e.Message); }
            try { screen.TypeText("abc", stop, true); throw new Exception("secret typing did not pause"); } catch (ScreenError e) { Assert(e.Message == Screen.PauseText, "A secret's error has no count: " + e.Message); }
            screen.Watch.Clock.Touch(-100000);
            var secret = screen.Run(Act("type_secret", "text", "S3CR3T-NEVER-ECHOED"), new ManualResetEvent(true));
            Assert(!Wire.Flag(secret, "ok") && Wire.Text(secret, "error") == Screen.SecretFailed && !Wire.Text(secret, "error").Contains("S3CR3T") && !secret.ContainsKey("text"), "type_secret returns only its generic error: " + Wire.Text(secret, "error"));
            var tooLong = screen.Run(Act("type_secret", "text", new string('x', 6000)), new ManualResetEvent(false));
            Assert(Wire.Text(tooLong, "error") == Screen.SecretFailed, "Even a refused secret returns the generic error");
        }
        Console.WriteLine("PASS input loops stop with the stop flag and the pause; type_secret errors are generic");
        // A reconnect needs the screen consent the prepare prompt records.
        var resume = Wire.Map("sid", Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"), "restart_resume", true, "resume_expires_at", Client.UnixNow() + 60000);
        try {
            Assert(!RestartResume.HasScreenConsent(resume), "A reconnect nobody prepared has no screen consent");
            RestartResume.Arm(resume, false);
            Assert(RestartResume.HasScreenConsent(resume) && !RestartResume.HasAdministratorConsent(resume), "Preparing records screen consent, and administrator consent only when asked");
            long expiry = Wire.Number(resume, "resume_expires_at"); resume["resume_expires_at"] = expiry + 1;
            Assert(!RestartResume.HasScreenConsent(resume), "The consent is bound to the deadline");
            resume["resume_expires_at"] = expiry;
            RestartResume.Disarm(resume);
            Assert(!RestartResume.HasScreenConsent(resume), "A used or cancelled reconnect clears the screen consent");
            using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\SupportMcp\ReconnectConsent")) key.SetValue(Wire.Text(resume, "sid"), "someone|" + expiry);
            Assert(!RestartResume.HasScreenConsent(resume), "An administrator consent from an older app is not screen consent");
        } finally { RestartResume.Disarm(resume); }
        Console.WriteLine("PASS a prepared reconnect carries screen consent only when the prompt recorded it");
    }
    // The service side of a Client in full control, without a service: screen frames are answered here, and
    // as: "user" runs with a copy of this process's own token, the way the service runs with the console user's.
    sealed class FakeFull : IFullControl {
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr result);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        public bool SignedIn = true; public long WelcomedAt; public int Screens;
        public bool Limited { get { return false; } }
        public string UserName { get { return "tester"; } }
        public Dictionary<string, object> ScreenOp(Dictionary<string, object> frame, WaitHandle stop) { Screens++; return Wire.Map("ok", true, "desktop", "secure"); }
        public IntPtr UserToken(out string profile) {
            if (!SignedIn) throw new ArgumentException(TokenChoice.NobodySignedIn);
            IntPtr own, dup;
            if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out own)) throw new Exception("OpenProcessToken");
            try { if (!DuplicateTokenEx(own, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Exception("DuplicateTokenEx"); } finally { CloseHandle(own); }
            profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); return dup;
        }
        public void Report(Dictionary<string, object> poll, long serverOffsetMs) { poll["desktop"] = "secure"; poll["input_blocked_until"] = Client.UnixNow() + 60000; }
        public void Welcomed(long expiresAtMs) { WelcomedAt = expiresAtMs; }
    }

    // One process gets at most 2 connections of the window pipe, idle ones are cut off after 5 s, and an end the service
    // never confirms finishes as Lost. A connection counts once its server thread takes it, and the threads of clients
    // that connect together can take them in any order. So each idle client first gets an answer, which proves it is
    // counted, and the test then waits for the server to cut them off (it counts a client out before it disconnects it).
    static void PerProcessLimit(string uiSddl) {
        string sid8b = Guid.NewGuid().ToString("N").Substring(0, 8), name = Backstop.Name(sid8b) + "-ui"; int endedB = 0;
        new UiServer(name, delegate { return Wire.Map("connected", true, "link", true, "ended", false); }, delegate { Interlocked.Increment(ref endedB); }, delegate(uint session) { return true; }, uiSddl);
        var idle = new List<System.IO.Pipes.NamedPipeClientStream>(); var asked = new List<Stopwatch>();
        try {
            for (int i = 0; i < UiServer.PerProcess; i++) {
                var c = Pipes.Client(name); idle.Add(c); c.Connect(2000);
                asked.Add(Stopwatch.StartNew()); Pipes.Write(c, Wire.Map("type", "status"));
                Assert(Wire.Flag(Pipes.Read(c, 4096, UiServer.ReadMs), "connected"), "An idle client is served first");
            }
            Assert(!ServiceLink.Running(sid8b), "A third connection of the same process is refused");
            for (int i = 0; i < idle.Count; i++) {
                try { Pipes.Read(idle[i], 4096, UiServer.ReadMs + 30000); throw new Exception("an idle client got a message"); } catch (IOException) { }
                // Windows may end a wait up to a clock tick early.
                Assert(asked[i].ElapsedMilliseconds >= UiServer.ReadMs - 100, "An idle client was cut off after " + asked[i].ElapsedMilliseconds + " ms");
            }
        } finally { foreach (var c in idle) c.Dispose(); }
        Assert(ServiceLink.Running(sid8b), "The idle clients were cut off and the process gets through again");
        // A service that never confirms the end: the window says it cannot reach it, not that the session ended.
        ServiceLink.EndMs = 2000;
        try {
            var stubborn = new ServiceLink(sid8b); int stubbornDone = 0; stubborn.Finished += delegate { stubbornDone++; }; stubborn.Start();
            Thread.Sleep(800); stubborn.Stop(); stubborn.Flush(10000);
            Assert(stubbornDone == 1 && stubborn.Lost && endedB >= 3, "The end goes out on the connection the window holds, again and again, and an unconfirmed end finishes as Lost: " + endedB);
        } finally { ServiceLink.EndMs = 30000; }
    }

    // A program the command started without waiting (like rundll32 user32.dll,LockWorkStation) gets up to a second to
    // finish: here a copy of this test program that waits 250 ms, started last. One that keeps running is killed
    // once that second is over, and the client's stop ends the second at once. Not a cscript script: on the
    // 20261103 Windows Server 2025 runner image cscript takes about two seconds to start, longer than that second.
    internal static void SettleTests(FakeRelay relay, string dir) {
        string tag = Guid.NewGuid().ToString("N").Substring(0, 8);
        string quick = Path.Combine(dir, "settle-quick-" + tag), slowPid = Path.Combine(dir, "settle-pid-" + tag), self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        var r = relay.Call(Run("$s = Start-Process cmd.exe -WindowStyle Hidden -PassThru -ArgumentList '/c ping -n 30 127.0.0.1 >nul'; Set-Content -LiteralPath '" + slowPid.Replace("'", "''")
            + "' -Value ([string]$s.Id + ' ' + $s.StartTime.ToUniversalTime().Ticks); Start-Process -FilePath '" + self.Replace("'", "''") + "' -WindowStyle Hidden -ArgumentList '--settle \"" + quick.Replace("'", "''") + "\"'; [Console]::Write([DateTime]::UtcNow.Ticks)", 30));
        long settledMs = (DateTime.UtcNow.Ticks - long.Parse(Decode(r, "stdout_b64"))) / 10000;
        Assert(Wire.Flag(r, "ok") && File.Exists(quick), "A program the command did not wait for finishes");
        Assert(settledMs >= CommandJob.SettleMs - 100 && settledMs < 10000, "The result waits about a second for a program that keeps running: " + settledMs + " ms");
        // The pid with its start time, so a reused pid cannot pass for the slow child.
        string[] slow = File.ReadAllText(slowPid).Trim().Split(' '); bool slowGone = true;
        try { using (var p = Process.GetProcessById(int.Parse(slow[0]))) if (p.StartTime.ToUniversalTime().Ticks == long.Parse(slow[1])) slowGone = p.WaitForExit(1000); }
        catch (ArgumentException) { } catch (InvalidOperationException) { }
        Assert(slowGone, "The program that keeps running is killed after that second");
        // The stop comes 50 ms after PowerShell itself exited (the script writes its pid), so it falls in the settle second.
        string marker = Path.Combine(dir, "settle-marker-" + tag), script = Path.Combine(dir, "settle-stop-" + tag + ".ps1");
        File.WriteAllText(script, "Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c ping -n 30 127.0.0.1 >nul'; Set-Content -LiteralPath '" + marker.Replace("'", "''") + "' -Value $PID");
        var stop = new ManualResetEvent(false); var clock = Stopwatch.StartNew(); long stoppedAt = long.MaxValue;
        var stopper = new Thread(delegate() {
            while (clock.ElapsedMilliseconds < 30000) { try { if (File.Exists(marker) && File.ReadAllText(marker).Trim().Length > 0) break; } catch (IOException) { } Thread.Sleep(5); }
            try { using (var ps = Process.GetProcessById(int.Parse(File.ReadAllText(marker).Trim()))) ps.WaitForExit(30000); } catch (ArgumentException) { }
            Thread.Sleep(50); stoppedAt = clock.ElapsedMilliseconds; stop.Set();
        });
        stopper.Start();
        try { using (var job = new CommandJob()) job.Run(script, dir, 30, stop); } catch (OperationCanceledException) { }
        long ended = clock.ElapsedMilliseconds; stopper.Join();
        Assert(stoppedAt <= ended && ended - stoppedAt < 300, "The client's stop ends the settle second at once: " + (ended - stoppedAt) + " ms after it");
    }

    // One elevation attempt with a stand-in for staging and UAC. The drop clock starts at the prompt, not at the staging; a
    // withdrawal during the staging shows no prompt; Discard removes the staged copy of a prompt nobody answered; and the
    // sweep at start removes only old staged folders directly in Temp, without following a junction inside.
    static void AttemptTests() {
        string a8 = Guid.NewGuid().ToString("N").Substring(0, 8), dir = Path.Combine(Path.GetTempPath(), "support-mcp-attempt-" + a8); Directory.CreateDirectory(dir);
        Func<string> slowStage = delegate { Thread.Sleep(1200); string d = Path.Combine(dir, Elevation.StagePrefix + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(d); File.WriteAllText(Path.Combine(d, "app.exe"), "x"); return Path.Combine(d, "app.exe"); };
        var no = new Elevation.Attempt(a8, slowStage, delegate(string copy, string nonce, Action answered) { Thread.Sleep(100); return -1223; }, 1000, delegate { });
        Assert(no.Done.WaitOne(10000) && no.Outcome == Elevation.Declined, "A No 100 ms into the prompt is a No, however long the staging took: " + no.Outcome);
        var drop = new Elevation.Attempt(a8, slowStage, delegate(string copy, string nonce, Action answered) { Thread.Sleep(1100); return -1223; }, 1000, delegate { });
        Assert(drop.Done.WaitOne(10000) && drop.Outcome == Elevation.NoAnswer, "A No after the drop time is Windows dropping the prompt: " + drop.Outcome);
        bool prompted = false; ManualResetEvent staging = new ManualResetEvent(false), go = new ManualResetEvent(false);
        var early = new Elevation.Attempt(a8, delegate { staging.Set(); go.WaitOne(); return slowStage(); }, delegate(string copy, string nonce, Action answered) { prompted = true; return 0; }, 300, delegate { });
        staging.WaitOne(); early.Withdraw(); go.Set();
        Assert(early.Done.WaitOne(10000) && !prompted && early.Outcome == Elevation.NoAnswer, "A withdrawal during the staging shows no prompt");
        string staged = null; ManualResetEvent asking = new ManualResetEvent(false), answer = new ManualResetEvent(false);
        var open = new Elevation.Attempt(a8, delegate { staged = slowStage(); return staged; }, delegate(string copy, string nonce, Action answered) { asking.Set(); answer.WaitOne(); return -1223; }, 300, delegate { });
        asking.WaitOne(); open.Discard();
        Assert(!Directory.Exists(Path.GetDirectoryName(staged)), "Discard removes the staged copy of a prompt nobody answered");
        answer.Set(); open.Done.WaitOne(10000);
        var yes = new Elevation.Attempt(a8, delegate { staged = slowStage(); return staged; }, delegate(string copy, string nonce, Action answered) { answered(); asking.Set(); answer.WaitOne(); return 0; }, 300, delegate { });
        asking.Reset(); answer.Reset(); asking.WaitOne(); yes.Discard();
        Assert(Directory.Exists(Path.GetDirectoryName(staged)), "Discard leaves the copy of an answered prompt alone");
        answer.Set(); Assert(yes.Done.WaitOne(10000) && yes.Outcome == Elevation.Installed && yes.EndedAt > 0, "The installer's exit code 0 is Installed");
        // The sweep: an hour-old staged folder (with a junction to a folder outside), a young one, another name, and a staged
        // name one level down.
        string temp = Path.Combine(dir, "sweep-" + a8), victim = Path.Combine(dir, "victim-" + a8);
        Directory.CreateDirectory(victim); File.WriteAllText(Path.Combine(victim, "keep.txt"), "x");
        string old = Path.Combine(temp, Elevation.StagePrefix + "old"), young = Path.Combine(temp, Elevation.StagePrefix + "young"), other = Path.Combine(temp, "other-old"), deep = Path.Combine(other, Elevation.StagePrefix + "deep");
        foreach (string d in new string[] { old, young, deep }) Directory.CreateDirectory(d);
        MkLink("/J", Path.Combine(old, "link"), victim);
        Assert(Directory.Exists(Path.Combine(old, "link")), "Test setup: the junction exists");
        foreach (string d in new string[] { old, other, deep }) Directory.SetCreationTimeUtc(d, DateTime.UtcNow.AddHours(-2));
        Elevation.SweepStaged(temp);
        Assert(!Directory.Exists(old) && Directory.Exists(young) && Directory.Exists(deep) && File.Exists(Path.Combine(victim, "keep.txt")),
            "The sweep removes only an old staged folder directly in Temp, and not what a junction inside points to: old " + Directory.Exists(old)
            + " young " + Directory.Exists(young) + " deep " + Directory.Exists(deep) + " victim " + File.Exists(Path.Combine(victim, "keep.txt")));
        DeleteTreeTests(dir);
        try { Directory.Delete(dir, true); } catch (Exception) { }
    }
    static void MkLink(string kind, string link, string target) {
        using (var mk = Process.Start(new ProcessStartInfo("cmd.exe", "/c mklink " + kind + " \"" + link + "\" \"" + target + "\"") { UseShellExecute = false, CreateNoWindow = true })) mk.WaitForExit();
    }
    // DeleteTree never follows a link: not the folder it is asked to delete, not a junction inside, not a folder swapped
    // for a junction after it was listed; and it never changes the attributes of a file another hard link shares.
    static void DeleteTreeTests(string dir) {
        string t8 = Guid.NewGuid().ToString("N").Substring(0, 8), root = Path.Combine(dir, "tree-" + t8);
        Func<string, string> victimOf = delegate(string name) { string v = Path.Combine(root, "victim-" + name); Directory.CreateDirectory(v); File.WriteAllText(Path.Combine(v, "keep.txt"), "x"); return v; };
        Directory.CreateDirectory(root);
        string top = victimOf("top"), topLink = Path.Combine(root, Elevation.StagePrefix + "link");
        MkLink("/J", topLink, top);
        Elevation.DeleteTree(topLink);
        Assert(!Directory.Exists(topLink) && File.Exists(Path.Combine(top, "keep.txt")), "A staged folder that is itself a junction: the link goes, its target stays");
        // A subfolder swapped for a junction between the listing of its parent and its own opening, and between its check
        // and its listing (the folder is then held, so the swap itself fails).
        string swapped = victimOf("swap"), race = Path.Combine(root, Elevation.StagePrefix + "race"), sub = Path.Combine(race, "sub");
        Action<string> swap = delegate(string name) {
            if (name != "sub" || Directory.Exists(sub + "-moved")) return;
            try { Directory.Move(sub, sub + "-moved"); MkLink("/J", sub, swapped); } catch (IOException) { }
        };
        Directory.CreateDirectory(sub); File.WriteAllText(Path.Combine(sub, "inner.txt"), "x");
        Native.BeforeOpen = swap;
        try { Elevation.DeleteTree(race); } catch (Exception) { } finally { Native.BeforeOpen = null; }
        Assert(!Directory.Exists(sub) && File.Exists(Path.Combine(swapped, "keep.txt")), "A folder swapped for a junction after the listing: the junction goes, its target stays: swapped "
            + Directory.Exists(sub + "-moved") + ", left " + Directory.Exists(sub) + ", target kept " + File.Exists(Path.Combine(swapped, "keep.txt")));
        if (Directory.Exists(sub + "-moved")) Directory.Delete(sub + "-moved", true);
        Directory.CreateDirectory(sub); File.WriteAllText(Path.Combine(sub, "inner.txt"), "x");
        Native.AfterCheck = swap;
        try { Elevation.DeleteTree(race); } catch (Exception) { } finally { Native.AfterCheck = null; }
        Assert(File.Exists(Path.Combine(swapped, "keep.txt")), "A folder swapped for a junction after its check is not followed");
        string shared = Path.Combine(victimOf("hard"), "shared.txt"), hard = Path.Combine(root, Elevation.StagePrefix + "hard");
        File.WriteAllText(shared, "x"); File.SetAttributes(shared, FileAttributes.ReadOnly | FileAttributes.Hidden);
        Directory.CreateDirectory(hard); MkLink("/H", Path.Combine(hard, "link.txt"), shared);
        var before = File.GetAttributes(shared);
        Assert((before & (FileAttributes.ReadOnly | FileAttributes.Hidden)) == (FileAttributes.ReadOnly | FileAttributes.Hidden), "Test setup: the shared file is read-only and hidden");
        try { Elevation.DeleteTree(hard); } catch (Exception) { }
        Assert(File.Exists(shared) && File.GetAttributes(shared) == before, "The attributes of a file another hard link shares stay as they were: " + File.GetAttributes(shared));
        string plain = Path.Combine(root, Elevation.StagePrefix + "plain"), ro = Path.Combine(plain, "deep", "ro.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(ro)); File.WriteAllText(ro, "x"); File.SetAttributes(ro, FileAttributes.ReadOnly);
        Elevation.DeleteTree(plain);
        Assert(!Directory.Exists(plain), "A plain staged folder goes, with a read-only file in a subfolder");
        File.SetAttributes(shared, FileAttributes.Normal);
        foreach (string f in Directory.GetFiles(root, "*", SearchOption.AllDirectories)) try { File.SetAttributes(f, FileAttributes.Normal); } catch (Exception) { }
    }

    static void QuestionTests() {
        // Before UAC the full-control question stays open after Allow, as the owner of the UAC prompt (Windows shows the prompt in
        // front only for an app in the foreground, and the click on Allow gives it that), says that Windows asks now, and cannot
        // be closed until the app finishes it. It is modeless: the corner window, with End session, stays enabled throughout.
        // Allow does nothing in its first 500 ms. Don't allow closes it at once. As the app's own confirm (no UAC), Allow closes it.
        {
            bool cornerOpen = false, cornerHeld = false, early = true, allowHeld = false, closeRefused = false, finished = false, denyClosed = false, confirmClosed = false;
            var t = new Thread(delegate() {
                Action pump = delegate { for (int i = 0; i < 10; i++) { Application.DoEvents(); System.Windows.Threading.Dispatcher.CurrentDispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Background, new Action(delegate { })); Thread.Sleep(25); } };
                Func<System.Windows.DependencyObject, string, System.Windows.Controls.Button> button = delegate(System.Windows.DependencyObject w, string text) { return Find<System.Windows.Controls.Button>(w, delegate(System.Windows.Controls.Button b) { return text.Equals(b.Content); }); };
                var corner = new SupportWindow(Palette.Detect(), false, false, null); corner.Show(); pump();
                IntPtr cornerHandle = new System.Windows.Interop.WindowInteropHelper(corner).Handle;
                var d = ConsentDialog.Open(true);
                // Loaded comes asynchronously: wait for it, so only the time guards Allow, and press at once after it.
                for (int i = 0; i < 400 && !d.IsLoaded; i++) { System.Windows.Threading.Dispatcher.CurrentDispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Background, new Action(delegate { })); Thread.Sleep(5); }
                var allow = button(d, "Allow");
                Press(allow); pump(); early = d.Allowed || d.Decided.WaitOne(0) || !allow.IsVisible;
                cornerOpen = IsWindowEnabled(cornerHandle);
                Thread.Sleep(ConsentDialog.ArmMs); pump();
                Press(allow); pump();
                allowHeld = d.IsVisible && d.Allowed && d.Decided.WaitOne(0) && !allow.IsVisible
                    && Find<System.Windows.Controls.TextBlock>(d, delegate(System.Windows.Controls.TextBlock b) { return b.Text == SupportAccess.Asking && b.IsVisible; }) != null;
                cornerHeld = IsWindowEnabled(cornerHandle);
                d.Close(); pump(); closeRefused = d.IsVisible;
                d.Finish(); pump(); finished = !d.IsVisible;
                var n = ConsentDialog.Open(true); pump();
                Press(button(n, "Don't allow")); pump();
                denyClosed = !n.IsVisible && !n.Allowed && n.Decided.WaitOne(0); n.Finish();
                var c = ConsentDialog.Open(false); pump(); Thread.Sleep(ConsentDialog.ArmMs);
                Press(button(c, "Allow")); pump();
                confirmClosed = !c.IsVisible && c.Allowed && c.Decided.WaitOne(0); c.Finish();
                corner.CloseQuietly(); pump();
            }); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
            Assert(cornerOpen && cornerHeld, "The corner window stays enabled while the question is open and while it waits for UAC");
            Assert(!early, "Allow does nothing right after the question appears");
            Assert(allowHeld, "Allow before UAC keeps the question open and says that Windows asks now");
            Assert(closeRefused && finished, "The question cannot be closed while UAC asks, only finished by the app");
            Assert(denyClosed, "Don't allow closes the question");
            Assert(confirmClosed, "Allow on the app's own confirm closes it");
            // The installer goes ahead only while the event of its own attempt (a random nonce) exists and is not set, and it
            // keeps the event: the app exiting afterwards withdraws nothing, setting it does. Nobody can make the event first.
            string w8 = Guid.NewGuid().ToString("N").Substring(0, 8), n1 = Elevation.Nonce(), n2 = Elevation.Nonce();
            Func<string, bool> wanted = delegate(string nonce) { using (var h = Elevation.Wanted(w8, nonce)) return h != null; };
            Assert(n1 != n2 && System.Text.RegularExpressions.Regex.IsMatch(n1, "^[0-9a-f]{32}$"), "Each attempt has a nonce of its own");
            Assert(!wanted(n1), "No attempt: the installer installs nothing");
            EventWaitHandle held;
            using (var want = Elevation.Want(w8, n1)) {
                Assert(wanted(n1) && !wanted(n2), "Only the attempt with that nonce is wanted");
                using (var other = Elevation.Want(w8, n2)) { other.Set(); Assert(wanted(n1) && !wanted(n2), "Withdrawing one attempt leaves another alone"); }
                held = Elevation.Wanted(w8, n1);
            }
            Assert(held != null && !held.WaitOne(0), "The installer's open event outlives the app and stays unset");
            held.Dispose();
            Assert(!wanted(n1), "With no one holding it, an attempt whose app is gone is not wanted");
            using (var want = Elevation.Want(w8, n1)) {
                held = Elevation.Wanted(w8, n1); want.Set();
                Assert(held.WaitOne(0) && !wanted(n1), "A withdrawal reaches an installer that already holds the event");
                held.Dispose();
            }
            using (var squat = new EventWaitHandle(false, EventResetMode.ManualReset, Elevation.WantName(w8, n2))) {
                bool refused = false; try { Elevation.Want(w8, n2).Dispose(); } catch (IOException) { refused = true; }
                Assert(refused, "An event someone made first is refused");
            }
        }
    }

    static void FullControlTests(string dir) {
        Assert(ConsentPath.Decide(true, 2, 1, 5) == Consent.Confirm && ConsentPath.Decide(true, 1, 0, -1) == Consent.Confirm, "An elevated app (or UAC off for an administrator) gets no UAC prompt, so it asks itself");
        Assert(ConsentPath.Decide(false, 3, 1, 0) == Consent.Confirm && ConsentPath.Decide(false, 3, -1, 0) == Consent.Confirm, "An administrator who elevates without a prompt is asked by the app");
        Assert(ConsentPath.Decide(false, 1, 0, -1) == Consent.Unavailable && ConsentPath.Decide(false, 1, 0, 0) == Consent.Unavailable, "UAC off and a standard user: full control is impossible");
        Assert(ConsentPath.Decide(false, 3, 1, 5) == Consent.Prompt && ConsentPath.Decide(false, 3, -1, -1) == Consent.Prompt && ConsentPath.Decide(false, 3, 1, 2) == Consent.Prompt, "An administrator with UAC gets the UAC prompt");
        Assert(ConsentPath.Decide(false, 1, 1, 0) == Consent.Prompt && ConsentPath.Decide(false, 1, -1, 5) == Consent.Prompt, "A standard user gets the UAC credential prompt (ConsentPromptBehaviorAdmin does not apply)");
        Assert(SupportAccess.LimitedHeading + " " + SupportAccess.LimitedText == "Continue with limited support? Support can see your screen and control your mouse and keyboard, but not Windows security prompts.", "Fallback text");
        Assert(SupportAccess.FullHeading + " " + SupportAccess.FullText == "Give support full control of this PC? Support can see your screen, control your mouse and keyboard, work through Windows security prompts and the sign-in screen, and keep working after a restart. Access ends when you click End session, or after 24 hours, and everything is removed.", "Full control text");
        Assert(SupportAccess.Asking == "Windows will ask for permission to give support full control.", "Notice before UAC");
        Console.WriteLine("PASS full-control consent: the UAC prompt, the app's own confirm, or unavailable, and the texts");

        // ACLs: the service folder is SYSTEM and Administrators only, with nothing inherited.
        var folder = FullAcl.Folder(); var rules = folder.GetAccessRules(true, true, typeof(SecurityIdentifier));
        Assert(folder.AreAccessRulesProtected && rules.Count == 2, "Folder ACL: protected, two rules, got " + rules.Count);
        foreach (FileSystemAccessRule r in rules)
            Assert((r.IdentityReference.Equals(FullAcl.SystemSid) || r.IdentityReference.Equals(FullAcl.AdminsSid)) && r.FileSystemRights == FileSystemRights.FullControl && r.AccessControlType == AccessControlType.Allow
                && r.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) && !r.IsInherited, "Folder rule " + r.IdentityReference);
        var window = FullAcl.Window(); var wrules = window.GetAccessRules(true, true, typeof(SecurityIdentifier)); int users = 0;
        Assert(window.AreAccessRulesProtected && wrules.Count == 3, "Window ACL: protected, three rules");
        foreach (FileSystemAccessRule r in wrules) {
            if (!r.IdentityReference.Equals(FullAcl.UsersSid)) { Assert(r.FileSystemRights == FileSystemRights.FullControl, "SYSTEM and Administrators own window.exe"); continue; }
            users++; Assert((r.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute && (r.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) == 0, "Users may only read and run window.exe");
        }
        Assert(users == 1, "Users read window.exe");
        var me = WindowsIdentity.GetCurrent().User; var script = FullAcl.Script(me);
        foreach (FileSystemAccessRule r in script.GetAccessRules(true, true, typeof(SecurityIdentifier))) if (r.IdentityReference.Equals(me)) Assert((r.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete)) == 0, "The user may read a command script, not change it");
        // On disk, as icacls shows it. The folder is created in one step with its ACL, and never over an existing one.
        string aclDir = Path.Combine(dir, "acl-folder"); Native.CreateLocked(aclDir, FullAcl.Folder());
        try {
            try { Native.CreateLocked(aclDir, FullAcl.Folder()); throw new Exception("an existing folder was adopted"); } catch (System.ComponentModel.Win32Exception e) { Assert(e.NativeErrorCode == 183, "Exists: " + e.NativeErrorCode); }
            var icacls = Process.Start(new ProcessStartInfo("icacls.exe", "\"" + aclDir + "\"") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true });
            string shown = icacls.StandardOutput.ReadToEnd(); icacls.WaitForExit();
            string sys = FullAcl.SystemSid.Translate(typeof(NTAccount)).Value, admins = FullAcl.AdminsSid.Translate(typeof(NTAccount)).Value;
            int entries = 0; foreach (string line in shown.Split('\n')) if (line.Contains(":(")) entries++;
            Assert(shown.Contains(sys + ":(OI)(CI)(F)") && shown.Contains(admins + ":(OI)(CI)(F)") && entries == 2, "icacls shows SYSTEM and Administrators with full control, inherited by files and folders, and nobody else:\n" + shown);
        } finally {
            var mine = new DirectorySecurity(); mine.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, AccessControlType.Allow));
            Directory.SetAccessControl(aclDir, mine); Directory.Delete(aclDir);
        }
        // The folder goes under %ProgramFiles%, read from HKLM, where Users may not create or delete anything.
        Assert(FullInstall.Folder("abcd1234").EndsWith(@"\SupportMCP-abcd1234") && Directory.Exists(FullInstall.Root) && !FullInstall.Root.ToUpperInvariant().Contains("PROGRAMDATA"), "The session folder: " + FullInstall.Folder("abcd1234"));
        foreach (FileSystemAccessRule r in Directory.GetAccessControl(FullInstall.Root).GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (r.IdentityReference.Equals(FullAcl.UsersSid) && r.AccessControlType == AccessControlType.Allow && r.PropagationFlags != PropagationFlags.InheritOnly)
                Assert((r.FileSystemRights & (FileSystemRights.CreateDirectories | FileSystemRights.CreateFiles | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) == 0, "Users cannot create or delete in " + FullInstall.Root + ": " + r.FileSystemRights);
        Console.WriteLine("PASS full-control ACLs: the folder (checked with icacls), window.exe and command scripts");

        // The deadline: saved and loaded with the full session id, expiry, the 24-hour cap, and the first welcome.
        long now = Client.UnixNow(); string fullSid = new string('c', 64);
        var st = new FullState { Sid = fullSid, Task = Backstop.NewTask("cccccccc"), Deadline = now + 7200000, AppPid = 4242 }; st.Save(dir);
        var back = FullState.Load(dir);
        Assert(back != null && back.Deadline == st.Deadline && !back.Welcomed && back.Sid == fullSid && back.AppPid == 4242 && back.Task == st.Task && back.Task.StartsWith("SupportMcp-cccccccc-") && back.Task.Length == 28, "State round trip, with this install's own task name");
        Assert(Backstop.NewTask("cccccccc") != Backstop.NewTask("cccccccc"), "Every install gets a task name of its own");
        back.Welcomed = true; back.Save(dir); back = FullState.Load(dir);
        Assert(back.Welcomed && !File.Exists(FullState.PathIn(dir) + ".new"), "State is replaced in place");
        File.WriteAllText(FullState.PathIn(dir), "{\"deadline\":" + (now + 5000) + "}"); Assert(FullState.Load(dir) == null, "A state without the full session id is treated as over");
        File.WriteAllText(FullState.PathIn(dir), "{not json"); Assert(FullState.Load(dir) == null, "A damaged state is treated as over");
        File.WriteAllText(FullState.PathIn(dir), "{\"deadline\":\"soon\"}"); Assert(FullState.Load(dir) == null, "A state of the wrong type is treated as over");
        File.Delete(FullState.PathIn(dir)); Assert(FullState.Load(dir) == null, "A missing state is treated as over");
        Assert(!FullState.Expired(now + 1, now) && FullState.Expired(now, now) && FullState.Expired(now - 1, now), "Expired at the deadline");
        Assert(FullState.Clamp(now + 3 * FullState.DayMs, now) == now + FullState.DayMs && FullState.Clamp(now + 5000, now) == now + 5000, "Never more than 24 hours");
        Assert(FullState.OnWelcome(now + 7200000, false, now + 86000000, now) == now + 86000000, "The first welcome moves connect_by to the session's expiry");
        Assert(FullState.OnWelcome(now + 50000000, true, now + 86000000, now) == now + 50000000 && FullState.OnWelcome(now + 50000000, true, now + 1000, now) == now + 1000, "A later welcome never extends the deadline, only brings it closer");
        Assert(FullState.OnWelcome(now + 7200000, false, now + 5 * FullState.DayMs, now) == now + FullState.DayMs, "A relay expiry beyond 24 hours is capped");
        Assert(SasShare.Needed(-1) && SasShare.Needed(0) && SasShare.Needed(2) && !SasShare.Needed(1) && !SasShare.Needed(3) && SasShare.Wanted(-1) == 1 && SasShare.Wanted(0) == 1 && SasShare.Wanted(2) == 3, "SoftwareSASGeneration changes only when services may not send SAS; ease of access apps keep their right");
        Console.WriteLine("PASS full-control state: persistence, expiry, the 24-hour cap and the first welcome");

        // SoftwareSASGeneration shared by sessions, in a test copy of the two keys under HKCU. The C# release and the
        // backstop's PowerShell release must behave the same.
        string testKey = @"Software\SupportMcpTest-" + Guid.NewGuid().ToString("N");
        SasShare.MutexName = @"Local\SupportMcpTest-Sas-" + Guid.NewGuid().ToString("N"); // a Global one needs administrator rights
        // The test account makes these mutexes itself, so it is trusted as their owner here (issue #22; OwnerCheckTests
        // checks the refusal). An elevated account's objects are owned by Administrators anyway.
        OwnerCheck.AlsoTrusted = WindowsIdentity.GetCurrent().User;
        Func<Microsoft.Win32.RegistryKey> root = delegate { return Microsoft.Win32.Registry.CurrentUser.CreateSubKey(testKey); };
        Func<object> sas = delegate { using (var r = root()) using (var k = r.OpenSubKey(SasShare.PolicyKey)) return k == null ? null : k.GetValue(SasShare.Value); };
        Action<object> setSas = delegate(object v) { using (var r = root()) using (var k = r.CreateSubKey(SasShare.PolicyKey)) { if (v == null) k.DeleteValue(SasShare.Value, false); else k.SetValue(SasShare.Value, v, Microsoft.Win32.RegistryValueKind.DWord); } };
        Func<bool> clean = delegate { using (var r = root()) return r.OpenSubKey(SasShare.RootKey) == null; };
        Action<string> psRelease = delegate(string holder) {
            var ps = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript(@"HKCU:\" + testKey, holder) + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true });
            string err = ps.StandardError.ReadToEnd(); ps.WaitForExit(); Assert(ps.ExitCode == 0 && err.Trim() == "", "The backstop's PowerShell runs cleanly: " + err);
        };
        try {
            foreach (bool viaPowerShell in new bool[] { false, true }) {
                Action<string> release = delegate(string holder) { if (viaPowerShell) psRelease(holder); else using (var r = root()) SasShare.Release(r, holder); };
                string how = viaPowerShell ? " (PowerShell)" : " (C#)";
                setSas(null);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                Assert((int)sas() == 1, "Absent becomes 1" + how);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-bbbbbbbb");
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 1, "The first session to leave keeps the value while another still needs it" + how);
                release("SupportMcp-bbbbbbbb");
                Assert(sas() == null && clean(), "The last one deletes the value it added, and the records" + how);
                setSas(2);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                Assert((int)sas() == 3, "2 becomes 3" + how);
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 2 && clean(), "2 comes back" + how);
                setSas(0);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                setSas(3); // an administrator changes it while the session runs
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 3 && clean(), "A later change by an administrator stays" + how);
                setSas(1);
                using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
                release("SupportMcp-aaaaaaaa");
                Assert((int)sas() == 1 && clean(), "A value that already allowed services is left alone" + how);
            }
            // The C# and the PowerShell release both wait for the mutex another process holds.
            setSas(null);
            using (var r = root()) SasShare.Acquire(r, "SupportMcp-aaaaaaaa");
            var other = new Mutex(false, SasShare.MutexName); var taken = new ManualResetEvent(false); var letGo = new ManualResetEvent(false);
            var owner = new Thread(delegate() { other.WaitOne(); taken.Set(); letGo.WaitOne(); other.ReleaseMutex(); }); owner.Start(); taken.WaitOne();
            var waited = Stopwatch.StartNew(); var releaser = new Thread(delegate() { psRelease("SupportMcp-aaaaaaaa"); }); releaser.Start();
            Thread.Sleep(2500); Assert((int)sas() == 1, "The PowerShell release waits while another process holds the mutex");
            letGo.Set(); releaser.Join(30000); owner.Join();
            Assert(sas() == null && clean() && waited.ElapsedMilliseconds >= 2500, "Then it runs");
            // Without the mutex nothing touches the record: Acquire and Release report it, PowerShell exits with 1.
            int wait = SasShare.WaitMs; SasShare.WaitMs = 1000;
            try {
                setSas(null);
                using (var r = root()) Assert(SasShare.Acquire(r, "SupportMcp-aaaaaaaa"), "Acquire reports that it ran");
                taken.Reset(); letGo.Reset();
                owner = new Thread(delegate() { other.WaitOne(); taken.Set(); letGo.WaitOne(); other.ReleaseMutex(); }); owner.Start(); taken.WaitOne();
                using (var r = root()) Assert(!SasShare.Acquire(r, "SupportMcp-bbbbbbbb"), "Acquire without the mutex reports the skip");
                using (var r = root()) using (var k = r.OpenSubKey(SasShare.HoldersKey)) Assert(k.GetValue("SupportMcp-bbbbbbbb") == null, "and adds no holder");
                using (var r = root()) Assert(!SasShare.Release(r, "SupportMcp-aaaaaaaa"), "Release without the mutex reports the skip");
                Assert((int)sas() == 1, "and puts nothing back");
                var ps = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript(@"HKCU:\" + testKey, "SupportMcp-aaaaaaaa") + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true });
                string err = ps.StandardError.ReadToEnd(); ps.WaitForExit();
                Assert(ps.ExitCode == 1 && err.Trim() == "", "The PowerShell release without the mutex exits with 1: " + ps.ExitCode + " " + err);
                using (var r = root()) using (var k = r.OpenSubKey(SasShare.HoldersKey)) Assert((int)sas() == 1 && k.GetValue("SupportMcp-aaaaaaaa") != null && (string)k.GetValue("original") == "absent", "and keeps the entry and the original value for a later release");
                letGo.Set(); owner.Join();
                using (var r = root()) Assert(SasShare.Release(r, "SupportMcp-aaaaaaaa"), "A later release runs");
                Assert(sas() == null && clean(), "and puts the original back");
            } finally { SasShare.WaitMs = wait; letGo.Set(); }
            // send_sas checks the value first, since Windows drops SendSAS without an error when it refuses it.
            foreach (object v in new object[] { null, 0, 2 }) { setSas(v); using (var r = root()) Assert(!SasShare.Allowed(r), "Services may not send SAS with " + (v ?? "no value")); }
            foreach (object v in new object[] { 1, 3 }) { setSas(v); using (var r = root()) Assert(SasShare.Allowed(r), "Services may send SAS with " + v); }
        } finally { OwnerCheck.AlsoTrusted = null; Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(testKey, false); }
        Console.WriteLine("PASS SoftwareSASGeneration: shared by sessions, put back by the last one, an administrator's change kept, the same in PowerShell, never changed without the mutex");

        // The backstop never runs agent.exe, releases the registry share, and deletes itself last.
        string f = @"C:\Program Files\SupportMCP-abcd1234";
        var actions = Backstop.Actions("abcd1234", f, "SupportMcp-abcd1234-0123abcd"); string sys32 = Backstop.System32("");
        Assert(actions.Length == 3 && actions[0][0].EndsWith(@"\System32\cmd.exe") && actions[1][0].EndsWith(@"\System32\WindowsPowerShell\v1.0\powershell.exe") && actions[2][0].EndsWith(@"\System32\cmd.exe"), "cmd, PowerShell, cmd from the 64-bit System32");
        Assert(actions[0][1] == "/c " + sys32 + "sc.exe stop \"SupportMcp-abcd1234\" & " + sys32 + "PING.EXE -n 6 127.0.0.1 >nul & " + sys32 + "taskkill.exe /f /fi \"SERVICES eq SupportMcp-abcd1234\" & " + sys32 + "sc.exe delete \"SupportMcp-abcd1234\"", "First the service, every tool by its full path: " + actions[0][1]);
        Assert(sys32.IndexOf(' ') < 0, "System32 has no space, so the cmd lines need no quotes around tools");
        Assert(actions[1][1].Contains(SasShare.ReleaseScript("HKLM:", "SupportMcp-abcd1234")) && !actions[1][1].Substring(actions[1][1].IndexOf('"') + 1).TrimEnd('"').Contains("\""), "Then the registry share, with no double quote inside the script");
        Assert(actions[2][1].StartsWith("/c (for /l %i in (1,1,20) do @(if exist \"" + f + "\"") && actions[2][1].EndsWith(" & (" + sys32 + "reg.exe query \"HKLM\\SOFTWARE\\SupportMCP\\SoftwareSASGeneration\" /v \"SupportMcp-abcd1234\" /reg:64 >nul 2>&1 || " + sys32 + "schtasks.exe /delete /tn \"SupportMcp-abcd1234-0123abcd\" /f)") && actions[2][1].Contains(sys32 + "PING.EXE -n 3"), "Then the folder, and the task itself last, once its registry share is released: " + actions[2][1]);
        foreach (string[] a in actions) {
            Assert(!a[1].Contains("agent.exe") && !a[1].Contains("window.exe"), "The backstop never runs the app");
            Assert(a[1].IndexOf('%') < 0 || (a[1].IndexOf('%') == a[1].IndexOf("%i") && a[1].IndexOf("%i") == a[1].LastIndexOf("%i")), "At most one %i and no other %, so Task Scheduler expands nothing");
        }
        string xml = Backstop.Xml(actions, (long)(new DateTime(2026, 11, 3, 12, 0, 0, DateTimeKind.Utc) - new DateTime(1970, 1, 1)).TotalMilliseconds + 500);
        Assert(xml.Contains("<TimeTrigger><Repetition><Interval>PT1H</Interval></Repetition><StartBoundary>2026-11-03T12:00:01Z</StartBoundary>") && xml.Contains("<UserId>S-1-5-18</UserId>") && xml.Contains("<StartWhenAvailable>true</StartWhenAvailable>") && xml.Contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"), "Task at the deadline in UTC, rounded up, as SYSTEM, run late if the PC was off, and again every hour until it deletes itself");
        int at0 = xml.IndexOf("<Arguments>" + System.Security.SecurityElement.Escape(actions[0][1])), at1 = xml.IndexOf(System.Security.SecurityElement.Escape(actions[1][1])), at2 = xml.IndexOf(System.Security.SecurityElement.Escape(actions[2][1]));
        Assert(at0 > 0 && at1 > at0 && at2 > at1 && !xml.Contains(" & ") && xml.Contains("&amp;") && xml.Contains("&quot;"), "Three actions in order, escaped for XML");
        Console.WriteLine("PASS backstop task: the command line, its order and the task XML");

        // run in full control: the token choice and the as: field.
        Assert(TokenChoice.Pick(true, false, 0) == RunAs.System && TokenChoice.Pick(true, true, 3) == RunAs.System, "as: system runs as SYSTEM, signed in or not");
        Assert(TokenChoice.Pick(false, false, 0) == RunAs.Nobody && TokenChoice.NobodySignedIn == "nobody is signed in; use as: \"system\"", "as: user with nobody signed in is an error");
        Assert(TokenChoice.Pick(false, true, 3) == RunAs.ElevatedUser && TokenChoice.Pick(false, true, 1) == RunAs.User && TokenChoice.Pick(false, true, 2) == RunAs.User, "An administrator's filtered token is swapped for its elevated linked token; other tokens run as they are");
        var full = new FakeFull();
        using (var relay = new FakeRelay()) {
            relay.Agent.Full = full; relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(Wire.Text(relay.Hello, "control") == "full" && caps.Contains("full") && caps.Contains("screen") && Wire.Text(relay.Hello, "user") == "tester" && Wire.Flag(relay.Hello, "elevated"), "The service's hello says control full");
            for (int i = 0; i < 100 && full.WelcomedAt == 0; i++) Thread.Sleep(20);
            Assert(Math.Abs(full.WelcomedAt - (Client.UnixNow() + 300000)) < 5000, "The welcome's expiry reaches the service");
            for (int i = 0; i < 100 && (relay.LastPoll == null || Wire.Text(relay.LastPoll, "desktop") != "secure"); i++) Thread.Sleep(50);
            Assert(Wire.Text(relay.LastPoll, "desktop") == "secure" && Wire.Number(relay.LastPoll, "input_blocked_until") > 0, "Polls carry the service's report");
            var shot = relay.Call(Act("screenshot")); Assert(Wire.Flag(shot, "ok") && Wire.Text(shot, "desktop") == "secure" && full.Screens == 1, "Screen frames go to the service");
            var sys = Run("[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().Name)", 30); sys["as"] = "system";
            var r = relay.Call(sys); Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == WindowsIdentity.GetCurrent().Name, "as: system runs with the service's own token: " + Wire.Text(r, "error"));
            var user = Run("[Console]::Write([Security.Principal.WindowsIdentity]::GetCurrent().Name + '|' + (Get-Location).Path)", 30); user["as"] = "user";
            r = relay.Call(user); Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == WindowsIdentity.GetCurrent().Name + "|" + Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "as: user runs with the given token in its profile folder: " + Wire.Text(r, "error") + Decode(r, "stderr_b64"));
            full.SignedIn = false;
            r = relay.Call(user); Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == TokenChoice.NobodySignedIn, "as: user with nobody signed in: " + Wire.Text(r, "error"));
            var bad = Run("1", 10); bad["as"] = "root"; r = relay.Call(bad); Assert(Wire.Text(r, "error") == "as must be user or system", "Only user and system");
        }
        Console.WriteLine("PASS full-control client: hello, welcome, poll report, screen frames, and run as system, as user and with nobody signed in");

        // Block timer: the time limit, the operator's off, and Ctrl+Alt+Del.
        var block = new BlockTimer(); block.Arm(1000, 99);
        Assert(block.RemainingMs(1000) == 600000 && block.On(600999) && !block.On(601000), "At most 10 minutes");
        block.Arm(1000, 0); Assert(block.RemainingMs(1000) == 60000, "At least 1 minute");
        block.Arm(1000, 2); Assert(block.Check(5000, true, true) && block.Check(120999, true, true) && !block.Check(121000, true, true) && !block.Escaped && !block.On(121000), "It lifts by itself when the time is up");
        block.Arm(1000, 2); Assert(!block.Check(5000, false, true) && block.Escaped && !block.Check(6000, true, true) && !block.On(6000), "A switch to the secure desktop is Ctrl+Alt+Del: off, and it stays off");
        block.Arm(1000, 2); Assert(!block.Escaped && !block.Check(5000, true, false) && block.Escaped, "A block Windows already lifted counts as Ctrl+Alt+Del; only on again re-arms it");
        block.Arm(1000, 2); block.Off(); Assert(!block.Check(5000, true, true) && !block.Escaped, "The operator's off");
        Console.WriteLine("PASS block_input timer: the 10-minute cap, renewal, Ctrl+Alt+Del and off");

        // Pipe messages are length-prefixed JSON objects within a size limit; a window may only ask for status or end.
        Func<byte[], Dictionary<string, object>> read = delegate(byte[] raw) { return Pipes.Read(new MemoryStream(raw), 1024); };
        Func<string, byte[]> frame = delegate(string json) { byte[] b = Encoding.UTF8.GetBytes(json), all = new byte[b.Length + 4]; BitConverter.GetBytes(b.Length).CopyTo(all, 0); b.CopyTo(all, 4); return all; };
        var ms = new MemoryStream(); Pipes.Write(ms, Wire.Map("type", "status")); ms.Position = 0;
        Assert(Wire.Text(Pipes.Read(ms, 1024), "type") == "status", "A message round trip");
        foreach (byte[] raw in new byte[][] { frame("[1,2]"), frame("null"), frame("{\"type\":"), frame("\"text\""), new byte[] { 2, 0, 0, 0, 0x7B }, new byte[] { 0xFF, 0xFF, 0xFF, 0x7F }, new byte[] { 1, 0, 0, 0, 0x7B }, new byte[] { 0, 4, 0, 0 }, new byte[] { 1, 0 } }) {
            try { read(raw); throw new Exception("accepted a bad message of " + raw.Length + " bytes"); } catch (InvalidDataException) { } catch (EndOfStreamException) { }
        }
        Assert(Pipes.UiRequest(read(frame("{\"type\":\"status\"}"))) == "status" && Pipes.UiRequest(read(frame("{\"type\":\"end\"}"))) == "end", "status and end");
        foreach (string json in new string[] { "{\"type\":\"run\"}", "{\"type\":\"status\",\"x\":1}", "{\"type\":5}", "{}", "{\"Type\":\"end\"}", "{\"type\":[\"end\"]}" })
            Assert(Pipes.UiRequest(read(frame(json))) == null, "A window may not ask " + json);
        // The real pipe: a window reads status and ends the session; garbage closes the connection; nobody can take the name first.
        string sid8 = Guid.NewGuid().ToString("N").Substring(0, 8); int ended = 0;
        // Only the pipe's owner may add instances, and the tests do not run as SYSTEM: this account stands in for it.
        string uiSddl = "D:P(A;;GA;;;" + me.Value + ")(A;;0x12008B;;;IU)"; Func<uint, bool> anySession = delegate(uint session) { return true; };
        var ui = new UiServer(Backstop.Name(sid8) + "-ui", delegate { return Wire.Map("connected", true, "link", true, "busy", 1, "paused", false, "blocked", true, "expires_at", Client.UnixNow() + 3600000, "ended", ended > 0); }, delegate { Interlocked.Increment(ref ended); }, anySession, uiSddl);
        try { Native.PipeServer(Backstop.Name(sid8) + "-ui", "D:P(A;;GA;;;SY)", 4, true); throw new Exception("a second first instance was allowed"); } catch (System.ComponentModel.Win32Exception) { }
        Assert(ServiceLink.Running(sid8) && !ServiceLink.Running(Guid.NewGuid().ToString("N").Substring(0, 8)), "Running finds the service of this session only");
        // A client that asks for full access (which includes making a new pipe instance) is refused.
        // (The service's real ACL, on one instance this test account did not need rights to create.)
        using (var real = Native.PipeServer("SupportMcpTest-acl-" + sid8, UiServer.Sddl, 1, true)) {
            using (var greedy = new System.IO.Pipes.NamedPipeClientStream(".", "SupportMcpTest-acl-" + sid8, System.IO.Pipes.PipeDirection.InOut)) {
                try { greedy.Connect(2000); throw new Exception("the window pipe gave out write access that includes new instances"); } catch (UnauthorizedAccessException) { }
            }
            var accepting = new Thread(delegate() { try { real.WaitForConnection(); } catch (Exception) { } }); accepting.Start();
            using (var modest = Pipes.Client("SupportMcpTest-acl-" + sid8)) { modest.Connect(2000); Assert(modest.IsConnected, "A window's client gets in"); }
            accepting.Join(3000);
        }
        using (var raw = Pipes.Client(Backstop.Name(sid8) + "-ui")) {
            raw.Connect(2000); Pipes.Write(raw, Wire.Map("type", "run", "command", "calc"));
            try { Pipes.Read(raw, 4096); throw new Exception("the service answered a request a window may not make"); } catch (IOException) { }
            Assert(ended == 0, "A bad request does nothing");
        }
        var link = new ServiceLink(sid8); int connected = 0, finished = 0, busyNow = -1;
        link.Connected += delegate { connected++; }; link.Finished += delegate { finished++; }; link.BusyChanged += delegate(int n) { busyNow = n; };
        link.Start();
        for (int i = 0; i < 100 && (connected == 0 || busyNow != 1); i++) Thread.Sleep(50);
        Assert(connected == 1 && busyNow == 1 && link.Blocked && !link.Paused && link.SurvivesSignOut && Math.Abs((link.ExpiresLocal.ToUniversalTime() - DateTime.UtcNow).TotalMinutes - 60) < 1, "The window reads status");
        link.Stop(); link.Flush(5000);
        for (int i = 0; i < 100 && finished == 0; i++) Thread.Sleep(50);
        Assert(ended >= 1 && finished == 1 && !link.Lost && !ServiceLink.Running(sid8), "End session reaches the service, and the window sees the session end");
        PerProcessLimit(uiSddl);
        // Only the active console session is served: a process of another session (a switched user, Remote Desktop) is refused.
        string sid8c = Guid.NewGuid().ToString("N").Substring(0, 8);
        new UiServer(Backstop.Name(sid8c) + "-ui", delegate { return Wire.Map("connected", true, "ended", false); }, delegate { }, delegate(uint session) { return false; }, uiSddl);
        Assert(!ServiceLink.Running(sid8c), "A client from another session is refused");
        // Pipe clients let the server identify them, never act as them.
        string me8 = Guid.NewGuid().ToString("N").Substring(0, 8); string secret = Path.Combine(dir, "only-me.txt"); File.WriteAllText(secret, "x"); Exception asClient = null;
        using (var server = Native.PipeServer("SupportMcpTest-" + me8, "D:P(A;;GA;;;" + me.Value + ")", 1, true)) {
            var t = new Thread(delegate() { server.WaitForConnection(); Pipes.Read(server, 1024); server.RunAsClient(delegate { try { File.ReadAllText(secret); } catch (Exception e) { asClient = e; } }); });
            t.Start();
            using (var c = Pipes.Client("SupportMcpTest-" + me8)) { c.Connect(2000); Pipes.Write(c, Wire.Map("type", "status")); t.Join(5000); }
        }
        Assert(asClient != null, "The server cannot open files as the client (identification only)");
        Console.WriteLine("PASS pipes: framing, the window's two requests, the first-instance guard and the window link");

        // The corner window's copy is the exe without the configuration (and its attach key).
        byte[] cfgBytes = Encoding.UTF8.GetBytes("{\"sid\":\"x\"}"), body = new byte[] { 77, 90, 1, 2, 3 };
        var withCfg = new MemoryStream(); withCfg.Write(body, 0, body.Length); withCfg.Write(cfgBytes, 0, cfgBytes.Length); withCfg.Write(BitConverter.GetBytes(cfgBytes.Length), 0, 4); byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); withCfg.Write(footer, 0, footer.Length);
        Assert(Wire.Payload(withCfg.ToArray()) == body.Length, "window.exe is cut before the configuration");
        Console.WriteLine("PASS window.exe carries no session configuration");

        // The elevated installer runs from a copy in a fresh folder, and reads itself through a handle that nobody can write or rename under.
        string download = Path.Combine(dir, "downloads"); Directory.CreateDirectory(download);
        string exe = Path.Combine(download, "remote-support-abcd1234.exe"); File.WriteAllBytes(exe, withCfg.ToArray());
        File.WriteAllText(exe + ".config", "<configuration/>"); File.WriteAllText(Path.Combine(download, "version.dll"), "planted");
        string staged = Elevation.Stage(exe);
        try {
            Assert(Path.GetFileName(staged) == "remote-support-abcd1234.exe" && Path.GetDirectoryName(Path.GetDirectoryName(staged)).TrimEnd('\\') == Path.GetTempPath().TrimEnd('\\') && Directory.GetFiles(Path.GetDirectoryName(staged)).Length == 1, "Only the exe is in the staging folder: " + staged);
            FileStream held; byte[] selfBytes = FullInstall.ReadSelf(staged, out held);
            using (held) {
                Assert(selfBytes.Length == withCfg.Length, "The installer reads its whole file once");
                try { using (new FileStream(staged, FileMode.Open, FileAccess.Write, FileShare.ReadWrite)) { } throw new Exception("the held exe could be opened for writing"); } catch (IOException) { }
                try { File.Move(staged, staged + ".old"); throw new Exception("the held exe could be renamed"); } catch (IOException) { }
            }
        } finally { Directory.Delete(Path.GetDirectoryName(staged), true); }
        Console.WriteLine("PASS the elevated installer runs from a clean copy and holds its own file");

        // File operations as SYSTEM refuse junctions, links and a second hard link, and work on a plain path.
        string plain = Path.Combine(dir, "plain"), target = Path.Combine(dir, "protected"); Directory.CreateDirectory(plain); Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "file.txt"), "keep");
        Func<string, int> cmd = delegate(string line) { var c = Process.Start(new ProcessStartInfo("cmd.exe", "/c " + line) { UseShellExecute = false, CreateNoWindow = true }); c.WaitForExit(); return c.ExitCode; };
        Assert(cmd("mklink /J \"" + Path.Combine(plain, "jump") + "\" \"" + target + "\"") == 0, "Test setup: a junction");
        Assert(cmd("mklink /H \"" + Path.Combine(plain, "twin.txt") + "\" \"" + Path.Combine(target, "file.txt") + "\"") == 0, "Test setup: a second hard link");
        foreach (string path in new string[] { Path.Combine(plain, @"jump\file.txt"), Path.Combine(plain, @"jump\new.txt") })
            foreach (bool write in new bool[] { true, false }) {
                try { using (Native.OpenPlain(path, write, false)) { } throw new Exception("followed a junction: " + path + " write " + write); } catch (ArgumentException e) { Assert(e.Message == Native.LinkRefused, e.Message); } catch (System.ComponentModel.Win32Exception) { Assert(!write, "Only a read of a missing file may fail differently"); }
            }
        try { using (Native.OpenPlain(Path.Combine(plain, "twin.txt"), true, false)) { } throw new Exception("wrote through a second hard link"); } catch (ArgumentException e) { Assert(e.Message == Native.LinkRefused, e.Message); }
        Assert(File.ReadAllText(Path.Combine(target, "file.txt")) == "keep" && !File.Exists(Path.Combine(target, "new.txt")), "Nothing behind the junction or the link changed");
        // Missing folders are made one level at a time, each checked; a junction at any level is refused.
        foreach (bool write in new bool[] { true, false }) {
            try { using (Native.OpenPlain(Path.Combine(plain, @"jump\new\deeper\x.txt"), write, false)) { } throw new Exception("went through a junction above new folders"); } catch (ArgumentException e) { Assert(e.Message == Native.LinkRefused, e.Message); }
        }
        Assert(!Directory.Exists(Path.Combine(target, "new")), "No folder was made behind the junction");
        string ok = Path.Combine(plain, @"sub\one\two\data.bin");
        using (var w = Native.OpenPlain(ok, true, false)) w.Write(new byte[] { 1, 2, 3 }, 0, 3);
        using (var w = Native.OpenPlain(ok, true, true)) w.Write(new byte[] { 4 }, 0, 1);
        using (var w = Native.OpenPlain(ok, true, false)) w.Write(new byte[] { 9 }, 0, 1);
        using (var r2 = Native.OpenPlain(ok, false, false)) Assert(r2.Length == 1 && r2.ReadByte() == 9, "A plain path: create, append, then replace");
        Assert(cmd("rmdir \"" + Path.Combine(plain, "jump") + "\"") == 0, "Test cleanup: the junction");
        Console.WriteLine("PASS file operations as SYSTEM refuse junctions and extra hard links, and keep working on plain paths");
    }
    static void LaneTests() {
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(Wire.Text(relay.Hello, "agent") == "windows-app-2" && Wire.Text(relay.Hello, "version") == Wire.Version && Wire.Text(relay.Hello, "control") == "normal" && caps.Contains("screen") && caps.Contains("uia") && caps.Contains("lanes"), "Hello must announce screen control and lanes");
            Assert(relay.WaitBusy(delegate(string[] b) { return b.Length == 0; }, 5000), "An idle client polls with no busy lane");
            for (int i = 0; i < 100 && relay.LastPoll == null; i++) Thread.Sleep(50);
            Assert(relay.LastPoll != null && relay.LastPoll.ContainsKey("busy") && Wire.Text(relay.LastPoll, "desktop") != "" && relay.LastPoll.ContainsKey("paused_until") && relay.LastPoll["paused_until"] == null, "A poll reports the desktop and no pause");
            string cmdId = relay.Queue(Run("Start-Sleep -Seconds 6; [Console]::Write('slow')", 30));
            Assert(relay.WaitBusy(delegate(string[] b) { return Array.IndexOf(b, "cmd") >= 0 && b.Length == 1; }, 15000), "While a command runs the client keeps polling and reports busy_lanes [cmd]");
            var timer = Stopwatch.StartNew();
            var screen = relay.Call(Act("wait", "seconds", 0.2, "screenshot", false));
            Assert(Wire.Flag(screen, "ok") && timer.ElapsedMilliseconds < 4000 && !relay.HasResult(cmdId), "A screen operation must finish while the command still runs, took " + timer.ElapsedMilliseconds + " ms");
            foreach (string name in new string[] { "block_input", "send_sas" }) {
                var denied = relay.Call(Act(name)); Assert(!Wire.Flag(denied, "ok") && Wire.Text(denied, "error") == Screen.NoFull, name + " needs full control");
            }
            var control = relay.Call(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            Assert(!Wire.Flag(control, "ok") && Wire.Text(control, "error") == Screen.NoFull, "request_full_control without a handler is refused in normal mode");
            var bad = relay.Call(Act("fly")); Assert(!Wire.Flag(bad, "ok") && Wire.Text(bad, "error") == "unknown screen action", "Unknown action");
            var secretKey = relay.Call(Act("key", "keys", "ctrl+alt+Delete", "screenshot", false)); Assert(!Wire.Flag(secretKey, "ok"), "ctrl+alt+Delete is refused");
            Assert(!relay.HasResult(cmdId), "The command is still running");
            var done = relay.WaitResult(cmdId, 30);
            Assert(Wire.Flag(done, "ok") && Decode(done, "stdout_b64") == "slow", "The command result still arrives");
            Assert(relay.WaitBusy(delegate(string[] b) { return b.Length == 0; }, 2000), "A finished lane ends the parked poll at once, so the client is free again within 2 s");
            Console.WriteLine("PASS hello, lanes: a screen operation runs while a command runs, and full-control operations are refused");
        }
        // A normal-mode app that can elevate says so with the "full" cap, and request_full_control goes to its handler.
        using (var relay = new FakeRelay()) {
            relay.Agent.CanElevate = true; int asked = 0;
            relay.Agent.RequestFull = delegate { asked++; return Wire.Map("ok", false, "error", "the customer declined full control"); };
            relay.Lifetime = 300000; relay.Start();
            var caps = (System.Collections.ArrayList)relay.Hello["caps"];
            Assert(caps.Contains("full") && Wire.Text(relay.Hello, "control") == "normal", "A normal-mode app that can elevate reports the full cap and control normal");
            var r = relay.Call(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            Assert(asked == 1 && !Wire.Flag(r, "ok") && Wire.Text(r, "error") == "the customer declined full control", "request_full_control runs the elevation handler: " + Wire.Text(r, "error"));
            var more = relay.Call(Run("[Console]::Write('still')", 20));
            Assert(Wire.Flag(more, "ok") && Decode(more, "stdout_b64") == "still", "A declined request leaves normal mode working");
        }
        // A handler that hands the session to the service stops this client without a result or an end.
        using (var relay = new FakeRelay()) {
            relay.Agent.CanElevate = true; var agent = relay.Agent;
            agent.RequestFull = delegate { agent.EndRemote = false; agent.Stop(); return null; };
            relay.Lifetime = 300000; relay.Start();
            string id = relay.Queue(Wire.Map("type", "control", "lane", "screen", "action", "request_full_control"));
            relay.WaitExit(); Thread.Sleep(300);
            Assert(!relay.HasResult(id) && !relay.End, "A handed-over client sends no result and no end");
        }
        // The cooldown: a decline at the first start blocks an immediate request as much as a later decline; a failure does not.
        {
            int asks = 0; Func<Dictionary<string, object>> ask = delegate { asks++; return Wire.Map("ok", false, "error", "asked"); };
            long t = PauseClock.Now();
            var gate = new FullRequestGate(); gate.Record(Elevation.Declined, t);
            Assert(Wire.Text(gate.Request(ask, t + 1), "error") == FullRequestGate.Cooling && asks == 0, "A decline at the first start: an immediate request gets the cooldown error and no prompt");
            Assert(Wire.Text(gate.Request(ask, t + FullRequestGate.CooldownMs - 1), "error") == FullRequestGate.Cooling && asks == 0, "Still within the minute");
            Assert(Wire.Text(gate.Request(ask, t + FullRequestGate.CooldownMs), "error") == "asked" && asks == 1, "After a minute it prompts again");
            gate = new FullRequestGate(); gate.Record(Elevation.Failed, t); gate.Record(Elevation.Installed, t);
            Assert(Wire.Text(gate.Request(ask, t + 1), "error") == "asked" && asks == 2, "A failure is not a decline: it prompts at once");
            gate = new FullRequestGate(); var inside = new ManualResetEvent(false); var leave = new ManualResetEvent(false); Dictionary<string, object> second = null;
            var first = new Thread(delegate() { gate.Request(delegate { inside.Set(); leave.WaitOne(); return null; }, t); }); first.Start(); inside.WaitOne();
            second = gate.Request(ask, t); leave.Set(); first.Join();
            Assert(Wire.Text(second, "error") == FullRequestGate.Waiting && asks == 2, "One prompt at a time");
            gate.Record(Elevation.Declined, t + 5);
            Assert(Wire.Text(gate.Request(ask, t + 6), "error") == FullRequestGate.Cooling && asks == 2, "A later decline starts the cooldown too");
            gate = new FullRequestGate(); gate.Record(Elevation.NoAnswer, t);
            Assert(Wire.Text(gate.Request(ask, t + 1), "error") == "asked" && asks == 3, "No answer starts no cooldown");
            // A UAC prompt the app stopped waiting for: no new request while it is open; a No on it starts the cooldown.
            // The No counts at once, at the time the prompt ended: a request right after it, with no wait, gets the cooldown.
            var stale = new ManualResetEvent(false); int staleOutcome = Elevation.Declined; long staleEnded = t + 1000;
            gate.Leave(stale, delegate { return staleOutcome; }, delegate { return staleEnded; });
            Assert(Wire.Text(gate.Request(ask, t + 900), "error") == FullRequestGate.StillOpen && asks == 3, "No second prompt while an earlier one is open");
            stale.Set();
            Assert(Wire.Text(gate.Request(ask, t + 1001), "error") == FullRequestGate.Cooling && asks == 3, "A No on the earlier prompt starts the cooldown before the next request");
            Assert(Wire.Text(gate.Request(ask, t + 1000 + FullRequestGate.CooldownMs), "error") == "asked" && asks == 4, "The minute counts from when the prompt ended");
            gate = new FullRequestGate(); stale = new ManualResetEvent(false); staleOutcome = Elevation.NoAnswer;
            gate.Leave(stale, delegate { return staleOutcome; }, delegate { return staleEnded; }); stale.Set();
            Assert(Wire.Text(gate.Request(ask, t + 1001), "error") == "asked" && asks == 5, "A prompt Windows dropped (no answer) starts no cooldown");
        }
        AttemptTests();
        Console.WriteLine("PASS an elevation attempt: the drop time, a withdrawal while it stages, Discard and the sweep of staged copies");
        Console.WriteLine("PASS request_full_control: the full cap, a declined request, the silent handover, the cooldown after any decline");
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    static string ForegroundInfo() { IntPtr fg = Win.GetForegroundWindow(); uint pid; Win.GetWindowThreadProcessId(fg, out pid); var t = new StringBuilder(200); GetWindowText(fg, t, 200); string name = ""; try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { } return fg + " pid " + pid + " " + name + " \"" + t + "\" (this process " + Process.GetCurrentProcess().Id + ")"; }
    // Needs a Windows desktop session: real capture, input and windows.
    static void LiveScreenTests() {
        Screen.Dpi();
        if (Screen.Desktop() != "default" || Screen.Monitors().Count == 0) { Console.WriteLine("SKIP live screen tests: no reachable desktop"); return; }
        using (var relay = new FakeRelay()) {
            relay.Lifetime = 300000; relay.Start();
            var shot = relay.Call(Act("screenshot"));
            Assert(Wire.Flag(shot, "ok") && Wire.Text(shot, "mime") == "image/jpeg" && Wire.Text(shot, "desktop") == "default" && Wire.Number(shot, "displays") >= 1 && Wire.Number(shot, "display") == 0, "Screenshot result: " + Wire.Text(shot, "error"));
            Assert(Wire.Number(shot, "width") <= 1280 && Wire.Number(shot, "height") <= 800 && Wire.Text(shot, "image_b64").Length < 700000 && Hex(Wire.Text(shot, "image_b64")) == Convert.ToBase64String(new byte[] { 0xFF, 0xD8 }), "Screenshot size, limit and JPEG header");
            var zoom = relay.Call(Act("zoom", "x1", 0, "y1", 0, "x2", 200, "y2", 100));
            Assert(Wire.Flag(zoom, "ok") && Wire.Number(zoom, "width") > 0 && Wire.Number(zoom, "width") <= 1280, "Zoom: " + Wire.Text(zoom, "error"));
            var outside = relay.Call(Act("click", "x", 99999, "y", 1, "screenshot", false)); Assert(!Wire.Flag(outside, "ok") && Wire.Text(outside, "error").Contains("outside"), "A click outside the screenshot is refused");
            var tree = relay.Call(Act("ui_tree", "max_lines", 5)); Assert(Wire.Flag(tree, "ok") || Wire.Text(tree, "error") != "", "ui_tree answers");
            var stale = relay.Call(Act("ui_act", "ref", 999, "verb", "invoke", "screenshot", false)); Assert(!Wire.Flag(stale, "ok") && Wire.Text(stale, "error").Contains("ui_tree"), "A ref that ui_tree never gave is refused");
        }
        // Mapping reaches the exact physical pixel, and the guards refuse.
        int mw, mh; var display = Screen.Monitors()[0]; ScreenMath.Fit(display.Width, display.Height, out mw, out mh);
        using (var screen = new Screen()) {
            screen.Start(); Assert(screen.Watch.Ok, "The input hooks must install on a desktop session");
            var stop = new ManualResetEvent(false);
            System.Drawing.Point at = System.Drawing.Point.Empty; Dictionary<string, object> moved = null;
            var t = new Thread(delegate() {
                Screen.Dpi();
                moved = screen.Run(Act("move", "x", mw / 2, "y", mh / 3, "screenshot", false), stop);
                Win.GetCursorPos(out at);
            }); t.Start(); t.Join();
            Assert(Wire.Flag(moved, "ok"), "move: " + Wire.Text(moved, "error"));
            Assert(at.X == display.X + ScreenMath.ToPhysical(mw / 2, mw, display.Width) && at.Y == display.Y + ScreenMath.ToPhysical(mh / 3, mh, display.Height), "The cursor must land on the mapped physical pixel, got " + at.X + "," + at.Y);
            screen.Watch.Clock.Touch(PauseClock.Now());
            foreach (var act in new Dictionary<string, object>[] { Act("click", "x", 5, "y", 5), Act("move", "x", 5, "y", 5), Act("type", "text", "x"), Act("key", "keys", "a"), Act("scroll", "x", 5, "y", 5), Act("drag", "x1", 5, "y1", 5, "x2", 9, "y2", 9) }) {
                var refused = screen.Run(act, stop); Assert(!Wire.Flag(refused, "ok") && Wire.Text(refused, "error") == Screen.PauseText, "Input must be refused during a customer pause: " + ((Dictionary<string, object>)act["action"])["name"]);
            }
            var secretPaused = screen.Run(Act("type_secret", "text", "x"), stop); Assert(!Wire.Flag(secretPaused, "ok") && Wire.Text(secretPaused, "error") == Screen.SecretFailed, "type_secret is refused during a pause with the generic error");
            Assert(Wire.Flag(screen.Run(Act("screenshot"), stop), "ok"), "A screenshot still works during a pause");
            Assert(Wire.Text(screen.Run(Act("ui_tree", "max_lines", 3), stop), "error") != Screen.PauseText, "ui_tree is not paused");
            screen.Watch.Clock.Touch(-100000);
        }
        // Own-window guard: a window of this process at the target refuses the click and the keystrokes.
        using (var screen = new Screen()) {
            screen.Start();
            Dictionary<string, object> click = null, key = null, tree = null; var stop = new ManualResetEvent(false);
            var t = new Thread(delegate() {
                Screen.Dpi();
                using (var form = new Form { StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(display.X + 60, display.Y + 60), Size = new System.Drawing.Size(300, 200), TopMost = true }) {
                    form.Show(); form.Activate(); for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(25); }
                    int x = ScreenMath.ToImage(form.Left + 100 - display.X, mw, display.Width), y = ScreenMath.ToImage(form.Top + 100 - display.Y, mh, display.Height);
                    click = screen.Run(Act("click", "x", x, "y", y, "screenshot", false), stop);
                    key = screen.Run(Act("type", "text", "x", "screenshot", false), stop);
                    tree = screen.Run(Act("ui_tree"), stop);
                }
            }); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
            Assert(!Wire.Flag(click, "ok") && Wire.Text(click, "error").Contains("support window"), "A click on this process's window must be refused: " + Wire.Text(click, "error"));
            Assert(!Wire.Flag(key, "ok") && Wire.Text(key, "error").Contains("support window has the keyboard focus"), "Keystrokes while this process has the focus must be refused: " + Wire.Text(key, "error") + " foreground " + ForegroundInfo());
            Assert(!Wire.Flag(tree, "ok") && Wire.Text(tree, "error").Contains("support window"), "ui_tree must not read this process's window: " + Wire.Text(tree, "error"));
        }
        Console.WriteLine("PASS live screen: capture, zoom, exact cursor mapping, pause and own-window guards");
        // The corner window never takes the focus when it appears, keeps a taskbar button, and gives the focus back after
        // the customer keeps the session: asking to end activates it, Keep connected returns the focus to the window it came
        // from. That window belongs to another process (a peer started from this exe), because a window of this process is never given the focus back.
        {
            var info = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "--peer " + Process.GetCurrentProcess().Id) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
            var lines = new List<string>(); Process peer = Process.Start(info);
            peer.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) lock (lines) lines.Add(e.Data); };
            peer.BeginOutputReadLine();
            try {
                var end = DateTime.UtcNow.AddSeconds(15); bool ready = false;
                while (!ready && DateTime.UtcNow < end) { lock (lines) ready = lines.Contains("ready"); Thread.Sleep(25); }
                Assert(ready, "Test setup: the peer window opened");
                peer.Refresh(); IntPtr peerWindow = peer.MainWindowHandle;
                bool styled = false, stillPeer = false, active = true, confirmActive = false, restored = false, usable = false, wrongIds = true, olderKept = false, tuckBack = false;
                var t = new Thread(delegate() {
                    Screen.Dpi();
                    Action pump = delegate { for (int i = 0; i < 20; i++) { Application.DoEvents(); System.Windows.Threading.Dispatcher.CurrentDispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Background, new Action(delegate { })); Thread.Sleep(25); } };
                    pump();
                    Win.SetForegroundWindow(peerWindow); pump();
                    var window = new SupportWindow(Palette.Detect(), false, false, null);
                    window.Show(); pump();
                    IntPtr handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
                    int ex = Win.GetWindowLong(handle, -20);
                    styled = (ex & unchecked((int)Win.NoActivate)) != 0 && (ex & unchecked((int)Win.AppWindow)) != 0;
                    stillPeer = Win.GetForegroundWindow() == peerWindow; active = window.IsActive;
                    uint peerPid; uint peerThread = Win.GetWindowThreadProcessId(peerWindow, out peerPid);
                    usable = FocusReturn.Usable(peerWindow, peerPid, peerThread);
                    wrongIds = FocusReturn.Usable(peerWindow, peerPid + 1, peerThread) || FocusReturn.Usable(peerWindow, peerPid, peerThread + 1) || FocusReturn.Usable(IntPtr.Zero, 0, 0);
                    window.AskToEnd(); pump();
                    confirmActive = Win.GetForegroundWindow() == handle;
                    window.KeepConnected(); pump();
                    restored = Win.GetForegroundWindow() == peerWindow;
                    // The customer leaves the window while the confirm is open and comes back to it (a click on Keep activates it
                    // again): Keep must not pull the focus to the older window.
                    Win.SetForegroundWindow(peerWindow); pump();
                    window.AskToEnd(); pump();
                    using (var elsewhere = new Form { StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(display.X + 60, display.Y + 400), Size = new System.Drawing.Size(200, 150), TopMost = true }) {
                        elsewhere.Show(); elsewhere.Activate(); pump();
                        window.Activate(); pump();
                        window.KeepConnected(); pump();
                        olderKept = Win.GetForegroundWindow() != peerWindow;
                    }
                    // A second confirm and Keep (tucking the window while it is open calls the same method) gives the focus back again.
                    Win.SetForegroundWindow(peerWindow); pump();
                    window.AskToEnd(); pump();
                    window.KeepConnected(); pump();
                    tuckBack = Win.GetForegroundWindow() == peerWindow;
                    window.CloseQuietly();
                }); t.SetApartmentState(ApartmentState.STA); t.Start(); t.Join();
                Assert(styled, "The corner window must have WS_EX_NOACTIVATE and WS_EX_APPWINDOW");
                Assert(stillPeer && !active, "Showing the corner window must leave the focus where it was");
                Assert(confirmActive, "Asking to end must give the confirm the focus");
                Assert(restored, "Keep connected must give the focus back to the window that had it");
                Assert(usable && !wrongIds, "A remembered window is usable only with the same process and thread ids");
                Assert(olderKept, "Keep must not pull the focus to an older window after the customer left the support window");
                Assert(tuckBack, "Closing the confirm gives the focus back again");
            } finally { try { peer.Kill(); } catch (Exception) { } peer.Dispose(); }
        }
        Console.WriteLine("PASS the corner window does not take the focus, keeps its taskbar button, and Keep connected gives the focus back");
        QuestionTests();
        Console.WriteLine("PASS the full-control question stays open as the owner of the UAC prompt");

        // A key the app pressed whose up never arrived (a desktop switch) neither pauses support nor stays down:
        // Unstick sends the up. A key no one released and no input for 10 s is stuck and stops pausing. F23 and F22 are harmless.
        using (var screen = new Screen()) {
            screen.Start(); var stop = new ManualResetEvent(false);
            var t = new Thread(delegate() {
                Screen.Send(Screen.KeyEvent(0x86, 0, 0));
                Assert((Win.GetAsyncKeyState(0x86) & 0x8000) != 0, "Test setup: F23 is down");
                Assert(screen.PausedForMs == 0, "The app's own key left down is not the customer's");
                Screen.Unstick();
                Assert((Win.GetAsyncKeyState(0x86) & 0x8000) == 0, "Unstick sent its up");
                var raw = new Win.In[] { Screen.KeyEvent(0x85, 0, 0) }; Win.SendInput(1, raw, Marshal.SizeOf(typeof(Win.In))); // not through Send: not the app's
                screen.Watch.Clock.Touch(-100000);
                Assert(screen.PausedForMs > 0, "A key someone else holds pauses support");
                Thread.Sleep((int)InputIdle.StuckMs + 1000);
                long left = screen.PausedForMs;
                raw[0] = Screen.KeyEvent(0x85, 0, 2); Win.SendInput(1, raw, Marshal.SizeOf(typeof(Win.In)));
                Assert(left == 0, "After 10 s with no input it is stuck and pauses nothing: " + left);
            }); t.Start(); t.Join();
        }
        Console.WriteLine("PASS a key the app left down is released, and a stuck key stops pausing after 10 s");
    }
    static T Find<T>(System.Windows.DependencyObject root, Func<T, bool> match) where T : System.Windows.DependencyObject {
        foreach (object child in System.Windows.LogicalTreeHelper.GetChildren(root)) {
            var hit = child as T; if (hit != null && match(hit)) return hit;
            var node = child as System.Windows.DependencyObject; if (node == null) continue;
            var found = Find<T>(node, match); if (found != null) return found;
        }
        return null;
    }
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    // ---- PR 6: connect to a saved PC ---------------------------------------------------------------------------
    static bool Until(Func<bool> condition, int ms) { var end = DateTime.UtcNow.AddMilliseconds(ms); while (DateTime.UtcNow < end) { if (condition()) return true; Thread.Sleep(25); } return condition(); }
    static bool Elevated() { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
    static bool Interactive() { foreach (var g in WindowsIdentity.GetCurrent().Groups) if (g.Value == "S-1-5-4") return true; return false; }
    static Dictionary<string, object> ReadJson(string file) { return Wire.Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(file)); }
    static string Hex64() { return Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N"); }

    // Issue #22: a mutex or event someone else made first is never trusted. The setup mutex refuses with the plain
    // message (install, uninstall and the update lock), the SAS mutex is skipped as busy (C# and PowerShell), the
    // service picks a new uninstall event name when someone holds its own, and a tray or the uninstaller opens only an
    // event SYSTEM or Administrators own.
    static void OwnerCheckTests(string dir) {
        var me = WindowsIdentity.GetCurrent().User;
        Assert(OwnerCheck.Trusted(FullAcl.SystemSid) && OwnerCheck.Trusted(FullAcl.AdminsSid), "SYSTEM and Administrators are trusted owners");
        Assert(!OwnerCheck.Trusted((SecurityIdentifier)null) && !OwnerCheck.Trusted(FullAcl.UsersSid) && !OwnerCheck.Trusted(FullAcl.InteractiveSid), "Users, Interactive and no owner are not");
        Assert(!OwnerCheck.Trusted(delegate { throw new UnauthorizedAccessException(); }), "an owner that cannot be read counts as hostile");
        Assert(OwnerCheck.Blocked == "Another program is blocking Support. Restart the PC and try again." && DeviceSetup.ExitText(DeviceSetup.Blocked) == OwnerCheck.Blocked && DeviceSetup.After(DeviceSetup.Blocked) == DeviceSetup.Screen.Install, "setup says what blocks it and offers to try again");
        Assert(DeviceUninstall.Map(DeviceUninstall.Blocked) == DeviceUninstall.Outcome.Blocked, "uninstall maps the blocked exit");
        if (me.Equals(FullAcl.SystemSid)) { Console.WriteLine("SKIP the squatter checks: this test runs as SYSTEM, a trusted owner"); return; }

        // A squatter: a Local mutex this account made first and owns.
        var msec = new MutexSecurity(); msec.AddAccessRule(new MutexAccessRule(me, MutexRights.FullControl, AccessControlType.Allow)); msec.SetOwner(me);
        string mn = "Local\\SupportMcpSquat-" + Guid.NewGuid().ToString("N"); bool made;
        using (var squat = new System.Threading.Mutex(false, mn, out made, msec)) {
            Assert(made, "the squatter made the mutex first");
            try { DeviceInstall.SetupMutex(mn).Dispose(); throw new Exception("the setup used a mutex someone else made"); }
            catch (DeviceInstall.BlockedException e) { Assert(e.Message == OwnerCheck.Blocked, "the refusal says what blocks it"); }
            string lockName = DeviceUpdate.LockName; DeviceUpdate.LockName = mn;
            try { Assert(DeviceUpdate.Lock(0) == null, "an update never takes a squatted lock"); } finally { DeviceUpdate.LockName = lockName; }
            OwnerCheck.AlsoTrusted = me;
            try { using (var ok = DeviceInstall.SetupMutex(mn)) Assert(ok != null, "the same mutex with a trusted owner is used"); } finally { OwnerCheck.AlsoTrusted = null; }
        }
        // A squatter whose access list names only LocalService: this account made it, so its own handle works, but any open
        // by name is denied. The open throws before an owner can be read, and that counts as hostile too.
        var lsec = new MutexSecurity(); lsec.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null), MutexRights.FullControl, AccessControlType.Allow));
        string ln = "Local\\SupportMcpSquatDenied-" + Guid.NewGuid().ToString("N");
        using (var shut = new System.Threading.Mutex(false, ln, out made, lsec)) {
            Assert(made, "the shut-out squatter made the mutex first");
            try { using (Mutex.OpenExisting(ln)) { } throw new Exception("this account could open a mutex whose access list names only LocalService"); } catch (UnauthorizedAccessException) { }
            try { DeviceInstall.SetupMutex(ln).Dispose(); throw new Exception("the setup used a mutex that shuts it out"); }
            catch (DeviceInstall.BlockedException e) { Assert(e.Message == OwnerCheck.Blocked, "a squatter that shuts the caller out is refused as blocked, not as an access error"); }
            string lockName = DeviceUpdate.LockName; DeviceUpdate.LockName = ln;
            try { Assert(DeviceUpdate.Lock(0) == null, "an update never takes a lock that shuts it out"); } finally { DeviceUpdate.LockName = lockName; }
            string sasKeep = SasShare.MutexName, sasKey = @"Software\SupportMcpTest-" + Guid.NewGuid().ToString("N");
            SasShare.MutexName = ln;
            try {
                using (var r = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(sasKey)) {
                    Assert(!SasShare.Acquire(r, "SupportMcp-aaaaaaaa"), "a SAS mutex that shuts the caller out is skipped as busy, not thrown");
                    Assert(!SasShare.Release(r, "SupportMcp-aaaaaaaa") && r.OpenSubKey(SasShare.HoldersKey) == null, "and a release is skipped the same way, with nothing recorded");
                }
            } finally { SasShare.MutexName = sasKeep; Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(sasKey, false); }
        }
        // The setup mutex this code makes is trusted by the next opener on any account that may open it at all.
        if (Elevated()) {
            string own = "Local\\SupportMcpOwn-" + Guid.NewGuid().ToString("N");
            using (var first = DeviceInstall.SetupMutex(own)) {
                var owner = first.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
                Assert(FullAcl.AdminsSid.Equals(owner), "an elevated install makes the setup mutex owned by Administrators: " + owner);
                bool second = false; var t = new Thread(delegate() { try { using (DeviceInstall.SetupMutex(own)) second = true; } catch (Exception) { } }); t.Start(); t.Join();
                Assert(second, "and a second elevated opener trusts it");
            }
        }

        // The SAS mutex: skipped as busy when squatted, in C# and in the backstop's PowerShell.
        string sasName = SasShare.MutexName, testKey = @"Software\SupportMcpTest-" + Guid.NewGuid().ToString("N");
        SasShare.MutexName = "Local\\SupportMcpSquatSas-" + Guid.NewGuid().ToString("N");
        int wait = SasShare.WaitMs; SasShare.WaitMs = 1000;
        try {
            using (var squat = new System.Threading.Mutex(false, SasShare.MutexName, out made, msec)) {
                using (var r = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(testKey)) Assert(!SasShare.Acquire(r, "SupportMcp-aaaaaaaa"), "a squatted SAS mutex is skipped, as if busy");
                using (var r = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(testKey)) Assert(r.OpenSubKey(SasShare.HoldersKey) == null, "and nothing is recorded");
                var ps = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"" + SasShare.ReleaseScript(@"HKCU:\" + testKey, "SupportMcp-aaaaaaaa") + "\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true });
                string err = ps.StandardError.ReadToEnd(); ps.WaitForExit();
                Assert(ps.ExitCode == 1 && err.Trim() == "", "the backstop's release refuses a squatted mutex and exits with 1: " + ps.ExitCode + " " + err);
            }
        } finally { SasShare.MutexName = sasName; SasShare.WaitMs = wait; Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(testKey, false); }

        // The uninstall event.
        string prefix = DeviceService.UninstallPrefix, legacy = DeviceService.UninstallEvent;
        DeviceService.UninstallPrefix = "Local\\SupportMcpTestUninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + "-";
        DeviceService.UninstallEvent = "Local\\SupportMcpTestUninstallOld-" + Guid.NewGuid().ToString("N");
        try {
            string folder = NewServiceFolder(dir, "http://127.0.0.1:9"), part1 = new string('a', 32), file = Path.Combine(folder, "device.json");
            var json = ReadJson(file); json["uninstall_event"] = part1; File.WriteAllText(file, Wire.Json().Serialize(json));
            var esec = new EventWaitHandleSecurity(); esec.AddAccessRule(new EventWaitHandleAccessRule(me, EventWaitHandleRights.FullControl, AccessControlType.Allow)); esec.SetOwner(me);
            using (var squat = new EventWaitHandle(false, EventResetMode.ManualReset, DeviceService.UninstallPrefix + part1, out made, esec)) {
                var svc = new DeviceService(Path.Combine(folder, "support.exe")); Assert(svc.TestInit(), "init");
                Assert(Wire.Text(svc.TestStatus(), "uninstall_event") == part1, "the status frame names the part from device.json");
                using (var own = svc.TestCreateUninstall()) {
                    string part2 = Wire.Text(svc.TestStatus(), "uninstall_event");
                    Assert(own != null && part2 != part1 && DeviceService.ValidPart(part2), "a squatted name is never used: the service picks a new one");
                    Assert(Wire.Text(ReadJson(file), "uninstall_event") == part2, "and keeps it in device.json");
                    Assert(DeviceService.WatchUninstall(part1) == null && DeviceService.WatchUninstall("../x") == null, "a tray never watches the squatter's event, or a bad name");
                    DeviceService.SignalUninstall(part1);
                    Assert(!squat.WaitOne(0), "the uninstaller never sets the squatter's event");
                    OwnerCheck.AlsoTrusted = me; // this account made the service's event, so it stands in for SYSTEM here
                    try {
                        if (Elevated() || Interactive()) using (var watch = DeviceService.WatchUninstall(part2)) Assert(watch != null, "a tray watches the service's own event");
                        if (Elevated()) { DeviceService.SignalUninstall(part2); Assert(own.WaitOne(2000), "the uninstaller sets it"); }
                        else Console.WriteLine("SKIP setting the uninstall event: only SYSTEM and Administrators may set it");
                    } finally { OwnerCheck.AlsoTrusted = null; }
                }
            }
        } finally { DeviceService.UninstallPrefix = prefix; DeviceService.UninstallEvent = legacy; }
        Console.WriteLine("PASS issue #22: squatted setup, update and SAS mutexes are refused, the uninstall event gets a new name, and trays and the uninstaller trust only SYSTEM or Administrators");
    }

    // Call 10: a check-in never raises control; it may lower full to limited, with a history line. Access follows the team.
    static void ControlTests(string dir) {
        Assert(DeviceService.NextControl("limited", "full") == "limited" && DeviceService.NextControl("full", "limited") == "limited" && DeviceService.NextControl("full", "full") == "full"
            && DeviceService.NextControl("limited", "limited") == "limited" && DeviceService.NextControl("full", "") == "full" && DeviceService.NextControl("", "full") == "limited", "control only ever goes down");
        using (var relay = new FakeDevice()) {
            Func<string, string, string> dev = delegate(string ac, string ct) { return Wire.Json().Serialize(Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "workspace", "default", "status", "active", "name", "PC", "access", ac, "control", ct, "site_id", null))); };
            Func<DeviceService, int> lines = delegate(DeviceService x) { var hl = x.TestStatus()["history"] as System.Collections.ArrayList; return hl == null ? 0 : hl.Count; };
            string folder = NewServiceFolder(dir, relay.Origin), file = Path.Combine(folder, "device.json"); // limited, ask
            var svc = new DeviceService(Path.Combine(folder, "support.exe")); Assert(svc.TestInit(), "init limited");
            relay.Status = 200; relay.Body = dev("ask", "full"); int n = lines(svc);
            svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "control") == "limited" && Wire.Text(ReadJson(file), "control") == "limited" && lines(svc) == n, "a check-in saying full leaves a limited PC limited, with no line");
            relay.Body = dev("any", "full"); svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "any" && Wire.Text(svc.TestStatus(), "control") == "limited", "access follows the team to any time, control stays");
            relay.Body = dev("ask", "full"); svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "access") == "ask", "and back to ask");

            var full = ReadJson(file); full["control"] = "full"; full["access"] = "any"; File.WriteAllText(file, Wire.Json().Serialize(full));
            svc = new DeviceService(Path.Combine(folder, "support.exe")); Assert(svc.TestInit(), "init full");
            relay.Body = dev("any", "limited"); n = lines(svc);
            svc.TestCheckInOnce();
            var h = svc.TestStatus()["history"] as System.Collections.ArrayList;
            Assert(Wire.Text(svc.TestStatus(), "control") == "limited" && Wire.Text(ReadJson(file), "control") == "limited" && lines(svc) == n + 1
                && Wire.Text((Dictionary<string, object>)h[h.Count - 1], "text") == "Control set to limited support.", "a check-in may lower full control to limited, with a history line");
            relay.Body = dev("any", "full"); svc.TestCheckInOnce();
            Assert(Wire.Text(svc.TestStatus(), "control") == "limited" && Wire.Text(ReadJson(file), "control") == "limited", "and never raises it again");
        }
        Console.WriteLine("PASS control comes from the PC: a check-in only lowers it, with a line; access follows the team both ways");
    }

    // The check-in schedule: six hours plus up to ten minutes while the doorbell is up and the PC is active, five minutes
    // plus up to thirty seconds otherwise or while pending; backoff and the 426 schedule unchanged.
    static void ScheduleTests() {
        var r = new Random(7); var S = DeviceService.Schedule.Normal;
        for (int i = 0; i < 500; i++) {
            long up = DeviceService.NextDelay(S, true, DeviceState.Active, 0, r), down = DeviceService.NextDelay(S, false, DeviceState.Active, 0, r), pending = DeviceService.NextDelay(S, true, DeviceState.Pending, 0, r);
            Assert(up >= DeviceService.DoorbellEveryMs && up <= DeviceService.DoorbellEveryMs + DeviceService.DoorbellJitterMaxMs, "doorbell up: 6 h plus up to 10 min: " + up);
            Assert(down >= DeviceService.CheckEveryMs && down <= DeviceService.CheckEveryMs + DeviceService.JitterMaxMs, "doorbell down: 5 min plus up to 30 s: " + down);
            Assert(pending >= DeviceService.CheckEveryMs && pending <= DeviceService.CheckEveryMs + DeviceService.JitterMaxMs, "a pending PC keeps 5 min: " + pending);
        }
        Assert(DeviceService.DoorbellEveryMs == 6 * 3600 * 1000L && DeviceService.DoorbellJitterMaxMs == 600000, "six hours and ten minutes");
        Assert(DeviceService.NextDelay(DeviceService.Schedule.Backoff, true, DeviceState.Active, 120000, r) == 120000 && DeviceService.NextDelay(DeviceService.Schedule.Update, true, DeviceState.Active, 0, r) == DeviceService.UpdateEveryMs, "backoff and the 426 schedule are unchanged");
        Console.WriteLine("PASS the check-in schedule follows the doorbell");
    }

    // The session pointer, the target session and the decision, without a live service.
    static void SessionRuleTests() {
        string id = new string('a', 64);
        Func<string, DeviceService.SessionPointer> read = delegate(string json) { return DeviceService.ReadSession(Wire.Json().Deserialize<Dictionary<string, object>>(json)); };
        var p = read("{\"protocol\":1,\"session\":{\"id\":\"" + id + "\",\"by\":\"tech@example.com\",\"team\":\"Acme\",\"ask\":false,\"expires_at\":1794000000000}}");
        Assert(p != null && p.Id == id && p.By == "tech@example.com" && p.Team == "Acme" && !p.Ask && p.ExpiresAt == 1794000000000, "the pointer is read");
        Assert(read("{\"session\":{\"id\":\"" + id + "\"}}").Ask && read("{\"session\":{\"id\":\"" + id + "\",\"ask\":\"false\"}}").Ask && read("{\"session\":{\"id\":\"" + id + "\",\"ask\":0}}").Ask, "an ask that is not exactly false asks");
        foreach (string bad in new string[] { "{\"protocol\":1}", "{\"session\":null}", "{\"session\":\"x\"}", "{\"session\":{}}", "{\"session\":{\"id\":\"abc\"}}", "{\"session\":{\"id\":\"" + new string('A', 64) + "\"}}", "{\"session\":{\"id\":7}}" })
            Assert(read(bad) == null, "no or a malformed session is none: " + bad);
        Assert(DeviceService.ReadSession(null) == null, "no body, no session");
        var cleaned = read("{\"session\":{\"id\":\"" + id + "\",\"by\":\"a\\nb" + new string('x', 300) + "\",\"team\":5}}");
        Assert(cleaned.By.Length == 200 && cleaned.By.IndexOf('\n') < 0 && cleaned.Team == "", "by and team are cleaned for display");

        var T = DeviceService.Target.Console;
        var t = DeviceService.PickTarget(1, true, new List<uint> { 2, 3 }); Assert(t.Kind == T && t.Session == 1, "a user at the console: the console");
        t = DeviceService.PickTarget(1, false, new List<uint> { 2 }); Assert(t.Kind == DeviceService.Target.Remote && t.Session == 2, "else the one Remote Desktop session");
        t = DeviceService.PickTarget(1, false, new List<uint> { 2, 3 }); Assert(t.Kind == DeviceService.Target.Busy, "several: busy");
        t = DeviceService.PickTarget(1, false, new List<uint>()); Assert(t.Kind == DeviceService.Target.Nobody && t.Session == 1, "none: nobody, at the console");
        t = DeviceService.PickTarget(1, false, new List<uint> { 0, 1 }); Assert(t.Kind == DeviceService.Target.Nobody, "session 0 and the console are never remote");

        var D = DeviceService.Start.Host;
        Assert(DeviceService.Decide(true, "any", "full", T, false) == DeviceService.Start.Ask, "the session asks: ask");
        Assert(DeviceService.Decide(false, "ask", "full", T, false) == DeviceService.Start.Ask, "the PC's own ask asks, whatever the session says");
        Assert(DeviceService.Decide(false, "any", "full", T, false) == D && DeviceService.Decide(false, "any", "limited", DeviceService.Target.Remote, false) == D, "any time and no ask: host");
        Assert(DeviceService.Decide(true, "ask", "limited", T, true) == D, "a session the person already allowed rejoins without asking");
        Assert(DeviceService.Decide(false, "any", "full", DeviceService.Target.Nobody, false) == D, "only full control any time runs at the sign-in screen");
        Assert(DeviceService.Decide(true, "any", "full", DeviceService.Target.Nobody, false) == DeviceService.Start.DeclineNobody && DeviceService.Decide(false, "ask", "full", DeviceService.Target.Nobody, false) == DeviceService.Start.DeclineNobody
            && DeviceService.Decide(false, "any", "limited", DeviceService.Target.Nobody, false) == DeviceService.Start.DeclineNobody && DeviceService.Decide(true, "ask", "full", DeviceService.Target.Nobody, true) == DeviceService.Start.DeclineNobody, "nobody signed in: an asking or a limited session is declined as nobody");
        Assert(DeviceService.Decide(false, "any", "full", DeviceService.Target.Busy, false) == DeviceService.Start.DeclineBusy, "several Remote Desktop users: busy");

        // The question's argument: who and the team only, base64url JSON, checked again on the way in.
        string arg = DeviceAsk.Encode("tech@example.com", "Acme", false);
        var back = DeviceAsk.Decode(arg);
        Assert(System.Text.RegularExpressions.Regex.IsMatch(arg, "^[A-Za-z0-9_-]+$") && back != null && Wire.Text(back, "by") == "tech@example.com" && Wire.Text(back, "team") == "Acme" && Wire.Text(back, "control") == "limited", "the question's argument round-trips");
        Func<object, string> enc = delegate(object o) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(Wire.Json().Serialize(o))).TrimEnd('=').Replace('+', '-').Replace('/', '_'); };
        Assert(DeviceAsk.Decode("") == null && DeviceAsk.Decode("!!") == null && DeviceAsk.Decode(new string('a', DeviceAsk.MaxArg + 1)) == null
            && DeviceAsk.Decode(enc(Wire.Map("by", "a", "team", "b", "control", "full", "key", "smd1.x"))) == null && DeviceAsk.Decode(enc(Wire.Map("by", "a", "team", "b", "control", "system"))) == null, "anything else is refused");
        Assert(DeviceAsk.Heading("tech@example.com") == "Allow tech@example.com to connect to this PC?" && DeviceAsk.Text("tech@example.com", "Acme", false).Contains("tech@example.com from Acme") && DeviceAsk.Text("a", "b", true).Contains("sign-in screen")
            && DeviceAsk.Text("", "", false).StartsWith("Someone from your support team") && DeviceAsk.AnswerMs == 120000 && ConsentDialog.ArmMs == 500, "the question names who and the team, and what they can do");
        Console.WriteLine("PASS the session rules: the pointer, the target session, ask, host or decline, and the question's argument");
    }

    // The status frame's new fields and the tray's words (no action id or label contains "ask").
    static void TrayPr6Tests() {
        var f = DeviceService.StatusFrame("PC", "ask", "limited", DeviceState.Active, "", 1, new System.Collections.ArrayList(), "tech@example.com", 42, new string('b', 32));
        var live = f["session"] as Dictionary<string, object>;
        Assert(live != null && Wire.Text(live, "by") == "tech@example.com" && Wire.Number(live, "since") == 42 && Wire.Text(f, "uninstall_event") == new string('b', 32), "the status frame carries the live session and the uninstall event's part");
        var g = DeviceService.StatusFrame("PC", "ask", "limited", DeviceState.Active, "", 1, new System.Collections.ArrayList());
        Assert(!g.ContainsKey("session") && !g.ContainsKey("uninstall_event"), "neither when there is none");
        Assert(TrayText.Mode("ask").Contains("asks you") && TrayText.Mode("ask").Contains("Your support team's admins can change this.") && !TrayText.Mode("any").Contains("admins"), "the tray's ask line says the team's admins can change it");
        Assert(DeviceSetup.ModeText("ask") == "Support asks you here, on this PC, before each connection. Your support team's admins can change this.", "so does the wizard's");
        // The tray's pipe requests (refresh, uninstall watcher, a button) pass a gate, so it never holds more connections
        // than the service's per-process limit lets one process have.
        int inside = 0, most = 0; var workers = new List<Thread>();
        for (int i = 0; i < 8; i++) { var w = new Thread(delegate() { Tray.Gated<int>(delegate { int n = Interlocked.Increment(ref inside); int m; while (n > (m = Thread.VolatileRead(ref most))) Interlocked.CompareExchange(ref most, n, m); Thread.Sleep(50); Interlocked.Decrement(ref inside); return 0; }); }); workers.Add(w); w.Start(); }
        foreach (var w in workers) w.Join();
        Assert(most == UiServer.PerProcess, "eight tray requests at once never hold more than " + UiServer.PerProcess + " pipe connections, and use both: " + most);
        // The corner window's last words: true for each kind of session.
        Assert(SupportWindow.EndedText("00:12:30", "") == "Session ended after 00:12:30. Support can no longer reach this PC.", "a one-off link cannot be used again");
        Assert(SupportWindow.EndedText("00:12:30", "any") == "Session ended after 00:12:30. Your support team can connect again later.", "an any-time PC can be reached again");
        Assert(SupportWindow.EndedText("00:12:30", "ask") == "Session ended after 00:12:30. Your support team will ask you before connecting again.", "an ask-first PC says it will be asked");
        Assert(SupportWindow.EndedText("00:12:30", "ask").IndexOf("no longer reach", StringComparison.Ordinal) < 0 && SupportWindow.EndedText("00:12:30", "any").IndexOf("no longer reach", StringComparison.Ordinal) < 0, "a saved PC never says support can no longer reach it");
        Assert(TrayText.SessionLine("tech@example.com") == "Connected: tech@example.com" && TrayText.EndSession == "End session", "who is connected, and End session");
        foreach (bool on in new bool[] { false, true })
            foreach (string access in new string[] { "ask", "any" }) {
                var actions = TrayText.Actions(DeviceState.Active, access, on);
                Assert(actions.Contains("end_session") == on && actions.Contains("uninstall"), "end_session only while a session is live");
                foreach (string a in actions) Assert(a.IndexOf("ask") < 0, "no action id contains ask: " + a);
            }
        foreach (string label in new string[] { TrayText.EndSession, TrayText.Uninstall, TrayText.AllowAction }) Assert(label.IndexOf("ask", StringComparison.OrdinalIgnoreCase) < 0, "no label contains ask: " + label);
        Console.WriteLine("PASS the tray: the live session, End session, the uninstall event's part, and the admins line");
    }

    // The doorbell against a loopback WebSocket server: the upgrade (path, Bearer key, no Origin, the accept check),
    // masked pings, a pong for the relay's ping, rings that wake the check-in at most once per gap without losing the
    // last, a reconnect after a close, an oversized, fragmented, binary or masked frame, a missing pong, a wrong accept
    // or a refusal, and a stop that stays stopped.
    static void DoorbellTests() {
        long b = 0; var seen = new List<long>();
        for (int i = 0; i < 8; i++) { b = Doorbell.NextBackoff(b, 5000, 300000); seen.Add(b); }
        Assert(seen[0] == 5000 && seen[1] == 10000 && seen[2] == 20000 && seen[5] == 160000 && seen[6] == 300000 && seen[7] == 300000, "reconnects wait 5 s, doubling to 5 min");
        Assert(Doorbell.AcceptFor("dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "the accept value of RFC 6455's example");
        using (var server = new FakeBell()) {
            var wakes = new List<long>();
            var bell = new Doorbell(server.Origin, "smd1.test.key", delegate { lock (wakes) wakes.Add(PauseClock.Now()); });
            bell.PingMs = 200; bell.PongMs = 1500; bell.RingGapMs = 600; bell.MinBackoffMs = 100; bell.MaxBackoffMs = 400; bell.ConnectMs = 5000;
            Func<int> count = delegate { lock (wakes) return wakes.Count; };
            try {
                bell.Start();
                Assert(server.Opened.WaitOne(5000) && Until(delegate { return bell.Connected; }, 3000), "the doorbell connects");
                string req = server.LastRequest;
                Assert(req.StartsWith("GET /device/ring?protocol=1 HTTP/1.1\r\n") && req.Contains("\r\nAuthorization: Bearer smd1.test.key\r\n") && req.Contains("\r\nUpgrade: websocket\r\n")
                    && req.Contains("\r\nSec-WebSocket-Version: 13\r\n") && req.IndexOf("\r\nOrigin:", StringComparison.OrdinalIgnoreCase) < 0 && req.IndexOf("smd1.test.key", StringComparison.Ordinal) == req.IndexOf("Bearer ", StringComparison.Ordinal) + 7, "the upgrade: the ring path, the key in the Bearer header only, no Origin:\n" + req);
                Assert(Until(delegate { return count() >= 1; }, 2000), "a connect wakes the check-in");
                Assert(Until(delegate { return server.Pings >= 3; }, 4000) && server.Unmasked == 0 && bell.Connected, "masked pings every PingMs keep it up");
                server.Send(FakeBell.Frame(9, Encoding.UTF8.GetBytes("hi"), true, false));
                Assert(Until(delegate { return server.LastPong == "hi"; }, 2000) && server.Unmasked == 0, "a ping from the relay gets a masked pong with its payload");

                Thread.Sleep(800); // past the gap of the connect's wake
                int before = count();
                for (int i = 0; i < 5; i++) server.Send(FakeBell.Text("{\"type\":\"ring\"}"));
                Assert(Until(delegate { return count() >= before + 1; }, 1000), "a ring wakes the check-in at once");
                Thread.Sleep(1600);
                long gap; int got; lock (wakes) { got = wakes.Count - before; gap = wakes[wakes.Count - 1] - wakes[wakes.Count - 2]; }
                Assert(got == 2 && gap >= 550, "five rings at once wake it twice, now and at the end of the gap: " + got + " wakes, " + gap + " ms apart");
                Assert(bell.Connected && server.Upgrades == 1, "rings and pings kept the one connection");

                Action<string, byte[]> closes = delegate(string what, byte[] frame) {
                    server.Closed.Reset(); server.Opened.Reset(); int ups = server.Upgrades;
                    server.Send(frame);
                    Assert(server.Closed.WaitOne(3000), "the doorbell closes on " + what);
                    Assert(server.Opened.WaitOne(5000) && Until(delegate { return bell.Connected; }, 3000) && server.Upgrades == ups + 1, "and connects again after " + what);
                };
                closes("a close frame", FakeBell.Frame(8, new byte[] { 3, 232 }, true, false));
                closes("a frame over 1 KB", FakeBell.Frame(1, new byte[Doorbell.FrameMax + 1], true, false));
                closes("a fragment", FakeBell.Frame(1, Encoding.UTF8.GetBytes("ring"), false, false));
                closes("a binary frame", FakeBell.Frame(2, new byte[] { 1 }, true, false));
                closes("a masked frame", FakeBell.Frame(1, Encoding.UTF8.GetBytes("ring"), true, true));
                // A frame of exactly 1 KB is still read: a ring.
                before = count(); Thread.Sleep(700);
                server.Send(FakeBell.Frame(1, new byte[Doorbell.FrameMax], true, false));
                Assert(Until(delegate { return count() > before; }, 1500) && bell.Connected, "a 1 KB frame is a ring");

                server.NoPong = true; server.Closed.Reset(); server.Opened.Reset(); var quiet = Stopwatch.StartNew();
                Assert(server.Closed.WaitOne(6000) && quiet.ElapsedMilliseconds >= 900, "no pong within PongMs: the doorbell drops the connection");
                server.NoPong = false;
                Assert(server.Opened.WaitOne(5000) && Until(delegate { return bell.Connected; }, 3000), "and connects again");

                int good = bell.Connections; server.BadAccept = true; server.Closed.Reset();
                server.Send(FakeBell.Frame(8, new byte[0], true, false));
                Assert(server.Closed.WaitOne(3000), "closed for the next test");
                Thread.Sleep(1500);
                Assert(!bell.Connected && bell.Connections == good && server.Upgrades > good, "a wrong Sec-WebSocket-Accept is refused");
                server.BadAccept = false;
                Assert(Until(delegate { return bell.Connected; }, 5000), "a right one connects");
                good = bell.Connections; server.Status = 401; server.Closed.Reset();
                server.Send(FakeBell.Frame(8, new byte[0], true, false));
                Assert(server.Closed.WaitOne(3000), "closed for the refusal test");
                Thread.Sleep(1500);
                Assert(!bell.Connected && bell.Connections == good, "a refused upgrade does not connect");
                server.Status = 101;
                Assert(Until(delegate { return bell.Connected; }, 5000), "and it keeps trying");

                bell.Stop();
                Assert(!bell.Connected, "a stopped doorbell is not connected");
                int after = server.Upgrades; Thread.Sleep(1000);
                Assert(server.Upgrades == after, "and stays closed");
            } finally { bell.Stop(); }
        }
        Console.WriteLine("PASS the doorbell: the upgrade, pings and pongs, rings at most once per gap, every close case, a missing pong, a bad accept, and stop");
    }

    sealed class OwnToken {
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr result);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        // A primary token of this test account: stands in for the signed-in user's (WTSQueryUserToken needs SYSTEM).
        public static IntPtr Get(uint session) {
            IntPtr own, dup;
            if (!OpenProcessToken(GetCurrentProcess(), 0x02000000, out own)) return IntPtr.Zero;
            try { if (!DuplicateTokenEx(own, 0x02000000, IntPtr.Zero, 2, 1, out dup)) return IntPtr.Zero; } finally { CloseHandle(own); }
            return dup;
        }
    }
    static string HelloWith(string access, string control, Dictionary<string, object> session, Dictionary<string, object> update) {
        var m = Wire.Map("protocol", 1, "device", Wire.Map("id", "d", "workspace", "default", "status", "active", "name", "PC", "access", access, "control", control, "site_id", null));
        if (session != null) m["session"] = session; if (update != null) m["update"] = update;
        return Wire.Json().Serialize(m);
    }
    static Dictionary<string, object> Pointer(string id, bool ask) { return Wire.Map("id", id, "by", "tech@example.com", "team", "Acme", "ask", ask, "expires_at", Client.UnixNow() + 3600000); }
    // A service on a fresh folder with this access and control, and the test hooks: the target session, the user token
    // (this account's) and the corner pipe's ACL (this account may add instances). Asker is set by each case.
    static DeviceService SessionService(string dir, string origin, string access, string control, DeviceService.Target kind, out string folder) {
        folder = NewServiceFolder(dir, origin); string file = Path.Combine(folder, "device.json");
        var json = ReadJson(file); json["access"] = access; json["control"] = control; File.WriteAllText(file, Wire.Json().Serialize(json));
        var svc = new DeviceService(Path.Combine(folder, "support.exe"));
        Assert(svc.TestInit(), "init a session service");
        uint mine = (uint)Process.GetCurrentProcess().SessionId;
        svc.Targets = delegate { return new DeviceService.TargetChoice { Kind = kind, Session = kind == DeviceService.Target.Busy ? 0xFFFFFFFF : mine }; };
        svc.UserTokens = OwnToken.Get;
        svc.CornerSddl = "D:P(A;;GA;;;" + WindowsIdentity.GetCurrent().User.Value + ")(A;;0x12008B;;;IU)";
        svc.Asker = delegate { throw new Exception("this case must not ask"); };
        return svc;
    }
    static List<Dictionary<string, object>> AgentFor(FakeDevice relay, string type, string id) { return relay.Agent(type).FindAll(delegate(Dictionary<string, object> e) { return Wire.Text(e, "query") == "?sid=" + id; }); }
    static Dictionary<string, object> Body(Dictionary<string, object> logged) { return (Dictionary<string, object>)logged["body"]; }

    // Sessions on a saved PC against the fake relay's /agent: the decline paths (nobody, busy, declined, sent again only
    // when it failed), the question asked once, the accepted id saved and rejoined without asking, the Bearer key and no
    // X-Attach-Key, limited support acting as the user (run, as: system refused, files, no block_input or control),
    // the driver, end_session from the tray's session only with reason owner, a session gone from the answer ending
    // locally, full control at the sign-in screen, and updates held while a session is waiting or live.
    static void SessionLiveTests(string dir) {
        uint mine = (uint)Process.GetCurrentProcess().SessionId; string folder;
        var started = new List<DeviceService>();
        using (var relay = new FakeDevice())
        using (var signer = new TestSigner()) {
            relay.Status = 200;
            try {
                // Nobody signed in, an asking session on a limited PC: declined as nobody with the device key, nothing asked.
                string id = Hex64();
                var svc = SessionService(dir, relay.Origin, "ask", "limited", DeviceService.Target.Nobody, out folder); started.Add(svc);
                relay.Body = HelloWith("ask", "limited", Pointer(id, true), null);
                svc.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "decline", id).Count == 1; }, 5000), "nobody signed in: a decline");
                var d = AgentFor(relay, "decline", id)[0];
                Assert(Wire.Text(Body(d), "reason") == "nobody" && Wire.Text(d, "auth") == "Bearer smd1.default.id.secret" && d["attach"] == null && AgentFor(relay, "hello", id).Count == 0, "declined as nobody, with the device key as a Bearer header and no X-Attach-Key");
                Assert(svc.TestHoldUpdates, "updates wait while the pointer is there");
                svc.TestCheckInOnce(); Thread.Sleep(500);
                Assert(AgentFor(relay, "decline", id).Count == 1, "the same pointer again: no second decline");
                relay.Body = HelloWith("ask", "limited", null, null); svc.TestCheckInOnce();
                Assert(!svc.TestHoldUpdates, "the pointer gone: updates may go on");

                // A limited PC set to any time, a session that does not ask, nobody signed in: still declined as nobody.
                id = Hex64(); svc = SessionService(dir, relay.Origin, "any", "limited", DeviceService.Target.Nobody, out folder); started.Add(svc);
                relay.Body = HelloWith("any", "limited", Pointer(id, false), null); svc.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "decline", id).Count == 1; }, 5000) && Wire.Text(Body(AgentFor(relay, "decline", id)[0]), "reason") == "nobody", "a limited PC never runs at the sign-in screen");

                // Several Remote Desktop users: busy.
                id = Hex64(); svc = SessionService(dir, relay.Origin, "any", "full", DeviceService.Target.Busy, out folder); started.Add(svc);
                relay.Body = HelloWith("any", "full", Pointer(id, false), null); svc.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "decline", id).Count == 1; }, 5000) && Wire.Text(Body(AgentFor(relay, "decline", id)[0]), "reason") == "busy", "several Remote Desktop users: busy");

                // The person says Don't allow: declined, asked once. A decline that fails is sent again without asking.
                id = Hex64(); svc = SessionService(dir, relay.Origin, "ask", "full", DeviceService.Target.Console, out folder); started.Add(svc);
                int asked = 0; bool fullAsked = false;
                svc.Asker = delegate(uint s, DeviceService.SessionPointer p, bool full, WaitHandle w) { asked++; fullAsked = full; Assert(s == mine && p.By == "tech@example.com" && p.Team == "Acme", "the question names who and the team, in the target session"); return false; };
                relay.DeclineStatus = 500;
                relay.Body = HelloWith("ask", "full", Pointer(id, false), null); svc.TestCheckInOnce();
                Assert(Until(delegate { return svc.TestDeclined == "declined" && svc.TestSessionFinished; }, 5000) && asked == 1 && fullAsked, "the PC's own ask asks even when the session does not; Don't allow is declined");
                relay.DeclineStatus = 200;
                relay.Body = HelloWith("ask", "full", Pointer(id, false), null); svc.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "decline", id).Count == 2; }, 5000) && asked == 1, "a decline the relay did not take is sent again, without asking again");
                svc.TestCheckInOnce(); Thread.Sleep(500);
                Assert(AgentFor(relay, "decline", id).Count == 2 && asked == 1, "and only until it got through");

                // Allow on a limited PC: hosted as the user, with the accepted id saved.
                id = Hex64(); svc = SessionService(dir, relay.Origin, "ask", "limited", DeviceService.Target.Console, out folder); started.Add(svc);
                string limitedFolder = folder, limitedId = id; asked = 0;
                svc.Asker = delegate(uint s, DeviceService.SessionPointer p, bool full, WaitHandle w) { asked++; fullAsked = full; return true; };
                relay.AgentDriver = "tech@example.com";
                relay.Body = HelloWith("ask", "limited", Pointer(id, true), null); svc.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "hello", id).Count == 1; }, 8000), "Allow: the session connects");
                var hello = AgentFor(relay, "hello", id)[0];
                Assert(asked == 1 && !fullAsked && Wire.Text(Body(hello), "control") == "normal" && !Wire.Flag(Body(hello), "elevated") && Wire.Text(hello, "auth") == "Bearer smd1.default.id.secret" && hello["attach"] == null, "a limited PC says hello with control normal and the Bearer key only");
                Assert(Wire.Text(ReadJson(Path.Combine(folder, "device.json")), "accepted_session") == id && svc.TestAccepted == id, "the accepted id is saved in device.json");
                Assert(Until(delegate { var st = svc.TestStatus(); return st.ContainsKey("session") && Wire.Text((Dictionary<string, object>)st["session"], "by") == "tech@example.com" && Wire.Number((Dictionary<string, object>)st["session"], "since") > 0; }, 3000), "the status frame shows who is connected");
                Assert(svc.TestHoldUpdates, "updates wait while a session is live");
                var r = relay.AgentResult(relay.AgentQueue(Wire.Map("type", "run", "command", "[Console]::Write([Environment]::UserName)", "timeout_s", 60)), 90);
                Assert(Wire.Flag(r, "ok") && Decode(r, "stdout_b64") == Environment.UserName, "run runs as the user: " + Wire.Text(r, "error") + Decode(r, "stdout_b64"));
                r = relay.AgentResult(relay.AgentQueue(Wire.Map("type", "run", "command", "whoami", "as", "system", "timeout_s", 30)), 90);
                Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error").Contains("needs full control"), "as: system is refused with limited support");
                string probe = Path.Combine(dir, "limited-" + Guid.NewGuid().ToString("N") + ".txt"); File.WriteAllText(probe, "hello");
                r = relay.AgentResult(relay.AgentQueue(Wire.Map("type", "get_file", "path", probe, "length", 100)), 90);
                Assert(Wire.Flag(r, "ok") && Decode(r, "data_b64") == "hello", "a file is read as the user: " + Wire.Text(r, "error"));
                string written = probe + ".put";
                r = relay.AgentResult(relay.AgentQueue(Wire.Map("type", "put_file", "path", written, "data_b64", Convert.ToBase64String(Encoding.UTF8.GetBytes("put")))), 90);
                Assert(Wire.Flag(r, "ok") && File.ReadAllText(written) == "put", "a file is written as the user: " + Wire.Text(r, "error"));
                r = relay.AgentResult(relay.AgentQueue(Wire.Map("type", "screen", "action", Wire.Map("name", "block_input", "on", true))), 90);
                Assert(!Wire.Flag(r, "ok") && Wire.Text(r, "error") == Screen.NoFull, "block_input needs full control");
                r = relay.AgentResult(relay.AgentQueue(Wire.Map("type", "control")), 90);
                Assert(!Wire.Flag(r, "ok"), "a limited PC never takes full control: " + Wire.Text(r, "error"));
                relay.AgentDriver = "other@example.com";
                Assert(Until(delegate { var st = svc.TestStatus(); return st.ContainsKey("session") && Wire.Text((Dictionary<string, object>)st["session"], "by") == "other@example.com"; }, 5000), "a take-over shows the new driver");
                // end_session from a tray in another session does nothing; from the session's own, it ends with reason owner.
                svc.TestHandle(Wire.Map("type", "end_session"), mine + 1); Thread.Sleep(500);
                Assert(svc.TestSessionHosting && AgentFor(relay, "end", id).Count == 0, "end_session from another session is ignored");
                var after = svc.TestHandle(Wire.Map("type", "end_session"), mine);
                Assert(after != null, "end_session is answered with the status");
                Assert(Until(delegate { return AgentFor(relay, "end", id).Count == 1 && svc.TestSessionFinished; }, 8000) && Wire.Text(Body(AgentFor(relay, "end", id)[0]), "reason") == "owner", "End session ends it with reason owner");
                Assert(!svc.TestTerminal && !svc.TestStatus().ContainsKey("session"), "and the PC goes back to checking in");
                svc.TestCheckInOnce(); Thread.Sleep(500);
                Assert(AgentFor(relay, "hello", id).Count == 1 && asked == 1, "the same pointer does not start it again");

                // A restarted service rejoins the session the person allowed, without asking.
                var again = new DeviceService(Path.Combine(limitedFolder, "support.exe")); Assert(again.TestInit(), "reload"); started.Add(again);
                again.Targets = svc.Targets; again.UserTokens = OwnToken.Get; again.CornerSddl = svc.CornerSddl;
                again.Asker = delegate { throw new Exception("a rejoin must not ask"); };
                relay.Body = HelloWith("ask", "limited", Pointer(limitedId, true), null); again.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "hello", limitedId).Count == 2; }, 8000), "a restarted service rejoins the accepted session without asking");
                again.TestStopSession();

                // Full control, any time, nobody signed in: hosted with control full. Then the session goes from the answer: it ends here.
                id = Hex64(); svc = SessionService(dir, relay.Origin, "any", "full", DeviceService.Target.Nobody, out folder); started.Add(svc);
                relay.Body = HelloWith("any", "full", Pointer(id, false), null); svc.TestCheckInOnce();
                Assert(Until(delegate { return AgentFor(relay, "hello", id).Count == 1; }, 8000) && Wire.Text(Body(AgentFor(relay, "hello", id)[0]), "control") == "full", "full control any time runs with nobody signed in, as full");
                relay.Body = HelloWith("any", "full", null, null); svc.TestCheckInOnce();
                Assert(Until(delegate { return svc.TestSessionFinished && AgentFor(relay, "end", id).Count == 1; }, 8000), "a session gone from the answer ends locally");
                Assert(!svc.TestTerminal && Wire.Text(ReadJson(Path.Combine(folder, "device.json")), "accepted_session") == "" && File.Exists(Path.Combine(folder, "device.json")), "nothing is uninstalled, and the accepted id is cleared");

                // Updates wait while a pointer is there, and go on once it is gone.
                byte[] exe = FakeExe(60000, 9); relay.InstallBody = WithFooter(exe, relay.Origin);
                string note = NoteFor("99.0.0", Sha(exe), exe.Length); var update = Wire.Map("version", "99.0.0", "note", note, "signature", signer.Sign(note));
                id = Hex64(); svc = SessionService(dir, relay.Origin, "any", "full", DeviceService.Target.Busy, out folder); started.Add(svc);
                svc.TestUpdates(signer.Xy, delegate(string f, string a) { return null; });
                try {
                    int hits = relay.InstallHits;
                    relay.Body = HelloWith("any", "full", Pointer(id, false), update); svc.TestCheckInOnce();
                    Assert(relay.InstallHits == hits && svc.TestStaged == "", "an update offered with a session waiting is held");
                    relay.Body = HelloWith("any", "full", null, update); svc.TestCheckInOnce();
                    Assert(relay.InstallHits == hits + 1 && svc.TestStaged.Length > 0, "and taken once the session is gone");
                } finally { svc.TestDropStaged(); }
            } finally { foreach (var x in started) x.TestStopSession(); }
        }
        Console.WriteLine("PASS sessions on a saved PC: declines, the question, Allow and rejoin, limited support as the user, the driver, End session, a session gone, full control at the sign-in screen, and updates held");
    }

    static void Press(System.Windows.Controls.Button button) { button.RaiseEvent(new System.Windows.RoutedEventArgs(System.Windows.Controls.Primitives.ButtonBase.ClickEvent)); }
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    // A window of another process: the focus-return test starts this exe again with --peer <parent pid>. It lets the
    // parent take the foreground, and prints "ready" once its window is shown.
    static int PeerWindow(int parent) {
        Application.EnableVisualStyles();
        var display = Screen.Monitors()[0];
        using (var form = new Form { Text = "focus peer", StartPosition = FormStartPosition.Manual, Location = new System.Drawing.Point(display.X + 400, display.Y + 60), Size = new System.Drawing.Size(300, 200), TopMost = true }) {
            form.Shown += delegate { form.Activate(); AllowSetForegroundWindow(parent); Console.Out.WriteLine("ready"); Console.Out.Flush(); };
            Application.Run(form);
        }
        return 0;
    }
    public static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--peer") { Screen.Dpi(); return PeerWindow(int.Parse(args[1])); }
        if (args.Length == 2 && args[0] == "--settle") { Thread.Sleep(250); File.WriteAllText(args[1], "done"); return 0; }
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
                            Assert(message.Contains("see your screen") && message.Contains("control your mouse and keyboard") && message.Contains("run commands") && message.Contains("change files"), "Consent must name screen, mouse and keyboard control as well as commands and files: " + message);
                            return answer;
                        });
                        bool preconsented = reconnect && !administrator;
                        Assert(allowed == (preconsented || answer == DialogResult.Yes), "Only explicit Yes grants new access");
                        Assert(prompts == (preconsented ? 0 : 1), "Administrator startup and reconnect must always prompt");
                    }
                }
            }
            foreach (bool administrator in new bool[] { false, true }) {
                string without = SupportAccess.ConsentMessage(administrator, false);
                Assert(!without.Contains("see your screen") && without.Contains("run commands") && without.Contains("stay off") && without.Contains("with administrator rights?") == administrator, "A reconnect without screen consent must not promise it: " + without);
                Assert(SupportAccess.ConsentMessage(administrator) == SupportAccess.ConsentMessage(administrator, true), "The default consent names screen control");
                string shown = null; SupportAccess.Confirm(administrator, true, false, delegate(string message) { shown = message; return DialogResult.No; });
                Assert(administrator ? shown == without : shown == null, "The prompt for a reconnect without screen consent says so");
            }
            Console.WriteLine("PASS consent accepts only Yes, describes actual rights, and never silently grants administrator reconnect");
            using (var relay = new FakeRelay()) {
                relay.Lifetime = 300000; // covers the 60 s cold-start allowance below plus the rest of this block
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
                SettleTests(relay, dir);
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
            ScreenPureTests(dir);
            FullControlTests(dir);
            ClientRuleTests(dir);
            LaneTests();
            LiveScreenTests();
            FooterReaderTests();
            DeviceLinkTests();
            SetupRuleTests();
            DeviceInstallTests();
            DeviceServiceTests(dir);
            TrayTests();
            UninstallTests(dir);
            DeviceServiceLiveTests(dir);
            ReleaseKeyTests();
            ReleaseNoteTests();
            SemVerTests();
            UpdaterTests();
            DownloadTests();
            UpdateSwitchRuleTests();
            UpdateServiceTests(dir);
            UpdateTrialTests(dir);
            UninstallUpdateTests(dir);
            ScmCallTests();
            OwnerCheckTests(dir);
            ControlTests(dir);
            ScheduleTests();
            SessionRuleTests();
            TrayPr6Tests();
            DoorbellTests();
            SessionLiveTests(dir);
            // The downloaded PE overlay must be readable by the actual .NET client.
            string overlay = Path.Combine(dir, "overlay.exe"); byte[] cfg = Encoding.UTF8.GetBytes(Wire.Json().Serialize(Wire.Map("sid", new string('a', 64), "key", new string('b', 64), "origin", "https://support.example.com", "startup_expires_at", Client.UnixNow() + 10000)));
            using (var f = File.Create(overlay)) { f.WriteByte(77); f.WriteByte(90); f.Write(cfg, 0, cfg.Length); byte[] n = BitConverter.GetBytes(cfg.Length); f.Write(n, 0, n.Length); byte[] footer = Encoding.ASCII.GetBytes(Wire.Footer); f.Write(footer, 0, footer.Length); }
            Assert(Wire.Text(Wire.ReadConfig(overlay), "sid") == new string('a', 64), "Overlay configuration");
            Console.WriteLine("PASS executable session overlay"); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally { TryDeleteDir(dir); }
    }
}
