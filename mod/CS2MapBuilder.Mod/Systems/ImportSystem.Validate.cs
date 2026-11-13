using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using Game.Prefabs;
using Unity.Collections;
using Unity.Entities;

namespace CS2MapBuilder.Systems
{
    public sealed partial class ImportSystem
    {
        private sealed class LoadedFiles
        {
            public PackageRoads Roads;
            public PackageTrees Trees;
            public WaterJson Water;
            public ClimateJson Climate;
        }

        /// <summary>Step 1: read and validate the package, resolve every prefab name. Aborts the import on errors.</summary>
        private IEnumerator ValidateStep(StepReport r)
        {
            string folder = PackagesRootPath(m_PackageName);
            var rep = new ValidationReport();
            ImportLog.Info("Package folder: " + folder);

            PackageReader pkg = null;
            try { pkg = PackageReader.Open(folder, rep); }
            catch (PackageException e)
            {
                rep.Errors.Add(e.Message);
            }

            if (pkg != null)
            {
                m_Pkg = pkg;
                var m = pkg.Manifest;
                LastManifest = m;
                ImportLog.Info($"Manifest: name='{m.Name}' version={m.Version} heightScale={m.HeightScale} seaLevel={m.SeaLevel} hasSea={m.HasSea} " +
                               $"theme={m.Theme} startTile={(m.StartTile == null ? "none" : m.StartTile.Col + "," + m.StartTile.Row)} " +
                               $"counts: nodes={m.Counts?.Nodes} edges={m.Counts?.Edges} trees={m.Counts?.Trees} water={m.Counts?.WaterSources}");
                foreach (var w in m.Warnings ?? new List<string>()) r.Notes.Add("package warning: " + w);

                bool needRoads = (m_Opt.Networks || m_Opt.Names);
                bool needTrees = m_Opt.Trees;
                bool needWater = m_Opt.Water;
                bool needClimate = m_Opt.Climate;
                ReportMissing(r, pkg, needRoads, PackageFormat.RoadsFile, "Networks/Names");
                ReportMissing(r, pkg, needTrees, PackageFormat.TreesFile, "Trees");
                ReportMissing(r, pkg, needWater, PackageFormat.WaterFile, "Water sources (sea level from the manifest is still used)");
                ReportMissing(r, pkg, needClimate, PackageFormat.ClimateFile, "Climate seasons (lat/lon from the manifest selection is used)");
                ReportMissing(r, pkg, m_Opt.Terrain, PackageFormat.HeightmapFile, "Terrain heightmap");
                ReportMissing(r, pkg, m_Opt.WorldMap, PackageFormat.WorldmapFile, "World map");

                // Heavy JSON / binary parsing on a worker thread (pure code, no game access).
                LoadedFiles files = null;
                yield return RunAsync(() =>
                {
                    var f = new LoadedFiles();
                    if (needRoads && pkg.Has(PackageFormat.RoadsFile)) f.Roads = SafeRead(rep, PackageFormat.RoadsFile, () => pkg.ReadRoads(rep));
                    if (needTrees && pkg.Has(PackageFormat.TreesFile)) f.Trees = SafeRead(rep, PackageFormat.TreesFile, () => pkg.ReadTrees(rep));
                    if (pkg.Has(PackageFormat.WaterFile) && (needWater || needTrees)) f.Water = SafeRead(rep, PackageFormat.WaterFile, () => pkg.ReadWater(rep));
                    if (needClimate && pkg.Has(PackageFormat.ClimateFile)) f.Climate = SafeRead(rep, PackageFormat.ClimateFile, () => pkg.ReadClimate(rep));
                    return f;
                }, f => files = f);

                m_Roads = files.Roads;
                m_Trees = files.Trees;
                m_Water = files.Water;
                m_Climate = files.Climate;
                if (m_Roads != null) ImportLog.Info($"roads.json: {m_Roads.Nodes.Count} nodes, {m_Roads.Edges.Count} edges, {m_Roads.Edges.Count(e => !string.IsNullOrEmpty(e.Name))} named, {m_Roads.Nodes.Count(n => n.Outside)} outside-connection nodes");
                if (m_Trees != null) ImportLog.Info($"trees.bin: {m_Trees.Count} trees");
                if (m_Water != null) ImportLog.Info($"water.json: seaLevel={m_Water.SeaLevel} hasSea={m_Water.HasSea} sources={m_Water.Sources.Count}");
                if (m_Climate != null) ImportLog.Info($"climate.json: lat={m_Climate.Latitude} lon={m_Climate.Longitude} koppen={m_Climate.Koppen} seasons={m_Climate.Seasons.Count}");
            }

            int shown = 0;
            foreach (var w in rep.Warnings)
            {
                if (shown++ < 50) ImportLog.Warn("validation: " + w);
            }
            if (rep.Warnings.Count > 50) ImportLog.Warn($"validation: {rep.Warnings.Count - 50} more warnings not shown");
            r.Skip("validation warnings", rep.Warnings.Count);

            if (!rep.Ok)
            {
                foreach (var e in rep.Errors.Take(100)) ImportLog.Error("validation: " + e);
                if (rep.Errors.Count > 100) ImportLog.Error($"validation: {rep.Errors.Count - 100} more errors not shown");
                r.Fail("validation errors", rep.Errors.Count);
                r.Status = "failed";
                Abort($"package is invalid ({rep.Errors.Count} errors, first: {rep.Errors[0]})");
                yield break;
            }

            yield return WaitFrames.NextFrame;

            // Resolve prefabs.
            var missing = ResolvePrefabs(r);
            if (missing.Count > 0)
            {
                foreach (var name in missing) ImportLog.Error("missing prefab: " + name);
                r.Fail("missing prefabs", missing.Count);
                r.Status = "failed";
                Abort("prefabs not found in this game: " + string.Join(", ", missing) + ". See ModsData/CS2MapBuilder/prefabs.txt for the names that exist.");
                yield break;
            }
            r.Created = (m_NetPrefabByKey?.Count ?? 0) + (m_TreePrefabBySpecies?.Length ?? 0);
        }

