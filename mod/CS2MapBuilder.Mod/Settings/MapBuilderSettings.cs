using System;
using System.Collections.Generic;
using System.Linq;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using CS2MapBuilder.Systems;
using Colossal;
using Colossal.IO.AssetDatabase;
using Game.Modding;
using Game.Settings;
using Game.UI.Localization;
using Game.UI.Widgets;

namespace CS2MapBuilder.Settings
{
    /// <summary>
    /// Options page. Tab "Import" duplicates the editor panel's essential actions (fallback if the editor tab cannot
    /// be registered). Tab "Advanced" holds every switch for behaviour that can only be confirmed in game.
    /// The step checkboxes are shared with the editor panel.
    /// </summary>
    [FileLocation(ModPaths.ModId)]
    [SettingsUIGroupOrder(kPackageGroup, kPlayableGroup, kStepsGroup, kActionsGroup, kGeometryGroup, kBatchGroup, kWaterGroup, kMapFlowGroup, kSafetyGroup)]
    [SettingsUIShowGroupName(kPackageGroup, kPlayableGroup, kStepsGroup, kActionsGroup, kGeometryGroup, kBatchGroup, kWaterGroup, kMapFlowGroup, kSafetyGroup)]
    public sealed class MapBuilderSettings : ModSetting
    {
        public const string kImportTab = "Import";
        public const string kAdvancedTab = "Advanced";
        public const string kPackageGroup = "Package";
        public const string kStepsGroup = "Steps";
        public const string kActionsGroup = "Actions";
        public const string kGeometryGroup = "Geometry";
        public const string kBatchGroup = "Batching";
        public const string kWaterGroup = "Water";
        public const string kSafetyGroup = "Safety";
        public const string kPlayableGroup = "PlayableMap";
        public const string kMapFlowGroup = "MapFlow";

        public static MapBuilderSettings Current { get; set; }

        private static int s_PackagesVersion;

        public MapBuilderSettings(IMod mod) : base(mod) { SetDefaults(); }

        // ------------------------------------------------------------------ Import tab: package

        [SettingsUISection(kImportTab, kPackageGroup)]
        [SettingsUIDropdown(typeof(MapBuilderSettings), nameof(GetPackageItems))]
        [SettingsUIValueVersion(typeof(MapBuilderSettings), nameof(GetPackagesVersion))]
        public string SelectedPackage
        {
            get => m_SelectedPackage;
            set
            {
                // The map name follows the package (manifest name) unless the user typed their own.
                string oldDefault = MapCatalog.DefaultMapName(m_SelectedPackage);
                m_SelectedPackage = value;
                if (string.IsNullOrWhiteSpace(MapName) || MapName == oldDefault)
                    MapName = MapCatalog.DefaultMapName(value);
            }
        }
        private string m_SelectedPackage;

        [SettingsUISection(kImportTab, kPackageGroup)]
        [SettingsUIButton]
        public bool RefreshPackages { set { s_PackagesVersion++; } }

        [SettingsUISection(kImportTab, kPackageGroup)]
        [SettingsUIMultilineText]
        [SettingsUIDisplayName(typeof(MapBuilderSettings), nameof(GetStatusText))]
        public string StatusText => string.Empty;

        // ------------------------------------------------------------------ Import tab: playable map

        [SettingsUISection(kImportTab, kPlayableGroup)]
        [SettingsUITextInput]
        public string MapName { get; set; }

        [SettingsUISection(kImportTab, kPlayableGroup)]
        public bool OverwriteExistingMap { get; set; }

        [SettingsUISection(kImportTab, kPlayableGroup)]
        [SettingsUIButton]
        [SettingsUIButtonGroup("PlayableActions")]
        public bool CreatePlayableMap { set { MapFlowSystem.RequestCreate(SelectedPackage, MapName, OverwriteExistingMap); } }

