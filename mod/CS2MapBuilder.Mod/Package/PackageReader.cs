using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;

namespace CS2MapBuilder.Package
{
    public sealed class PackageException : Exception
    {
        public PackageException(string message) : base(message) { }
        public PackageException(string message, Exception inner) : base(message, inner) { }
    }

    /// <summary>Errors abort the import; warnings are reported and the import continues.</summary>
    public sealed class ValidationReport
    {
        public readonly List<string> Errors = new List<string>();
        public readonly List<string> Warnings = new List<string>();
        public bool Ok => Errors.Count == 0;

        public void Error(string file, string message) => Errors.Add(file + ": " + message);
        public void Warn(string file, string message) => Warnings.Add(file + ": " + message);

        public override string ToString()
        {
            var sb = new StringBuilder();
            foreach (var e in Errors) sb.AppendLine("ERROR " + e);
            foreach (var w in Warnings) sb.AppendLine("WARN  " + w);
            return sb.ToString();
        }
    }

    /// <summary>
    /// Reads one package folder. The manifest is read eagerly by <see cref="Open"/>; every other file is read
    /// on demand (they can be large), so each import step only pays for what it uses. All methods are pure C#
    /// and thread-safe per instance, so heavy files can be read on a worker thread.
    /// </summary>
    public sealed class PackageReader
    {
        public string Folder { get; }
        public Manifest Manifest { get; private set; }

        private PackageReader(string folder) { Folder = folder; }

        public string PathOf(string file) => Path.Combine(Folder, file);
        public bool Has(string file) => File.Exists(PathOf(file));
        public string ResourcePath(string name) => Path.Combine(Folder, PackageFormat.ResourcesDir, name + ".png");

