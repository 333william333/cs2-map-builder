using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

// Pure package model (format "cs2mapbuilder", version 1, see CONTRACT.md "M2 additions").
// No game or Unity dependencies in this namespace.
namespace CS2MapBuilder.Package
{
    public static class PackageFormat
    {
        public const string FormatId = "cs2mapbuilder";
        public const int SupportedVersion = 1;

        public const string ManifestFile = "manifest.json";
        public const string HeightmapFile = "heightmap.png";
        public const string WorldmapFile = "worldmap.png";
        public const string RoadsFile = "roads.json";
        public const string TreesFile = "trees.bin";
        public const string WaterFile = "water.json";
        public const string ClimateFile = "climate.json";
        public const string ResourcesDir = "resources";
        public static readonly string[] ResourceNames = { "fertile", "ore", "oil", "groundwater" };

        public const float PlayableHalf = 7168f;
        public const float WorldHalf = 28672f;
        public const int HeightmapSize = 4096;
        public const int ResourceSize = 256;
        public const int TileGrid = 23;
        public const float MinHeightScale = 200f;
        public const float MaxHeightScale = 10000f;
        public const float MaxSeaLevel = 2000f;
    }

    public sealed class Manifest
    {
        [JsonProperty("format")] public string Format;
        [JsonProperty("version")] public int Version;
        [JsonProperty("name")] public string Name;
        [JsonProperty("selection")] public SelectionInfo Selection;
        [JsonProperty("scale")] public ScaleInfo Scale;
        [JsonProperty("heightScale")] public float HeightScale;
        [JsonProperty("seaLevel")] public float SeaLevel;
        [JsonProperty("hasSea")] public bool HasSea;
        [JsonProperty("baseElevation")] public float BaseElevation;
        [JsonProperty("theme")] public string Theme;
        [JsonProperty("startTile")] public TileRef StartTile;
        [JsonProperty("counts")] public Counts Counts;
        [JsonProperty("netPrefabs")] public Dictionary<string, string> NetPrefabs = new Dictionary<string, string>();
        [JsonProperty("treePrefabs")] public Dictionary<string, string> TreePrefabs = new Dictionary<string, string>();
        [JsonProperty("treeSpecies")] public List<string> TreeSpecies = new List<string>();
        [JsonProperty("warnings")] public List<string> Warnings = new List<string>();
        /// <summary>String or array of strings; kept raw.</summary>
        [JsonProperty("attribution")] public JToken Attribution;
    }

    public sealed class SelectionInfo
    {
        [JsonProperty("centerLat")] public double CenterLat;
        [JsonProperty("centerLon")] public double CenterLon;
        [JsonProperty("sizeMeters")] public double SizeMeters;
        [JsonProperty("rotationDeg")] public double RotationDeg;
    }

    public sealed class ScaleInfo
    {
        [JsonProperty("horizontal")] public double Horizontal;
        [JsonProperty("vertical")] public double Vertical;
    }

    public sealed class TileRef
    {
        [JsonProperty("col")] public int Col;
        [JsonProperty("row")] public int Row;
    }

    public sealed class Counts
    {
        [JsonProperty("nodes")] public int Nodes;
        [JsonProperty("edges")] public int Edges;
        [JsonProperty("trees")] public int Trees;
        [JsonProperty("waterSources")] public int WaterSources;
    }

    // ------------------------------------------------------------------ roads.json

    public sealed class RoadNode
    {
        public int Id;
        public float X;   // game gx
        public float Z;   // game gz
        public float Elevation; // m above terrain, > 0 bridge, < 0 tunnel
        public bool Outside;
    }

