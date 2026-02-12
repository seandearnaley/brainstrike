---
title: "Embedding Provider Architecture (2025-10-22)"
sidebar_position: 7
---

# Embedding Provider Architecture (Historical)

Date: October 22, 2025.

This archived research captured a provider architecture direction for supporting local and hosted embedding backends through a common resolution layer.

## Historical Decisions Documented

- Normalize provider identifiers into a stable provider-plus-model key format.
- Resolve provider capabilities before job execution to avoid runtime ambiguity.
- Keep embedding-set dimension metadata authoritative for validation and writes.

## Constraints Identified

- Local model execution must remain renderer-compatible.
- Hosted providers require clear key resolution and fail-fast error behavior.
- Queue payloads should stay compact and avoid large text transfer.

## What Aged Well

- Explicit provider resolution contracts
- Dimension-aware embedding set design
- Separation of queue orchestration from provider implementation details

## Notes

This page is retained for historical context; consult current Architecture and AI sections for active behavior.
