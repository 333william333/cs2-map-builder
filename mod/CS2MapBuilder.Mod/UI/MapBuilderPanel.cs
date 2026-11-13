using System;
using System.Collections.Generic;
using System.Linq;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using CS2MapBuilder.Settings;
using CS2MapBuilder.Systems;
using Game.Reflection;
using Game.UI.Editor;
using Game.UI.Localization;
using Game.UI.Widgets;
using Unity.Entities;

namespace CS2MapBuilder.UI
{
    /// <summary>
    /// Native C# editor panel (no JS): package picker, step checkboxes, Import / Cancel / Undo, progress and the
    /// last log lines. Values are read from and written to <see cref="MapBuilderSettings"/>, shared with the
    /// options page.
    /// </summary>
    public sealed class MapBuilderPanel : EditorPanelSystemBase
    {
        private const int kLogLines = 8;
        private int m_PackagesVersion;
        private DropdownItem<string>[] m_Items = Array.Empty<DropdownItem<string>>();

        protected override void OnCreate()
        {
            base.OnCreate();
            title = LocalizedString.Value("CS2 Map Builder");
            RefreshPackages();

            var s = (Func<MapBuilderSettings>)(() => MapBuilderSettings.Current);
            var widgets = new List<IWidget>
            {
                new DropdownField<string>
                {
                    path = "package",
                    displayName = LocalizedString.Value("Package"),
                    itemsAccessor = new DelegateAccessor<DropdownItem<string>[]>(() => m_Items),
                    itemsVersion = () => m_PackagesVersion,
                    accessor = new DelegateAccessor<string>(
                        () => s()?.SelectedPackage ?? string.Empty,
                        v => { if (s() != null) { s().SelectedPackage = v; s().ApplyAndSave(); } }),
                },
                new Button
                {
                    path = "refresh",
                    displayName = LocalizedString.Value("Refresh package list"),
                    action = RefreshPackages,
                },
                new Label { path = "folder", displayName = LocalizedString.Value("Folder: " + ModPaths.Packages) },
                Toggle("stepTerrain", "Terrain (height scale + heightmap)", x => x.StepTerrain, (x, v) => x.StepTerrain = v),
                Toggle("stepWorld", "World map", x => x.StepWorldMap, (x, v) => x.StepWorldMap = v),
                Toggle("stepClimate", "Climate, theme, lat/lon", x => x.StepClimate, (x, v) => x.StepClimate = v),
                Toggle("stepWater", "Sea level + water sources", x => x.StepWater, (x, v) => x.StepWater = v),
                Toggle("stepResources", "Natural resources", x => x.StepResources, (x, v) => x.StepResources = v),
                Toggle("stepNetworks", "Roads, rail, paths", x => x.StepNetworks, (x, v) => x.StepNetworks = v),
                Toggle("stepNames", "Street names", x => x.StepNames, (x, v) => x.StepNames = v),
                Toggle("stepTrees", "Trees", x => x.StepTrees, (x, v) => x.StepTrees = v),
                Toggle("stepStartTiles", "Start tiles", x => x.StepStartTiles, (x, v) => x.StepStartTiles = v),
                ButtonRow.WithChildren(new[]
                {
                    new Button
                    {
                        path = "import",
                        displayName = LocalizedString.Value("Import"),
                        action = () => ImportSystem.RequestImport(s()?.SelectedPackage),
                        disabled = () => ImportSystem.IsBusy,
                    },
                    new Button
                    {
                        path = "cancel",
                        displayName = LocalizedString.Value("Cancel"),
                        action = ImportSystem.RequestCancel,
                        disabled = () => !ImportSystem.IsBusy,
                    },
                    new Button
                    {
                        path = "undo",
                        displayName = LocalizedString.Value("Undo last import"),
                        action = ImportSystem.RequestUndo,
                        disabled = () => ImportSystem.IsBusy || !ImportSystem.CanUndo,
                    },
                }),
                new Label { path = "status", displayNameAction = () => LocalizedString.Value(ImportSystem.StatusLine) },
                new StringInputField
                {
                    path = "mapName",
                    displayName = LocalizedString.Value("Map name"),
                    accessor = new DelegateAccessor<string>(
                        () => s()?.MapName ?? string.Empty,
                        v => { if (s() != null) { s().MapName = v; s().ApplyAndSave(); } }),
                },
                Toggle("overwrite", "Overwrite my existing map with this name", x => x.OverwriteExistingMap, (x, v) => x.OverwriteExistingMap = v),
                new Button
                {
                    path = "savePlayable",
                    displayName = LocalizedString.Value("Save as playable map"),
                    action = () => MapFlowSystem.RequestSaveCurrent(s()?.SelectedPackage, s()?.MapName, s()?.OverwriteExistingMap ?? false),
                    disabled = () => ImportSystem.IsBusy || MapFlowSystem.IsBusy,
                },
                new Label { path = "mapStatus", displayNameAction = () => LocalizedString.Value(string.IsNullOrEmpty(MapFlowSystem.StatusLine) ? " " : MapFlowSystem.StatusLine) },
            };
            for (int i = 0; i < kLogLines; i++)
            {
                int line = i;
                widgets.Add(new Label
                {
                    path = "log" + i,
                    displayNameAction = () =>
                    {
                        var lines = ImportLog.RecentLines(kLogLines);
                        int idx = line - (kLogLines - lines.Length);
                        return LocalizedString.Value(idx >= 0 && idx < lines.Length ? Shorten(lines[idx]) : " ");
                    },
                });
            }
            children = widgets;
        }

