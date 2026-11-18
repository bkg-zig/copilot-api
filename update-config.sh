#!/bin/bash
# Direct script to update copilot-api config.json with voice provider
# Run with sudo for write access

CONFIG_FILE="/srv/bkg/data/copilot-data/config.json"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found at $CONFIG_FILE"
    exit 1
fi

# Check if voice provider already exists
if grep -q '"voice"' "$CONFIG_FILE"; then
    echo "Voice provider already exists in config"
else
    # Add voice provider using a temp file
    python3 << 'EOF'
import json

config_file = "/srv/bkg/data/copilot-data/config.json"

with open(config_file, 'r') as f:
    config = json.load(f)

# Add voice provider
config['providers'] = config.get('providers', {})
config['providers']['voice'] = {
    "type": "openai-compatible",
    "baseUrl": "https://api.eysho.info/voice",
    "pricingCurrency": "USD"
}

with open(config_file, 'w') as f:
    json.dump(config, f, indent=2)

print("Voice provider added successfully")
EOF
    echo "Voice provider added to $CONFIG_FILE"
fi

# Display the updated providers section
echo ""
echo "Updated providers:"
python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(json.dumps(c.get('providers', {}), indent=2))"