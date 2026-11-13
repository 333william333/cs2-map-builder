using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using CS2MapBuilder.Settings;
using Game;
using Game.Areas;
using Game.City;
using Game.Common;
using Game.Prefabs;
using Game.SceneFlow;
using Game.Simulation;
using Game.Tools;
using Game.UI;
using Unity.Collections;
using Unity.Entities;

namespace CS2MapBuilder.Systems
{
    /// <summary>Yield instruction for import step iterators: wait a number of frames before continuing.</summary>
    public sealed class WaitFrames
    {
        public readonly int Frames;
        public WaitFrames(int frames) { Frames = Math.Max(1, frames); }
        public static readonly WaitFrames NextFrame = new WaitFrames(1);
    }

    /// <summary>
    /// The importer: a frame-budgeted state machine that runs at ToolUpdate (MOD_SPIKE 10). Each step is a C#
    /// iterator; the system advances it until the frame budget is used or the step yields a <see cref="WaitFrames"/>.
    /// Every MoveNext is wrapped in try/catch, so a failing step is reported and the next step still runs.
    /// Idle cost: one null check per frame. Nothing runs until the user presses Import or Undo.
    /// </summary>
    public sealed partial class ImportSystem : GameSystemBase
    {
        // ------------------------------------------------------------------ static facade for UI

        public static ImportSystem Instance { get; private set; }
        public static string StatusLine => Instance?.m_Status ?? "Not initialised";
        public static bool IsBusy => Instance != null && Instance.m_Mode != Mode.Idle;
        public static float Progress => Instance?.m_Progress ?? 0f;
        public static bool CanUndo => Instance?.m_LastRecord != null && Instance.m_LastRecord.Total > 0;

        public static void RequestImport(string package) { try { Instance?.StartImport(package, false); } catch (Exception e) { ImportLog.Error("Import request failed", e); } }

        /// <summary>Starts an import with every step enabled (used by "Create playable map"). Returns false if it did not start.</summary>
        public static bool RequestImportAllSteps(string package)
        {
            try { return Instance != null && Instance.StartImport(package, true); }
            catch (Exception e) { ImportLog.Error("Import request failed", e); return false; }
        }

        /// <summary>Incremented each time an import finishes (completed, aborted or cancelled).</summary>
        public static int FinishedCount { get; private set; }
        /// <summary>True when the last finished import was aborted (invalid package, missing prefabs, cancel).</summary>
        public static bool LastAborted { get; private set; }
        /// <summary>Result text of the last finished import.</summary>
        public static string LastResult { get; private set; } = string.Empty;
        /// <summary>Manifest of the last package that passed validation (for map metadata).</summary>
        public static Manifest LastManifest { get; private set; }
        public static void RequestCancel() { try { Instance?.Cancel(); } catch (Exception e) { ImportLog.Error("Cancel failed", e); } }
        public static void RequestUndo() { try { Instance?.StartUndo(); } catch (Exception e) { ImportLog.Error("Undo request failed", e); } }

        // ------------------------------------------------------------------ state

        private enum Mode { Idle, Importing, Undoing }

        private sealed class Step
        {
            public string Name;
            public bool Enabled;
            public Func<StepReport, IEnumerator> Body;
            public StepReport Report;
        }

        /// <summary>Settings snapshot taken when an import starts, so changes mid-import have no effect.</summary>
        private sealed class Options
        {
            public bool Terrain, WorldMap, Climate, Water, Resources, Networks, Names, Trees, StartTiles;
            public bool FlipRows, LinkExistingNodes, ReplaceStartTiles, SetSeaLevel, SkipTreesBelowSea;
            public int NetBatch, TreeBatch, MaxTrees, WaitFrames, SettleTimeout, UndoBatch, BudgetMs, WaterRamp;