        private static ToggleField Toggle(string path, string label, Func<MapBuilderSettings, bool> get, Action<MapBuilderSettings, bool> set)
        {
            return new ToggleField
            {
                path = path,
                displayName = LocalizedString.Value(label),
                accessor = new DelegateAccessor<bool>(
                    () => MapBuilderSettings.Current != null && get(MapBuilderSettings.Current),
                    v =>
                    {
                        var s = MapBuilderSettings.Current;
                        if (s == null) return;
                        set(s, v);
                        s.ApplyAndSave();
                    }),
            };
        }

        private void RefreshPackages()
        {
            try
            {
                var names = PackageReader.ListPackages(ModPaths.Packages);
                m_Items = names.Count == 0
                    ? new[] { new DropdownItem<string> { value = string.Empty, displayName = LocalizedString.Value("(no packages found)"), disabled = true } }
                    : names.Select(n => new DropdownItem<string> { value = n, displayName = LocalizedString.Value(n) }).ToArray();
                var s = MapBuilderSettings.Current;
                if (s != null && names.Count > 0 && !names.Contains(s.SelectedPackage)) s.SelectedPackage = names[0];
            }
            catch (Exception e)
            {
                ImportLog.Error("Could not list packages", e);
            }
            m_PackagesVersion++;
        }

        private static string Shorten(string s) => s.Length <= 120 ? s : s.Substring(0, 117) + "...";
    }

    /// <summary>The editor tool tab. No ToolBaseSystem is needed: EditorTool.tool is nullable (the panel alone is shown).</summary>
    public sealed class MapBuilderEditorTool : EditorTool
    {
        public MapBuilderEditorTool(World world) : base(world)
        {
            id = MapBuilderEditorToolIds.ToolId;
            icon = "Media/Editor/Package.svg";
            panel = world.GetOrCreateSystemManaged<MapBuilderPanel>();
            tool = null;
            m_DefaultTool = world.GetOrCreateSystemManaged<Game.Tools.DefaultToolSystem>();
        }

        private readonly Game.Tools.DefaultToolSystem m_DefaultTool;

        protected override void OnEnable()
        {
            base.OnEnable();
            // Make sure no brush or placement tool keeps creating preview definitions while we import.
            if (m_DefaultTool != null) m_ToolSystem.activeTool = m_DefaultTool;
        }
    }
}
