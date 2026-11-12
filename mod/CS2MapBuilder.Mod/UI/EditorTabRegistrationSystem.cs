using System;
using System.Linq;
using CS2MapBuilder.Infrastructure;
using CS2MapBuilder.Settings;
using Game;
using Game.SceneFlow;
using Game.UI.Editor;

namespace CS2MapBuilder.UI
{
    /// <summary>
    /// Appends the CS2 Map Builder tab to EditorToolUISystem.tools while the editor is open (MOD_SPIKE 8).
    /// Checks every 60 frames and only in the editor; if registration fails, the options page is the fallback.
    /// </summary>
    public sealed class EditorTabRegistrationSystem : GameSystemBase
    {
        private EditorToolUISystem m_EditorToolUISystem;
        private MapBuilderEditorTool m_Tool;
        private int m_Frame;
        private bool m_LoggedOk, m_LoggedFail;

        protected override void OnUpdate()
        {
            if ((++m_Frame % 60) != 0) return;
            var gm = GameManager.instance;
            if (gm == null || gm.gameMode != GameMode.Editor || gm.isGameLoading) return;
            try
            {
                if (m_EditorToolUISystem == null) m_EditorToolUISystem = World.GetExistingSystemManaged<EditorToolUISystem>();
                if (m_EditorToolUISystem == null) return;
                var tools = m_EditorToolUISystem.tools;
                if (tools == null) return;
                if (tools.Any(t => t != null && t.id == MapBuilderEditorToolIds.ToolId)) return;
                if (m_Tool == null) m_Tool = new MapBuilderEditorTool(World);
                m_EditorToolUISystem.tools = tools.Concat(new IEditorTool[] { m_Tool }).ToArray();
                if (!m_LoggedOk)
                {
                    ImportLog.Info($"Editor tab '{MapBuilderEditorToolIds.ToolId}' registered ({tools.Length + 1} editor tools).");
                    m_LoggedOk = true;
                }
            }
            catch (Exception e)
            {
                if (!m_LoggedFail)
                {
                    ImportLog.Error("Could not register the editor tab; use Options > CS2 Map Builder instead", e);
                    m_LoggedFail = true;
                }
            }
        }
    }
}
