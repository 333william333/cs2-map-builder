using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Colossal;
using Colossal.IO.AssetDatabase;
using Colossal.PSI.Common;
using Colossal.Serialization.Entities;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using CS2MapBuilder.Settings;
using Game;
using Game.Areas;
using Game.Assets;
using Game.City;
using Game.SceneFlow;
using Game.UI;
using Game.UI.Editor;
using Game.UI.Localization;
using Game.UI.Menu;
using Unity.Entities;

namespace CS2MapBuilder.Systems
{
    /// <summary>
    /// "Create playable map": main menu -> new map in the Map Editor -> full import -> settle -> name, description,
    /// theme, start tiles -> checklist (MapRequirementSystem) -> save through MapPanelSystem.SaveMap, the same
    /// method the editor's Save Map dialog calls. Also "Save as playable map" for the map open in the editor.
    /// Runs at UIUpdate so it lives through the main menu, the load and the editor. Idle cost: one null check.
    /// </summary>
    public sealed class MapFlowSystem : GameSystemBase
    {
        public const string Attribution = "© OpenStreetMap contributors, ESA WorldCover, Mapzen/AWS Terrain Tiles, Open-Meteo";
        private const string kNotificationId = "CS2MapBuilder.MapFlow";

        public static MapFlowSystem Instance { get; private set; }
        public static string StatusLine => Instance?.m_Status ?? string.Empty;
        public static bool IsBusy => Instance?.m_Job != null;

        /// <summary>Report for the autorun test hook (null for normal use).</summary>
        public static AutorunReport Report { get; set; }
        /// <summary>Incremented whenever a flow ends (success or not).</summary>
        public static int FinishedCount { get; private set; }

        /// <summary>Returns true if the flow started; otherwise <see cref="StatusLine"/> says why not.</summary>
        public static bool RequestCreate(string package, string mapName, bool overwrite)
        {
            try { return Instance != null && Instance.StartCreate(package, mapName, overwrite); }
            catch (Exception e) { ImportLog.Error("Create playable map failed to start", e); return false; }
        }

        public static void RequestSaveCurrent(string package, string mapName, bool overwrite)
        {
            try { Instance?.StartSaveCurrent(package, mapName, overwrite); }
            catch (Exception e) { ImportLog.Error("Save as playable map failed to start", e); }
        }

        public static void RequestCancel()
        {
            if (Instance?.m_Job == null) return;
            Instance.m_Cancel = true;
            ImportSystem.RequestCancel();
            ImportLog.Warn("Map flow: cancel requested.");
        }

        private Coroutine m_Job;
        private int m_WaitFrames;
        private bool m_Cancel;
        private bool m_NeedEditor;          // set once the editor is up: leaving it aborts the flow
        private string m_Status = string.Empty;
        private readonly Stopwatch m_Timer = new Stopwatch();
        private Stopwatch m_StepTimer = new Stopwatch();

        private string m_Package;
        private string m_MapName;
        private bool m_Overwrite;
        private Manifest m_Manifest;

        protected override void OnCreate()
        {
            base.OnCreate();
            Instance = this;
        }

        protected override void OnDestroy()
        {
            if (Instance == this) Instance = null;
            base.OnDestroy();
        }

        // ------------------------------------------------------------------ requests

        private bool StartCreate(string package, string mapName, bool overwrite)
        {
            if (!PrepareRequest("Create playable map", package, mapName, overwrite, needPackage: true)) return false;
            var gm = GameManager.instance;
            if (gm.gameMode == GameMode.Editor)
            {
                Refuse("You are in the Map Editor. 'Create playable map' starts a NEW map and would discard this one. " +
                       "Go to the main menu first, or use the editor tab's 'Save as playable map' for the map you have open.");
                return false;
            }
            if (gm.gameMode != GameMode.MainMenu)
            {
                Refuse("Return to the main menu first (Create playable map does not run from inside a city).");
                return false;
            }
            Begin(CreateJob());
            return true;
        }

