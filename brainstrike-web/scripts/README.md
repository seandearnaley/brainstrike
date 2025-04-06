# Scripts Directory

This directory contains utility scripts for the BrainStrike Web project.

## Token Debugging Script

The `debug-tokens.sh` script helps diagnose issues with GitHub tokens used in the release workflow.

### Usage

```bash
# Make sure the script is executable
chmod +x scripts/debug-tokens.sh

# Run the script
./scripts/debug-tokens.sh
```

### What It Does

The script checks:

1. If `GH_TOKEN` is properly set
2. If the token has the correct format
3. If the repository information is correctly configured
4. If semantic-release and its plugins are installed
5. If the workflow file is properly configured

### Fixing Token Issues

If you're having issues with the release workflow related to tokens:

1. Make sure you've added a `GH_TOKEN` secret to your GitHub repository
   - Go to Settings > Secrets and variables > Actions
   - Add a new repository secret named `GH_TOKEN`
   - Use a Personal Access Token with the `repo` scope

2. Verify the workflow file uses `GH_TOKEN` consistently
   - All references should be to `secrets.GH_TOKEN`, not `secrets.GITHUB_TOKEN`
   - Both checkout actions and environment variables should use `GH_TOKEN`

3. Check token permissions
   - For a Personal Access Token, make sure it has the `repo` scope
   - For GitHub Actions, make sure the workflow has the necessary permissions:
     ```yaml
     permissions:
       contents: write
       issues: write
       pull-requests: write
     ```

## Commit Message Testing Script

The `test-commit.sh` script helps validate commit messages against commitlint rules.

### Usage

```bash
# Test a commit message
./scripts/test-commit.sh "feat(ui): add new button component"
``` 