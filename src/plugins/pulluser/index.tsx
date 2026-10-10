/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Alerts, ChannelStore, Menu, PermissionStore, RestAPI, UserStore, useState } from "@webpack/common";

interface VoiceState {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
}

interface VoiceStateStore {
    getAllVoiceStates(): { [guildId: string]: { [userId: string]: VoiceState } };
    getVoiceStatesForChannel(channelId: string): { [userId: string]: VoiceState };
}

const VoiceStateStore: VoiceStateStore = findStoreLazy("VoiceStateStore");
const RelationshipStore = findStoreLazy("RelationshipStore");

let pullList: string[] = [];
let lastMyChannelId: string | null = null;
let monitorInterval: NodeJS.Timeout | null = null;
const pullCache = new Map<string, number>();
let recentPulls: { userId: string; username: string; globalName: string; timestamp: number }[] = [];

const settings = definePluginSettings({
    enableGUI: {
        type: OptionType.BOOLEAN,
        description: "Enable GUI (right-click menu)",
        default: true
    }
});

function hasMovePerm(channelId: string): boolean {
    try {
        const MOVE = 1n << 24n;
        const channel = ChannelStore.getChannel(channelId);
        if (!channel) return false;
        return PermissionStore.can(MOVE, channel);
    } catch {
        return false;
    }
}

function isPulled(userId: string): boolean {
    return pullList.includes(userId);
}

function addToPullList(userId: string) {
    if (!isPulled(userId)) {
        pullList.push(userId);
        console.log("[PullUser] Added:", userId, "Total:", pullList.length);
    }
}

function removeFromPullList(userId: string) {
    pullList = pullList.filter(id => id !== userId);
    console.log("[PullUser] Removed:", userId);
}

function getMyChannelId(): string | null {
    const myId = UserStore.getCurrentUser()?.id;
    if (!myId) return null;

    try {
        const states = VoiceStateStore.getAllVoiceStates();
        for (const users of Object.values(states)) {
            if (users[myId]?.channelId) {
                return users[myId].channelId;
            }
        }
    } catch {}
    return null;
}

function getCurrentGuildId(): string | null {
    const myChannelId = getMyChannelId();
    if (!myChannelId) return null;
    
    const channel = ChannelStore.getChannel(myChannelId);
    return channel?.guild_id || null;
}

function getUserInfo(userId: string): { username: string; globalName: string; id: string } {
    const user = UserStore.getUser(userId);
    return {
        username: user?.username || "Unknown",
        globalName: user?.globalName || user?.username || "Unknown",
        id: userId
    };
}

function addToRecentPulls(userId: string) {
    const userInfo = getUserInfo(userId);
    
    // Remove existing entry if exists
    recentPulls = recentPulls.filter(pull => pull.userId !== userId);
    
    // Add to beginning of array
    recentPulls.unshift({
        userId,
        username: userInfo.username,
        globalName: userInfo.globalName,
        timestamp: Date.now()
    });
    
    // Keep only last 20 pulls
    if (recentPulls.length > 20) {
        recentPulls = recentPulls.slice(0, 20);
    }
}

function pullUserInstant(guildId: string, userId: string, targetChannelId: string) {
    const now = Date.now();
    const cacheKey = `${userId}-${targetChannelId}`;
    const lastPull = pullCache.get(cacheKey);

    if (lastPull && (now - lastPull) < 5000) {
        return;
    }

    pullCache.set(cacheKey, now);

    // Add to recent pulls
    addToRecentPulls(userId);

    RestAPI.patch({
        url: `/guilds/${guildId}/members/${userId}`,
        body: { channel_id: targetChannelId }
    }).catch(() => {});
}