        private void StartSaveCurrent(string package, string mapName, bool overwrite)
        {
            if (!PrepareRequest("Save as playable map", package, mapName, overwrite, needPackage: false)) return;
            if (GameManager.instance.gameMode != GameMode.Editor)
            {
                Refuse("'Save as playable map' works in the Map Editor only. From the main menu use 'Create playable map'.");
                return;
            }
            m_NeedEditor = true;
            Begin(SaveJob(true));
        }

        private bool PrepareRequest(string action, string package, string mapName, bool overwrite, bool needPackage)
        {
            var gm = GameManager.instance;
            if (m_Job != null) { Refuse(action + " ignored: a map is already being created."); return false; }
            if (ImportSystem.IsBusy) { Refuse(action + " ignored: an import or undo is running."); return false; }
            if (gm == null || gm.isGameLoading) { Refuse(action + " ignored: the game is loading."); return false; }

            m_Package = string.IsNullOrWhiteSpace(package) ? null : package;
            m_Manifest = null;
            if (m_Package != null)
            {
                var rep = new ValidationReport();
                try
                {
                    var pkg = PackageReader.Open(Path.Combine(ModPaths.Packages, m_Package), rep);
                    if (rep.Ok) m_Manifest = pkg.Manifest;
                }
                catch (PackageException e) { rep.Errors.Add(e.Message); }
                if (!rep.Ok)
                {
                    if (needPackage) { Refuse($"Package '{m_Package}' is invalid: {rep.Errors[0]}"); return false; }
                    ImportLog.Warn("Map flow: package manifest unreadable, description will be generic: " + rep.Errors[0]);
                }
            }
            else if (needPackage) { Refuse("Select a package first."); return false; }

            string name = MapCatalog.SanitizeName(string.IsNullOrWhiteSpace(mapName) ? MapCatalog.DefaultMapName(m_Package) : mapName);
            if (string.IsNullOrEmpty(name)) { Refuse("Type a map name first."); return false; }
            var existing = MapCatalog.Find(name);
            if (existing != null && !overwrite)
            {
                Refuse($"A map named '{name}' already exists. Choose another name or tick 'Overwrite existing map'.");
                return false;
            }
            if (existing != null && !existing.IsUserMap)
            {
                Refuse($"A map named '{name}' exists but is not in your own Maps folder (game or Paradox Mods map); it is never overwritten. Choose another name.");
                return false;
            }
            m_MapName = name;
            m_Overwrite = overwrite;
            m_Cancel = false;
            m_NeedEditor = false;
            ImportLog.BeginSession($"{action} '{name}' from package '{m_Package ?? "(none)"}'");
            ImportLog.Info($"Map flow: {action}, map name '{name}', package '{m_Package ?? "(none)"}', overwrite={overwrite} (existing map: {(existing != null ? "yes" : "no")}).");
            return true;
        }

        private void Begin(IEnumerator job)
        {
            m_Timer.Restart();
            m_WaitFrames = 0;
            m_Job = new Coroutine(job);
        }

        private void Refuse(string message)
        {
            m_Status = message;
            ImportLog.Warn("Map flow: " + message);
            Notify("CS2 Map Builder", message, ProgressState.Warning, null, remove: true);
        }

        // ------------------------------------------------------------------ frame loop

        protected override void OnUpdate()
        {
            if (m_Job == null) return;
            var gm = GameManager.instance;
            if (m_NeedEditor && (gm == null || gm.gameMode != GameMode.Editor || gm.isGameLoading))
            {
                Finish(false, "Stopped: the Map Editor was closed before the map was saved. Nothing was saved.");
                return;
            }
            if (m_Cancel && !m_SaveStarted)
            {
                Finish(false, "Cancelled by the user. Nothing was saved.");
                return;
            }
            if (m_WaitFrames > 0) { m_WaitFrames--; return; }
            var job = m_Job;
            try
            {
                m_Running = true;
                bool more = job.MoveNext(out object y);
                m_Running = false;
                if (!more)
                {
                    if (m_Job != null) Finish(false, "Stopped unexpectedly, see import.log.");
                    try { job.Dispose(); } catch (Exception) { }
                    return;
                }
                if (y is WaitFrames w) m_WaitFrames = w.Frames - 1;
            }
            catch (Exception e)
            {
                m_Running = false;
                try { job.Dispose(); } catch (Exception) { }
                ImportLog.Error("Map flow failed", e);
                if (m_NeedEditor && GameManager.instance?.gameMode == GameMode.Editor) OpenSaveDialogFallback("an internal error: " + e.Message);
                else Finish(false, "Failed: " + e.Message + " (see import.log)");
            }
        }

