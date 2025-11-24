#!/bin/bash

# scripts/local-ci.sh
# Wrapper around 'act' to run GitHub Actions locally with ease.

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to display usage
usage() {
    echo "Usage: $0 [options] [act arguments]"
    echo
    echo "Options:"
    echo "  -h, --help           Show this help message"
    echo "  --list-json          List available workflows and jobs in JSON format"
    echo "  --check-prereqs      Check if prerequisites (act, docker) are met and exit"
    echo
    echo "Examples:"
    echo "  $0                   Run in interactive mode"
    echo "  $0 -j checks         Run the 'checks' job"
    echo "  $0 -l                List workflows (act default format)"
    echo "  $0 --list-json       List workflows in JSON"
    echo "  $0 --reuse           Reuse containers (faster subsequent runs)"
}

# Check prerequisites
check_prereqs() {
    local silent=$1
    local missing=0

    if ! command -v act &> /dev/null; then
        if [ "$silent" != "true" ]; then
            echo -e "${RED}Error: 'act' is not installed.${NC}"
            echo -e "Please install it to run local CI:"
            echo -e "  brew install act"
        fi
        missing=1
    fi

    if ! docker info &> /dev/null; then
        if [ "$silent" != "true" ]; then
            echo -e "${RED}Error: Docker is not running.${NC}"
            echo -e "Please start Docker Desktop or your Docker daemon."
        fi
        missing=1
    fi

    return $missing
}

# Parse custom arguments
LIST_JSON=false
CHECK_PREREQS=false
REUSE_CONTAINERS=false
PASSTHROUGH_ARGS=()

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            exit 0
            ;;
        --list-json)
            LIST_JSON=true
            shift
            ;;
        --check-prereqs)
            CHECK_PREREQS=true
            shift
            ;;
        --reuse)
            REUSE_CONTAINERS=true
            shift
            ;;
        *)
            PASSTHROUGH_ARGS+=("$1")
            shift
            ;;
    esac
done

# Handle --check-prereqs
if [ "$CHECK_PREREQS" = true ]; then
    if check_prereqs "true"; then
        echo "Prerequisites met."
        exit 0
    else
        echo "Prerequisites missing."
        exit 1
    fi
fi

# Check prereqs normally
check_prereqs "false"

# Default options
ACT_OPTS=("--rm")
# Default to Medium image to avoid interactive prompt and permissions issues on Large image
ACT_OPTS+=("-P" "ubuntu-latest=catthehacker/ubuntu:act-latest")

# Boost container resources for local runs
# Note: User must ensure Docker Desktop has allocated sufficient resources (Settings -> Resources)
# Increase shm-size to prevent Electron/Chromium crashes in Docker (default is 64MB)
ACT_OPTS+=("--container-options" "--memory=32g --cpus=8 --shm-size=4g")

# Configure artifact server path to prevent upload failures
ACT_OPTS+=("--artifact-server-path" "/tmp/artifacts")

# Check for Apple Silicon and force linux/amd64 to avoid arm64 permission issues
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
    # Only add if not already specified by user
    if [[ ! " ${PASSTHROUGH_ARGS[*]} " =~ " --container-architecture " ]]; then
        echo -e "${YELLOW}Detected Apple Silicon. Forcing --container-architecture linux/amd64 for compatibility.${NC}"
        ACT_OPTS+=("--container-architecture" "linux/amd64")
    fi
fi

SECRETS_FILE=".secrets"

if [ "$REUSE_CONTAINERS" = true ]; then
    # Remove --rm if reusing, add -r
    ACT_OPTS=("-r")
    if [ "$LIST_JSON" = false ]; then
        echo -e "${GREEN}Container reuse enabled (experimental)${NC}"
    fi
fi

# Load secrets if available
if [ -f "$SECRETS_FILE" ]; then
    # Only print if not in JSON mode
    if [ "$LIST_JSON" = false ]; then
        echo -e "${GREEN}Loading secrets from $SECRETS_FILE${NC}"
    fi
    ACT_OPTS+=("--secret-file" "$SECRETS_FILE")
