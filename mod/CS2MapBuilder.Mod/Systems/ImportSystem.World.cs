using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using Game.Common;
using Game.Prefabs;
using Game.Prefabs.Climate;
using Game.Simulation;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Experimental.Rendering;

namespace CS2MapBuilder.Systems
{
    public sealed partial class ImportSystem
    {
        // ================================================================== Terrain

        /// <summary>
        /// Step 2: SetTerrainProperties(heightScale) -> ReplaceWorldHeightmap -> ReplaceHeightmap (MOD_SPIKE 2, 10.2).
        /// Textures are built directly from the package PNGs as R16_UNorm, Unity row 0 = min z.
        /// </summary>
        private IEnumerator TerrainStep(StepReport r)
        {
            var m = m_Pkg.Manifest;
            bool doHeight = m_Opt.Terrain && m_Pkg.Has(PackageFormat.HeightmapFile);
            bool doWorld = m_Opt.WorldMap && m_Pkg.Has(PackageFormat.WorldmapFile);
            if (!doHeight && !doWorld)
            {
                r.Status = "skipped";
                r.Notes.Add("no heightmap.png / worldmap.png to import (or both disabled)");
                yield break;
            }

            var rep = new ValidationReport();
            GrayImage height = null, world = null;
            SetProgress(r, 0.05f, "decoding PNGs");
            yield return RunAsync(() =>
            {
                var h = doHeight ? m_Pkg.ReadHeightmap(PackageFormat.HeightmapFile, rep) : null;
                var w = doWorld ? m_Pkg.ReadHeightmap(PackageFormat.WorldmapFile, rep) : null;
                return new[] { h, w };
            }, res => { height = res[0]; world = res[1]; });
            foreach (var w in rep.Warnings) r.Notes.Add(w);

            float2 before = m_TerrainSystem.heightScaleOffset;
            m_TerrainSystem.SetTerrainProperties(new float2(m.HeightScale, 0f));
            r.Notes.Add($"height scale/offset {before.x}/{before.y} -> {m_TerrainSystem.heightScaleOffset.x}/{m_TerrainSystem.heightScaleOffset.y}");
            yield return WaitFrames.NextFrame;

            if (world != null)
            {
                SetProgress(r, 0.3f, "world map");
                var tex = MakeHeightTexture(world, m_Opt.FlipRows, "CS2MapBuilder World");
                if (!TerrainSystem.IsValidHeightmapFormat(tex))
                {
                    r.Fail("world map texture format rejected by TerrainSystem.IsValidHeightmapFormat");
                    UnityEngine.Object.Destroy(tex);
                }
                else
                {
                    m_TerrainSystem.ReplaceWorldHeightmap(tex);
                    // The terrain system keeps the texture itself outside the editor; only destroy it if it was copied.
                    if (!ReferenceEquals(m_TerrainSystem.worldHeightmap, tex)) UnityEngine.Object.Destroy(tex);
                    r.Created++;
                    ImportLog.Info("World heightmap replaced.");
                }
                yield return new WaitFrames(m_Opt.WaitFrames);
            }

            if (height != null)
            {
                SetProgress(r, 0.6f, "heightmap");
                var tex = MakeHeightTexture(height, m_Opt.FlipRows, "CS2MapBuilder Heightmap");
                if (!TerrainSystem.IsValidHeightmapFormat(tex))
                {
                    r.Fail("heightmap texture format rejected by TerrainSystem.IsValidHeightmapFormat");
                }
                else
                {
                    m_TerrainSystem.ReplaceHeightmap(tex);
                    r.Created++;
                    ImportLog.Info("Playable heightmap replaced.");
                }
                UnityEngine.Object.Destroy(tex);
                yield return new WaitFrames(m_Opt.WaitFrames);

                // Report what the game now has at known points: answers the north and height-mapping questions (MOD_SPIKE 11.1/11.2).
                var data = m_TerrainSystem.GetHeightData(true);
                if (data.isCreated)
                {
                    float c = 7168f - 300f;
                    LogHeightProbe(r, data, height, "centre", 0f, 0f);
                    LogHeightProbe(r, data, height, "NW (x-, z+)", -c, c);
                    LogHeightProbe(r, data, height, "NE (x+, z+)", c, c);
                    LogHeightProbe(r, data, height, "SW (x-, z-)", -c, -c);
                    LogHeightProbe(r, data, height, "SE (x+, z-)", c, -c);
                }
                else r.Notes.Add("terrain height data not available for the probe");
            }

            if (height != null && world != null) CompareWorldCentre(r, height, world);
        }