        private bool m_SaveStarted;
        private bool m_Running;

        private void Finish(bool ok, string message)
        {
            if (!m_Running) { try { m_Job?.Dispose(); } catch (Exception) { } }
            m_Job = null;
            m_NeedEditor = false;
            m_SaveStarted = false;
            m_Timer.Stop();
            m_Status = message;
            ImportLog.Info($"Map flow {(ok ? "SUCCEEDED" : "ENDED")} after {m_Timer.Elapsed.TotalSeconds:0.0} s: {message}");
            Report?.Finish(ok, message);
            FinishedCount++;
            Notify(ok ? "Playable map created" : "CS2 Map Builder", message, ok ? ProgressState.Complete : ProgressState.Failed, null, remove: true);
        }

        private void Progress(string step, int percent)
        {
            m_Status = $"{m_MapName}: {step}";
            Notify("Creating map " + m_MapName, step, ProgressState.Progressing, percent, remove: false);
        }

        private void Phase(string name)
        {
            if (m_StepTimer.IsRunning) ImportLog.Info($"Map flow: phase done in {m_StepTimer.Elapsed.TotalSeconds:0.0} s");
            m_StepTimer = Stopwatch.StartNew();
            ImportLog.Info("Map flow: " + name);
            Report?.BeginPhase(name);
        }

        // ------------------------------------------------------------------ create: main menu -> editor -> import

        private IEnumerator CreateJob()
        {
            var opt = MapBuilderSettings.Current;
            int readyFrames = opt?.EditorReadyFrames ?? 180;
            int loadTimeout = opt?.EditorLoadTimeoutSeconds ?? 300;

            Phase("starting the Map Editor with a new map (GameManager.Load(Editor, NewMap))");
            Progress("starting the Map Editor", 2);
            // Same preparation as MenuUISystem.StartEditor (the main menu's Editor > New map).
            var meta = World.GetOrCreateSystemManaged<MapMetadataSystem>();
            meta.mapName = string.Empty;
            meta.prefabReferences = null;
            var city = World.GetOrCreateSystemManaged<CityConfigurationSystem>();
            city.overrideLoadedOptions = false;
            city.overrideThemeName = null;
            bool? loadResult = null;
            Exception loadError = null;
            TaskManager.instance.EnqueueTask(SaveHelpers.kSaveLoadTaskName, async () =>
            {
                try { loadResult = await GameManager.instance.Load(GameMode.Editor, Purpose.NewMap); }
                catch (Exception e) { loadError = e; loadResult = false; }
            }, 1);

            var sw = Stopwatch.StartNew();
            while (true)
            {
                var gm = GameManager.instance;
                if (loadResult == false) throw new InvalidOperationException("the game refused to start the Map Editor" + (loadError != null ? ": " + loadError.Message : ""));
                if (gm.gameMode == GameMode.Editor && !gm.isGameLoading && loadResult != false) break;
                if (sw.Elapsed.TotalSeconds > loadTimeout) throw new TimeoutException($"the Map Editor did not open within {loadTimeout} s");
                yield return WaitFrames.NextFrame;
            }
            m_NeedEditor = true;
            ImportLog.Info($"Map flow: editor ready after {sw.Elapsed.TotalSeconds:0.0} s; waiting {readyFrames} frames before importing.");
            Progress("editor open, preparing", 8);
            yield return new WaitFrames(readyFrames);

            Phase("full import of package " + m_Package);
            int before = ImportSystem.FinishedCount;
            if (!ImportSystem.RequestImportAllSteps(m_Package))
                throw new InvalidOperationException("the import did not start: " + ImportSystem.StatusLine);
            while (ImportSystem.FinishedCount == before)
            {
                int pct = 10 + (int)(ImportSystem.Progress * 60f);
                Progress("importing: " + ImportSystem.StatusLine, Math.Min(70, pct));
                yield return new WaitFrames(15);
            }
            if (ImportSystem.LastAborted)
            {
                if (Report != null)
                {
                    Report.importAborted = true;
                    Report.importResult = ImportSystem.LastResult;
                    Report.importSteps = new List<string>(ImportSystem.LastStepLines);
                }
                Finish(false, "The import was stopped (" + ImportSystem.LastResult + "). The map was not saved. Details in import.log.");
                yield break;
            }
            ImportLog.Info("Map flow: import finished: " + ImportSystem.LastResult);
            if (Report != null)
            {
                Report.importAborted = ImportSystem.LastAborted;
                Report.importResult = ImportSystem.LastResult;
                Report.importSteps = new List<string>(ImportSystem.LastStepLines);
                Report.Write();
            }
            yield return SaveJob(false);
        }

