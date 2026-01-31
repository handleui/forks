import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import logo from "./assets/logo.svg";
import "./app.css";

const App = () => {
  const [greetMsg, setGreetMsg] = createSignal("");
  const [name, setName] = createSignal("");

  const greet = async () => {
    setGreetMsg(await invoke("greet", { name: name() }));
  };

  return (
    <main class="container">
      <h1>Welcome to Tauri + Solid</h1>

      <div class="row">
        <a href="https://vite.dev" rel="noopener" target="_blank">
          <img
            alt="Vite logo"
            class="logo vite"
            height="96"
            src="/vite.svg"
            width="96"
          />
        </a>
        <a href="https://tauri.app" rel="noopener" target="_blank">
          <img
            alt="Tauri logo"
            class="logo tauri"
            height="96"
            src="/tauri.svg"
            width="96"
          />
        </a>
        <a href="https://solidjs.com" rel="noopener" target="_blank">
          <img
            alt="Solid logo"
            class="logo solid"
            height="96"
            src={logo}
            width="96"
          />
        </a>
      </div>
      <p>Click on the Tauri, Vite, and Solid logos to learn more.</p>

      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          id="greet-input"
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button type="submit">Greet</button>
      </form>
      <p>{greetMsg()}</p>
    </main>
  );
};

export default App;
