import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { AccountsProvider } from "./accounts.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(<AccountsProvider><App /></AccountsProvider>);