        // ------------------------------------------------------------------ metadata, checklist, save

        private IEnumerator SaveJob(bool standalone)
        {
            var opt = MapBuilderSettings.Current;
            int settleMax = opt?.MapSettleFrames ?? 3600;
            int saveTimeout = opt?.SaveTimeoutSeconds ?? 180;
            var manifest = m_Manifest ?? ImportSystem.LastManifest;

            var mapPanel = World.GetExistingSystemManaged<MapPanelSystem>();
            var requirements = World.GetExistingSystemManaged<MapRequirementSystem>();
            var city = World.GetOrCreateSystemManaged<CityConfigurationSystem>();
            var tiles = World.GetOrCreateSystemManaged<MapTileSystem>();
            if (mapPanel == null) throw new InvalidOperationException("MapPanelSystem not found (is this the Map Editor?)");

            // Theme
            Phase("metadata: theme, start tiles, name, description");
            Progress("setting name, description, theme and start tiles", 72);
            if (city.defaultTheme == Entity.Null) ImportLog.Warn("Map flow: no default theme set (the Climate step sets it from the package).");
            else ImportLog.Info("Map flow: theme entity " + city.defaultTheme.Index + " (" + (World.GetOrCreateSystemManaged<Game.Prefabs.PrefabSystem>().GetPrefabName(city.defaultTheme)) + ")");

            // Start tiles: repair if the import step did not leave any.
            if (tiles.GetStartTiles().Length == 0 && ImportSystem.Instance != null)
            {
                int col = manifest?.StartTile?.Col ?? 11, row = manifest?.StartTile?.Row ?? 11;
                var notes = new List<string>();
                int added = ImportSystem.Instance.ApplyStartTiles(col, row, true, notes);
                foreach (var n in notes) ImportLog.Info("Map flow: " + n);
                ImportLog.Info($"Map flow: start area was empty, {added} tiles added around col {col}, row {row}.");
            }
            else ImportLog.Info($"Map flow: start area has {tiles.GetStartTiles().Length} tiles.");

            // Name and description (private LocalizationFields of MapPanelSystem, the editor's Map settings fields).
            string description = BuildDescription(manifest);
            bool nameSet = SetLocalizationField(mapPanel, "m_MapNameLocalization", m_MapName);
            bool descSet = SetLocalizationField(mapPanel, "m_MapDescriptionLocalization", description);
            ImportLog.Info($"Map flow: name field set={nameSet}, description field set={descSet}. Description: {description}");
            yield return WaitFrames.NextFrame;

            // Checklist: wait (bounded) for terrain, water and the requirement system to settle.
            Phase($"checklist (MapRequirementSystem), up to {settleMax} frames");
            string failing = null;
            bool playable = false;
            int frames = 0;
            string lastLogged = null;
            while (true)
            {
                failing = FailingRequirements(requirements, mapPanel);
                playable = failing.Length == 0;
                if (failing != lastLogged)
                {
                    ImportLog.Info($"Map flow: checklist after {frames} frames: {(playable ? "all required items OK" : "missing " + failing)}");
                    lastLogged = failing;
                }
                if ((playable && frames >= 120) || frames >= settleMax) break;
                Progress(playable ? "checklist complete, settling" : "waiting for the checklist: " + failing, 75 + Math.Min(10, frames * 10 / Math.Max(1, settleMax)));
                frames += 30;
                yield return new WaitFrames(30);
            }
            if (!playable) ImportLog.Warn("Map flow: checklist still failing after the settle time: " + failing);
            if (Report != null)
            {
                Report.checklist.Clear();
                foreach (var item in new[] { "starting area", "water in the starting area", "road outside connection", "map name" })
                    Report.checklist.Add(new AutorunReport.Requirement { requirement = item, passed = !failing.Contains(item) });
                Report.checklist.Add(new AutorunReport.Requirement { requirement = "MapPanelSystem.MapIsPlayable()", passed = SafeIsPlayable(mapPanel) });
                Report.playable = playable;
                Report.Beat($"checklist after {frames} frames: {(playable ? "all OK" : "missing " + failing)}");
            }
            if (!nameSet)
            {
                OpenSaveDialogFallback("the map name could not be filled in automatically");
                yield break;
            }

            // Save
            Phase("saving through MapPanelSystem.SaveMap");
            Progress("saving the map", 90);
            World.GetOrCreateSystemManaged<MapMetadataSystem>().Update(); // as MapPanelSystem.OnSaveMap does
            MapMetadata savedMeta = null;
            bool saveDone = false;
            Exception saveError = null;
            var existing = MapCatalog.Find(m_MapName);
            if (existing != null && !m_Overwrite)
            {
                Finish(false, $"A map named '{m_MapName}' appeared while working; nothing overwritten. Save from the editor under another name.");
                yield break;
            }
            Func<Task> save;
            if (existing != null)
            {
                if (!existing.IsUserMap) { Finish(false, $"'{m_MapName}' is not your own map; it is never overwritten."); yield break; }
                MapMetadata asset = AssetDatabase.global.GetAsset<MapMetadata>(existing.Guid);
                SourceMeta sm = asset.GetMeta();
                var db = asset.database as ILocalAssetDatabase;
                if (db == null) { Finish(false, $"'{m_MapName}' is in a read-only database; it is never overwritten."); yield break; }
                var path = AssetDataPath.Create(sm.subPath, sm.fileName, EscapeStrategy.None);
                MapInfo target = asset.target;
                string displayName = sm.displayName;
                ImportLog.Info($"Map flow: overwriting user map '{displayName}' ({existing.Guid}) as requested.");
                save = () => mapPanel.SaveMap(displayName, existing.Guid, target, db, path, true, m => savedMeta = m);
            }
            else
            {
                var path = SaveHelpers.GetAssetDataPath<MapMetadata>(AssetDatabase.user, m_MapName);
                save = () => mapPanel.SaveMap(m_MapName, Colossal.Hash128.Empty, null, AssetDatabase.user, path, true, m => savedMeta = m);
            }
            string expectedFile = Path.Combine(MapCatalog.UserMapsFolder, m_MapName + ".cok");
            ImportLog.Info($"Map flow: save target {(existing != null ? "(overwrite) " : "")}{expectedFile}");
            if (Report != null)
            {
                Report.saveAssetDataPath = existing != null ? "overwrite of " + existing.Guid : SaveHelpers.GetAssetDataPath<MapMetadata>(AssetDatabase.user, m_MapName).ToString();
                Report.saveExpectedFile = expectedFile;
                Report.Beat("saving to " + expectedFile);
            }
            m_SaveStarted = true;
            TaskManager.instance.EnqueueTask(SaveHelpers.kSaveLoadTaskName, async () =>
            {
                try { await save(); }
                catch (Exception e) { saveError = e; }
                finally { saveDone = true; }
            }, 1);

            var sw = Stopwatch.StartNew();
            while (!saveDone && sw.Elapsed.TotalSeconds < saveTimeout) yield return new WaitFrames(10);
            if (saveError != null)
            {
                ImportLog.Error("Map flow: SaveMap failed", saveError);
                m_SaveStarted = false;
                OpenSaveDialogFallback("saving failed (" + saveError.Message + ")");
                yield break;
            }
            if (!saveDone)
            {
                m_SaveStarted = false;
                Finish(false, $"Saving did not finish within {saveTimeout} s. Check Maps in the editor's Load Map list before saving again.");
                yield break;
            }
            yield return new WaitFrames(30); // callback runs on the main thread after the save
            ImportLog.Info($"Map flow: save finished in {sw.Elapsed.TotalSeconds:0.0} s, callback {(savedMeta != null ? "received" : "not yet received")}.");

            var check = MapCatalog.Find(m_MapName);
            bool fileExists = File.Exists(expectedFile);
            var matches = new List<string>();
            try
            {
                if (Directory.Exists(MapCatalog.UserMapsFolder))
                    foreach (var f in Directory.GetFiles(MapCatalog.UserMapsFolder, m_MapName + "*")) matches.Add(f);
            }
            catch (Exception) { }
            ImportLog.Info($"Map flow: file {(fileExists ? "exists" : "NOT found")}: {expectedFile}; listing: {(check == null ? "not found" : $"'{check.DisplayName}' id {check.Guid} user={check.IsUserMap} playable={check.IsPlayable} listedUnderNewGame={check.ListedUnderNewGame}")}");
            if (Report != null)
            {
                Report.saveFileExists = fileExists;
                Report.saveFolderMatches = matches;
                Report.mapListingFound = check != null;
                Report.mapListingName = check?.DisplayName;
                Report.mapListingId = check?.Guid.ToString();
                Report.mapListingIsUserMap = check?.IsUserMap;
                Report.mapListingIsPlayable = check?.IsPlayable;
                Report.listedUnderNewGame = check?.ListedUnderNewGame;
                Report.Write();
            }
            if (check == null)
            {
                OpenSaveDialogFallback("the saved map was not found in the map list afterwards");
                yield break;
            }
            if (playable && check.ListedUnderNewGame)
                Finish(true, $"Map '{m_MapName}' is saved and playable. Find it under New Game (and in the editor's Load Map list).");
            else
                Finish(false, $"Map '{m_MapName}' is saved but the checklist is not complete (missing: {(failing.Length > 0 ? failing : "the saved map is not flagged playable")}). New Game only lists playable custom maps. " +
                              "Fix that in the editor (Map settings > Checklist), then save again with the editor's Save Map and pick the same map to overwrite.");
        }

