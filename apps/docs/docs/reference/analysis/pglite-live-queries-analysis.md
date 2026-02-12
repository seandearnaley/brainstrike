---
title: "PGlite Live Queries Analysis"
sidebar_position: 9
---

# PGlite Live Queries Analysis

This analysis summarizes behavior and tradeoffs observed when using live-query patterns against local PGlite-backed state.

## Key Findings

- Live updates improve UI freshness for queue and vector status surfaces.
- Unbounded subscriptions can create avoidable render churn.
- Query fanout and polling cadence must be constrained in renderer-heavy workflows.

## Risk Areas

- High-frequency updates on large collections increase CPU usage.
- Multiple listeners attached to overlapping query scopes can duplicate work.
- Missing teardown paths can leak subscriptions during route transitions.

## Recommended Controls

- Scope subscriptions to only currently visible views.
- Debounce or batch update notifications where feasible.
- Ensure explicit teardown on unmount and workflow completion.
- Prefer derived selectors over broad whole-table subscriptions.

## Implementation Guidance

- Keep live-query usage close to view boundaries.
- Use thin adapters to separate query transport from UI state updates.
- Validate behavior under long-running queue backfill and rapid navigation.