    public sealed class RoadEdgeJson
    {
        [JsonProperty("id")] public int Id;
        [JsonProperty("a")] public int A;
        [JsonProperty("b")] public int B;
        [JsonProperty("cls")] public string Cls;
        [JsonProperty("prefab")] public string Prefab;
        [JsonProperty("oneway")] public bool Oneway;
        [JsonProperty("bridge")] public bool Bridge;
        [JsonProperty("tunnel")] public bool Tunnel;
        [JsonProperty("name")] public string Name;
        /// <summary>[x0, z0, x1, z1, x2, z2, x3, z3]</summary>
        [JsonProperty("bezier")] public double[] Bezier;
    }

    public sealed class RoadsJson
    {
        /// <summary>[[id, gx, gz, elevation, outside 0/1], ...]</summary>
        [JsonProperty("nodes")] public List<double[]> Nodes = new List<double[]>();
        [JsonProperty("edges")] public List<RoadEdgeJson> Edges = new List<RoadEdgeJson>();
    }

    public sealed class PackageRoads
    {
        public List<RoadNode> Nodes = new List<RoadNode>();
        public Dictionary<int, RoadNode> NodesById = new Dictionary<int, RoadNode>();
        public List<RoadEdgeJson> Edges = new List<RoadEdgeJson>();
    }

    // ------------------------------------------------------------------ trees.bin

    public sealed class PackageTrees
    {
        public int Count;
        /// <summary>[gx0, gz0, gx1, gz1, ...]</summary>
        public float[] XZ;
        /// <summary>index into Manifest.TreeSpecies</summary>
        public byte[] Species;
        /// <summary>0 young, 1 teen, 2 adult, 3 elderly, 4 dead</summary>
        public byte[] Age;
    }

    // ------------------------------------------------------------------ water.json

    public sealed class WaterJson
    {
        [JsonProperty("seaLevel")] public float SeaLevel;
        [JsonProperty("hasSea")] public bool HasSea;
        [JsonProperty("sources")] public List<WaterSourceJson> Sources = new List<WaterSourceJson>();
    }

    public sealed class WaterSourceJson
    {
        /// <summary>"borderRiver" | "river" | "lake"</summary>
        [JsonProperty("kind")] public string Kind;
        [JsonProperty("x")] public float X;
        [JsonProperty("z")] public float Z;
        [JsonProperty("radius")] public float Radius;
        /// <summary>game height of the water surface</summary>
        [JsonProperty("level")] public float Level;
        [JsonProperty("rate")] public float? Rate;
    }

    // ------------------------------------------------------------------ climate.json

    public sealed class ClimateJson
    {
        [JsonProperty("latitude")] public float Latitude;
        [JsonProperty("longitude")] public float Longitude;
        [JsonProperty("koppen")] public string Koppen;
        [JsonProperty("monthlyMeanC")] public float[] MonthlyMeanC;
        [JsonProperty("monthlyMinC")] public float[] MonthlyMinC;
        [JsonProperty("monthlyMaxC")] public float[] MonthlyMaxC;
        [JsonProperty("monthlyPrecipMm")] public float[] MonthlyPrecipMm;
        [JsonProperty("monthlyCloud")] public float[] MonthlyCloud;
        [JsonProperty("theme")] public string Theme;
        [JsonProperty("seasons")] public List<SeasonJson> Seasons = new List<SeasonJson>();
    }

    public sealed class SeasonJson
    {
        [JsonProperty("name")] public string Name;
        [JsonProperty("startMonth")] public float StartMonth;
        [JsonProperty("tempNightC")] public float TempNightC;
        [JsonProperty("tempDayC")] public float TempDayC;
        [JsonProperty("cloudChance")] public float CloudChance;
        [JsonProperty("precipChance")] public float PrecipChance;
    }

    // ------------------------------------------------------------------ images

    /// <summary>Greyscale image, values normalised to 0..65535, row 0 = top of the PNG.</summary>
    public sealed class GrayImage
    {
        public int Width;
        public int Height;
        public int SourceBitDepth;
        public ushort[] Data;

        public ushort this[int x, int y] => Data[y * Width + x];
    }
}
