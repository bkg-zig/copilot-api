#!/bin/bash
# Script to configure voice provider for api.eysho.info
# This integrates voice API directly for all requests (agent-talk integration)

set -e

CONFIG_FILE="/srv/bkg/data/copilot-data/config.json"
SECRETS_DIR="/srv/bkg/secrets/ide"

echo "Setting up voice provider for api.eysho.info..."

# Create secrets directory if it doesn't exist
mkdir -p "$SECRETS_DIR"

# Backup existing config if it exists
if [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "${CONFIG_FILE}.backup"
    echo "Backup created at ${CONFIG_FILE}.backup"
fi

# Check if jq is available for JSON manipulation
if ! command -v jq &> /dev/null; then
    echo "jq not found, installing..."
    sudo apt-get update && sudo apt-get install -y jq
fi

# Add voice provider to config.json
if [ -f "$CONFIG_FILE" ]; then
    jq '.providers.voice = {
        "type": "openai-compatible",
        "baseUrl": "https://api.eysho.info/voice",
        "pricingCurrency": "USD"
    }' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    echo "Voice provider added to $CONFIG_FILE"
fi

echo "Voice provider configuration completed!"
echo ""
echo "Next steps:"
echo "1. Add API key for voice provider in $CONFIG_FILE"
echo "   Edit the voice provider section and add: \"apiKey\": \"YOUR_KEY\""
echo "2. Restart copilot-api service"
echo "3. Voice API (api.eysho.info) will now be used for all requests"