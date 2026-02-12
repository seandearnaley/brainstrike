---
title: "File Explorer Settings"
sidebar_position: 8
---

# File Explorer Settings

This reference captures the effective configuration model for file explorer behavior.

## Scope

Settings govern:

- Tree expansion and collapse behavior
- Selection persistence
- Sorting and filtering defaults
- Visibility rules for hidden or ignored paths

## Persistence Expectations

File explorer settings should be treated as user-level persistent UI state.

- Persist settings in the same storage layer as other renderer preferences.
- Keep schema additions backward-compatible.
- Include new keys in factory-reset cleanup paths.

## Operational Rules

- Avoid implicit fallback behavior that hides configuration errors.
- Keep defaults explicit and deterministic.
- Document any new setting key where persistence contracts are defined.

## Validation Checklist

When adding or changing settings:

1. Add type-safe schema or interface updates.
2. Add migration handling for existing persisted values.
3. Add tests for defaulting, persistence, and reset behavior.
4. Verify desktop and web parity where relevant.