        private static void ReportMissing(StepReport r, PackageReader pkg, bool needed, string file, string what)
        {
            if (needed && !pkg.Has(file)) r.Notes.Add($"{file} not in package: {what} skipped");
        }

        private static T SafeRead<T>(ValidationReport rep, string file, Func<T> read) where T : class
        {
            try { return read(); }
            catch (PackageException e) { rep.Errors.Add(e.Message); }
            catch (Exception e) { rep.Errors.Add($"{file}: {e.GetType().Name}: {e.Message}"); }
            return null;
        }

        /// <summary>Builds name -> entity tables from the prefab system and resolves the package's names, with fallbacks.</summary>
        private List<string> ResolvePrefabs(StepReport r)
        {
            var nets = new Dictionary<string, Entity>(StringComparer.Ordinal);
            var objects = new Dictionary<string, Entity>(StringComparer.Ordinal);
            var listing = new StringBuilder();
            using (var arr = m_PrefabQuery.ToEntityArray(Allocator.TempJob))
            {
                foreach (var e in arr)
                {
                    if (!m_PrefabSystem.TryGetPrefab<PrefabBase>(e, out var p) || p == null) continue;
                    if (p is NetPrefab)
                    {
                        if (!nets.ContainsKey(p.name)) nets[p.name] = e;
                        listing.Append("net\t").Append(p.GetType().Name).Append('\t').AppendLine(p.name);
                    }
                    else if (p is ObjectPrefab)
                    {
                        if (!objects.ContainsKey(p.name)) objects[p.name] = e;
                        if (EntityManager.HasComponent<TreeData>(e))
                            listing.Append("tree\t").Append(p.GetType().Name).Append('\t').AppendLine(p.name);
                    }
                    else if (p is ThemePrefab || p is Game.Prefabs.Climate.ClimatePrefab)
                    {
                        listing.Append(p is ThemePrefab ? "theme\t" : "climate\t").Append(p.GetType().Name).Append('\t').AppendLine(p.name);
                    }
                }
            }
            try { File.WriteAllText(Path.Combine(ModPaths.ModsData, "prefabs.txt"), listing.ToString()); } catch (Exception) { }
            ImportLog.Info($"Prefab tables: {nets.Count} net prefabs, {objects.Count} object prefabs (full list in prefabs.txt)");

            var missing = new List<string>();
            var m = m_Pkg.Manifest;

            m_NetPrefabByKey = new Dictionary<string, Entity>(StringComparer.Ordinal);
            if (m_Roads != null && m_Opt.Networks)
            {
                var usedKeys = new HashSet<string>(m_Roads.Edges.Select(e => e.Prefab));
                foreach (var key in usedKeys)
                {
                    if (!m.NetPrefabs.TryGetValue(key, out var gameName)) continue; // reported by validation
                    var resolved = PrefabFallbacks.Resolve(gameName, nets.ContainsKey, PrefabFallbacks.Net, out bool sub);
                    if (resolved == null) { missing.Add($"{gameName} (net '{key}')"); continue; }
                    if (sub)
                    {
                        r.Notes.Add($"net '{key}': '{gameName}' not found, using '{resolved}'");
                        ImportLog.Warn($"prefab substitution: '{gameName}' -> '{resolved}'");
                    }
                    m_NetPrefabByKey[key] = nets[resolved];
                }
            }

            m_TreePrefabBySpecies = new Entity[m.TreeSpecies.Count];
            if (m_Trees != null && m_Opt.Trees)
            {
                var used = new bool[m.TreeSpecies.Count];
                for (int i = 0; i < m_Trees.Count; i++) if (m_Trees.Species[i] < used.Length) used[m_Trees.Species[i]] = true;
                for (int s = 0; s < m.TreeSpecies.Count; s++)
                {
                    if (!used[s]) continue;
                    string species = m.TreeSpecies[s];
                    string gameName = m.TreePrefabs[species];
                    var resolved = PrefabFallbacks.Resolve(gameName, objects.ContainsKey, PrefabFallbacks.Tree, out bool sub);
                    if (resolved == null) { missing.Add($"{gameName} (tree '{species}')"); continue; }
                    if (sub)
                    {
                        r.Notes.Add($"tree '{species}': '{gameName}' not found, using '{resolved}'");
                        ImportLog.Warn($"prefab substitution: '{gameName}' -> '{resolved}'");
                    }
                    m_TreePrefabBySpecies[s] = objects[resolved];
                }
            }
            return missing;
        }
    }
}
