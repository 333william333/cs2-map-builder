using System;
using Colossal.IO.AssetDatabase;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Settings;
using CS2MapBuilder.Systems;
using CS2MapBuilder.UI;
using Game;
using Game.Modding;
using Game.SceneFlow;

namespace CS2MapBuilder
{
    /// <summary>
    /// Entry point. Registers the systems and the options page and logs where packages are read from.
    /// Does no import work on load: the importer is idle until the user presses Import in the Map Editor.
    /// Note: the game creates IMod instances without running constructors or field initialisers.
    /// </summary>
    public sealed class Mod : IMod
    {
        public static Mod Instance { get; private set; }
        private MapBuilderSettings m_Settings;

        public void OnLoad(UpdateSystem updateSystem)
        {
            Instance = this;
            try
            {
                string version = typeof(Mod).Assembly.GetName().Version?.ToString() ?? "?";
                ModPaths.EnsureDirectories();
                ImportLog.Info($"CS2 Map Builder importer {version} loading (game {SafeGameVersion()}). Packages folder: {ModPaths.Packages}");

                LoadSettings();

                updateSystem.UpdateAt<ImportSystem>(SystemUpdatePhase.ToolUpdate);
                updateSystem.UpdateAt<EditorTabRegistrationSystem>(SystemUpdatePhase.UIUpdate);

                ImportLog.Info("CS2 Map Builder importer loaded. Open the Map Editor and use the 'CS2 Map Builder' tab (or Options > CS2 Map Builder).");
            }
            catch (Exception e)
            {
                ImportLog.Error("CS2 Map Builder failed to load", e);
            }
        }

        public void OnDispose()
        {
            try
            {
                m_Settings?.UnregisterInOptionsUI();
            }
            catch (Exception e) { ImportLog.Error("Dispose failed", e); }
            m_Settings = null;
            MapBuilderSettings.Current = null;
            Instance = null;
        }

        private void LoadSettings()
        {
            try
            {
                var settings = new MapBuilderSettings(this);
                settings.RegisterInOptionsUI();
                GameManager.instance.localizationManager.AddSource("en-US", new MapBuilderSettingsLocale(settings));
                AssetDatabase.global.LoadSettings(ModPaths.ModId, settings, new MapBuilderSettings(this));
                m_Settings = settings;
                MapBuilderSettings.Current = settings;
            }
            catch (Exception e)
            {
                ImportLog.Error("Settings page could not be registered (defaults are used)", e);
                if (MapBuilderSettings.Current == null)
                {
                    try { MapBuilderSettings.Current = new MapBuilderSettings(this); } catch (Exception) { }
                }
            }
        }

        private static string SafeGameVersion()
        {
            try { return UnityEngine.Application.version; } catch (Exception) { return "unknown"; }
        }
    }
}
