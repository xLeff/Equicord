# Follow Me — Equicord

**Follow Me** is a private Equicord user plugin that moves selected Discord members into the voice channel occupied by the current user. The behavior is enabled per user from the Discord user context menu and continues until that user is removed from the list.

## Features

| Feature | Behavior |
|---|---|
| Select a member | Open a member’s context menu and choose `Move <user> with me`. The user ID is stored locally in the plugin settings. |
| Automatic movement | When the current user joins or moves to another server voice channel, the plugin attempts to move each selected member into that channel. |
| Immediate movement | If the leader is already in a voice channel when a member is selected, the plugin immediately attempts to move that member into the leader’s current channel. |
| Permission safety | The plugin checks the source and destination channel permissions and reports failures without bypassing Discord permissions. Equicord may also be rejected by Discord based on role hierarchy or other server rules. |
| Multiple members | Several user IDs can be selected. Each member is moved independently. |
| Stop moving a member | Open that member’s context menu again and choose `Stop moving <user> with me`. |
| Disconnect on leave | An optional setting disconnects selected members when the current user leaves voice. |
| Manual switch | Equicord Toolbox contains a `Follow Me: Move selected members with me` checkbox. |
| Local storage | The selected-user list is kept in Equicord’s local settings store. This plugin does not use an external service or bot token. |

## Permissions and limitations

The current account must have **Move Members** and **Connect** permission for the relevant voice channels. The target member must already be connected to a server voice channel, and the leader and target channels must belong to the same server. The plugin does not move members in direct messages or group calls, does not bypass permissions, and does not change another user’s account settings.

Discord’s official API documentation describes moving a guild member by updating the member’s `channel_id`. The endpoint requires the caller to have permission to connect to both channels and the `MOVE_MEMBERS` permission. The plugin uses Equicord’s authenticated client request layer to perform the same server operation, rather than a bot token.

This is a **local client plugin** and an unofficial Discord client modification. It can only move members in servers where the current user is authorized to do so. Discord or Equicord can change internal client behavior or rate limits, so the plugin should be rebuilt against the same Equicord checkout where it is installed.

## Installation in Equicord

Equicord’s documentation states that private plugins belong in `src/userplugins`, with one folder and an `index.ts` or `index.tsx` entry file. Copy the `index.tsx` file into a folder named `followMe` under your Equicord source directory:

```text
Equicord/
└── src/
    └── userplugins/
        └── followMe/
            └── index.tsx
```

From the Equicord repository root, install dependencies if needed and rebuild:

```bash
pnpm install
pnpm build
```

If Equicord has not been injected into Discord yet, run:

```bash
pnpm inject
```

Restart Discord after the build. Open **Settings → Equicord → Plugins**, search for **FollowMe**, and enable it. Equicord’s official custom-plugin instructions are available at [docs.equicord.org/plugins](https://docs.equicord.org/plugins).

## Configuration and usage

The plugin settings are available in Equicord’s plugin settings panel. `Followed users` accepts Discord user IDs separated by commas or new lines, but the user-context menu action is the easier way to manage the list.

The default settings enable automatic movement and notifications. `Disconnect followed members when you leave voice` is disabled by default; enable it if selected members should be disconnected when you leave your current voice channel.

To start, join a server voice channel, right-click the target member, and choose **Move [name] with me**. When you move to another voice channel in the same server, Equicord attempts to move the selected member as well. To stop, right-click the member and choose **Stop moving [name] with me**.

## Verification

The plugin was checked against an Equicord source checkout with TypeScript, ESLint, and a standalone Equicord build. The delivered package contains only the plugin folder and this README.

## License

This plugin is released under the GNU General Public License v3.0 or later, consistent with Equicord and Vencord plugin license headers.
