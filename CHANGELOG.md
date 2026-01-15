# Changelog

All notable changes to the "copilot-chat-history" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-01-15

### 👑 Leader Election & Distributed Consensus

- **Leader Election** — implements distributed consensus mechanism to ensure only one VS Code instance performs auto-archive/cleanup operations across multiple windows.
- **Master Lock Management** — uses timeout-based locks with configurable TTL and heartbeat intervals to prevent race conditions.
- **Configurable Consensus** — new settings for `leaderCheckIntervalSeconds`, `lockTTLSeconds`, and `heartbeatIntervalSeconds` to tune the election algorithm.
- **Safety & Consistency** — prevents duplicate auto-archive work and maintains consistency across instances.

### 🔄 Background Scanning & Load More

- **Background Scanning** — continuously monitors workspace storage for new chat sessions without blocking UI.
- **Load More Conversations** — pagination support to load conversations in batches, improving performance for workspaces with many sessions.
- **Smart Pagination** — configurable batch size for fetching and displaying sessions incrementally.

### 🗄️ Archive Management Improvements

- **Archive Browser Enhancement** — improved UI and filtering for browsing archived sessions.
- **Per-Workspace Archive Folders** — archived items are organized by workspace for easier management and restoration.
- **Permanent Delete** — option to permanently delete archived conversations or entire workspace archives.

### ⚙️ Configuration & Settings

- New advanced settings for auto-archive, auto-purge, and leader election:
  - `copilotChatHistory.autoArchive.leaderElectionEnabled` — enable/disable leader election
  - `copilotChatHistory.autoArchive.lockTTLSeconds` — master lock timeout
  - `copilotChatHistory.autoArchive.heartbeatIntervalSeconds` — lock refresh frequency
  - `copilotChatHistory.autoArchive.leaderCheckIntervalSeconds` — election check frequency
  - `copilotChatHistory.autoPurge.checkIntervalHours` — purge job frequency
  - `copilotChatHistory.autoArchive.checkIntervalHours` — auto-archive job frequency

### 🎯 Performance & Reliability

- Improved background task scheduling to prevent UI blocking
- Better error handling for archive operations
- More informative progress notifications and success summaries
- Graceful fallback if leader election fails

## [1.3.0] - 2026-01-14

### 🗑️ Archive Management & Browser

- **Archive Browser** — new view to browse archived sessions grouped by workspace; restore or permanently delete items individually.
- **Empty Archive** — new command to permanently delete archived conversations with scope options (global or per-workspace), retention policy (delete older than N days), progress reporting, and cancellation support.

### ♻️ Soft-delete & Undo

- **Move to Archive** — delete operations now move session files to an **archive** in the extension's global storage instead of permanently removing them immediately. Archived files are not scanned by Copilot and won't show up in history.
- **Undo** — after deleting (single, selected, or workspace delete-all) the extension shows an **Undo** action to restore the moved sessions instantly.
- **Safety & Performance** — soft-delete helps quickly reclaim UI list performance while keeping an option to restore if deleted by mistake.

### ✨ Fork & Improvements

- **Renamed** extension display name to **Copilot Chat History (Fork w/Improvements)** to differentiate from upstream.
- **Cancellation** support for exports and deletes: users can cancel long-running operations via the notification progress Cancel button.
- **Multi-select**: select multiple conversations (Ctrl/Cmd+click) and export or delete them in bulk from the view title or context menu.
- **Per-item Delete**: inline Delete action for each conversation node.
- **Workspace Delete All**: delete all conversations for a workspace with a single action (confirmation and progress provided).
- **Progress reporting**: more informative progress notifications and better success/error summaries.
- **Docs**: README and CHANGELOG updated to reflect fork changes.


## [1.1.0] - 2025-09-06

### ✨ Enhanced Chat Renderer

- **Authentic VS Code Styling**: Updated webview chat renderer with authentic CSS styles based on the official VS Code Copilot Chat repository
- **Professional Icons**: Replaced emoji avatars with professional SVG icons matching VS Code's design language
- **Improved Message Layout**: Restructured message layout to match official VS Code chat interface
- **Better Typography**: Enhanced font rendering and sizing for improved readability
- **Advanced Markdown Support**: 
  - Support for four-backtick code blocks (like official Copilot)
  - Improved inline code formatting
  - Better list and quote handling
  - Link detection and formatting
  - Proper table rendering
- **Responsive Design**: Added mobile-friendly responsive breakpoints
- **Theme Integration**: Full integration with VS Code color themes

### 🎨 Visual Improvements

- **Native Look & Feel**: Chat display now closely matches the official VS Code Copilot Chat interface
- **Proper Spacing**: Adjusted margins, padding, and line heights to match VS Code standards
- **Color Consistency**: All colors now use VS Code's CSS variables for perfect theme integration
- **Avatar Redesign**: Professional user and Copilot icons instead of emoji
- **Message Bubbles**: Cleaner message container styling with proper borders and backgrounds

### 🐛 Bug Fixes

- Fixed markdown formatting edge cases
- Improved code block language detection
- Better handling of special characters in content
- Fixed responsive design issues on smaller screens

## [1.0.1] - 2025-09-06

### Fixed
- Updated Node.js version requirement to 20.x for compatibility with latest vsce and dependencies
- Fixed CI/CD pipeline to use @vscode/vsce instead of deprecated vsce package
- Updated GitHub Actions to use modern actions (softprops/action-gh-release@v1)

## [1.0.0] - 2025-09-06 Log

All notable changes to the "Copilot Chat History" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-09-06

### Added
- Initial release of Copilot Chat History extension
- Workspace-based organization of Copilot chat sessions
- Tree view in Activity Bar for easy navigation
- Search and filter functionality for chat sessions
- Inline buttons for opening workspaces (current/new window)
- Smart title generation from chat content
- Automatic workspace path resolution
- Support for collapsed/expanded workspace groups
- Refresh functionality to reload chat data

### Features
- **Chat Organization**: Groups chat sessions by workspace for better organization
- **Search**: Filter chat sessions by title with case-insensitive search
- **Workspace Navigation**: Direct workspace opening from chat history
- **Smart Titles**: Automatically generates meaningful titles from first message if no custom title exists
- **Performance**: Efficient scanning of VS Code workspace storage
- **User Experience**: Clean, intuitive tree interface

### Technical Details
- Compatible with VS Code 1.103.0+
- TypeScript implementation with full type safety
- Efficient file system scanning and caching
- URI path resolution for cross-platform compatibility
- Error handling for missing or moved workspaces

## [Unreleased]

### Planned Features
- Export chat history to various formats
- Advanced search with content filtering
- Chat session tagging and categories
- Statistics and insights
- Backup and restore functionality