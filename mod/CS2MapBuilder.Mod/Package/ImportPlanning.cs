using System;
using System.Collections.Generic;
using System.Linq;

namespace CS2MapBuilder.Package
{
    /// <summary>One frame's worth of network definitions: whole connected components of one class tier.</summary>
    public sealed class NetBatch
    {
        public int Tier;
        public int Components;
        public readonly List<int> EdgeIndices = new List<int>();
    }

    /// <summary>
    /// Pure planning helpers for the import (testable outside the game).
    /// Network order follows MOD_SPIKE 10.6: (a) highways and rail, (b) arterials, (c) local roads, (d) paths.
    /// Within a tier, connected components are never split across frames (MOD_SPIKE 3.2: free ends merge
    /// reliably only within one frame's definitions).
    /// </summary>
    public static class ImportPlanning
    {
        public static readonly string[] TierNames = { "highways+rail", "arterials", "local", "paths" };

        public static int TierOf(string cls)
        {
            switch (cls)
            {
                case "motorway":
                case "trunk":
                case "rail":
                    return 0;
                case "primary":
                case "secondary":
                case "subway":
                    return 1;
                case "tertiary":
                case "residential":
                case "service":
                case "tram":
                    return 2;
                case "pedestrian":
                    return 3;
                default:
                    return 2;
            }
        }

        /// <summary>
        /// Groups edges by tier, then by connected component (within the tier), then packs whole components
        /// into batches of at most <paramref name="batchSize"/> edges. A component larger than the batch size
        /// becomes one batch on its own (it is never split).
        /// </summary>
        public static List<NetBatch> PlanNetBatches(PackageRoads roads, int batchSize, Func<RoadEdgeJson, bool> include = null)
        {
            if (batchSize < 1) batchSize = 1;
            var result = new List<NetBatch>();
            for (int tier = 0; tier < TierNames.Length; tier++)
            {
                var edges = new List<int>();
                for (int i = 0; i < roads.Edges.Count; i++)
                {
                    var e = roads.Edges[i];
                    if (TierOf(e.Cls) != tier) continue;
                    if (include != null && !include(e)) continue;
                    edges.Add(i);
                }
                if (edges.Count == 0) continue;

                var uf = new UnionFind();
                foreach (int i in edges) uf.Union(roads.Edges[i].A, roads.Edges[i].B);
                var comps = new Dictionary<int, List<int>>();
                var order = new List<int>();
                foreach (int i in edges)
                {
                    int root = uf.Find(roads.Edges[i].A);
                    if (!comps.TryGetValue(root, out var list))
                    {
                        list = new List<int>();
                        comps[root] = list;
                        order.Add(root);
                    }
                    list.Add(i);
                }

                NetBatch cur = null;
                foreach (int root in order)
                {
                    var comp = comps[root];
                    if (cur != null && cur.EdgeIndices.Count + comp.Count > batchSize)
                    {
                        result.Add(cur);
                        cur = null;
                    }
                    if (cur == null) cur = new NetBatch { Tier = tier };
                    cur.EdgeIndices.AddRange(comp);
                    cur.Components++;
                }
                if (cur != null) result.Add(cur);
            }
            return result;
        }

        /// <summary>Indices of trees in Z-order (Morton) of their position, so consecutive chunks are spatially compact.</summary>
        public static int[] ZOrder(float[] xz, int count)
        {
            var keys = new ulong[count];
            var idx = new int[count];
            for (int i = 0; i < count; i++)
            {
                uint qx = Quantize(xz[2 * i]);
                uint qz = Quantize(xz[2 * i + 1]);
                keys[i] = Interleave(qx, qz);
                idx[i] = i;
            }
            Array.Sort(keys, idx);
            return idx;
        }

        /// <summary>Evenly subsamples an ordered index list down to <paramref name="max"/> entries.</summary>
        public static int[] Subsample(int[] ordered, int max)
        {
            if (max <= 0 || ordered.Length <= max) return ordered;
            var r = new int[max];
            double step = (double)ordered.Length / max;
            for (int i = 0; i < max; i++) r[i] = ordered[(int)(i * step)];
            return r;
        }

        private static uint Quantize(float v)
        {
            double t = (v + PackageFormat.WorldHalf) / (2.0 * PackageFormat.WorldHalf);
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            return (uint)(t * 65535.0);
        }

