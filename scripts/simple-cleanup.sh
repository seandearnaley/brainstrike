#!/bin/bash

# Simple GitHub Artifacts Cleanup Script
REPO="seandearnaley/brainstrike"

echo "=== GitHub Artifacts Cleanup for $REPO ==="
echo

# Get summary
echo "📊 Getting artifacts summary..."
gh api "repos/$REPO/actions/artifacts" > artifacts.json

total_count=$(cat artifacts.json | jq -r '.total_count')
total_size=$(cat artifacts.json | jq -r '[.artifacts[].size_in_bytes] | add')

echo "Total artifacts: $total_count"
echo "Total size: $total_size bytes ($(echo "scale=2; $total_size/1024/1024" | bc -l) MB)"
echo

# Function to delete all artifacts
if [ "$1" = "delete-all" ]; then
    echo "⚠️  WARNING: This will delete ALL $total_count artifacts!"
    echo "This will free up $(echo "scale=2; $total_size/1024/1024" | bc -l) MB of space."
    read -p "Are you sure? Type 'yes' to confirm: " confirmation
    
    if [ "$confirmation" = "yes" ]; then
        echo "🗑️  Deleting all artifacts..."
        
        # Get all artifact IDs
        cat artifacts.json | jq -r '.artifacts[].id' > artifact_ids.txt
        
        # Delete each artifact
        while read -r id; do
            echo "Deleting artifact ID: $id"
            gh api "repos/$REPO/actions/artifacts/$id" -X DELETE
            if [ $? -eq 0 ]; then
                echo "✅ Deleted artifact $id"
            else
                echo "❌ Failed to delete artifact $id"
            fi
        done < artifact_ids.txt
        
        echo "🎉 Cleanup complete!"
        rm -f artifact_ids.txt
    else
        echo "Cancelled."
    fi
elif [ "$1" = "delete-old" ]; then
    days=${2:-30}
    echo "🗑️  Deleting artifacts older than $days days..."
    
    # Calculate cutoff date (30 days ago)
    if command -v gdate >/dev/null 2>&1; then
        # macOS with GNU coreutils
        cutoff_date=$(gdate -d "$days days ago" -u +"%Y-%m-%dT%H:%M:%SZ")
    else
        # Try BSD date (macOS default)
        cutoff_date=$(date -u -v-${days}d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    fi
    
    echo "Cutoff date: $cutoff_date"
    
    # Get old artifact IDs
    cat artifacts.json | jq -r --arg cutoff "$cutoff_date" '.artifacts[] | select(.created_at < $cutoff) | .id' > old_artifact_ids.txt
    
    old_count=$(wc -l < old_artifact_ids.txt | tr -d ' ')
    
    if [ "$old_count" -eq 0 ]; then
        echo "No artifacts older than $days days found."
    else
        echo "Found $old_count artifacts older than $days days."
        read -p "Delete these old artifacts? (y/N): " -n 1 -r
        echo
        
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            while read -r id; do
                echo "Deleting old artifact ID: $id"
                gh api "repos/$REPO/actions/artifacts/$id" -X DELETE
                if [ $? -eq 0 ]; then
                    echo "✅ Deleted old artifact $id"
                else
                    echo "❌ Failed to delete old artifact $id"
                fi
            done < old_artifact_ids.txt
            echo "🎉 Old artifacts cleanup complete!"
        else
            echo "Cancelled."
        fi
    fi
    
    rm -f old_artifact_ids.txt
else
    echo "Usage: $0 [delete-all|delete-old [days]]"
    echo "  delete-all  - Delete all artifacts (with confirmation)"
    echo "  delete-old  - Delete artifacts older than N days (default: 30)"
    echo
    echo "Current status: $total_count artifacts using $(echo "scale=2; $total_size/1024/1024" | bc -l) MB"
fi

# Cleanup temp file
rm -f artifacts.json 