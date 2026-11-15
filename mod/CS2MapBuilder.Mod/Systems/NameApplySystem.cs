using System;
using System.Collections.Generic;
using CS2MapBuilder.Infrastructure;
using Game;
using Game.UI;
using Unity.Entities;

namespace CS2MapBuilder.Systems
{
    /// <summary>
    /// Applies street names at UIUpdate. NameSystem.SetCustomName writes through EndFrameBarrier, a
    /// SafeCommandBufferSystem that only allows new command buffers after AllowBarrier&lt;EndFrameBarrier&gt; has run in
    /// MainLoop. ToolUpdate (where ImportSystem runs) comes before that, so calling it there throws
    /// "Trying to create EntityCommandBuffer when it's not allowed!" (seen in game). UIUpdate runs after it, like the
    /// game's own rename UI.
    /// </summary>
    public sealed class NameApplySystem : GameSystemBase
    {
        private static readonly Queue<KeyValuePair<Entity, string>> s_Queue = new Queue<KeyValuePair<Entity, string>>();
        private const int kPerFrame = 2000;
        private NameSystem m_NameSystem;

        public static int Pending { get { lock (s_Queue) return s_Queue.Count; } }
        public static int Applied { get; private set; }
        public static int Failed { get; private set; }
        public static string LastError { get; private set; }

        public static void Enqueue(Entity entity, string name)
        {
            lock (s_Queue) s_Queue.Enqueue(new KeyValuePair<Entity, string>(entity, name));
        }

        public static void ResetCounters()
        {
            Applied = 0; Failed = 0; LastError = null;
        }

        protected override void OnCreate()
        {
            base.OnCreate();
            m_NameSystem = World.GetOrCreateSystemManaged<NameSystem>();
        }

        protected override void OnUpdate()
        {
            if (Pending == 0) return;
            for (int i = 0; i < kPerFrame; i++)
            {
                KeyValuePair<Entity, string> item;
                lock (s_Queue)
                {
                    if (s_Queue.Count == 0) break;
                    item = s_Queue.Dequeue();
                }
                try
                {
                    if (!EntityManager.Exists(item.Key)) { Failed++; LastError = "entity no longer exists"; continue; }
                    m_NameSystem.SetCustomName(item.Key, item.Value);
                    Applied++;
                }
                catch (Exception e)
                {
                    Failed++;
                    if (LastError == null) ImportLog.Error("Setting a street name failed", e);
                    LastError = e.Message;
                }
            }
        }
    }
}