        /// <summary>Same rules as MapPanelSystem.MapIsPlayable, itemised for the log. Empty string = playable.</summary>
        private static string FailingRequirements(MapRequirementSystem req, MapPanelSystem panel)
        {
            var missing = new List<string>();
            if (req == null) return "requirement system not found";
            if (!req.hasStartingArea) missing.Add("starting area");
            if (!(req.StartingAreaHasResource(MapFeature.SurfaceWater) || req.StartingAreaHasResource(MapFeature.GroundWater))) missing.Add("water in the starting area");
            if (!req.roadConnection) missing.Add("road outside connection");
            if (!IsNameFieldValid(panel)) missing.Add("map name");
            if (missing.Count == 0 && !panel.MapIsPlayable()) missing.Add("MapIsPlayable() is false for an unknown reason");
            return string.Join(", ", missing);
        }

        private static bool SafeIsPlayable(MapPanelSystem panel)
        {
            try { return panel.MapIsPlayable(); } catch (Exception) { return false; }
        }

        private static bool IsNameFieldValid(MapPanelSystem panel)
        {
            try
            {
                var f = typeof(MapPanelSystem).GetField("m_MapNameLocalization", BindingFlags.Instance | BindingFlags.NonPublic);
                return f?.GetValue(panel) is LocalizationField field && field.IsValid();
            }
            catch (Exception) { return false; }
        }

