# Publish TODO

- [x] Create publisher on VS Code Marketplace  
  - Go: https://marketplace.visualstudio.com/manage
  - Sign in
  - Create publisher named `xl0` if not already exists  
  - Must match `package.json -> publisher`

- [x] Create publish token  
  - Preferred path: go to https://marketplace.visualstudio.com/manage
  - Sign in with same Microsoft account used for publisher `xl0`
  - Open publisher/profile security settings
  - Create Personal Access Token there if UI offers it
  - Fallback official path: go to https://dev.azure.com
  - In Azure DevOps, open User settings → Personal access tokens
  - Create token with:
    - Organization: `All accessible organizations`
    - Scopes: `Custom defined`
    - `Show all scopes`
    - `Marketplace` → `Manage`
  - Copy token immediately and save it securely
  - If auth loops or sign-out redirects happen:
    - Sign out from Microsoft/Azure sessions
    - Retry in incognito/private window
    - Make sure same account is used for Marketplace, Azure DevOps, and `vsce`

- [ ] Check manifest quality  
  Before first publish, worth adding:
  - [x] `icon` (`assets/icon.png`, rendered from `assets/logo.svg`)
  - `galleryBanner`
  - `homepage`
  - `bugs`
  - more complete `README`
  - `keywords`
  - maybe better `categories`

  Not strictly required, but Marketplace page looks weak without them.

- [x] Build/package locally  
  From `ide-plugins/vscode`:
  ```bash
  bun install
  bun run check
  bun run package
  ```
  Result -> `*.vsix`

- [x] Authenticate  
  PAT lives in `ide-plugins/vscode/.env` as `VSCE_PAT` (git-ignored). Bun loads that file
  automatically, so it only reaches `vsce` when `vsce` is started through `bun run` —
  `bunx`/`npx vsce` run the node shebang directly and never see it.

- [ ] Publish  
  From `ide-plugins/vscode`, publishing the current `package.json` version:
  ```bash
  bun run release
  ```
  Bump + publish in one step: `bun run release patch|minor|major`.

- [ ] Verify listing  
  - Check Marketplace page
  - Install by ID: `xl0.pi-lovely-ide`
  - Confirm README/rendering/icon/changelog OK

- [ ] Important gotchas  
  - Version must increase every publish.
  - `publisher` must exactly match Marketplace publisher.
  - `engines.vscode` must be valid for target users.
  - `.vscodeignore` controls packaged files. Yours looks sane.
  - Without `VSCE_PAT`, `vsce` silently falls back to the PAT stored in the OS keyring by
    `vsce login` and never checks its expiry, so a stale token fails at upload time.
  - Since `main` points to `dist/extension.cjs`, publish depends on prepublish build succeeding.

- [ ] Recommended first-pass polish before publish  
  - [x] add icon file + `icon` field
  - expand `README.md` with install/setup/use
  - add `keywords`
  - maybe add `pricing: "Free"` and `license` already OK

- [ ] Minimal command flow  
  ```bash
  cd ide-plugins/vscode
  bun install
  bun run check
  npx vsce login xl0
  npx vsce publish
  ```
