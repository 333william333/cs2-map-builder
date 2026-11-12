# CS2 importer mod: feasibility spike

Date: 2026-11-12. Game on this machine: **1.6.4f1 (1097.158a)**, Unity runtime 2022.3.71f1 (`Player.log`). The modding toolchain is not installed (`CSII_TOOLPATH` unset). .NET SDK 10.0.402 is installed.

**Evidence tags**
- **[SRC]**: verified by reading the cited open-source mod code or official docs.
- **[REF]**: verified against the public API surface of the game's 1.6.4 managed assemblies. Only member names are cited here; no game code was copied.
- **[INF]**: my inference. Not confirmed by code or docs.
- **[GAME]**: can only be confirmed by running the game.

Coordinates throughout: the playable area is x, z ∈ [-7168, +7168] m and the world is ±28672 m. y is world height in metres.

---

## 0. Verdict table

| # | Feature | Feasible | Approach | Conf. | Risk |
|---|---|---|---|---|---|
| 1 | Heightmap import from code | **Yes** | `ImageAsset.ImportImageFromPath` → `TerrainSystem.ReplaceHeightmap(Texture2D)`. This is the same call the editor's Import button makes. | High | Low |
| 1b | World map import from code | **Yes** | `TerrainSystem.ReplaceWorldHeightmap(Texture2D)` | High | Low/med: world map scaling looks odd in some community reports |
| 1c | Height scale from code | **Yes** | `TerrainSystem.SetTerrainProperties(new float2(scale, 0))`. The editor slider allows 200–10000; the default is 4096. | High | Low |
| 1d | Sea level from code | **Yes** | `WaterSystem.SeaLevel = h` (0–2000), then `ResetToSealevel()`, as the editor's "Apply sea level" does | High | Med: water takes minutes to settle |
| 3 | Roads, rail, tram, subway, paths | **Yes** | One entity per segment with `CreationDefinition{Permanent}` + `NetCourse` + `Updated`, created from a plain system in ToolUpdate. Alternative: the tool handshake with Apply. | High | **High** on quality: node merging, bridges, density, game stalls |
| 3b | Bridges and tunnels | **Partly** | Per-end `NetCourse.m_Elevation` (> 0 bridge, < 0 tunnel). Bridge prefabs have extra length and span rules. | Med | High |
| 4 | Trees and bushes (100k+) | **Yes** | `CreationDefinition{Permanent}` + `ObjectDefinition{m_Age}` in batches of thousands | High (mechanism) | Med: total count and frame time |
| 5 | Water: sea | **Yes** | The new water system has no sea source; set the global `WaterSystem.SeaLevel` instead | High | Med |
| 5b | Lakes, rivers (constant level / constant rate) | **Yes** | Create entities with `WaterSourceData` + `Game.Objects.Transform` + `Created` + `Updated` | High | Med: rivers are approximated by level sources |
| 6a | Climate preset | **Yes** | `ClimateSystem.currentClimate = prefabEntity` | High | Low |
| 6b | Custom climate values, latitude/longitude | **Yes** | Clone the `ClimatePrefab` (as the editor's "Edit" does) and set `m_Latitude`, `m_Longitude` and `m_Seasons[]`. The curves are regenerated from the seasons. | Med-High | Med |
| 6c | Theme | **Yes** | `CityConfigurationSystem.defaultTheme = themeEntity` | High | Low |
| 6d | Map name and description | **Partly** | Stored in a private `MapPanelSystem` localisation field and written at save time. Use reflection, or let the user type them. | Med | Med |
| 6e | Starting tiles | **Yes (inferred)** | Add map tile entities to `MapTileSystem.GetStartTiles()` (a mutable `NativeList`) | Med | Med |
| 6f | Ore, oil, fertile land, groundwater | **Yes** | Write the 256×256 `CellMapData` of `NaturalResourceSystem` / `GroundWaterSystem`, mirroring `ResourcePanelSystem.ApplyTexture` | High | Low |
| 6g | Forest resource | **Yes (indirect)** | Forest is counted from tree entities. There is no forest map. | High | Low |
| 6h | Outside connections | **Yes** | A road or rail node exactly on the ±7168 border is auto-tagged `OutsideConnection`. Air and ship connections are placed as objects. | Med-High | Med |
| 7 | Street names | **Yes** | `NameSystem.SetCustomName(aggregateEntity, name)` + `CustomName` + `Updated`, run after aggregates exist | High | Med: one aggregate can cover several OSM names |
| 8 | Build without the toolchain | **Yes** | net48 / C# 9 class library that references `Cities2_Data\Managed\*.dll` directly. No Burst; plain C# systems are fine. | High | Low |
| 8b | Panel in the Map Editor | **Yes** | Add an `IEditorTool` to `EditorToolUISystem.tools` with an `EditorPanelSystemBase` panel (pure C#, no JS needed) | High | Low |
| 9 | Tracing overlay from a PNG | **Yes, today** | algernon's **Image Overlay** mod (Apache-2.0) reads PNGs from `%LocalLow%\…\Overlays` and stretches them over 14 336 m | High | Low |

**The two biggest risks:**
1. **Road graph quality.** Node merging across batches, short or dense segments, bridges, rail/road overlaps and lake piers. The one public OSM importer spends more than 250 kB of code on these cases.
2. **Game-side cost.** Very large city networks and deletes can stall the game or exhaust RAM (23 GB was reported during a full-Seattle delete).

---

## 1. Heightmap facts

| Fact | Value | Evidence |
|---|---|---|
| Resolution | **4096×4096** exactly | `TerrainSystem.kDefaultHeightmapWidth/Height = 4096`, `IsValidHeightmapFormat` [REF]; Paradox dev diary 2 [SRC] |
| Pixel format after load | `R16_UNorm` (or `R16G16B16A16_UNorm`); anything else shows `Editor.INCORRECT_HEIGHTMAP_*` | `TerrainSystem.IsValidHeightmapFormat`, `TerrainPanelSystem.DisplayHeightmapError` [REF] |
| File formats | 16-bit grayscale **PNG or TIFF** (`ImageAsset.kExtensions`) | dev diary 2 [SRC]; `TerrainPanelSystem` file picker [REF] |
| Folder | `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Heightmaps\`. The editor lists assets whose `subPath` starts with `Heightmaps`. Since 1.6 it also has a "Select from disk" file picker (`lastHeightMapDirectory`), so any path works. The folder does not exist on this machine yet; create it. | `TerrainPanelSystem.kHeightmapFolder`, `OnLoadHeightmap(string path)` [REF]; dev diary 2 [SRC] |
| Playable size | **14 336 m** (`kDefaultMapSize`), i.e. **3.5 m per heightmap pixel** | `TerrainSystem` [REF]; Image Overlay README [SRC] |
| World size | **57 344 m** = 4 × playable (`kDefaultWorldSize = kDefaultMapSize * 4`), i.e. 14 m per world-map pixel | [REF] |
| World map vs playable | World map: 4096², same format. Its **centre 1024×1024 must match the playable heightmap**, because 14 336 / 57 344 = 1/4. | dev diary 2 [SRC]; the size ratio [REF] |
| Height scale | default **4096 m**; editor slider **200–10 000**. Height = `pixel / 65535 * heightScale + offset`, and the offset is 0 by default. | `kDefaultHeightScaleOffset = (4096, 0)`, `TerrainPanelSystem` slider min/max [REF]; the formula is used in cs2-osm-importer `OsmImportSystem.Trenches.cs` [SRC] |
| Sea level | Absolute height in metres, editor range **0–2000**. Default **511.7** for new maps (`kDefaultSeaLevel`); 0 when a legacy save is loaded. | `WaterSystem.SeaLevel`, `kMaxSeaLevel`, `SetDefaults`; `WaterPanelSystem` slider [REF] |
| Row order | Texture row index increases with world **+z**: cell `(x, z)` = `playableOffset + (x, z) * cell`. Unity loads a PNG bottom-up, so **PNG row 0 (top) = max z**. Whether +z is "north" on the in-game compass is **[INF]**. The CS2 OSM Toolkit tells users to "keep north up" when using Image Overlay, which agrees. | importer `Trenches.cs` indexing [SRC]; `CellMapSystem.GetCellCenter` [REF]; north [INF] → **[GAME]** |
| Resource maps | 256×256 grayscale from the same `Heightmaps` folder; white = full amount | dev diary 2 [SRC]; `ResourcePanelSystem.kTextureImportFolder`, `NaturalResourceSystem.kTextureSize = 256` [REF] |

**Practical rules for the exporter**
- **Height scale.** Choose it per map as `max(elevation range) + margin`, within 200–10 000. Store `heightScale` in the package and set it with `SetTerrainProperties` **before** `ReplaceHeightmap`, so the 16-bit quantisation is computed against the same scale.
- **Bit depth.** Use 16-bit, single channel. Unity loads the PNG with `asset.Load(srgb: true)` and then converts it `ToR16`. 16-bit gray PNGs are what the editor's own export writes [REF], so they round-trip.

---

## 2. Setting the terrain from code

**Verdict: yes.** The editor's import is just three calls, and a mod can make them [REF `Game.UI.Editor/TerrainPanelSystem.cs` `OnLoadHeightmap`/`OnLoadWorldHeightmap`]:
```
ImageAsset a = ImageAsset.ImportImageFromPath(path);   // Colossal.IO.AssetDatabase
Texture2D t = a.Load(srgb: true);
if (TerrainSystem.IsValidHeightmapFormat(t)) terrainSystem.ReplaceHeightmap(t);   // or ReplaceWorldHeightmap(t)
```

**What the calls do**
- `ReplaceHeightmap` converts the texture to R16, calls `FinalizeTerrainData`, and calls `WaterSystem.TerrainWillChange()` [REF].
- `SetTerrainProperties(float2 heightScaleOffset)` changes the scale [REF].

**Who already uses this from mod code**
- **cs2-osm-importer**, `OsmImportSystem.Trenches.cs`, uses `ReplaceHeightmap`. It builds a `Texture2D(w, h, GraphicsFormat.R16_UNorm)`, calls `SetPixelData(ushort[])` and `Apply()`, then waits a few frames and calls `GetHeightData(true)` before sampling again [SRC]. https://github.com/digiphreniac/cs2-osm-importer
- **CS2-NetworkTools** (MIT), `NetworkTools.Mod/Tests/Utils/ProvingGroundLoader.cs`, also uses `ReplaceHeightmap` [SRC].

We can skip the PNG round trip and build the `Texture2D` straight from the package bytes. The editor's import button is therefore only a fallback.

---

## 3. Roads and rail

### 3.1 How mods create nets

**A. Permanent definitions, no tool (cs2-osm-importer)** [SRC + REF]
- **Code.** `cs2-osm-importer/OsmImportSystem.cs` `CreateNetCourseDefinition` (~line 1852) creates entities from a `GameSystemBase` registered at `SystemUpdatePhase.ToolUpdate` (`Mod.cs`).
- **Components.** One pre-built archetype carries `CreationDefinition`, `NetCourse`, `Updated` and a marker tag.
  - `CreationDefinition{ m_Prefab = netPrefabEntity, m_Flags = CreationFlags.Permanent, m_RandomSeed }`.
  - `NetCourse{ m_StartPosition / m_EndPosition = CoursePos{ m_Position, m_Rotation = identity, m_Elevation = float2(e), m_CourseDelta 0/1, m_SplitPosition 0/1, m_Flags = IsFirst / IsLast, m_ParentMesh = -1 }, m_Curve = Bezier4x3(a, a + d/3, b - d/3, b), m_Elevation = (e0, e1), m_Length }`.
- **Why Permanent works.** It skips Temp, validation and Apply entirely. `GenerateEdgesSystem.GenerateEdge` and `GenerateNodesSystem` branch on `CreationFlags.Permanent` and create real entities without a `Temp` component [REF].
- **Completion.** Watch for the definitions to be consumed and the edge count to rise (`WaitForGeneratedRoads`).
- **Licence.** The repo has **no licence file** (all rights reserved). Read it to learn from it; do not copy code from it.

**B. Tool handshake (cities-skylines-2-mcp bridge, Apache-2.0)** [SRC]
- **Code.** `CS2MCP.Bridge/BridgeRoadToolSystem.cs` (upstream LancerComet) and the `editor-import` fork's `BridgeImportToolSystem.cs`. Both are `ObjectToolBaseSystem` subclasses that set themselves as `ToolSystem.activeTool`.
- **Handshake per batch.** Definitions → `applyMode = Clear` → `None` (preview, then validation, for `settleFrames`) → `Apply` if `GetAllowApply()`. `ToolSystem.ignoreErrors = true` bypasses validation.
- **Rejected batches** are bisected until each failure is a single item, which then carries the game's error name.
- **Speed.** Default batch is 64 edges; objects go 500 per batch (50k trees in 18.2 s).
- https://github.com/LancerComet/cities-skylines-2-mcp; fork + docs (`IMPORT_SCHEMA.md`, `MAP_SETTINGS.md`, `PREFAB_NAMES.md`): https://github.com/thedevdavid/cities-skylines-2-mcp/tree/editor-import

**Recommendation.**
- **Use A (Permanent) for bulk.** It is fast and needs no tool activation.
- **Use B for problem segments,** where validation errors explain what is wrong.
- **Write our own code for both,** with the Apache-2.0 bridge as the licensable reference.

### 3.2 Constraints

- **Curves.** Each edge is one cubic `Bezier4x3`. Fit OSM polylines into curve segments in the desktop app. Straight lines use thirds-of-the-chord control points. `NetUtils.FitCurve(startPos, startTan, endTan, endPos)` exists [REF].
- **Length.**
  - Most nets have `NetGeometryData.m_EdgeLengthRange.max = 200 m` by default, set in `NetInitializeSystem` (~875) [REF]. Pathway/taxiway-type nets get 1000 m (~2137) [REF].
  - Longer courses are split automatically by `CourseSplitSystem` [REF].
  - The importer drops courses shorter than 1 m [SRC]. The bridge accepts 4–1500 m per edge [SRC].
- **Elevation.**
  - `CoursePos.m_Elevation` and `NetCourse.m_Elevation` are metres above terrain: `> 0` is elevated or bridge, `< 0` is tunnel, 0 is ground.
  - Defaults: `m_ElevationLimit = 4 m`, `m_ElevatedLength = 80 m` (pillar spacing) [REF].
  - Bridges need about 2 × limit = 8 m, or validation raises `LowElevation` [SRC bridge docs].
  - **Pass the real height above ground at both ends.** With 0, the nodes the game inserts on a long span drop to the ground; a 547 m span sagged from 67 m to 12 m (importer comment, `CreateNetCourseDefinition`) [SRC].
- **Bridge prefabs** have span rules: fixed spans, 0.6–1.4 × segment length, and one edge per bridge. See the fork's `IMPORT_SCHEMA.md` "Bridge prefabs" [SRC]. Plain road prefabs with elevation are the safer default.
- **Node merging.**
  - Within one frame's definitions, free ends at **bit-identical positions** merge into one node [SRC bridge doc].
  - Across frames (separate apply sets), a new course point within **~13–22 m** of an existing node is merged into it and the node moves. Batching 128 per frame gave 667 dead ends versus 2 when everything went in one frame (`OsmImportSystem.cs` lines 26–35) [SRC].
  - Mitigations:
    - Snap shared OSM nodes to identical float3 values in the desktop app.
    - Queue a connected component, or a whole road class, in **one frame**.
    - Or attach to existing nodes via `CoursePos.m_Entity`. The bridge creates nodes first as zero-length courses and resolves their entities after each batch [SRC].
- **Batching numbers (importer, full Seattle)** [SRC]
  - 201k definitions in one frame are feasible if every component is set via one archetype; four `AddComponentData` calls per entity took 10.9 s.
  - Deleting 43k edges at 128 per frame took 110 s. Deleting everything in one frame ran out of memory. Their fix: 2048 edges per frame in Z-order tiles.
- **Validation is skipped under Permanent.** Overlaps, water and steep slopes are not checked, so the desktop app must pre-clean. Respect the per-prefab `m_MaxSlopeSteepness`; it is asset data, so read it at runtime from `NetGeometryData`.
- **Prefab lookup.** Enumerate entities with `PrefabData`, call `PrefabSystem.GetPrefab<PrefabBase>(e).name`, and build a name → entity dictionary at load. Fail loudly if a name is missing, because DLC and theme differences are possible [REF].

### 3.3 Vanilla net prefab names

Source: cs2-osm-importer `NetworksPrefabs.csv` and `prefab-mappings.json` [SRC]; bridge fork `PREFAB_NAMES.md` [SRC]. Treat the list as a starting point and validate it at runtime.

| Class | Prefab names |
|---|---|
| Highway | `Highway Oneway - 1 lane` … `- 5 lanes`; `Highway Twoway - 2 lanes`, `- 3 lanes`, `- 4 lanes`; `Highway Twoway Asymmetric - 1+3 lanes`, `- 2+3 lanes` |
| Large | `Large Road`, `Large Road Divided`, `Large Road Oneway`, `Large Road Oneway - 7 lanes`, `Large Road Asymmetric`, `Large Road Asymmetric - 2+4 lanes`, `- 2+5 lanes`, `XL Road Divided` |
| Medium | `Medium Road`, `Medium Road Divided`, `Medium Road Oneway`, `Medium Road Oneway - 5 lanes`, `Medium Road Asymmetric`, `Medium Road Asymmetric - 1+3 lanes`, `Medium Road - Double Sided Parking`, `… Angled` |
| Small | `Small Road`, `Small Road Oneway`, `Small Road Oneway - 1 lane`, `- 3 lanes`, `Small Road Asymmetric`, `Small Road - Double Sided Parking`, `… Angled`, `Small Road Oneway - Single Sided Parking`, `Small Road Divided - Double Sided Parking` |
| Alley / gravel / pedestrian street | `Alley`, `Alley Oneway`, `Alley - Double Sided Parking`, `Gravel Road`, `Gravel Road Oneway`, `Pedestrian Street`, `Pedestrian Street Small` |
| Train | `Twoway Train Track`, `Oneway Train Track`, `Double Train Track`, `Double Train Track - Twoway` |
| Tram | `Double Tram Track`, `Oneway Tram Track` |
| Subway | `Twoway Subway Track`, `Oneway Subway Track`, `Double Subway Track`, `Double Subway Track - Twoway` |
| Paths | `Pavement Path`, `PedestrianPathWide01`, `PedestrianPathWithBikeLanes`, `TwoWayBikePath`, `OneWayBikePath` |
| Quays | `QuaySmall01`–`03`, `QuayMedium01`–`03`, `QuayLarge01`–`03` |
| Utilities | `High-voltage Line`, `Low-voltage Line`, ground-cable variants |
| Waterways | `Narrow/Medium/Wide Seaway`, `Narrow/Medium/Wide Boatway` |

Gravel and dirt footpath names were not found in these lists; look them up at runtime (**[GAME]**).

---

## 4. Trees and bushes

- **Mechanism** [SRC + REF]. One definition entity per object:
  - `CreationDefinition{ m_Prefab, m_Flags = Permanent, m_RandomSeed }`.
  - `ObjectDefinition{ m_Position, m_Rotation, m_LocalPosition, m_LocalRotation, m_Age, m_Scale, m_Intensity, m_ParentMesh = -1, m_Probability = 100, m_PrefabSubIndex = -1 }`.
  - `Updated`.
  - `GenerateObjectsSystem` honours `Permanent` [REF `GenerateObjectsSystem.cs` ~982, ~1290].
- **References for object placement**
  - **Line Tool** (Apache-2.0), `Code/Systems/CreateDefinitions.cs`: https://github.com/algernon-A/LineTool-CS2
  - **Tree Controller** (MIT), `Systems/TreeObjectDefinitionSystem.cs`. It sets ages per `TreeState` (Teen / Adult / Elderly / Dead / Stump) using `ObjectUtils.TREE_AGE_PHASE_*`: https://github.com/yenyang/Tree_Controller
  - The bridge fork maps `age` to `AgeMask` and `m_Age`: seedling 0, young 0.175, adult 0.425, elderly 0.775 (`ToolUtils.GetRandomAge(ref random, AgeMask)`) [SRC].
- **Batching**
  - The bridge measured 50k trees in 18.2 s with the tool path [SRC].
  - With Permanent definitions, aim for about 5k–20k per frame, using one archetype and component arrays (**[INF]**, tune in game).
  - Pre-filter positions on the desktop side: not under water, not on roads, not inside lakes. The converter audit found 10k trees standing in a river because there was no mask [SRC].
- **Vanilla tree names** [SRC: Tree Controller, placemaker `ParkArt.cs`, bridge `PREFAB_NAMES.md`]
  - Trees: `AppleTree01`, `BirchTree01`, `OakTree01`, `PineTree01`, `SpruceTree01`, `EuropeanSpruce01`, `EU_AlderTree01`, `EU_ChestnutTree01`, `EU_PoplarTree01`, `NA_HickoryTree01`, `NA_LindenTree01`, `NA_LondonPlaneTree01`.
  - Palms: `CoconutPalmTree01`, `FloridaPalmTree01`, `RoyalPalmTree01`, `SylvesterPalmTree01`.
  - Placeholders: `TreeWildRandom01` and `TreeCityRandom01` (the game picks a species per object).
  - Bushes: `GreenBushWild01/02`, `FlowerBushWild01/02`, `GreenBushCity01–03`, `BushWildRandom01`.
  - Growth-stage meshes (`…Adult01` etc.) are variants, not prefabs to place.
- **Count limits.** Unknown. Vanilla maps' tree counts and the render cost of 300k+ trees are **[GAME]**.

---

## 5. Water sources

**The water system changed (1.6.x)** [REF + SRC]
- **New and legacy.** `WaterSystem` has `UseLegacyWaterSources`. New maps start with `false` (new simulation) and `SeaLevel = 511.7`. Old maps stay legacy until the editor's "Upgrade water sources" button sets the flag to `false` (`WaterPanelSystem`).
- **No sea source.** In the new system the sea is the global `WaterSystem.SeaLevel` (0–2000) plus `ResetToSealevel()` ("Apply sea level"). When legacy sources are upgraded, Sea (type 3) sources are folded into the sea level and destroyed (`WaterSystem` ~1261) [REF].
- **Source types.** `WaterSourceData{ int m_ConstantDepth, float m_Radius, m_Height, m_Multiplier, m_Polluted, int m_Id, float m_Modifier }`. The type ints are 0 stream (constant rate), 1 lake (constant level), 2 river, 3 sea; they matter only in `WaterSimulationLegacy` [REF].
- **New `SourceStep` behaviour.** According to the CS1→CS2 converter audit, if `m_Polluted > 0` the source is a flow source; otherwise it is a constant-level source with target `position.y + m_Height` within `m_Radius × m_Modifier`. Height is capped at 250 m and radius at 1–2500 [SRC](https://github.com/thedevdavid/cs1-cs2-map-converter/blob/HEAD/audit/cs2-side.md). This is **[SRC, unverified by me in `WaterSimulation.SourceStep`]**.
- **Creating a source from code** (cs2-osm-importer `OsmImportSystem.Lakes.cs` `CreateLakeSource`) [SRC]: `EntityManager.CreateEntity(typeof(WaterSourceData), typeof(Game.Objects.Transform), typeof(Created), typeof(Updated))` with `m_Multiplier = 1`, `m_Modifier = 1` and `m_Id = -1`. `m_Height` is the depth above ground at the source position.
  - `WaterPanelSystem` gives each new source a name via `NameSystem` [REF].
  - Water Features (MIT) is a further reference: https://github.com/yenyang/Water_Features
- **Implications for our package**
  - **Sea.** Write `seaLevel` and set `SeaLevel` after the heightmap, then call `ResetToSealevel()`.
  - **Lakes.** Constant-level sources at the shore height, with radius kept inside the outline. The importer only fills basins whose bed lies below the shore and skips lakes under 1000 m² [SRC].
  - **Border rivers.** In the new system a river is a level source near the border with the target set at the river surface. Carve the riverbed into the heightmap so the water flows.
  - **Timing.** Water rises over minutes. Wait before placing anything that samples the water surface, such as piers (importer `SeaLevel.cs`: 10-minute timeout) [SRC].
- **History.** CO announced the water rework in Aug 2025 (Paradox "Work in motion"). Patch 1.6.0f1 fixed map saves with custom climate, water and terrain settings [SRC, search results].

---

## 6. Map settings

| Setting | From code | How | Evidence |
|---|---|---|---|
| Climate preset | yes | `ClimateSystem.currentClimate = prefabSystem.GetEntity(climatePrefab)` | `ClimatePanelSystem.currentClimate` [REF] |
| Custom climate | yes | Clone the `ClimatePrefab` (`PrefabBase.Clone()`, then `AddPrefab`) and set its fields: `m_FreezingTemperature`, `m_Seasons[]` (`m_StartTime`, `m_TempNightDay`, `m_TempDeviationNightDay`, cloud and precipitation chance/amount, …) and `m_RandomSeed`. Make it current, then rebuild the curves. The five `AnimationCurve`s are generated from the seasons, so do not write them directly. The edited copy is embedded in the map on save (`PrefabSystem.SaveClimate`). | `ClimatePrefab` fields [REF]; bridge `MAP_SETTINGS.md` "climateEdit" [SRC] |
| Latitude / longitude | yes, via the climate | `ClimatePrefab.m_Latitude` (−90…90) and `m_Longitude` (−180…180) are copied to `PlanetarySystem` on load and on every climate change. Setting `PlanetarySystem.latitude` directly does not persist. | `ClimatePanelSystem` ~264, `ClimatePrefab` [REF]; bridge doc [SRC] |
| Theme | yes | `CityConfigurationSystem.defaultTheme = themeEntity` (an entity with `ThemeData`; names "European", "North American") | `CityConfigurationSystem` [REF]; bridge doc [SRC] |
| Height scale, sea level | yes | sections 1 and 5 | [REF] |
| Camera start, left-hand traffic | yes | `CityConfigurationSystem.m_CameraPivot/m_CameraAngle/m_CameraZoom`, `leftHandTraffic` | `MapPanelSystem` [REF] |
| Map name, description | partly | Private `LocalizationField`s in `MapPanelSystem`, turned into `Maps.MAP_TITLE[...]` on save. Code access needs reflection; otherwise show the values in our panel and let the user paste them. | [REF]; bridge says "by hand" [SRC] |
| Starting tiles | yes [INF] | `MapTileSystem.GetStartTiles()` returns the serialized `NativeList<Entity>`; the editor's selection tool writes into it. Add tile entities (`MapTile` + `Area`), then mark them `Updated`. Old tile grid: 23×23 cells of 623.3 m. | `MapTileSystem`, `SelectionToolSystem` ~1067 [REF] |
| Ore, oil, fertile | yes | `NaturalResourceSystem.GetData(false, out deps)`, `deps.Complete()`, then write `m_Buffer[y*256+x].m_Ore/m_Oil/m_Fertility = new NaturalResourceAmount{ m_Base = 0..10000 }`. Afterwards `AddComponent<Updated>(MapFeatureElement query)`. | `ResourcePanelSystem.ApplyTexture/ApplyOre` [REF] |
| Groundwater | yes | `GroundWaterSystem` cell map: `GroundWater{ m_Amount = m_Max = 0..10000 }` | same [REF] |
| Forest | indirect | Comes from tree entities (MapFeature.Forest); nothing to paint | `MapRequirementSystem` [REF]; bridge doc [SRC] |
| Fish | indirect | Water-related; no import path seen | [INF] |
| Outside connections | yes | Road and train: end a network node exactly at x or z = ±7168; `GenerateNodesSystem` tags border nodes `Game.Net.OutsideConnection` and the prefab spawns the marker. Air and ship: place `Airplane Outside Connection` / `Ship Outside Connection - Twoway` as objects on the border. Power and water: inferred to work the same way. | bridge `PREFAB_NAMES.md` [SRC]; verify [GAME] |
| Playability checklist | read | `MapRequirementSystem`: starting area, water in it, a road connection and a map name are required | [REF]; bridge doc [SRC] |

---

## 7. Street names

**Yes** [SRC + REF]. cs2-osm-importer (`OsmImportSystem.cs` ~3110–3160) resolves each edge to its aggregate (`Game.Net.Aggregated.m_Aggregate`). It then calls `NameSystem.SetCustomName(aggregate, name)`, adds or sets `CustomName`, and adds `Updated` + `BatchesUpdated`. It defers this to UIUpdate, once the aggregates exist.
- **Signatures.** `NameSystem.SetCustomName(Entity, string)` and `TryGetCustomName(Entity, out string)` [REF `Game.UI/NameSystem.cs` 209/214].
- **Caveats**
  - The game forms aggregates by prefab and continuity. Two OSM names on one continuous aggregate collide, so the last write wins **[INF]**.
  - Run naming after all edges in the area exist and the aggregates have settled; wait a few frames.

---

## 8. Toolchain, install, UI

**Official toolchain** (in-game Options → Modding; it sets the `CSII_*` user env vars)
- **What 1.6.4 installs:** Unity **2022.3.62f2**, Entities **1.3.10**, .NET SDK **8** (minimum 6) and Node.js **22.21** (minimum 18) [REF `Game.Modding.Toolchain.Dependencies/*`]. The wiki still says Unity 2022.3.7f1 and verifies against 1.1.12f1, so it is outdated [SRC](https://cs2.paradoxwikis.com/Modding_Toolchain).
- **Project settings:** `Mod.props` sets `net48`, `LangVersion 9.0` and references from `CSII_MANAGEDPATH` or the Steam default path [SRC: local `Cities2_Data\Content\Game\.ModdingToolchain\Mod.props`].
- **Build steps:** `Mod.targets` runs ModPostProcessor (IL plus Burst) and deploys to `CSII_LOCALMODSPATH\<TargetName>`.
- **Templates:** a C# NuGet template (`ColossalOrder.ModTemplate.1.0.0.nupkg`) and a UI template (`npx-create-csii-ui-mod`) [local files].

**Without the toolchain (works today)**
- Use a plain SDK-style net48 class library with `HintPath`s into `...\Cities2_Data\Managed\` and `Private=false`.
- **Limitation:** there is no Burst/IL post-processing, so use no `[BurstCompile]` jobs and no `SystemAPI` source generators. Main-thread `EntityManager` code is fine for an importer.

**Local install**
- Copy the DLL to `%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Mods\<ModName>\`. Local mods load without publishing. Prefix the folder with `.` to disable it [SRC wiki].
- Every C# change needs a game restart, because the DLL is loaded once with `Assembly.Load(byte[])` [REF].
- `ModsData` exists with per-mod folders (Anarchy, RoadBuilder, …). Use `...\ModsData\CS2MapBuilder\` for packages. Most mods build the path from `Colossal.PSI.Environment.EnvPath.kUserDataPath` **[INF; verify the field name]**.

**Map Editor UI**
- **Yes, as a native editor tool tab** [SRC]. cs2-osm-importer `OsmImporterUISystem.RegisterEditorTool()` appends a `Game.UI.Editor.EditorTool` subclass to `EditorToolUISystem.tools`. The tool has `id`, `icon`, `panel` and `tool` set; the panel is an `EditorPanelSystemBase` whose widgets are C# (`EditorSection`, buttons, `DelegateAccessor`); the tool is a minimal `ToolBaseSystem` (`OsmEditorTool.cs`, `OsmImportToolSystem.cs`).
- **Also possible:** a JS UI module with `moduleRegistry.append('Editor', …)` [REF].
- **Also possible:** a `ModSetting` page with a directory picker and an Import button (`SettingsUIButton`, `SettingsUIDirectoryPicker`) [REF].
- **Recommendation.** Use the editor tool tab, because no JS build is needed. Keep a settings-page button as a fallback.

---

## 9. Existing tools

| Tool | What it does | Licence | Learn / reuse |
|---|---|---|---|
| **cs2-osm-importer** (digiphreniac), github.com/digiphreniac/cs2-osm-importer | In-editor mod: `.osm` XML → roads, rail, tram, bike, piers, parking lots, parks, lake water sources, street names, roundabouts, bridge trenches. Seattle-scale tested. Active (pushed 2026-11-10). | **None** (all rights reserved) | The best reference for pitfalls: node merging, elevation, deletes, sea wait, names. **Do not copy code.** Its feature list overlaps ours; we could ask the author about interop or licensing. |
| **cities-skylines-2-mcp** (LancerComet) + **editor-import fork** (thedevdavid) | HTTP bridge in the game; the fork imports networks, objects and water and sets map settings, with dry runs, undo and reports | **Apache-2.0** | A legally reusable reference for definitions, batching, bisection, ages and map settings. Its docs (`IMPORT_SCHEMA.md`, `MAP_SETTINGS.md`, `PREFAB_NAMES.md`) are excellent. |
| **cs1-cs2-map-converter** (thedevdavid) | End-to-end CS1 → CS2 map via the bridge: heightmap and world map rebuild, nets, trees, water, climate | none | Its `audit/cs2-side.md` covers water, outside connections and trees in water |
| **MOOB** (Cities2Modding) | Old BepInEx mod. Its only remaining job is enabling the editor; the vanilla game now does import/export. | GPL-2.0 | Obsolete. Nothing to reuse. |
| **ExtraLandscapingTools** (AlphaGaming7780) | Brushes and resource tools (ore, oil, groundwater, fertile), custom brushes | none in the repo | Not needed: the vanilla 256² resource import covers this |
| **Image Overlay** (algernon-A), github.com/algernon-A/ImageOverlay | PNG overlay over the playable area, up to 16 384 px, from `%LocalLow%\…\Overlays`; scales to 14 336 m, centred; moves, rotates, sets transparency; works in the editor | Apache-2.0 | **Use as the tracing overlay now:** our app writes `Overlays\<map>.png`, 4096 px ≈ 3.5 m/px, north up. Its overlay code is a model if we want our own. |
| **MapImageLayer** (Cities2Modding) | Older overlay mod (Thunderstore, about 2 years old) | – | Superseded by Image Overlay |
| **CS2 OSM Toolkit** (Osyanne; Patreon cw/CS2OSMToolkit) | Web visualiser: OSM zoning/services for 83 cities, exported as PNG for Image Overlay. Heightmaps are "planned". Not a mod. | Repo says "Other" (README badge says MIT) | Validates the overlay workflow. No in-game import. |
| **Carto** (taipei-native/Carto) | Exports a save to GeoJSON, Shapefile and GeoTIFF (UTM reprojection). Export only. | MIT | Useful to round-trip-test our import against the source data |
| **CityTimeline-Mod + cs2-realmap-generator** (Giscolab) | GeoJSON overlay mod plus a Python OSM → GeoJSON/heightmap pipeline. Road spawning is "experimental, disabled"; it enables an experimental 57 km LargeMap. | none / Other | Little reuse |
| **terraining** (nonta1234) | Web heightmap generator for CS1/CS2 | MIT | Reference for DEM sampling and scale |
| **Tree Controller**, **Water Features** (yenyang) | Tree ages and brushes; extra water source types | MIT | Code patterns for ages and water sources |
| **Line Tool** (algernon-A) | Object placement along lines | Apache-2.0 | Object definition code |

**Tracing overlay answer.** Yes. Image Overlay accepts a PNG we generate and needs no code from us.

---

## 10. Recommended mod architecture

**Package location.** `%LocalLow%\Colossal Order\Cities Skylines II\ModsData\CS2MapBuilder\packages\<name>\`. The desktop app writes it directly, or through the user's import dialog. The package contains `manifest.json` (version, heightScale, seaLevel, climate, theme, lat/lon, names), `heightmap.png`, `worldmap.png`, `roads.json`, `trees.bin`, `water.json` and `resources/*.png` (256²). The app also writes `Overlays\<name>.png` for Image Overlay.

**Assemblies.** `CS2MapBuilder.Mod.dll` (net48, C# 9). Package parsing goes in a separate pure `Core` assembly with its own tests. JSON uses the game-shipped Newtonsoft 13, which is not deployed with the mod.

**Systems**
| System | Phase | Role |
|---|---|---|
| `MapBuilderUISystem : UISystemBase` | UIUpdate | Registers the editor tool (`EditorToolUISystem.tools`); naming pass |
| `MapBuilderPanel : EditorPanelSystemBase` | – | Package picker, step checkboxes, progress, log |
| `MapBuilderTool : ToolBaseSystem` (minimal) | ToolUpdate | Required by `EditorTool`; also the B-path apply handshake if needed |
| `ImportSystem : GameSystemBase` | **ToolUpdate** | State machine, one step per frame, frame-budgeted |

**Import order** (each step waits for the previous one to settle)
1. **Validate** the manifest and resolve every prefab name to an entity. Abort with a list of missing names.
2. **Terrain.** `SetTerrainProperties(heightScale)` → `ReplaceWorldHeightmap(world)` → `ReplaceHeightmap(playable)`. Wait N frames, then call `GetHeightData(true)` to settle the CPU copy.
3. **Climate, theme, lat/lon** (climate clone), camera start.
4. **Water.** `SeaLevel` + `ResetToSealevel()`, then the lake and river level sources. Start them at radius 0 and raise them gradually (the importer's approach), then wait until the water surface converges, with a timeout.
5. **Resources.** Write the cell maps (ore, oil, fertile, groundwater).
6. **Networks**, in this order:
   - (a) highways and rail;
   - (b) arterials;
   - (c) local roads;
   - (d) paths.
   Queue each class's connected components in a single frame, with shared nodes bit-identical. Wait for consumption. Record created edges for undo (a tag component on definitions, then a lookup by position).
7. **Street names** (UIUpdate, after the aggregates settle).
8. **Trees and bushes** in spatial (Z-order) chunks of about 10k per frame with Permanent definitions. Skip points in water, on nets, or in building lots.
9. **Starting tiles**; check outside connections and the playability checklist; report.
10. **The user saves the map by hand** (the editor's Save dialog builds the metadata) and sets the map name and description.

**Undo / delete.** Remove in Z-order batches of about 2k edges per frame, together with their nodes; avoid deleting everything in one frame [SRC importer].

---

## 11. Only confirmable in the game

1. **North.** That PNG row 0 (top) lands at max z, and whether that is north on the compass and sun path. Import a test heightmap with a corner marker.
2. **Height mapping.** That `ReplaceHeightmap` from our own `Texture2D(R16_UNorm)` gives height = v/65535 × scale; whether `SetTerrainProperties` before or after the import matters; how `ReplaceWorldHeightmap` treats a world-map centre that disagrees with the playable map.
3. **Permanent net definitions in the editor**: building lots, outside-connection markers, `Native` flags, undo behaviour, and whether the editor marks the map dirty.
4. **Node-merge distance and batch strategy** on our graph, including a frame-time and RAM budget for the largest realistic area.
5. **Elevation:** bridges and tunnels from per-end elevation on normal road prefabs; pillar placement; tunnel portals at the terrain.
6. **New water system:** the actual `SourceStep` semantics (`m_Polluted` as flow, the height cap), how long sources take to fill, and river behaviour near the border.
7. **Climate clone persistence** after save and reload; `RebuildCurves` access from mod code.
8. **Starting tiles via `GetStartTiles().Add`:** whether the boundary mesh refreshes and whether the selection survives saving.
9. **Map name and description by reflection:** private field names in 1.6.4.
10. **Tree budget:** FPS and memory at 100k, 300k and 1M trees; behaviour of `TreeWildRandom01`.
11. **Street naming on aggregates** that cover several OSM names.
12. **Prefab names.** Full list at runtime (paths, gravel footpaths, DLC tracks) and EU/NA theme differences.
13. **Toolchain-free build.** Load-test the net48 DLL against 1.6.4. Decide whether Burst is needed later.
