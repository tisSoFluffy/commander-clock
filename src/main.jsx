import React from "react";
import ReactDOM from "react-dom/client";
import CommanderClock from "./CommanderClock.jsx";

// NOTE: StrictMode is intentionally omitted. It double-mounts effects in dev,
// which causes our host PeerJS effect to register the same deterministic peer
// ID twice in a row and the second one collides on the broker.
ReactDOM.createRoot(document.getElementById("root")).render(<CommanderClock />);
