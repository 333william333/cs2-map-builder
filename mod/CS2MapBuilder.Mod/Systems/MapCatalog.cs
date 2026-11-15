using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Colossal.IO.AssetDatabase;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using Game.Assets;

namespace CS2MapBuilder.Systems
{
    /// <summary>Read-only view of the maps the game knows (same enumeration as the editor's map picker).</summary>
    public static class MapCatalog
    {
        public sealed class MapRef
        {
            public Colossal.Hash128 Guid;
            public string DisplayName;
            /// <summary>True when the map lives in the user's own database (the Maps folder), so it may be overwritten.</summary>
            public bool IsUserMap;
            /// <summary>Shipped with the game (AssetDatabase&lt;Game&gt;); listed under New Game regardless of isPlayable.</summary>
            public bool IsGameMap;
            /// <summary>MapInfo.isPlayable: New Game lists a non-game map only when this is true (MenuUISystem.FilterMaps).</summary>
            public bool IsPlayable;
            public bool ListedUnderNewGame => IsGameMap || IsPlayable;
        }

        /// <summary>All maps by display name (case-insensitive). Never throws; returns an empty list on errors.</summary>
        public static List<MapRef> All()
        {
            var list = new List<MapRef>();
            try
            {
                foreach (MapMetadata asset in AssetDatabase.global.GetAssets(default(SearchFilter<MapMetadata>)))
                {
                    using (asset)
                    {
                        try
                        {
                            var meta = asset.GetMeta();
                            if (meta.displayName == null) continue;
                            list.Add(new MapRef
                            {
                                Guid = asset.id,
                                DisplayName = meta.displayName,
                                IsUserMap = ReferenceEquals(asset.database, AssetDatabase.user),
                                IsGameMap = asset.database is AssetDatabase<Colossal.IO.AssetDatabase.Game>,
                                IsPlayable = SafePlayable(asset),
                            });
                        }
                        catch (Exception) { }
                    }
                }
            }
            catch (Exception e)
            {
                ImportLog.Warn("Could not list maps: " + e.Message);
            }
            return list;
        }

        private static bool SafePlayable(MapMetadata asset)
        {
            try { return asset.target != null && asset.target.isPlayable; } catch (Exception) { return false; }
        }

        /// <summary>Folder the editor's Save Map writes user maps to: user data + EnvPath special path for MapMetadata ("Maps/&lt;user id&gt;").</summary>
        public static string UserMapsFolder
        {
            get
            {
                string special = null;
                try { special = Colossal.PSI.Environment.EnvPath.GetSpecialPath<MapMetadata>(); } catch (Exception) { }
                string rel = string.IsNullOrEmpty(special) ? "Maps" : special;
                return Path.GetFullPath(Path.Combine(ModPaths.UserData, rel.Replace('/', Path.DirectorySeparatorChar)));
            }
        }

        public static MapRef Find(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return null;
            return All().FirstOrDefault(m => string.Equals(m.DisplayName, name, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Map file name from free text: invalid file name characters removed, trimmed, at most 64 characters.</summary>
        public static string SanitizeName(string name)
        {
            if (name == null) return string.Empty;
            var invalid = new HashSet<char>(Path.GetInvalidFileNameChars());
            var sb = new StringBuilder();
            foreach (char c in name) if (!invalid.Contains(c)) sb.Append(c);
            string s = sb.ToString().Trim().Trim('.');
            return s.Length > 64 ? s.Substring(0, 64).Trim() : s;
        }

        /// <summary>The default map name for a package: the manifest name, else the folder name.</summary>
        public static string DefaultMapName(string package)
        {
            if (string.IsNullOrWhiteSpace(package)) return string.Empty;
            try
            {
                var m = PackageReader.ReadJson<Manifest>(Path.Combine(ModPaths.Packages, package, PackageFormat.ManifestFile), PackageFormat.ManifestFile);
                if (!string.IsNullOrWhiteSpace(m.Name)) return SanitizeName(m.Name);
            }
            catch (Exception) { }
            return SanitizeName(package);
        }
    }
}
