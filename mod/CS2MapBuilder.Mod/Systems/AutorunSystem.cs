using System;
using System.Diagnostics;
using System.IO;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Settings;
using Game;
using Game.SceneFlow;
using Newtonsoft.Json;

namespace CS2MapBuilder.Systems
{
    /// <summary>
    /// Test hook for unattended runs. On reaching the main menu, if ModsData\CS2MapBuilder\autorun.json exists:
    /// rename it first (autorun.json.taken-&lt;time&gt;, so it can never loop), run "Create playable map", write
    /// autorun-result.json (heartbeat at every phase), return to the main menu and optionally quit the game.
    /// Does nothing when the file is absent (one File.Exists per visit to the main menu).
    /// </summary>
    public sealed class AutorunSystem : GameSystemBase
    {
        private sealed class Request
        {
            [JsonProperty("package")] public string Package { get; set; }
            [JsonProperty("mapName")] public string MapName { get; set; }
            [JsonProperty("overwrite")] public bool Overwrite { get; set; }
            [JsonProperty("quitWhenDone")] public bool QuitWhenDone { get; set; }
        }

        private enum State { Watching, Delay, Running, ReturnToMenu, WaitMenu, Quit, Done }

        public static string RequestPath => Path.Combine(ModPaths.ModsData, "autorun.json");

        private State m_State = State.Watching;
        private bool m_WasInMenu;
        private int m_Frames;
        private int m_FlowCountAtStart;
        private Request m_Request;
        private AutorunReport m_Report;
        private readonly Stopwatch m_Wait = new Stopwatch();

        protected override void OnUpdate()
        {
            var gm = GameManager.instance;
            if (gm == null) return;
            bool inMenu = gm.gameMode == GameMode.MainMenu && !gm.isGameLoading;
            try
            {
                switch (m_State)
                {
                    case State.Watching:
                        if (inMenu && !m_WasInMenu && File.Exists(RequestPath)) { m_State = State.Delay; m_Frames = 0; }
                        break;
                    case State.Delay:
                        // Let the menu and the asset database settle before starting.
                        if (!inMenu) { m_State = State.Watching; break; }
                        if (++m_Frames >= 300) Start();
                        break;
                    case State.Running:
                        if (MapFlowSystem.FinishedCount != m_FlowCountAtStart && !MapFlowSystem.IsBusy) AfterFlow();
                        break;
                    case State.ReturnToMenu:
                        if (inMenu) { m_State = State.WaitMenu; m_Wait.Restart(); break; }
                        if (m_Wait.Elapsed.TotalSeconds > 300) { m_Report.returnedToMenu = "timeout"; m_Report.Beat("did not reach the main menu within 300 s"); m_State = State.WaitMenu; m_Wait.Restart(); }
                        break;
                    case State.WaitMenu:
                        // Give the asset database time to flush the saved map to disk before quitting.
                        if (m_Wait.Elapsed.TotalSeconds < 10) break;
                        if (m_Report.returnedToMenu == null) m_Report.returnedToMenu = "yes";
                        m_Report.Beat("back in the main menu" + (m_Request.QuitWhenDone ? ", quitting" : ""));
                        m_State = m_Request.QuitWhenDone ? State.Quit : State.Done;
                        break;
                    case State.Quit:
                        m_State = State.Done;
                        MapFlowSystem.Report = null;
                        ImportLog.Info("Autorun: quitting the game (quitWhenDone).");
                        GameManager.QuitGame();
                        break;
                    case State.Done:
                        m_State = State.Watching;
                        MapFlowSystem.Report = null;
                        break;
                }
            }
            catch (Exception e)
            {
                ImportLog.Error("Autorun failed", e);
                if (m_Report != null) { m_Report.Finish(false, "autorun error: " + e.Message); }
                MapFlowSystem.Report = null;
                m_State = State.Watching;
            }
            m_WasInMenu = inMenu;
        }

        private void Start()
        {
            // Take the request file first so a crash or restart can never run it again.
            string taken = RequestPath + ".taken-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            string text;
            try
            {
                text = File.ReadAllText(RequestPath);
                File.Move(RequestPath, taken);
            }
            catch (Exception e)
            {
                ImportLog.Error("Autorun: could not take autorun.json; not running", e);
                try { File.Delete(RequestPath); } catch (Exception) { }
                m_State = State.Watching;
                return;
            }

            m_Report = new AutorunReport
            {
                modVersion = typeof(AutorunSystem).Assembly.GetName().Version?.ToString(),
                gameVersion = SafeGameVersion(),
            };
            try { m_Request = JsonConvert.DeserializeObject<Request>(text) ?? new Request(); }
            catch (Exception e)
            {
                m_Request = new Request();
                m_Report.request = text;
                m_Report.Finish(false, "autorun.json is not valid JSON: " + e.Message);
                m_State = State.Watching;
                return;
            }
            m_Report.request = m_Request;
            m_Report.quitRequested = m_Request.QuitWhenDone;
            m_Report.Beat($"autorun started (request file moved to {Path.GetFileName(taken)})");
            ImportLog.Info($"Autorun: package '{m_Request.Package}', map '{m_Request.MapName}', overwrite={m_Request.Overwrite}, quitWhenDone={m_Request.QuitWhenDone}");

            MapFlowSystem.Report = m_Report;
            m_FlowCountAtStart = MapFlowSystem.FinishedCount;
            m_Report.BeginPhase("request");
            if (!MapFlowSystem.RequestCreate(m_Request.Package, m_Request.MapName, m_Request.Overwrite))
            {
                m_Report.Finish(false, "not started: " + MapFlowSystem.StatusLine);
                AfterFlowCore();
                return;
            }
            m_State = State.Running;
        }

        private void AfterFlow()
        {
            m_Report.Beat("flow ended: " + MapFlowSystem.StatusLine);
            AfterFlowCore();
        }

        private void AfterFlowCore()
        {
            var gm = GameManager.instance;
            if (gm.gameMode == GameMode.MainMenu && !gm.isGameLoading)
            {
                m_State = State.WaitMenu;
                m_Wait.Restart();
                return;
            }
            m_Report.Beat("returning to the main menu");
            // Queued behind the save on the game's SaveLoadGame task queue, so the save completes first.
            Colossal.TaskManager.instance.EnqueueTask(SaveHelpers.kSaveLoadTaskName, async () =>
            {
                try { await GameManager.instance.MainMenu(); }
                catch (Exception e) { ImportLog.Error("Autorun: MainMenu() failed", e); }
            }, 1);
            m_State = State.ReturnToMenu;
            m_Wait.Restart();
        }

        private static string SafeGameVersion()
        {
            try { return UnityEngine.Application.version; } catch (Exception) { return "unknown"; }
        }
    }
}
