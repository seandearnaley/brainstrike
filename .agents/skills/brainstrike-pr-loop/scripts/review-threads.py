#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from typing import Any


QUERY = """
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:10) {
            nodes {
              body
              path
              outdated
              originalLine
            }
          }
        }
      }
    }
  }
}
"""


def main() -> int:
    if len(sys.argv) != 4:
        print(
            f"usage: {sys.argv[0]} <owner> <repo> <pr-number>",
            file=sys.stderr,
        )
        return 1

    owner, repo, pr_number = sys.argv[1], sys.argv[2], sys.argv[3]
    result = subprocess.run(
        [
            "gh",
            "api",
            "graphql",
            "-f",
            f"query={QUERY}",
            "-F",
            f"owner={owner}",
            "-F",
            f"repo={repo}",
            "-F",
            f"number={pr_number}",
        ],
        capture_output=True,
        check=True,
        text=True,
    )
    payload: dict[str, Any] = json.loads(result.stdout)
    nodes = (
        payload.get("data", {})
        .get("repository", {})
        .get("pullRequest", {})
        .get("reviewThreads", {})
        .get("nodes", [])
    )

    unresolved = [node for node in nodes if not node.get("isResolved", False)]
    print(f"unresolved_threads={len(unresolved)}")
    for index, thread in enumerate(unresolved, start=1):
        comments = thread.get("comments", {}).get("nodes", [])
        first = comments[0] if comments else {}
        body = " ".join(str(first.get("body", "")).split())
        if len(body) > 180:
            body = f"{body[:177]}..."
        path = first.get("path") or "<unknown>"
        line = first.get("originalLine")
        outdated = bool(first.get("outdated"))
        location = f"{path}:{line}" if line else path
        stale_flag = " outdated" if outdated else ""
        print(f"{index}. {thread.get('id')} {location}{stale_flag}")
        if body:
            print(f"   {body}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
