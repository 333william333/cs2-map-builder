using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using CS2MapBuilder.Infrastructure;
using Newtonsoft.Json;

namespace CS2MapBuilder.Systems
{
    /// <summary>
    /// Machine-readable record of one "Create playable map" run, written to ModsData\CS2MapBuilder\autorun-result.json
    /// after every phase (heartbeat), so a crash still leaves evidence. Used by the autorun test hook.
    /// </summary>
    public sealed class AutorunReport
    {
        public sealed class PhaseInfo
        {
            public string name;
            public string status = "running";
            public double seconds;
            public string detail;
        }

        public sealed class Requirement
        {
            public string requirement;
            public bool passed;
        }

        public string startedAt = DateTime.Now.ToString("o");
        public string finishedAt;
        public string gameVersion;
        public string modVersion;
        public object request;
        public List<string> heartbeat = new List<string>();
        public List<PhaseInfo> phases = new List<PhaseInfo>();
        public List<string> importSteps = new List<string>();
        public bool? importAborted;
        public string importResult;
        public List<Requirement> checklist = new List<Requirement>();
        public bool? playable;
        public string saveAssetDataPath;
        public string saveExpectedFile;
        public bool? saveFileExists;
        public List<string> saveFolderMatches = new List<string>();
        public bool? mapListingFound;
        public string mapListingName;
        public string mapListingId;
        public bool? mapListingIsUserMap;
        public bool? mapListingIsPlayable;
        public bool? listedUnderNewGame;
        public bool? ok;
        public string message;
        public string returnedToMenu;
        public bool quitRequested;

        [JsonIgnore] private readonly Stopwatch m_Total = Stopwatch.StartNew();
        [JsonIgnore] private Stopwatch m_Phase;

        public static string ResultPath => Path.Combine(ModPaths.ModsData, "autorun-result.json");

        public void Beat(string text)
        {
            string line = $"{DateTime.Now:HH:mm:ss.fff} +{m_Total.Elapsed.TotalSeconds:0.0}s {text}";
            heartbeat.Add(line);
            Write();
        }

        public void BeginPhase(string name)
        {
            EndPhase("ok", null);
            phases.Add(new PhaseInfo { name = name });
            m_Phase = Stopwatch.StartNew();
            Beat("phase: " + name);
        }

        public void EndPhase(string status, string detail)
        {
            if (phases.Count == 0 || m_Phase == null) return;
            var p = phases[phases.Count - 1];
            if (p.status != "running") return;
            p.status = status;
            p.seconds = Math.Round(m_Phase.Elapsed.TotalSeconds, 2);
            if (detail != null) p.detail = detail;
            m_Phase = null;
        }

        public void Finish(bool success, string text)
        {
            EndPhase(success ? "ok" : "failed", text);
            ok = success;
            message = text;
            finishedAt = DateTime.Now.ToString("o");
            Beat("finished: " + (success ? "ok" : "failed") + ": " + text);
        }

        /// <summary>Writes the whole report atomically (temp file, then replace). Never throws.</summary>
        public void Write()
        {
            try
            {
                Directory.CreateDirectory(ModPaths.ModsData);
                string tmp = ResultPath + ".tmp";
                File.WriteAllText(tmp, JsonConvert.SerializeObject(this, Formatting.Indented));
                if (File.Exists(ResultPath)) File.Delete(ResultPath);
                File.Move(tmp, ResultPath);
            }
            catch (Exception e)
            {
                ImportLog.Warn("Could not write autorun-result.json: " + e.Message);
            }
        }
    }
}
