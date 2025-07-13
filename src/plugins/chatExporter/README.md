# Discord chat exporter plugin for Vencord

A Discord chat exporter plugin to export messages in multiple formats. All data is processed locally on your machine, ensuring privacy and security without external tools.

## Features

* Multiple export formats: Export chats as JSON, CSV, plain text, or HTML.
* Attachment support: Package attachments with HTML exports into a ZIP file.
* Flexible scope: Export single channels or entire servers.
* Advanced filtering:
    * Date range filtering with precise time selection.
    * User filtering to include or exclude specific users.
    * Message limit controls.
* Rich content support:
    * Preserves reactions, embeds, and replies.
    * Parses markdown correctly in HTML exports.
    * Supports custom emojis.
* Smart rate limiting: Handles Discord API rate limits with exponential backoff.
* Progress tracking: View real time export status.
* DM support: Export direct messages and group DMs.

## Usage

### Accessing the exporter

Right click on any channel, DM, or server and select "Export Chat..." from the context menu.

### Export options

#### Export scope
* Current channel: Export only the selected channel.
* Entire server: Export all text channels in a server. This is not available for DMs.

#### Filters
* Date range: Set specific start and end dates and times for your export.
* User filter: Include only specific users or exclude certain users from the export.
* Message limit: Set a maximum number of messages to export. A value of 0 means unlimited.

#### Export formats
1.  JSON: Complete structured data export with all metadata.
2.  CSV: Spreadsheet compatible format for data analysis.
3.  Plain Text: Simple, readable text format.
4.  HTML: Rich formatted export with styling and attachment support.

#### Additional options
* Include attachments: Downloads all attachments and packages them with HTML exports.
* Include reactions: Preserves reaction data.
* Include embeds: Preserves embed content.

## HTML export features

The HTML export provides a viewing experience similar to Discord's interface:
* Dark theme styling.
* Message formatting with markdown.
* Clickable attachments that support image and video previews.
* An image lightbox.
* Spoiler tags.
* Custom emoji support.
* Preservation of reply context.

## Technical details

### Rate limiting
The plugin uses intelligent rate limiting that includes:
* Exponential backoff with jitter.
* Automatic retries on rate limit errors.
* Status updates during rate limit waits.
* A maximum of 10 retry attempts.

### Performance
* Concurrent attachment downloads up to 10 simultaneously.
* Efficient message fetching with deduplication.
* Memory conscious processing for large exports.

### Security
* Authentication tokens are not exposed.
* All exports are processed locally.
* Attachments are downloaded directly from Discord's CDN.
* No data is sent to third party servers.

## Settings

Configure default values in Vencord Settings > Plugins > Chat Exporter:
* Default format: Set your preferred export format.
* Default message limit: Set a default message limit for exports.
* Include attachments by default: Toggle default attachment inclusion.

## Limitations

* Ephemeral messages which are only visible to you cannot be exported. They are not stored in Discord's message history.
* Large exports can be slow due to Discord's rate limits.
* Attachment downloads depend on your internet connection speed.
* Very large servers may require patience when loading member lists.
* Some bot messages or special message types may not export correctly.

## Troubleshooting

### "Loading members..." never completes
This can happen in very large servers. The member list will populate as Discord sends the data. You can proceed with the export even if the full list has not loaded.

### Rate limit errors
If you encounter rate limit errors, try the following:
1.  Reduce the message limit.
2.  Export smaller date ranges.
3.  Wait a few minutes before retrying.

### Missing attachments
Ensure you have a stable internet connection. Some attachments may fail to download if they were deleted from Discord's servers.

### Account disconnections
If your account disconnects during a large export:
1.  Stop the export immediately.
2.  Wait 5 to 10 minutes before trying again.
3.  Use smaller message limits or date ranges.
4.  Consider exporting channels individually instead of entire servers.

## File naming

Exported files are named using the pattern:
`discord-export-[channel-name]-[date].ext`

For ZIP exports with attachments:
`discord-export-[channel-name]-[date].zip`

## Privacy note

This plugin operates entirely within your Discord client. No data is sent to external servers. All processing happens locally on your machine, keeping your messages and attachments private.

## Important disclaimers

Exporting your own data does not violate Discord's Terms of Service. However, **large exports may trigger Discord's anti abuse systems** because of the high volume of API requests. This could result in:
* Temporary disconnection from voice channels.
* Temporary disconnection from Discord entirely.
* Account flagging for suspicious activity.

Large exports can also affect your system performance:
* **High memory usage**: Downloading attachments temporarily stores files in memory before writing them to the disk.
* **CPU usage**: Processing and formatting many messages is CPU intensive.
* **Disk space**: Exports with attachments require enough free disk space for the ZIP file.

**The developers of this plugin are not responsible for any action Discord takes as a result of its use.** Use this tool at your own risk. Consider exporting in smaller batches to avoid triggering rate limits or affecting system performance.
