# -*- coding: utf-8 -*-
"""打包 Windows 桌面版：编译启动器 + 拷贝应用 + 生成图标与说明。

产出目录结构与交付一致：
  乡野星图-桌面版/
    乡野星图.exe        启动器（file:// 模式，双击即开）
    打开.bat            推荐启动方式（本地服务模式，语音可用）
    serve.ps1           本地静态服务（仅监听 127.0.0.1）
    使用说明.txt
    App/                应用本体（可直接拷到任何静态服务器发布）
"""
import os, shutil, subprocess, sys

# 路径相对脚本自身推导（本脚本位于 <项目根>/源码/scripts/），搬动目录后无需改代码
SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
APP = os.path.join(ROOT, "源码", "app")
OUT = os.path.join(ROOT, "交付", "乡野星图-桌面版")
CSC = r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
CS = os.path.join(SCRIPTS, "Launcher.cs")

if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)

# 应用文件
shutil.copytree(APP, os.path.join(OUT, "App"))

# 启动脚本（本地服务模式 + 兜底）
shutil.copy2(os.path.join(SCRIPTS, "serve.ps1"), os.path.join(OUT, "serve.ps1"))
shutil.copy2(os.path.join(SCRIPTS, "launcher.bat"), os.path.join(OUT, "打开.bat"))
shutil.copy2(os.path.join(SCRIPTS, "使用说明.txt"), os.path.join(OUT, "使用说明.txt"))

# 图标（没有 Pillow 时跳过，不影响可执行文件）
ico = os.path.join(OUT, "_tmp.ico")
icon_arg = []
try:
    from PIL import Image
    Image.open(os.path.join(APP, "assets", "icon-512.png")).save(
        ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    icon_arg = ["/win32icon:" + ico]
except Exception as e:
    print("跳过图标（未安装 Pillow）:", e)

exe = os.path.join(OUT, "乡野星图.exe")
cmd = [CSC, "/nologo", "/target:winexe", "/optimize+",
       "/out:" + exe] + icon_arg + [
       "/reference:System.dll",
       "/reference:System.Windows.Forms.dll",
       CS]
r = subprocess.run(cmd, capture_output=True)
out = (r.stdout or b"") + (r.stderr or b"")
try:
    print(out.decode("gbk", errors="replace"))
except Exception:
    print(out.decode("utf-8", errors="replace"))
if r.returncode != 0:
    print("编译失败", r.returncode)
    sys.exit(1)

if os.path.exists(ico):
    os.remove(ico)

print("打包完成:", OUT)
for n in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, n)
    print("  ", n, "(dir)" if os.path.isdir(p) else str(round(os.path.getsize(p) / 1024, 1)) + "KB")
