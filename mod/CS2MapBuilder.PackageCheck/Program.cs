using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using CS2MapBuilder.Package;
using Newtonsoft.Json;

namespace CS2MapBuilder.PackageCheck
{
    /// <summary>Out-of-game checks and test-package generators for the CS2 Map Builder importer.</summary>
    internal static class Program
    {
        private static int s_Failures;

        private static int Main(string[] args)
        {
            try
            {
                string cmd = args.Length > 0 ? args[0] : "selftest";
                switch (cmd)
                {
                    case "selftest": return SelfTest(args.Length > 1 ? args[1] : null);
                    case "check": return Check(Arg(args, 1, "package dir"));
                    case "make-marker": return MakeMarker(Arg(args, 1, "out dir"));
                    case "make-trees": return MakeTrees(Arg(args, 1, "out dir"), int.Parse(Arg(args, 2, "count")));
                    default:
                        Console.WriteLine("usage: PackageCheck selftest [sample-dir] | check <dir> | make-marker <out> | make-trees <out> <count>");
                        return 2;
                }
            }
            catch (Exception e)
            {
                Console.WriteLine("FATAL " + e);
                return 3;
            }
        }

        private static string Arg(string[] a, int i, string what)
        {
            if (a.Length <= i) throw new ArgumentException("missing argument: " + what);
            return a[i];
        }

        // ------------------------------------------------------------------ check

        /// <summary>Reads every file the mod would read and prints the validation report. Exit 1 on errors.</summary>
        private static int Check(string dir)
        {
            var rep = new ValidationReport();
            PackageReader pkg;
            try { pkg = PackageReader.Open(dir, rep); }
            catch (PackageException e) { Console.WriteLine("ERROR " + e.Message); return 1; }
            var m = pkg.Manifest;
            Console.WriteLine($"manifest: name={m.Name} version={m.Version} heightScale={m.HeightScale} seaLevel={m.SeaLevel} hasSea={m.HasSea} theme={m.Theme}");

            void Try(string file, Action a)
            {
                if (!pkg.Has(file)) { Console.WriteLine($"  {file}: not present (step skipped in game)"); return; }
                try { a(); } catch (PackageException e) { rep.Errors.Add(e.Message); }
            }

            Try(PackageFormat.RoadsFile, () =>
            {
                var r = pkg.ReadRoads(rep);
                var plan = ImportPlanning.PlanNetBatches(r, 20000);
                Console.WriteLine($"  roads: {r.Nodes.Count} nodes, {r.Edges.Count} edges, {plan.Count} frames planned at batch 20000");
                foreach (var b in plan) Console.WriteLine($"    frame tier={ImportPlanning.TierNames[b.Tier]} edges={b.EdgeIndices.Count} components={b.Components}");
            });
            Try(PackageFormat.TreesFile, () => { var t = pkg.ReadTrees(rep); Console.WriteLine($"  trees: {t.Count}"); });
            Try(PackageFormat.WaterFile, () => { var w = pkg.ReadWater(rep); Console.WriteLine($"  water: seaLevel={w.SeaLevel} hasSea={w.HasSea} sources={w.Sources.Count}"); });
            Try(PackageFormat.ClimateFile, () =>
            {
                var c = pkg.ReadClimate(rep);
                var notes = new List<string>();
                var seasons = ImportPlanning.NormaliseSeasons(c.Seasons, notes);
                Console.WriteLine($"  climate: lat={c.Latitude} lon={c.Longitude} {string.Join("; ", notes)}");
                foreach (var s in seasons) Console.WriteLine($"    {s.Name}: start {s.StartTime:0.000} night/day {s.TempNight}/{s.TempDay} clouds {s.CloudChance}% precip {s.PrecipChance}%");
            });
            Try(PackageFormat.HeightmapFile, () => { var h = pkg.ReadHeightmap(PackageFormat.HeightmapFile, rep); Console.WriteLine($"  heightmap: {h.Width}x{h.Height} {h.SourceBitDepth}-bit, NW pixel {h[0, 0]}, SE pixel {h[h.Width - 1, h.Height - 1]}"); });
            Try(PackageFormat.WorldmapFile, () => { var h = pkg.ReadHeightmap(PackageFormat.WorldmapFile, rep); Console.WriteLine($"  worldmap: {h.Width}x{h.Height} {h.SourceBitDepth}-bit"); });
            foreach (var name in PackageFormat.ResourceNames)
            {
                if (!File.Exists(pkg.ResourcePath(name))) { Console.WriteLine($"  resources/{name}.png: not present"); continue; }
                try { var img = pkg.ReadResource(name, rep); Console.WriteLine($"  resources/{name}.png: {img.Width}x{img.Height}"); }
                catch (PackageException e) { rep.Errors.Add(e.Message); }
            }
            Console.Write(rep.ToString());
            Console.WriteLine(rep.Ok ? "RESULT ok" : $"RESULT {rep.Errors.Count} error(s)");
            return rep.Ok ? 0 : 1;
        }

