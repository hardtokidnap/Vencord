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
    FluxDispatcher,
    Forms,
    GuildChannelStore,
    GuildMemberStore,
    GuildStore,
    Menu,
    RestAPI,
    Select,
    SelectedChannelStore,
    Text,
    TextInput,
    useEffect,
    useMemo,
    UserStore,
    useState,
    useStateFromStores
} from "@webpack/common";
import { Channel } from "discord-types/general";

// JSZip will be loaded dynamically
let JSZip: any;

const logger = new Logger("ChatExporter");

// Markdown parsing utilities
function parseMarkdown(text: string): string {
    if (!text) return "";

    // Escape HTML first
    let parsed = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    // Parse Discord-specific markdown
    // Bold
    parsed = parsed.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    parsed = parsed.replace(/\*(.+?)\*/g, "<em>$1</em>");
    parsed = parsed.replace(/_(.+?)_/g, "<em>$1</em>");
    // Underline
    parsed = parsed.replace(/__(.+?)__/g, "<u>$1</u>");
    // Strikethrough
    parsed = parsed.replace(/~~(.+?)~~/g, "<del>$1</del>");
    // Inline code
    parsed = parsed.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Code blocks
    parsed = parsed.replace(/```(\w+)?\n([\s\S]+?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang || "plaintext"}">${code.trim()}</code></pre>`;
    });
    // Spoilers
    parsed = parsed.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
    // Block quotes
    parsed = parsed.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    // Headers
    parsed = parsed.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    parsed = parsed.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    parsed = parsed.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Links
    parsed = parsed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Convert custom emojis
    parsed = parsed.replace(/&lt;:(\w+):(\d+)&gt;/g, '<img class="emoji" src="https://cdn.discordapp.com/emojis/$2.png" alt=":$1:" title=":$1:">');
    parsed = parsed.replace(/&lt;a:(\w+):(\d+)&gt;/g, '<img class="emoji animated" src="https://cdn.discordapp.com/emojis/$2.gif" alt=":$1:" title=":$1:">');

    // Convert mentions
    parsed = parsed.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@User</span>');
    parsed = parsed.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@Role</span>');
    parsed = parsed.replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#channel</span>');

    // Line breaks
    parsed = parsed.replace(/\n/g, "<br>");

    // Merge adjacent blockquotes
    parsed = parsed.replace(/<\/blockquote><br><blockquote>/g, "<br>");

    return parsed;
}

// Rate limiting with exponential backoff
class RateLimiter {
    private retryAfter: number = 0;
    private retryCount: number = 0;
    private maxRetries: number = 10;
    private baseDelay: number = 1000;
    private maxDelay: number = 60000;

    async executeWithRetry<T>(
        fn: () => Promise<T>,
        onRetry?: (retryCount: number, delay: number) => void
    ): Promise<T> {
        while (this.retryCount < this.maxRetries) {
            try {
                // Wait if we're rate limited
                if (this.retryAfter > Date.now()) {
                    const waitTime = this.retryAfter - Date.now();
                    if (onRetry) {
                        onRetry(this.retryCount, waitTime);
                    }
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }

                const result = await fn();

                // Reset on success
                this.retryCount = 0;
                this.retryAfter = 0;

                return result;
            } catch (error: any) {
                if (error?.status === 429) {
                    this.retryCount++;

                    // Get retry after from headers or calculate exponential backoff
                    const retryAfterHeader = error.headers?.["retry-after"];
                    let delay: number;

                    if (retryAfterHeader) {
                        delay = parseInt(retryAfterHeader) * 1000;
                    } else {
                        // Exponential backoff with jitter
                        delay = Math.min(
                            this.baseDelay * Math.pow(2, this.retryCount - 1) + Math.random() * 1000,
                            this.maxDelay
                        );
                    }

                    this.retryAfter = Date.now() + delay;

                    if (this.retryCount >= this.maxRetries) {
                        throw new Error(`Rate limited after ${this.maxRetries} retries`);
                    }

                    continue;
                }

                // Non-rate limit error
                throw error;
            }
        }

        throw new Error("Max retries exceeded");
    }
}

