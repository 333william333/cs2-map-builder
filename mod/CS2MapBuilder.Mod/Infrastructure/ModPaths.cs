using System;
using System.IO;

namespace CS2MapBuilder.Infrastructure
{
    /// <summary>
    /// File locations. Packages: %LocalLow%\Colossal Order\Cities Skylines II\ModsData\CS2MapBuilder\packages\&lt;name&gt;\.
    /// </summary>
    public static class ModPaths
    {
        public const string ModId = "CS2MapBuilder";

        private static string s_UserData;

        /// <summary>Game user-data root via Colossal.PSI.Environment.EnvPath.kUserDataPath, else the known LocalLow path.</summary>
        public static string UserData
        {
            get
            {
                if (s_UserData != null) return s_UserData;
                string root = null;
                try { root = Colossal.PSI.Environment.EnvPath.kUserDataPath; } catch (Exception) { }
                if (string.IsNullOrEmpty(root))
                    root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        "AppData", "LocalLow", "Colossal Order", "Cities Skylines II");
                s_UserData = root;
                return root;
            }
        }

        public static string ModsData => Path.Combine(UserData, "ModsData", ModId);
        public static string Packages => Path.Combine(ModsData, "packages");
        public static string ImportLogFile => Path.Combine(ModsData, "import.log");

        public static void EnsureDirectories()
        {
            try { Directory.CreateDirectory(Packages); } catch (Exception) { }
        }
    }
}
