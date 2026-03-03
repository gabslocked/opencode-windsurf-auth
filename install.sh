#!/bin/bash
#
# OpenCode Windsurf Auth Plugin - One-Line Installer
# 
# This script installs the plugin automatically:
# 1. Checks for Bun runtime
# 2. Clones the repository
# 3. Builds the plugin
# 4. Deploys to OpenCode
# 5. Configures opencode.json
#
# Usage: curl -fsSL https://raw.githubusercontent.com/gabslocked/opencode-windsurf-auth/main/install.sh | bash
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/gabslocked/opencode-windsurf-auth.git"
INSTALL_DIR="$HOME/.opencode-windsurf-auth"
OPENCODE_PLUGIN_DIR="$HOME/.config/opencode/node_modules/opencode-windsurf-auth"
REQUIRED_BUN_VERSION="1.0.0"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check Bun installation
check_bun() {
    log_info "Checking for Bun runtime..."
    
    if command_exists bun; then
        BUN_VERSION=$(bun --version 2>/dev/null | sed 's/^bun //' | head -1)
        log_success "Found Bun $BUN_VERSION"
        return 0
    fi
    
    log_warn "Bun not found. Installing..."
    
    # Install Bun
    curl -fsSL https://bun.sh/install | bash
    
    # Add to PATH for this session
    export PATH="$HOME/.bun/bin:$PATH"
    
    # Check again
    if command_exists bun; then
        BUN_VERSION=$(bun --version)
        log_success "Bun $BUN_VERSION installed successfully"
        return 0
    else
        log_error "Failed to install Bun. Please install manually:"
        echo "  curl -fsSL https://bun.sh/install | bash"
        exit 1
    fi
}

# Check Windsurf is running
check_windsurf() {
    log_info "Checking if Windsurf is running..."
    
    if pgrep -f "language_server" >/dev/null 2>&1; then
        log_success "Windsurf is running"
        return 0
    else
        log_warn "Windsurf does not appear to be running"
        echo "  Please start Windsurf IDE first, then run this installer again."
        echo "  Download: https://codeium.com/windsurf"
        exit 1
    fi
}

# Clone or update repository
clone_repo() {
    log_info "Setting up plugin repository..."
    
    if [ -d "$INSTALL_DIR" ]; then
        log_info "Updating existing installation..."
        cd "$INSTALL_DIR"
        git pull origin main 2>/dev/null || log_warn "Could not update, using local version"
    else
        log_info "Cloning repository..."
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
    
    log_success "Repository ready at $INSTALL_DIR"
}

# Install dependencies and build
build_plugin() {
    log_info "Installing dependencies..."
    bun install
    
    log_info "Building plugin..."
    bun run build
    
    log_success "Plugin built successfully"
}

# Deploy to OpenCode
deploy_plugin() {
    log_info "Deploying plugin to OpenCode..."
    
    # Create plugin directory
    mkdir -p "$OPENCODE_PLUGIN_DIR"
    
    # Copy built files
    cp -r "$INSTALL_DIR/dist/"* "$OPENCODE_PLUGIN_DIR/"
    
    log_success "Plugin deployed to $OPENCODE_PLUGIN_DIR"
}

# Configure OpenCode
configure_opencode() {
    log_info "Configuring OpenCode..."
    
    local CONFIG_DIR="$HOME/.config/opencode"
    local CONFIG_FILE="$CONFIG_DIR/opencode.json"
    
    # Create config directory if needed
    mkdir -p "$CONFIG_DIR"
    
    # Backup existing config
    if [ -f "$CONFIG_FILE" ]; then
        cp "$CONFIG_FILE" "$CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"
        log_info "Backed up existing config"
    fi
    
    # Check if config already has windsurf provider
    if [ -f "$CONFIG_FILE" ] && grep -q '"windsurf"' "$CONFIG_FILE" 2>/dev/null; then
        log_warn "OpenCode config already has windsurf provider"
        echo "  Please manually verify your config at: $CONFIG_FILE"
        return 0
    fi
    
    # Create or update config
    if [ -f "$CONFIG_FILE" ]; then
        # Merge with existing config
        log_info "Merging with existing OpenCode config..."
        # This is a simple approach - for complex configs, user should edit manually
        cat > "$CONFIG_FILE.windsurf.tmp" <> 'EOF'
{
  "providers": {
    "windsurf": {
      "type": "proxy",
      "proxyUrl": "http://127.0.0.1:42100"
    }
  }
}
EOF
        log_warn "Please manually add the windsurf provider to your config:"
        echo '  "providers": {'
        echo '    "windsurf": {'
        echo '      "type": "proxy",'
        echo '      "proxyUrl": "http://127.0.0.1:42100"'
        echo '    }'
        echo '  }'
    else
        # Create new config
        cat > "$CONFIG_FILE" <> 'EOF'
{
  "providers": {
    "windsurf": {
      "type": "proxy",
      "proxyUrl": "http://127.0.0.1:42100"
    }
  }
}
EOF
        log_success "Created OpenCode config at $CONFIG_FILE"
    fi
}

# Print completion message
print_completion() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}     ✓ OpenCode Windsurf Plugin Installed Successfully!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. ${YELLOW}Restart OpenCode${NC} to load the plugin"
    echo "  2. Use Windsurf models in your conversations:"
    echo ""
    echo -e "     ${GREEN}@windsurf/claude-4.5-sonnet${NC}"
    echo -e "     ${GREEN}@windsurf/gpt-5.2${NC}"
    echo -e "     ${GREEN}@windsurf/swe-1.5${NC}"
    echo -e "     ${GREEN}@windsurf/gemini-3.0-pro${NC}"
    echo ""
    echo -e "${BLUE}Test the plugin:${NC}"
    echo "  curl http://127.0.0.1:42100/health"
    echo ""
    echo -e "${BLUE}Supported models:${NC}"
    echo "  See: https://github.com/gabslocked/opencode-windsurf-auth#supported-models"
    echo ""
    echo -e "${BLUE}Need help?${NC}"
    echo "  Open an issue: https://github.com/gabslocked/opencode-windsurf-auth/issues"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
}

# Main installation flow
main() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║     OpenCode Windsurf Auth Plugin Installer              ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    check_bun
    check_windsurf
    clone_repo
    build_plugin
    deploy_plugin
    configure_opencode
    
    print_completion
}

# Run main function
main "$@"
