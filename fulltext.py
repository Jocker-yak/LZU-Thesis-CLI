# -*- coding: utf-8 -*-
"""便捷入口： python fulltext.py <命令> ...  等价于  python -m lzu_fulltext <命令> ...

    python fulltext.py probe
    python fulltext.py grab --keyword 侯扶江 --find-fid 5cff3489f0c23900f886634fffe22fff
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lzu_fulltext.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
