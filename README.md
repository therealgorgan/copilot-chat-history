# Copilot Chat History (Fork w/Improvements)

> **This is a fork of the original [Copilot Chat History](https://github.com/Arbuzov/copilot-chat-history) extension with significant enhancements** including archive management, undo support, bulk operations, background scanning, distributed consensus (leader election), auto-archive/auto-purge, pagination, and much more.

A Visual Studio Code extension that helps you view and manage your GitHub Copilot chat history organized by workspace.

## 🚀 What's New in This Fork

This fork adds **10+ major features** beyond the original v1.1.0 base:

| Feature | This Fork | Original |
|---------|-----------|----------|
| **Archive Management** | ✅ Complete soft-delete and archive browsing | ❌ No |
| **Undo Support** | ✅ Instant undo for any delete operation | ❌ No |
| **Bulk Operations** | ✅ Multi-select export/delete with progress | ❌ No |
| **Background Scanning** | ✅ Continuous monitoring without UI blocking | ❌ No |
| **Leader Election** | ✅ Distributed consensus for multi-window safety | ❌ No |
| **Auto-Archive** | ✅ Automatic archiving based on session limits | ❌ No |
| **Auto-Purge** | ✅ Scheduled retention policy enforcement | ❌ No |
| **Pagination (Load More)** | ✅ Load conversations in batches for large workspaces | ❌ No |
| **Functional Refresh** | ✅ Actual data reload on refresh button | ⚠️ Basic only |
| **Cancellable Operations** | ✅ Cancel long-running operations | ❌ No |
| **Chat Rendering** | ✅ Enhanced with professional styling (v1.1.0) | ✅ Same v1.1.0 |
| **Workspace Organization** | ✅ Same excellent organization | ✅ Same |

### Recent Improvements (v1.6.0)
- ✅ **Functional Refresh Buttons** — Chat Sessions and Archive views now properly reload data from disk
- ✅ **Empty Workspace Auto-Removal** — Empty workspaces automatically removed from both views
- ✅ **Immediate Unarchive Visibility** — Restored sessions appear instantly in Chat Sessions
- ✅ **Better Button Labels** — Delete (Archive) button clearly indicates move to archive
- ✅ **Fixed Archive Bugs** — Fixed duplicate listings, incorrect counts, and UI refresh issues

## 🎨 Enhanced Chat Display (v1.1.0)

The extension features a completely redesigned chat renderer that closely matches the official VS Code Copilot Chat interface:

### ✨ New Features
- **Authentic VS Code Styling**: CSS styles based on the official VS Code Copilot Chat repository
- **Professional Icons**: SVG icons for user and Copilot avatars instead of emoji
- **Advanced Markdown Support**: 
  - Four-backtick code blocks (like official Copilot)
  - Better formatting for lists, quotes, links, and tables
  - Proper syntax highlighting integration
- **Responsive Design**: Optimized for different screen sizes
- **Theme Integration**: Full VS Code theme support with proper color variables

### 🎯 Improved User Experience
- Native look and feel matching VS Code's design language
- Better typography and spacing
- Enhanced readability with proper contrast ratios
- Professional message layout with improved avatars

## Features

### 📊 Chat History Management
- 📁 **Workspace Organization**: Chat sessions grouped by workspace for easy navigation
- 🔍 **Search & Filter**: Quickly find specific chat sessions by title or content
- 🔗 **Quick Access**: Open workspaces directly from chat history with inline buttons
- 📝 **Smart Titles**: Automatically generates meaningful titles from chat content
- 🌲 **Tree View**: Clean, collapsible interface in the Activity Bar
- ⚡ **Fast Performance**: Efficient scanning and caching of chat data
- 📈 **Load More**: Pagination support to load conversations in batches, improving UI performance for workspaces with many sessions

### 🗑️ Archive & Deletion Management
- ♻️ **Soft-delete (Move to Archive)**: Deleted conversations are moved to an archive folder in the extension's global storage so they are not scanned by Copilot and do not affect history or performance. You can Undo deletes immediately after the operation.
- 🗄️ **Archive Browser**: A new Archive view lists archived conversations grouped by workspace; restore or permanently delete specific archived items.
- ↩️ **Undo deletions**: Immediately after delete operations the extension offers an **Undo** action to restore moved sessions back to their original location.
- 🔁 **Bulk Operations**: Multi-select export and delete with progress and ability to cancel via the notification.

### ⚙️ Advanced Features
- 🎯 **Background Scanning**: Continuously monitors workspace storage for new chat sessions in the background without blocking the UI
- 👑 **Leader Election**: Uses distributed consensus to ensure only one VS Code instance performs auto-archive/cleanup operations across multiple windows, preventing race conditions and duplicate work
- 🔄 **Auto-Archive**: Automatically archive or delete oldest conversations when a workspace exceeds the configured session limit
- ⏰ **Auto-Purge**: Scheduled purging of archived conversations based on retention policy
- ⚙️ **Configurable Settings**: Fine-tune leader election, background scanning intervals, and auto-maintenance policies
- 🔄 **Working Refresh Buttons**: Both Chat Sessions and Archive views have functional refresh buttons that reload data from disk

### Where archives are stored

Archived conversation files are placed in the extension's global storage under an `archive` directory (programmatically: `context.globalStorageUri/fsPath/archive`). On Windows this typically lives under `%APPDATA%\Code\User\globalStorage\<extension-id>\archive`. Inside the `archive` folder each workspace has its own subfolder (named using the workspace's folder name), which makes it easy to perform per-workspace archival operations. These files are kept out of workspace storage so Copilot does not load them into the history, improving performance when many sessions exist.

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Copilot Chat History (Fork)"
4. Click Install

