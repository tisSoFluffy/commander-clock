import React, { useState, useEffect, useRef, useCallback } from "react";
import { Peer } from "peerjs";
import QRCode from "qrcode";

/* ──────────────────────────────────────────────────────────────
   Commander Pod Clock — Networked
   Host runs canonical state. Peers connect via PeerJS using a
   short room code (also encoded as a QR). Host is a player.
   Joiners claim a pre-assigned named seat from a list.

   Topology: star. Host validates intents and broadcasts state.
   Peers send {type: "claim" | "pass" | "think-toggle"}.

   Network note: PeerJS uses a public signaling broker to do the
   WebRTC handshake. Initial connect needs internet; gameplay does
   not (data flows direct over LAN).
   ────────────────────────────────────────────────────────────── */

const SEAT_COLORS = [
  { name: "Plains", ink: "#e8dcc0", glow: "#f5e9c8", bg: "#3a3322" },
  { name: "Island", ink: "#7ec4e8", glow: "#a8dcf5", bg: "#1c2e3a" },
  { name: "Swamp", ink: "#b59ad6", glow: "#c9b3e8", bg: "#2a2435" },
  { name: "Mountain", ink: "#e89a82", glow: "#f5b7a3", bg: "#3a2420" },
  { name: "Forest", ink: "#8fc99a", glow: "#aadcb3", bg: "#21321f" },
];

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O — unambiguous
const newRoomCode = () =>
  Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const peerIdFor = (room) => `cmdr-clock-${room.toLowerCase()}`;

