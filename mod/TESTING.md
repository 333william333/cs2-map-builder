# In-game test protocol: CS2 Map Builder importer

Each run answers one or more of the open questions in `docs/MOD_SPIKE.md` section 11, cheapest first.
Run the steps in order. After each step: send back the log lines listed (from
`%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\ModsData\CS2MapBuilder\import.log`)
and a screenshot if anything looks wrong.

Settings live in two places: the **CS2 Map Builder** tab in the map editor (package selection, steps, buttons) and
**Options -> CS2 Map Builder** (the same buttons plus the *Advanced* tab with all the toggles below).

## 0. Preparation (once)

1. Build: run `mod\build.ps1` in PowerShell. It should end with `ALL TESTS PASSED` and `Done: ...\dist\CS2MapBuilder`.
2. Install (your decision): `mod\install.ps1 -WithSample`. This copies the DLL to
   `...\Cities Skylines II\Mods\CS2MapBuilder\` and the sample package to `ModsData\CS2MapBuilder\packages\sample-package\`.
3. Create test packages with the tool (from the `mod` folder):
   ```powershell
   $p = "$env:USERPROFILE\AppData\LocalLow\Colossal Order\Cities Skylines II\ModsData\CS2MapBuilder\packages"
   .\CS2MapBuilder.PackageCheck\bin\Release\PackageCheck.exe make-marker "$p\marker-test"
   .\CS2MapBuilder.PackageCheck\bin\Release\PackageCheck.exe make-trees "$p\trees-10000" 10000
   .\CS2MapBuilder.PackageCheck\bin\Release\PackageCheck.exe make-trees "$p\trees-100000" 100000
   .\CS2MapBuilder.PackageCheck\bin\Release\PackageCheck.exe make-trees "$p\trees-300000" 300000
   ```
   Each command ends with `RESULT ok`.
4. Start the game. **Send:** the line `CS2 Map Builder importer ... loading (game ...). Packages folder: ...`
   and the line `... loaded.` from `Logs\CS2MapBuilder.log` (the same lines are in import.log).
   If they do not appear, the mod did not load (question 13, toolchain-free build). Send `Logs\Modding.log` and `Player.log` instead.

## 1. Loading and the map editor tab

1. Main menu -> Editor -> Map Editor -> new map.
2. Wait a few seconds. Look for a new tab with a package icon in the toolbar (next to Import/Prefab/Photo/Bulldozer).
3. **Send:** the line `Editor tab 'CS2MapBuilder' registered (...)` or the error line `Could not register the editor tab`.
4. If no tab appears, use **Options -> CS2 Map Builder** for all the steps below (the same buttons).

## 2. North and height scale (questions 11.1 and 11.2)

Package: `marker-test`. It has a 400 m plateau in the **northwest** corner (900 x 900 m), a 250 m block in the
**northeast** corner (450 x 450 m, smaller), a pit east of the center and a low strip along the **south** edge.
Base level 100 m, height scale 1000 m.

1. Tick only **Terrain**. Everything else off.
2. Select `marker-test` and click **Import**. Wait until the status line says `done`.
3. Look: using the compass in the editor, is the big plateau in the northwest and the small block in the northeast?
   Is the low strip in the south?
4. **Send:** all `height probe ...` lines and the `Step Terrain ...` line. Example of a correct result:
   `height probe NW (x-, z+) ...: game 400.0 m, package 400.0 m`.
5. If the plateau ended up in the **southwest** (and the strip in the north): turn on **Flip heightmap rows (north/south)** under
   Options -> Advanced and import again. Let us know, and it becomes the default.
   If the plateau ended up in the **northeast** (mirrored east-west) there is no toggle: send a screenshot.
6. If the heights in the probes differ from `package` by more than a meter or so: send the lines, this answers 11.2.

## 3. Five roads (questions 11.3, 11.4, 11.11)

Package: `sample-package` (6 nodes, 5 roads: one junction with a Medium Road east-west, a Small Road north-south and a
curved Small Road heading east, all named). Two classes mean two different frames: the link between Storgatan and Ågatan
at node x=150 tests merging across frames.

1. Tick only **Roads, rail, paths** and **Street names**. Import into an empty part of the map near the center
   (the roads are placed around coordinate 0,0).
2. Look: a four-way junction in the middle, a curved road heading east that connects to the east arm (no gap, no
   dead end), and the names Storgatan, Kyrkogatan and Ågatan on the roads.
3. **Send:** the lines `Step Networks ...`, `Networks: tier ...`, `Networks: ... package nodes matched ...`,
   `Step Names ...` and any `definitions still pending`.
4. If Ågatan does not connect to Storgatan: turn on **Attach to existing nodes** and import again (Undo first).
   Send the same lines.
5. Click **Undo last import**. All five roads should disappear. **Send:** the lines `Undo of ...` and `Undo done: ...`.
6. Save the map after a fresh import (the Save dialog). Is the map marked as modified? Reload it: are the roads and
   names still there? (questions 11.3, 11.11)

## 4. Water (question 11.6)

Package: `marker-test` again (the terrain from step 2 should still be there). Sea level 50 m, a lake with surface 90 m in the pit
at x=+2000, z=0.

1. Tick only **Sea level + water sources**. Import.
2. Look: the sea fills the low strip in the south (20 m) but not the plain (100 m). The pit east of the center fills
   slowly into a lake. Let the game run (time speed) for 3-5 minutes.
3. **Send:** the lines `Step Water ...`, `sea level ... -> 50.0`, `Water: 1 sources created ...` and any line
   that starts with `WARNING: this map uses LEGACY water sources`. Note roughly how many minutes the lake takes.
4. If the sea does not change: check that **Set the sea level** is on. If the lake never appears: set
   **Water source ramp (frames)** to 0 and import again (Undo first removes the source).
   If it says LEGACY: click *Upgrade water sources* in the editor's Water panel and import again.

## 5. Trees in increasing numbers (question 11.10)

Packages: `trees-10000`, then `trees-100000`, then `trees-300000`. The trees are in a 6 x 6 km square around the center,
three species (birch, pine, oak), mixed ages.

1. Tick only **Trees**. Set **Maximum trees** to 1,000,000 under Advanced so nothing is thinned out.
2. Import `trees-10000`. Watch the FPS (for example the Steam overlay) and the memory in Task Manager before and after.
3. **Send:** the line `Step Trees ...` (time and count), the line `Trees: ... definitions queued ...`, FPS before/after
   and the game's memory usage.
4. Click **Undo last import**, send `Undo done` and the time. Repeat with 100,000 and then 300,000.
5. If the game stutters heavily during the import: lower **Tree batch size** (for example 2000) and try again.
   If it freezes completely at 300,000: set **Maximum trees** lower and say at which count it worked.
6. If the line says `trees not generated`: send it, because not all definitions were consumed.

## 6. Climate, theme and start tiles (questions 11.7 and 11.8)

Package: `sample-package`.

1. Tick only **Climate, theme, lat/lon** and **Start tiles**.
2. Look in the editor's Climate panel: a new climate preset `CS2MapBuilder sample-package`, latitude 59.86,
   longitude 17.64, seasonal temperatures matching Uppsala. Theme European. Start area = 3 x 3 tiles in the middle.
3. **Send:** the lines `Step Climate ...`, all `season '...' <- ...`, `climate set: ...`, `theme ...`,
   `Step StartTiles ...` and `start tiles ... -> ...`.
4. Save the map, quit to the menu, load the map again. Are the climate, latitude/longitude and start tiles still there?
5. If the start tiles do not show up immediately but exist after a reload: let us know (the border mesh is not updated).
   If they come out wrong: turn off **Replace start tiles** and test again, or turn the step off.

## 7. Full package from the app (when the desktop app exports packages)

1. Export a small area (a few km) from the app to the package folder. Tick all steps.
2. If the import aborts with `prefabs not found in this game`: send that line and the file
   `ModsData\CS2MapBuilder\prefabs.txt` (question 11.12).
3. **Send:** the whole block from `==== SUMMARY` to `==== RESULT`, all `prefab substitution` lines, the line
   `outside connections: x/y border nodes ...` and `Networks: ... package nodes matched ...`.
4. Look for: bridges that sink (11.5), tunnel mouths, dead ends where roads should meet (11.4),
   exit markers at the map edge (6h).
5. If the game freezes during the network step: lower **Network batch size**. Note: whole connected road networks are never split,
   so one large connected network still runs in a single frame. Send the time from `Step Networks`.
6. If the steps wait for a long time (`definitions still pending ... (timeout)`): raise **Settle timeout** or
   **Frames to wait between steps**.

## Toggles to know about (Options -> CS2 Map Builder -> Advanced)

| Toggle | Default | Change when |
|---|---|---|
| Flip heightmap rows (north/south) | off | the terrain is mirrored north-south (step 2) |
| Attach to existing nodes | off | roads of different classes do not connect (step 3) |
| Replace start tiles | on | the start tiles should be added instead of replaced |
| Network batch size | 20,000 | the game stutters (lower) or nodes are not merged (higher) |
| Tree batch size | 10,000 | the game stutters during tree import |
| Maximum trees | 400,000 | performance (step 5) |
| Frames to wait between steps | 30 | the game does not finish between steps |
| Settle timeout (frames) | 600 | `definitions still pending ... (timeout)` in the log |
| Undo batch size | 2,000 | Undo stutters (lower) |
| Frame budget (ms) | 12 | the import takes too much time per frame |
| Set the sea level | on | the sea level should be left untouched |
| Water source ramp (frames) | 120 | lakes do not fill |
| Skip trees below sea level | on | trees are missing on low land that is not sea |
| Allow import outside the Map Editor | off | leave alone: importing into a city is not supported |

Undo only works for the latest import in the same game session. Terrain, climate, sea level, resources, names and
start tiles are not restored by Undo.