function monitorAndPull() {
    try {
        const myChannelId = getMyChannelId();

        if (!myChannelId) {
            lastMyChannelId = null;
            return;
        }

        lastMyChannelId = myChannelId;

        const channel = ChannelStore.getChannel(myChannelId);
        if (!channel || !hasMovePerm(myChannelId)) return;

        const allStates = VoiceStateStore.getAllVoiceStates();

        for (const userId of pullList) {
            let userChannelId: string | null = null;

            for (const users of Object.values(allStates)) {
                if (users[userId]?.channelId) {
                    userChannelId = users[userId].channelId;
                    break;
                }
            }

            if (userChannelId && userChannelId !== myChannelId) {
                pullUserInstant(channel.guild_id, userId, myChannelId);
                console.log("[PullUser] Monitor pulled:", userId);
            }
        }
    } catch {}
}

function startMonitoring() {
    if (monitorInterval) return;

    monitorInterval = setInterval(monitorAndPull, 1000);
    console.log("[PullUser] Monitoring started (1000ms)");
}

function stopMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        console.log("[PullUser] Monitoring stopped");
    }
}

// GUI Component with Search, Friends, and Recent Pulls
function PullUserManager() {
    const [searchTerm, setSearchTerm] = useState("");
    const [activeTab, setActiveTab] = useState("search"); // "search", "friends", "recent", "voice"
    const [refreshKey, setRefreshKey] = useState(0);

    const myChannelId = getMyChannelId();
    const guildId = getCurrentGuildId();
    const myId = UserStore.getCurrentUser()?.id;

    // Get all users in voice channels
    const allVoiceStates = VoiceStateStore.getAllVoiceStates();
    const voiceUsers: { id: string; username: string; globalName: string; channelId: string; channelName: string }[] = [];
    const seenUsers = new Set<string>();

    Object.values(allVoiceStates).forEach((users: any) => {
        Object.values(users).forEach((state: any) => {
            if (state.userId && state.channelId && !seenUsers.has(state.userId)) {
                const user = UserStore.getUser(state.userId);
                if (user && user.id !== myId) {
                    seenUsers.add(state.userId);
                    const channel = ChannelStore.getChannel(state.channelId);
                    voiceUsers.push({
                        id: state.userId,
                        username: user.username || "Unknown",
                        globalName: user.globalName || user.username || "Unknown",
                        channelId: state.channelId,
                        channelName: channel?.name || "Unknown Channel"
                    });
                }
            }
        });
    });

    // Get friends list
    const friends: { id: string; username: string; globalName: string }[] = [];
    try {
        const relationships = RelationshipStore.getRelationships();
        if (relationships) {
            Object.keys(relationships).forEach((userId) => {
                const relationship = relationships[userId];
                // Check if it's a friend relationship
                if (relationship === 1 || relationship === "FRIEND" || relationship === 2) {
                    const user = UserStore.getUser(userId);
                    if (user && user.id !== myId) {
                        friends.push({
                            id: user.id,
                            username: user.username || "Unknown",
                            globalName: user.globalName || user.username || "Unknown"
                        });
                    }
                }
            });
        }
    } catch (error) {
        console.error("[PullUser] Error getting friends:", error);
    }

    // Global search across all users
    const searchResults: { id: string; username: string; globalName: string; isFriend: boolean }[] = [];
    if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        
        // Search in all cached users
        const allUsers = UserStore.getUsers();
        if (allUsers) {
            Object.values(allUsers).forEach((user: any) => {
                if (user && user.id !== myId) {
                    const usernameMatch = user.username?.toLowerCase().includes(searchLower);
                    const globalNameMatch = user.globalName?.toLowerCase().includes(searchLower);
                    const idMatch = user.id?.includes(searchTerm);
                    
                    if (usernameMatch || globalNameMatch || idMatch) {
                        const isFriend = friends.some(f => f.id === user.id);
                        searchResults.push({
                            id: user.id,
                            username: user.username || "Unknown",
                            globalName: user.globalName || user.username || "Unknown",
                            isFriend
                        });
                    }
                }
            });
        }
        
        // Limit results
        searchResults.splice(50);
    }

    const handleManualAdd = () => {
        const userId = prompt("Enter user ID to add to pull list:");
        if (userId && userId.trim()) {
            const user = UserStore.getUser(userId.trim());
            if (user) {
                addToPullList(userId.trim());
                setRefreshKey(k => k + 1);
                Alerts.show({
                    title: "User Added",
                    body: `${user.globalName || user.username} has been added to the pull list.`,
                    confirmText: "OK"
                });
            } else {
                Alerts.show({
                    title: "Error",
                    body: "User not found. Please check the ID and try again.",
                    confirmText: "OK"
                });
            }
        }
    };

    const handleManualPull = () => {
        const userId = prompt("Enter user ID to pull now:");
        if (userId && userId.trim()) {
            if (myChannelId && guildId) {
                pullUserInstant(guildId, userId.trim(), myChannelId);
                setRefreshKey(k => k + 1);
                Alerts.show({
                    title: "Pull Executed",
                    body: "User has been pulled to your channel.",
                    confirmText: "OK"
                });
            }
        }
    };

    // Render user card with full info
    const renderUserCard = (userId: string, username: string, globalName: string, extraInfo?: string) => {
        const isInPullList = isPulled(userId);
        const isInVoice = voiceUsers.some(v => v.id === userId);
        const voiceChannel = voiceUsers.find(v => v.id === userId)?.channelName;
        
        return (
            <div key={userId} style={{ 
                display: "flex", 
                justifyContent: "space-between", 
                alignItems: "center",
                padding: "10px",
                marginBottom: "8px",
                backgroundColor: "var(--background-primary)",
                borderRadius: "6px",
                border: isInPullList ? "2px solid var(--text-link)" : "1px solid var(--background-tertiary)",
                transition: "all 0.2s"
            }}>
                <div style={{ flex: 1, marginRight: "10px" }}>
                    <div style={{ 
                        color: "var(--text-normal)",
                        fontWeight: "bold",
                        fontSize: "14px",
                        display: "flex",
                        alignItems: "center",
                        gap: "5px",
                        flexWrap: "wrap"
                    }}>
                        <span>{globalName}</span>
                        {isInVoice && (
                            <span style={{ 
                                fontSize: "10px", 
                                color: "var(--text-positive)",
                                backgroundColor: "var(--background-positive)",
                                padding: "2px 6px",
                                borderRadius: "10px"
                            }}>
                                VOICE
                            </span>
                        )}
                        {isInPullList && (
                            <span style={{ 
                                fontSize: "10px", 
                                color: "var(--text-link)",
                                backgroundColor: "var(--background-secondary)",
                                padding: "2px 6px",
                                borderRadius: "10px"
                            }}>
                                PULL LIST
                            </span>
                        )}
                    </div>
                    <div style={{ 
                        color: "var(--text-muted)",
                        fontSize: "12px",
                        marginTop: "3px"
                    }}>
                        @{username}
                    </div>
                    <div style={{ 
                        color: "var(--text-muted)",
                        fontSize: "11px",
                        marginTop: "2px",
                        fontFamily: "monospace"
                    }}>
                        ID: {userId}
                    </div>
                    {extraInfo && (
                        <div style={{ 
                            color: "var(--text-muted)",
                            fontSize: "11px",
                            marginTop: "2px"
                        }}>
                            {extraInfo}
                        </div>
                    )}
                    {voiceChannel && (
                        <div style={{ 
                            color: "var(--text-muted)",
                            fontSize: "11px",
                            marginTop: "2px"
                        }}>
                            📢 {voiceChannel}
                        </div>
                    )}
                </div>
                <div style={{ display: "flex", gap: "5px", flexShrink: 0 }}>
                    <button
                        onClick={() => {
                            if (isPulled(userId)) {
                                removeFromPullList(userId);
                            } else {
                                addToPullList(userId);
                            }
                            setRefreshKey(k => k + 1);
                        }}
                        style={{
                            padding: "6px 10px",
                            backgroundColor: isPulled(userId) ? "var(--button-danger-background)" : "var(--button-secondary-background)",
                            color: isPulled(userId) ? "var(--white)" : "var(--text-normal)",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                            fontSize: "12px",
                            transition: "all 0.2s",
                            whiteSpace: "nowrap"
                        }}
                    >
                        {isPulled(userId) ? "❌ Remove" : "✅ Add"}
                    </button>
                    {myChannelId && guildId && (
                        <button
                            onClick={() => {
                                pullUserInstant(guildId, userId, myChannelId);
                                setRefreshKey(k => k + 1);
                            }}
                            style={{
                                padding: "6px 10px",
                                backgroundColor: "var(--button-secondary-background)",
                                color: "var(--text-normal)",
                                border: "none",
                                borderRadius: "4px",
                                cursor: "pointer",
                                fontSize: "12px",
                                whiteSpace: "nowrap"
                            }}
                        >
                            🎯 Pull
                        </button>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div style={{ maxHeight: "500px", overflowY: "auto" }}>
            {!myChannelId && (
                <div style={{ 
                    padding: "10px", 
                    marginBottom: "10px",
                    backgroundColor: "var(--background-warning)",
                    color: "var(--text-warning)",
                    borderRadius: "4px",
                    fontSize: "13px"
                }}>
                    ⚠️ You are not in a voice channel. Pull functionality is disabled.
                </div>
            )}

            {/* Search Bar */}
            <div style={{ marginBottom: "15px" }}>
                <input
                    type="text"
                    placeholder="🔍 Search by name, @username, or ID..."
                    value={searchTerm}
                    onChange={(e) => {
                        setSearchTerm(e.target.value);
                        if (e.target.value) {
                            setActiveTab("search");
                        }
                    }}
                    style={{
                        width: "100%",
                        padding: "10px",
                        backgroundColor: "var(--background-secondary)",
                        border: "1px solid var(--background-tertiary)",
                        borderRadius: "8px",
                        color: "var(--text-normal)",
                        fontSize: "14px",
                        outline: "none",
                        boxSizing: "border-box",
                        transition: "border-color 0.2s"
                    }}
                    onFocus={(e) => {
                        e.target.style.borderColor = "var(--text-link)";
                    }}
                    onBlur={(e) => {
                        e.target.style.borderColor = "var(--background-tertiary)";
                    }}
                />
                {searchTerm && (
                    <div style={{ 
                        marginTop: "5px", 
                        fontSize: "12px", 
                        color: "var(--text-muted)" 
                    }}>
                        Searching by: name, @username, or ID
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div style={{ 
                display: "flex", 
                gap: "10px", 
                marginBottom: "15px",
                borderBottom: "1px solid var(--background-tertiary)",
                paddingBottom: "10px",
                flexWrap: "wrap"
            }}>
                <button
                    onClick={() => setActiveTab("search")}
                    style={{
                        padding: "8px 12px",
                        backgroundColor: activeTab === "search" ? "var(--button-primary-background)" : "transparent",
                        color: activeTab === "search" ? "var(--white)" : "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        transition: "all 0.2s"
                    }}
                >
                    🔍 Search
                </button>
                <button
                    onClick={() => setActiveTab("friends")}
                    style={{
                        padding: "8px 12px",
                        backgroundColor: activeTab === "friends" ? "var(--button-primary-background)" : "transparent",
                        color: activeTab === "friends" ? "var(--white)" : "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        transition: "all 0.2s"
                    }}
                >
                    👥 Friends ({friends.length})
                </button>
                <button
                    onClick={() => setActiveTab("voice")}
                    style={{
                        padding: "8px 12px",
                        backgroundColor: activeTab === "voice" ? "var(--button-primary-background)" : "transparent",
                        color: activeTab === "voice" ? "var(--white)" : "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        transition: "all 0.2s"
                    }}
                >
                    🔊 Voice ({voiceUsers.length})
                </button>
                <button
                    onClick={() => setActiveTab("recent")}
                    style={{
                        padding: "8px 12px",
                        backgroundColor: activeTab === "recent" ? "var(--button-primary-background)" : "transparent",
                        color: activeTab === "recent" ? "var(--white)" : "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        transition: "all 0.2s"
                    }}
                >
                    🕒 Recent ({recentPulls.length})
                </button>
            </div>

            {/* Quick Actions */}
            <div style={{ 
                display: "flex", 
                gap: "10px", 
                marginBottom: "15px",
                flexWrap: "wrap"
            }}>
                <button
                    onClick={handleManualAdd}
                    style={{
                        padding: "8px 12px",
                        backgroundColor: "var(--button-secondary-background)",
                        color: "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        flex: "1",
                        minWidth: "120px"
                    }}
                >
                    ➕ Add by ID
                </button>
                <button
                    onClick={handleManualPull}
                    style={{
                        padding: "8px 12px",
                        backgroundColor: "var(--button-secondary-background)",
                        color: "var(--text-normal)",
                        border: "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                        flex: "1",
                        minWidth: "120px"
                    }}
                >
                    🎯 Pull by ID
                </button>
            </div>

            {/* Content Area */}
            <div style={{ marginBottom: "15px" }}>
                {activeTab === "search" && searchTerm && (
                    <>
                        <h3 style={{ 
                            margin: "0 0 10px 0", 
                            color: "var(--text-normal)",
                            fontSize: "14px",
                            fontWeight: "bold"
                        }}>
                            Search Results ({searchResults.length})
                        </h3>
                        <div style={{ 
                            backgroundColor: "var(--background-secondary)", 
                            padding: "10px", 
                            borderRadius: "8px",
                            maxHeight: "250px",
                            overflowY: "auto"
                        }}>
                            {searchResults.length > 0 ? (
                                searchResults.map(user => 
                                    renderUserCard(
                                        user.id, 
                                        user.username, 
                                        user.globalName,
                                        user.isFriend ? '👥 Friend' : undefined
                                    )
                                )
                            ) : (
                                <div style={{ 
                                    textAlign: "center", 
                                    color: "var(--text-muted)",
                                    padding: "20px"
                                }}>
                                    No users found matching "{searchTerm}"
                                </div>
                            )}
                        </div>
                    </>
                )}

                {activeTab === "friends" && (
                    <>
                        <h3 style={{ 
                            margin: "0 0 10px 0", 
                            color: "var(--text-normal)",
                            fontSize: "14px",
                            fontWeight: "bold"
                        }}>
                            Your Friends ({friends.length})
                        </h3>
                        <div style={{ 
                            backgroundColor: "var(--background-secondary)", 
                            padding: "10px", 
                            borderRadius: "8px",
                            maxHeight: "250px",
                            overflowY: "auto"
                        }}>
                            {friends.length > 0 ? (
                                friends
                                    .filter(friend => {
                                        if (!searchTerm) return true;
                                        const searchLower = searchTerm.toLowerCase();
                                        return friend.username.toLowerCase().includes(searchLower) ||
                                               friend.globalName.toLowerCase().includes(searchLower) ||
                                               friend.id.includes(searchTerm);
                                    })
                                    .map(friend => 
                                        renderUserCard(
                                            friend.id, 
                                            friend.username, 
                                            friend.globalName
                                        )
                                    )
                            ) : (
                                <div style={{ 
                                    textAlign: "center", 
                                    color: "var(--text-muted)",
                                    padding: "20px"
                                }}>
                                    No friends found
                                </div>
                            )}
                        </div>
                    </>
                )}

                {activeTab === "voice" && (
                    <>
                        <h3 style={{ 
                            margin: "0 0 10px 0", 
                            color: "var(--text-normal)",
                            fontSize: "14px",
                            fontWeight: "bold"
                        }}>
                            Users in Voice Channels ({voiceUsers.length})
                        </h3>
                        <div style={{ 
                            backgroundColor: "var(--background-secondary)", 
                            padding: "10px", 
                            borderRadius: "8px",
                            maxHeight: "250px",
                            overflowY: "auto"
                        }}>
                            {voiceUsers.length > 0 ? (
                                voiceUsers
                                    .filter(user => {
                                        if (!searchTerm) return true;
                                        const searchLower = searchTerm.toLowerCase();
                                        return user.username.toLowerCase().includes(searchLower) ||
                                               user.globalName.toLowerCase().includes(searchLower) ||
                                               user.id.includes(searchTerm);
                                    })
                                    .map(user => 
                                        renderUserCard(
                                            user.id, 
                                            user.username, 
                                            user.globalName,
                                            `Channel: ${user.channelName}`
                                        )
                                    )
                            ) : (
                                <div style={{ 
                                    textAlign: "center", 
                                    color: "var(--text-muted)",
                                    padding: "20px"
                                }}>
                                    No users in voice channels
                                </div>
                            )}
                        </div>
                    </>
                )}

                {activeTab === "recent" && (
                    <>
                        <h3 style={{ 
                            margin: "0 0 10px 0", 
                            color: "var(--text-normal)",
                            fontSize: "14px",
                            fontWeight: "bold"
                        }}>
                            Recently Pulled ({recentPulls.length})
                        </h3>
                        <div style={{ 
                            backgroundColor: "var(--background-secondary)", 
                            padding: "10px", 
                            borderRadius: "8px",
                            maxHeight: "250px",
                            overflowY: "auto"
                        }}>
                            {recentPulls.length > 0 ? (
                                recentPulls
                                    .filter(pull => {
                                        if (!searchTerm) return true;
                                        const searchLower = searchTerm.toLowerCase();
                                        return pull.username.toLowerCase().includes(searchLower) ||
                                               pull.globalName.toLowerCase().includes(searchLower) ||
                                               pull.userId.includes(searchTerm);
                                    })
                                    .map(pull => {
                                        const timeAgo = Math.floor((Date.now() - pull.timestamp) / 60000);
                                        const timeText = timeAgo < 1 ? "Just now" : 
                                                       timeAgo < 60 ? `${timeAgo} min ago` : 
                                                       `${Math.floor(timeAgo / 60)} hr ago`;
                                        
                                        return renderUserCard(
                                            pull.userId, 
                                            pull.username, 
                                            pull.globalName,
                                            `🕒 Pulled ${timeText}`
                                        );
                                    })
                            ) : (
                                <div style={{ 
                                    textAlign: "center", 
                                    color: "var(--text-muted)",
                                    padding: "20px"
                                }}>
                                    No recent pulls
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Current Pull List */}
            <div>
                <h3 style={{ 
                    margin: "0 0 10px 0", 
                    color: "var(--text-normal)",
                    fontSize: "14px",
                    fontWeight: "bold"
                }}>
                    Current Pull List ({pullList.length})
                </h3>
                <div style={{ 
                    backgroundColor: "var(--background-secondary)", 
                    padding: "10px", 
                    borderRadius: "8px",
                    maxHeight: "150px",
                    overflowY: "auto"
                }}>
                    {pullList.length > 0 ? pullList.map(id => {
                        const userInfo = getUserInfo(id);
                        return (
                            <div key={id} style={{ 
                                display: "flex", 
                                justifyContent: "space-between", 
                                alignItems: "center",
                                padding: "8px",
                                backgroundColor: "var(--background-primary)",
                                borderRadius: "4px",
                                marginBottom: "3px"
                            }}>
                                <div>
                                    <span style={{ 
                                        color: "var(--text-normal)",
                                        fontWeight: "bold"
                                    }}>
                                        {userInfo.globalName}
                                    </span>
                                    <span style={{ 
                                        color: "var(--text-muted)",
                                        marginLeft: "8px",
                                        fontSize: "12px"
                                    }}>
                                        @{userInfo.username}
                                    </span>
                                </div>
                                <button
                                    onClick={() => {
                                        removeFromPullList(id);
                                        setRefreshKey(k => k + 1);
                                    }}
                                    style={{
                                        backgroundColor: "transparent",
                                        border: "none",
                                        color: "var(--text-danger)",
                                        cursor: "pointer",
                                        fontSize: "18px",
                                        padding: "0 5px"
                                    }}
                                >
                                    ×
                                </button>
                            </div>
                        );
                    }) : (
                        <div style={{ 
                            textAlign: "center", 
                            color: "var(--text-muted)",
                            fontSize: "14px"
                        }}>
                            Pull list is empty
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function showGUI() {
    Alerts.show({
        title: "🎯 Pull User Manager",
        body: <PullUserManager />,
        confirmText: "Close",
        cancelText: null as any,
        className: "pull-user-modal"
    });
}

const UserContext: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user || user.id === UserStore.getCurrentUser().id) return;

    const pulled = isPulled(user.id);

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            {settings.store.enableGUI && (
                <Menu.MenuItem
                    id="open-gui"
                    label="🎯 Open Pull User Manager"
                    action={() => showGUI()}
                />
            )}
            <Menu.MenuItem
                id="pull-user"
                label={pulled ? "Remove from Pull List" : "Pull User"}
                color={pulled ? "danger" : undefined}
                action={() => {
                    if (pulled) {
                        Alerts.show({
                            title: "Remove from Pull List",
                            body: `Are you sure you want to remove ${user.username} from the pull list?`,
                            confirmText: "Remove",
                            cancelText: "Cancel",
                            confirmColor: "red",
                            onConfirm: () => removeFromPullList(user.id)
                        });
                    } else {
                        addToPullList(user.id);
                    }
                }}
            />
        </Menu.MenuGroup>
    ));
};

const ChannelContext: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || channel.type !== 2 || !channel.guild_id) return;

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            {settings.store.enableGUI && (
                <Menu.MenuItem
                    id="open-gui"
                    label="🎯 Open Pull User Manager"
                    action={() => showGUI()}
                />
            )}
        </Menu.MenuGroup>
    ));

    if (pullList.length === 0) return;

    const items = pullList.map(userId => {
        const user = UserStore.getUser(userId);
        const name = user?.username || userId;

        return (
            <Menu.MenuItem
                key={userId}
                id={`pull-${userId}`}
                label={name}
                color="danger"
                action={() => {
                    Alerts.show({
                        title: "Remove from Pull List",
                        body: `Are you sure you want to remove ${name} from the pull list?`,
                        confirmText: "Remove",
                        cancelText: "Cancel",
                        confirmColor: "red",
                        onConfirm: () => removeFromPullList(userId)
                    });
                }}
            />
        );
    });

    items.push(<Menu.MenuSeparator key="sep" />);
    items.push(
        <Menu.MenuItem
            key="rm-all"
            id="rm-all"
            label="Remove All"
            color="danger"
            action={() => {
                Alerts.show({
                    title: "Remove All Users",
                    body: `Are you sure you want to remove all ${pullList.length} users from the pull list?`,
                    confirmText: "Remove All",
                    cancelText: "Cancel",
                    confirmColor: "red",
                    onConfirm: () => {
                        pullList = [];
                        console.log("[PullUser] Cleared pull list");
                    }
                });
            }}
        />
    );

    children.splice(-1, 0, (
        <Menu.MenuGroup>
            <Menu.MenuItem id="pull-list" label="Pull List">
                {items}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    ));
};

export default definePlugin({
    name: "PullUser",
    description: "Drag users with you across voice channels. Right-click users to add them to your pull list - they'll automatically follow you whenever you switch voice channels.",
    authors: [Devs.Him],
    settings,

    start() {
        console.log("[PullUser] Starting");
        lastMyChannelId = getMyChannelId();
        startMonitoring();
    },

    stop() {
        console.log("[PullUser] Stopping");
        stopMonitoring();
        pullList = [];
        lastMyChannelId = null;
        pullCache.clear();
        recentPulls = [];
    },

    contextMenus: {
        "user-context": UserContext,
        "channel-context": ChannelContext
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[] }) {
            if (!voiceStates || voiceStates.length === 0) return;

            const myId = UserStore.getCurrentUser()?.id;
            if (!myId) return;

            for (const state of voiceStates) {
                if (state.userId === myId) {
                    const newChannel = state.channelId;

                    if (newChannel && newChannel !== lastMyChannelId) {
                        console.log("[PullUser] Flux detected move to:", newChannel);
                        lastMyChannelId = newChannel;
                        monitorAndPull();
                    } else if (!newChannel) {
                        lastMyChannelId = null;
                    }
                    break;
                }
            }
        }
    }
});