using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Colossal.Logging;

namespace CS2MapBuilder.Infrastructure
{
    /// <summary>
    /// Logs to the game log (Logs\CS2MapBuilder.log via Colossal LogManager) and to ModsData\CS2MapBuilder\import.log.
    /// Keeps the last lines in memory for the UI. Never throws.
    /// </summary>
    public static class ImportLog
    {
        private static readonly ILog s_Log = LogManager.GetLogger(ModPaths.ModId).SetShowsErrorsInUI(false);
        private static readonly object s_Lock = new object();
        private static readonly LinkedList<string> s_Recent = new LinkedList<string>();
        private const int kRecent = 12;
        private static int s_Version;

        public static int Version => s_Version;

        public static void Info(string msg) => Write("INFO ", msg, null);
        public static void Warn(string msg) => Write("WARN ", msg, null);
        public static void Error(string msg, Exception e = null) => Write("ERROR", msg, e);

        public static string[] RecentLines(int n)
        {
            lock (s_Lock) return s_Recent.Skip(Math.Max(0, s_Recent.Count - n)).ToArray();
        }

        public static void BeginSession(string header)
        {
            try
            {
                Directory.CreateDirectory(ModPaths.ModsData);
                File.AppendAllText(ModPaths.ImportLogFile,
                    Environment.NewLine + "==================== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + header + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch (Exception) { }
        }

        private static void Write(string level, string msg, Exception e)
        {
            string text = e == null ? msg : msg + " | " + e.GetType().Name + ": " + e.Message;
            try
            {
                if (level == "ERROR") { if (e != null) s_Log.Error(e, msg); else s_Log.Error(msg); }
                else if (level == "WARN ") s_Log.Warn(msg);
                else s_Log.Info(msg);
            }
            catch (Exception) { }
            try
            {
                string line = DateTime.Now.ToString("HH:mm:ss.fff") + " " + level + " " + text;
                File.AppendAllText(ModPaths.ImportLogFile, line + Environment.NewLine + (e != null ? e + Environment.NewLine : ""), Encoding.UTF8);
            }
            catch (Exception) { }
            lock (s_Lock)
            {
                s_Recent.AddLast(level.Trim() + " " + text);
                while (s_Recent.Count > kRecent) s_Recent.RemoveFirst();
                s_Version++;
            }
        }
    }

    /// <summary>Per-step counters and timings for the final summary.</summary>
    public sealed class StepReport
    {
        public string Name;
        public string Status = "pending"; // pending, skipped, ok, partial, failed, cancelled
        public readonly Stopwatch Timer = new Stopwatch();
        public int Created;
        public readonly Dictionary<string, int> Skipped = new Dictionary<string, int>();
        public readonly Dictionary<string, int> Failed = new Dictionary<string, int>();
        public readonly List<string> Notes = new List<string>();

        public void Skip(string reason, int n = 1) { if (n > 0) Skipped[reason] = (Skipped.TryGetValue(reason, out int c) ? c : 0) + n; }
        public void Fail(string reason, int n = 1) { if (n > 0) Failed[reason] = (Failed.TryGetValue(reason, out int c) ? c : 0) + n; }

        public string Line()
        {
            var sb = new StringBuilder();
            sb.Append($"{Name,-10} {Status,-9} {Timer.ElapsedMilliseconds,7} ms  created {Created}");
            if (Skipped.Count > 0) sb.Append("  skipped " + string.Join(", ", Skipped.Select(kv => $"{kv.Value} {kv.Key}")));
            if (Failed.Count > 0) sb.Append("  FAILED " + string.Join(", ", Failed.Select(kv => $"{kv.Value} {kv.Key}")));
            return sb.ToString();
        }
    }
}
