"""A live reader that holds a lock generation open, as an antivirus scan does.

Prints the file's bytes, waits for one stdin line, then reads and prints them
again through the same handle. On Windows, Python's open() withholds
FILE_SHARE_DELETE, so nothing can rename over or delete the file while it is
held; POSIX has no share modes.
"""

import sys


def main():
    with open(sys.argv[1], "rb") as held:
        print(held.read().decode("utf-8"), flush=True)
        sys.stdin.readline()
        held.seek(0)
        print(held.read().decode("utf-8"), flush=True)


main()