        private static bool SetLocalizationField(MapPanelSystem panel, string fieldName, string text)
        {
            try
            {
                var f = typeof(MapPanelSystem).GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic);
                if (!(f?.GetValue(panel) is LocalizationField field))
                {
                    ImportLog.Warn($"Map flow: MapPanelSystem.{fieldName} not found (game version changed?).");
                    return false;
                }
                var lm = GameManager.instance.localizationManager;
                var entries = new List<LocalizationField.LocalizationFieldEntry>();
                foreach (var id in new[] { lm.fallbackLocaleId, lm.activeLocaleId }.Where(x => !string.IsNullOrEmpty(x)).Distinct())
                    entries.Add(new LocalizationField.LocalizationFieldEntry(id, text));
                field.Initialize(entries);
                field.SetPropertiesChanged();
                return field.IsValid();
            }
            catch (Exception e)
            {
                ImportLog.Error("Map flow: could not set " + fieldName, e);
                return false;
            }
        }

        public static string BuildDescription(Manifest m)
        {
            if (m == null) return "Made with CS2 Map Builder. Data: " + Attribution + ".";
            var s = m.Selection;
            string place = string.IsNullOrWhiteSpace(m.Name) ? "A real place" : m.Name.Trim();
            string coords = s == null ? "" :
                $" at {Math.Abs(s.CenterLat):0.0000}°{(s.CenterLat >= 0 ? "N" : "S")}, {Math.Abs(s.CenterLon):0.0000}°{(s.CenterLon >= 0 ? "E" : "W")}";
            string area = s == null || s.SizeMeters <= 0 ? "" : $" Real area {s.SizeMeters / 1000.0:0.#} km across";
            string scale = m.Scale == null ? "" : $", horizontal scale {m.Scale.Horizontal:0.##}x, vertical scale {m.Scale.Vertical:0.##}x";
            string rot = s != null && Math.Abs(s.RotationDeg) > 0.01 ? $", rotated {s.RotationDeg:0}°" : "";
            return $"{place}{coords}.{area}{scale}{rot}. Made with CS2 Map Builder. Data: {Attribution}.";
        }

