#!/bin/bash

# GitHub Artifacts Cleanup Script
# This script helps list and delete GitHub Actions artifacts

REPO="seandearnaley/brainstrike"

echo "=== GitHub Artifacts Cleanup for $REPO ==="
echo

# Function to list all artifacts
list_artifacts() {
    echo "📋 Listing all artifacts..."
    gh api "repos/$REPO/actions/artifacts" --jq '.artifacts[] | "ID: \(.id) | Name: \(.name) | Size: \(.size_in_bytes) bytes | Created: \(.created_at)"'
}

# Function to get total artifacts count and size
get_artifacts_summary() {
    echo "📊 Artifacts Summary:"
    local summary=$(gh api "repos/$REPO/actions/artifacts" --jq '{total_count: .total_count, artifacts: [.artifacts[] | {id: .id, name: .name, size: .size_in_bytes}]}')
    echo "$summary" | jq -r '"Total artifacts: \(.total_count)"'
    echo "$summary" | jq -r '"Total size: \([.artifacts[].size] | add) bytes"'
    echo
}

# Function to delete all artifacts
delete_all_artifacts() {
    echo "🗑️  Deleting all artifacts..."
    local artifact_ids=$(gh api "repos/$REPO/actions/artifacts" --jq '.artifacts[].id')
    
    if [ -z "$artifact_ids" ]; then
        echo "No artifacts found to delete."
        return
    fi
    
    echo "Found artifacts to delete:"
    for id in $artifact_ids; do
        echo "Deleting artifact ID: $id"
        gh api "repos/$REPO/actions/artifacts/$id" -X DELETE
        if [ $? -eq 0 ]; then
            echo "✅ Successfully deleted artifact $id"
        else
            echo "❌ Failed to delete artifact $id"
        fi
    done
}

# Function to delete artifacts older than N days
delete_old_artifacts() {
    local days=${1:-7}
    echo "🗑️  Deleting artifacts older than $days days..."
    
    local cutoff_date=$(date -d "$days days ago" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-${days}d +"%Y-%m-%dT%H:%M:%SZ")
    echo "Cutoff date: $cutoff_date"
    
    local old_artifacts=$(gh api "repos/$REPO/actions/artifacts" --jq --arg cutoff "$cutoff_date" '.artifacts[] | select(.created_at < $cutoff) | .id')
    
    if [ -z "$old_artifacts" ]; then
        echo "No old artifacts found to delete."
        return
    fi
    
    for id in $old_artifacts; do
        echo "Deleting old artifact ID: $id"
        gh api "repos/$REPO/actions/artifacts/$id" -X DELETE
        if [ $? -eq 0 ]; then
            echo "✅ Successfully deleted old artifact $id"
        else
            echo "❌ Failed to delete old artifact $id"
        fi
    done
}

# Main menu
case "${1:-list}" in
    "list")
        get_artifacts_summary
        list_artifacts
        ;;
    "delete-all")
        echo "⚠️  WARNING: This will delete ALL artifacts!"
        read -p "Are you sure? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            delete_all_artifacts
        else
            echo "Cancelled."
        fi
        ;;
    "delete-old")
        days=${2:-7}
        delete_old_artifacts $days
        ;;
    *)
        echo "Usage: $0 [list|delete-all|delete-old [days]]"
        echo "  list        - List all artifacts (default)"
        echo "  delete-all  - Delete all artifacts (with confirmation)"
        echo "  delete-old  - Delete artifacts older than N days (default: 7)"
        ;;
esac 