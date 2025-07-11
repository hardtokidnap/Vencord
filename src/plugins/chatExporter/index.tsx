/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import {
    Button,
    Card,
    ChannelStore,
    Checkbox,
    Constants,
    Forms,
    GuildChannelStore,
    GuildMemberStore,
    GuildStore,
    Menu,
    React,
    RestAPI,
    Select,
    SelectedChannelStore,
    Text,
    TextInput,
    UserStore,
    useState
} from "@webpack/common";
import { Channel } from "discord-types/general";

// JSZip will be loaded dynamically
let JSZip: any;

const logger = new Logger("ChatExporter");

// User-facing messages
const Messages = {
    ATTACHMENT_WARNING: "⚠️ Large files or many attachments may take considerable time to download",
    ATTACHMENT_INFO: "📦 Attachments will be downloaded and packaged in a ZIP file with the HTML export",
    UNLIMITED_WARNING: "⚠️ Warning: Unlimited exports may take a long time and consume significant memory for large servers",
    RATE_LIMIT_ERROR: "⚠️ Rate limited by Discord API. Please wait a moment and try again with a smaller export.",
    RATE_LIMIT_RETRY: (seconds: number) => `Rate limited - waiting ${seconds}s before retry...`,
    FETCHING_MESSAGES: (count: number) => `Fetched ${count} messages from current channel...`,
    DOWNLOADING_ATTACHMENTS: (current: number, total: number, percent: number) =>
        `Downloading attachments: ${current}/${total} (${percent}%)`,
    USER_FILTER_DISABLED: "User filtering is currently disabled. All users will be included in the export.",
    ALL_CHANNELS_NOTICE: "All text channels in the server will be exported when \"Entire Server\" is selected."
};

// Define plugin settings
const settings = definePluginSettings({
    defaultFormat: {
        type: OptionType.SELECT,
        description: "Default export format",
        default: "json",
        options: [
            { label: "JSON", value: "json" },
            { label: "CSV", value: "csv" },
            { label: "Plain Text", value: "txt" },
            { label: "HTML", value: "html" }
        ]
    },
    defaultMessageLimit: {
        type: OptionType.NUMBER,
        description: "Default message limit for exports (0 = unlimited)",
        default: 1000,
        min: 0,
        max: 50000
    },
    includeAttachmentsByDefault: {
        type: OptionType.BOOLEAN,
        description: "Include attachments in exports by default",
        default: true
    }
});

// Load JSZip dynamically at runtime
async function loadJSZip() {
    if (!JSZip) {
        try {
            // Load JSZip from CDN
            const script = document.createElement("script");
            script.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
            document.head.appendChild(script);

            // Wait for script to load
            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = reject;
            });

            JSZip = (window as any).JSZip;
            if (!JSZip) {
                throw new Error("JSZip failed to load");
            }
        } catch (error) {
            logger.error("Failed to load JSZip:", error);
            throw new Error("JSZip library is required for attachment export");
        }
    }
    return JSZip;
}

interface ExportOptions {
    scope: "current-channel" | "entire-server";
    channelIds: string[];
    dateRange: {
        enabled: boolean;
        start: Date;
        end: Date;
    };
    userFilter: {
        enabled: boolean;
        userIds: string[];
        mode: "include" | "exclude";
    };
    messageLimit: number;
    includeAttachments: boolean;
    includeReactions: boolean;
    includeEmbeds: boolean;
    format: "json" | "csv" | "txt" | "html";
}

interface ExportedMessage {
    id: string;
    content: string;
    author: {
        id: string;
        username: string;
        discriminator: string;
        avatar: string;
        displayName?: string;
    };
    timestamp: string;
    edited_timestamp?: string;
    channel: {
        id: string;
        name: string;
        type: number;
    };
    attachments: Array<{
        id: string;
        filename: string;
        url: string;
        size: number;
        contentType?: string;
    }>;
    embeds: any[];
    reactions: Array<{
        emoji: string;
        count: number;
        users: string[];
    }>;
    mentions: Array<{
        id: string;
        username: string;
    }>;
    reply?: {
        messageId: string;
        authorId: string;
        content: string;
    };
}

interface ExportProgress {
    currentChannel: string;
    processedChannels: number;
    totalChannels: number;
    processedMessages: number;
    totalMessages: number;
    status: string;
}