function fmt(ms) {
  const neg = ms < 0;
  const t = Math.abs(ms);
  const s = Math.floor(t / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const core =
    h > 0
      ? `${h}:${String(mm).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  return (neg ? "-" : "") + core;
}

const makePlayers = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `Seat ${i + 1}`,
    elapsed: 0,
    turns: 0,
    eliminated: false,
    claimedBy: null,
    life: 40,
  }));

/* ── error boundary so bugs surface visibly, not as black screen ── */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Commander Clock crashed:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "#e8dcc0", fontFamily: "monospace" }}>
          <h2 style={{ color: "#e87a5a" }}>Something broke</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); }}
            style={{ marginTop: 12, padding: "10px 16px" }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── root ─────────────────────────────────────────────────── */
export default function CommanderClock() {
  const [role, setRole] = useState(null); // null | "solo" | "host" | "joiner"
  const [joinCode, setJoinCode] = useState("");

  useEffect(() => {
    const url = new URL(window.location.href);
    const room = url.searchParams.get("room");
    if (room && /^[A-Z]{4}$/i.test(room)) {
      setJoinCode(room.toUpperCase());
      setRole("joiner");
    }
  }, []);

  return (
    <ErrorBoundary>
      <div style={S.root}>
        <style>{CSS}</style>
        {!role && <RolePicker onPick={setRole} setJoinCode={setJoinCode} />}
        {(role === "solo" || role === "host") && (
          <SoloOrHostApp mode={role} onExit={() => setRole(null)} />
        )}
        {role === "joiner" && (
          <JoinerApp initialCode={joinCode} onExit={() => setRole(null)} />
        )}
      </div>
    </ErrorBoundary>
  );
}

/* ── role picker ──────────────────────────────────────────── */
function RolePicker({ onPick, setJoinCode }) {
  const [code, setCode] = useState("");
  return (
    <div className="cc-setup">
      <header className="cc-head">
        <div className="cc-pip" />
        <h1>Commander Clock</h1>
        <p className="cc-sub">Turn timer for the pod</p>
      </header>

      <section className="cc-card">
        <label className="cc-label">Start a game</label>
        <div className="cc-rolebtns">
          <button className="cc-rolebtn" onClick={() => onPick("solo")}>
            <div className="cc-roletitle">One Phone</div>
            <div className="cc-roledesc">Pass the device around the table</div>
          </button>
          <button className="cc-rolebtn" onClick={() => onPick("host")}>
            <div className="cc-roletitle">Host a Room</div>
            <div className="cc-roledesc">Everyone joins from their own phone</div>
          </button>
        </div>
      </section>

      <section className="cc-card">
        <label className="cc-label">Join an existing room</label>
        <div className="cc-joinrow">
          <input
            className="cc-input cc-code"
            value={code}
            placeholder="ABCD"
            maxLength={4}
            onChange={(e) =>
              setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))
            }
          />
          <button
            className="cc-segbtn on"
            disabled={code.length !== 4}
            onClick={() => {
              setJoinCode(code);
              onPick("joiner");
            }}
            style={{ flex: "0 0 auto", padding: "14px 22px" }}
          >
            Join
          </button>
        </div>
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Solo / Host app
   ────────────────────────────────────────────────────────────── */
function SoloOrHostApp({ mode, onExit }) {
  const [stage, setStage] = useState("setup");
  const [playerCount, setPlayerCount] = useState(4);
  const [players, setPlayers] = useState(() => makePlayers(4));
  const [activeIdx, setActiveIdx] = useState(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [thinkMs, setThinkMs] = useState(0);
  const [thinkRunning, setThinkRunning] = useState(false);

  const [roomCode] = useState(() => (mode === "host" ? newRoomCode() : null));
  const [peerStatus, setPeerStatus] = useState("idle");
  const [peerError, setPeerError] = useState(null);
  const [connectedPeers, setConnectedPeers] = useState([]);
  const [commanderImages, setCommanderImages] = useState({});
  const [notes, setNotes] = useState({});
  const peerRef = useRef(null);
  const connsRef = useRef(new Map());
  const stateRef = useRef(null);
  const commanderImagesRef = useRef({});
  const notesRef = useRef({});

  // ── timer ticks ─────────────────────────────────────────
  const tickRef = useRef(null);
  const lastTick = useRef(null);
  useEffect(() => {
    if (!running || activeIdx === null) return;
    lastTick.current = performance.now();
    tickRef.current = setInterval(() => {
      const now = performance.now();
      const dt = now - lastTick.current;
      lastTick.current = now;
      setPlayers((prev) =>
        prev.map((p, i) => (i === activeIdx ? { ...p, elapsed: p.elapsed + dt } : p))
      );
    }, 200);
    return () => clearInterval(tickRef.current);
  }, [running, activeIdx]);

  const thinkTickRef = useRef(null);
  const thinkLastTick = useRef(null);
  useEffect(() => {
    if (!thinkRunning) return;
    thinkLastTick.current = performance.now();
    thinkTickRef.current = setInterval(() => {
      const now = performance.now();
      const dt = now - thinkLastTick.current;
      thinkLastTick.current = now;
      setThinkMs((t) => t + dt);
    }, 200);
    return () => clearInterval(thinkTickRef.current);
  }, [thinkRunning]);

  // ── host: spin up PeerJS server ─────────────────────────
  useEffect(() => {
    if (mode !== "host") return;
    let cancelled = false;
    setPeerStatus("starting");
    try {
      const peer = new Peer(peerIdFor(roomCode), { debug: 1 });
      if (cancelled) { peer.destroy(); return; }
      peerRef.current = peer;
      peer.on("open", () => setPeerStatus("ready"));
      peer.on("error", (err) => {
        setPeerStatus("error");
        setPeerError(err.type || err.message || String(err));
      });
      peer.on("connection", (conn) => {
        conn.on("open", () => {
          connsRef.current.set(conn.peer, conn);
          setConnectedPeers((p) => [...p, { id: conn.peer }]);
          sendTo(conn, { type: "state", payload: stateRef.current });
          sendTo(conn, {
            type: "roster",
            payload: stateRef.current?.players.map((pl, i) => ({
              seat: i,
              name: pl.name,
              claimedBy: pl.claimedBy,
            })),
          });
          if (Object.keys(commanderImagesRef.current).length) {
            sendTo(conn, { type: "commander-images", payload: commanderImagesRef.current });
          }
          if (Object.keys(notesRef.current).length) {
            sendTo(conn, { type: "notes", payload: notesRef.current });
          }
        });
        conn.on("data", (msg) => handlePeerMsg(conn, msg));
        conn.on("close", () => {
          connsRef.current.delete(conn.peer);
          setConnectedPeers((p) => p.filter((x) => x.id !== conn.peer));
          setPlayers((prev) =>
            prev.map((pl) =>
              pl.claimedBy === conn.peer ? { ...pl, claimedBy: null } : pl
            )
          );
        });
      });
    } catch (e) {
      setPeerStatus("error");
      setPeerError(e.message);
    }
    return () => {
      cancelled = true;
      try { peerRef.current?.destroy(); } catch {}
    };
  }, [mode, roomCode]);

  // keep stateRef + commanderImagesRef fresh and broadcast on every change
  useEffect(() => {
    const snap = { stage, players, activeIdx, running, thinkMs, thinkRunning };
    stateRef.current = snap;
    if (mode === "host" && connsRef.current.size) {
      for (const conn of connsRef.current.values()) {
        sendTo(conn, { type: "state", payload: snap });
      }
    }
  }, [stage, players, activeIdx, running, thinkMs, thinkRunning, mode]);

  useEffect(() => {
    commanderImagesRef.current = commanderImages;
  }, [commanderImages]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const sendTo = (conn, msg) => { try { conn.send(msg); } catch {} };

  const handlePeerMsg = (conn, msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "claim") {
      setPlayers((prev) => {
        const target = prev[msg.seat];
        if (!target || target.claimedBy) return prev;
        return prev.map((p, i) =>
          p.claimedBy === conn.peer
            ? { ...p, claimedBy: null }
            : i === msg.seat
            ? { ...p, claimedBy: conn.peer }
            : p
        );
      });
    } else if (msg.type === "pass") {
      const cur = stateRef.current?.activeIdx;
      if (cur === null || cur === undefined) return;
      const p = stateRef.current.players[cur];
      if (!p || p.claimedBy !== conn.peer) return;
      pushHistory();
      setPlayers((prev) =>
        prev.map((pl, i) => (i === cur ? { ...pl, turns: pl.turns + 1 } : pl))
      );
      setActiveIdx(advanceFrom(cur, stateRef.current.players));
      setRunning(true);
    } else if (msg.type === "think-toggle") {
      setThinkRunning((r) => {
        if (!r) setThinkMs(0);
        return !r;
      });
    } else if (msg.type === "life-delta") {
      const { delta } = msg;
      if (typeof delta !== "number") return;
      setPlayers((prev) => {
        const myIdx = prev.findIndex((p) => p.claimedBy === conn.peer);
        if (myIdx === -1) return prev;
        return prev.map((p, i) => (i === myIdx ? { ...p, life: p.life + delta } : p));
      });
    } else if (msg.type === "set-commander") {
      const { img, name, text, power, toughness, loyalty } = msg;
      if (typeof img !== "string") return;
      setPlayers((prev) => {
        const myIdx = prev.findIndex((p) => p.claimedBy === conn.peer);
        if (myIdx === -1) return prev;
        setCommanderImages((ci) => {
          const updated = { ...ci, [myIdx]: { img, name: name || "", text: text || "", power: power ?? null, toughness: toughness ?? null, loyalty: loyalty ?? null } };
          commanderImagesRef.current = updated;
          for (const c of connsRef.current.values()) {
            sendTo(c, { type: "commander-images", payload: updated });
          }
          return updated;
        });
        return prev;
      });
    } else if (msg.type === "set-note") {
      const { text } = msg;
      if (typeof text !== "string") return;
      setPlayers((prev) => {
        const myIdx = prev.findIndex((p) => p.claimedBy === conn.peer);
        if (myIdx === -1) return prev;
        setNotes((n) => {
          const updated = { ...n, [myIdx]: text };
          notesRef.current = updated;
          for (const c of connsRef.current.values()) {
            sendTo(c, { type: "notes", payload: updated });
          }
          return updated;
        });
        return prev;
      });
    }
  };

  // ── host commander update (direct, no peer message needed) ─
  const setCommanderForSeat = (seat, data) => {
    setCommanderImages((ci) => {
      const updated = { ...ci, [seat]: data };
      commanderImagesRef.current = updated;
      for (const conn of connsRef.current.values()) {
        sendTo(conn, { type: "commander-images", payload: updated });
      }
      return updated;
    });
  };

  // ── host note update (direct, no peer message needed) ───
  const updateNote = (seat, text) => {
    setNotes((n) => {
      const updated = { ...n, [seat]: text };
      notesRef.current = updated;
      for (const conn of connsRef.current.values()) {
        sendTo(conn, { type: "notes", payload: updated });
      }
      return updated;
    });
  };

  // ── game logic ──────────────────────────────────────────
  const advanceFrom = (from, ps) => {
    const n = ps.length;
    for (let step = 1; step <= n; step++) {
      const idx = (from + step) % n;
      if (!ps[idx].eliminated) return idx;
    }
    return from;
  };

  const startGame = () => {
    setActiveIdx(0);
    setRunning(true);
    setHistory([]);
    setStage("game");
  };

  const pushHistory = () =>
    setHistory((h) => [
      ...h.slice(-30),
      { players: players.map((p) => ({ ...p })), activeIdx },
    ]);

  const passTurn = () => {
    if (activeIdx === null) return;
    pushHistory();
    setPlayers((prev) =>
      prev.map((p, i) => (i === activeIdx ? { ...p, turns: p.turns + 1 } : p))
    );
    setActiveIdx((cur) => advanceFrom(cur, players));
    setRunning(true);
  };

  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      setPlayers(last.players);
      setActiveIdx(last.activeIdx);
      return h.slice(0, -1);
    });
  };

  const toggleEliminated = (idx) => {
    pushHistory();
    setPlayers((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, eliminated: !p.eliminated } : p))
    );
    if (idx === activeIdx) {
      setActiveIdx((cur) => {
        const n = players.length;
        for (let step = 1; step <= n; step++) {
          const cand = (cur + step) % n;
          if (cand !== idx && !players[cand].eliminated) return cand;
        }
        return cur;
      });
    }
  };

  const adjustLife = (idx, delta) => {
    setPlayers((prev) =>
      prev.map((p, i) => (i === idx ? { ...p, life: p.life + delta } : p))
    );
  };

  const newGame = () => {
    setStage("setup");
    setRunning(false);
    setActiveIdx(null);
    setThinkMs(0);
    setThinkRunning(false);
    setPlayers((prev) =>
      prev.map((p) => ({ ...p, elapsed: 0, turns: 0, eliminated: false, life: 40 }))
    );
  };

  const toggleThink = () => {
    setThinkRunning((r) => {
      if (!r) setThinkMs(0);
      return !r;
    });
  };
  const resetThink = () => { setThinkRunning(false); setThinkMs(0); };

  if (stage === "setup") {
    return (
      <HostSetup
        mode={mode}
        playerCount={playerCount}
        setPlayerCount={(n) => {
          setPlayerCount(n);
          setPlayers((prev) => {
            const next = makePlayers(n);
            return next.map((p, i) => ({ ...p, name: prev[i]?.name || p.name }));
          });
        }}
        players={players}
        setPlayerName={(i, name) =>
          setPlayers((prev) => prev.map((p, idx) => (idx === i ? { ...p, name } : p)))
        }
        roomCode={roomCode}
        peerStatus={peerStatus}
        peerError={peerError}
        connectedPeers={connectedPeers}
        onStart={startGame}
        onExit={onExit}
      />
    );
  }
  return (
    <Game
      players={players}
      activeIdx={activeIdx}
      running={running}
      canUndo={history.length > 0}
      thinkMs={thinkMs}
      thinkRunning={thinkRunning}
      onToggleThink={toggleThink}
      onResetThink={resetThink}
      onPass={passTurn}
      onTogglePause={() => setRunning((r) => !r)}
      onUndo={undo}
      onEliminate={toggleEliminated}
      onAdjustLife={adjustLife}
      onNewGame={newGame}
      commanderImages={commanderImages}
      notes={notes}
      onUpdateNote={updateNote}
      onSetCommander={setCommanderForSeat}
      hostBanner={
        mode === "host" && (
          <HostBanner
            roomCode={roomCode}
            peerStatus={peerStatus}
            connectedPeers={connectedPeers}
          />
        )
      }
    />
  );
}

/* ── host setup ───────────────────────────────────────────── */
function HostSetup({
  mode, playerCount, setPlayerCount,
  players, setPlayerName,
  roomCode, peerStatus, peerError, connectedPeers,
  onStart, onExit,
}) {
  return (
    <div className="cc-setup">
      <header className="cc-head">
        <div className="cc-pip" />
        <h1>Commander Clock</h1>
        <p className="cc-sub">
          {mode === "host" ? "Hosting a room" : "One phone, passed around"}
        </p>
      </header>

      {mode === "host" && (
        <RoomCard
          roomCode={roomCode}
          peerStatus={peerStatus}
          peerError={peerError}
          connectedPeers={connectedPeers}
          players={players}
        />
      )}

      <section className="cc-card">
        <label className="cc-label">Players at the table</label>
        <div className="cc-seg">
          {[4, 5].map((n) => (
            <button
              key={n}
              className={`cc-segbtn ${playerCount === n ? "on" : ""}`}
              onClick={() => setPlayerCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </section>

      <section className="cc-card">
        <label className="cc-label">
          Seat names — turn order is clockwise
          {mode === "host" && (
            <span className="cc-hint">
              Players will pick their seat by name when they join
            </span>
          )}
        </label>
        <div className="cc-names">
          {players.map((p, i) => (
            <div className="cc-namerow" key={i}>
              <span className="cc-dot" style={{ background: SEAT_COLORS[i].ink }} />
              <input
                className="cc-input"
                value={p.name}
                placeholder={`Seat ${i + 1}`}
                maxLength={16}
                onChange={(e) => setPlayerName(i, e.target.value)}
              />
              {mode === "host" && p.claimedBy && (
                <span className="cc-claimed">●</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <button className="cc-start" onClick={onStart}>Start Game</button>
      <button className="cc-textbtn" onClick={onExit}>← Back</button>
    </div>
  );
}

function RoomCard({ roomCode, peerStatus, peerError, connectedPeers, players }) {
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  const [qrSvg, setQrSvg] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toString(joinUrl, { type: "svg", margin: 1, width: 220 })
      .then((svg) => setQrSvg(svg))
      .catch(() => setQrSvg(null));
  }, [joinUrl]);

  const copy = () => {
    navigator.clipboard?.writeText(joinUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const claimed = players.filter((p) => p.claimedBy).length;

  return (
    <section className="cc-card cc-roomcard">
      <label className="cc-label">Share this room</label>
      <div className="cc-roomrow">
        {qrSvg ? (
          <div className="cc-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        ) : (
          <div className="cc-qr">
            <div className="cc-qr-fallback">…</div>
          </div>
        )}
        <div className="cc-roominfo">
          <div className="cc-roomcode">{roomCode}</div>
          <div className="cc-status">
            {peerStatus === "starting" && (<><span className="cc-spin" /> Starting…</>)}
            {peerStatus === "ready" && (
              <>
                <span className="cc-live" /> Open · {connectedPeers.length} joined ·{" "}
                {claimed}/{players.length} claimed
              </>
            )}
            {peerStatus === "error" && (
              <span className="cc-err">
                Can't reach signaling server{peerError ? ` (${peerError})` : ""}
              </span>
            )}
          </div>
          <button className="cc-textbtn" onClick={copy}>
            {copied ? "✓ copied" : "copy join link"}
          </button>
        </div>
      </div>
    </section>
  );
}

function HostBanner({ roomCode, peerStatus, connectedPeers }) {
  return (
    <div className="cc-hostbanner">
      <span className="cc-hostroom">{roomCode}</span>
      <span className="cc-hostsep">·</span>
      <span>
        {peerStatus === "ready" ? (
          <><span className="cc-live" /> {connectedPeers.length} joined</>
        ) : peerStatus === "starting" ? "starting…" : (
          <span className="cc-err">offline</span>
        )}
      </span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Joiner app
   ────────────────────────────────────────────────────────────── */
function JoinerApp({ initialCode, onExit }) {
  const [code] = useState(initialCode);
  const [status, setStatus] = useState("idle");
  const [errorMsg, setErrorMsg] = useState(null);
  const [roster, setRoster] = useState([]);
  const [mySeat, setMySeat] = useState(null);
  const [remote, setRemote] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [commanderImages, setCommanderImages] = useState({});
  const [notes, setNotes] = useState({});
  const peerRef = useRef(null);
  const connRef = useRef(null);

  const connect = useCallback(() => {
    setStatus("connecting");
    setErrorMsg(null);
    try {
      const peer = new Peer({ debug: 1 });
      peerRef.current = peer;
      peer.on("open", () => {
        const conn = peer.connect(peerIdFor(code), { reliable: true });
        connRef.current = conn;
        conn.on("open", () => setStatus("roster"));
        conn.on("data", (msg) => {
          if (msg.type === "state") setRemote(msg.payload);
          if (msg.type === "roster") setRoster(msg.payload || []);
          if (msg.type === "commander-images") setCommanderImages(msg.payload || {});
          if (msg.type === "notes") setNotes(msg.payload || {});
        });
        conn.on("close", () => {
          setStatus("error");
          setErrorMsg("Disconnected from host");
        });
        conn.on("error", (e) => {
          setStatus("error");
          setErrorMsg(e.message || String(e));
        });
      });
      peer.on("error", (e) => {
        setStatus("error");
        const t = e.type || "";
        if (t === "peer-unavailable")
          setErrorMsg(`No room found with code ${code}`);
        else setErrorMsg(e.message || t);
      });
    } catch (e) {
      setStatus("error");
      setErrorMsg(e.message);
    }
  }, [code]);

  useEffect(() => {
    if (code && code.length === 4) connect();
    return () => {
      try { connRef.current?.close(); } catch {}
      try { peerRef.current?.destroy(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const claim = (seat) => {
    connRef.current?.send({ type: "claim", seat });
    setMySeat(seat);
    setStatus("connected");
  };

  const pass = () => connRef.current?.send({ type: "pass" });
  const toggleThink = () => connRef.current?.send({ type: "think-toggle" });
  const adjustLife = (delta) => connRef.current?.send({ type: "life-delta", delta });
  const setCommander = ({ img, name, text, power, toughness, loyalty }) =>
    connRef.current?.send({ type: "set-commander", img, name, text, power, toughness, loyalty });
  const sendNote = (text) => connRef.current?.send({ type: "set-note", text });

  if (status === "idle" || status === "connecting") {
    return (
      <div className="cc-setup">
        <header className="cc-head">
          <div className="cc-pip" />
          <h1>Joining…</h1>
          <p className="cc-sub">Room {code}</p>
        </header>
        <section className="cc-card">
          <div className="cc-status">
            <span className="cc-spin" /> Connecting to host
          </div>
        </section>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="cc-setup">
        <header className="cc-head">
          <h1>Couldn't connect</h1>
          <p className="cc-sub">{errorMsg}</p>
        </header>
        <button className="cc-start" onClick={connect}>Try Again</button>
        <button className="cc-textbtn" onClick={onExit}>← Back</button>
      </div>
    );
  }

  if (status === "roster") {
    return (
      <div className="cc-setup">
        <header className="cc-head">
          <div className="cc-pip" />
          <h1>Pick your seat</h1>
          <p className="cc-sub">Room {code}</p>
        </header>
        <section className="cc-card">
          <label className="cc-label">Open seats</label>
          <div className="cc-names">
            {roster.map((r) => (
              <button
                key={r.seat}
                className="cc-seatpick"
                disabled={!!r.claimedBy}
                onClick={() => claim(r.seat)}
                style={{ "--ink": SEAT_COLORS[r.seat].ink }}
              >
                <span className="cc-dot" style={{ background: SEAT_COLORS[r.seat].ink }} />
                <span className="cc-seatpickname">{r.name}</span>
                {r.claimedBy && <span className="cc-claimed">taken</span>}
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  if (!remote || mySeat === null) {
    return (
      <div className="cc-setup">
        <header className="cc-head">
          <h1>Waiting for game to start…</h1>
        </header>
      </div>
    );
  }

  const me = remote.players[mySeat];
  const isMyTurn = remote.activeIdx === mySeat;
  const others = remote.players
    .map((p, i) => ({ ...p, seat: i }))
    .filter((p) => p.seat !== mySeat);

  return (
    <div className="cc-joiner">
      {scanOpen && (
        <CommanderScanModal
          onConfirm={(data) => { setCommander(data); setScanOpen(false); }}
          onClose={() => setScanOpen(false)}
        />
      )}
      {noteOpen && (
        <NoteModal
          initialText={notes[mySeat] || ""}
          onSave={(text) => { sendNote(text); setNoteOpen(false); }}
          onClose={() => setNoteOpen(false)}
        />
      )}
      <div
        className={`cc-myseat ${isMyTurn ? "active" : ""} ${me.eliminated ? "out" : ""}`}
        style={{
          "--ink": SEAT_COLORS[mySeat].ink,
          "--glow": SEAT_COLORS[mySeat].glow,
          "--seatbg": SEAT_COLORS[mySeat].bg,
          ...(commanderImages[mySeat]?.img
            ? { "--cmdr-img": `url("${commanderImages[mySeat].img}")` }
            : {}),
        }}
        onClick={() => {
          if (isMyTurn && remote.running && !me.eliminated) pass();
        }}
      >
        {commanderImages[mySeat]?.img && <div className="cc-seat-art" />}
        {/* Main stats — centered */}
        <div className="cc-myseat-main">
          <div className="cc-myseat-name">{me.name}</div>
          <div className="cc-myseat-life">
            <LifeBtn delta={-1} onAdjust={adjustLife} className="cc-lifebtn-lg" />
            <span className="cc-myseat-lifenum">{me.life}</span>
            <LifeBtn delta={1} onAdjust={adjustLife} className="cc-lifebtn-lg" />
          </div>
          <div className="cc-myseat-time">{fmt(me.elapsed)}</div>
          <div className="cc-myseat-turns">{me.turns} turns played</div>
          <div className="cc-myseat-cta">
            {me.eliminated
              ? "eliminated"
              : isMyTurn
              ? remote.running ? "TAP TO END TURN" : "paused by host"
              : `waiting · ${remote.players[remote.activeIdx]?.name}'s turn`}
          </div>
          <div className="cc-joiner-btns">
            <button
              className="cc-scan-btn"
              onClick={(e) => { e.stopPropagation(); setScanOpen(true); }}
            >
              📷 Commander
            </button>
            <button
              className="cc-scan-btn"
              onClick={(e) => { e.stopPropagation(); setNoteOpen(true); }}
            >
              {notes[mySeat] ? "📝 Edit Note" : "📝 Note"}
            </button>
          </div>
        </div>
        {/* My note strip */}
        {notes[mySeat] && (
          <div className="cc-seat-note joiner-note">{notes[mySeat]}</div>
        )}
        {/* Commander footer — pinned to the bottom */}
        {(commanderImages[mySeat]?.name || commanderImages[mySeat]?.text) && (
          <div className="cc-seat-cmdr-footer">
            <div className="cc-seat-cmdr-row">
              {commanderImages[mySeat]?.name && (
                <span className="cc-seat-cmdrname">{commanderImages[mySeat].name}</span>
              )}
              {commanderImages[mySeat]?.power != null && commanderImages[mySeat]?.toughness != null && (
                <span className="cc-seat-pt">{commanderImages[mySeat].power}/{commanderImages[mySeat].toughness}</span>
              )}
              {commanderImages[mySeat]?.loyalty != null && commanderImages[mySeat]?.power == null && (
                <span className="cc-seat-pt loyalty">{commanderImages[mySeat].loyalty}</span>
              )}
            </div>
            {commanderImages[mySeat]?.text && (
              <div className="cc-seat-cmdrtext">{commanderImages[mySeat].text}</div>
            )}
          </div>
        )}
      </div>

      <div className="cc-others">
        {others.map((p) => (
          <div
            key={p.seat}
            className={`cc-other ${p.seat === remote.activeIdx ? "active" : ""} ${p.eliminated ? "out" : ""}`}
            style={{
              "--ink": SEAT_COLORS[p.seat].ink,
              ...(commanderImages[p.seat]?.img
                ? { "--cmdr-img": `url("${commanderImages[p.seat].img}")` }
                : {}),
            }}
          >
            {commanderImages[p.seat]?.img && <div className="cc-other-art" />}
            <div className="cc-other-name">{p.name}</div>
            {commanderImages[p.seat]?.name && (
              <div className="cc-other-cmdrname">{commanderImages[p.seat].name}</div>
            )}
            {commanderImages[p.seat]?.power != null && commanderImages[p.seat]?.toughness != null && (
              <div className="cc-other-pt">{commanderImages[p.seat].power}/{commanderImages[p.seat].toughness}</div>
            )}
            {commanderImages[p.seat]?.loyalty != null && commanderImages[p.seat]?.power == null && (
              <div className="cc-other-pt">{commanderImages[p.seat].loyalty}★</div>
            )}
            <div className="cc-other-life">{p.life}</div>
            <div className="cc-other-time">{fmt(p.elapsed)}</div>
            {notes[p.seat] && (
              <div className="cc-other-note">{notes[p.seat]}</div>
            )}
          </div>
        ))}
      </div>

      <div className={`cc-think ${remote.thinkRunning ? "live" : ""}`} onClick={toggleThink}>
        <div className="cc-think-label">
          <span className="cc-think-dot" /> Thinking
        </div>
        <div className="cc-think-time">{fmt(remote.thinkMs)}</div>
      </div>
    </div>
  );
}