// User-facing messages
const Messages = {
    ATTACHMENT_WARNING: "Large files or many attachments may take considerable time to download",
    ATTACHMENT_INFO: "Attachments will be downloaded and packaged in a ZIP file along with your export",
    UNLIMITED_WARNING: "Warning: Unlimited exports may take a long time and consume significant memory for large servers",
    RATE_LIMIT_ERROR: "⚠️ Rate limited by Discord API. Please wait a moment and try again with a smaller export.",
    RATE_LIMIT_RETRY: (seconds: number) => `Rate limited - waiting ${seconds}s before retry...`,
    FETCHING_MESSAGES: (count: number) => `Fetched ${count} messages from current channel...`,
    DOWNLOADING_ATTACHMENTS: (current: number, total: number, percent: number) =>
        `Downloading attachments: ${current}/${total} (${percent}%)`,
    USER_FILTER_INFO: "Select users to include or exclude from the export",
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

// Helper function to download media via HTML elements (works around CORS)
async function downloadViaElement(url: string, type: "image" | "video"): Promise<Blob | null> {
    return new Promise(resolve => {
        try {
            if (type === "image") {
                const img = new Image();
                img.crossOrigin = "anonymous";

                img.onload = () => {
                    try {
                        const canvas = document.createElement("canvas");
                        canvas.width = img.width;
                        canvas.height = img.height;
                        const ctx = canvas.getContext("2d");

                        if (ctx) {
                            ctx.drawImage(img, 0, 0);
                            canvas.toBlob(blob => {
                                resolve(blob);
                            }, "image/png");
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        logger.error("Error converting image to blob:", e);
                        resolve(null);
                    }
                };

                img.onerror = () => {
                    logger.error(`Failed to load image: ${url}`);
                    resolve(null);
                };

                img.src = url;
            } else if (type === "video") {
                // For videos, we'll try to use the blob URL directly from a fetch with no-cors
                // This is a workaround that might work for some videos
                fetch(url, { mode: "no-cors" })
                    .then(() => {
                        // We can't access the response, but we can try to create a blob URL
                        // This is a hack that might work in some cases
                        logger.warn("Video download via element not fully implemented, returning null");
                        resolve(null);
                    })
                    .catch(() => {
                        resolve(null);
                    });
            }
        } catch (error) {
            logger.error("Error in downloadViaElement:", error);
            resolve(null);
        }
    });
}

// Helper functions for attachment type detection (based on DiscordChatExporter logic)
function getFileExtension(filename: string): string {
    const lastDot = filename.lastIndexOf(".");
    return lastDot === -1 ? "" : filename.substring(lastDot + 1).toLowerCase();
}

function isImageAttachment(filename: string, contentType?: string): boolean {
    if (contentType?.startsWith("image/")) return true;
    const ext = getFileExtension(filename);
    return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext);
}

function isVideoAttachment(filename: string, contentType?: string): boolean {
    if (contentType?.startsWith("video/")) return true;
    const ext = getFileExtension(filename);
    return ["gifv", "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v"].includes(ext);
}

function isAudioAttachment(filename: string, contentType?: string): boolean {
    if (contentType?.startsWith("audio/")) return true;
    const ext = getFileExtension(filename);
    return ["mp3", "wav", "ogg", "flac", "m4a"].includes(ext);
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
    const defaultMessageLimit = settings.store.defaultMessageLimit ?? 1000;
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
    const [userSearchQuery, setUserSearchQuery] = useState("");

    // Get guild members for user filtering (only for guilds)
    const [guildMembers, setGuildMembers] = useState<Array<{
        label: string;
        value: string;
        username: string;
        nick: string;
    }>>([]);

    // Track member IDs to detect when new members are loaded
    const memberIds = useStateFromStores(
        [GuildMemberStore],
        () => currentGuild && !isDM ? GuildMemberStore.getMemberIds(currentGuild.id) : [],
        null,
        (old, current) => old.length === current.length
    );

    useEffect(() => {
        if (!currentGuild || isDM) {
            setGuildMembers([]);
            return;
        }

        const fetchMembers = () => {
            try {
                // Get all member IDs first
                const allMemberIds = GuildMemberStore.getMemberIds(currentGuild.id);
                const formattedMembers: any[] = [];

                // Fetch each member individually
                for (const memberId of allMemberIds) {
                    const member = GuildMemberStore.getMember(currentGuild.id, memberId);
                    const user = UserStore.getUser(memberId);

                    if (user) {
                        formattedMembers.push({
                            label: `${member?.nick || user.username}#${user.discriminator}`,
                            value: user.id,
                            username: user.username.toLowerCase(),
                            nick: (member?.nick ?? "").toLowerCase()
                        });
                    }
                }

                setGuildMembers(formattedMembers);
            } catch (error) {
                logger.error("Error fetching guild members:", error);
                setGuildMembers([]);
            }
        };

        // Initial fetch
        fetchMembers();

        // Request more members if needed
        if (memberIds.length < 100) {
            // For small servers, request all members
            FluxDispatcher.dispatch({
                type: "GUILD_MEMBERS_REQUEST",
                guildIds: [currentGuild.id],
                query: "",
                limit: 0
            });
        }

    }, [currentGuild, isDM, memberIds]);

    // Filter members based on search query
    const filteredMembers = useMemo(() => {
        if (!userSearchQuery) return guildMembers;

        const query = userSearchQuery.toLowerCase();
        return guildMembers.filter(member =>
            member.username.includes(query) ||
            member.nick.includes(query) ||
            member.label.toLowerCase().includes(query)
        );
    }, [guildMembers, userSearchQuery]);

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

    const toggleUserSelection = (userId: string) => {
        setOptions(prev => {
            const userIds = prev.userFilter.userIds.includes(userId)
                ? prev.userFilter.userIds.filter(id => id !== userId)
                : [...prev.userFilter.userIds, userId];

            return {
                ...prev,
                userFilter: { ...prev.userFilter, userIds }
            };
        });
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
                                <Text>
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
                                            <Text>
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

                                    {!isDM ? (
                                        <>
                                            <TextInput
                                                placeholder="Search users..."
                                                value={userSearchQuery}
                                                onChange={setUserSearchQuery}
                                                style={{
                                                    marginTop: "8px",
                                                    marginBottom: "8px",
                                                    background: "var(--input-background)"
                                                }}
                                            />

                                            <div style={{
                                                maxHeight: "200px",
                                                overflowY: "auto",
                                                border: "1px solid var(--background-modifier-accent)",
                                                borderRadius: "4px",
                                                padding: "8px"
                                            }}>
                                                {filteredMembers.length > 0 ? (
                                                    filteredMembers.map(member => (
                                                        <div key={member.value} style={{ marginBottom: "4px" }}>
                                                            <Checkbox
                                                                value={options.userFilter.userIds.includes(member.value)}
                                                                onChange={() => toggleUserSelection(member.value)}
                                                            >
                                                                {member.label}
                                                            </Checkbox>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <Text>
                                                        {guildMembers.length === 0 ? "Loading members..." : "No users found"}
                                                    </Text>
                                                )}
                                            </div>

                                            {options.userFilter.userIds.length > 0 && (
                                                <Text style={{ marginTop: "8px" }}>
                                                    {options.userFilter.userIds.length} user{options.userFilter.userIds.length !== 1 ? "s" : ""} selected
                                                </Text>
                                            )}
                                        </>
                                    ) : (
                                        <Text>
                                            User filtering is not available in DMs
                                        </Text>
                                    )}
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
                                    value={String(options.messageLimit)}
                                    onChange={value => {
                                        const num = parseInt(value) || 0;
                                        updateOption("messageLimit", Math.max(0, num));
                                    }}
                                    placeholder="0"
                                />
                                {options.messageLimit === 0 && (
                                    <Text style={{ marginTop: "5px" }}>
                                        ⚠️ {Messages.UNLIMITED_WARNING}
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
                                {options.includeAttachments && (
                                    <>
                                        <Text style={{ marginLeft: "20px", marginTop: "5px" }}>
                                            📦 {Messages.ATTACHMENT_INFO}
                                        </Text>
                                        <Text style={{ marginLeft: "20px", marginTop: "5px" }}>
                                            ⚠️ {Messages.ATTACHMENT_WARNING}
                                        </Text>
                                    </>
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
                                <Text>
                                    <strong>Scope:</strong> {options.scope === "current-channel" ?
                                        (currentChannel ? currentChannel.name : "Current Channel") :
                                        "Entire Server"}
                                </Text>
                                <Text>
                                    <strong>Format:</strong> {options.format.toUpperCase()}
                                </Text>
                                <Text>
                                    <strong>Message Limit:</strong> {options.messageLimit === 0 ? "Unlimited" : options.messageLimit}
                                </Text>
                                {options.dateRange.enabled && (
                                    <Text>
                                        <strong>Date Range:</strong> {options.dateRange.start.toLocaleDateString()} - {options.dateRange.end.toLocaleDateString()}
                                    </Text>
                                )}
                            </div>
                        </Card>
                    </div>
                ) : (
                    <div className="vc-export-progress">
                        <Text variant="heading-md/semibold" style={{ color: "var(--header-primary)" }}>Exporting...</Text>
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
                                        <Text>
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
                                    <div style={{ marginTop: "10px", padding: "10px", background: "var(--status-danger-background)", borderRadius: "4px" }}>
                                        <Text style={{ color: "var(--text-danger)" }}>
                                            ❌ {progress.status}
                                        </Text>
                                    </div>
                                )}
                                {progress.status.includes("completed") && (
                                    <div style={{ marginTop: "10px", padding: "10px", background: "var(--status-positive-background)", borderRadius: "4px" }}>
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

    // Handle attachments if enabled (for all formats, not just HTML)
    if (options.includeAttachments) {
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
    const rateLimiter = new RateLimiter();

    while (true) {
        try {
            const response = await rateLimiter.executeWithRetry(
                async () => RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query: {
                        limit: 100, // Back to 100 with better rate limiting
                        ...(lastMessageId && { before: lastMessageId })
                    }
                }),
                (retryCount, delay) => {
                    setProgress({
                        currentChannel: "",
                        processedChannels: 0,
                        totalChannels: 0,
                        processedMessages: fetchedCount,
                        totalMessages: 0,
                        status: Messages.RATE_LIMIT_RETRY(Math.round(delay / 1000))
                    });
                }
            );

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

            // Small delay between requests to be respectful
            await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error) {
            logger.error("Failed to fetch messages:", error);

            // If rate limiter threw an error after max retries
            if (error instanceof Error && error.message.includes("Rate limited")) {
                setProgress({
                    currentChannel: "",
                    processedChannels: 0,
                    totalChannels: 0,
                    processedMessages: fetchedCount,
                    totalMessages: 0,
                    status: Messages.RATE_LIMIT_ERROR
                });
            }

            break;
        }
    }

    // Discord returns messages newest first when using 'before', so reverse to get chronological order
    return messages.reverse();
}

async function processMessage(rawMessage: any, options: ExportOptions): Promise<ExportedMessage | null> {
    // Apply user filter if enabled
    if (options.userFilter.enabled && options.userFilter.userIds.length > 0) {
        const authorId = rawMessage.author.id;
        const isIncluded = options.userFilter.userIds.includes(authorId);

        // If mode is "include", only include messages from selected users
        // If mode is "exclude", exclude messages from selected users
        if (options.userFilter.mode === "include" && !isIncluded) {
            return null;
        }
        if (options.userFilter.mode === "exclude" && isIncluded) {
            return null;
        }
    }

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
        // Debug: Log raw attachments
        rawMessage.attachments.forEach((att: any) => {
            if (isVideoAttachment(att.filename, att.content_type)) {
                logger.info(`Found video attachment in message: ${att.filename} (${att.content_type || "no content type"}) - URL: ${att.url}`);
            }
        });

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
    // Sort messages by timestamp consistently across all formats (oldest first)
    // Create a new sorted array to avoid mutation issues
    const sortedMessages = [...messages].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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
    // Use the markdown parser
    function parseContent(content: string): string {
        if (!content) return "<em>No content</em>";
        return parseMarkdown(content);
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
        code {
            background: #2f3136;
            padding: 2px 4px;
            border-radius: 3px;
            font-family: Consolas, 'Courier New', monospace;
            font-size: 0.875em;
        }
        pre {
            background: #2f3136;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 5px 0;
        }
        pre code {
            background: none;
            padding: 0;
        }
        blockquote {
            border-left: 4px solid #4f545c;
            padding-left: 12px;
            margin: 5px 0;
            color: #b9bbbe;
        }
        .spoiler {
            background: #202225;
            color: transparent;
            cursor: pointer;
            padding: 0 2px;
            border-radius: 3px;
            transition: all 0.1s ease;
        }
        .spoiler:hover {
            background: #2f3136;
        }
        .spoiler.revealed {
            color: inherit;
            background: rgba(255, 255, 255, 0.1);
        }
        h1, h2, h3 {
            margin: 10px 0 5px 0;
            color: #ffffff;
        }
        h1 { font-size: 1.5em; }
        h2 { font-size: 1.3em; }
        h3 { font-size: 1.1em; }
        strong { font-weight: 600; }
        em { font-style: italic; }
        u { text-decoration: underline; }
        del { text-decoration: line-through; opacity: 0.6; }
        a {
            color: #00aff4;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .emoji.animated {
            width: 48px;
            height: 48px;
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
        let failedCount = 0;
        const totalAttachments = attachments.length;

        // Debug: Log attachment types
        logger.info(`Total attachments to download: ${totalAttachments}`);
        const videoAttachments = attachments.filter(att =>
            isVideoAttachment(att.filename, att.contentType)
        );
        logger.info(`Video attachments found: ${videoAttachments.length}`);
        videoAttachments.forEach(video => {
            logger.info(`Video: ${video.filename} (${video.contentType || "no content type"})`);
        });

        // Helper function to download a single attachment with retry
        async function downloadAttachment(attachment: any, retryCount = 0): Promise<boolean> {
            const maxRetries = 3;
            console.error(`[ChatExporter DEBUG] downloadAttachment called for: ${attachment.filename} URL: ${attachment.url}`);
            try {
                // Handle filename collisions
                const { filename: attachmentFilename } = attachment;
                let filename = attachmentFilename;
                const count = filenameCount.get(attachment.filename) || 0;
                if (count > 0) {
                    const ext = filename.lastIndexOf(".");
                    if (ext > 0) {
                        filename = `${filename.substring(0, ext)}_${count}${filename.substring(ext)}`;
                    } else {
                        filename = `${filename}_${count}`;
                    }
                }
                filenameCount.set(attachment.filename, count + 1);

                // Debug: Log what we're downloading
                const isVideo = isVideoAttachment(attachment.filename, attachment.contentType);
                if (isVideo) {
                    logger.info(`Downloading video: ${filename} from ${attachment.url}`);
                }

                // Convert CDN URLs to media proxy URLs to avoid CORS issues
                let downloadUrl = attachment.url;

                logger.error(`[DEBUG] Starting URL conversion for: ${downloadUrl}`);
                console.error(`[ChatExporter DEBUG] Starting URL conversion for: ${downloadUrl}`);
                logger.error(`[DEBUG] URL includes cdn.discordapp.com: ${downloadUrl.includes("cdn.discordapp.com")}`);
                logger.error(`[DEBUG] URL includes media.discordapp.net: ${downloadUrl.includes("media.discordapp.net")}`);

                // Check if it's a Discord CDN URL and convert to media proxy
                if (downloadUrl.includes("cdn.discordapp.com") || downloadUrl.includes("media.discordapp.net")) {
                    logger.error("[DEBUG] URL matches Discord CDN/media proxy pattern");
                    console.error("[ChatExporter DEBUG] URL matches Discord CDN/media proxy pattern");
                    const url = new URL(downloadUrl);
                    logger.error(`[DEBUG] URL host: ${url.host}`);

                    // If it's already a media proxy URL, just clean up parameters
                    if (url.host === "media.discordapp.net") {
                        logger.error("[DEBUG] Already a media proxy URL, cleaning parameters");
                        // Remove any size constraints that might affect video quality
                        url.searchParams.delete("width");
                        url.searchParams.delete("height");
                        url.searchParams.delete("quality");
                        url.searchParams.delete("format");
                        downloadUrl = url.toString();
                    } else if (url.host === "cdn.discordapp.com") {
                        logger.error("[DEBUG] Converting CDN URL to media proxy");
                        // Convert CDN URL to media proxy URL using Discord's media proxy
                        const mediaProxyEndpoint = (window as any).GLOBAL_ENV?.MEDIA_PROXY_ENDPOINT || "https://media.discordapp.net";
                        logger.error(`[DEBUG] Media proxy endpoint: ${mediaProxyEndpoint}`);

                        // Extract the path from the CDN URL (everything after cdn.discordapp.com)
                        const cdnPath = url.pathname + url.search;
                        logger.error(`[DEBUG] CDN path: ${cdnPath}`);

                        // Create the media proxy URL
                        downloadUrl = `${mediaProxyEndpoint}${cdnPath}`;

                        logger.error(`[DEBUG] Converted CDN URL to media proxy: ${attachment.url} -> ${downloadUrl}`);
                        console.error(`[ChatExporter DEBUG] Converted CDN URL to media proxy: ${attachment.url} -> ${downloadUrl}`);
                    }

                    // Special handling for .gifv files - convert to .mp4
                    if (attachment.filename.toLowerCase().endsWith(".gifv")) {
                        downloadUrl = downloadUrl.replace(/\.gifv(\?|$)/, ".mp4$1");
                        logger.error(`[DEBUG] Converted .gifv URL to .mp4: ${downloadUrl}`);
                    }
                } else {
                    logger.error("[DEBUG] URL does not match Discord CDN pattern");
                    // For non-Discord URLs, keep as-is but clean up .gifv
                    if (attachment.filename.toLowerCase().endsWith(".gifv")) {
                        downloadUrl = downloadUrl.replace(/\.gifv(\?|$)/, ".mp4$1");
                        logger.error(`[DEBUG] Converted .gifv URL to .mp4: ${downloadUrl}`);
                    }
                }

                logger.error(`[DEBUG] Final download URL: ${downloadUrl}`);
                console.error(`[ChatExporter DEBUG] Final download URL: ${downloadUrl}`);

                // Try the standard CORS approach first
                try {
                    console.error(`[ChatExporter DEBUG] About to fetch with URL: ${downloadUrl}`);
                    const response = await fetch(downloadUrl, {
                        method: "GET",
                        mode: "cors"
                    });
                    if (response.ok) {
                        const blob = await response.blob();

                        // Debug: Log video blob info
                        if (isVideo) {
                            logger.info(`Downloaded video ${filename}: ${blob.size} bytes, type: ${blob.type}`);
                        }

                        await attachmentFolder!.file(filename, blob);
                        downloadedCount++;

                        setProgress({
                            currentChannel: "",
                            processedChannels: 0,
                            totalChannels: 0,
                            processedMessages: messages.length,
                            totalMessages: 0,
                            status: Messages.DOWNLOADING_ATTACHMENTS(downloadedCount, totalAttachments, Math.round((downloadedCount / totalAttachments) * 100))
                        });

                        return true;
                    } else if (response.status === 429 && retryCount < maxRetries) {
                        // Rate limited, wait and retry
                        const retryAfter = parseInt(response.headers.get("retry-after") || "1") * 1000;
                        await new Promise(resolve => setTimeout(resolve, retryAfter));
                        return downloadAttachment(attachment, retryCount + 1);
                    }
                } catch (corsError) {
                    logger.warn(`CORS error downloading ${filename}, trying no-cors approach:`, corsError);

                    // If CORS fails, try no-cors mode as a fallback
                    try {
                        const response = await fetch(downloadUrl, {
                            method: "GET",
                            mode: "no-cors"
                        });

                        // With no-cors, we can't access the response directly, but we can try to create an image/video element
                        // and then convert it to a blob
                        if (isVideo || isVideoAttachment(filename, attachment.contentType)) {
                            logger.info(`Attempting video element approach for ${filename}`);
                            const blob = await downloadViaElement(downloadUrl, "video");
                            if (blob) {
                                await attachmentFolder!.file(filename, blob);
                                downloadedCount++;
                                logger.info(`Successfully downloaded ${filename} via video element`);

                                setProgress({
                                    currentChannel: "",
                                    processedChannels: 0,
                                    totalChannels: 0,
                                    processedMessages: messages.length,
                                    totalMessages: 0,
                                    status: Messages.DOWNLOADING_ATTACHMENTS(downloadedCount, totalAttachments, Math.round((downloadedCount / totalAttachments) * 100))
                                });

                                return true;
                            }
                        } else if (isImageAttachment(filename, attachment.contentType)) {
                            logger.info(`Attempting image element approach for ${filename}`);
                            const blob = await downloadViaElement(downloadUrl, "image");
                            if (blob) {
                                await attachmentFolder!.file(filename, blob);
                                downloadedCount++;
                                logger.info(`Successfully downloaded ${filename} via image element`);

                                setProgress({
                                    currentChannel: "",
                                    processedChannels: 0,
                                    totalChannels: 0,
                                    processedMessages: messages.length,
                                    totalMessages: 0,
                                    status: Messages.DOWNLOADING_ATTACHMENTS(downloadedCount, totalAttachments, Math.round((downloadedCount / totalAttachments) * 100))
                                });

                                return true;
                            }
                        }
                    } catch (fallbackError) {
                        logger.error(`Fallback download also failed for ${filename}:`, fallbackError);
                    }
                }

                // Log failure details
                const errorDetails = {
                    filename: filename,
                    url: attachment.url,
                    finalUrl: downloadUrl,
                    contentType: attachment.contentType,
                    isVideo: isVideo
                };
                logger.error("Failed to download attachment:", errorDetails);

                return false;
            } catch (error) {
                logger.error(`Error downloading ${attachment.filename}:`, error);
                return false;
            }
        }

        // Process downloads in batches to avoid overwhelming the browser
        const CONCURRENT_DOWNLOADS = 5;
        const downloadQueue = [...attachments];
        const activeDownloads = new Set<Promise<boolean>>();

        // Process downloads with a sliding window approach
        while (downloadQueue.length > 0 || activeDownloads.size > 0) {
            // Start new downloads up to the limit
            while (activeDownloads.size < CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
                const attachment = downloadQueue.shift()!;
                const downloadPromise = downloadAttachment(attachment)
                    .then(success => {
                        if (!success) {
                            failedCount++;
                            logger.error(`Failed to download: ${attachment.filename}`);
                        }
                        return success;
                    })
                    .finally(() => activeDownloads.delete(downloadPromise));
                activeDownloads.add(downloadPromise);
            }

            // Wait for at least one download to complete
            if (activeDownloads.size > 0) {
                await Promise.race(activeDownloads);
            }
        }

        logger.info(`Download complete. Success: ${downloadedCount}, Failed: ${failedCount}`);

        // Create the export file
        setProgress({
            currentChannel: "",
            processedChannels: 0,
            totalChannels: 0,
            processedMessages: messages.length,
            totalMessages: 0,
            status: "Creating export file..."
        });

        let exportData: string;
        let filename: string;

        if (options.format === "html") {
            // For HTML, use the special version with local attachment links
            exportData = await formatAsHTMLWithAttachments(messages, channels);
            filename = "export.html";
        } else {
            // For other formats, use the standard formatters
            exportData = await formatExportData(messages, options, channels);
            filename = `export.${options.format}`;
        }

        zip.file(filename, exportData);

        // Generate and download the ZIP
        const zipBlob = await zip.generateAsync({ type: "blob" });

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
        a.download = `discord-export-${channelName}-${timestamp}-with-attachments.zip`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        logger.error("Failed to download attachments:", error);
        throw error;
    }
}

function formatAsHTMLWithAttachments(messages: ExportedMessage[], channels: Channel[]): string {
    // Use the markdown parser
    function parseContent(content: string): string {
        if (!content) return "<em>No content</em>";
        return parseMarkdown(content);
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
            transition: transform 0.2s ease;
        }
        .attachment img {
            cursor: pointer;
        }
        .attachment img:hover, .attachment video:hover {
            transform: scale(1.05);
        }
        .attachment video {
            display: block;
            width: 100%;
            max-width: 400px;
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
        code {
            background: #2f3136;
            padding: 2px 4px;
            border-radius: 3px;
            font-family: Consolas, 'Courier New', monospace;
            font-size: 0.875em;
        }
        pre {
            background: #2f3136;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 5px 0;
        }
        pre code {
            background: none;
            padding: 0;
        }
        blockquote {
            border-left: 4px solid #4f545c;
            padding-left: 12px;
            margin: 5px 0;
            color: #b9bbbe;
        }
        .spoiler {
            background: #202225;
            color: transparent;
            cursor: pointer;
            padding: 0 2px;
            border-radius: 3px;
            transition: all 0.1s ease;
        }
        .spoiler:hover {
            background: #2f3136;
        }
        .spoiler.revealed {
            color: inherit;
            background: rgba(255, 255, 255, 0.1);
        }
        h1, h2, h3 {
            margin: 10px 0 5px 0;
            color: #ffffff;
        }
        h1 { font-size: 1.5em; }
        h2 { font-size: 1.3em; }
        h3 { font-size: 1.1em; }
        strong { font-weight: 600; }
        em { font-style: italic; }
        u { text-decoration: underline; }
        del { text-decoration: line-through; opacity: 0.6; }
        a {
            color: #00aff4;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .emoji.animated {
            width: 48px;
            height: 48px;
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
                const isImage = isImageAttachment(att.filename, att.contentType);
                const isVideo = isVideoAttachment(att.filename, att.contentType);

                if (isImage) {
                    html += `<div class="attachment">
                        <a href="${localPath}" target="_blank">📎 ${att.filename}</a><br/>
                        <img src="${localPath}" alt="${att.filename}" loading="lazy" onclick="openLightbox('${localPath}')"/>
                    </div>`;
                } else if (isVideo) {
                    html += `<div class="attachment">
                        <a href="${localPath}" target="_blank">📎 ${att.filename}</a><br/>
                        <video controls ${att.filename.toLowerCase().endsWith(".gifv") ? "autoplay loop muted" : ""}>
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

