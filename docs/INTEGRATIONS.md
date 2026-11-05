# Connecting integrations

All of these are optional and off until you turn them on under **Integrations**. Use **Test** after connecting. It only reads, and changes nothing. FlowState changes only your own status, Do Not Disturb and calendar, and never posts to channels.

## Linux (GNOME)

Nothing to set up. FlowState turns off notification banners during focus and puts your previous setting back afterwards. Other desktops, including KDE, are not supported yet, and FlowState says so.

## macOS

Create two shortcuts in the Shortcuts app, named exactly:

- `FlowState On`: uses **Set Focus** to turn on the Focus mode you want
- `FlowState Off`: uses **Set Focus** to turn it off

## Windows

Windows has no supported way for apps to turn on Do Not Disturb, so turn it on yourself from the notification area.

## Slack

Use a test workspace first. Create your own Slack app at https://api.slack.com/apps, under **From a manifest**:

```yaml
display_information:
  name: FlowState
oauth_config:
  scopes:
    user:
      - dnd:write
      - users.profile:read
      - users.profile:write
```

Install it to your workspace, then copy the **User OAuth Token** (it starts with `xoxp-`) into FlowState. It is stored in your OS keychain.

## Google Calendar

1. In https://console.cloud.google.com, create a project and enable the **Google Calendar API**.
2. Set up the OAuth consent screen, and add yourself as a test user.
3. Create an **OAuth client ID** of type **Desktop app**.
4. Paste the client ID and secret into FlowState, and click **Sign in with Google**.

FlowState asks only for permission to manage calendar events. It adds one "Focus time (FlowState)" block to your primary calendar and ends it when focus ends.