        private Texture2D MakeHeightTexture(GrayImage img, bool flip, string name)
        {
            int size = img.Width;
            var data = new ushort[size * size];
            for (int row = 0; row < size; row++)
            {
                int src = ImportPlanning.PackageRowForGameRow(row, size, flip) * size;
                Array.Copy(img.Data, src, data, row * size, size);
            }
            var tex = new Texture2D(size, size, GraphicsFormat.R16_UNorm, TextureCreationFlags.None) { name = name };
            tex.SetPixelData(data, 0);
            tex.Apply(false, false);
            return tex;
        }

        private void LogHeightProbe(StepReport r, TerrainHeightData data, GrayImage img, string label, float x, float z)
        {
            float game = TerrainUtils.SampleHeight(ref data, new float3(x, 0f, z));
            int col = Mathf.Clamp((int)((x + 7168f) / 14336f * img.Width), 0, img.Width - 1);
            int row = Mathf.Clamp((int)((7168f - z) / 14336f * img.Height), 0, img.Height - 1);
            float expected = img[col, row] / 65535f * m_Pkg.Manifest.HeightScale;
            string msg = $"height probe {label} at ({x:0},{z:0}): game {game:0.0} m, package {expected:0.0} m (PNG col {col}, row {row})";
            r.Notes.Add(msg);
        }

        private void CompareWorldCentre(StepReport r, GrayImage height, GrayImage world)
        {
            // World map centre 1024x1024 should equal the playable map downsampled 4x (MOD_SPIKE 1).
            double sum = 0; int n = 0;
            for (int j = 0; j < 64; j++)
                for (int i = 0; i < 64; i++)
                {
                    int hx = i * 64 + 32, hy = j * 64 + 32;
                    int wx = 1536 + hx / 4, wy = 1536 + hy / 4;
                    sum += Math.Abs(height[hx, hy] - world[wx, wy]) / 65535.0 * m_Pkg.Manifest.HeightScale;
                    n++;
                }
            r.Notes.Add($"world map centre vs heightmap: mean difference {sum / n:0.00} m over {n} samples");
        }

        // ================================================================== Climate, theme, lat/lon

