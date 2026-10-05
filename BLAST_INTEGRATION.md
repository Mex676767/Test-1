# LiveChat Blast

The **Blast** tab is available in the widget and standalone preview.

## Why it uses agent authorization

The existing `LIVECHAT_PAT` and `LIVECHAT_PAT_2` credentials belong to their
token owners. Sending through either PAT would attribute messages to that
owner. The Blast tab therefore uses the shared PATs only to resolve archive
links. Reopening chats, sending messages/files, and closing chats use a
temporary OAuth token belonging to the CS agent who clicked **Connect
LiveChat**.

The token is stored in `sessionStorage`, so an incognito session removes it
when that browser session closes.

## One-time setup

1. In the existing app's LiveChat Developer Console, add or open the App
   Authorization building block.
2. Use the JavaScript/implicit flow and add the `chats--access:rw` scope.
   This lets a normal agent work only with chats in groups they can access.
3. Add this redirect URI (replace the host if the production host differs):

   `https://test-1-7wp.pages.dev/blast/oauth.html`

4. Copy the Authorization block's Client ID.
5. In Cloudflare Pages, add `LIVECHAT_CLIENT_ID` with account 1's Client ID.
   When a second, completely separate LiveChat license has its own Developer
   Console app, repeat the setup there and add its Client ID as
   `LIVECHAT_CLIENT_ID_2`.
6. Add `/blast/oauth.html` as an allowed redirect on both OAuth clients, then
   redeploy.

The app uses `https://test-1-7wp.pages.dev/blast/oauth.html` as its canonical
callback even when the preview is opened through a Cloudflare deployment
alias. To use another permanent domain, set `LIVECHAT_REDIRECT_URI` to the
exact URI registered in both Developer Console apps.

## Agent flow

1. Open the standalone admin preview and select **Blast**.
2. Click **Connect LiveChat** and sign in as the CS agent who should receive
   KPI credit.
3. Add archive links and messages manually, or use **Bulk Import**.
4. Review the queue and start it. A separate **Blast delivery** window opens.
   Keep it open until delivery finishes; the LiveChat widget can be reloaded
   or switched between chats without destroying the running queue. Allow
   pop-ups if the browser blocks this window. Each archived chat is reopened, messages
   and an optional image are sent as the connected agent, and chats reopened
   by the tool are closed again.

The shared admin PAT never authors a blast message.

The widget monitors the delivery window and can pause, resume, or stop it.
Use **Open Blast window** to bring the running queue back into view. Queue
progress is saved locally; the OAuth token stays in session storage and is
passed only to the same-origin delivery window. Closing that window stops
delivery. An interrupted queue is never automatically replayed, because an
interrupted send may already have reached a customer.