            public static Options From(MapBuilderSettings s)
            {
                s = s ?? new MapBuilderSettings(Mod.Instance); // defaults; only if the options page failed to load
                return new Options
                {
                    Terrain = s.StepTerrain, WorldMap = s.StepWorldMap, Climate = s.StepClimate, Water = s.StepWater,
                    Resources = s.StepResources, Networks = s.StepNetworks, Names = s.StepNames, Trees = s.StepTrees,
                    StartTiles = s.StepStartTiles, FlipRows = s.FlipHeightmapRows, LinkExistingNodes = s.LinkExistingNodes,
                    ReplaceStartTiles = s.ReplaceStartTiles, SetSeaLevel = s.SetSeaLevel, SkipTreesBelowSea = s.SkipTreesBelowSeaLevel,
                    NetBatch = Math.Max(1, s.NetBatchSize), TreeBatch = Math.Max(100, s.TreeBatchSize), MaxTrees = Math.Max(0, s.MaxTrees),
                    WaitFrames = Math.Max(1, s.FramesBetweenSteps), SettleTimeout = Math.Max(30, s.SettleTimeoutFrames),
                    UndoBatch = Math.Max(100, s.UndoBatchSize), BudgetMs = Math.Max(1, s.FrameBudgetMs), WaterRamp = Math.Max(0, s.WaterRampFrames),
                };
            }
        }

        /// <summary>What the last import created, for "undo last import". Entities are only valid in this session.</summary>
        private sealed class ImportRecord
        {
            public string Package;
            public readonly List<Entity> Edges = new List<Entity>();
            public readonly List<Entity> Nodes = new List<Entity>();
            public readonly List<Entity> Trees = new List<Entity>();
            public readonly List<Entity> WaterSources = new List<Entity>();
            public int Total => Edges.Count + Nodes.Count + Trees.Count + WaterSources.Count;
        }

        private Mode m_Mode = Mode.Idle;
        private string m_Status = "Idle";
        private float m_Progress;
        private bool m_CancelRequested;
        private int m_WaitFrames;
        private readonly List<Step> m_Steps = new List<Step>();
        private int m_StepIndex;
        private Coroutine m_Current;
        private Coroutine m_UndoJob;
        private bool m_Aborted;
        private string m_AbortReason;
        private readonly Stopwatch m_TotalTimer = new Stopwatch();

        private Options m_Opt;
        private ImportRecord m_Record;
        private ImportRecord m_LastRecord;
        private HashSet<Entity> m_StartEdges, m_StartNodes, m_StartTrees;

        // package data loaded by Validate
        private string m_PackageName;
        private PackageReader m_Pkg;
        private PackageRoads m_Roads;
        private PackageTrees m_Trees;
        private WaterJson m_Water;
        private ClimateJson m_Climate;
        private Dictionary<string, Entity> m_NetPrefabByKey;      // manifest netPrefabs key -> prefab entity
        private Entity[] m_TreePrefabBySpecies;                    // index = manifest treeSpecies index
        private float m_AppliedSeaLevel = float.NaN;
        private readonly Dictionary<int, Entity> m_PkgNodeEntity = new Dictionary<int, Entity>();

        // ------------------------------------------------------------------ game systems and queries

        private PrefabSystem m_PrefabSystem;
        private TerrainSystem m_TerrainSystem;
        private WaterSystem m_WaterSystem;
        private ClimateSystem m_ClimateSystem;
        private PlanetarySystem m_PlanetarySystem;
        private CityConfigurationSystem m_CityConfigurationSystem;
        private NaturalResourceSystem m_NaturalResourceSystem;
        private GroundWaterSystem m_GroundWaterSystem;
        private NameSystem m_NameSystem;
        private MapTileSystem m_MapTileSystem;

        private EntityQuery m_DefinitionQuery;
        private EntityQuery m_EdgeQuery;
        private EntityQuery m_NodeQuery;
        private EntityQuery m_TreeQuery;
        private EntityQuery m_PrefabQuery;
        private EntityQuery m_MapFeatureQuery;
        private EntityQuery m_MapTileQuery;