        /// <summary>
        /// Step 3: clones the current ClimatePrefab (as the editor's Duplicate does), applies seasons and lat/lon,
        /// rebuilds the curves, makes it current; sets the default theme.
        /// </summary>
        private IEnumerator ClimateStep(StepReport r)
        {
            var m = m_Pkg.Manifest;
            float lat = m_Climate?.Latitude ?? (float)(m.Selection?.CenterLat ?? double.NaN);
            float lon = m_Climate?.Longitude ?? (float)(m.Selection?.CenterLon ?? double.NaN);

            try
            {
                Entity current = m_ClimateSystem.currentClimate;
                if (current == Entity.Null || !EntityManager.Exists(current)) throw new InvalidOperationException("no current climate");
                var baseClimate = m_PrefabSystem.GetPrefab<ClimatePrefab>(current);
                var clone = (ClimatePrefab)baseClimate.Clone("CS2MapBuilder " + (string.IsNullOrEmpty(m.Name) ? m_PackageName : m.Name));
                r.Notes.Add($"base climate '{baseClimate.name}' cloned as '{clone.name}'");
                if (!float.IsNaN(lat)) clone.m_Latitude = Mathf.Clamp(lat, -90f, 90f);
                if (!float.IsNaN(lon)) clone.m_Longitude = Mathf.Clamp(lon, -180f, 180f);

                if (m_Climate != null && m_Climate.Seasons.Count > 0)
                {
                    var notes = new List<string>();
                    var seasons = ImportPlanning.NormaliseSeasons(m_Climate.Seasons, notes);
                    r.Notes.AddRange(notes);
                    var target = clone.m_Seasons ?? new ClimateSystem.SeasonInfo[0];
                    var ordered = target.Where(s => s != null).OrderBy(s => s.m_StartTime).ToArray();
                    int n = Math.Min(ordered.Length, seasons.Count);
                    for (int i = 0; i < n; i++)
                    {
                        var dst = ordered[i];
                        var src = seasons[i];
                        dst.m_StartTime = src.StartTime;
                        dst.m_TempNightDay = new float2(src.TempNight, src.TempDay);
                        dst.m_CloudChance = src.CloudChance;
                        dst.m_PrecipitationChance = src.PrecipChance;
                        r.Notes.Add($"season '{dst.name}' <- '{src.Name}': start {src.StartTime:0.000}, night/day {src.TempNight:0.0}/{src.TempDay:0.0} C, clouds {src.CloudChance:0}%, precip {src.PrecipChance:0}%");
                    }
                    if (ordered.Length != seasons.Count)
                        r.Notes.Add($"climate has {ordered.Length} seasons, package {seasons.Count}; {n} applied in start-time order");
                }
                clone.RebuildCurves();
                if (!m_PrefabSystem.AddPrefab(clone)) throw new InvalidOperationException("PrefabSystem.AddPrefab returned false for the climate clone");
                m_ClimateSystem.currentClimate = m_PrefabSystem.GetEntity(clone);
                m_PlanetarySystem.latitude = clone.m_Latitude;
                m_PlanetarySystem.longitude = clone.m_Longitude;
                r.Created++;
                r.Notes.Add($"climate set: lat {clone.m_Latitude:0.0000}, lon {clone.m_Longitude:0.0000}");
            }
            catch (Exception e)
            {
                r.Fail("climate: " + e.Message);
                ImportLog.Error("Climate could not be set", e);
                if (!float.IsNaN(lat) && !float.IsNaN(lon))
                {
                    // Not persisted in the map (MOD_SPIKE 6), but visible in this session.
                    m_PlanetarySystem.latitude = lat;
                    m_PlanetarySystem.longitude = lon;
                    r.Notes.Add("lat/lon set on PlanetarySystem only (not saved with the map)");
                }
            }
            yield return WaitFrames.NextFrame;

            // Theme
            string theme = !string.IsNullOrEmpty(m.Theme) ? m.Theme : m_Climate?.Theme;
            if (!string.IsNullOrEmpty(theme))
            {
                string want = theme.IndexOf("north", StringComparison.OrdinalIgnoreCase) >= 0 ? "North American" : "European";
                Entity found = Entity.Null;
                var names = new List<string>();
                using (var arr = m_PrefabQuery.ToEntityArray(Allocator.TempJob))
                {
                    foreach (var e in arr)
                    {
                        if (!m_PrefabSystem.TryGetPrefab<ThemePrefab>(e, out var t) || t == null) continue;
                        names.Add(t.name);
                        if (found == Entity.Null && t.name.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) found = e;
                    }
                }
                if (found != Entity.Null)
                {
                    m_CityConfigurationSystem.defaultTheme = found;
                    r.Created++;
                    r.Notes.Add($"theme '{theme}' -> '{want}'");
                }
                else r.Fail($"theme '{want}' not found (themes: {string.Join(", ", names)})");
            }
        }

        // ================================================================== Water

