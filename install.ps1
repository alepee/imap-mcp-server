# IMAP MCP Server Installer for Claude Desktop (Windows)
# This script clones, builds, and configures the IMAP MCP server

$ErrorActionPreference = "Stop"

Write-Host "🚀 IMAP MCP Server Installer for Claude Desktop" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan

# Default installation directory
$defaultInstallDir = "$env:USERPROFILE\.claude\mcp-servers\imap"
$installDir = if ($args.Count -gt 0) { $args[0] } else { $defaultInstallDir }

Write-Host "📁 Installing to: $installDir" -ForegroundColor Yellow

# Check if Node.js is installed
try {
    $nodeVersion = node -v
    if (-not $nodeVersion) {
        throw "Node.js not found"
    }
} catch {
    Write-Host "❌ Node.js is not installed. Please install Node.js 16 or higher." -ForegroundColor Red
    Write-Host "   Download from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check Node.js version
$versionNumber = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
if ($versionNumber -lt 16) {
    Write-Host "❌ Node.js version 16 or higher is required. Current version: $nodeVersion" -ForegroundColor Red
    exit 1
}

# Create installation directory
Write-Host "📂 Creating installation directory..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Clone or update the repository
Write-Host "📥 Cloning repository..." -ForegroundColor Green
if (Test-Path "$installDir\.git") {
    Write-Host "📝 Repository already exists, pulling latest changes..." -ForegroundColor Yellow
    Set-Location $installDir
    git pull
} else {
    git clone https://github.com/alepee/imap-mcp-server.git $installDir
    Set-Location $installDir
}

# Install dependencies
Write-Host "📦 Installing dependencies..." -ForegroundColor Green
npm install

# Build the project
Write-Host "🔨 Building project..." -ForegroundColor Green
npm run build

# Configure Claude Desktop
$configDir = "$env:APPDATA\Claude"
$configFile = "$configDir\claude_desktop_config.json"

# Create config directory if it doesn't exist
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

# Prepare the server configuration
$serverConfig = @{
    command = "node"
    args = @("$installDir\dist\index.js" -replace '\\', '/')
}

if (Test-Path $configFile) {
    Write-Host "📝 Updating Claude Desktop configuration..." -ForegroundColor Green
    
    # Backup existing config
    $backupFile = "$configFile.backup.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    Copy-Item $configFile $backupFile
    
    try {
        # Read existing config
        $config = Get-Content $configFile -Raw | ConvertFrom-Json
        
        # Ensure mcpServers property exists
        if (-not $config.PSObject.Properties['mcpServers']) {
            $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue @{} -Force
        }
        
        # Add or update IMAP server config
        $config.mcpServers | Add-Member -NotePropertyName 'imap' -NotePropertyValue $serverConfig -Force
        
        # Save updated config
        $config | ConvertTo-Json -Depth 10 | Set-Content $configFile
    } catch {
        Write-Host "⚠️  Failed to update config automatically. Please manually add the following to your $configFile`:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host '  "mcpServers": {' -ForegroundColor White
        Write-Host '    "imap": {' -ForegroundColor White
        Write-Host '      "command": "node",' -ForegroundColor White
        Write-Host "      `"args`": [`"$($installDir -replace '\\', '/')/dist/index.js`"]" -ForegroundColor White
        Write-Host '    }' -ForegroundColor White
        Write-Host '  }' -ForegroundColor White
    }
} else {
    Write-Host "📝 Creating Claude Desktop configuration..." -ForegroundColor Green
    $config = @{
        mcpServers = @{
            imap = $serverConfig
        }
    }
    $config | ConvertTo-Json -Depth 10 | Set-Content $configFile
}

Write-Host ""
Write-Host "✅ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next steps:" -ForegroundColor Cyan
Write-Host "1. Restart Claude Desktop" -ForegroundColor White
Write-Host "2. The IMAP MCP server tools will be available in Claude" -ForegroundColor White
Write-Host "3. Use 'imap_add_account' to add your first email account" -ForegroundColor White
Write-Host ""
Write-Host "📚 Available tools:" -ForegroundColor Cyan
Write-Host "   - imap_add_account     : Add a new IMAP account" -ForegroundColor White
Write-Host "   - imap_list_accounts   : List configured accounts" -ForegroundColor White
Write-Host "   - imap_connect         : Connect to an account" -ForegroundColor White
Write-Host "   - imap_list_folders    : List email folders" -ForegroundColor White
Write-Host "   - imap_search_emails   : Search for emails" -ForegroundColor White
Write-Host "   - imap_get_email       : Read email content" -ForegroundColor White
Write-Host "   - ... and more!" -ForegroundColor White
Write-Host ""
Write-Host "🔒 Security: Your credentials are encrypted and stored in:" -ForegroundColor Cyan
Write-Host "   $env:USERPROFILE\.imap-mcp\" -ForegroundColor White
Write-Host ""
Write-Host "📖 For more information, visit:" -ForegroundColor Cyan
Write-Host "   https://github.com/alepee/imap-mcp-server" -ForegroundColor White