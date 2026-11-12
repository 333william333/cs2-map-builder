using System;
using System.Collections.Generic;

namespace CS2MapBuilder.Package
{
    /// <summary>
    /// Near-equivalent substitutes for game prefabs that may be missing (DLC, theme, renamed assets).
    /// Resolution order: the requested name, then each fallback in order. A substitution is always reported.
    /// Names come from docs/MOD_SPIKE.md 3.3 / 4 and CONTRACT.md; the mod logs the real list at runtime.
    /// </summary>
    public static class PrefabFallbacks
    {
        public static readonly Dictionary<string, string[]> Net = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            { "Highway Oneway - 4 lanes", new[] { "Highway Oneway - 3 lanes", "Highway Oneway - 2 lanes", "Large Road Oneway" } },
            { "Highway Oneway - 3 lanes", new[] { "Highway Oneway - 2 lanes", "Highway Oneway - 4 lanes", "Large Road Oneway" } },
            { "Highway Oneway - 2 lanes", new[] { "Highway Oneway - 3 lanes", "Highway Oneway - 1 lane", "Medium Road Oneway" } },
            { "Highway Oneway - 1 lane", new[] { "Highway Oneway - 2 lanes", "Small Road Oneway" } },
            { "Highway Twoway - 3 lanes", new[] { "Highway Twoway - 2 lanes", "Highway Twoway - 4 lanes", "Large Road" } },
            { "Highway Twoway - 2 lanes", new[] { "Highway Twoway - 3 lanes", "Large Road", "Medium Road" } },
            { "Large Road", new[] { "Large Road Divided", "Medium Road" } },
            { "Large Road Oneway", new[] { "Medium Road Oneway", "Highway Oneway - 3 lanes" } },
            { "Medium Road", new[] { "Medium Road Divided", "Large Road", "Small Road" } },
            { "Medium Road Oneway", new[] { "Small Road Oneway", "Large Road Oneway" } },
            { "Small Road", new[] { "Medium Road" } },
            { "Small Road Oneway", new[] { "Small Road Oneway - 1 lane", "Medium Road Oneway" } },
            { "Gravel Road", new[] { "Small Road", "Alley" } },
            { "Alley", new[] { "Small Road", "Gravel Road" } },
            { "Pavement Path", new[] { "PedestrianPathWide01", "Pedestrian Street Small", "Pedestrian Street" } },
            { "Double Train Track", new[] { "Double Train Track - Twoway", "Twoway Train Track" } },
            { "Twoway Train Track", new[] { "Double Train Track - Twoway", "Double Train Track" } },
            { "Double Tram Track", new[] { "Oneway Tram Track" } },
            { "Double Subway Track", new[] { "Double Subway Track - Twoway", "Twoway Subway Track" } },
        };

        public static readonly Dictionary<string, string[]> Tree = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            { "BirchTree01", new[] { "EU_AlderTree01", "EU_PoplarTree01", "TreeWildRandom01" } },
            { "OakTree01", new[] { "NA_HickoryTree01", "EU_ChestnutTree01", "TreeWildRandom01" } },
            { "NA_LindenTree01", new[] { "OakTree01", "EU_ChestnutTree01", "TreeWildRandom01" } },
            { "EU_ChestnutTree01", new[] { "OakTree01", "NA_LindenTree01", "TreeWildRandom01" } },
            { "EU_PoplarTree01", new[] { "BirchTree01", "EU_AlderTree01", "TreeWildRandom01" } },
            { "EU_AlderTree01", new[] { "BirchTree01", "EU_PoplarTree01", "TreeWildRandom01" } },
            { "AppleTree01", new[] { "OakTree01", "TreeCityRandom01", "TreeWildRandom01" } },
            { "NA_HickoryTree01", new[] { "OakTree01", "NA_LindenTree01", "TreeWildRandom01" } },
            { "NA_LondonPlaneTree01", new[] { "OakTree01", "NA_LindenTree01", "TreeWildRandom01" } },
            { "PineTree01", new[] { "SpruceTree01", "EuropeanSpruce01", "TreeWildRandom01" } },
            { "SpruceTree01", new[] { "EuropeanSpruce01", "PineTree01", "TreeWildRandom01" } },
            { "GreenBushWild01", new[] { "GreenBushWild02", "BushWildRandom01", "FlowerBushWild01" } },
            { "CoconutPalmTree01", new[] { "FloridaPalmTree01", "RoyalPalmTree01", "SylvesterPalmTree01" } },
        };

        /// <summary>
        /// Resolves <paramref name="requested"/> against <paramref name="exists"/>. Returns the name to use, or null.
        /// <paramref name="substituted"/> is true when a fallback was used.
        /// </summary>
        public static string Resolve(string requested, Func<string, bool> exists, Dictionary<string, string[]> table, out bool substituted)
        {
            substituted = false;
            if (string.IsNullOrEmpty(requested)) return null;
            if (exists(requested)) return requested;
            if (table != null && table.TryGetValue(requested, out var alts))
            {
                foreach (var alt in alts)
                {
                    if (exists(alt)) { substituted = true; return alt; }
                }
            }
            return null;
        }
    }
}