        // ------------------------------------------------------------------ selftest

        private static int SelfTest(string sampleDir)
        {
            Test("PNG 16-bit round trip", () =>
            {
                var data = new ushort[37 * 21];
                for (int i = 0; i < data.Length; i++) data[i] = (ushort)(i * 977 % 65536);
                var img = PngCodec.Decode(PngCodec.EncodeGray16(37, 21, data));
                Assert(img.Width == 37 && img.Height == 21 && img.SourceBitDepth == 16, "size/depth");
                Assert(img.Data.SequenceEqual(data), "pixels");
            });
            Test("PNG 8-bit round trip scales to 16-bit", () =>
            {
                var data = new byte[256];
                for (int i = 0; i < 256; i++) data[i] = (byte)i;
                var img = PngCodec.Decode(PngCodec.EncodeGray8(16, 16, data));
                Assert(img[0, 0] == 0 && img[15, 15] == 65535 && img[1, 0] == 257, "values");
            });
            Test("PNG rejects garbage", () => Throws<PackageException>(() => PngCodec.Decode(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9 })));
            Test("PNG decodes a filtered image (Sub/Up/Average/Paeth)", () =>
            {
                // 3x2 8-bit grey with filters 1 and 4, values computed by hand.
                var raw = new byte[] { 1, 10, 5, 5, 4, 3, 2, 1 }; // row0 Sub: 10,15,20 ; row1 Paeth: deltas 3,2,1
                var png = TestPng(3, 2, raw);
                var img = PngCodec.Decode(png);
                Assert(img[0, 0] == 10 * 257 && img[1, 0] == 15 * 257 && img[2, 0] == 20 * 257, "row 0 (Sub)");
                // Paeth: x0: a=0,b=10,c=0 -> pred 10 -> 13; x1: a=13,b=15,c=10 -> p=18 -> pred 15 -> 17; x2: a=17,b=20,c=15 -> p=22 -> pred 20 -> 21
                Assert(img[0, 1] == 13 * 257 && img[1, 1] == 17 * 257 && img[2, 1] == 21 * 257, "row 1 (Paeth)");
            });
            Test("trees.bin parse + validation", () =>
            {
                var m = new Manifest { TreeSpecies = new List<string> { "oak" }, TreePrefabs = new Dictionary<string, string> { { "oak", "OakTree01" } } };
                var bin = TreesBin(new float[] { 1, 2, 3, 4 }, new byte[] { 0, 0 }, new byte[] { 2, 9 });
                var rep = new ValidationReport();
                var t = PackageReader.ParseTrees(bin, m, rep);
                Assert(t.Count == 2 && t.XZ[3] == 4 && t.Age[0] == 2, "values");
                Assert(rep.Ok && rep.Warnings.Count == 1, "one age warning, no error");
                var bad = TreesBin(new float[] { 1, 2 }, new byte[] { 5 }, new byte[] { 0 });
                var rep2 = new ValidationReport();
                PackageReader.ParseTrees(bad, m, rep2);
                Assert(!rep2.Ok, "species out of range is an error");
                Throws<PackageException>(() => PackageReader.ParseTrees(bin.Take(bin.Length - 1).ToArray(), m, new ValidationReport()));
                var magic = (byte[])bin.Clone(); magic[0] = (byte)'X';
                Throws<PackageException>(() => PackageReader.ParseTrees(magic, m, new ValidationReport()));
            });
            Test("manifest version check", () =>
            {
                var rep = new ValidationReport();
                PackageReader.ValidateManifest(new Manifest { Format = "cs2mapbuilder", Version = 2, HeightScale = 1000 }, rep);
                Assert(rep.Errors.Any(e => e.Contains("version")), "version 2 rejected");
                var rep2 = new ValidationReport();
                PackageReader.ValidateManifest(new Manifest { Format = "other", Version = 1, HeightScale = 50, SeaLevel = 3000 }, rep2);
                Assert(rep2.Errors.Count == 3, "format, heightScale, seaLevel: " + string.Join(" | ", rep2.Errors));
            });
            Test("net planning keeps components whole and orders tiers", () =>
            {
                var roads = new PackageRoads();
                for (int i = 1; i <= 8; i++) { var n = new RoadNode { Id = i, X = i * 30, Z = 0 }; roads.Nodes.Add(n); roads.NodesById[i] = n; }
                void E(int id, int a, int b, string cls) => roads.Edges.Add(new RoadEdgeJson { Id = id, A = a, B = b, Cls = cls, Prefab = "p", Bezier = new double[8] });
                E(1, 1, 2, "residential"); E(2, 2, 3, "residential"); E(3, 3, 4, "residential"); // component of 3
                E(4, 5, 6, "residential");                                                       // component of 1
                E(5, 7, 8, "motorway");                                                          // tier 0
                E(6, 1, 5, "pedestrian");                                                        // tier 3
                var plan = ImportPlanning.PlanNetBatches(roads, 2);
                Assert(plan[0].Tier == 0 && plan[0].EdgeIndices.Count == 1, "motorway first");
                Assert(plan[1].Tier == 2 && plan[1].EdgeIndices.Count == 3, "3-edge component not split although batch is 2");
                Assert(plan[2].Tier == 2 && plan[2].EdgeIndices.Count == 1, "next component in the next frame");
                Assert(plan[3].Tier == 3, "paths last");
                var big = ImportPlanning.PlanNetBatches(roads, 100);
                Assert(big.Count == 3 && big[1].Components == 2, "both local components share one frame when they fit");
            });
            Test("prefab fallbacks", () =>
            {
                var have = new HashSet<string> { "Medium Road", "OakTree01" };
                Assert(PrefabFallbacks.Resolve("Medium Road", have.Contains, PrefabFallbacks.Net, out bool s1) == "Medium Road" && !s1, "direct");
                Assert(PrefabFallbacks.Resolve("Small Road", have.Contains, PrefabFallbacks.Net, out bool s2) == "Medium Road" && s2, "fallback");
                Assert(PrefabFallbacks.Resolve("NA_LindenTree01", have.Contains, PrefabFallbacks.Tree, out _) == "OakTree01", "tree fallback");
                Assert(PrefabFallbacks.Resolve("Nonexistent", have.Contains, PrefabFallbacks.Net, out _) == null, "missing");
            });
            Test("season normalisation", () =>
            {
                var notes = new List<string>();
                var s = ImportPlanning.NormaliseSeasons(new List<SeasonJson>
                {
                    new SeasonJson { Name = "winter", StartMonth = 12, CloudChance = 0.8f, PrecipChance = 0.5f },
                    new SeasonJson { Name = "spring", StartMonth = 3, CloudChance = 0.5f, PrecipChance = 0.3f },
                }, notes);
                Assert(s[0].Name == "spring" && Math.Abs(s[0].StartTime - 2f / 12f) < 1e-5, "1-based, sorted");
                Assert(Math.Abs(s[1].CloudChance - 80f) < 1e-3, "fractions scaled to percent");
            });
            Test("grid row mapping", () =>
            {
                Assert(ImportPlanning.PackageRowForGameRow(0, 4096, false) == 4095, "game row 0 (min z) = PNG bottom row");
                Assert(ImportPlanning.PackageRowForGameRow(0, 4096, true) == 0, "flipped");
                ImportPlanning.TileCenter(0, 0, out float x, out float z);
                Assert(x < -6800 && z > 6800, "tile (0,0) is top-left (NW)");
            });
            Test("z-order + subsample", () =>
            {
                var xz = new float[] { 1000, 1000, -1000, -1000, 1001, 1001, -999, -999 };
                var o = ImportPlanning.ZOrder(xz, 4);
                Assert(Math.Abs(Array.IndexOf(o, 0) - Array.IndexOf(o, 2)) == 1, "neighbours adjacent");
                Assert(ImportPlanning.Subsample(Enumerable.Range(0, 10).ToArray(), 5).SequenceEqual(new[] { 0, 2, 4, 6, 8 }), "even thinning");
            });