        private sealed class RampedSource { public Entity Entity; public float Radius; }

        /// <summary>
        /// Step 4: global sea level + ResetToSealevel, then constant-level water sources. In the 1.6 water system
        /// a source fills to Transform.y + m_Height (WaterSimulation.SourceStep), so Transform.y is the ground and
        /// m_Height = level - ground.
        /// </summary>
        private IEnumerator WaterStep(StepReport r)
        {
            var m = m_Pkg.Manifest;
            float seaLevel = m_Water?.SeaLevel ?? m.SeaLevel;
            bool hasSea = m_Water?.HasSea ?? m.HasSea;

            if (m_WaterSystem.UseLegacyWaterSources)
                r.Notes.Add("WARNING: this map uses LEGACY water sources. Press 'Upgrade water sources' in the editor's Water panel and import again for correct lakes.");

            if (m_Opt.SetSeaLevel)
            {
                float before = m_WaterSystem.SeaLevel;
                float target = hasSea ? Mathf.Clamp(seaLevel, 0f, WaterSystem.kMaxSeaLevel) : 0f;
                m_WaterSystem.SeaLevel = target;
                m_WaterSystem.ResetToSealevel();
                m_AppliedSeaLevel = target;
                r.Notes.Add($"sea level {before:0.0} -> {target:0.0} (hasSea={hasSea})");
            }
            else
            {
                m_AppliedSeaLevel = m_WaterSystem.SeaLevel;
                r.Notes.Add("sea level left unchanged (setting off): " + m_AppliedSeaLevel);
            }
            yield return WaitFrames.NextFrame;

            if (m_Water == null || m_Water.Sources.Count == 0)
            {
                r.Notes.Add("no water sources in the package");
                yield break;
            }

            var data = m_TerrainSystem.GetHeightData(true);
            if (!data.isCreated) throw new InvalidOperationException("terrain height data not available");
            var ramp = new List<RampedSource>();
            float startFactor = m_Opt.WaterRamp > 0 ? 0.1f : 1f;
            foreach (var s in m_Water.Sources)
            {
                if (s == null || !(s.Radius > 0)) { r.Skip("invalid source"); continue; }
                float ground = TerrainUtils.SampleHeight(ref data, new float3(s.X, 0f, s.Z));
                float depth = s.Level - ground;
                if (depth < 1f)
                {
                    r.Notes.Add($"{s.Kind} at ({s.X:0},{s.Z:0}): level {s.Level:0.0} is {(-depth):0.0} m below/near ground {ground:0.0}; depth clamped to 1 m (is the bed carved?)");
                    depth = 1f;
                }
                Entity e;
                using (var one = EntityManager.CreateEntity(m_WaterSourceArchetype, 1, Allocator.Temp)) e = one[0];
                EntityManager.SetComponentData(e, new Game.Simulation.WaterSourceData
                {
                    m_ConstantDepth = s.Kind == "lake" ? 1 : 2, // legacy type: 1 lake (constant level), 2 river; unused by the new simulation
                    m_Radius = s.Radius * startFactor,
                    m_Height = depth,
                    m_Multiplier = 1f,
                    m_Polluted = 0f,            // > 0 would make it a flow source in the new simulation
                    m_Id = -1,
                    m_Modifier = 1f,
                });
                EntityManager.SetComponentData(e, new Game.Objects.Transform { m_Position = new float3(s.X, ground, s.Z), m_Rotation = quaternion.identity });
                m_Record.WaterSources.Add(e);
                ramp.Add(new RampedSource { Entity = e, Radius = s.Radius });
                r.Created++;
            }
            ImportLog.Info($"Water: {r.Created} sources created" + (m_Opt.WaterRamp > 0 ? $", ramping radius over {m_Opt.WaterRamp} frames" : ""));

            for (int f = 1; f <= m_Opt.WaterRamp; f++)
            {
                if (m_CancelRequested) yield break;
                float k = 0.1f + 0.9f * f / m_Opt.WaterRamp;
                foreach (var s in ramp)
                {
                    if (!EntityManager.Exists(s.Entity)) continue;
                    var d = EntityManager.GetComponentData<Game.Simulation.WaterSourceData>(s.Entity);
                    d.m_Radius = s.Radius * k;
                    EntityManager.SetComponentData(s.Entity, d);
                }
                if ((f & 15) == 0) SetProgress(r, (float)f / m_Opt.WaterRamp, "ramping water sources");
                yield return WaitFrames.NextFrame;
            }
        }