        // ------------------------------------------------------------------ fallback

        /// <summary>
        /// Opens the editor's own Save Map dialog (MapPanelSystem.ShowSaveMapPanel) with whatever could be filled in,
        /// and tells the user exactly what to click.
        /// </summary>
        private void OpenSaveDialogFallback(string reason)
        {
            string msg = $"Could not finish automatically: {reason}. The editor's Save Map dialog is open: type '{m_MapName}' as the file name and click Save Map. " +
                         "If the checklist warns, open Map settings, fill in the map name and fix the listed items first.";
            try
            {
                var panel = World.GetExistingSystemManaged<MapPanelSystem>();
                var ui = World.GetExistingSystemManaged<EditorPanelUISystem>();
                if (panel != null && ui != null)
                {
                    ui.activePanel = panel;
                    panel.ShowSaveMapPanel();
                }
                else msg = $"Could not finish automatically: {reason}. Open the editor's menu, choose Save Map, type '{m_MapName}' and click Save Map.";
            }
            catch (Exception e)
            {
                ImportLog.Error("Map flow: could not open the Save Map dialog", e);
                msg = $"Could not finish automatically: {reason}. Open the editor's menu, choose Save Map, type '{m_MapName}' and click Save Map.";
            }
            Finish(false, msg);
        }

        // ------------------------------------------------------------------ notifications

        private void Notify(string title, string text, ProgressState state, int? progress, bool remove)
        {
            try
            {
                var n = World.GetExistingSystemManaged<NotificationUISystem>();
                if (n == null) return;
                if (remove)
                    n.RemoveNotification(kNotificationId, 15f, LocalizedString.Value(title), LocalizedString.Value(text), null, state, progress);
                else
                    n.AddOrUpdateNotification(kNotificationId, LocalizedString.Value(title), LocalizedString.Value(text), null, state, progress);
            }
            catch (Exception) { }
        }
    }
}