            if (sampleDir == null)
            {
                string guess = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "sample-package"));
                if (Directory.Exists(guess)) sampleDir = guess;
            }
            if (sampleDir != null)
            {
                Test("sample package reads without errors: " + sampleDir, () => Assert(Check(sampleDir) == 0, "check failed"));
            }
            else Console.WriteLine("SKIP sample package (pass its folder as argument)");

            Console.WriteLine(s_Failures == 0 ? "ALL TESTS PASSED" : $"{s_Failures} TEST(S) FAILED");
            return s_Failures == 0 ? 0 : 1;
        }

        private static void Test(string name, Action body)
        {
            try { body(); Console.WriteLine("PASS " + name); }
            catch (Exception e) { s_Failures++; Console.WriteLine("FAIL " + name + ": " + e.Message); }
        }

        private static void Assert(bool ok, string what) { if (!ok) throw new Exception("assertion failed: " + what); }

        private static void Throws<T>(Action a) where T : Exception
        {
            try { a(); }
            catch (T) { return; }
            throw new Exception("expected " + typeof(T).Name);
        }

        private static byte[] TestPng(int w, int h, byte[] filteredRaw)
        {
            // Build a PNG from already-filtered scanlines, reusing the encoder's chunk writer via an 8-bit encode then patching IDAT is
            // overkill; instead compress by hand.
            var ms = new MemoryStream();
            ms.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
            var ihdr = new byte[13];
            BE(ihdr, 0, w); BE(ihdr, 4, h); ihdr[8] = 8; ihdr[9] = 0;
            Chunk(ms, "IHDR", ihdr);
            var z = new MemoryStream();
            z.WriteByte(0x78); z.WriteByte(0x01);
            using (var ds = new System.IO.Compression.DeflateStream(z, System.IO.Compression.CompressionLevel.Optimal, true)) ds.Write(filteredRaw, 0, filteredRaw.Length);
            z.Write(new byte[4], 0, 4); // Adler ignored by the decoder
            Chunk(ms, "IDAT", z.ToArray());
            Chunk(ms, "IEND", new byte[0]);
            return ms.ToArray();
        }

        private static void Chunk(Stream s, string type, byte[] data)
        {
            var len = new byte[4]; BE(len, 0, data.Length);
            s.Write(len, 0, 4);
            s.Write(Encoding.ASCII.GetBytes(type), 0, 4);
            s.Write(data, 0, data.Length);
            s.Write(new byte[4], 0, 4); // CRC not checked by the decoder
        }

        private static void BE(byte[] b, int o, int v) { b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v; }

        private static byte[] TreesBin(float[] xz, byte[] species, byte[] age)
        {
            var ms = new MemoryStream();
            var bw = new BinaryWriter(ms);
            bw.Write(Encoding.ASCII.GetBytes("CS2T"));
            bw.Write((uint)1);
            bw.Write((uint)species.Length);
            foreach (var f in xz) bw.Write(f);
            bw.Write(species);
            bw.Write(age);
            return ms.ToArray();
        }

        // ------------------------------------------------------------------ generators

        private static object BaseManifest(string name, float heightScale, float seaLevel, bool hasSea, int trees, int water) => new
        {
            format = "cs2mapbuilder",
            version = 1,
            name,
            selection = new { centerLat = 59.8586, centerLon = 17.6389, sizeMeters = 14336, rotationDeg = 0 },
            scale = new { horizontal = 1.0, vertical = 1.0 },
            heightScale,
            seaLevel,
            hasSea,
            baseElevation = 0,
            theme = "european",
            startTile = new { col = 11, row = 11 },
            counts = new { nodes = 0, edges = 0, trees, waterSources = water },
            netPrefabs = new Dictionary<string, string>(),
            treePrefabs = new Dictionary<string, string> { { "birch", "BirchTree01" }, { "pine", "PineTree01" }, { "oak", "OakTree01" } },
            treeSpecies = new[] { "birch", "pine", "oak" },
            warnings = new string[0],
            attribution = "generated test package",
        };

        /// <summary>
        /// Terrain + water test package. heightScale 1000 m, base plain 100 m. Markers: NW corner plateau 400 m
        /// (900 x 900 m), NE corner block 250 m (450 x 450 m), a 40 m basin with a lake at x=+2000, z=0, and a 20 m
        /// strip along the south edge that the sea (level 50 m) floods.
        /// </summary>
        private static int MakeMarker(string dir)
        {
            Directory.CreateDirectory(dir);
            const int N = 4096;
            const float scale = 1000f;
            const float mPerPx = 14336f / N;
            var data = new ushort[N * N];
            ushort H(float m) => (ushort)Math.Round(Math.Max(0, Math.Min(scale, m)) / scale * 65535);
            for (int row = 0; row < N; row++)
            {
                float z = 7168f - (row + 0.5f) * mPerPx;
                for (int col = 0; col < N; col++)
                {
                    float x = -7168f + (col + 0.5f) * mPerPx;
                    float h = 100f;
                    if (x < -7168f + 900f && z > 7168f - 900f) h = 400f;                 // NW plateau
                    else if (x > 7168f - 450f && z > 7168f - 450f) h = 250f;             // NE block
                    else if (z < -7168f + 600f) h = 20f;                                  // south strip (sea)
                    float dx = x - 2000f, dz = z;
                    float d = (float)Math.Sqrt(dx * dx + dz * dz);
                    if (d < 400f) h = Math.Min(h, 100f - 40f * (float)Math.Cos(d / 400f * Math.PI / 2)); // basin, 60 m at centre
                    data[row * N + col] = H(h);
                }
            }
            File.WriteAllBytes(Path.Combine(dir, PackageFormat.HeightmapFile), PngCodec.EncodeGray16(N, N, data));
            var manifest = BaseManifest("marker-test", scale, 50f, true, 0, 1);
            File.WriteAllText(Path.Combine(dir, PackageFormat.ManifestFile), JsonConvert.SerializeObject(manifest, Formatting.Indented));
            var water = new { seaLevel = 50f, hasSea = true, sources = new[] { new { kind = "lake", x = 2000f, z = 0f, radius = 250f, level = 90f } } };
            File.WriteAllText(Path.Combine(dir, PackageFormat.WaterFile), JsonConvert.SerializeObject(water, Formatting.Indented));
            Console.WriteLine("wrote marker package to " + dir);
            return Check(dir);
        }

        /// <summary>Tree test package: count trees on a jittered grid in a 6 km square around the centre, three species.</summary>
        private static int MakeTrees(string dir, int count)
        {
            Directory.CreateDirectory(dir);
            var rnd = new Random(12345);
            int side = (int)Math.Ceiling(Math.Sqrt(count));
            float step = 6000f / side;
            var xz = new float[count * 2];
            var sp = new byte[count];
            var age = new byte[count];
            for (int i = 0; i < count; i++)
            {
                int gx = i % side, gz = i / side;
                xz[2 * i] = -3000f + (gx + (float)rnd.NextDouble()) * step;
                xz[2 * i + 1] = -3000f + (gz + (float)rnd.NextDouble()) * step;
                sp[i] = (byte)(i % 3);
                age[i] = (byte)rnd.Next(0, 5);
            }
            File.WriteAllBytes(Path.Combine(dir, PackageFormat.TreesFile), TreesBin(xz, sp, age));
            var manifest = BaseManifest("trees-" + count, 4096f, 0f, false, count, 0);
            File.WriteAllText(Path.Combine(dir, PackageFormat.ManifestFile), JsonConvert.SerializeObject(manifest, Formatting.Indented));
            Console.WriteLine($"wrote {count} trees to {dir}");
            return Check(dir);
        }
    }
}
