using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Colossal.Mathematics;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Package;
using Game.Net;
using Game.Simulation;
using Game.Tools;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CS2MapBuilder.Systems
{
    public sealed partial class ImportSystem
    {
        private const float kNodeMatchDistance = 1.0f;

        // ================================================================== Networks

        /// <summary>
        /// Step 6: one Permanent net definition per package edge (MOD_SPIKE 3.1 A), by class tier, whole connected
        /// components per frame, shared nodes bit-identical (node y is computed once per package node and reused).
        /// After each batch the generated nodes are matched back to package nodes by position.
        /// </summary>
        private IEnumerator NetworksStep(StepReport r)
        {
            if (m_Roads == null || m_Roads.Edges.Count == 0) { r.Status = "skipped"; r.Notes.Add("no roads in package"); yield break; }

            var data = m_TerrainSystem.GetHeightData(true);
            if (!data.isCreated) throw new InvalidOperationException("terrain height data not available");

            // Node world positions, computed once: identical floats for every course that touches the node.
            var nodePos = new Dictionary<int, float3>(m_Roads.Nodes.Count);
            foreach (var n in m_Roads.Nodes)
            {
                float ground = TerrainUtils.SampleHeight(ref data, new float3(n.X, 0f, n.Z));
                nodePos[n.Id] = new float3(n.X, ground + n.Elevation, n.Z);
            }
            var grid = BuildNodeGrid();

            var batches = ImportPlanning.PlanNetBatches(m_Roads, m_Opt.NetBatch, e => m_NetPrefabByKey.ContainsKey(e.Prefab));
            int planned = batches.Sum(b => b.EdgeIndices.Count);
            int skippedNoPrefab = m_Roads.Edges.Count - planned;
            r.Skip("edge prefab unresolved", skippedNoPrefab);
            for (int t = 0; t < ImportPlanning.TierNames.Length; t++)
            {
                var tb = batches.Where(b => b.Tier == t).ToList();
                if (tb.Count > 0)
                    r.Notes.Add($"tier {ImportPlanning.TierNames[t]}: {tb.Sum(b => b.EdgeIndices.Count)} edges, {tb.Sum(b => b.Components)} components, {tb.Count} frames, largest frame {tb.Max(b => b.EdgeIndices.Count)} edges");
            }

            var knownNodes = new HashSet<Entity>(m_StartNodes);
            int edgesBefore = m_EdgeQuery.CalculateEntityCount();
            var rng = new Unity.Mathematics.Random((uint)(Environment.TickCount | 1));
            int done = 0, linked = 0;

            foreach (var batch in batches)
            {
                if (m_CancelRequested) yield break;
                int count = batch.EdgeIndices.Count;
                int baseline = m_DefinitionQuery.CalculateEntityCount();
                using (var ents = EntityManager.CreateEntity(m_NetDefinitionArchetype, count, Allocator.Temp))
                {
                    for (int k = 0; k < count; k++)
                    {
                        var edge = m_Roads.Edges[batch.EdgeIndices[k]];
                        var course = BuildCourse(edge, nodePos, data, ref linked);
                        EntityManager.SetComponentData(ents[k], new CreationDefinition
                        {
                            m_Prefab = m_NetPrefabByKey[edge.Prefab],
                            m_Flags = CreationFlags.Permanent,
                            m_RandomSeed = rng.NextInt(),
                        });
                        EntityManager.SetComponentData(ents[k], course);
                    }
                }
                done += count;
                SetProgress(r, (float)done / Math.Max(1, planned), $"{done}/{planned} edges ({ImportPlanning.TierNames[batch.Tier]})");
                yield return WaitFrames.NextFrame;
                yield return WaitForDefinitions(r, "networks", baseline);
                yield return new WaitFrames(m_Opt.WaitFrames);
                MatchNewNodes(knownNodes, grid);
            }

            int created = m_EdgeQuery.CalculateEntityCount() - edgesBefore;
            r.Created = created;
            if (created < planned) r.Fail("edges not generated (merged, rejected or still pending)", planned - created);
            if (created > planned) r.Notes.Add($"{created - planned} more edges than definitions (the game split some courses)");
            r.Notes.Add($"{m_PkgNodeEntity.Count}/{m_Roads.Nodes.Count} package nodes matched to game nodes within {kNodeMatchDistance} m; {linked} course ends attached by entity");
            int outside = m_Roads.Nodes.Count(n => n.Outside);
            if (outside > 0)
            {
                int tagged = m_Roads.Nodes.Count(n => n.Outside && m_PkgNodeEntity.TryGetValue(n.Id, out var e) && EntityManager.HasComponent<OutsideConnection>(e));
                r.Notes.Add($"outside connections: {tagged}/{outside} border nodes carry Game.Net.OutsideConnection");
            }
        }

        private NetCourse BuildCourse(RoadEdgeJson edge, Dictionary<int, float3> nodePos, TerrainHeightData data, ref int linked)
        {
            var na = m_Roads.NodesById[edge.A];
            var nb = m_Roads.NodesById[edge.B];
            float3 a = nodePos[edge.A];
            float3 d = nodePos[edge.B];
            Entity ea = Entity.Null, eb = Entity.Null;
            if (m_Opt.LinkExistingNodes)
            {
                if (m_PkgNodeEntity.TryGetValue(edge.A, out ea) && EntityManager.Exists(ea)) { a = EntityManager.GetComponentData<Node>(ea).m_Position; linked++; }
                else ea = Entity.Null;
                if (m_PkgNodeEntity.TryGetValue(edge.B, out eb) && EntityManager.Exists(eb)) { d = EntityManager.GetComponentData<Node>(eb).m_Position; linked++; }
                else eb = Entity.Null;
            }

            var bz = edge.Bezier;
            bool elevated = Math.Abs(na.Elevation) > 0.01f || Math.Abs(nb.Elevation) > 0.01f || edge.Bridge || edge.Tunnel;
            float3 b, c;
            if (elevated)
            {
                // Bridges and tunnels: straight height profile between the ends (no sag, MOD_SPIKE 3.2).
                b = new float3((float)bz[2], math.lerp(a.y, d.y, 1f / 3f), (float)bz[3]);
                c = new float3((float)bz[4], math.lerp(a.y, d.y, 2f / 3f), (float)bz[5]);
            }
            else
            {
                b = new float3((float)bz[2], TerrainUtils.SampleHeight(ref data, new float3((float)bz[2], 0f, (float)bz[3])), (float)bz[3]);
                c = new float3((float)bz[4], TerrainUtils.SampleHeight(ref data, new float3((float)bz[4], 0f, (float)bz[5])), (float)bz[5]);
            }
            var curve = new Bezier4x3(a, b, c, d);

            return new NetCourse
            {
                m_StartPosition = new CoursePos
                {
                    m_Entity = ea,
                    m_Position = a,
                    m_Rotation = NetUtils.GetNodeRotation(MathUtils.StartTangent(curve)),
                    m_Elevation = new float2(na.Elevation),
                    m_CourseDelta = 0f,
                    m_SplitPosition = 0f,
                    m_Flags = CoursePosFlags.IsFirst,
                    m_ParentMesh = -1,
                },
                m_EndPosition = new CoursePos
                {
                    m_Entity = eb,
                    m_Position = d,
                    m_Rotation = NetUtils.GetNodeRotation(MathUtils.EndTangent(curve)),
                    m_Elevation = new float2(nb.Elevation),
                    m_CourseDelta = 1f,
                    m_SplitPosition = 1f,
                    m_Flags = CoursePosFlags.IsLast,
                    m_ParentMesh = -1,
                },
                m_Curve = curve,
                m_Elevation = new float2(na.Elevation, nb.Elevation),
                m_Length = MathUtils.Length(curve),
                m_FixedIndex = -1,
            };
        }

        // ------------------------------------------------------------------ node matching

        private Dictionary<long, List<RoadNode>> BuildNodeGrid()
        {
            var grid = new Dictionary<long, List<RoadNode>>();
            foreach (var n in m_Roads.Nodes)
            {
                long key = CellKey(n.X, n.Z);
                if (!grid.TryGetValue(key, out var list)) grid[key] = list = new List<RoadNode>();
                list.Add(n);
            }
            return grid;
        }

        private static long CellKey(float x, float z)
        {
            long cx = (long)Math.Floor(x / 8f), cz = (long)Math.Floor(z / 8f);
            return (cx << 32) ^ (cz & 0xFFFFFFFFL);
        }

        /// <summary>Maps game nodes not seen before to the nearest package node within kNodeMatchDistance (xz).</summary>
        private int MatchNewNodes(HashSet<Entity> known, Dictionary<long, List<RoadNode>> grid)
        {
            int matched = 0;
            using (var arr = m_NodeQuery.ToEntityArray(Allocator.TempJob))
            {
                foreach (var e in arr)
                {
                    if (!known.Add(e)) continue;
                    var p = EntityManager.GetComponentData<Node>(e).m_Position;
                    RoadNode best = null;
                    float bestD = kNodeMatchDistance;
                    long cx = (long)Math.Floor(p.x / 8f), cz = (long)Math.Floor(p.z / 8f);
                    for (long dx = -1; dx <= 1; dx++)
                        for (long dz = -1; dz <= 1; dz++)
                        {
                            if (!grid.TryGetValue(((cx + dx) << 32) ^ ((cz + dz) & 0xFFFFFFFFL), out var list)) continue;
                            foreach (var n in list)
                            {
                                float dd = math.distance(new float2(n.X, n.Z), p.xz);
                                if (dd <= bestD) { bestD = dd; best = n; }
                            }
                        }
                    if (best != null)
                    {
                        m_PkgNodeEntity[best.Id] = e;
                        matched++;
                    }
                }
            }
            return matched;
        }

        // ================================================================== Street names

        /// <summary>
        /// Step 7: after the aggregates exist, NameSystem.SetCustomName(aggregate, name). One aggregate can span
        /// several package names; the most frequent wins and conflicts are counted.
        /// </summary>
        private IEnumerator NamesStep(StepReport r)
        {
            if (m_Roads == null) { r.Status = "skipped"; r.Notes.Add("no roads in package"); yield break; }
            var named = new Dictionary<long, string>();
            foreach (var e in m_Roads.Edges)
                if (!string.IsNullOrWhiteSpace(e.Name)) named[PairKey(e.A, e.B)] = e.Name.Trim();
            if (named.Count == 0) { r.Status = "skipped"; r.Notes.Add("no named edges"); yield break; }

            yield return new WaitFrames(Math.Max(60, m_Opt.WaitFrames));
            if (m_PkgNodeEntity.Count == 0)
            {
                // Networks were not imported in this run: match existing game nodes by position.
                MatchNewNodes(new HashSet<Entity>(), BuildNodeGrid());
                r.Notes.Add($"matched {m_PkgNodeEntity.Count} existing game nodes by position");
            }
            var pkgOfEntity = new Dictionary<Entity, int>();
            foreach (var kv in m_PkgNodeEntity) pkgOfEntity[kv.Value] = kv.Key;

            Dictionary<Entity, Dictionary<string, int>> byAggregate = null;
            int noAggregate = 0, unmatched = 0;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                byAggregate = new Dictionary<Entity, Dictionary<string, int>>();
                noAggregate = 0; unmatched = 0;
                int pendingNull = 0;
                using (var arr = m_EdgeQuery.ToEntityArray(Allocator.TempJob))
                {
                    foreach (var e in arr)
                    {
                        var edge = EntityManager.GetComponentData<Edge>(e);
                        if (!pkgOfEntity.TryGetValue(edge.m_Start, out int a) || !pkgOfEntity.TryGetValue(edge.m_End, out int b)) continue;
                        if (!named.TryGetValue(PairKey(a, b), out var name)) continue;
                        if (!EntityManager.HasComponent<Aggregated>(e)) { noAggregate++; continue; }
                        var agg = EntityManager.GetComponentData<Aggregated>(e).m_Aggregate;
                        if (agg == Entity.Null) { pendingNull++; continue; }
                        if (!byAggregate.TryGetValue(agg, out var counts)) byAggregate[agg] = counts = new Dictionary<string, int>();
                        counts[name] = (counts.TryGetValue(name, out int c) ? c : 0) + 1;
                    }
                }
                unmatched = pendingNull;
                if (pendingNull == 0) break;
                ImportLog.Info($"Names: {pendingNull} named edges have no aggregate yet; waiting (attempt {attempt + 1}/5)");
                yield return new WaitFrames(60);
            }

            int conflicts = 0;
            NameApplySystem.ResetCounters();
            foreach (var kv in byAggregate)
            {
                var best = kv.Value.OrderByDescending(x => x.Value).First();
                if (kv.Value.Count > 1) conflicts++;
                // Applied at UIUpdate by NameApplySystem: SetCustomName cannot run at ToolUpdate (EndFrameBarrier not yet allowed).
                NameApplySystem.Enqueue(kv.Key, best.Key);
            }
            int waited = 0;
            while (NameApplySystem.Pending > 0 && waited < m_Opt.SettleTimeout)
            {
                waited++;
                yield return WaitFrames.NextFrame;
            }
            r.Created = NameApplySystem.Applied;
            r.Fail("names not applied: " + (NameApplySystem.LastError ?? "timeout"), NameApplySystem.Failed + NameApplySystem.Pending);
            r.Skip("named edges without Aggregated component", noAggregate);
            r.Skip("named edges whose aggregate never appeared", unmatched);
            if (conflicts > 0) r.Notes.Add($"{conflicts} aggregates covered several names; the most frequent name was used");
            int namedGame = byAggregate.Sum(kv => kv.Value.Values.Sum());
            r.Notes.Add($"{named.Count} named package edges, {namedGame} matched game edges, {byAggregate.Count} aggregates named");
        }

        private static long PairKey(int a, int b)
        {
            int lo = Math.Min(a, b), hi = Math.Max(a, b);
            return ((long)lo << 32) | (uint)hi;
        }
    }
}