        /// <summary>Lists package folders (those containing a manifest.json) under the packages root.</summary>
        public static List<string> ListPackages(string packagesRoot)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(packagesRoot) || !Directory.Exists(packagesRoot)) return result;
            foreach (var dir in Directory.GetDirectories(packagesRoot))
            {
                if (File.Exists(Path.Combine(dir, PackageFormat.ManifestFile)))
                    result.Add(Path.GetFileName(dir));
            }
            result.Sort(StringComparer.OrdinalIgnoreCase);
            return result;
        }

        /// <summary>Opens a package and reads + validates its manifest. Throws PackageException on fatal problems.</summary>
        public static PackageReader Open(string folder, ValidationReport report)
        {
            if (!Directory.Exists(folder)) throw new PackageException("package folder not found: " + folder);
            var r = new PackageReader(folder);
            string mpath = r.PathOf(PackageFormat.ManifestFile);
            if (!File.Exists(mpath)) throw new PackageException(PackageFormat.ManifestFile + " not found in " + folder);
            r.Manifest = ReadJson<Manifest>(mpath, PackageFormat.ManifestFile);
            ValidateManifest(r.Manifest, report);
            return r;
        }

        // ------------------------------------------------------------------ JSON helpers

        public static T ReadJson<T>(string path, string fileForErrors)
        {
            string text;
            try { text = File.ReadAllText(path, Encoding.UTF8); }
            catch (Exception e) { throw new PackageException($"{fileForErrors}: cannot read ({e.Message})", e); }
            try
            {
                var settings = new JsonSerializerSettings
                {
                    MissingMemberHandling = MissingMemberHandling.Ignore,
                    FloatParseHandling = FloatParseHandling.Double,
                };
                var obj = JsonConvert.DeserializeObject<T>(text, settings);
                if (obj == null) throw new PackageException(fileForErrors + ": file is empty or 'null'");
                return obj;
            }
            catch (JsonException e)
            {
                throw new PackageException($"{fileForErrors}: invalid JSON ({e.Message})", e);
            }
        }

        // ------------------------------------------------------------------ manifest

        public static void ValidateManifest(Manifest m, ValidationReport rep)
        {
            const string F = PackageFormat.ManifestFile;
            if (m.Format != PackageFormat.FormatId)
                rep.Error(F, $"'format' is '{m.Format}', expected '{PackageFormat.FormatId}'");
            if (m.Version != PackageFormat.SupportedVersion)
                rep.Error(F, $"'version' is {m.Version}; this mod reads version {PackageFormat.SupportedVersion} only. Update the mod or re-export the package.");
            if (string.IsNullOrWhiteSpace(m.Name)) rep.Warn(F, "'name' is empty");
            if (!(m.HeightScale >= PackageFormat.MinHeightScale && m.HeightScale <= PackageFormat.MaxHeightScale))
                rep.Error(F, $"'heightScale' {m.HeightScale} is outside the editor range {PackageFormat.MinHeightScale}..{PackageFormat.MaxHeightScale}");
            if (!(m.SeaLevel >= 0 && m.SeaLevel <= PackageFormat.MaxSeaLevel))
                rep.Error(F, $"'seaLevel' {m.SeaLevel} is outside 0..{PackageFormat.MaxSeaLevel}");
            if (m.HasSea && m.SeaLevel > m.HeightScale)
                rep.Warn(F, $"'seaLevel' {m.SeaLevel} is above 'heightScale' {m.HeightScale}");
            if (m.StartTile != null && (m.StartTile.Col < 0 || m.StartTile.Col >= PackageFormat.TileGrid || m.StartTile.Row < 0 || m.StartTile.Row >= PackageFormat.TileGrid))
                rep.Error(F, $"'startTile' ({m.StartTile.Col},{m.StartTile.Row}) is outside the {PackageFormat.TileGrid}x{PackageFormat.TileGrid} grid");
            if (m.Counts == null) rep.Warn(F, "'counts' is missing; count checks are skipped");
            if (m.NetPrefabs == null) m.NetPrefabs = new Dictionary<string, string>();
            if (m.TreePrefabs == null) m.TreePrefabs = new Dictionary<string, string>();
            if (m.TreeSpecies == null) m.TreeSpecies = new List<string>();
            foreach (var kv in m.NetPrefabs)
                if (string.IsNullOrWhiteSpace(kv.Value)) rep.Error(F, $"netPrefabs['{kv.Key}'] is empty");
            foreach (var kv in m.TreePrefabs)
                if (string.IsNullOrWhiteSpace(kv.Value)) rep.Error(F, $"treePrefabs['{kv.Key}'] is empty");
            for (int i = 0; i < m.TreeSpecies.Count; i++)
                if (!m.TreePrefabs.ContainsKey(m.TreeSpecies[i] ?? ""))
                    rep.Error(F, $"treeSpecies[{i}] '{m.TreeSpecies[i]}' has no entry in treePrefabs");
        }

        // ------------------------------------------------------------------ roads.json

        public PackageRoads ReadRoads(ValidationReport rep)
        {
            const string F = PackageFormat.RoadsFile;
            var json = ReadJson<RoadsJson>(PathOf(F), F);
            var data = new PackageRoads();
            if (json.Nodes == null) json.Nodes = new List<double[]>();
            if (json.Edges == null) json.Edges = new List<RoadEdgeJson>();

            for (int i = 0; i < json.Nodes.Count; i++)
            {
                var n = json.Nodes[i];
                if (n == null || n.Length < 4)
                {
                    rep.Error(F, $"nodes[{i}] must be [id, gx, gz, elevation, outside]");
                    continue;
                }
                var node = new RoadNode
                {
                    Id = (int)n[0],
                    X = (float)n[1],
                    Z = (float)n[2],
                    Elevation = (float)n[3],
                    Outside = n.Length > 4 && n[4] != 0,
                };
                if (!IsFinite(node.X) || !IsFinite(node.Z) || !IsFinite(node.Elevation))
                {
                    rep.Error(F, $"nodes[{i}] (id {node.Id}) has a non-finite coordinate");
                    continue;
                }
                if (Math.Abs(node.X) > PackageFormat.PlayableHalf + 0.01f || Math.Abs(node.Z) > PackageFormat.PlayableHalf + 0.01f)
                    rep.Warn(F, $"node {node.Id} at ({node.X:0.0}, {node.Z:0.0}) is outside the playable area");
                if (data.NodesById.ContainsKey(node.Id))
                {
                    rep.Error(F, $"nodes[{i}]: duplicate node id {node.Id}");
                    continue;
                }
                data.NodesById[node.Id] = node;
                data.Nodes.Add(node);
            }

            var edgeIds = new HashSet<int>();
            for (int i = 0; i < json.Edges.Count; i++)
            {
                var e = json.Edges[i];
                if (e == null) { rep.Error(F, $"edges[{i}] is null"); continue; }
                string where = $"edges[{i}] (id {e.Id})";
                if (!edgeIds.Add(e.Id)) rep.Error(F, where + ": duplicate edge id");
                if (!data.NodesById.ContainsKey(e.A)) rep.Error(F, $"{where}: node a={e.A} does not exist");
                if (!data.NodesById.ContainsKey(e.B)) rep.Error(F, $"{where}: node b={e.B} does not exist");
                if (e.A == e.B) rep.Error(F, where + ": a and b are the same node");
                if (string.IsNullOrEmpty(e.Prefab)) rep.Error(F, where + ": 'prefab' is empty");
                if (e.Bezier == null || e.Bezier.Length != 8)
                {
                    rep.Error(F, where + ": 'bezier' must have 8 numbers [x0,z0,x1,z1,x2,z2,x3,z3]");
                }
                else
                {
                    bool finite = true;
                    foreach (var v in e.Bezier) finite &= IsFinite(v);
                    if (!finite) rep.Error(F, where + ": 'bezier' has a non-finite value");
                    else if (data.NodesById.TryGetValue(e.A, out var na) && data.NodesById.TryGetValue(e.B, out var nb))
                    {
                        double d0 = Dist(e.Bezier[0], e.Bezier[1], na.X, na.Z);
                        double d3 = Dist(e.Bezier[6], e.Bezier[7], nb.X, nb.Z);
                        if (d0 > 0.5 || d3 > 0.5)
                            rep.Warn(F, $"{where}: bezier endpoints are {d0:0.00} m / {d3:0.00} m from nodes a/b (the node positions are used)");
                        double chord = Dist(na.X, na.Z, nb.X, nb.Z);
                        if (chord < 1.0) rep.Error(F, $"{where}: nodes are {chord:0.00} m apart (degenerate edge)");
                    }
                }
                data.Edges.Add(e);
            }

            var c = Manifest?.Counts;
            if (c != null)
            {
                if (c.Nodes != data.Nodes.Count) rep.Warn(F, $"manifest counts.nodes={c.Nodes} but roads.json has {data.Nodes.Count}");
                if (c.Edges != data.Edges.Count) rep.Warn(F, $"manifest counts.edges={c.Edges} but roads.json has {data.Edges.Count}");
            }
            if (Manifest != null)
            {
                foreach (var key in data.Edges.Select(e => e.Prefab).Where(p => !string.IsNullOrEmpty(p)).Distinct())
                    if (!Manifest.NetPrefabs.ContainsKey(key))
                        rep.Error(F, $"edge prefab '{key}' has no entry in manifest netPrefabs");
            }
            return data;
        }

        // ------------------------------------------------------------------ trees.bin

        public PackageTrees ReadTrees(ValidationReport rep)
        {
            const string F = PackageFormat.TreesFile;
            byte[] b;
            try { b = File.ReadAllBytes(PathOf(F)); }
            catch (Exception e) { throw new PackageException($"{F}: cannot read ({e.Message})", e); }
            return ParseTrees(b, Manifest, rep);
        }

        public static PackageTrees ParseTrees(byte[] b, Manifest manifest, ValidationReport rep)
        {
            const string F = PackageFormat.TreesFile;
            if (b.Length < 12) throw new PackageException(F + ": file is shorter than its 12-byte header");
            if (b[0] != 'C' || b[1] != 'S' || b[2] != '2' || b[3] != 'T')
                throw new PackageException(F + ": bad magic (expected 'CS2T')");
            uint version = BitConverter.ToUInt32(b, 4);
            if (version != 1) throw new PackageException($"{F}: version {version} is not supported (expected 1)");
            uint count = BitConverter.ToUInt32(b, 8);
            long expected = 12L + count * 8L + count * 2L;
            if (b.Length != expected)
                throw new PackageException($"{F}: size is {b.Length} bytes, expected {expected} for {count} trees");
            if (!BitConverter.IsLittleEndian) throw new PackageException(F + ": big-endian hosts are not supported");

            int n = (int)count;
            var t = new PackageTrees { Count = n, XZ = new float[n * 2], Species = new byte[n], Age = new byte[n] };
            Buffer.BlockCopy(b, 12, t.XZ, 0, n * 8);
            Buffer.BlockCopy(b, 12 + n * 8, t.Species, 0, n);
            Buffer.BlockCopy(b, 12 + n * 9, t.Age, 0, n);

            int speciesCount = manifest?.TreeSpecies?.Count ?? 0;
            int badSpecies = 0, badAge = 0, badPos = 0;
            for (int i = 0; i < n; i++)
            {
                if (t.Species[i] >= speciesCount) badSpecies++;
                if (t.Age[i] > 4) badAge++;
                float x = t.XZ[2 * i], z = t.XZ[2 * i + 1];
                if (!IsFinite(x) || !IsFinite(z) || Math.Abs(x) > PackageFormat.WorldHalf || Math.Abs(z) > PackageFormat.WorldHalf) badPos++;
            }
            if (badSpecies > 0) rep.Error(F, $"{badSpecies} trees have a species index >= treeSpecies.Length ({speciesCount})");
            if (badAge > 0) rep.Warn(F, $"{badAge} trees have an age > 4 (clamped to 4)");
            if (badPos > 0) rep.Error(F, $"{badPos} trees have non-finite or out-of-world positions");
            if (manifest?.Counts != null && manifest.Counts.Trees != n)
                rep.Warn(F, $"manifest counts.trees={manifest.Counts.Trees} but trees.bin has {n}");
            return t;
        }

        // ------------------------------------------------------------------ water.json, climate.json

        public WaterJson ReadWater(ValidationReport rep)
        {
            const string F = PackageFormat.WaterFile;
            var w = ReadJson<WaterJson>(PathOf(F), F);
            if (w.Sources == null) w.Sources = new List<WaterSourceJson>();
            for (int i = 0; i < w.Sources.Count; i++)
            {
                var s = w.Sources[i];
                string where = $"sources[{i}]";
                if (s == null) { rep.Error(F, where + " is null"); continue; }
                if (s.Kind != "lake" && s.Kind != "river" && s.Kind != "borderRiver")
                    rep.Warn(F, $"{where}: unknown kind '{s.Kind}', treated as a lake");
                if (!(s.Radius > 0)) rep.Error(F, $"{where}: radius {s.Radius} must be > 0");
                if (Math.Abs(s.X) > PackageFormat.WorldHalf || Math.Abs(s.Z) > PackageFormat.WorldHalf)
                    rep.Error(F, $"{where}: position ({s.X},{s.Z}) is outside the world");
                if (!IsFinite(s.Level)) rep.Error(F, $"{where}: level is not finite");
            }
            if (Manifest != null)
            {
                if (Math.Abs(w.SeaLevel - Manifest.SeaLevel) > 0.01f)
                    rep.Warn(F, $"seaLevel {w.SeaLevel} differs from manifest seaLevel {Manifest.SeaLevel}; water.json wins");
                if (Manifest.Counts != null && Manifest.Counts.WaterSources != w.Sources.Count)
                    rep.Warn(F, $"manifest counts.waterSources={Manifest.Counts.WaterSources} but water.json has {w.Sources.Count}");
            }
            return w;
        }

        public ClimateJson ReadClimate(ValidationReport rep)
        {
            const string F = PackageFormat.ClimateFile;
            var c = ReadJson<ClimateJson>(PathOf(F), F);
            if (c.Latitude < -90 || c.Latitude > 90) rep.Error(F, $"latitude {c.Latitude} is outside -90..90");
            if (c.Longitude < -180 || c.Longitude > 180) rep.Error(F, $"longitude {c.Longitude} is outside -180..180");
            if (c.Seasons == null) c.Seasons = new List<SeasonJson>();
            if (c.Seasons.Count != 4) rep.Warn(F, $"expected 4 seasons, found {c.Seasons.Count}");
            return c;
        }

        // ------------------------------------------------------------------ images

        public GrayImage ReadHeightmap(string file, ValidationReport rep)
        {
            var img = PngCodec.DecodeFile(PathOf(file));
            if (img.Width != PackageFormat.HeightmapSize || img.Height != PackageFormat.HeightmapSize)
                throw new PackageException($"{file}: is {img.Width}x{img.Height}, must be {PackageFormat.HeightmapSize}x{PackageFormat.HeightmapSize}");
            if (img.SourceBitDepth != 16) rep.Warn(file, $"is {img.SourceBitDepth}-bit; 16-bit is expected (heights will be coarse)");
            return img;
        }

        public GrayImage ReadResource(string name, ValidationReport rep)
        {
            string file = PackageFormat.ResourcesDir + "/" + name + ".png";
            var img = PngCodec.DecodeFile(ResourcePath(name));
            if (img.Width != PackageFormat.ResourceSize || img.Height != PackageFormat.ResourceSize)
                rep.Warn(file, $"is {img.Width}x{img.Height}, expected {PackageFormat.ResourceSize}x{PackageFormat.ResourceSize}; it is resampled");
            return img;
        }

        // ------------------------------------------------------------------ helpers

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);
        private static bool IsFinite(float v) => !float.IsNaN(v) && !float.IsInfinity(v);
        private static double Dist(double x0, double z0, double x1, double z1)
        {
            double dx = x1 - x0, dz = z1 - z0;
            return Math.Sqrt(dx * dx + dz * dz);
        }
    }
}