### From GitHub Releases

1. Download the latest `.vsix` file from [Releases](https://github.com/therealgorgan/copilot-chat-history/releases)
2. Open VS Code
3. Go to Extensions (Ctrl+Shift+X)
4. Click the "..." menu and select "Install from VSIX..."
5. Select the downloaded file

## Usage

### Viewing Chat History

1. Look for the "Copilot Chat History" icon in the Activity Bar (left sidebar)
2. Click to open the panel
3. Browse your chat sessions organized by workspace
4. Expand/collapse workspaces as needed

### Search and Filter

- Click the search icon (🔍) in the panel header
- Enter keywords to filter chat sessions
- Use the clear filter button (🗑️) to reset

### Opening Workspaces

- Use the inline arrow buttons next to workspace names:
  - **→** Open workspace in current window
  - **↗** Open workspace in new window

### Refreshing

- Click the refresh button (🔄) to reload chat history from disk
- Automatically scans for new chat sessions

## How it Works

The extension scans your VS Code workspace storage for Copilot chat sessions:

- **Location**: `%APPDATA%\Code\User\workspaceStorage\[workspace-id]\chatSessions\`
- **Grouping**: Sessions are grouped by their associated workspace
- **Titles**: Uses custom titles or generates them from first message
- **Paths**: Resolves workspace paths from stored configuration

## Requirements

- Visual Studio Code 1.103.0 or higher
- GitHub Copilot extension (for generating chat sessions)

## Extension Settings

This extension contributes the following settings:

Currently, no additional settings are required. The extension works out of the box.

## Known Issues

- Workspace paths may not resolve correctly if projects have been moved
- Search is case-insensitive and searches in session titles only
- Large numbers of chat sessions may impact performance

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup

1. Clone this repository
2. Run `npm install` to install dependencies
3. Press `F5` to open a new Extension Development Host window
4. Test your changes

### Building and Packaging

```bash
# Development commands
npm run compile          # Compile TypeScript
npm run watch           # Watch for changes
npm run package         # Build for production

# Create installable package
npm run package:vsix     # Creates .vsix file for installation

# Publishing (requires tokens)
npm run publish:vsce     # Publish to VS Code Marketplace
npm run publish:ovsx     # Publish to Open VSX Registry
npm run publish:both     # Publish to both marketplaces
```

### Local Testing

1. Build VSIX package: `npm run package:vsix`
2. Install locally: `code --install-extension copilot-chat-history-1.0.3.vsix`
3. Reload VS Code and test functionality

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Changelog

### 1.0.0

- Initial release
- Workspace-based chat organization
- Search and filter functionality
- Inline workspace opening buttons
- Smart title generation

---

**Enjoy managing your Copilot chat history!** 🚀

## Support

If you encounter any issues or have feature requests, please file them in the [GitHub Issues](https://github.com/therealgorgan/copilot-chat-history/issues).