        private static ulong Interleave(uint x, uint z)
        {
            ulong r = 0;
            for (int b = 0; b < 16; b++)
            {
                r |= (ulong)((x >> b) & 1) << (2 * b);
                r |= (ulong)((z >> b) & 1) << (2 * b + 1);
            }
            return r;
        }

        // ------------------------------------------------------------------ tree age

        /// <summary>
        /// Package age (0 young, 1 teen, 2 adult, 3 elderly, 4 dead) to the game's normalised age, using the middle
        /// of each phase from ObjectUtils.TREE_AGE_PHASE_* (child 0.1, teen 0.15, adult 0.35, elderly 0.35, dead 0.05).
        /// </summary>
        public static float TreeAge(byte age)
        {
            switch (age)
            {
                case 0: return 0.05f;
                case 1: return 0.175f;
                case 2: return 0.425f;
                case 3: return 0.775f;
                default: return 0.975f;
            }
        }

        // ------------------------------------------------------------------ climate

        public sealed class SeasonValues
        {
            public string Name;
            public float StartTime;       // 0..1 of the year
            public float TempNight, TempDay;
            public float CloudChance;     // 0..100
            public float PrecipChance;    // 0..100
        }

        /// <summary>
        /// Normalises climate.json seasons to the game's units. startMonth may be 0- or 1-based and chances may be
        /// 0..1 or 0..100; both are detected and reported in <paramref name="notes"/>.
        /// </summary>
        public static List<SeasonValues> NormaliseSeasons(List<SeasonJson> seasons, List<string> notes)
        {
            var r = new List<SeasonValues>();
            if (seasons == null || seasons.Count == 0) return r;
            bool zeroBased = seasons.Any(s => s.StartMonth < 1f);
            bool fractionChances = seasons.All(s => s.CloudChance <= 1f && s.PrecipChance <= 1f);
            notes?.Add($"climate: startMonth read as {(zeroBased ? "0-based" : "1-based")}, chances read as {(fractionChances ? "0..1 (scaled to %)" : "percent")}");
            foreach (var s in seasons)
            {
                float m = zeroBased ? s.StartMonth : s.StartMonth - 1f;
                float k = fractionChances ? 100f : 1f;
                r.Add(new SeasonValues
                {
                    Name = s.Name,
                    StartTime = Clamp(m / 12f, 0f, 0.999f),
                    TempNight = Clamp(s.TempNightC, -70f, 70f),
                    TempDay = Clamp(s.TempDayC, -70f, 70f),
                    CloudChance = Clamp(s.CloudChance * k, 0f, 100f),
                    PrecipChance = Clamp(s.PrecipChance * k, 0f, 100f),
                });
            }
            r.Sort((a, b) => a.StartTime.CompareTo(b.StartTime));
            return r;
        }

        public static float Clamp(float v, float lo, float hi) => v < lo ? lo : (v > hi ? hi : v);

        // ------------------------------------------------------------------ grids

        /// <summary>
        /// Package grids are row 0 = top (max z). Game cell maps and Unity textures are row 0 = min z.
        /// Returns the package row to read for game row <paramref name="gameRow"/> of a grid of <paramref name="size"/>.
        /// <paramref name="flip"/> = the "flip heightmap rows" setting (compensates if north turns out to be wrong).
        /// </summary>
        public static int PackageRowForGameRow(int gameRow, int size, bool flip) => flip ? gameRow : size - 1 - gameRow;

        /// <summary>Centre of a 23x23 map tile in game metres (row 0 = top = max z).</summary>
        public static void TileCenter(int col, int row, out float x, out float z)
        {
            float cell = 2f * PackageFormat.PlayableHalf / PackageFormat.TileGrid;
            x = -PackageFormat.PlayableHalf + (col + 0.5f) * cell;
            z = PackageFormat.PlayableHalf - (row + 0.5f) * cell;
        }

        private sealed class UnionFind
        {
            private readonly Dictionary<int, int> m_Parent = new Dictionary<int, int>();

            public int Find(int x)
            {
                if (!m_Parent.ContainsKey(x)) { m_Parent[x] = x; return x; }
                int root = x;
                while (m_Parent[root] != root) root = m_Parent[root];
                while (x != root)
                {
                    int next = m_Parent[x];
                    m_Parent[x] = root;
                    x = next;
                }
                return root;
            }

            public void Union(int a, int b)
            {
                int ra = Find(a), rb = Find(b);
                if (ra != rb) m_Parent[ra] = rb;
            }
        }
    }
}