        // ================================================================== Resources

        /// <summary>Step 5: writes the 256x256 cell maps like the editor's ResourcePanelSystem.ApplyTexture (white = 10000).</summary>
        private IEnumerator ResourcesStep(StepReport r)
        {
            var rep = new ValidationReport();
            var images = new Dictionary<string, GrayImage>();
            yield return RunAsync(() =>
            {
                var d = new Dictionary<string, GrayImage>();
                foreach (var name in PackageFormat.ResourceNames)
                    if (System.IO.File.Exists(m_Pkg.ResourcePath(name))) d[name] = m_Pkg.ReadResource(name, rep);
                return d;
            }, d => images = d);
            foreach (var w in rep.Warnings) r.Notes.Add(w);
            foreach (var name in PackageFormat.ResourceNames)
                if (!images.ContainsKey(name)) r.Skip("missing resources/" + name + ".png");
            if (images.Count == 0) { r.Status = "skipped"; yield break; }

            bool natural = images.ContainsKey("fertile") || images.ContainsKey("ore") || images.ContainsKey("oil");
            if (natural)
            {
                var data = m_NaturalResourceSystem.GetData(false, out JobHandle deps);
                deps.Complete();
                int size = data.m_TextureSize.x;
                images.TryGetValue("fertile", out var fert);
                images.TryGetValue("ore", out var ore);
                images.TryGetValue("oil", out var oil);
                for (int y = 0; y < data.m_TextureSize.y; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        int i = y * size + x;
                        var cell = data.m_Buffer[i];
                        if (fert != null) cell.m_Fertility.m_Base = Amount(fert, x, y, size, 10000);
                        if (ore != null) cell.m_Ore.m_Base = Amount(ore, x, y, size, 10000);
                        if (oil != null) cell.m_Oil.m_Base = Amount(oil, x, y, size, 10000);
                        data.m_Buffer[i] = cell;
                    }
                }
                r.Created += (fert != null ? 1 : 0) + (ore != null ? 1 : 0) + (oil != null ? 1 : 0);
            }
            yield return WaitFrames.NextFrame;

            if (images.TryGetValue("groundwater", out var gw))
            {
                var data = m_GroundWaterSystem.GetData(false, out JobHandle deps);
                deps.Complete();
                int size = data.m_TextureSize.x;
                for (int y = 0; y < data.m_TextureSize.y; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        short v = (short)Amount(gw, x, y, size, 10000);
                        data.m_Buffer[y * size + x] = new GroundWater { m_Amount = v, m_Max = v };
                    }
                }
                r.Created++;
            }

            if (!m_MapFeatureQuery.IsEmptyIgnoreFilter) EntityManager.AddComponent<Updated>(m_MapFeatureQuery);
        }

        /// <summary>Package value (row 0 = top) at game cell (x, y) (row 0 = min z), scaled to 0..max.</summary>
        private ushort Amount(GrayImage img, int x, int y, int size, int max)
        {
            int prow = ImportPlanning.PackageRowForGameRow(y, size, m_Opt.FlipRows);
            int sx = Math.Min(img.Width - 1, x * img.Width / size);
            int sy = Math.Min(img.Height - 1, prow * img.Height / size);
            return (ushort)Mathf.RoundToInt(img[sx, sy] / 65535f * max);
        }
    }
}
