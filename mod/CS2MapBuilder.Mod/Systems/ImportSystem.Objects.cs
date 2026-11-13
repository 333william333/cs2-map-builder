using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using Game.Areas;
using Game.Common;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MapBuilder.Systems
{
    public sealed partial class ImportSystem
    {
        // ================================================================== Trees

        /// <summary>Step 8: Permanent object definitions in Z-order chunks (MOD_SPIKE 4).</summary>
        private IEnumerator TreesStep(StepReport r)
        {
            if (m_Trees == null || m_Trees.Count == 0) { r.Status = "skipped"; r.Notes.Add("no trees in package"); yield break; }

            int[] order = null;
            yield return RunAsync(() => ImportPlanning.ZOrder(m_Trees.XZ, m_Trees.Count), o => order = o);
            int total = order.Length;
            order = ImportPlanning.Subsample(order, m_Opt.MaxTrees);
            r.Skip("thinned by 'Maximum trees'", total - order.Length);

            var data = m_TerrainSystem.GetHeightData(true);
            if (!data.isCreated) throw new InvalidOperationException("terrain height data not available");
            bool seaCheck = m_Opt.SkipTreesBelowSea && !float.IsNaN(m_AppliedSeaLevel) && m_AppliedSeaLevel > 0f;
            if (!seaCheck && m_Opt.SkipTreesBelowSea)
            {
                var hasSea = m_Water?.HasSea ?? m_Pkg.Manifest.HasSea;
                if (hasSea) { seaCheck = true; m_AppliedSeaLevel = m_WaterSystem.SeaLevel; }
            }

            var rng = new Unity.Mathematics.Random((uint)(Environment.TickCount | 1));
            int treesBefore = m_TreeQuery.CalculateEntityCount();
            int baseline = m_DefinitionQuery.CalculateEntityCount();
            int pos = 0, queued = 0, belowSea = 0, noPrefab = 0;
            var batch = new List<int>(m_Opt.TreeBatch);
            while (pos < order.Length)
            {
                if (m_CancelRequested) yield break;
                batch.Clear();
                while (pos < order.Length && batch.Count < m_Opt.TreeBatch)
                {
                    int i = order[pos++];
                    int sp = m_Trees.Species[i];
                    if (sp >= m_TreePrefabBySpecies.Length || m_TreePrefabBySpecies[sp] == Entity.Null) { noPrefab++; continue; }
                    batch.Add(i);
                }
                if (batch.Count > 0)
                {
                    using (var ents = EntityManager.CreateEntity(m_ObjectDefinitionArchetype, batch.Count, Allocator.Temp))
                    {
                        int used = 0;
                        for (int k = 0; k < batch.Count; k++)
                        {
                            int i = batch[k];
                            float x = m_Trees.XZ[2 * i], z = m_Trees.XZ[2 * i + 1];
                            float ground = TerrainUtils.SampleHeight(ref data, new float3(x, 0f, z));
                            if (seaCheck && ground < m_AppliedSeaLevel) { belowSea++; continue; }
                            var e = ents[used++];
                            EntityManager.SetComponentData(e, new CreationDefinition
                            {
                                m_Prefab = m_TreePrefabBySpecies[m_Trees.Species[i]],
                                m_Flags = CreationFlags.Permanent,
                                m_RandomSeed = rng.NextInt(),
                            });
                            EntityManager.SetComponentData(e, new ObjectDefinition
                            {
                                m_Position = new float3(x, ground, z),
                                m_Rotation = quaternion.RotateY(rng.NextFloat(0f, 2f * math.PI)),
                                m_LocalRotation = quaternion.identity,
                                m_Scale = new float3(1f),
                                m_Intensity = 1f,
                                m_Age = ImportPlanning.TreeAge(m_Trees.Age[i]),
                                m_ParentMesh = -1,
                                m_GroupIndex = -1,
                                m_Probability = 100,
                                m_PrefabSubIndex = -1,
                            });
                        }
                        // Entities not used (trees below sea level) are destroyed before the game sees them.
                        if (used < ents.Length)
                            EntityManager.DestroyEntity(ents.GetSubArray(used, ents.Length - used));
                        queued += used;
                    }
                }
                SetProgress(r, (float)pos / order.Length, $"{queued} trees queued");
                yield return WaitFrames.NextFrame;
            }
            r.Skip("ground below sea level", belowSea);
            r.Skip("species prefab unresolved", noPrefab);

            yield return WaitForDefinitions(r, "trees", baseline);
            yield return new WaitFrames(m_Opt.WaitFrames);
            int created = m_TreeQuery.CalculateEntityCount() - treesBefore;
            r.Created = created;
            if (created < queued) r.Fail("trees not generated", queued - created);
            r.Notes.Add($"{queued} definitions queued in chunks of {m_Opt.TreeBatch}; tree count now {m_TreeQuery.CalculateEntityCount()}");
        }

        // ================================================================== Start tiles

        /// <summary>Step 9: start tiles via MapTileSystem.GetStartTiles() (MOD_SPIKE 6, inferred).</summary>
        private IEnumerator StartTilesStep(StepReport r)
        {
            var st = m_Pkg.Manifest.StartTile;
            if (st == null) { r.Status = "skipped"; r.Notes.Add("manifest has no startTile"); yield break; }
            r.Created = ApplyStartTiles(st.Col, st.Row, m_Opt.ReplaceStartTiles, r.Notes);
        }

        /// <summary>
        /// Sets the start area to the 3x3 tiles around (col, row) of the 23x23 grid (row 0 = top). Returns tiles added.
        /// Public so the playable-map flow can repair a missing start area.
        /// </summary>
        public int ApplyStartTiles(int col0, int row0, bool replace, List<string> notes)
        {
            // Tile centres from their area nodes.
            var tiles = new List<(Entity e, float2 c)>();
            using (var arr = m_MapTileQuery.ToEntityArray(Allocator.TempJob))
            {
                foreach (var e in arr)
                {
                    var nodes = EntityManager.GetBuffer<Game.Areas.Node>(e, true);
                    if (nodes.Length == 0) continue;
                    float2 sum = float2.zero;
                    for (int i = 0; i < nodes.Length; i++) sum += nodes[i].m_Position.xz;
                    tiles.Add((e, sum / nodes.Length));
                }
            }
            if (tiles.Count == 0) throw new InvalidOperationException("no map tiles found");
            float cell = 2f * PackageFormat.PlayableHalf / PackageFormat.TileGrid;

            var wanted = new List<Entity>();
            int missing = 0;
            for (int dr = -1; dr <= 1; dr++)
                for (int dc = -1; dc <= 1; dc++)
                {
                    int col = col0 + dc, row = row0 + dr;
                    if (col < 0 || row < 0 || col >= PackageFormat.TileGrid || row >= PackageFormat.TileGrid) continue;
                    ImportPlanning.TileCenter(col, row, out float x, out float z);
                    var target = new float2(x, z);
                    var best = tiles.OrderBy(t => math.distancesq(t.c, target)).First();
                    if (math.distance(best.c, target) > cell * 0.6f) { missing++; continue; }
                    if (!wanted.Contains(best.e)) wanted.Add(best.e);
                }

            var list = m_MapTileSystem.GetStartTiles();
            int before = list.Length;
            if (replace) list.Clear();
            int added = 0;
            foreach (var e in wanted)
            {
                bool present = false;
                for (int i = 0; i < list.Length; i++) if (list[i] == e) { present = true; break; }
                if (!present) { list.Add(e); added++; }
            }
            foreach (var e in wanted) EntityManager.AddComponent<Updated>(e);
            notes?.Add($"start tiles {before} -> {list.Length} (centre col {col0}, row {row0}; {tiles.Count} map tiles in the map; replace={replace}; {missing} grid cells without a tile)");
            return added;
        }

        // ================================================================== Finalize

        private IEnumerator FinalizeStep(StepReport r)
        {
            m_Status = $"{m_PackageName}: finishing";
            yield return WaitForDefinitions(r, "finalize");
            yield return new WaitFrames(m_Opt.WaitFrames);

            m_Record.Edges.AddRange(NewSince(m_EdgeQuery, m_StartEdges));
            m_Record.Nodes.AddRange(NewSince(m_NodeQuery, m_StartNodes));
            m_Record.Trees.AddRange(NewSince(m_TreeQuery, m_StartTrees));
            m_StartEdges = m_StartNodes = m_StartTrees = null;
            if (m_Record.Total > 0) m_LastRecord = m_Record;
            r.Created = m_Record.Total;
            r.Notes.Add($"undo record: {m_Record.Edges.Count} edges, {m_Record.Nodes.Count} nodes, {m_Record.Trees.Count} trees, {m_Record.WaterSources.Count} water sources");

            m_TotalTimer.Stop();
            ImportLog.Info("==== SUMMARY " + m_PackageName + (m_Aborted ? " (ABORTED: " + m_AbortReason + ")" : "") + $" total {m_TotalTimer.Elapsed.TotalSeconds:0.0} s");
            foreach (var s in m_Steps)
                if (s.Name != "Finalize") ImportLog.Info("  " + s.Report.Line());
            int failedSteps = m_Steps.Count(s => s.Report.Status == "failed" || s.Report.Status == "partial");
            string result = m_Aborted ? "aborted: " + m_AbortReason
                : failedSteps > 0 ? $"done with problems in {failedSteps} step(s), see import.log"
                : "done";
            ImportLog.Info("==== RESULT " + result + ". Save the map from the editor's Save dialog to keep it.");
            m_Status = $"{m_PackageName}: {result}";
            m_Progress = 1f;
        }

        // ================================================================== Undo

        /// <summary>Deletes what the last import created, in batches (MOD_SPIKE 10: ~2k per frame), trees first.</summary>
        private IEnumerator UndoJob(ImportRecord rec)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int deleted = 0;
            int total = rec.Total;
            ImportLog.Info($"Undo of '{rec.Package}': {rec.Trees.Count} trees, {rec.Edges.Count} edges, {rec.Nodes.Count} nodes, {rec.WaterSources.Count} water sources");

            foreach (var group in new[] { ("trees", rec.Trees), ("water sources", rec.WaterSources) })
            {
                for (int i = 0; i < group.Item2.Count; i += m_Opt.UndoBatch)
                {
                    if (m_CancelRequested) { FinishUndo(rec, deleted, true); yield break; }
                    deleted += DeleteBatch(group.Item2, i, m_Opt.UndoBatch, null);
                    m_Status = $"Undo: {deleted}/{total} ({group.Item1})";
                    yield return WaitFrames.NextFrame;
                }
            }

            var recordedNodes = new HashSet<Entity>(rec.Nodes);
            for (int i = 0; i < rec.Edges.Count; i += m_Opt.UndoBatch)
            {
                if (m_CancelRequested) { FinishUndo(rec, deleted, true); yield break; }
                deleted += DeleteBatch(rec.Edges, i, m_Opt.UndoBatch, recordedNodes);
                m_Status = $"Undo: {deleted}/{total} (edges)";
                yield return WaitFrames.NextFrame;
            }
            for (int i = 0; i < rec.Nodes.Count; i += m_Opt.UndoBatch)
            {
                if (m_CancelRequested) { FinishUndo(rec, deleted, true); yield break; }
                deleted += DeleteBatch(rec.Nodes, i, m_Opt.UndoBatch, null);
                m_Status = $"Undo: {deleted}/{total} (nodes)";
                yield return WaitFrames.NextFrame;
            }
            ImportLog.Info($"Undo finished in {sw.Elapsed.TotalSeconds:0.0} s. Terrain, climate, sea level, resources, names and start tiles are not reverted.");
            FinishUndo(rec, deleted, false);
        }

        private void FinishUndo(ImportRecord rec, int deleted, bool cancelled)
        {
            m_Status = cancelled ? $"Undo cancelled after {deleted} entities" : $"Undo done: {deleted} entities deleted";
            ImportLog.Info(m_Status);
            if (!cancelled && ReferenceEquals(m_LastRecord, rec)) m_LastRecord = null;
        }

        /// <summary>
        /// Adds Deleted to entities [start, start+count) that still exist. For edges, the end nodes that are NOT
        /// part of the record are marked Updated so the game rebuilds them (as ApplyNetSystem does for deletes).
        /// </summary>
        private int DeleteBatch(List<Entity> list, int start, int count, HashSet<Entity> recordedNodes)
        {
            int end = Math.Min(list.Count, start + count);
            var batch = new NativeList<Entity>(end - start, Allocator.Temp);
            var touched = new HashSet<Entity>();
            for (int i = start; i < end; i++)
            {
                var e = list[i];
                if (!EntityManager.Exists(e) || EntityManager.HasComponent<Deleted>(e)) continue;
                batch.Add(e);
                if (recordedNodes != null && EntityManager.HasComponent<Game.Net.Edge>(e))
                {
                    var edge = EntityManager.GetComponentData<Game.Net.Edge>(e);
                    if (!recordedNodes.Contains(edge.m_Start)) touched.Add(edge.m_Start);
                    if (!recordedNodes.Contains(edge.m_End)) touched.Add(edge.m_End);
                }
            }
            int n = batch.Length;
            if (n > 0) EntityManager.AddComponent<Deleted>(batch.AsArray());
            foreach (var t in touched)
                if (EntityManager.Exists(t) && !EntityManager.HasComponent<Deleted>(t) && !EntityManager.HasComponent<Updated>(t))
                    EntityManager.AddComponent<Updated>(t);
            batch.Dispose();
            return n;
        }

        private void RunUndo(System.Diagnostics.Stopwatch budget)
        {
            while (m_Mode == Mode.Undoing && budget.ElapsedMilliseconds < m_Opt.BudgetMs)
            {
                bool more;
                object yielded;
                try { more = m_UndoJob.MoveNext(out yielded); }
                catch (Exception e)
                {
                    ImportLog.Error("Undo failed", e);
                    StopAll("Undo failed, see import.log");
                    return;
                }
                if (!more)
                {
                    m_UndoJob.Dispose();
                    m_UndoJob = null;
                    m_Mode = Mode.Idle;
                    m_CancelRequested = false;
                    return;
                }
                if (yielded is WaitFrames w) { m_WaitFrames = w.Frames - 1; return; }
            }
        }
    }
}
