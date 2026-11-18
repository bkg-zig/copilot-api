#!/usr/bin/env python3
"""
Script to add voice provider configuration to copilot-api config.json
For use with api.eysho.info for agent-talk integration
"""

import json
import os
import shutil
from pathlib import Path

CONFIG_PATH = "/srv/bkg/data/copilot-data/config.json"
SECRETS_DIR = "/srv/bkg/secrets/ide"

def update_config():
    """Update the copilot-api config.json with voice provider"""

    # Backup existing config
    if os.path.exists(CONFIG_PATH):
        backup_path = f"{CONFIG_PATH}.backup"
        shutil.copy2(CONFIG_PATH, backup_path)
        print(f"Backup created at {backup_path}")

    # Load existing config
    config = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'r') as f:
            config = json.load(f)

    # Ensure providers section exists
    if 'providers' not in config:
        config['providers'] = {}

    # Add voice provider configuration
    config['providers']['voice'] = {
        "type": "openai-compatible",
        "baseUrl": "https://api.eysho.info/voice",
        "pricingCurrency": "USD"
    }

    # Write updated config
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)

    print(f"Voice provider added to {CONFIG_PATH}")

    # Create secrets directory
    os.makedirs(SECRETS_DIR, exist_ok=True)
    print(f"Secrets directory ready: {SECRETS_DIR}")

    # Verify
    with open(CONFIG_PATH, 'r') as f:
        updated = json.load(f)

    print("\nUpdated providers:")
    print(json.dumps(updated.get('providers', {}), indent=2))

    return True

if __name__ == "__main__":
    try:
        update_config()
        print("\n✓ Configuration updated successfully!")
        print("\nNext steps:")
        print("1. Add API key for voice provider in the config")
        print("2. Restart copilot-api service")
        print("3. Voice API (api.eysho.info) will be used for all requests")
    except Exception as e:
        print(f"Error: {e}")
        exit(1)