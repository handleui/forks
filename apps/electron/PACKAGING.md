# Packaging (bundle forksd)

- Put the built **forksd** artifact into the Electron build output (e.g. `electron-builder` **extraResources**).
- Electron main process should spawn the bundled `forksd` binary (or in dev: spawn `tsx` / `bun run dev` for the forksd app).
- Use a fixed localhost port + token, or a Unix socket / named pipe for auth.
