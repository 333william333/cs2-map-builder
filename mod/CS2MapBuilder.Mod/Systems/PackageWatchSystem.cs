using System;
using System.Collections.Generic;
using System.Linq;
using Colossal.PSI.Common;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using CS2MapBuilder.Settings;
using Game;
using Game.SceneFlow;
using Game.UI.Localization;
using Game.UI.Menu;

namespace CS2MapBuilder.Systems
{
    /// <summary>
    /// When the main menu is reached, shows one notification per package that has no saved map yet
    /// ("New map package ready: ..."). Reads only the small manifest files; runs once per visit to the menu.
    /// </summary>
    public sealed class PackageWatchSystem : GameSystemBase
    {
        private bool m_WasInMenu;
        private int m_Frame;
        private readonly HashSet<string> m_Shown = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        protected override void OnUpdate()
        {
            if ((++m_Frame % 30) != 0) return;
            var gm = GameManager.instance;
            bool inMenu = gm != null && gm.gameMode == GameMode.MainMenu && !gm.isGameLoading;
            if (inMenu && !m_WasInMenu)
            {
                try { Scan(); }
                catch (Exception e) { ImportLog.Error("Package scan failed", e); }
            }
            m_WasInMenu = inMenu;
        }

        private void Scan()
        {
            if (!(MapBuilderSettings.Current?.NotifyNewPackages ?? true)) return;
            var packages = PackageReader.ListPackages(ModPaths.Packages);
            if (packages.Count == 0) return;
            var maps = new HashSet<string>(MapCatalog.All().Select(m => m.DisplayName), StringComparer.OrdinalIgnoreCase);
            var notifications = World.GetExistingSystemManaged<NotificationUISystem>();
            int fresh = 0;
            foreach (var pkg in packages)
            {
                string mapName = MapCatalog.DefaultMapName(pkg);
                if (maps.Contains(mapName) || maps.Contains(pkg)) continue;
                fresh++;
                if (notifications == null || m_Shown.Contains(pkg)) continue;
                string id = "CS2MapBuilder.Package." + pkg;
                notifications.AddOrUpdateNotification(id,
                    LocalizedString.Value("New map package ready: " + mapName),
                    LocalizedString.Value("Open Options > CS2 Map Builder to create the playable map."),
                    null, null, null, () => notifications.RemoveNotification(id));
                m_Shown.Add(pkg);
            }
            ImportLog.Info($"Main menu: {packages.Count} packages, {fresh} without a saved map, {maps.Count} maps known to the game.");
        }
    }
}
