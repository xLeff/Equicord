/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, User } from "@vencord/discord-types";
import {
    AuthenticationStore,
    ChannelStore,
    GuildMemberStore,
    Menu,
    PermissionsBits,
    PermissionStore,
    RestAPI,
    SelectedChannelStore,
    showToast,
    Toasts,
    UserStore,
    VoiceStateStore
} from "@webpack/common";

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Automatically move followed members into your current voice channel",
        default: true
    },
    followedUsers: {
        type: OptionType.STRING,
        description: "User IDs to move with you, separated by commas or new lines",
        default: "",
        multiline: true,
        placeholder: "Paste one Discord user ID per line"
    },
    disconnectTargetsWhenLeaving: {
        type: OptionType.BOOLEAN,
        description: "Disconnect followed members when you leave voice",
        default: false
    },
    showNotifications: {
        type: OptionType.BOOLEAN,
        description: "Show a notification after moving a followed member",
        default: true
    }
});

interface VoiceStateChange {
    userId: string;
    channelId?: string | null;
    oldChannelId?: string | null;
    sessionId?: string;
}

interface UserContextProps {
    user?: User;
    channel?: Channel;
}

const movingUserIds = new Set<string>();
let lastLeaderChannelId: string | null = null;

function parseUserIds(value: string): string[] {
    return [...new Set(value.split(/[\s,]+/).map(id => id.trim()).filter(Boolean))];
}

function getFollowedUserIds(): string[] {
    return parseUserIds(settings.store.followedUsers);
}

function setFollowedUserIds(userIds: string[]) {
    settings.store.followedUsers = [...new Set(userIds)].join("\n");
}

function getUserLabel(userId: string): string {
    const user = UserStore.getUser(userId);
    return user?.globalName ?? user?.username ?? userId;
}

function notify(message: string, type = Toasts.Type.MESSAGE) {
    if (settings.store.showNotifications) showToast(message, type);
}

function getVoiceChannelId(userId: string): string | null {
    return VoiceStateStore.getVoiceStateForUser(userId)?.channelId ?? null;
}

function canMoveBetweenChannels(sourceChannel: Channel, destinationChannel?: Channel): boolean {
    if (!sourceChannel.guild_id) return false;
    if (!PermissionStore.can(PermissionsBits.MOVE_MEMBERS, sourceChannel)) return false;
    if (!PermissionStore.can(PermissionsBits.CONNECT, sourceChannel)) return false;
    return destinationChannel == null || PermissionStore.can(PermissionsBits.CONNECT, destinationChannel);
}

async function moveMemberToChannel(userId: string, destinationChannelId: string | null, leaderChannel: Channel) {
    if (movingUserIds.has(userId)) return;

    const targetChannelId = getVoiceChannelId(userId);
    if (!targetChannelId || targetChannelId === destinationChannelId) return;

    const targetChannel = ChannelStore.getChannel(targetChannelId);
    const destinationChannel = destinationChannelId == null ? undefined : ChannelStore.getChannel(destinationChannelId);
    if (!targetChannel || !leaderChannel.guild_id || targetChannel.guild_id !== leaderChannel.guild_id) return;
    if (destinationChannelId != null && (!destinationChannel || destinationChannel.guild_id !== leaderChannel.guild_id)) return;
    if (!GuildMemberStore.isMember(leaderChannel.guild_id, userId)) return;

    if (!canMoveBetweenChannels(targetChannel, destinationChannel)) {
        notify(`You do not have permission to move ${getUserLabel(userId)}.`, Toasts.Type.FAILURE);
        return;
    }

    movingUserIds.add(userId);
    try {
        await RestAPI.patch({
            url: `/guilds/${leaderChannel.guild_id}/members/${userId}`,
            body: { channel_id: destinationChannelId }
        });

        if (destinationChannelId == null) {
            notify(`${getUserLabel(userId)} was disconnected.`);
        } else {
            notify(`${getUserLabel(userId)} was moved to ${destinationChannel?.name ?? "your voice channel"}.`);
        }
    } catch {
        notify(`Discord rejected moving ${getUserLabel(userId)}. Check Move Members and channel permissions.`, Toasts.Type.FAILURE);
    } finally {
        movingUserIds.delete(userId);
    }
}

