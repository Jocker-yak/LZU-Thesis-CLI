这里是本次任务早期边探索边写的脚本，功能已经全部并入 lzu_fulltext/，仅作历史参考：

  harvest.py       最早的抓取脚本（--fid+--cookie 或伪造 --path 令牌）
  lzu_harvest.py   门户检索 + 令牌抽取 + fid 反查
  fetch_pages.py   实际用来下载本次论文 84 页并合成 PDF 的脚本

现在请用上层目录里的统一工具：

  python fulltext.py probe
  python fulltext.py grab --keyword 侯扶江 --find-fid <fid>
  python fulltext.py fetch --token <令牌> --out out

命令说明见 lzu_fulltext/README.md
