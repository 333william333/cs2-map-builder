# CS2 Map Builder importer (Cities: Skylines II mod)

Imports a package written by the desktop app (format `cs2mapbuilder` version 1, see `CONTRACT.md` "M2 additions")
into the **Map Editor**: terrain, world map, climate/theme/lat-lon, sea level and water sources, natural resources,
roads/rail/paths, street names, trees and start tiles. Design and evidence: `docs/MOD_SPIKE.md`.
In-game test protocol: `TESTING.md`.

## Build

```powershell
./build.ps1                                   # Steam default game path
./build.ps1 -GamePath 'D:\...\Cities Skylines II'
```

Plain SDK-style net48 / C# 9 class library, referencing `Cities2_Data\Managed\*.dll` by HintPath with
`Private=false` (no official toolchain, no Burst, no source generators). Output: `dist/CS2MapBuilder/CS2MapBuilder.Mod.dll`
(+ pdb). The script also builds `CS2MapBuilder.PackageCheck` and runs its self test against `sample-package/`
(`-SkipTests` to skip). It stops with a clear message if `Game.dll` is not found under `-GamePath`.

## Install

`./install.ps1` copies `dist/CS2MapBuilder/` to `%LocalLow%\Colossal Order\Cities Skylines II\Mods\CS2MapBuilder\`
and creates the packages folder (`-WithSample` also copies the sample package). `./uninstall.ps1` removes the mod
(`-RemoveData` also removes `ModsData\CS2MapBuilder`). Restart the game after either.

## Packages

`%LocalLow%\Colossal Order\Cities Skylines II\ModsData\CS2MapBuilder\packages\<name>\` with `manifest.json`
(required) and any of `heightmap.png`, `worldmap.png`, `roads.json`, `trees.bin`, `water.json`, `climate.json`,
`resources/{fertile,ore,oil,groundwater}.png`. A missing file skips its step and is reported.

Out-of-game tools (`CS2MapBuilder.PackageCheck/bin/Release/PackageCheck.exe`):
`check <dir>` (validates a package exactly as the mod reads it), `selftest [sample-dir]`,
`make-marker <dir>` (terrain/water test package with corner markers), `make-trees <dir> <count>`.

`sample-package/` is hand-made: 42 nodes, 41 edges (Medium Road + Small Road, named, one road to the east border as the
outside connection), 12 trees, 1 lake source,
climate for Uppsala. It omits `heightmap.png`, `worldmap.png` and all `resources/*.png`.

## Using it

**Create a playable map (recommended).** Main menu -> Options -> CS2 Map Builder -> pick the package, check the map
name (defaults to the manifest name) -> **Create playable map**. The mod opens the Map Editor with a new map
(`GameManager.Load(GameMode.Editor, Purpose.NewMap)`, as the menu's Editor > New map does), runs the full import with
all steps, waits (bounded) for terrain, water and the checklist, sets the map name and description (place, coordinates,
scale, data attribution), theme and start tiles, logs each checklist item of `MapRequirementSystem` (starting area,
water in it, road connection, map name) and saves through `MapPanelSystem.SaveMap`, the method the editor's Save Map
dialog calls. The map is then under New Game and in the editor's Load Map list. Progress and the result appear on the
Options page and as a notification. An existing map name is refused unless **Overwrite existing map** is ticked, and
only your own maps can be overwritten. Leaving the editor midway stops the flow without saving. If a part cannot be done
from code, the editor's Save Map dialog is opened and the message says exactly what to type and click.
In the editor tab, **Save as playable map** does the metadata, checklist and save part for the open map.
In the main menu, a notification announces each package that has no saved map yet.

**Manual import.** Map Editor -> tab **CS2 Map Builder** (package icon): pick package, tick steps, **Import**, **Cancel**,
**Undo last import**, progress and the last log lines. Fallback with the same actions:
Options -> CS2 Map Builder. Imports are refused outside the Map Editor unless "Allow import outside the Map Editor" is on.
Logs: `Logs\CS2MapBuilder.log` and `ModsData\CS2MapBuilder\import.log` (per-step timing, counts, skipped/failed with
reasons, final summary). `ModsData\CS2MapBuilder\prefabs.txt` lists every net/tree/theme/climate prefab name in your game.

## Architecture

| Path | Role |
|---|---|
| `Mod.cs` | `IMod`: logs version + packages folder, options page, registers systems. No work on load. |
| `Package/` | Pure C# (no game refs): models, reader + validation, PNG codec, prefab fallback table, planning (tiers, connected components, Z-order, season units, row mapping). Also compiled into PackageCheck. |
| `Systems/MapFlowSystem.cs` | UIUpdate. "Create playable map" and "Save as playable map": editor load, import, settle, metadata, checklist, save, fallback dialog, notifications. |
| `Systems/MapCatalog.cs`, `PackageWatchSystem.cs` | Existing maps (same enumeration as the editor's map picker); main-menu notification for packages without a map. |
| `Systems/ImportSystem*.cs` | `GameSystemBase` at `ToolUpdate`. Frame-budgeted state machine; each step is an iterator, every `MoveNext` in try/catch so a failing step is reported and the rest continue. Steps: Validate -> Terrain -> Climate -> Water -> Resources -> Networks -> Names -> Trees -> StartTiles -> Finalize. Heavy file parsing runs on a worker thread. |
| `UI/` | `EditorTabRegistrationSystem` (UIUpdate, appends the tool to `EditorToolUISystem.tools` in the editor), `MapBuilderEditorTool` + `MapBuilderPanel` (`EditorPanelSystemBase`, C# widgets only). |
| `Settings/` | `ModSetting` options page: same actions + every in-game unknown as a switch. |

Networks: one Permanent `CreationDefinition` + `NetCourse` + `Updated` per edge from one archetype; tiers
highways+rail -> arterials -> local -> paths; whole connected components per frame (never split); node y computed once
per package node so shared ends are bit-identical; bridges/tunnels use per-end elevation and a straight height
profile; ground roads sample the terrain at the Bezier control points. After each frame, game nodes are matched to
package nodes (<= 1 m) for names and the optional entity link. Undo: the import snapshots edges/nodes/trees at start
and records the difference at the end (plus created water sources); undo adds `Deleted` in batches (trees, water,
edges with `Updated` on surviving neighbour nodes, then nodes). Terrain, climate, sea level, resources, names and
start tiles are not reverted. Records live only for the session.

## Known unknowns (only the game can answer; see TESTING.md)

| Unknown (spike 11) | Compensating setting |
|---|---|
| PNG row 0 = north (max z) | Flip heightmap rows (also applies to world map and resources) |
| Node merge across frames | Network batch size (larger = more per frame), Attach to existing nodes |
| Definitions consumed / settle time | Frames to wait between steps, Settle timeout |
| Water filling, legacy maps | Set the sea level, Water source ramp; step toggle |
| Tree budget, frame time | Maximum trees, Tree batch size, Frame budget |
| Start tiles via `GetStartTiles()` | Replace start tiles; step toggle |
| Climate clone persistence, names on aggregates | step toggles (Climate, Street names) |
| Undo by `Deleted` on nets | Undo batch size (no alternative path implemented) |
| Elevated course y = ground + elevation | none (reported by the node match count and visually) |
| Editor ready after `Load(Editor, NewMap)` | Frames to wait after the editor opens, Editor load timeout |
| Water and checklist settle time before saving | Maximum settle time (frames), Save timeout |

### Create playable map: what is verified only by compilation

Everything in `MapFlowSystem` compiles against 1.6.4 and follows the decompiled call sites, but has not run in game:
the editor load (`GameManager.Load(GameMode.Editor, Purpose.NewMap)` queued on `TaskManager` task "SaveLoadGame",
as `MenuUISystem.StartEditor`), the map name and description (written by reflection into the private
`MapPanelSystem.m_MapNameLocalization` / `m_MapDescriptionLocalization` LocalizationFields, then checked with
`IsValid()`), the checklist (`MapRequirementSystem.hasStartingArea`, `StartingAreaHasResource(SurfaceWater/GroundWater)`,
`roadConnection`, and `MapPanelSystem.MapIsPlayable()`), and the save (`MapPanelSystem.SaveMap` with
`AssetDatabase.user` and `SaveHelpers.GetAssetDataPath<MapMetadata>`, or the overwrite branch exactly as the editor's
`OnSaveMap`). No preview or thumbnail is captured: the editor saves without one when none is picked and the map list
falls back to the default image.

## Corrections to docs/MOD_SPIKE.md (checked against the 1.6.4 reference/DLLs)

1. `EditorTool.tool` is nullable (`[CanBeNull]`); a tab needs only a panel. No `ToolBaseSystem` subclass is used;
   the tab switches the active tool to `DefaultToolSystem` so no brush keeps emitting preview definitions.
2. `EditorPanelUISystem` calls `activePanel.Update()` and re-reads `children` every frame, so the panel needs no
   update registration and widget text can be dynamic (`displayNameAction`).
3. `NameSystem.SetCustomName` itself adds `CustomName` + `BatchesUpdated` through its end-frame barrier; the mod
   adds nothing else.
4. New water simulation (`WaterSimulation.SourceStep`): the target level is `Transform.y + m_Height`, a source with
   `m_Radius == 0` is ignored (so the ramp starts at 10 %, not 0), and `m_Polluted > 0` really switches to a flow source
   (confirmed in code, was "unverified"). Transform.y is set to the sampled ground and `m_Height = level - ground`,
   matching `WaterSystem.UpdateWaterSourcesHeights`.
5. `ReplaceHeightmap` / `ReplaceWorldHeightmap` use the current `heightScaleOffset`, so `SetTerrainProperties` must
   come first (answers part of 11.2). Outside the editor the terrain keeps the world-map texture you pass (do not destroy
   it), and a world map whose size differs from the heightmap is discarded.
6. `ClimatePrefab.RebuildCurves()` is public; `PrefabBase.Clone()` deep-copies through JSON, so the cloned seasons are
   independent objects (answers part of 11.7). `PrefabSystem.AddPrefab` returns bool.
7. Toolchain-free build: `EntityManager.CreateEntity(EntityArchetype)` does not compile against net48
   (`ReadOnlySpan` overload resolution, CS0518); use `CreateEntity(archetype, count, Allocator)`.
8. The game's `Newtonsoft.Json.dll` fails strong-name validation on .NET Framework outside the game, so the
   out-of-game checker targets .NET 10 (the mod itself stays net48).
9. Package type names must not be `RoadData`/`TreeData`/`WaterSourceData` in files that import `Game.Prefabs`
   (they exist there); the pure models are `PackageRoads`/`PackageTrees`.
