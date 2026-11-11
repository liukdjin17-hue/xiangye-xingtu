using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace XiangYeXingTu
{
    static class Program
    {
        // 日志写在 exe 同目录，避免把开发机绝对路径带到别人的电脑上
        static string logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "xyxt-launch.log");

        static void Log(string msg)
        {
            try
            {
                File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\r\n", Encoding.UTF8);
            }
            catch { }
        }

        [STAThread]
        static void Main(string[] args)
        {
            try { File.Delete(logPath); } catch { }
            Log("start args=" + (args == null ? "null" : string.Join(" ", args)));

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string page = Path.Combine(Path.Combine(baseDir, "App"), "index.html");
            Log("baseDir=" + baseDir);
            Log("page exists=" + File.Exists(page) + " " + page);

            if (!File.Exists(page))
            {
                MessageBox.Show(
                    "没找到 App\\index.html。\n\n请把整个“乡野星图-桌面版”文件夹拷到电脑上，不要只拷贝这个 exe。",
                    "乡野星图", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string url = new Uri(page).AbsoluteUri;
            Log("url=" + url);

            string profile = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "XiangYeXingTu");
            Log("profile=" + profile);

            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            string browser = null;
            foreach (string c in candidates)
            {
                bool ok = false;
                try { ok = File.Exists(c); } catch (Exception ex) { Log("check fail " + c + " " + ex.Message); }
                Log("candidate " + ok + " " + c);
                if (ok && browser == null) browser = c;
            }

            Log("browser=" + (browser == null ? "NULL" : browser));

            try
            {
                if (browser == null)
                {
                    Log("fallback default browser");
                    Process.Start(page);
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = browser;
                // 参数不用引号：URL 已做百分号编码、profile 路径无空格；
                // 带引号时部分版本的 Edge 会忽略 --app，退化成普通标签页。
                psi.Arguments =
                    "--app=" + url + " " +
                    "--user-data-dir=" + profile + " " +
                    "--window-size=1180,860 " +
                    "--no-first-run --no-default-browser-check --disable-features=Translate " +
                    "--lang=zh-CN";
                psi.UseShellExecute = false;
                Log("run " + psi.FileName + " " + psi.Arguments);
                Process p = Process.Start(psi);
                Log("pid=" + (p == null ? 0 : p.Id));
            }
            catch (Exception ex)
            {
                Log("EXCEPTION " + ex.ToString());
                MessageBox.Show(
                    "启动失败：" + ex.Message + "\n\n可以直接用浏览器打开 App\\index.html。",
                    "乡野星图", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