        [SettingsUISection(kImportTab, kPlayableGroup)]
        [SettingsUIButton]
        [SettingsUIButtonGroup("PlayableActions")]
        public bool SaveAsPlayableMap { set { MapFlowSystem.RequestSaveCurrent(SelectedPackage, MapName, OverwriteExistingMap); } }

        [SettingsUISection(kImportTab, kPlayableGroup)]
        [SettingsUIButton]
        [SettingsUIButtonGroup("PlayableActions")]
        public bool CancelPlayableMap { set { MapFlowSystem.RequestCancel(); } }

        // ------------------------------------------------------------------ Import tab: steps

        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepTerrain { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepWorldMap { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepClimate { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepWater { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepResources { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepNetworks { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepNames { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepTrees { get; set; }
        [SettingsUISection(kImportTab, kStepsGroup)] public bool StepStartTiles { get; set; }

        // ------------------------------------------------------------------ Import tab: actions

        [SettingsUISection(kImportTab, kActionsGroup)]
        [SettingsUIButton]
        [SettingsUIButtonGroup("ImportActions")]
        public bool ImportNow { set { ImportSystem.RequestImport(SelectedPackage); } }

        [SettingsUISection(kImportTab, kActionsGroup)]
        [SettingsUIButton]
        [SettingsUIButtonGroup("ImportActions")]
        public bool CancelImport { set { ImportSystem.RequestCancel(); MapFlowSystem.RequestCancel(); } }

        [SettingsUISection(kImportTab, kActionsGroup)]
        [SettingsUIButton]
        [SettingsUIConfirmation]
        [SettingsUIButtonGroup("ImportActions")]
        public bool UndoLastImport { set { ImportSystem.RequestUndo(); } }

        // ------------------------------------------------------------------ Advanced: geometry / orientation

        /// <summary>Unknown until tested (MOD_SPIKE 11.1): whether PNG row 0 lands at max z (north). Applies to heightmap, world map and resource maps.</summary>
        [SettingsUISection(kAdvancedTab, kGeometryGroup)] public bool FlipHeightmapRows { get; set; }

        /// <summary>Set CoursePos.m_Entity to already generated nodes so later batches attach instead of relying on the merge radius.</summary>
        [SettingsUISection(kAdvancedTab, kGeometryGroup)] public bool LinkExistingNodes { get; set; }

        /// <summary>Replace the start tiles with a 3x3 block around the package start tile (otherwise add to them).</summary>
        [SettingsUISection(kAdvancedTab, kGeometryGroup)] public bool ReplaceStartTiles { get; set; }

        // ------------------------------------------------------------------ Advanced: batching

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 100, max = 200000, step = 100, unit = Game.UI.Unit.kInteger)]
        public int NetBatchSize { get; set; }

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 500, max = 50000, step = 500, unit = Game.UI.Unit.kInteger)]
        public int TreeBatchSize { get; set; }

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 0, max = 2000000, step = 10000, unit = Game.UI.Unit.kInteger)]
        public int MaxTrees { get; set; }

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 1, max = 600, step = 1, unit = Game.UI.Unit.kInteger)]
        public int FramesBetweenSteps { get; set; }

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 60, max = 3600, step = 30, unit = Game.UI.Unit.kInteger)]
        public int SettleTimeoutFrames { get; set; }

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 500, max = 20000, step = 500, unit = Game.UI.Unit.kInteger)]
        public int UndoBatchSize { get; set; }

        [SettingsUISection(kAdvancedTab, kBatchGroup)]
        [SettingsUISlider(min = 2, max = 100, step = 1, unit = Game.UI.Unit.kInteger)]
        public int FrameBudgetMs { get; set; }

        // ------------------------------------------------------------------ Advanced: water

        [SettingsUISection(kAdvancedTab, kWaterGroup)] public bool SetSeaLevel { get; set; }

        [SettingsUISection(kAdvancedTab, kWaterGroup)]
        [SettingsUISlider(min = 0, max = 1200, step = 30, unit = Game.UI.Unit.kInteger)]
        public int WaterRampFrames { get; set; }

        [SettingsUISection(kAdvancedTab, kWaterGroup)] public bool SkipTreesBelowSeaLevel { get; set; }

        // ------------------------------------------------------------------ Advanced: playable map flow

        [SettingsUISection(kAdvancedTab, kMapFlowGroup)]
        [SettingsUISlider(min = 30, max = 1800, step = 30, unit = Game.UI.Unit.kInteger)]
        public int EditorReadyFrames { get; set; }

        [SettingsUISection(kAdvancedTab, kMapFlowGroup)]
        [SettingsUISlider(min = 60, max = 900, step = 30, unit = Game.UI.Unit.kInteger)]
        public int EditorLoadTimeoutSeconds { get; set; }

        [SettingsUISection(kAdvancedTab, kMapFlowGroup)]
        [SettingsUISlider(min = 120, max = 36000, step = 120, unit = Game.UI.Unit.kInteger)]
        public int MapSettleFrames { get; set; }

        [SettingsUISection(kAdvancedTab, kMapFlowGroup)]
        [SettingsUISlider(min = 30, max = 900, step = 30, unit = Game.UI.Unit.kInteger)]
        public int SaveTimeoutSeconds { get; set; }

        [SettingsUISection(kAdvancedTab, kMapFlowGroup)]
        public bool NotifyNewPackages { get; set; }

        // ------------------------------------------------------------------ Advanced: safety

        /// <summary>Nothing runs outside the Map Editor unless this is on.</summary>
        [SettingsUISection(kAdvancedTab, kSafetyGroup)] public bool AllowOutsideEditor { get; set; }

        public override void SetDefaults()
        {
            MapName = string.Empty;
            SelectedPackage = string.Empty;
            OverwriteExistingMap = false;
            EditorReadyFrames = 180;
            EditorLoadTimeoutSeconds = 300;
            MapSettleFrames = 3600;
            SaveTimeoutSeconds = 180;
            NotifyNewPackages = true;
            StepTerrain = true;
            StepWorldMap = true;
            StepClimate = true;
            StepWater = true;
            StepResources = true;
            StepNetworks = true;
            StepNames = true;
            StepTrees = true;
            StepStartTiles = true;
            FlipHeightmapRows = false;
            LinkExistingNodes = false;
            ReplaceStartTiles = true;
            NetBatchSize = 20000;
            TreeBatchSize = 10000;
            MaxTrees = 400000;
            FramesBetweenSteps = 30;
            SettleTimeoutFrames = 600;
            UndoBatchSize = 2000;
            FrameBudgetMs = 12;
            SetSeaLevel = true;
            WaterRampFrames = 120;
            SkipTreesBelowSeaLevel = true;
            AllowOutsideEditor = false;
        }

        // ------------------------------------------------------------------ getters used by attributes

        public DropdownItem<string>[] GetPackageItems()
        {
            List<string> names;
            try { names = PackageReader.ListPackages(ModPaths.Packages); }
            catch (Exception) { names = new List<string>(); }
            if (names.Count == 0)
                return new[] { new DropdownItem<string> { value = string.Empty, displayName = LocalizedString.Value("(no packages in ModsData/CS2MapBuilder/packages)"), disabled = true } };
            return names.Select(n => new DropdownItem<string> { value = n, displayName = LocalizedString.Value(n) }).ToArray();
        }

        public int GetPackagesVersion() => s_PackagesVersion;

        public LocalizedString GetStatusText()
        {
            string flow = MapFlowSystem.StatusLine;
            string import = ImportSystem.StatusLine;
            if (string.IsNullOrEmpty(flow)) return LocalizedString.Value(import);
            return LocalizedString.Value(MapFlowSystem.IsBusy ? flow + "\n" + import : flow);
        }
    }

    /// <summary>en-US strings for the options page (labels for all settings, the tab name and the editor tool tab).</summary>
    public sealed class MapBuilderSettingsLocale : IDictionarySource
    {
        private readonly MapBuilderSettings m_S;

        public MapBuilderSettingsLocale(MapBuilderSettings s) { m_S = s; }

        public IEnumerable<KeyValuePair<string, string>> ReadEntries(IList<IDictionaryEntryError> errors, Dictionary<string, int> indexCounts)
        {
            var d = new Dictionary<string, string>
            {
                { m_S.GetSettingsLocaleID(), "CS2 Map Builder" },
                { m_S.GetOptionTabLocaleID(MapBuilderSettings.kImportTab), "Import" },
                { m_S.GetOptionTabLocaleID(MapBuilderSettings.kAdvancedTab), "Advanced" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kPackageGroup), "Package" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kStepsGroup), "Steps to run" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kActionsGroup), "Actions (Map Editor only)" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kGeometryGroup), "Orientation and geometry (unknowns, see TESTING.md)" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kBatchGroup), "Batching and timing" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kWaterGroup), "Water" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kSafetyGroup), "Safety" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kPlayableGroup), "Playable map (start from the main menu)" },
                { m_S.GetOptionGroupLocaleID(MapBuilderSettings.kMapFlowGroup), "Create playable map: timing" },
                { "Editor.TOOL[" + MapBuilderEditorToolIds.ToolId + "]", "CS2 Map Builder" },
                { "Editor.TOOL_DESCRIPTION[" + MapBuilderEditorToolIds.ToolId + "]", "Import a CS2 Map Builder package" },
            };
            void Add(string prop, string label, string desc)
            {
                d[m_S.GetOptionLabelLocaleID(prop)] = label;
                d[m_S.GetOptionDescLocaleID(prop)] = desc;
            }
            Add(nameof(MapBuilderSettings.SelectedPackage), "Package", "Package folder under ModsData/CS2MapBuilder/packages.");
            Add(nameof(MapBuilderSettings.RefreshPackages), "Refresh list", "Re-read the packages folder.");
            Add(nameof(MapBuilderSettings.StatusText), "Status", "Import status.");
            Add(nameof(MapBuilderSettings.MapName), "Map name", "Name of the saved map, shown under New Game. Defaults to the package name.");
            Add(nameof(MapBuilderSettings.OverwriteExistingMap), "Overwrite existing map", "Allow replacing one of your own maps with the same name. Off: an existing name is refused. Game and Paradox Mods maps are never overwritten.");
            Add(nameof(MapBuilderSettings.CreatePlayableMap), "Create playable map", "From the main menu: opens the Map Editor with a new map, imports the package with all steps, fills in name, description, theme and start tiles, checks the checklist and saves the map so it appears under New Game.");
            Add(nameof(MapBuilderSettings.SaveAsPlayableMap), "Save editor map as playable map", "In the Map Editor: fill in name, description and start tiles for the open map, check the checklist and save it.");
            Add(nameof(MapBuilderSettings.CancelPlayableMap), "Cancel", "Stop creating the map (nothing is saved if the save has not started).");
            Add(nameof(MapBuilderSettings.EditorReadyFrames), "Frames to wait after the editor opens", "Let the new map finish setting up before the import starts.");
            Add(nameof(MapBuilderSettings.EditorLoadTimeoutSeconds), "Editor load timeout (s)", "Give up if the Map Editor has not opened after this long.");
            Add(nameof(MapBuilderSettings.MapSettleFrames), "Maximum settle time (frames)", "Longest wait for terrain, water and the checklist before saving.");
            Add(nameof(MapBuilderSettings.SaveTimeoutSeconds), "Save timeout (s)", "Give up waiting for the save after this long.");
            Add(nameof(MapBuilderSettings.NotifyNewPackages), "Notify about new packages", "In the main menu, show a notification for each package that has no saved map yet.");
            Add(nameof(MapBuilderSettings.StepTerrain), "Terrain (height scale + heightmap)", "Set the height scale and replace the playable heightmap.");
            Add(nameof(MapBuilderSettings.StepWorldMap), "World map", "Replace the world (backdrop) heightmap, if the package has one.");
            Add(nameof(MapBuilderSettings.StepClimate), "Climate, theme, latitude/longitude", "Clone the current climate, apply the package seasons and location, set the theme.");
            Add(nameof(MapBuilderSettings.StepWater), "Sea level and water sources", "Set the sea level and create lake/river level sources.");
            Add(nameof(MapBuilderSettings.StepResources), "Natural resources", "Write fertile land, ore, oil and groundwater cell maps.");
            Add(nameof(MapBuilderSettings.StepNetworks), "Roads, rail, paths", "Create network segments by class.");
            Add(nameof(MapBuilderSettings.StepNames), "Street names", "Name road aggregates after the networks exist.");
            Add(nameof(MapBuilderSettings.StepTrees), "Trees", "Place trees in spatial chunks.");
            Add(nameof(MapBuilderSettings.StepStartTiles), "Start tiles", "Set the starting map tiles.");
            Add(nameof(MapBuilderSettings.ImportNow), "Import", "Import the selected package (Map Editor only).");
            Add(nameof(MapBuilderSettings.CancelImport), "Cancel", "Stop the running import after the current batch.");
            Add(nameof(MapBuilderSettings.UndoLastImport), "Undo last import", "Delete the networks, trees and water sources created by the last import (terrain and climate are not reverted).");
            Add(nameof(MapBuilderSettings.FlipHeightmapRows), "Flip heightmap rows (north/south)", "Turn on if the imported terrain is mirrored north-south. Also applies to the world map and resource maps.");
            Add(nameof(MapBuilderSettings.LinkExistingNodes), "Attach to existing nodes", "Connect later network batches to nodes created by earlier batches by entity, not only by position.");
            Add(nameof(MapBuilderSettings.ReplaceStartTiles), "Replace start tiles", "On: start area = 3x3 tiles around the package start tile. Off: add those tiles to the current start area.");
            Add(nameof(MapBuilderSettings.NetBatchSize), "Network batch size", "Maximum edges per frame. Whole connected components are never split, so a large component can exceed this.");
            Add(nameof(MapBuilderSettings.TreeBatchSize), "Tree batch size", "Trees created per frame.");
            Add(nameof(MapBuilderSettings.MaxTrees), "Maximum trees", "Trees beyond this are thinned evenly. 0 = no limit.");
            Add(nameof(MapBuilderSettings.FramesBetweenSteps), "Frames to wait between steps", "Frames to let the game settle after each step and batch.");
            Add(nameof(MapBuilderSettings.SettleTimeoutFrames), "Settle timeout (frames)", "Give up waiting for the game to consume definitions after this many frames.");
            Add(nameof(MapBuilderSettings.UndoBatchSize), "Undo batch size", "Entities deleted per frame by undo.");
            Add(nameof(MapBuilderSettings.FrameBudgetMs), "Frame budget (ms)", "Milliseconds of import work per frame.");
            Add(nameof(MapBuilderSettings.SetSeaLevel), "Set the sea level", "Set the global sea level from the package (0 when the package has no sea).");
            Add(nameof(MapBuilderSettings.WaterRampFrames), "Water source ramp (frames)", "Grow water source radii from 10% to full over this many frames. 0 = full radius at once.");
            Add(nameof(MapBuilderSettings.SkipTreesBelowSeaLevel), "Skip trees below sea level", "Do not place trees whose ground is below the sea level.");
            Add(nameof(MapBuilderSettings.AllowOutsideEditor), "Allow import outside the Map Editor", "Off by default. Importing into a running city is not supported.");
            return d;
        }

        public void Unload() { }
    }

    public static class MapBuilderEditorToolIds
    {
        public const string ToolId = "CS2MapBuilder";
    }
}
