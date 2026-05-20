# Commander Clock

Turn timer for 4–5 player Magic: The Gathering Commander games. Plays on one
phone passed around, or networked across the pod with everyone on their own
phone.

## What you need

- A laptop (any OS — Windows, Mac, Linux)
- Node.js installed: https://nodejs.org (any v18+ works, "LTS" is fine)
- Home wifi that all phones and the laptop can join
- Phones with a modern browser (Safari on iPhone, Chrome on Android)

You only need internet for the *initial* phone-to-phone handshake. The
gameplay data flows directly between phones on your local wifi.

## First-time setup (do this once)

Open a terminal (Terminal.app on Mac, PowerShell on Windows) in this
folder and run:

```
npm install
```

This downloads the dependencies. Takes ~30 seconds.

## Every game night

1. Bring your laptop. Connect it to the home wifi.
2. Open a terminal in this folder and run:

   ```
   npm run dev
   ```

3. Vite prints two URLs. Look at the **Network** one — it'll look like:

   ```
   ➜  Local:   http://localhost:5173/
   ➜  Network: http://192.168.1.42:5173/      ← this one
   ```

4. On the host phone (yours), open the Network URL in the browser.
   Tap **Host a Room**. Set up player names, then start the game.
5. Other players scan the QR code with their phone camera (or visit the
   Network URL and type the 4-letter room code). They pick their seat
   by name from the list, and the game is on.

When you're done, hit `Ctrl+C` in the terminal to stop the server,
close the laptop, you're out.

## Troubleshooting

**`npm audit` shows 2 moderate vulnerabilities.**
These are in Vite's dev-server-only `esbuild` dependency. They don't
affect the production build that runs on phones. **Do not run
`npm audit fix --force`** — it upgrades Vite to v6/v7 which prints
a wall of deprecation warnings and isn't needed for this project.
If you've already done it and want to revert, run:

```
npm install vite@5.4.20 @vitejs/plugin-react@4.3.4 --save-dev --save-exact
```

**"Network: not shown" — only Local appears.**
Your firewall is probably blocking the port. On Windows allow Node.js
through Windows Defender Firewall when prompted. On macOS, System
Settings → Network → Firewall → allow incoming connections for Node.

**Phones can't reach the Network URL.**
Make sure the laptop and phones are on the *same* wifi network — many
homes have a separate "guest" network. Both devices need to be on the
same one.

**"Couldn't reach signaling server" on a phone.**
The phone needs internet for the initial PeerJS handshake. Check the
phone's wifi.

**The host phone's battery dies mid-game.**
Game ends. Open a new room from any phone, names will need to be
re-entered. (Persistent state is a future feature — kept simple for
now.)

## One-phone mode

Don't want to bother with the laptop? Pick **One Phone** from the
opening screen instead. Pass the device clockwise as turns end.
This mode works without the laptop too — you can build a static
version with `npm run build`, then put the `dist/` folder anywhere
that serves files. But honestly, just use `npm run dev`.