async function moveFollowedUsers(destinationChannelId: string | null, oldChannelId?: string | null) {
    const followedIds = getFollowedUserIds();
    if (followedIds.length === 0) return;

    const leaderChannelId = destinationChannelId ?? oldChannelId;
    if (!leaderChannelId) return;

    const leaderChannel = ChannelStore.getChannel(leaderChannelId);
    if (!leaderChannel || !leaderChannel.guild_id) return;

    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!currentUserId) return;

    await Promise.all(followedIds.map(userId => {
        if (userId === currentUserId) return Promise.resolve();
        return moveMemberToChannel(
            userId,
            destinationChannelId,
            leaderChannel
        );
    }));
}

const userContextMenuPatch: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    if (!user || user.id === UserStore.getCurrentUser()?.id) return;

    const followedIds = getFollowedUserIds();
    const isFollowed = followedIds.includes(user.id);

    children.push(
        <Menu.MenuItem
            id="follow-me-user-toggle"
            label={isFollowed ? `Stop moving ${getUserLabel(user.id)} with me` : `Move ${getUserLabel(user.id)} with me`}
            action={() => {
                const currentIds = getFollowedUserIds();
                if (currentIds.includes(user.id)) {
                    setFollowedUserIds(currentIds.filter(id => id !== user.id));
                    notify(`Stopped moving ${getUserLabel(user.id)} with you.`);
                } else {
                    setFollowedUserIds([...currentIds, user.id]);
                    notify(`${getUserLabel(user.id)} will now move with you.`);

                    const leaderChannelId = SelectedChannelStore.getVoiceChannelId();
                    const leaderChannel = leaderChannelId == null ? undefined : ChannelStore.getChannel(leaderChannelId);
                    if (leaderChannelId && leaderChannel) void moveMemberToChannel(user.id, leaderChannelId, leaderChannel);
                }
            }}
        />
    );
};

export default definePlugin({
    name: "FollowMe",
    description: "Automatically move selected members into the voice channel you join.",
    tags: ["Voice", "Friends", "Utility"],
    authors: [Devs.Him],
    settings,

    start() {
        lastLeaderChannelId = SelectedChannelStore.getVoiceChannelId() ?? null;
    },

    stop() {
        movingUserIds.clear();
        lastLeaderChannelId = null;
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateChange[] }) {
            if (!settings.store.enabled) return;

            const currentUserId = UserStore.getCurrentUser()?.id;
            if (!currentUserId) return;

            const currentSessionId = AuthenticationStore.getSessionId();
            const leaderState = voiceStates.find(state =>
                state.userId === currentUserId &&
                (!state.sessionId || !currentSessionId || state.sessionId === currentSessionId)
            );
            if (!leaderState) return;

            const destinationChannelId = leaderState.channelId ?? null;
            if (destinationChannelId === lastLeaderChannelId) return;
            lastLeaderChannelId = destinationChannelId;

            if (!destinationChannelId && !settings.store.disconnectTargetsWhenLeaving) return;
            void moveFollowedUsers(destinationChannelId, leaderState.oldChannelId);
        }
    },

    toolboxActions() {
        const isEnabled = settings.store.enabled;

        return (
            <Menu.MenuCheckboxItem
                id="follow-me-toolbox-toggle"
                label="Follow Me: Move selected members with me"
                checked={isEnabled}
                action={() => {
                    settings.store.enabled = !isEnabled;
                    notify(settings.store.enabled ? "Follow Me enabled." : "Follow Me disabled.");
                }}
            />
        );
    },

    contextMenus: {
        "user-context": userContextMenuPatch
    }
});