elif [ -f ".env" ]; then
    if [ "$LIST_JSON" = false ]; then
        echo -e "${YELLOW}No .secrets file found, trying .env...${NC}"
    fi
    ACT_OPTS+=("--secret-file" ".env")
else
    if [ "$LIST_JSON" = false ]; then
        echo -e "${YELLOW}Warning: No secrets file found (.secrets or .env).${NC}"
    fi
fi

# Handle --list-json
if [ "$LIST_JSON" = true ]; then
    # Capture act output. act -l outputs a table.
    # We need to parse it.
    # Format: Stage  Job ID  Job name  Workflow name  Workflow file  Events
    # We skip the first line (header).
    
    # Note: This is a simple parser and might be fragile if act changes output format.
    # It assumes standard act output.
    
    OUTPUT=$(act -l 2>/dev/null | tail -n +2)
    
    # Construct JSON manually or using jq if available, but let's try to be dependency-light.
    # We'll use python or node if available for reliable JSON creation, or simple string manipulation.
    # Since this is a JS monorepo, node is likely available.
    
    node -e "
        const fs = require('fs');
        const stdin = fs.readFileSync(0, 'utf-8');
        const lines = stdin.trim().split('\n');
        const jobs = lines.map(line => {
            const parts = line.trim().split(/\s{2,}/); // Split by 2 or more spaces
            if (parts.length < 5) return null;
            return {
                jobId: parts[1],
                jobName: parts[2],
                workflowName: parts[3],
                workflowFile: parts[4],
                events: parts[5]
            };
        }).filter(Boolean);
        console.log(JSON.stringify(jobs, null, 2));
    " <<< "$OUTPUT"
    
    exit 0
fi

# Helper to list workflows
list_workflows() {
    echo -e "${GREEN}Available Workflows:${NC}"
    act -l | awk 'NR>1 {print $1, $2, $3}' | column -t
}

# Interactive mode if no arguments provided
if [ ${#PASSTHROUGH_ARGS[@]} -eq 0 ]; then
    echo -e "${GREEN}Welcome to Brainstrike Local CI!${NC}"
    echo "-----------------------------------"
    
    PS3="Select an action: "
    options=("Run specific job" "List workflows" "Run all checks (Test workflow)" "Run Desktop E2E (Shard 2 - Fast)" "Quit")
    select opt in "${options[@]}"
    do
        case $opt in
            "Run specific job")
                echo -e "\nListing jobs..."
                act -l
                echo -e "\nEnter the Job ID to run (e.g., checks, e2e):"
                read -r job_id
                if [ -n "$job_id" ]; then
                    echo -e "${GREEN}Running job: $job_id${NC}"
                    act -j "$job_id" "${ACT_OPTS[@]}"
                else
                    echo -e "${RED}Invalid job ID.${NC}"
                fi
                break
                ;;
            "List workflows")
                list_workflows
                break
                ;;
            "Run all checks (Test workflow)")
                echo -e "${GREEN}Running all jobs in Test workflow...${NC}"
                act push -W .github/workflows/test.yml "${ACT_OPTS[@]}"
                break
                ;;
            "Run Desktop E2E (Shard 2 - Fast)")
                echo -e "${GREEN}Running Desktop E2E Shard 2...${NC}"
                act workflow_dispatch -W .github/workflows/local-desktop-e2e.yml --input shardIndex=2 --input shardTotal=2 "${ACT_OPTS[@]}"
                break
                ;;
            "Quit")
                exit 0
                ;;
            *) echo "Invalid option $REPLY";;
        esac
    done
else
    # Pass arguments directly to act
    echo -e "${GREEN}Running act with arguments: ${PASSTHROUGH_ARGS[*]}${NC}"
    act "${PASSTHROUGH_ARGS[@]}" "${ACT_OPTS[@]}"
fi