        private EntityArchetype m_NetDefinitionArchetype;
        private EntityArchetype m_ObjectDefinitionArchetype;
        private EntityArchetype m_WaterSourceArchetype;

        protected override void OnCreate()
        {
            base.OnCreate();
            Instance = this;
            m_PrefabSystem = World.GetOrCreateSystemManaged<PrefabSystem>();
            m_TerrainSystem = World.GetOrCreateSystemManaged<TerrainSystem>();
            m_WaterSystem = World.GetOrCreateSystemManaged<WaterSystem>();
            m_ClimateSystem = World.GetOrCreateSystemManaged<ClimateSystem>();
            m_PlanetarySystem = World.GetOrCreateSystemManaged<PlanetarySystem>();
            m_CityConfigurationSystem = World.GetOrCreateSystemManaged<CityConfigurationSystem>();
            m_NaturalResourceSystem = World.GetOrCreateSystemManaged<NaturalResourceSystem>();
            m_GroundWaterSystem = World.GetOrCreateSystemManaged<GroundWaterSystem>();
            m_NameSystem = World.GetOrCreateSystemManaged<NameSystem>();
            m_MapTileSystem = World.GetOrCreateSystemManaged<MapTileSystem>();

            m_DefinitionQuery = GetEntityQuery(ComponentType.ReadOnly<CreationDefinition>());
            m_EdgeQuery = GetEntityQuery(new EntityQueryDesc
            {
                All = new[] { ComponentType.ReadOnly<Game.Net.Edge>() },
                None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() },
            });
            m_NodeQuery = GetEntityQuery(new EntityQueryDesc
            {
                All = new[] { ComponentType.ReadOnly<Game.Net.Node>() },
                None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() },
            });
            m_TreeQuery = GetEntityQuery(new EntityQueryDesc
            {
                All = new[] { ComponentType.ReadOnly<Game.Objects.Tree>() },
                None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() },
            });
            m_PrefabQuery = GetEntityQuery(ComponentType.ReadOnly<PrefabData>());
            m_MapFeatureQuery = GetEntityQuery(ComponentType.ReadOnly<MapFeatureElement>());
            m_MapTileQuery = GetEntityQuery(new EntityQueryDesc
            {
                All = new[] { ComponentType.ReadOnly<MapTile>(), ComponentType.ReadOnly<Area>(), ComponentType.ReadOnly<Game.Areas.Node>() },
                None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() },
            });

            // One archetype per definition kind: every component set in one CreateEntity call (MOD_SPIKE 3.2).
            m_NetDefinitionArchetype = EntityManager.CreateArchetype(
                ComponentType.ReadWrite<CreationDefinition>(), ComponentType.ReadWrite<NetCourse>(), ComponentType.ReadWrite<Updated>());
            m_ObjectDefinitionArchetype = EntityManager.CreateArchetype(
                ComponentType.ReadWrite<CreationDefinition>(), ComponentType.ReadWrite<ObjectDefinition>(), ComponentType.ReadWrite<Updated>());
            m_WaterSourceArchetype = EntityManager.CreateArchetype(
                ComponentType.ReadWrite<Game.Simulation.WaterSourceData>(), ComponentType.ReadWrite<Game.Objects.Transform>(),
                ComponentType.ReadWrite<Created>(), ComponentType.ReadWrite<Updated>());
        }

        protected override void OnDestroy()
        {
            if (Instance == this) Instance = null;
            base.OnDestroy();
        }

        protected override void OnGameLoadingComplete(Colossal.Serialization.Entities.Purpose purpose, GameMode mode)
        {
            base.OnGameLoadingComplete(purpose, mode);
            // A new map invalidates every recorded entity and any running job.
            if (m_Mode != Mode.Idle) ImportLog.Warn("A map was loaded while an import/undo was running; it was stopped.");
            StopAll("stopped: map loaded");
            m_LastRecord = null;
            m_Status = "Idle";
        }

        // ------------------------------------------------------------------ requests

        private bool CheckContext(string action)
        {
            if (m_Mode != Mode.Idle)
            {
                ImportLog.Warn(action + " ignored: an import or undo is already running.");
                return false;
            }
            var gm = GameManager.instance;
            if (gm == null || gm.isGameLoading)
            {
                ImportLog.Warn(action + " ignored: the game is loading.");
                return false;
            }
            bool editor = gm.gameMode == GameMode.Editor;
            if (!editor && !(MapBuilderSettings.Current?.AllowOutsideEditor ?? false))
            {
                m_Status = action + " refused: open the Map Editor (or enable 'Allow import outside the Map Editor').";
                ImportLog.Warn(m_Status + " Current mode: " + gm.gameMode);
                return false;
            }
            return true;
        }

        private bool StartImport(string package, bool allSteps)
        {
            if (!CheckContext("Import")) return false;
            if (string.IsNullOrWhiteSpace(package))
            {
                m_Status = "Select a package first.";
                ImportLog.Warn("Import refused: no package selected.");
                return false;
            }

            m_Opt = Options.From(MapBuilderSettings.Current);
            if (allSteps)
            {
                m_Opt.Terrain = m_Opt.WorldMap = m_Opt.Climate = m_Opt.Water = m_Opt.Resources = true;
                m_Opt.Networks = m_Opt.Names = m_Opt.Trees = m_Opt.StartTiles = true;
            }
            m_PackageName = package;
            m_Pkg = null; m_Roads = null; m_Trees = null; m_Water = null; m_Climate = null;
            m_NetPrefabByKey = null; m_TreePrefabBySpecies = null; m_AppliedSeaLevel = float.NaN;
            m_PkgNodeEntity.Clear();
            m_Record = new ImportRecord { Package = package };
            m_Aborted = false; m_AbortReason = null; m_CancelRequested = false;

            m_Steps.Clear();
            AddStep("Validate", true, ValidateStep);
            AddStep("Terrain", m_Opt.Terrain || m_Opt.WorldMap, TerrainStep);
            AddStep("Climate", m_Opt.Climate, ClimateStep);
            AddStep("Water", m_Opt.Water, WaterStep);
            AddStep("Resources", m_Opt.Resources, ResourcesStep);
            AddStep("Networks", m_Opt.Networks, NetworksStep);
            AddStep("Names", m_Opt.Names, NamesStep);
            AddStep("Trees", m_Opt.Trees, TreesStep);
            AddStep("StartTiles", m_Opt.StartTiles, StartTilesStep);
            AddStep("Finalize", true, FinalizeStep);

            ImportLog.BeginSession("import " + package);
            ImportLog.Info($"Import of '{package}' started. Mod {typeof(ImportSystem).Assembly.GetName().Version}, game mode {GameManager.instance?.gameMode}. " +
                           $"Options: flipRows={m_Opt.FlipRows} netBatch={m_Opt.NetBatch} treeBatch={m_Opt.TreeBatch} maxTrees={m_Opt.MaxTrees} " +
                           $"wait={m_Opt.WaitFrames} settleTimeout={m_Opt.SettleTimeout} setSea={m_Opt.SetSeaLevel} linkNodes={m_Opt.LinkExistingNodes} budget={m_Opt.BudgetMs}ms");

            // Snapshot what exists, so the record holds only what this import created.
            m_StartEdges = Snapshot(m_EdgeQuery);
            m_StartNodes = Snapshot(m_NodeQuery);
            m_StartTrees = Snapshot(m_TreeQuery);

            m_StepIndex = -1;
            m_Current = null;
            m_TotalTimer.Restart();
            m_Mode = Mode.Importing;
            m_Status = "Importing " + package;
            AdvanceStep();
            return true;
        }

        private void AddStep(string name, bool enabled, Func<StepReport, IEnumerator> body)
        {
            m_Steps.Add(new Step { Name = name, Enabled = enabled, Body = body, Report = new StepReport { Name = name } });
        }

        private void Cancel()
        {
            if (m_Mode == Mode.Idle) return;
            m_CancelRequested = true;
            ImportLog.Warn("Cancel requested; stopping after the current batch.");
        }

        private void StartUndo()
        {
            if (!CheckContext("Undo")) return;
            if (m_LastRecord == null || m_LastRecord.Total == 0)
            {
                m_Status = "Nothing to undo (only imports made in this session can be undone).";
                ImportLog.Warn(m_Status);
                return;
            }
            m_Opt = Options.From(MapBuilderSettings.Current);
            m_CancelRequested = false;
            ImportLog.BeginSession("undo " + m_LastRecord.Package);
            m_UndoJob = new Coroutine(UndoJob(m_LastRecord));
            m_TotalTimer.Restart();
            m_Mode = Mode.Undoing;
        }

        private void StopAll(string why)
        {
            if (m_Mode == Mode.Importing)
            {
                LastAborted = true;
                LastResult = why;
                FinishedCount++;
            }
            try { m_Current?.Dispose(); } catch (Exception) { }
            try { m_UndoJob?.Dispose(); } catch (Exception) { }
            m_Current = null;
            m_UndoJob = null;
            m_Steps.Clear();
            m_Mode = Mode.Idle;
            m_Status = why;
        }

        // ------------------------------------------------------------------ frame loop

        protected override void OnUpdate()
        {
            if (m_Mode == Mode.Idle) return;
            if (m_WaitFrames > 0) { m_WaitFrames--; return; }
            var budget = Stopwatch.StartNew();
            try
            {
                if (m_Mode == Mode.Undoing) RunUndo(budget);
                else RunImport(budget);
            }
            catch (Exception e)
            {
                // Should never happen (steps are guarded individually); keep the game alive regardless.
                ImportLog.Error("Importer loop failed; stopping", e);
                StopAll("Stopped after an internal error, see import.log");
            }
        }

        private void RunImport(Stopwatch budget)
        {
            while (m_Mode == Mode.Importing && budget.ElapsedMilliseconds < m_Opt.BudgetMs)
            {
                var step = m_Steps[m_StepIndex];
                if (m_CancelRequested && step.Name != "Finalize")
                {
                    FinishStep(step, "cancelled");
                    m_Aborted = true;
                    m_AbortReason = "cancelled by user";
                    AdvanceStep();
                    continue;
                }

                object yielded;
                bool more;
                step.Report.Timer.Start();
                try
                {
                    more = m_Current.MoveNext(out yielded);
                }
                catch (Exception e)
                {
                    step.Report.Timer.Stop();
                    step.Report.Fail(e.GetType().Name + ": " + e.Message);
                    ImportLog.Error($"Step {step.Name} failed; continuing with the next step", e);
                    FinishStep(step, "failed");
                    AdvanceStep();
                    continue;
                }
                step.Report.Timer.Stop();

                if (!more)
                {
                    string status = step.Report.Status != "pending" ? step.Report.Status
                        : step.Report.Failed.Count > 0 ? (step.Report.Created > 0 ? "partial" : "failed") : "ok";
                    FinishStep(step, status);
                    AdvanceStep();
                    continue;
                }
                if (yielded is WaitFrames w)
                {
                    m_WaitFrames = w.Frames - 1;
                    return;
                }
            }
        }

        private void FinishStep(Step step, string status)
        {
            try { m_Current?.Dispose(); } catch (Exception) { }
            m_Current = null;
            step.Report.Status = status;
            ImportLog.Info("Step " + step.Report.Line());
            foreach (var n in step.Report.Notes) ImportLog.Info("  " + step.Name + ": " + n);
        }

        private void AdvanceStep()
        {
            while (true)
            {
                m_StepIndex++;
                if (m_StepIndex >= m_Steps.Count)
                {
                    m_Mode = Mode.Idle;
                    m_Current = null;
                    LastAborted = m_Aborted;
                    LastResult = m_Status;
                    FinishedCount++;
                    return;
                }
                var step = m_Steps[m_StepIndex];
                if (step.Name != "Finalize" && (!step.Enabled || m_Aborted))
                {
                    step.Report.Status = m_Aborted ? (m_CancelRequested ? "cancelled" : "skipped") : "skipped";
                    if (m_Aborted) step.Report.Notes.Add("not run: " + m_AbortReason);
                    else step.Report.Notes.Add("disabled in settings");
                    ImportLog.Info("Step " + step.Report.Line());
                    continue;
                }
                m_Progress = 0f;
                m_Status = $"{m_PackageName}: step {m_StepIndex + 1}/{m_Steps.Count} {step.Name}";
                ImportLog.Info($"Step {step.Name} started.");
                m_Current = new Coroutine(step.Body(step.Report));
                return;
            }
        }

        /// <summary>Aborts all following steps (the current step should then return).</summary>
        private void Abort(string reason)
        {
            m_Aborted = true;
            m_AbortReason = reason;
            ImportLog.Error("Import aborted: " + reason);
        }

        private void SetProgress(StepReport r, float fraction, string detail)
        {
            m_Progress = fraction;
            m_Status = $"{m_PackageName}: step {m_StepIndex + 1}/{m_Steps.Count} {r.Name} {(int)(fraction * 100)}% {detail}";
        }

        // ------------------------------------------------------------------ shared helpers

        private HashSet<Entity> Snapshot(EntityQuery q)
        {
            var set = new HashSet<Entity>();
            using (var arr = q.ToEntityArray(Allocator.TempJob))
                foreach (var e in arr) set.Add(e);
            return set;
        }

        private List<Entity> NewSince(EntityQuery q, HashSet<Entity> before)
        {
            var list = new List<Entity>();
            using (var arr = q.ToEntityArray(Allocator.TempJob))
                foreach (var e in arr) if (before == null || !before.Contains(e)) list.Add(e);
            return list;
        }

        /// <summary>Runs pure work on a worker thread and yields frames until it is done (rethrows its exception).</summary>
        private static IEnumerator RunAsync<T>(Func<T> work, Action<T> done)
        {
            var task = Task.Run(work);
            while (!task.IsCompleted) yield return WaitFrames.NextFrame;
            if (task.IsFaulted)
            {
                var inner = task.Exception?.InnerException ?? task.Exception;
                throw new PackageException(inner?.Message ?? "background task failed", inner);
            }
            done(task.Result);
        }

        /// <summary>Waits until the game has consumed all creation definitions, or the timeout. Returns frames waited.</summary>
        /// <summary>
        /// Waits until the number of creation definitions is back to <paramref name="baseline"/> (what existed before
        /// we queued ours, e.g. a tool preview), or the timeout.
        /// </summary>
        private IEnumerator WaitForDefinitions(StepReport r, string what, int baseline = 0)
        {
            int frames = 0;
            int left = m_DefinitionQuery.CalculateEntityCount();
            while (left > baseline && frames < m_Opt.SettleTimeout)
            {
                frames++;
                yield return WaitFrames.NextFrame;
                left = m_DefinitionQuery.CalculateEntityCount();
            }
            if (left > baseline)
            {
                r.Notes.Add($"{what}: {left - baseline} definitions still pending after {frames} frames (timeout); continuing");
                ImportLog.Warn($"{what}: {left - baseline} creation definitions not consumed after {frames} frames (timeout). Is a tool active that creates previews?");
            }
            else if (frames >= 10)
            {
                ImportLog.Info($"{what}: definitions consumed after {frames} frames.");
            }
        }

        private string PackagesRootPath(string name) => Path.Combine(ModPaths.Packages, name);
    }
}
