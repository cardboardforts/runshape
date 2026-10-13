import { createRoot } from "react-dom/client";

import "@xyflow/react/dist/style.css";
import "./styles.css";

import { App } from "./App";
import { vscodeHost } from "./host";

const root = document.getElementById("root");
if (root === null) throw new Error("webview: #root element missing");
createRoot(root).render(<App host={vscodeHost()} />);