/* ── shared Game (host & solo) ───────────────────────────── */
function Game({
  players, activeIdx, running, canUndo,
  thinkMs, thinkRunning, onToggleThink, onResetThink,
  onPass, onTogglePause, onUndo, onEliminate, onAdjustLife, onNewGame,
  commanderImages = {},
  notes = {},
  onUpdateNote,
  onSetCommander,
  hostBanner,
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const grid = players.length <= 4 ? "grid-2x2" : "grid-5";
  const aliveCount = players.filter((p) => !p.eliminated).length;
  return (
    <div className="cc-game">
      {notesOpen && (
        <TableNotesModal
          players={players}
          notes={notes}
          onUpdate={onUpdateNote}
          onClose={() => setNotesOpen(false)}
        />
      )}
      {hostBanner}
      <div className={`cc-grid ${grid}`}>
        {players.map((p, i) => (
          <SeatPanel
            key={p.id}
            player={p}
            color={SEAT_COLORS[i]}
            active={i === activeIdx}
            running={running}
            commanderImg={commanderImages[i]?.img}
            commanderName={commanderImages[i]?.name}
            commanderText={commanderImages[i]?.text}
            commanderPower={commanderImages[i]?.power}
            commanderToughness={commanderImages[i]?.toughness}
            commanderLoyalty={commanderImages[i]?.loyalty}
            noteText={notes[i] || ""}
            onPass={onPass}
            onEliminate={() => onEliminate(i)}
            onAdjustLife={(delta) => onAdjustLife(i, delta)}
            onSetCommander={onSetCommander ? (data) => onSetCommander(i, data) : null}
          />
        ))}
      </div>

      <div className={`cc-think ${thinkRunning ? "live" : ""}`} onClick={onToggleThink}>
        <div className="cc-think-label">
          <span className="cc-think-dot" /> Thinking
        </div>
        <div className="cc-think-time">{fmt(thinkMs)}</div>
        <button
          className="cc-think-reset"
          onClick={(e) => { e.stopPropagation(); onResetThink(); }}
          aria-label="Reset thinking timer"
        >⟲</button>
      </div>

      <div className="cc-bar">
        <button className="cc-ctl" onClick={onUndo} disabled={!canUndo}>↩ Undo</button>
        <button className={`cc-ctl ${running ? "" : "paused"}`} onClick={onTogglePause}>
          {running ? "❚❚ Pause" : "▶ Resume"}
        </button>
        <button className="cc-ctl" onClick={() => setNotesOpen(true)}>📝 Notes</button>
        <button className="cc-ctl" onClick={onNewGame}>⟲ New</button>
      </div>
      {aliveCount <= 1 && (
        <div className="cc-winner">
          {players.find((p) => !p.eliminated)?.name} wins the pod
        </div>
      )}
    </div>
  );
}

function LifeBtn({ delta, onAdjust, className }) {
  const toRef = useRef(null);
  const ivRef = useRef(null);

  const startAdjust = (e) => {
    e.stopPropagation();
    onAdjust(delta);
    toRef.current = setTimeout(() => {
      ivRef.current = setInterval(() => onAdjust(delta), 100);
    }, 400);
  };

  const stopAdjust = (e) => {
    e.stopPropagation();
    clearTimeout(toRef.current);
    clearInterval(ivRef.current);
  };

  return (
    <button
      className={`cc-lifebtn${className ? ` ${className}` : ""}`}
      onPointerDown={startAdjust}
      onPointerUp={stopAdjust}
      onPointerLeave={stopAdjust}
      onClick={(e) => e.stopPropagation()}
    >
      {delta > 0 ? "+" : "−"}
    </button>
  );
}

function SeatPanel({ player, color, active, running, commanderImg, commanderName, commanderText, commanderPower, commanderToughness, commanderLoyalty, noteText, onPass, onEliminate, onAdjustLife, onSetCommander }) {
  const pressTimer = useRef(null);
  const longFired = useRef(false);
  const [scanOpen, setScanOpen] = useState(false);

  const start = () => {
    longFired.current = false;
    pressTimer.current = setTimeout(() => {
      longFired.current = true;
      onEliminate();
    }, 650);
  };
  const end = () => {
    clearTimeout(pressTimer.current);
    if (longFired.current) return;
    if (active && !player.eliminated && running) onPass();
  };

  return (
    <>
      {scanOpen && onSetCommander && (
        <CommanderScanModal
          onConfirm={(data) => { onSetCommander(data); setScanOpen(false); }}
          onClose={() => setScanOpen(false)}
        />
      )}
      <div
        className={`cc-seat ${active ? "active" : ""} ${player.eliminated ? "out" : ""}`}
        style={{
          "--ink": color.ink,
          "--glow": color.glow,
          "--seatbg": color.bg,
          ...(commanderImg ? { "--cmdr-img": `url("${commanderImg}")` } : {}),
        }}
        onPointerDown={start}
        onPointerUp={end}
        onPointerLeave={() => clearTimeout(pressTimer.current)}
      >
        {commanderImg && <div className="cc-seat-art" />}
        {/* Main stats — centered in the available space */}
        <div className="cc-seat-main">
          <div className="cc-seat-top">
            <span className="cc-seatname">
              {player.name}
              {player.claimedBy && (
                <span className="cc-onphone" title="On their own phone">📱</span>
              )}
            </span>
            <span className="cc-turns">{player.turns} turns</span>
          </div>
          <div className="cc-life-row">
            <LifeBtn delta={-1} onAdjust={onAdjustLife} />
            <span className="cc-life">{player.life}</span>
            <LifeBtn delta={1} onAdjust={onAdjustLife} />
          </div>
          <div className="cc-time">{fmt(player.elapsed)}</div>
          {active && !player.eliminated && (
            <div className="cc-tap">{running ? "tap to pass" : "paused"}</div>
          )}
        </div>
        {/* Note strip — sits just above commander footer */}
        {noteText ? (
          <div className="cc-seat-note">{noteText}</div>
        ) : null}
        {/* Commander footer — pinned to the bottom */}
        <div className="cc-seat-cmdr-footer">
          {commanderName ? (
            <div className="cc-seat-cmdr-row">
              <span className="cc-seat-cmdrname">{commanderName}</span>
              {commanderPower != null && commanderToughness != null && (
                <span className="cc-seat-pt">{commanderPower}/{commanderToughness}</span>
              )}
              {commanderLoyalty != null && commanderPower == null && (
                <span className="cc-seat-pt loyalty">{commanderLoyalty}</span>
              )}
              {onSetCommander && (
                <button
                  className="cc-seat-scan-icon"
                  onClick={(e) => { e.stopPropagation(); setScanOpen(true); }}
                  title="Change commander"
                >📷</button>
              )}
            </div>
          ) : onSetCommander ? (
            <button
              className="cc-seat-setcmdr"
              onClick={(e) => { e.stopPropagation(); setScanOpen(true); }}
            >
              📷 Set Commander
            </button>
          ) : null}
          {commanderText && (
            <div className="cc-seat-cmdrtext">{commanderText}</div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── Table Notes Modal (host) ────────────────────────────── */
function TableNotesModal({ players, notes, onUpdate, onClose }) {
  return (
    <div className="cc-scan-overlay" onClick={onClose}>
      <div className="cc-scan-modal cc-notes-modal" onClick={(e) => e.stopPropagation()}>
        <button className="cc-scan-close" onClick={onClose}>✕</button>
        <div className="cc-scan-title">Table Notes</div>
        <p className="cc-notes-hint">
          Emblems, Monarch, Initiative, counters — anything the table should remember.
        </p>
        <div className="cc-notes-list">
          {players.map((p, i) => (
            <div key={i} className="cc-notes-row">
              <label className="cc-notes-seat" style={{ color: SEAT_COLORS[i].ink }}>
                {p.name}
              </label>
              <textarea
                className="cc-notes-input"
                rows={2}
                placeholder="No notes…"
                value={notes[i] || ""}
                onChange={(e) => onUpdate(i, e.target.value)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Note Modal (joiner — edit own seat) ─────────────────── */
function NoteModal({ initialText, onSave, onClose }) {
  const [text, setText] = useState(initialText);
  return (
    <div className="cc-scan-overlay" onClick={onClose}>
      <div className="cc-scan-modal cc-notes-modal" onClick={(e) => e.stopPropagation()}>
        <button className="cc-scan-close" onClick={onClose}>✕</button>
        <div className="cc-scan-title">My Note</div>
        <p className="cc-notes-hint">
          Emblems, effects, reminders — visible to everyone at the table.
        </p>
        <textarea
          className="cc-notes-input cc-notes-input-solo"
          rows={4}
          placeholder="e.g. Has Monarch · Jace emblem active"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <div className="cc-scan-actions">
          <button className="cc-scan-confirm" onClick={() => onSave(text)}>
            Save Note
          </button>
          {text && (
            <button className="cc-scan-retry" onClick={() => onSave("")}>
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Commander Scan Modal ────────────────────────────────── */
async function initTesseract() {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_pageseg_mode: "7",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',- ",
  });
  return worker;
}

async function ocrTitleStrip(video, worker) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Card guide rect: centered, portrait 63:88 aspect, 80% of shorter dimension
  const shorter = Math.min(vw, vh);
  const cardW = shorter * 0.75;
  const cardH = cardW * (88 / 63);
  const cardX = (vw - cardW) / 2;
  const cardY = (vh - cardH) / 2;

  // Title strip: top 14% of card height, left 65% of width (excludes mana cost)
  const stripW = cardW * 0.65;
  const stripH = cardH * 0.14;

  const canvas = document.createElement("canvas");
  // Scale 3x for better OCR accuracy
  canvas.width = stripW * 3;
  canvas.height = stripH * 3;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, cardX, cardY, stripW, stripH, 0, 0, canvas.width, canvas.height);

  // Grayscale + contrast boost
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const c = gray < 128 ? Math.max(0, gray - 50) : Math.min(255, gray + 50);
    d[i] = d[i + 1] = d[i + 2] = c;
  }
  ctx.putImageData(imgData, 0, 0);

  const { data: { text, confidence } } = await worker.recognize(canvas);
  const cleaned = text.replace(/[^A-Za-z',\- ]/g, "").trim();
  return confidence > 35 && cleaned.length >= 3 ? cleaned : null;
}

async function scryfallFuzzy(name) {
  const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const card = await res.json();
  if (card.object === "error") return null;
  return card;
}

async function scryfallSearch(query) {
  const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=name&unique=cards`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.data || []).slice(0, 6);
}

function CommanderScanModal({ onConfirm, onClose }) {
  const [phase, setPhase] = useState("init"); // init | loading | scanning | detected | search | error
  const [errMsg, setErrMsg] = useState("");
  const [detected, setDetected] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const videoRef = useRef(null);
  const workerRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const lastScannedRef = useRef("");
  const searchTimerRef = useRef(null);
  const scanActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    initTesseract()
      .then((w) => {
        if (cancelled) { w.terminate(); return; }
        workerRef.current = w;
        startCamera();
      })
      .catch((e) => {
        if (!cancelled) { setErrMsg(e.message); setPhase("error"); }
      });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const cleanup = () => {
    scanActiveRef.current = false;
    clearInterval(scanIntervalRef.current);
    clearTimeout(searchTimerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    workerRef.current?.terminate().catch(() => {});
    workerRef.current = null;
    streamRef.current = null;
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase("scanning");
      beginScanLoop();
    } catch (e) {
      setErrMsg("Camera access denied — use search below instead.");
      setPhase("search");
    }
  };

  const beginScanLoop = () => {
    scanActiveRef.current = true;
    scanIntervalRef.current = setInterval(async () => {
      if (!workerRef.current || !videoRef.current || !scanActiveRef.current) return;
      const text = await ocrTitleStrip(videoRef.current, workerRef.current).catch(() => null);
      if (!text || text === lastScannedRef.current) return;
      lastScannedRef.current = text;
      const card = await scryfallFuzzy(text).catch(() => null);
      if (card && scanActiveRef.current) {
        scanActiveRef.current = false;
        clearInterval(scanIntervalRef.current);
        setDetected(card);
        setPhase("detected");
      }
    }, 1200);
  };

  const resumeScan = () => {
    lastScannedRef.current = "";
    setDetected(null);
    setPhase("scanning");
    beginScanLoop();
  };

  const handleSearchInput = (q) => {
    setSearchQuery(q);
    clearTimeout(searchTimerRef.current);
    if (q.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      const results = await scryfallSearch(q).catch(() => []);
      setSearchResults(results);
      setSearching(false);
    }, 450);
  };

  const confirmCard = (card) => {
    // Double-faced cards store image_uris and oracle_text per face
    const faces = card.card_faces;
    const img =
      card.image_uris?.art_crop ||
      faces?.[0]?.image_uris?.art_crop ||
      card.image_uris?.normal ||
      faces?.[0]?.image_uris?.normal ||
      card.image_uris?.large ||
      faces?.[0]?.image_uris?.large;
    const text =
      card.oracle_text ||
      (faces ? faces.map((f) => `${f.name}\n${f.oracle_text}`).join("\n—\n") : "");
    // Power/toughness for creatures, loyalty for planeswalkers
    const power = card.power ?? faces?.[0]?.power ?? null;
    const toughness = card.toughness ?? faces?.[0]?.toughness ?? null;
    const loyalty = card.loyalty ?? faces?.[0]?.loyalty ?? null;
    if (img) onConfirm({ img, name: card.name, text, power, toughness, loyalty });
  };

  const artUrl = (card) =>
    card.image_uris?.art_crop || card.image_uris?.normal || "";

  return (
    <div className="cc-scan-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="cc-scan-modal">
        <button className="cc-scan-close" onClick={onClose}>✕</button>
        <div className="cc-scan-title">Set Commander</div>

        {/* Camera area */}
        {(phase === "loading" || phase === "scanning" || phase === "detected") && (
          <div className="cc-cam-wrap">
            <video ref={videoRef} className="cc-cam-video" playsInline muted />
            <div className="cc-cam-guide">
              <div className="cc-cam-title-strip" />
            </div>
            {phase === "loading" && (
              <div className="cc-cam-overlay-msg">
                <span className="cc-spin" /> Loading scanner…
              </div>
            )}
            {phase === "scanning" && (
              <div className="cc-cam-overlay-msg scanning">
                Hold card in frame
              </div>
            )}
          </div>
        )}

        {/* Detected card confirmation */}
        {phase === "detected" && detected && (
          <div className="cc-scan-result">
            {artUrl(detected) && (
              <img className="cc-scan-art" src={artUrl(detected)} alt={detected.name} />
            )}
            <div className="cc-scan-cardname">{detected.name}</div>
            <div className="cc-scan-actions">
              <button className="cc-scan-confirm" onClick={() => confirmCard(detected)}>
                Use This Commander
              </button>
              <button className="cc-scan-retry" onClick={resumeScan}>
                Scan Again
              </button>
            </div>
          </div>
        )}

        {/* Search fallback */}
        <div className="cc-scan-search-wrap">
          <div className="cc-scan-search-label">
            {phase === "error" ? errMsg : "Or search by name"}
          </div>
          <input
            className="cc-input cc-scan-search-input"
            placeholder="Commander name…"
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
          />
          {searching && <div className="cc-scan-searching"><span className="cc-spin" /> Searching…</div>}
          {searchResults.length > 0 && (
            <div className="cc-scan-results-list">
              {searchResults.map((card) => (
                <button
                  key={card.id}
                  className="cc-scan-result-item"
                  onClick={() => confirmCard(card)}
                >
                  {artUrl(card) && (
                    <img className="cc-scan-thumb" src={artUrl(card)} alt="" />
                  )}
                  <span>{card.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── styles ──────────────────────────────────────────────── */
const S = {
  root: {
    minHeight: "100vh", width: "100%",
    background:
      "radial-gradient(120% 80% at 50% 0%, #2a2620 0%, #161310 55%, #0d0b09 100%)",
    fontFamily: "'Spectral', Georgia, serif",
    color: "#e8dcc0",
  },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Spectral:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@500;700&display=swap');
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

.cc-setup { max-width: 460px; margin: 0 auto; padding: 32px 20px 48px; }
.cc-head { text-align: center; margin-bottom: 26px; }
.cc-pip {
  width: 34px; height: 34px; margin: 0 auto 12px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #e8dcc0, #9a7b3c 60%, #4a3a1c);
  box-shadow: 0 0 22px rgba(232,220,192,0.35), inset 0 -3px 6px rgba(0,0,0,0.5);
}
.cc-head h1 {
  font-family: 'Cinzel', serif; font-weight: 700; font-size: 28px;
  margin: 0; letter-spacing: 1.5px; color: #f0e6cc;
}
.cc-sub { margin: 4px 0 0; font-style: italic; color: #8a8270; font-size: 14px; }

.cc-card {
  background: linear-gradient(180deg, #211d17, #18150f);
  border: 1px solid #34301f; border-radius: 14px;
  padding: 18px; margin-bottom: 14px;
  box-shadow: inset 0 1px 0 rgba(232,220,192,0.05), 0 6px 18px rgba(0,0,0,0.4);
}
.cc-label {
  display: block; font-family: 'Cinzel', serif; font-size: 12px;
  letter-spacing: 1.5px; text-transform: uppercase;
  color: #a99a6c; margin-bottom: 12px;
}
.cc-hint {
  display: block; font-family: 'Spectral', serif; font-style: italic;
  text-transform: none; letter-spacing: 0; font-size: 12px;
  color: #6e6655; margin-top: 2px;
}
.cc-seg { display: flex; gap: 8px; }
.cc-segbtn {
  flex: 1; padding: 14px 0; font-family: 'JetBrains Mono', monospace;
  font-size: 16px; font-weight: 700;
  background: #14110c; color: #8a8270;
  border: 1px solid #34301f; border-radius: 10px; cursor: pointer;
  transition: all .15s ease;
}
.cc-segbtn:disabled { opacity: 0.4; cursor: not-allowed; }
.cc-segbtn.on {
  background: linear-gradient(180deg, #b89a4e, #8a6f33);
  color: #1a1610; border-color: #d8bc70;
  box-shadow: 0 0 14px rgba(184,154,78,0.4);
}
.cc-names { display: flex; flex-direction: column; gap: 10px; }
.cc-namerow { display: flex; align-items: center; gap: 10px; }
.cc-dot {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  box-shadow: 0 0 8px currentColor;
}
.cc-input {
  flex: 1; padding: 12px 14px; font-family: 'Spectral', serif; font-size: 16px;
  background: #14110c; color: #e8dcc0;
  border: 1px solid #34301f; border-radius: 10px; outline: none;
}
.cc-input:focus { border-color: #b89a4e; }
.cc-code {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  text-align: center; letter-spacing: 6px; font-size: 20px; text-transform: uppercase;
}
.cc-joinrow { display: flex; gap: 8px; align-items: stretch; }
.cc-claimed {
  font-family: 'JetBrains Mono', monospace; font-size: 11px;
  color: #7ec488; margin-left: 6px;
}

.cc-rolebtns { display: flex; flex-direction: column; gap: 10px; }
.cc-rolebtn {
  text-align: left; padding: 16px 18px;
  background: #14110c; color: #e8dcc0;
  border: 1px solid #34301f; border-radius: 10px; cursor: pointer;
  transition: border-color .15s, transform .1s;
}
.cc-rolebtn:active { transform: translateY(1px); }
.cc-rolebtn:hover { border-color: #b89a4e; }
.cc-roletitle {
  font-family: 'Cinzel', serif; font-weight: 600; font-size: 16px;
  color: #d8bc70; letter-spacing: 1px;
}
.cc-roledesc {
  font-family: 'Spectral', serif; font-style: italic;
  color: #8a8270; font-size: 13px; margin-top: 2px;
}

.cc-roomcard { padding: 16px; }
.cc-roomrow { display: flex; gap: 16px; align-items: center; }
.cc-qr {
  background: #f0e6cc; border-radius: 10px; padding: 8px;
  width: 130px; height: 130px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.cc-qr svg { width: 100%; height: 100%; display: block; }
.cc-qr-fallback { color: #1a1610; font-size: 12px; }
.cc-roominfo { flex: 1; min-width: 0; }
.cc-roomcode {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 32px; letter-spacing: 6px; color: #f0e6cc; margin-bottom: 6px;
}
.cc-status {
  font-family: 'Spectral', serif; font-size: 13px; color: #8a8270;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.cc-live {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: #7ec488; box-shadow: 0 0 8px #7ec488;
  animation: pulse 1.6s ease-in-out infinite;
}
.cc-err { color: #e87a5a; font-style: italic; }
.cc-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid #34301f; border-top-color: #d8bc70;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.cc-start {
  width: 100%; padding: 18px; margin-top: 6px;
  font-family: 'Cinzel', serif; font-weight: 700; font-size: 18px;
  letter-spacing: 2px; text-transform: uppercase;
  color: #1a1610; cursor: pointer;
  background: linear-gradient(180deg, #d8bc70, #a8893e);
  border: 1px solid #e8d090; border-radius: 12px;
  box-shadow: 0 0 24px rgba(216,188,112,0.35), inset 0 1px 0 rgba(255,255,255,0.3);
}
.cc-start:active { transform: translateY(1px); }
.cc-textbtn {
  display: block; width: 100%; margin-top: 12px;
  background: transparent; border: none; color: #8a8270;
  font-family: 'Spectral', serif; font-style: italic; font-size: 14px;
  cursor: pointer; padding: 8px;
}

.cc-seatpick {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; width: 100%;
  background: #14110c; color: #e8dcc0;
  border: 1px solid #34301f; border-radius: 10px;
  cursor: pointer; text-align: left; transition: border-color .15s;
}
.cc-seatpick:not(:disabled):hover { border-color: var(--ink); }
.cc-seatpick:disabled { opacity: 0.4; cursor: not-allowed; }
.cc-seatpickname { flex: 1; font-family: 'Cinzel', serif; font-size: 16px; }

.cc-game {
  min-height: 100vh; display: flex; flex-direction: column;
  padding: 10px; gap: 10px;
}
.cc-hostbanner {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 6px 12px;
  font-family: 'JetBrains Mono', monospace; font-size: 12px;
  color: #8a8270; letter-spacing: 1px;
  background: rgba(20,17,12,0.5);
  border: 1px solid #2c281c; border-radius: 999px; align-self: center;
}
.cc-hostroom { color: #d8bc70; font-weight: 700; letter-spacing: 3px; }
.cc-hostsep { opacity: 0.4; }

.cc-grid { display: grid; gap: 10px; flex: 1; }
.grid-2x2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.grid-5 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr 1fr;
}
.grid-5 .cc-seat:nth-child(5) { grid-column: 1 / -1; }

.cc-seat {
  position: relative; border-radius: 14px;
  padding: 0; display: flex; flex-direction: column;
  justify-content: space-between; align-items: stretch;
  background: linear-gradient(165deg, var(--seatbg), #110f0b);
  border: 1px solid #2c281c;
  cursor: pointer; overflow: hidden;
  transition: transform .12s ease, box-shadow .25s ease, opacity .25s ease;
}
.cc-seat-main {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 6px; padding: 16px 16px 8px;
}
.cc-seat-art {
  position: absolute; inset: 0; z-index: 0;
  background-image: var(--cmdr-img);
  background-size: cover; background-position: center top;
  opacity: 0.28;
  transition: opacity .4s ease;
}
.cc-seat.active .cc-seat-art { opacity: 0.38; }
.cc-seat-top, .cc-life-row, .cc-time, .cc-tap, .cc-turns { position: relative; z-index: 1; }

/* Commander footer shared by SeatPanel + cc-myseat */
.cc-seat-cmdr-footer {
  position: relative; z-index: 2;
  width: 100%; flex-shrink: 0;
  padding: 7px 10px 10px;
  background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.45) 100%);
  border-top: 1px solid rgba(255,255,255,0.06);
}
.cc-seat-cmdr-row {
  display: flex; align-items: baseline;
  justify-content: space-between; gap: 6px;
  margin-bottom: 4px;
}
.cc-seat-cmdrname {
  font-family: 'Spectral', serif; font-style: italic; font-size: 11px;
  color: var(--ink); opacity: 0.85; letter-spacing: 0.3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
}
.cc-seat-cmdrtext {
  font-family: 'Spectral', serif; font-size: 10px; line-height: 1.45;
  color: #d0c5a8; white-space: pre-wrap;
  max-height: 68px; overflow-y: auto; scrollbar-width: none;
}
.cc-seat-cmdrtext::-webkit-scrollbar { display: none; }
.cc-seat-pt {
  flex-shrink: 0;
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 12px; letter-spacing: 0.5px; color: #f0e6cc;
}
.cc-seat-pt.loyalty { color: #7ec4e8; }
.cc-seat.active {
  border-color: var(--glow);
  box-shadow: 0 0 0 1px var(--glow), 0 0 32px -4px var(--ink),
    inset 0 0 40px -16px var(--ink);
  transform: scale(1.012);
}
.cc-seat.active::before {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(80% 60% at 50% 0%, var(--ink), transparent 70%);
  opacity: 0.12; pointer-events: none;
}
.cc-seat.out { opacity: 0.38; filter: grayscale(0.7); }
.cc-seat:active { transform: scale(0.985); }
.cc-seat-top {
  display: flex; justify-content: space-between; width: 100%;
  align-items: baseline;
}
.cc-seatname {
  font-family: 'Cinzel', serif; font-weight: 600; font-size: 16px;
  color: var(--ink); letter-spacing: 0.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cc-onphone { font-size: 11px; margin-left: 4px; opacity: 0.7; }
.cc-turns {
  font-family: 'JetBrains Mono', monospace; font-size: 11px;
  color: #6e6655; flex-shrink: 0; margin-left: 8px;
}
.cc-time {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: clamp(34px, 11vw, 52px); line-height: 1;
  color: #f0e6cc; letter-spacing: 1px;
  text-shadow: 0 2px 12px rgba(0,0,0,0.6);
}
.cc-seat.active .cc-time { color: #fff; }
.cc-life-row {
  display: flex; align-items: center; gap: 8px;
}
.cc-life {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: clamp(26px, 8vw, 40px); line-height: 1;
  color: var(--ink); min-width: 2ch; text-align: center;
  font-variant-numeric: tabular-nums;
}
.cc-lifebtn {
  width: 32px; height: 32px; flex-shrink: 0;
  background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; color: var(--ink);
  font-size: 18px; font-weight: 700; line-height: 1;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background .1s, transform .1s;
  touch-action: none;
}
.cc-lifebtn:active { transform: scale(0.88); background: rgba(0,0,0,0.6); }
.cc-lifebtn-lg {
  width: 44px; height: 44px; font-size: 24px; border-radius: 10px;
}

.cc-tap {
  font-family: 'Cinzel', serif; font-size: 11px; letter-spacing: 2px;
  text-transform: uppercase; color: var(--glow);
  margin-top: 2px; animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%,100%{opacity:.5} 50%{opacity:1} }

.cc-bar { display: flex; gap: 8px; }

.cc-think {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px;
  background: linear-gradient(180deg, #14181c, #0e1115);
  border: 1px solid #243038; border-radius: 11px; cursor: pointer;
  transition: border-color .2s ease, box-shadow .2s ease;
}
.cc-think.live {
  border-color: #5a8fa8;
  box-shadow: 0 0 18px -4px rgba(126,196,232,0.45),
    inset 0 0 24px -10px rgba(126,196,232,0.3);
}
.cc-think-label {
  display: flex; align-items: center; gap: 8px;
  font-family: 'Cinzel', serif; font-size: 11px;
  letter-spacing: 2px; text-transform: uppercase;
  color: #6b8090; flex: 1;
}
.cc-think.live .cc-think-label { color: #a8d4ec; }
.cc-think-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #3a4a55; transition: background .2s ease;
}
.cc-think.live .cc-think-dot {
  background: #7ec4e8; box-shadow: 0 0 10px #7ec4e8;
  animation: thinkPulse 1.4s ease-in-out infinite;
}
@keyframes thinkPulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
.cc-think-time {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 22px; color: #c8d8e4; letter-spacing: 1px;
  font-variant-numeric: tabular-nums;
}
.cc-think.live .cc-think-time { color: #e8f4ff; }
.cc-think-reset {
  background: transparent; border: 1px solid #2c3a44;
  color: #6b8090; width: 32px; height: 32px;
  border-radius: 8px; font-size: 14px; cursor: pointer;
}
.cc-think-reset:active { transform: translateY(1px); }

.cc-ctl {
  flex: 1; padding: 15px 0;
  font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 1px;
  background: linear-gradient(180deg, #211d17, #15120d);
  color: #b8aa7c; border: 1px solid #34301f; border-radius: 11px;
  cursor: pointer;
}
.cc-ctl:disabled { opacity: 0.35; }
.cc-ctl.paused {
  background: linear-gradient(180deg, #b89a4e, #8a6f33);
  color: #1a1610; border-color: #d8bc70;
}
.cc-ctl:active { transform: translateY(1px); }

.cc-winner {
  text-align: center; padding: 14px;
  font-family: 'Cinzel', serif; font-weight: 700; font-size: 17px;
  letter-spacing: 1px; color: #1a1610;
  background: linear-gradient(180deg, #d8bc70, #a8893e);
  border-radius: 12px;
  box-shadow: 0 0 24px rgba(216,188,112,0.4);
}

.cc-joiner {
  min-height: 100vh; display: flex; flex-direction: column;
  padding: 10px; gap: 10px;
}
.cc-myseat {
  flex: 1; min-height: 50vh; border-radius: 16px;
  padding: 0;
  display: flex; flex-direction: column;
  justify-content: space-between; align-items: stretch;
  background: linear-gradient(165deg, var(--seatbg), #110f0b);
  border: 1px solid #2c281c;
  cursor: pointer; position: relative; overflow: hidden;
  transition: box-shadow .25s ease, transform .12s ease;
}
.cc-myseat-main {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 10px; padding: 24px 24px 8px;
}
.cc-myseat.active {
  border-color: var(--glow);
  box-shadow: 0 0 0 2px var(--glow),
    0 0 48px -4px var(--ink),
    inset 0 0 60px -20px var(--ink);
}
.cc-myseat.active::before {
  content: ""; position: absolute; inset: 0;
  background: radial-gradient(80% 60% at 50% 0%, var(--ink), transparent 70%);
  opacity: 0.18; pointer-events: none;
}
.cc-myseat.out { opacity: 0.4; filter: grayscale(0.7); }
.cc-myseat:active { transform: scale(0.995); }
.cc-myseat-name {
  font-family: 'Cinzel', serif; font-weight: 600; font-size: 22px;
  color: var(--ink); letter-spacing: 1px;
  position: relative; z-index: 1;
}
.cc-myseat-life {
  display: flex; align-items: center; gap: 14px;
  position: relative; z-index: 1; flex-shrink: 0;
}
.cc-myseat-lifenum {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: clamp(48px, 16vw, 76px); line-height: 1;
  color: var(--ink); min-width: 2ch; text-align: center;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 18px rgba(0,0,0,0.5);
}
.cc-myseat-time {
  position: relative; z-index: 1;
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: clamp(56px, 18vw, 96px); line-height: 1;
  color: #fff; letter-spacing: 2px;
  text-shadow: 0 4px 24px rgba(0,0,0,0.6);
  font-variant-numeric: tabular-nums;
}
.cc-myseat-turns {
  position: relative; z-index: 1;
  font-family: 'JetBrains Mono', monospace; font-size: 12px;
  color: #8a8270; letter-spacing: 1px;
}
.cc-myseat-cta {
  position: relative; z-index: 1;
  margin-top: 4px;
  font-family: 'Cinzel', serif; font-size: 13px;
  letter-spacing: 3px; text-transform: uppercase;
  color: var(--glow);
}
.cc-myseat.active .cc-myseat-cta { animation: pulse 2s ease-in-out infinite; }

.cc-others {
  display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
}
.cc-other {
  position: relative;
  padding: 10px 12px; border-radius: 10px;
  background: linear-gradient(165deg, #1c1812, #0e0c08);
  border: 1px solid #2c281c;
  overflow: hidden;
  transition: border-color .25s;
}
.cc-other-art {
  position: absolute; inset: 0; z-index: 0;
  background-image: var(--cmdr-img);
  background-size: cover; background-position: center top;
  opacity: 0.22;
}
.cc-other.active .cc-other-art { opacity: 0.32; }
.cc-other-name, .cc-other-life, .cc-other-time { position: relative; z-index: 1; }
.cc-other-cmdrname {
  position: relative; z-index: 1;
  font-family: 'Spectral', serif; font-style: italic; font-size: 10px;
  color: var(--ink); opacity: 0.65;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-top: -1px; margin-bottom: 2px;
}
.cc-other-pt {
  position: relative; z-index: 1;
  display: inline-block;
  padding: 1px 6px; margin-bottom: 3px;
  background: rgba(0,0,0,0.6);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 11px; color: #f0e6cc;
}
.cc-other.active {
  border-color: var(--ink);
  box-shadow: 0 0 14px -3px var(--ink);
}
.cc-other.out { opacity: 0.35; }
.cc-other-name {
  font-family: 'Cinzel', serif; font-size: 12px;
  color: var(--ink); letter-spacing: 0.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cc-other-life {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 22px; color: var(--ink); margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.cc-other-time {
  font-family: 'JetBrains Mono', monospace; font-weight: 700;
  font-size: 13px; color: #6e6655; margin-top: 1px;
  font-variant-numeric: tabular-nums;
}

/* ── note strip (SeatPanel + joiner) ── */
.cc-seat-note {
  position: relative; z-index: 2;
  width: 100%; flex-shrink: 0;
  padding: 5px 10px;
  background: rgba(184,154,78,0.13);
  border-top: 1px solid rgba(184,154,78,0.25);
  font-family: 'Spectral', serif; font-style: italic;
  font-size: 10px; line-height: 1.4; color: #d8bc70;
  white-space: pre-wrap; word-break: break-word;
}
.cc-seat-note.joiner-note {
  font-size: 12px; padding: 7px 14px;
  border-radius: 0 0 6px 6px;
}

/* ── joiner button row ── */
.cc-joiner-btns {
  display: flex; gap: 8px; justify-content: center;
  position: relative; z-index: 2;
}

/* ── notes modal ── */
.cc-notes-modal { gap: 10px; }
.cc-notes-hint {
  font-family: 'Spectral', serif; font-style: italic;
  font-size: 13px; color: #6e6655; margin: 0; text-align: center;
}
.cc-notes-list { display: flex; flex-direction: column; gap: 12px; }
.cc-notes-row { display: flex; flex-direction: column; gap: 4px; }
.cc-notes-seat {
  font-family: 'Cinzel', serif; font-size: 12px;
  letter-spacing: 1px; text-transform: uppercase;
}
.cc-notes-input {
  width: 100%; padding: 10px 12px;
  font-family: 'Spectral', serif; font-size: 14px; line-height: 1.5;
  background: #14110c; color: #e8dcc0;
  border: 1px solid #34301f; border-radius: 10px;
  outline: none; resize: none;
}
.cc-notes-input:focus { border-color: #b89a4e; }
.cc-notes-input-solo { min-height: 100px; }

/* ── other-player note ── */
.cc-other-note {
  position: relative; z-index: 1;
  font-family: 'Spectral', serif; font-style: italic;
  font-size: 10px; color: #d8bc70; line-height: 1.3;
  margin-top: 2px; word-break: break-word;
}

/* ── host "Set Commander" button inside seat footer ── */
.cc-seat-setcmdr {
  width: 100%; padding: 5px 8px;
  font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 1px;
  text-transform: uppercase; color: #8a8270;
  background: rgba(0,0,0,0.35); border: 1px dashed #34301f;
  border-radius: 6px; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.cc-seat-setcmdr:hover { color: #d8bc70; border-color: #b89a4e; }
.cc-seat-setcmdr:active { opacity: 0.7; }

/* ── small 📷 icon next to commander name (change commander) ── */
.cc-seat-scan-icon {
  flex-shrink: 0; padding: 0 3px;
  background: transparent; border: none;
  font-size: 12px; line-height: 1; cursor: pointer;
  opacity: 0.5; transition: opacity .15s;
}
.cc-seat-scan-icon:hover { opacity: 1; }
.cc-seat-scan-icon:active { transform: scale(0.85); }

/* ── commander scan button ── */
.cc-scan-btn {
  position: relative; z-index: 2;
  margin-top: 4px; padding: 8px 18px;
  font-family: 'Cinzel', serif; font-size: 11px; letter-spacing: 1.5px;
  text-transform: uppercase; color: #8a8270;
  background: rgba(0,0,0,0.45); border: 1px solid #34301f;
  border-radius: 999px; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.cc-scan-btn:active { opacity: 0.7; }

/* ── scan modal overlay ── */
.cc-scan-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(10,8,6,0.92);
  display: flex; align-items: flex-end; justify-content: center;
}
.cc-scan-modal {
  width: 100%; max-width: 480px; max-height: 92vh;
  background: linear-gradient(180deg, #1c1812, #13110d);
  border: 1px solid #34301f; border-radius: 20px 20px 0 0;
  padding: 20px 16px 32px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 14px;
  position: relative;
}
.cc-scan-close {
  position: absolute; top: 16px; right: 16px;
  background: transparent; border: none; color: #6e6655;
  font-size: 18px; cursor: pointer; padding: 4px 8px;
}
.cc-scan-title {
  font-family: 'Cinzel', serif; font-size: 14px;
  letter-spacing: 2px; text-transform: uppercase;
  color: #a99a6c; text-align: center; margin-top: 4px;
}

/* ── camera view ── */
.cc-cam-wrap {
  position: relative; width: 100%; border-radius: 12px; overflow: hidden;
  background: #000; aspect-ratio: 4/3;
}
.cc-cam-video {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.cc-cam-guide {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
  pointer-events: none;
}
.cc-cam-guide::before {
  content: "";
  width: 72%; aspect-ratio: 63/88;
  border: 2px solid rgba(216,188,112,0.7);
  border-radius: 8px;
  box-shadow: 0 0 0 9999px rgba(0,0,0,0.45);
}
.cc-cam-title-strip {
  position: absolute;
  top: calc(50% - 44% * (88/63) / 2);
  left: calc(50% - 36%);
  width: 46.8%; /* 72% * 0.65 */
  height: calc(72% * (88/63) * 0.14);
  border: 1px dashed rgba(216,188,112,0.5);
  border-radius: 3px;
  background: rgba(216,188,112,0.06);
}
.cc-cam-overlay-msg {
  position: absolute; bottom: 10px; left: 0; right: 0;
  text-align: center; font-family: 'Cinzel', serif;
  font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
  color: rgba(232,220,192,0.8);
  display: flex; align-items: center; justify-content: center; gap: 8px;
}
.cc-cam-overlay-msg.scanning {
  animation: pulse 2s ease-in-out infinite;
}

/* ── detected card result ── */
.cc-scan-result {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}
.cc-scan-art {
  width: 100%; max-height: 180px; object-fit: cover;
  border-radius: 10px; border: 1px solid #34301f;
}
.cc-scan-cardname {
  font-family: 'Cinzel', serif; font-size: 16px;
  color: #f0e6cc; letter-spacing: 0.5px; text-align: center;
}
.cc-scan-actions {
  display: flex; gap: 8px; width: 100%;
}
.cc-scan-confirm {
  flex: 1; padding: 14px;
  font-family: 'Cinzel', serif; font-weight: 700; font-size: 13px;
  letter-spacing: 1px; text-transform: uppercase;
  color: #1a1610; cursor: pointer;
  background: linear-gradient(180deg, #d8bc70, #a8893e);
  border: 1px solid #e8d090; border-radius: 10px;
}
.cc-scan-retry {
  padding: 14px 18px;
  font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 1px;
  background: #14110c; color: #8a8270;
  border: 1px solid #34301f; border-radius: 10px; cursor: pointer;
}

/* ── search fallback ── */
.cc-scan-search-wrap {
  display: flex; flex-direction: column; gap: 8px;
}
.cc-scan-search-label {
  font-family: 'Cinzel', serif; font-size: 11px;
  letter-spacing: 1.5px; text-transform: uppercase;
  color: #6e6655;
}
.cc-scan-search-input { width: 100%; }
.cc-scan-searching {
  font-family: 'Spectral', serif; font-size: 13px; color: #8a8270;
  display: flex; align-items: center; gap: 6px;
}
.cc-scan-results-list {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 260px; overflow-y: auto;
}
.cc-scan-result-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 8px;
  background: #14110c; border: 1px solid #2c281c;
  color: #e8dcc0; font-family: 'Spectral', serif; font-size: 14px;
  cursor: pointer; text-align: left;
  transition: border-color .15s;
}
.cc-scan-result-item:hover { border-color: #b89a4e; }
.cc-scan-thumb {
  width: 48px; height: 34px; object-fit: cover;
  border-radius: 4px; flex-shrink: 0;
}
`;
