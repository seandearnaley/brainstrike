"""A live reader that memory-maps a lock generation read-only.

Prints the mapped bytes, waits for one stdin line, then prints the same view's
bytes again. Windows opens the file with every share mode, as Defender and the
search indexer do; Python's own open() withholds FILE_SHARE_DELETE there, and
POSIX has no share modes.
"""

import mmap
import os
import sys


def open_shared(path):
    if os.name != "nt":
        return os.open(path, os.O_RDONLY)
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    generic_read = 0x80000000
    share_read_write_delete = 0x1 | 0x2 | 0x4
    open_existing = 3
    handle = kernel32.CreateFileW(
        path, generic_read, share_read_write_delete, None, open_existing, 0, None
    )
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    return msvcrt.open_osfhandle(handle, os.O_RDONLY)


def main():
    descriptor = open_shared(sys.argv[1])
    try:
        view = mmap.mmap(descriptor, 0, access=mmap.ACCESS_READ)
        try:
            print(view[:].decode("utf-8"), flush=True)
            sys.stdin.readline()
            print(view[:].decode("utf-8"), flush=True)
        finally:
            view.close()
    finally:
        os.close(descriptor)


main()