function ExportModal({ modalProps, initialChannelId }: { modalProps: ModalProps; initialChannelId?: string; }) {
    const currentChannel = initialChannelId ? ChannelStore.getChannel(initialChannelId) :
        (SelectedChannelStore.getChannelId() ? ChannelStore.getChannel(SelectedChannelStore.getChannelId()) : null);
    const currentGuild = currentChannel?.guild_id ? GuildStore.getGuild(currentChannel.guild_id) : null;
    const isDM = currentChannel && (currentChannel.type === 1 || currentChannel.type === 3); // DM or Group DM

    // Get plugin settings - Access through settings.store
    const defaultFormat = settings.store.defaultFormat || "json";
    const defaultMessageLimit = settings.store.defaultMessageLimit || 1000;
    const includeAttachmentsByDefault = settings.store.includeAttachmentsByDefault ?? true;

    const [options, setOptions] = useState<ExportOptions>({
        scope: "current-channel",
        channelIds: initialChannelId ? [initialChannelId] : [],
        dateRange: {
            enabled: false,
            start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
            end: new Date()
        },
        userFilter: {
            enabled: false,
            userIds: [],
            mode: "include"
        },
        messageLimit: defaultMessageLimit,
        includeAttachments: includeAttachmentsByDefault,
        includeReactions: true,
        includeEmbeds: true,
        format: defaultFormat as "json" | "csv" | "txt" | "html"
    });

    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState<ExportProgress | null>(null);

    // Get available channels for export (only for guilds)
    const availableChannels = React.useMemo(() => {
        if (!currentGuild || isDM) return [];

        try {
            const channels = GuildChannelStore.getChannels(currentGuild.id);
            return Object.values(channels.SELECTABLE)
                .flat()
                .filter((channel: any) => channel.channel.type === 0) // Text channels only
                .map((channel: any) => ({
                    label: `#${channel.channel.name}`,
                    value: channel.channel.id
                }));
        } catch (error) {
            logger.error("Error getting available channels:", error);
            return [];
        }
    }, [currentGuild, isDM]);

    // Get guild members for user filtering (only for guilds)
    const guildMembers = React.useMemo(() => {
        if (!currentGuild || isDM) return [];

        try {
            const members = GuildMemberStore.getMembers(currentGuild.id);
            return members.map((member: any) => ({
                label: `${member.nick || member.user.username}#${member.user.discriminator}`,
                value: member.user.id
            }));
        } catch (error) {
            logger.error("Error getting guild members:", error);
            return [];
        }
    }, [currentGuild, isDM]);

    const updateOption = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
        setOptions(prev => ({ ...prev, [key]: value }));
    };

    const updateDateRange = (key: keyof ExportOptions["dateRange"], value: any) => {
        setOptions(prev => ({
            ...prev,
            dateRange: { ...prev.dateRange, [key]: value }
        }));
    };

    const updateUserFilter = (key: keyof ExportOptions["userFilter"], value: any) => {
        setOptions(prev => ({
            ...prev,
            userFilter: { ...prev.userFilter, [key]: value }
        }));
    };

    const startExport = async () => {
        setIsExporting(true);
        setProgress({
            currentChannel: "",
            processedChannels: 0,
            totalChannels: 0,
            processedMessages: 0,
            totalMessages: 0,
            status: "Initializing..."
        });

        try {
            await performExport(options, setProgress);
            setProgress({
                currentChannel: "",
                processedChannels: 0,
                totalChannels: 0,
                processedMessages: 0,
                totalMessages: 0,
                status: "Export completed successfully!"
            });
            // Keep the modal open briefly to show success, then close
            setTimeout(() => {
                modalProps.onClose();
            }, 2000);
        } catch (error) {
            logger.error("Export failed:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            setProgress({
                currentChannel: "",
                processedChannels: 0,
                totalChannels: 0,
                processedMessages: 0,
                totalMessages: 0,
                status: `Export failed: ${errorMessage}`
            });
        } finally {
            setIsExporting(false);
            // Clear progress after a delay if it shows an error
            if (progress?.status?.includes("failed")) {
                setTimeout(() => {
                    setProgress(null);
                }, 5000);
            }
        }
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold">Discord Chat Exporter</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>

            <ModalContent className="vc-chat-exporter-modal">
                {!isExporting ? (
                    <div className="vc-export-options">
                        {/* Export Scope */}
                        <Card className="vc-export-card">
                            <Forms.FormTitle>Export Scope</Forms.FormTitle>
                            {isDM ? (
                                <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                                    Exporting current {currentChannel?.type === 3 ? "group DM" : "DM"}: {currentChannel?.name || "Direct Message"}
                                </Text>
                            ) : (
                                <>
                                    <Select
                                        options={[
                                            { label: "Current Channel", value: "current-channel" },
                                            { label: "Entire Server", value: "entire-server" }
                                        ]}
                                        select={value => updateOption("scope", value)}
                                        isSelected={value => options.scope === value}
                                        serialize={String}
                                    />

                                    {options.scope === "entire-server" && (
                                        <div className="vc-channel-selector">
                                            <Forms.FormTitle>Select Channels (All will be exported)</Forms.FormTitle>
                                            <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                                                {Messages.ALL_CHANNELS_NOTICE}
                                            </Text>
                                        </div>
                                    )}
                                </>
                            )}
                        </Card>

                        {/* Date Range Filter */}
                        <Card className="vc-export-card">
                            <Checkbox
                                value={options.dateRange.enabled}
                                onChange={(event, checked) => updateDateRange("enabled", checked)}
                            >
                                <Forms.FormTitle>Date Range Filter</Forms.FormTitle>
                            </Checkbox>

                            {options.dateRange.enabled && (
                                <div className="vc-date-range">
                                    <div className="vc-date-input">
                                        <Forms.FormTitle>Start Date & Time</Forms.FormTitle>
                                        <TextInput
                                            type="datetime-local"
                                            value={(() => {
                                                // Format date for datetime-local input (local timezone)
                                                const year = options.dateRange.start.getFullYear();
                                                const month = String(options.dateRange.start.getMonth() + 1).padStart(2, "0");
                                                const day = String(options.dateRange.start.getDate()).padStart(2, "0");
                                                const hours = String(options.dateRange.start.getHours()).padStart(2, "0");
                                                const minutes = String(options.dateRange.start.getMinutes()).padStart(2, "0");
                                                return `${year}-${month}-${day}T${hours}:${minutes}`;
                                            })()}
                                            onChange={value => updateDateRange("start", new Date(value))}
                                        />
                                    </div>
                                    <div className="vc-date-input">
                                        <Forms.FormTitle>End Date & Time</Forms.FormTitle>
                                        <TextInput
                                            type="datetime-local"
                                            value={(() => {
                                                // Format date for datetime-local input (local timezone)
                                                const year = options.dateRange.end.getFullYear();
                                                const month = String(options.dateRange.end.getMonth() + 1).padStart(2, "0");
                                                const day = String(options.dateRange.end.getDate()).padStart(2, "0");
                                                const hours = String(options.dateRange.end.getHours()).padStart(2, "0");
                                                const minutes = String(options.dateRange.end.getMinutes()).padStart(2, "0");
                                                return `${year}-${month}-${day}T${hours}:${minutes}`;
                                            })()}
                                            onChange={value => updateDateRange("end", new Date(value))}
                                        />
                                    </div>
                                </div>
                            )}
                        </Card>

                        {/* User Filter */}
                        <Card className="vc-export-card">
                            <Checkbox
                                value={options.userFilter.enabled}
                                onChange={(event, checked) => updateUserFilter("enabled", checked)}
                            >
                                <Forms.FormTitle>User Filter</Forms.FormTitle>
                            </Checkbox>

                            {options.userFilter.enabled && (
                                <div className="vc-user-filter">
                                    <Select
                                        options={[
                                            { label: "Include Only", value: "include" },
                                            { label: "Exclude", value: "exclude" }
                                        ]}
                                        select={mode => updateUserFilter("mode", mode)}
                                        isSelected={mode => options.userFilter.mode === mode}
                                        serialize={String}
                                    />
                                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                                        {Messages.USER_FILTER_DISABLED}
                                    </Text>
                                </div>
                            )}
                        </Card>

                        {/* Export Options */}
                        <Card className="vc-export-card">
                            <Forms.FormTitle>Export Options</Forms.FormTitle>

                            <div className="vc-export-format">
                                <Forms.FormTitle>Format</Forms.FormTitle>
                                <Select
                                    options={[
                                        { label: "JSON", value: "json" },
                                        { label: "CSV", value: "csv" },
                                        { label: "Plain Text", value: "txt" },
                                        { label: "HTML", value: "html" }
                                    ]}
                                    select={format => updateOption("format", format)}
                                    isSelected={format => options.format === format}
                                    serialize={String}
                                />
                            </div>

                            <div className="vc-message-limit">
                                <Forms.FormTitle>Message Limit (0 = unlimited)</Forms.FormTitle>
                                <TextInput
                                    type="number"
                                    value={options.messageLimit.toString()}
                                    onChange={value => updateOption("messageLimit", parseInt(value) || 0)}
                                />
                                {options.messageLimit === 0 && (
                                    <Text variant="text-sm/normal" style={{ color: "var(--text-warning)", marginTop: "5px" }}>
                                        {Messages.UNLIMITED_WARNING}
                                    </Text>
                                )}
                            </div>

                            <div className="vc-include-options">
                                <Checkbox
                                    value={options.includeAttachments}
                                    onChange={(event, checked) => updateOption("includeAttachments", checked)}
                                >
                                    Include Attachments
                                </Checkbox>
                                {options.includeAttachments && options.format === "html" && (
                                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)", marginLeft: "20px", marginTop: "5px" }}>
                                        {Messages.ATTACHMENT_INFO}
                                    </Text>
                                )}
                                {options.includeAttachments && options.format === "html" && (
                                    <Text variant="text-sm/normal" style={{ color: "var(--text-warning)", marginLeft: "20px", marginTop: "5px" }}>
                                        {Messages.ATTACHMENT_WARNING}
                                    </Text>
                                )}
                                <Checkbox
                                    value={options.includeReactions}
                                    onChange={(event, checked) => updateOption("includeReactions", checked)}
                                >
                                    Include Reactions
                                </Checkbox>
                                <Checkbox
                                    value={options.includeEmbeds}
                                    onChange={(event, checked) => updateOption("includeEmbeds", checked)}
                                >
                                    Include Embeds
                                </Checkbox>
                            </div>
                        </Card>

                        {/* Export Summary */}
                        <Card className="vc-export-card" style={{ background: "var(--background-secondary-alt)" }}>
                            <Forms.FormTitle>Export Summary</Forms.FormTitle>
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                <Text variant="text-sm/normal">
                                    <strong>Scope:</strong> {options.scope === "current-channel" ?
                                        (currentChannel ? currentChannel.name : "Current Channel") :
                                        "Entire Server"}
                                </Text>
                                <Text variant="text-sm/normal">
                                    <strong>Format:</strong> {options.format.toUpperCase()}
                                </Text>
                                <Text variant="text-sm/normal">
                                    <strong>Message Limit:</strong> {options.messageLimit === 0 ? "Unlimited" : options.messageLimit}
                                </Text>
                                {options.dateRange.enabled && (
                                    <Text variant="text-sm/normal">
                                        <strong>Date Range:</strong> {options.dateRange.start.toLocaleDateString()} - {options.dateRange.end.toLocaleDateString()}
                                    </Text>
                                )}
                            </div>
                        </Card>
                    </div>
                ) : (
                    <div className="vc-export-progress">
                        <Text variant="heading-md/semibold">Exporting...</Text>
                        {progress && (
                            <>
                                <div className="vc-progress-info">
                                    <Text style={{ fontSize: "16px", fontWeight: 500 }}>{progress.status}</Text>
                                    {progress.currentChannel && (
                                        <Text>Current: {progress.currentChannel}</Text>
                                    )}
                                    <Text>Channels: {progress.processedChannels}/{progress.totalChannels}</Text>
                                    <Text>Messages: {progress.processedMessages.toLocaleString()}</Text>
                                    {progress.totalMessages > 0 && (
                                        <Text style={{ color: "var(--text-muted)" }}>
                                            Processing: {Math.round((progress.processedMessages / progress.totalMessages) * 100)}%
                                        </Text>
                                    )}
                                </div>
                                <div className="vc-progress-bar">
                                    <div
                                        className="vc-progress-fill"
                                        style={{
                                            width: `${(progress.processedChannels / Math.max(progress.totalChannels, 1)) * 100}%`
                                        }}
                                    />
                                </div>
                                {progress.status.includes("failed") && (
                                    <div style={{ marginTop: "10px", padding: "10px", background: "var(--background-danger)", borderRadius: "4px" }}>
                                        <Text style={{ color: "var(--text-danger)" }}>
                                            ❌ {progress.status}
                                        </Text>
                                    </div>
                                )}
                                {progress.status.includes("completed") && (
                                    <div style={{ marginTop: "10px", padding: "10px", background: "var(--background-positive)", borderRadius: "4px" }}>
                                        <Text style={{ color: "var(--text-positive)" }}>
                                            ✅ {progress.status}
                                        </Text>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}
            </ModalContent>

            <ModalFooter>
                <Button
                    color={Button.Colors.BRAND}
                    disabled={isExporting}
                    onClick={startExport}
                >
                    {isExporting ? "Exporting..." : "Start Export"}
                </Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    look={Button.Looks.LINK}
                    onClick={modalProps.onClose}
                    disabled={isExporting}
                >
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

async function performExport(options: ExportOptions, setProgress: (progress: ExportProgress) => void) {
    const startTime = Date.now();
    const channelsToExport = await getChannelsToExport(options);
    const allMessages: ExportedMessage[] = [];

    setProgress({
        currentChannel: "",
        processedChannels: 0,
        totalChannels: channelsToExport.length,
        processedMessages: 0,
        totalMessages: 0,
        status: "Starting export..."
    });

    for (let i = 0; i < channelsToExport.length; i++) {
        const channel = channelsToExport[i];

        // Get proper channel name for display
        let displayName = channel.name || "Unknown Channel";
        if (channel.type === 1) { // DM
            const recipientId = channel.recipients?.[0];
            if (recipientId) {
                try {
                    const recipient = UserStore.getUser(recipientId);
                    if (recipient) {
                        displayName = `DM with ${recipient.username}#${recipient.discriminator}`;
                    } else {
                        displayName = "Direct Message";
                    }
                } catch (error) {
                    displayName = "Direct Message";
                }
            } else {
                displayName = "Direct Message";
            }
        } else if (channel.type === 3) { // Group DM
            displayName = channel.name || "Group DM";
        } else {
            displayName = `#${channel.name || "Unknown Channel"}`;
        }

        setProgress({
            currentChannel: displayName,
            processedChannels: i,
            totalChannels: channelsToExport.length,
            processedMessages: allMessages.length,
            totalMessages: 0,
            status: `Fetching messages from ${displayName}...`
        });

        try {
            const messages = await fetchChannelMessages(channel.id, options, setProgress);
            allMessages.push(...messages);

            // Calculate estimated time remaining
            const elapsed = Date.now() - startTime;
            const avgTimePerChannel = elapsed / (i + 1);
            const remainingChannels = channelsToExport.length - (i + 1);
            const estimatedRemaining = Math.round((avgTimePerChannel * remainingChannels) / 1000);
            const etaStr = estimatedRemaining > 0 ? ` (ETA: ${estimatedRemaining}s)` : "";

            setProgress({
                currentChannel: displayName,
                processedChannels: i + 1,
                totalChannels: channelsToExport.length,
                processedMessages: allMessages.length,
                totalMessages: 0,
                status: `Completed ${displayName}${etaStr}`
            });
        } catch (error) {
            logger.error(`Failed to fetch messages from ${displayName}:`, error);
            // Continue with other channels
        }
    }

    setProgress({
        currentChannel: "",
        processedChannels: channelsToExport.length,
        totalChannels: channelsToExport.length,
        processedMessages: allMessages.length,
        totalMessages: 0,
        status: "Formatting export data..."
    });

    // Apply final message limit if needed
    let finalMessages = allMessages;
    if (options.messageLimit > 0 && allMessages.length > options.messageLimit) {
        finalMessages = allMessages.slice(0, options.messageLimit);
    }

    setProgress({
        currentChannel: "",
        processedChannels: channelsToExport.length,
        totalChannels: channelsToExport.length,
        processedMessages: finalMessages.length,
        totalMessages: 0,
        status: `Formatting ${finalMessages.length} messages for export...`
    });

    // Handle attachments if enabled and format is HTML
    if (options.includeAttachments && options.format === "html") {
        setProgress({
            currentChannel: "",
            processedChannels: channelsToExport.length,
            totalChannels: channelsToExport.length,
            processedMessages: finalMessages.length,
            totalMessages: 0,
            status: "Downloading attachments..."
        });

        await downloadWithAttachments(finalMessages, options, channelsToExport, setProgress);
    } else {
        const exportData = await formatExportData(finalMessages, options, channelsToExport);
        downloadExport(exportData, options.format, channelsToExport);
    }
}

async function getChannelsToExport(options: ExportOptions): Promise<Channel[]> {
    if (options.scope === "current-channel") {
        // Use the initial channel ID if provided, otherwise get current channel
        const channelId = options.channelIds.length > 0 ? options.channelIds[0] : SelectedChannelStore.getChannelId();
        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        if (channel) {
            // For DMs, we'll handle the name in the progress display since we can't modify the channel object
            return [channel];
        }
        return [];
    } else {
        // Export all text channels in the server (only for guilds)
        const channelId = options.channelIds.length > 0 ? options.channelIds[0] : SelectedChannelStore.getChannelId();
        const currentChannel = channelId ? ChannelStore.getChannel(channelId) : null;
        const currentGuild = currentChannel?.guild_id ? GuildStore.getGuild(currentChannel.guild_id) : null;

        if (!currentGuild) return [];

        try {
            const channels = GuildChannelStore.getChannels(currentGuild.id);
            return Object.values(channels.SELECTABLE)
                .flat()
                .filter((channel: any) => channel.channel.type === 0) // Text channels only
                .map((channel: any) => channel.channel);
        } catch (error) {
            logger.error("Error getting channels to export:", error);
            return [];
        }
    }
}

async function fetchChannelMessages(channelId: string, options: ExportOptions, setProgress: (progress: ExportProgress) => void): Promise<ExportedMessage[]> {
    const messages: ExportedMessage[] = [];
    const seenMessageIds = new Set<string>();
    let lastMessageId: string | undefined;
    let fetchedCount = 0;
    let retryCount = 0;
    const maxRetries = 5;
    const baseDelay = 500; // Start with 500ms base delay

    while (true) {
        try {
            const response = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query: {
                    limit: 50, // Reduced from 100 to be more conservative
                    ...(lastMessageId && { before: lastMessageId })
                }
            });

            const fetchedMessages = response.body || [];
            if (fetchedMessages.length === 0) break;

            for (const rawMessage of fetchedMessages) {
                try {
                    // Skip duplicate messages
                    if (seenMessageIds.has(rawMessage.id)) {
                        continue;
                    }
                    seenMessageIds.add(rawMessage.id);

                    const message = await processMessage(rawMessage, options);
                    if (message) {
                        // Apply date filter on the client side
                        const messageDate = new Date(message.timestamp);
                        const shouldInclude = !options.dateRange.enabled ||
                            (messageDate >= options.dateRange.start && messageDate <= options.dateRange.end);

                        if (shouldInclude) {
                            messages.push(message);
                            fetchedCount++;
                        }
                    }

                    if (options.messageLimit > 0 && messages.length >= options.messageLimit) {
                        return messages.slice(0, options.messageLimit);
                    }
                } catch (msgError) {
                    logger.error("Failed to process message:", msgError);
                    // Continue processing other messages
                }
            }

            lastMessageId = fetchedMessages[fetchedMessages.length - 1].id;

            setProgress({
                currentChannel: "",
                processedChannels: 0,
                totalChannels: 0,
                processedMessages: fetchedCount,
                totalMessages: 0,
                status: Messages.FETCHING_MESSAGES(fetchedCount)
            });

            // More conservative rate limiting with progressive delay
            const delay = baseDelay + (retryCount * 200);
            await new Promise(resolve => setTimeout(resolve, delay));
            retryCount = 0; // Reset retry count on successful request

        } catch (error) {
            logger.error("Failed to fetch messages:", error);

            // Check if it's a rate limit error
            if (error && typeof error === "object" && "status" in error && (error as any).status === 429) {
                retryCount++;
                if (retryCount > maxRetries) {
                    logger.error("Max retries exceeded for rate limiting");
                    setProgress({
                        currentChannel: "",
                        processedChannels: 0,
                        totalChannels: 0,
                        processedMessages: fetchedCount,
                        totalMessages: 0,
                        status: Messages.RATE_LIMIT_ERROR
                    });
                    break;
                }

                // Exponential backoff with jitter
                const waitTime = Math.min(1000 * Math.pow(2, retryCount) + Math.random() * 1000, 30000);
                logger.warn(`Rate limited, waiting ${Math.round(waitTime / 1000)}s before retry ${retryCount}/${maxRetries}`);

                setProgress({
                    currentChannel: "",
                    processedChannels: 0,
                    totalChannels: 0,
                    processedMessages: fetchedCount,
                    totalMessages: 0,
                    status: Messages.RATE_LIMIT_RETRY(Math.round(waitTime / 1000))
                });

                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            // For other errors, break the loop
            break;
        }
    }

    return messages;
}

async function processMessage(rawMessage: any, options: ExportOptions): Promise<ExportedMessage | null> {
    // User filter is currently disabled - include all messages

    const channel = ChannelStore.getChannel(rawMessage.channel_id);
    const { author } = rawMessage;

    // Get channel name, handling DMs specially
    let channelName = "Unknown Channel";
    if (channel) {
        if (channel.type === 1) { // DM
            // For DMs, get the other participant's name
            const recipientId = channel.recipients?.[0];
            if (recipientId) {
                try {
                    const recipient = UserStore.getUser(recipientId);
                    if (recipient) {
                        channelName = `DM with ${recipient.username}#${recipient.discriminator}`;
                    } else {
                        channelName = "Direct Message";
                    }
                } catch (error) {
                    channelName = "Direct Message";
                }
            } else {
                channelName = "Direct Message";
            }
        } else if (channel.type === 3) { // Group DM
            channelName = channel.name || "Group DM";
        } else {
            channelName = channel.name || "Unknown Channel";
        }
    }

    const message: ExportedMessage = {
        id: rawMessage.id,
        content: rawMessage.content || "",
        author: {
            id: author.id,
            username: author.username,
            discriminator: author.discriminator,
            avatar: author.avatar,
            displayName: author.global_name
        },
        timestamp: rawMessage.timestamp,
        edited_timestamp: rawMessage.edited_timestamp,
        channel: {
            id: channel?.id || rawMessage.channel_id,
            name: channelName,
            type: channel?.type || 0
        },
        attachments: [],
        embeds: [],
        reactions: [],
        mentions: []
    };

    // Process attachments
    if (options.includeAttachments && rawMessage.attachments) {
        message.attachments = rawMessage.attachments.map((att: any) => ({
            id: att.id,
            filename: att.filename,
            url: att.url,
            size: att.size,
            contentType: att.content_type
        }));
    }

    // Process embeds
    if (options.includeEmbeds && rawMessage.embeds) {
        message.embeds = rawMessage.embeds;
    }

    // Process reactions
    if (options.includeReactions && rawMessage.reactions) {
        message.reactions = rawMessage.reactions.map((reaction: any) => ({
            emoji: reaction.emoji.name || reaction.emoji.id,
            count: reaction.count,
            users: [] // User list not available in API response
        }));
    }

    // Process mentions
    if (rawMessage.mentions) {
        message.mentions = rawMessage.mentions.map((mention: any) => ({
            id: mention.id,
            username: mention.username
        }));
    }

    // Process reply
    if (rawMessage.referenced_message) {
        message.reply = {
            messageId: rawMessage.referenced_message.id,
            authorId: rawMessage.referenced_message.author.id,
            content: rawMessage.referenced_message.content
        };
    }

    return message;
}

async function formatExportData(messages: ExportedMessage[], options: ExportOptions, channels: Channel[]): Promise<string> {
    // Sort messages by timestamp consistently across all formats
    const sortedMessages = messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    switch (options.format) {
        case "json":
            return formatAsJSON(sortedMessages, options, channels);
        case "csv":
            return formatAsCSV(sortedMessages);
        case "txt":
            return formatAsText(sortedMessages);
        case "html":
            return formatAsHTML(sortedMessages, channels);
        default:
            return formatAsJSON(sortedMessages, options, channels);
    }
}

function formatAsJSON(messages: ExportedMessage[], options: ExportOptions, channels: Channel[]): string {
    const exportData = {
        metadata: {
            exportDate: new Date().toISOString(),
            exportOptions: options,
            channels: channels.map(c => ({ id: c.id, name: c.name, type: c.type })),
            messageCount: messages.length
        },
        messages: messages
    };

    return JSON.stringify(exportData, null, 2);
}

function formatAsCSV(messages: ExportedMessage[]): string {
    const headers = ["Timestamp", "Channel", "Author", "Content", "Attachments", "Reactions", "Reply To"];
    const rows = [headers.join(",")];

    for (const message of messages) {
        const content = message.content
            .replace(/\r?\n/g, " ") // Replace newlines with spaces
            .replace(/"/g, '""'); // Escape quotes

        const replyContent = message.reply?.content
            ?.replace(/\r?\n/g, " ")
            .replace(/"/g, '""') || "";

        const row = [
            `"${message.timestamp}"`,
            `"${message.channel.name}"`,
            `"${message.author.username}#${message.author.discriminator}"`,
            `"${content}"`,
            `"${message.attachments.map(a => a.filename).join(", ")}"`,
            `"${message.reactions.map(r => `${r.emoji}(${r.count})`).join(", ")}"`,
            `"${replyContent}"`
        ];
        rows.push(row.join(","));
    }

    return rows.join("\n");
}

function formatAsText(messages: ExportedMessage[]): string {
    const lines: string[] = [];
    let currentChannel = "";

    for (const message of messages) {
        if (message.channel.name !== currentChannel) {
            currentChannel = message.channel.name;
            // Don't add # for DMs
            const channelPrefix = message.channel.type === 1 || message.channel.type === 3 ? "" : "#";
            lines.push(`\n=== ${channelPrefix}${currentChannel} ===\n`);
        }

        const timestamp = new Date(message.timestamp).toLocaleString();
        const author = message.author.displayName || `${message.author.username}#${message.author.discriminator}`;

        lines.push(`[${timestamp}] ${author}: ${message.content || "[No content]"}`);

        if (message.attachments.length > 0) {
            lines.push(`  📎 Attachments: ${message.attachments.map(a => a.filename).join(", ")}`);
        }

        if (message.reactions.length > 0) {
            lines.push(`  🎭 Reactions: ${message.reactions.map(r => `${r.emoji}(${r.count})`).join(", ")}`);
        }

        if (message.reply) {
            lines.push(`  ↪️ Reply to: ${message.reply.content}`);
        }

        lines.push("");
    }

    return lines.join("\n");
}

function formatAsHTML(messages: ExportedMessage[], channels: Channel[]): string {
    // Helper function to parse custom emojis in content
    function parseContent(content: string): string {
        if (!content) return "<em>No content</em>";

        // Escape HTML
        let escaped = content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        // Convert custom emojis to images
        escaped = escaped.replace(/<:(\w+):(\d+)>/g, '<img class="emoji" src="https://cdn.discordapp.com/emojis/$2.png" alt=":$1:" title=":$1:">');
        escaped = escaped.replace(/<a:(\w+):(\d+)>/g, '<img class="emoji" src="https://cdn.discordapp.com/emojis/$2.gif" alt=":$1:" title=":$1:">');

        // Convert mentions to highlighted text
        escaped = escaped.replace(/<@!?(\d+)>/g, '<span class="mention">@User</span>');
        escaped = escaped.replace(/<@&(\d+)>/g, '<span class="mention">@Role</span>');
        escaped = escaped.replace(/<#(\d+)>/g, '<span class="mention">#channel</span>');

        // Convert line breaks
        escaped = escaped.replace(/\n/g, "<br>");

        return escaped;
    }

    let html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Discord Chat Export</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #36393f;
            color: #dcddde;
            margin: 0;
            padding: 20px;
            line-height: 1.5;
        }
        .header {
            background: #2f3136;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }
        .channel {
            background: #40444b;
            margin: 10px 0;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .message {
            margin: 10px 0;
            padding: 10px;
            border-left: 3px solid transparent;
            transition: all 0.2s ease;
            border-radius: 4px;
        }
        .message:hover {
            background: rgba(0,0,0,0.1);
            border-left-color: #7289da;
        }
        .message.has-attachment {
            border-left-color: #43b581;
        }
        .author {
            font-weight: bold;
            color: #7289da;
            margin-bottom: 4px;
        }
        .timestamp {
            color: #72767d;
            font-size: 0.8em;
            margin-left: 8px;
        }
        .content {
            margin: 5px 0;
            word-wrap: break-word;
        }
        .attachment {
            background: #2f3136;
            padding: 5px;
            margin: 5px 0;
            border-radius: 4px;
        }
        .emoji {
            width: 20px;
            height: 20px;
            vertical-align: text-bottom;
            margin: 0 2px;
        }
        .mention {
            background: rgba(114, 137, 218, 0.3);
            color: #7289da;
            padding: 0 2px;
            border-radius: 3px;
        }
        .reply {
            display: flex;
            align-items: center;
            margin-bottom: 4px;
            padding-left: 20px;
            position: relative;
            font-size: 0.875rem;
            color: #8e9297;
        }
        .reply::before {
            content: "";
            position: absolute;
            left: 0;
            top: 50%;
            width: 16px;
            height: 8px;
            border-left: 2px solid #4f545c;
            border-top: 2px solid #4f545c;
            border-top-left-radius: 6px;
        }
        .reaction {
            background: #2f3136;
            padding: 2px 6px;
            margin: 2px;
            border-radius: 12px;
            display: inline-block;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Discord Chat Export</h1>
        <p>Exported on: ${new Date().toLocaleString()}</p>
        <p>Channels: ${channels.map(c => {
        const prefix = c.type === 1 || c.type === 3 ? "" : "#";
        return `${prefix}${c.name}`;
    }).join(", ")}</p>
        <p>Messages: ${messages.length}</p>
    </div>
`;

    let currentChannel = "";
    for (const message of messages) {
        if (message.channel.name !== currentChannel) {
            if (currentChannel) html += "</div>";
            currentChannel = message.channel.name;
            // Don't add # for DMs
            const channelPrefix = message.channel.type === 1 || message.channel.type === 3 ? "" : "#";
            html += `<div class="channel"><h2>${channelPrefix}${currentChannel}</h2>`;
        }

        const timestamp = new Date(message.timestamp).toLocaleString();
        const author = message.author.displayName || `${message.author.username}#${message.author.discriminator}`;
        const hasAttachment = message.attachments.length > 0;
        const messageClass = hasAttachment ? "message has-attachment" : "message";

        html += `
<div class="${messageClass}">`;

        // Add reply context if present
        if (message.reply) {
            html += `
    <div class="reply">
        ↪️ Replying to: ${message.reply.content.substring(0, 100)}${message.reply.content.length > 100 ? "..." : ""}
    </div>`;
        }

        html += `
    <div class="author">${author} <span class="timestamp">${timestamp}</span></div>
    <div class="content">${parseContent(message.content)}</div>
`;

        if (message.attachments.length > 0) {
            html += "<div class=\"attachments\">";
            for (const att of message.attachments) {
                html += `<div class="attachment">📎 ${att.filename}</div>`;
            }
            html += "</div>";
        }

        if (message.reactions.length > 0) {
            html += "<div class=\"reactions\">";
            for (const reaction of message.reactions) {
                html += `<span class="reaction">${reaction.emoji} ${reaction.count}</span>`;
            }
            html += "</div>";
        }

        html += "</div>";
    }

    if (currentChannel) html += "</div>";
    html += "</body></html>";

    return html;
}

async function downloadWithAttachments(messages: ExportedMessage[], options: ExportOptions, channels: Channel[], setProgress: (progress: ExportProgress) => void) {
    try {
        const ZipLib = await loadJSZip();
        const zip = new ZipLib();

        // Collect all attachments and handle duplicates
        const attachments = messages.flatMap(msg => msg.attachments);
        const attachmentFolder = zip.folder("attachments");
        const filenameCount = new Map<string, number>();

        let downloadedCount = 0;
        const totalAttachments = attachments.length;

        // Helper function to download a single attachment
        async function downloadAttachment(attachment: any) {
            try {
                // Handle duplicate filenames
                let { filename } = attachment;
                const count = filenameCount.get(filename) || 0;
                if (count > 0) {
                    const ext = filename.split(".").pop();
                    const baseName = filename.substring(0, filename.lastIndexOf("."));
                    filename = `${baseName}_${count}.${ext}`;
                }
                filenameCount.set(attachment.filename, count + 1);

                const response = await fetch(attachment.url);
                if (response.ok) {
                    const blob = await response.blob();
                    attachmentFolder?.file(filename, blob);

                    // Update the attachment object with the final filename for HTML generation
                    attachment.filename = filename;

                    downloadedCount++;
                    setProgress({
                        currentChannel: "",
                        processedChannels: 0,
                        totalChannels: 0,
                        processedMessages: downloadedCount,
                        totalMessages: totalAttachments,
                        status: Messages.DOWNLOADING_ATTACHMENTS(downloadedCount, totalAttachments, Math.round(downloadedCount / totalAttachments * 100))
                    });

                    return true;
                } else {
                    logger.warn(`Failed to download attachment: ${filename}`);
                    return false;
                }
            } catch (error) {
                logger.error(`Error downloading attachment ${attachment.filename}:`, error);
                return false;
            }
        }

        // Download attachments in parallel with a concurrency limit
        const CONCURRENT_DOWNLOADS = 5;
        for (let i = 0; i < attachments.length; i += CONCURRENT_DOWNLOADS) {
            const batch = attachments.slice(i, i + CONCURRENT_DOWNLOADS);
            await Promise.all(batch.map(downloadAttachment));

            // Small delay between batches to avoid rate limiting
            if (i + CONCURRENT_DOWNLOADS < attachments.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Generate HTML with local attachment links
        setProgress({
            currentChannel: "",
            processedChannels: 0,
            totalChannels: 0,
            processedMessages: downloadedCount,
            totalMessages: totalAttachments,
            status: "Generating HTML with attachments..."
        });

        const htmlData = await formatAsHTMLWithAttachments(messages, channels);
        zip.file("export.html", htmlData);

        // Generate ZIP
        setProgress({
            currentChannel: "",
            processedChannels: 0,
            totalChannels: 0,
            processedMessages: downloadedCount,
            totalMessages: totalAttachments,
            status: "Creating ZIP file..."
        });

        const zipBlob = await zip.generateAsync({ type: "blob" });

        // Download ZIP
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        a.href = url;

        let channelName = "export";
        if (channels.length === 1) {
            const channel = channels[0];
            if (channel.type === 1) { // DM
                const recipientId = channel.recipients?.[0];
                if (recipientId) {
                    try {
                        const recipient = UserStore.getUser(recipientId);
                        if (recipient) {
                            channelName = `DM-${recipient.username}`;
                        } else {
                            channelName = "DM";
                        }
                    } catch (error) {
                        channelName = "DM";
                    }
                } else {
                    channelName = "DM";
                }
            } else if (channel.type === 3) { // Group DM
                channelName = channel.name?.replace(/[^a-zA-Z0-9]/g, "-") || "GroupDM";
            } else {
                channelName = channel.name?.replace(/[^a-zA-Z0-9]/g, "-") || "channel";
            }
        } else {
            channelName = `${channels.length}-channels`;
        }

        const timestamp = new Date().toISOString().split("T")[0];
        a.download = `discord-export-${channelName}-${timestamp}.zip`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        logger.error("Failed to create ZIP with attachments:", error);
        // Fallback to regular HTML export
        const exportData = await formatExportData(messages, options, channels);
        downloadExport(exportData, options.format, channels);
    }
}

function formatAsHTMLWithAttachments(messages: ExportedMessage[], channels: Channel[]): string {
    // Helper function to parse custom emojis in content
    function parseContent(content: string): string {
        if (!content) return "<em>No content</em>";

        // Escape HTML
        let escaped = content
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        // Convert custom emojis to images
        escaped = escaped.replace(/<:(\w+):(\d+)>/g, '<img class="emoji" src="https://cdn.discordapp.com/emojis/$2.png" alt=":$1:" title=":$1:">');
        escaped = escaped.replace(/<a:(\w+):(\d+)>/g, '<img class="emoji" src="https://cdn.discordapp.com/emojis/$2.gif" alt=":$1:" title=":$1:">');

        // Convert mentions to highlighted text
        escaped = escaped.replace(/<@!?(\d+)>/g, '<span class="mention">@User</span>');
        escaped = escaped.replace(/<@&(\d+)>/g, '<span class="mention">@Role</span>');
        escaped = escaped.replace(/<#(\d+)>/g, '<span class="mention">#channel</span>');

        // Convert line breaks
        escaped = escaped.replace(/\n/g, "<br>");

        return escaped;
    }

    let html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Discord Chat Export</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #36393f;
            color: #dcddde;
            margin: 0;
            padding: 20px;
            line-height: 1.5;
        }
        .header {
            background: #2f3136;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }
        .channel {
            background: #40444b;
            margin: 10px 0;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .message {
            margin: 10px 0;
            padding: 10px;
            border-left: 3px solid transparent;
            transition: all 0.2s ease;
            border-radius: 4px;
        }
        .message:hover {
            background: rgba(0,0,0,0.1);
            border-left-color: #7289da;
        }
        .message.has-attachment {
            border-left-color: #43b581;
        }
        .author {
            font-weight: bold;
            color: #7289da;
            margin-bottom: 4px;
        }
        .timestamp {
            color: #72767d;
            font-size: 0.8em;
            margin-left: 8px;
        }
        .content {
            margin: 5px 0;
            word-wrap: break-word;
        }
        .attachment {
            background: #2f3136;
            padding: 10px;
            margin: 5px 0;
            border-radius: 4px;
            display: inline-block;
        }
        .attachment a {
            color: #00aff4;
            text-decoration: none;
        }
        .attachment a:hover {
            text-decoration: underline;
        }
        .attachment img, .attachment video {
            max-width: 400px;
            max-height: 300px;
            border-radius: 4px;
            margin: 5px 0;
            cursor: pointer;
            transition: transform 0.2s ease;
        }
        .attachment img:hover {
            transform: scale(1.05);
        }
        .emoji {
            width: 20px;
            height: 20px;
            vertical-align: text-bottom;
            margin: 0 2px;
        }
        .mention {
            background: rgba(114, 137, 218, 0.3);
            color: #7289da;
            padding: 0 2px;
            border-radius: 3px;
        }
        .reply {
            display: flex;
            align-items: center;
            margin-bottom: 4px;
            padding-left: 20px;
            position: relative;
            font-size: 0.875rem;
            color: #8e9297;
        }
        .reply::before {
            content: "";
            position: absolute;
            left: 0;
            top: 50%;
            width: 16px;
            height: 8px;
            border-left: 2px solid #4f545c;
            border-top: 2px solid #4f545c;
            border-top-left-radius: 6px;
        }
        .reaction {
            background: #2f3136;
            padding: 2px 6px;
            margin: 2px;
            border-radius: 12px;
            display: inline-block;
            font-size: 0.9em;
        }
        .no-content {
            color: #72767d;
            font-style: italic;
        }

        /* Lightbox styles */
        .lightbox {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.9);
            animation: fadeIn 0.3s ease;
        }

        .lightbox.active {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .lightbox-content {
            max-width: 90%;
            max-height: 90%;
            animation: zoomIn 0.3s ease;
        }

        .lightbox-close {
            position: absolute;
            top: 20px;
            right: 40px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
            transition: color 0.2s ease;
        }

        .lightbox-close:hover {
            color: #ff5555;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        @keyframes zoomIn {
            from { transform: scale(0.5); }
            to { transform: scale(1); }
        }
    </style>
    <script>
        function openLightbox(src) {
            const lightbox = document.getElementById('lightbox');
            const lightboxImg = document.getElementById('lightbox-img');
            lightbox.classList.add('active');
            lightboxImg.src = src;
        }

        function closeLightbox() {
            const lightbox = document.getElementById('lightbox');
            lightbox.classList.remove('active');
        }

        // Close lightbox on escape key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                closeLightbox();
            }
        });
    </script>
</head>
<body>
    <div class="header">
        <h1>Discord Chat Export</h1>
        <p>Exported on: ${new Date().toLocaleString()}</p>
        <p>Channels: ${channels.map(c => {
        const prefix = c.type === 1 || c.type === 3 ? "" : "#";
        return `${prefix}${c.name}`;
    }).join(", ")}</p>
        <p>Messages: ${messages.length}</p>
        <p><em>📦 Attachments are included in the attachments/ folder</em></p>
    </div>

    <!-- Lightbox -->
    <div id="lightbox" class="lightbox" onclick="closeLightbox()">
        <span class="lightbox-close">&times;</span>
        <img id="lightbox-img" class="lightbox-content" onclick="event.stopPropagation()">
    </div>
`;

    let currentChannel = "";
    for (const message of messages) {
        if (message.channel.name !== currentChannel) {
            if (currentChannel) html += "</div>";
            currentChannel = message.channel.name;
            // Don't add # for DMs
            const channelPrefix = message.channel.type === 1 || message.channel.type === 3 ? "" : "#";
            html += `<div class="channel"><h2>${channelPrefix}${currentChannel}</h2>`;
        }

        const timestamp = new Date(message.timestamp).toLocaleString();
        const author = message.author.displayName || `${message.author.username}#${message.author.discriminator}`;
        const hasAttachment = message.attachments.length > 0;
        const messageClass = hasAttachment ? "message has-attachment" : "message";

        html += `
<div class="${messageClass}">`;

        // Add reply context if present
        if (message.reply) {
            html += `
    <div class="reply">
        ↪️ Replying to: ${message.reply.content.substring(0, 100)}${message.reply.content.length > 100 ? "..." : ""}
    </div>`;
        }

        html += `
    <div class="author">${author} <span class="timestamp">${timestamp}</span></div>
    <div class="content">${parseContent(message.content)}</div>
`;

        if (message.attachments.length > 0) {
            html += "<div class=\"attachments\">";
            for (const att of message.attachments) {
                const localPath = `attachments/${att.filename}`;
                const isImage = att.contentType?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(att.filename);
                const isVideo = att.contentType?.startsWith("video/") || /\.(mp4|webm|mov|avi)$/i.test(att.filename);

                if (isImage) {
                    html += `<div class="attachment">
                        <a href="${localPath}" target="_blank">📎 ${att.filename}</a><br/>
                        <img src="${localPath}" alt="${att.filename}" loading="lazy" onclick="openLightbox('${localPath}')"/>
                    </div>`;
                } else if (isVideo) {
                    html += `<div class="attachment">
                        <a href="${localPath}" target="_blank">📎 ${att.filename}</a><br/>
                        <video controls>
                            <source src="${localPath}" type="${att.contentType || "video/mp4"}">
                            Your browser does not support the video tag.
                        </video>
                    </div>`;
                } else {
                    html += `<div class="attachment">
                        <a href="${localPath}" target="_blank">📎 ${att.filename}</a>
                        <span style="color: #72767d; font-size: 0.8em;"> (${(att.size / 1024).toFixed(1)} KB)</span>
                    </div>`;
                }
            }
            html += "</div>";
        }

        if (message.reactions.length > 0) {
            html += "<div class=\"reactions\">";
            for (const reaction of message.reactions) {
                html += `<span class="reaction">${reaction.emoji} ${reaction.count}</span>`;
            }
            html += "</div>";
        }

        html += "</div>";
    }

    if (currentChannel) html += "</div>";
    html += "</body></html>";

    return html;
}

function downloadExport(data: string, format: string, channels: Channel[]) {
    const blob = new Blob([data], {
        type: format === "json" ? "application/json" :
            format === "csv" ? "text/csv" :
                format === "html" ? "text/html" : "text/plain"
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;

    let channelName = "export";
    if (channels.length === 1) {
        const channel = channels[0];
        if (channel.type === 1) { // DM
            const recipientId = channel.recipients?.[0];
            if (recipientId) {
                try {
                    const recipient = UserStore.getUser(recipientId);
                    if (recipient) {
                        channelName = `DM-${recipient.username}`;
                    } else {
                        channelName = "DM";
                    }
                } catch (error) {
                    channelName = "DM";
                }
            } else {
                channelName = "DM";
            }
        } else if (channel.type === 3) { // Group DM
            channelName = channel.name?.replace(/[^a-zA-Z0-9]/g, "-") || "GroupDM";
        } else {
            channelName = channel.name?.replace(/[^a-zA-Z0-9]/g, "-") || "channel";
        }
    } else {
        channelName = `${channels.length}-channels`;
    }

    const timestamp = new Date().toISOString().split("T")[0];
    a.download = `discord-export-${channelName}-${timestamp}.${format}`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export default definePlugin({
    name: "Chat Exporter",
    description: "Tired of having to export your chat history through dodgy Tampermonkey scripts or download additional apps and give away your AUTH token? This plugin takes care of that.\n\nThrough this plugin you can export in various formats, as JSON, HTML, CSV, or even Plain Text. If you want, It will also include attachments neatly packed in a .zip and referenced in the HTML files for easy viewing after export.",
    authors: [Devs.Hardtokidnap],
    dependencies: [],
    settings,

    contextMenus: {
        "channel-context": (children, { channel }) => {
            if (!channel?.id) return;

            children.push(
                <Menu.MenuItem
                    id="vc-chat-exporter"
                    label="Export Chat..."
                    action={() => openModal(modalProps =>
                        <ExportModal
                            modalProps={modalProps}
                            initialChannelId={channel.id}
                        />
                    )}
                />
            );
        },
        "gdm-context": (children, { channel }) => {
            if (!channel?.id) return;

            children.push(
                <Menu.MenuItem
                    id="vc-chat-exporter-gdm"
                    label="Export Chat..."
                    action={() => openModal(modalProps =>
                        <ExportModal
                            modalProps={modalProps}
                            initialChannelId={channel.id}
                        />
                    )}
                />
            );
        },
        "user-context": (children, { channel }) => {
            if (!channel?.id) return;

            children.push(
                <Menu.MenuItem
                    id="vc-chat-exporter-dm"
                    label="Export Chat..."
                    action={() => openModal(modalProps =>
                        <ExportModal
                            modalProps={modalProps}
                            initialChannelId={channel.id}
                        />
                    )}
                />
            );
        }
    }
});
